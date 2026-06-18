// 핵심 신뢰도 파이프 (PRD §4 FR-03). 순수 함수 — 모크 생성기와 프론트가 공유.

export const TRIM_FRACTION = 0.05; // 상위 5% + 하위 5% 절단
export const SAMPLE_THRESHOLD = { fine: 10, mid: 30, coarse: 50 }; // 저표본 임계값 N

export interface TrimResult {
  mean: number | null;
  median: number | null;
  totalSamples: number;
  kept: number;
  trimmedSamples: number;
  hardDropped: number;
  retainedRatio: number;
}

// 비정상 네트워크 한계 위반 샘플 제거 (FR-03 하드 임계값 필터).
export function applyHardThreshold(samples: number[], hard?: { min: number; max: number }): number[] {
  if (!hard) return samples.slice();
  const { min = -Infinity, max = Infinity } = hard;
  return samples.filter((v) => Number.isFinite(v) && v >= min && v <= max);
}

// 절단평균/중앙값: 정렬 후 상·하위 frac 제거, 나머지 90%로 집계.
// NFR(추적성) 요구 카운트(총샘플/절단/잔존율) 함께 반환.
export function trimmedStats(
  rawSamples: number[],
  opts: { frac?: number; hard?: { min: number; max: number } } = {}
): TrimResult {
  const { frac = TRIM_FRACTION, hard } = opts;
  const cleaned = applyHardThreshold(rawSamples, hard);
  const total = rawSamples.length;
  const hardDropped = total - cleaned.length;

  if (cleaned.length === 0) {
    return { mean: null, median: null, totalSamples: total, kept: 0, trimmedSamples: total, hardDropped, retainedRatio: 0 };
  }

  const sorted = cleaned.slice().sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * frac);
  const kept = sorted.slice(cut, sorted.length - cut);
  const window = kept.length > 0 ? kept : sorted; // 소표본에서 전부 제거 방지

  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  const median =
    window.length % 2
      ? window[(window.length - 1) / 2]
      : (window[window.length / 2 - 1] + window[window.length / 2]) / 2;

  return {
    mean,
    median,
    totalSamples: total,
    kept: window.length,
    trimmedSamples: total - window.length,
    hardDropped,
    retainedRatio: total > 0 ? window.length / total : 0,
  };
}

// FR-03 저표본 검증: 해당 버킷이 임계값 미만인가?
export function isLowSample(keptCount: number, tier: keyof typeof SAMPLE_THRESHOLD): boolean {
  return keptCount < (SAMPLE_THRESHOLD[tier] ?? SAMPLE_THRESHOLD.fine);
}

export interface AggregateResult {
  mean: number | null;
  median: number | null;
  totalSamples: number;
  kept: number;
  trimmedSamples: number;
  retainedRatio: number;
  lowSample: boolean;
}

// 이미 집계된 버킷들을 더 큰 뷰(시간/일)로 재집계. 버킷 평균을 절단하고
// 샘플 카운트를 합산해 재집계 후에도 추적성 유지 (FR-03 + NFR).
export function aggregateBuckets(
  buckets: { mean: number | null; totalSamples: number; kept: number }[],
  tier: keyof typeof SAMPLE_THRESHOLD
): AggregateResult {
  const valued = buckets.filter((b) => b && b.mean != null);
  if (valued.length === 0) {
    return { mean: null, median: null, totalSamples: 0, kept: 0, trimmedSamples: 0, retainedRatio: 0, lowSample: true };
  }
  const means = valued.map((b) => b.mean as number);
  const agg = trimmedStats(means);
  const totalSamples = buckets.reduce((s, b) => s + (b?.totalSamples || 0), 0);
  const keptSamples = buckets.reduce((s, b) => s + (b?.kept || 0), 0);
  return {
    mean: agg.mean,
    median: agg.median,
    totalSamples,
    kept: keptSamples,
    trimmedSamples: totalSamples - keptSamples,
    retainedRatio: totalSamples > 0 ? keptSamples / totalSamples : 0,
    lowSample: isLowSample(keptSamples, tier),
  };
}
