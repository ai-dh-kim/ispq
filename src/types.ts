// Shared types for the quality dashboard, used by both the React frontend and
// the Node mock generator.

export type TierKey = 'fine' | 'mid' | 'coarse';

// A tier's columnar block for one ISP/metric: parallel arrays aligned to the
// tier's shared time axis. Compact on purpose (single-file size, FR-07).
//   v = trimmed mean, n = total raw samples, k = samples kept after FR-03 trim.
// A bucket with no data is encoded as null in each array.
export type TierBlock = [
  v: (number | null)[],
  n: (number | null)[],
  k: (number | null)[],
];

export interface SeriesEntry {
  fine: TierBlock;
  mid: TierBlock;
  coarse: TierBlock;
}

export interface TierMeta {
  baseMin: number; // base bucket size in minutes
  t: number[]; // shared time axis (epoch ms), ascending
}

export interface QualityData {
  generatedAt: string;
  mode: 'sim' | 'live';
  lang: string;
  tiers: Record<TierKey, TierMeta>;
  isps: string[];
  metrics: string[];
  // series[ispId][metricId] -> SeriesEntry
  series: Record<string, Record<string, SeriesEntry>>;
  // 스냅샷(비시계열) 지표: 기간 집계 단일값. snapshot[ispId][metricId] -> 값(또는 null).
  // 시계열이 아니므로 표(SnapshotTable)로 표시한다.
  snapshot?: Record<string, Record<string, number | null>>;
}

// One decoded, display-ready point after aggregation + FR-03 derivation.
// 표본 수(total/kept/trimmed/retained)는 null 가능: percentile 기반 실데이터(예: Cloudflare
// IQI)는 표본 수를 제공하지 않으므로 "미상(–)"으로 두고 저표본 경고를 띄우지 않는다.
export interface DisplayPoint {
  t: number;
  v: number; // mean
  total: number | null; // total samples (null = 미상)
  kept: number | null;
  trimmed: number | null; // total - kept
  retained: number | null; // kept / total (0..1)
  low: boolean; // below sample-size threshold (FR-03 validator)
}
