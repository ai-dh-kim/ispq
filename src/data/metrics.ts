// 지표 카탈로그 (PRD §4 FR-02). 소스/단위/방향성/하드 임계값(FR-03) 포함.
// higherIsBetter: 값이 클수록 좋은 지표 (피크 분석/색상에 사용)
// hard: { min, max } 비정상 샘플 제거를 위한 물리적 한계

export interface SourceDef {
  id: string;
  label: string;
}

export interface MetricDef {
  id: string;
  name: string;
  source: string;
  unit: string;
  higherIsBetter: boolean;
  hard: { min: number; max: number };
}

export const SOURCES: Record<string, SourceDef> = {
  cloudflare: { id: 'cloudflare', label: 'Cloudflare Radar' },
  mlab: { id: 'mlab', label: 'M-Lab (ndt7 / BigQuery)' },
  ripe: { id: 'ripe', label: 'RIPE Atlas' },
};

export const METRICS: MetricDef[] = [
  // --- Cloudflare Radar ---
  { id: 'latency', name: '지연시간 (RTT)', source: 'cloudflare', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 500 } },
  { id: 'jitter', name: '지터', source: 'cloudflare', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 200 } },
  { id: 'bandwidth', name: '대역폭(기준)', source: 'cloudflare', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 } },
  { id: 'httpErrorRate', name: 'HTTP 오류율', source: 'cloudflare', unit: '%', higherIsBetter: false, hard: { min: 0, max: 100 } },

  // --- M-Lab (ndt7) ---
  { id: 'meanThroughput', name: '평균 처리량', source: 'mlab', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 } },
  { id: 'minRtt', name: '최소 RTT', source: 'mlab', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 500 } },
  { id: 'lossRate', name: '손실률', source: 'mlab', unit: '%', higherIsBetter: false, hard: { min: 0, max: 100 } },
  { id: 'cwnd', name: '혼잡 윈도우', source: 'mlab', unit: 'KB', higherIsBetter: true, hard: { min: 0, max: 100000 } },
  { id: 'pacingRate', name: '페이싱 레이트', source: 'mlab', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 } },

  // --- RIPE Atlas ---
  { id: 'pingAvg', name: 'Ping 평균 RTT', source: 'ripe', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 500 } },
  { id: 'availability', name: '가용성', source: 'ripe', unit: '%', higherIsBetter: true, hard: { min: 0, max: 100 } },
  { id: 'hops', name: '트레이스라우트 홉 수', source: 'ripe', unit: '홉', higherIsBetter: false, hard: { min: 1, max: 40 } },
  { id: 'asPathFlaps', name: 'AS 경로 변동', source: 'ripe', unit: '회', higherIsBetter: false, hard: { min: 0, max: 50 } },
  { id: 'dnsResolve', name: 'DNS 응답시간', source: 'ripe', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 2000 } },
];

export const METRIC_BY_ID: Record<string, MetricDef> = Object.fromEntries(
  METRICS.map((m) => [m.id, m])
);

export const DEFAULT_METRIC = 'meanThroughput';
