// 지표 카탈로그 (PRD §4 FR-02). 소스/단위/방향성/하드 임계값(FR-03) 포함.
// higherIsBetter: 값이 클수록 좋은 지표 (피크 분석/색상에 사용)
// hard: { min, max } 비정상 샘플 제거를 위한 물리적 한계

export interface SourceDef {
  id: string;
  label: string;
}

// 지표의 근거(출처) 표기. 보고 신뢰성(NFR)을 위해 차트 하단에 등급+출처를 노출한다.
//   grade A: 제공사가 그 지표 자체를 직접 측정·공개 (반박 불가)
//   grade B: 공개 원측정값의 표준 집계/분위수
//   grade C: 공개 원측정값 + 공개 스펙의 임계값 적용 (임계값 출처 명시)
export interface MetricCite {
  grade: 'A' | 'B' | 'C';
  basis: string; // 어떤 공개데이터/스펙으로 뒷받침되는지 (한국어 한 줄)
  url: string;   // 권위 있는 출처 링크
}

export interface MetricDef {
  id: string;
  name: string;
  source: string;
  unit: string;
  higherIsBetter: boolean;
  hard: { min: number; max: number };
  // 값 → 범주형 인증 등급(rating_grade) 매핑. 내림차순 임계값(min 이상이면 해당 라벨).
  // 지정된 지표에 한해 차트 툴팁/피크 카드에 등급이 표시된다.
  grades?: { min: number; label: string }[];
  cite: MetricCite; // 근거(등급/출처) — 모든 지표 필수(형평성). 차트 하단에 표시.
}

export const SOURCES: Record<string, SourceDef> = {
  cloudflare: { id: 'cloudflare', label: 'Cloudflare Radar' },
  mlab: { id: 'mlab', label: 'M-Lab (ndt7 / BigQuery)' },
  ripe: { id: 'ripe', label: 'RIPE Atlas' },
  netflix: { id: 'netflix', label: 'Netflix 스트리밍 품질 (ISP Speed Index)' },
};

// Netflix 스트리밍 품질 등급(rating_grade) 임계값.
// HD(1080p) 재생 가능 비율 기준의 3단계. (Netflix ISP Speed Index는 순위만 매기므로
// 등급 라벨은 HD 가능 비율에서 파생한 표시용 분류이다.)
export const NF_GRADES: { min: number; label: string }[] = [
  { min: 90, label: 'HD 안정' },
  { min: 70, label: 'HD 제한적' },
  { min: 0, label: '표준화질(SD)' },
];

export const METRICS: MetricDef[] = [
  // --- Cloudflare Radar ---
  { id: 'latency', name: '지연시간 (RTT)', source: 'cloudflare', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 500 },
    cite: { grade: 'A', basis: 'Cloudflare Radar 인터넷 품질(IQI): ASN별 idle 지연(RTT) 실측', url: 'https://radar.cloudflare.com/quality' } },
  { id: 'bandwidth', name: '대역폭(기준)', source: 'cloudflare', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 },
    cite: { grade: 'A', basis: 'Cloudflare Radar 인터넷 품질(IQI): ASN별 다운로드 속도(중앙값) 실측', url: 'https://radar.cloudflare.com/quality' } },
  { id: 'httpErrorRate', name: 'HTTP 오류율', source: 'cloudflare', unit: '%', higherIsBetter: false, hard: { min: 0, max: 100 },
    cite: { grade: 'B', basis: 'Cloudflare Radar HTTP 데이터셋(AS 차원)의 상태코드 분포 기반 4xx/5xx 비율 집계', url: 'https://developers.cloudflare.com/radar/investigate/http-requests/' } },
  // 보장 처리량(하위 25%): Cloudflare가 ASN별 다운로드 25퍼센타일을 직접 공개. "최악 체감 속도".
  { id: 'p25Throughput', name: '보장 처리량 (하위 25%)', source: 'cloudflare', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 },
    cite: { grade: 'A', basis: 'Cloudflare Radar 인터넷 품질(IQI): ASN별 다운로드 25퍼센타일 실측 공개값', url: 'https://radar.cloudflare.com/quality' } },

  // --- M-Lab (ndt7) ---
  { id: 'meanThroughput', name: '평균 처리량', source: 'mlab', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 },
    cite: { grade: 'A', basis: 'M-Lab ndt7: 다운로드 처리량 실측 (BigQuery 공개셋 measurement-lab.ndt.ndt7)', url: 'https://www.measurementlab.net/tests/ndt/ndt7/' } },
  // 업로드 처리량: ndt7은 다운로드와 함께 업로드도 독립 측정. 대칭성·업로드 체감(백업/방송/게임).
  { id: 'uploadThroughput', name: '업로드 처리량', source: 'mlab', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 },
    cite: { grade: 'A', basis: 'M-Lab ndt7: 업로드 처리량 실측 (BigQuery 공개셋, download/upload 독립 테스트)', url: 'https://www.measurementlab.net/tests/ndt/ndt7/' } },
  { id: 'minRtt', name: '최소 RTT', source: 'mlab', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 500 },
    cite: { grade: 'A', basis: 'M-Lab ndt7 TCP_INFO: 최소 RTT(tcpi_min_rtt) 실측', url: 'https://www.measurementlab.net/tests/ndt/ndt7/' } },
  { id: 'lossRate', name: '손실률', source: 'mlab', unit: '%', higherIsBetter: false, hard: { min: 0, max: 100 },
    cite: { grade: 'B', basis: 'M-Lab ndt7 TCP_INFO: 재전송 카운터 기반 손실률 집계', url: 'https://www.measurementlab.net/tests/ndt/ndt7/' } },
  { id: 'cwnd', name: '혼잡 윈도우', source: 'mlab', unit: 'KB', higherIsBetter: true, hard: { min: 0, max: 100000 },
    cite: { grade: 'A', basis: 'M-Lab ndt7 TCP_INFO: 혼잡 윈도우(tcpi_snd_cwnd) 실측', url: 'https://www.measurementlab.net/tests/ndt/ndt7/' } },
  { id: 'pacingRate', name: '페이싱 레이트', source: 'mlab', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 },
    cite: { grade: 'A', basis: 'M-Lab ndt7 TCP_INFO: 페이싱 레이트(tcpi_pacing_rate) 실측', url: 'https://www.measurementlab.net/tests/ndt/ndt7/' } },

  // --- RIPE Atlas ---
  { id: 'pingAvg', name: 'Ping 평균 RTT', source: 'ripe', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 500 },
    cite: { grade: 'A', basis: 'RIPE Atlas ping 측정 RTT 실측(프로브는 각 ISP 망에 위치)', url: 'https://atlas.ripe.net/docs/built-in-measurements/' } },
  { id: 'availability', name: '가용성', source: 'ripe', unit: '%', higherIsBetter: true, hard: { min: 0, max: 100 },
    cite: { grade: 'B', basis: 'RIPE Atlas ping 성공 비율로 산출한 가용성 집계', url: 'https://atlas.ripe.net/docs/built-in-measurements/' } },
  { id: 'hops', name: '트레이스라우트 홉 수', source: 'ripe', unit: '홉', higherIsBetter: false, hard: { min: 1, max: 40 },
    cite: { grade: 'A', basis: 'RIPE Atlas traceroute 홉 수 실측', url: 'https://atlas.ripe.net/docs/built-in-measurements/' } },
  { id: 'asPathFlaps', name: 'AS 경로 변동', source: 'ripe', unit: '회', higherIsBetter: false, hard: { min: 0, max: 50 },
    cite: { grade: 'B', basis: 'RIPE Atlas traceroute/토폴로지 스캔의 경로 변화 횟수 집계', url: 'https://atlas.ripe.net/docs/built-in-measurements/' } },
  { id: 'dnsResolve', name: 'DNS 응답시간', source: 'ripe', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 2000 },
    cite: { grade: 'A', basis: 'RIPE Atlas DNS 측정 응답시간 실측', url: 'https://atlas.ripe.net/docs/built-in-measurements/' } },

  // --- Netflix 스트리밍 품질 ---
  // hd_verified_percentage: HD(1080p) 재생 가능 비율(지속 처리량 ≥ 5Mbps). 등급(rating_grade) 산출 기준.
  { id: 'nfHd', name: 'HD 재생 가능 비율 (1080p)', source: 'netflix', unit: '%', higherIsBetter: true, hard: { min: 0, max: 100 }, grades: NF_GRADES,
    cite: { grade: 'C', basis: 'M-Lab 처리량 실측 × Netflix 공식 권장(Full HD 1080p = 5Mbps 이상)', url: 'https://help.netflix.com/en/node/306' } },
  // 4K(UHD) 재생 가능 비율(지속 처리량 ≥ 15Mbps). 부하에 더 민감.
  { id: 'nf4k', name: '4K(UHD) 재생 가능 비율', source: 'netflix', unit: '%', higherIsBetter: true, hard: { min: 0, max: 100 },
    cite: { grade: 'C', basis: 'M-Lab 처리량 실측 × Netflix 공식 권장(Ultra HD 4K = 15Mbps 이상)', url: 'https://help.netflix.com/en/node/306' } },
  // Netflix ISP Speed Index: 통신사별 프라임타임 평균 재생 처리량(실측 공개값). Netflix가 비트레이트를 캡하므로 값이 작다.
  { id: 'nfSpeedIndex', name: 'ISP Speed Index (프라임타임 평균)', source: 'netflix', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 6 },
    cite: { grade: 'A', basis: 'Netflix ISP Speed Index: 통신사별 프라임타임 평균 재생 Mbps 공개값(월별)', url: 'https://ispspeedindex.netflix.net/' } },
];

// 값에 해당하는 rating_grade 라벨 (grades 미지정 지표는 null).
export function gradeFor(metric: MetricDef, v: number | null): string | null {
  if (!metric.grades || v == null) return null;
  for (const g of metric.grades) if (v >= g.min) return g.label;
  return metric.grades[metric.grades.length - 1]?.label ?? null;
}

export const METRIC_BY_ID: Record<string, MetricDef> = Object.fromEntries(
  METRICS.map((m) => [m.id, m])
);

export const DEFAULT_METRIC = 'meanThroughput';
