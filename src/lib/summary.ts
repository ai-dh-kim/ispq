// 요약 패널(한눈에 보기) 계산 — 임원용 종합 계층.
// 이미 로드된 quality_data.json의 coarse(1일) 티어에서 클라이언트가 전부 계산한다(새 수집 없음).
// 정직성 원칙: 절대 임계값("몇 ms부터 나쁨")은 근거를 대기 어려우므로 쓰지 않고,
// (1) 표시된 ISP 간 '상대 순위'와 (2) 자기 자신 대비 '변화율'만 보여 준다(측정값의 산술 비교 · 파생 C).
//
// 시간창은 '지금'이 아니라 지표별 마지막 실데이터 시점(lastMs) 기준(recentDays=N):
//   최근 창 = (lastMs-N일, lastMs]  ·  기준 창 = (lastMs-(N+30)일, lastMs-N일]
// → 발행 지연이 다른 지표(M-Lab ~2일, Speed Test 1일)끼리도 공정하게 비교된다.

import type { QualityData } from '../types.ts';
import { METRIC_BY_ID } from '../data/metrics.ts';

const DAY = 86400000;
export const DEFAULT_RECENT_DAYS = 7;
const BASE_DAYS = 30;

// 요약 매트릭스에 올릴 대표 지표(열). 전 지표를 다 올리면 표가 임원 친화성을 잃는다 —
// 출처를 가로질러 범주(지연/속도/안정성/스트리밍)를 대표하는 6종만. 여기만 고치면 열이 바뀐다.
export const SUMMARY_METRICS: { id: string; short: string }[] = [
  { id: 'latency', short: 'RTT' },
  { id: 'bandwidth', short: '다운로드' },
  { id: 'uploadBandwidth', short: '업로드' },
  { id: 'loadedLatency', short: '부하지연' },
  { id: 'lossRate', short: '손실률' },
  { id: 'nfHd', short: 'HD가능' },
];

export interface SummaryCell {
  v: number | null;    // 최근 N일 평균 (데이터 없으면 null)
  rank: number | null; // 표시된 ISP 중 순위(1=최고). 값 없으면 null
  ranked: number;      // 이 지표에서 순위가 매겨진 ISP 수(꼴찌 판정용)
}

export interface ChangeItem {
  ispId: string;
  metricId: string;
  recent: number;   // 최근 N일 평균
  base: number;     // 이전 30일 평균
  deltaPct: number; // (recent-base)/base*100 — 값 기준 부호
  worse: boolean;   // higherIsBetter 반영한 '악화' 여부
}

// 한 지표의 ISP별 {recent, base} 평균. coarse(1일) 티어 사용.
function windowMeans(
  data: QualityData, ispIds: string[], metricId: string, recentDays: number,
): Map<string, { recent: number | null; base: number | null }> {
  const axis = data.tiers.coarse?.t ?? [];
  const out = new Map<string, { recent: number | null; base: number | null }>();

  // 지표별 마지막 실데이터 시점: 표시된 ISP 중 가장 최신 non-null.
  let lastMs = -Infinity;
  for (const isp of ispIds) {
    const v = data.series[isp]?.[metricId]?.coarse?.[0];
    if (!v) continue;
    for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) { if (axis[i] > lastMs) lastMs = axis[i]; break; }
  }
  if (!Number.isFinite(lastMs)) { for (const isp of ispIds) out.set(isp, { recent: null, base: null }); return out; }

  const recentFrom = lastMs - recentDays * DAY;
  const baseFrom = lastMs - (recentDays + BASE_DAYS) * DAY;
  for (const isp of ispIds) {
    const v = data.series[isp]?.[metricId]?.coarse?.[0];
    let rSum = 0, rN = 0, bSum = 0, bN = 0;
    if (v) {
      axis.forEach((t, i) => {
        const x = v[i];
        if (x == null) return;
        if (t > recentFrom && t <= lastMs) { rSum += x; rN++; }
        else if (t > baseFrom && t <= recentFrom) { bSum += x; bN++; }
      });
    }
    out.set(isp, { recent: rN ? rSum / rN : null, base: bN ? bSum / bN : null });
  }
  return out;
}

// 순위 매트릭스: rows[ispId].cells[metricId] = { v, rank, ranked }.
export function buildSummary(
  data: QualityData, ispIds: string[], metricIds: string[], recentDays = DEFAULT_RECENT_DAYS,
): Map<string, Record<string, SummaryCell>> {
  const rows = new Map<string, Record<string, SummaryCell>>();
  for (const isp of ispIds) rows.set(isp, {});
  for (const metricId of metricIds) {
    const metric = METRIC_BY_ID[metricId];
    const means = windowMeans(data, ispIds, metricId, recentDays);
    const vals = ispIds
      .map((isp) => ({ isp, v: means.get(isp)?.recent ?? null }))
      .filter((x): x is { isp: string; v: number } => x.v != null);
    for (const isp of ispIds) {
      const v = means.get(isp)?.recent ?? null;
      // 경쟁 순위: 나보다 엄격히 좋은 값의 수 + 1 (동률은 같은 순위).
      let rank: number | null = null;
      if (v != null) {
        const better = vals.filter((x) => (metric.higherIsBetter ? x.v > v : x.v < v)).length;
        rank = better + 1;
      }
      rows.get(isp)![metricId] = { v, rank, ranked: vals.length };
    }
  }
  return rows;
}

// 변화 감지: 최근 N일 vs 이전 30일 평균의 변화율. |변화율| >= minPct 만 반환, 악화 우선 정렬.
export function detectChanges(
  data: QualityData, ispIds: string[], metricIds: string[], recentDays = DEFAULT_RECENT_DAYS, minPct = 10,
): ChangeItem[] {
  const items: ChangeItem[] = [];
  for (const metricId of metricIds) {
    const metric = METRIC_BY_ID[metricId];
    const means = windowMeans(data, ispIds, metricId, recentDays);
    for (const isp of ispIds) {
      const m = means.get(isp);
      if (!m || m.recent == null || m.base == null) continue;
      if (m.base <= 1e-9) continue; // 0 기준 변화율은 무의미(분모 보호)
      const deltaPct = ((m.recent - m.base) / m.base) * 100;
      if (Math.abs(deltaPct) < minPct) continue;
      const worse = metric.higherIsBetter ? deltaPct < 0 : deltaPct > 0;
      items.push({ ispId: isp, metricId, recent: m.recent, base: m.base, deltaPct, worse });
    }
  }
  // 악화 먼저, 그 안에서 변화율 큰 순.
  return items.sort((a, b) => Number(b.worse) - Number(a.worse) || Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
}
