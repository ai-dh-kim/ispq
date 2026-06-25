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
  note?: string; // 해석 시 유의점(측정 한계 등) — 출처 팝오버에 한 줄 추가 표시.
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
  // M-Lab 공개셋(BigQuery) 기반 지표. M-Lab은 ~1~2일 지연 발행이라:
  //  (1) 차트에 지연 공지 표시  (2) X축을 '최신 M-Lab 데이터' 지점에서 멈춤(현재까지 끌고 가지 않음).
  // nfHd/nf4k는 출처가 netflix지만 실제 값은 M-Lab 처리량에서 파생되므로 동일하게 적용.
  mlabBased?: boolean;
  cite: MetricCite; // 근거(등급/출처) — 모든 지표 필수(형평성). 차트 하단에 표시.
}

export const SOURCES: Record<string, SourceDef> = {
  cloudflare: { id: 'cloudflare', label: 'Cloudflare Radar' },
  mlab: { id: 'mlab', label: 'M-Lab (ndt7 / BigQuery)' },
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
  // DNS 응답시간: ISP DNS 해석 속도. Cloudflare IQI가 ASN별로 시계열 제공(낮을수록 좋음). RTT 바로 아래에 배치.
  { id: 'dnsResponse', name: 'DNS 응답시간', source: 'cloudflare', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 2000 },
    cite: { grade: 'A', basis: 'Cloudflare Radar 인터넷 품질(IQI): ASN별 DNS 응답시간(중앙값) 실측', url: 'https://radar.cloudflare.com/quality' } },
  { id: 'bandwidth', name: '대역폭(기준)', source: 'cloudflare', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 },
    cite: { grade: 'A', basis: 'Cloudflare Radar 인터넷 품질(IQI): ASN별 다운로드 속도(중앙값) 실측', url: 'https://radar.cloudflare.com/quality',
      note: '※ Cloudflare가 실측한 다운로드 속도의 중앙값(체감 속도)입니다. 가입 상품의 회선 용량(예: 1G)이 아니며, 측정 환경·서버 영향으로 표기 속도보다 낮게 나옵니다. ISP 간 상대·추세 비교용입니다.' } },
  // 보장 처리량(하위 25%): Cloudflare가 ASN별 다운로드 25퍼센타일을 직접 공개. "최악 체감 속도".
  { id: 'p25Throughput', name: '보장 처리량 (하위 25%)', source: 'cloudflare', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 },
    cite: { grade: 'A', basis: 'Cloudflare Radar 인터넷 품질(IQI): ASN별 다운로드 25퍼센타일 실측 공개값', url: 'https://radar.cloudflare.com/quality',
      note: '※ 다운로드 속도 하위 25%(최악 체감 구간)의 측정 중앙값입니다. 가입 회선 용량이 아닌 체감 속도이며, ISP 간 상대 비교용입니다.' } },
  // IPv6 채택률: ISP 망 현대화 수준(높을수록 최신). Cloudflare가 ASN별 IPv6 트래픽 비율을 시계열로 공개.
  { id: 'ipv6', name: 'IPv6 채택률', source: 'cloudflare', unit: '%', higherIsBetter: true, hard: { min: 0, max: 100 },
    cite: { grade: 'A', basis: 'Cloudflare Radar HTTP: ASN별 IPv6 트래픽 비율 실측(망 현대화 지표)', url: 'https://developers.cloudflare.com/radar/investigate/http-requests/',
      note: '※ Cloudflare HTTP 트래픽 중 IPv6 비율(실측)입니다. 한국 유선망은 IPv6 도입률이 낮아 일부 ISP(예: KT·SK브로드밴드)는 0%에 가깝게 나올 수 있으며, 이는 측정값이지 오류가 아닙니다.' } },

  // --- M-Lab (ndt7) ---
  { id: 'meanThroughput', name: '평균 처리량', source: 'mlab', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 }, mlabBased: true,
    cite: { grade: 'A', basis: 'M-Lab ndt7: 다운로드 처리량 실측 (BigQuery 공개셋 measurement-lab.ndt.ndt7)', url: 'https://www.measurementlab.net/tests/ndt/ndt7/',
      note: '※ M-Lab 서버로의 단일 TCP 측정값입니다. 경로·서버 한계와 측정자 자기선택(문제 시 측정), WiFi·단말 영향으로 가입 상품 속도(예: 500M·1G)보다 낮게 나올 수 있어 절대속도보다 ISP 간 상대·추세 비교에 적합합니다.' } },
  // 피크 처리량: 버킷 내 처리량 상위 10%의 평균(관측된 단일 TCP 피크). '공급 한계'의 하한 프록시.
  { id: 'peakCapacity', name: '피크 처리량 (상위 10%)', source: 'mlab', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 }, mlabBased: true,
    cite: { grade: 'A', basis: 'M-Lab ndt7: 다운로드 처리량 상위 10%의 평균(버킷별, BigQuery 분위수 집계)', url: 'https://www.measurementlab.net/tests/ndt/ndt7/',
      note: '※ 단일 TCP→M-Lab 서버 측정의 상위 10% 평균입니다. 경로·단일스트림 상한에 막혀 OLT/백본의 실제 공급 한계를 과소평가할 수 있어 "관측된 피크"로 해석하세요(ISP 간 상대 비교용).' } },
  { id: 'minRtt', name: '최소 RTT', source: 'mlab', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 500 }, mlabBased: true,
    cite: { grade: 'A', basis: 'M-Lab ndt7 TCP_INFO: 최소 RTT(tcpi_min_rtt) 실측', url: 'https://www.measurementlab.net/tests/ndt/ndt7/' } },
  // 지연 하한: 버킷 내 MinRTT 하위 10%의 평균(최상 조건의 '지연 바닥'). 백본/물리 경로 품질 프록시.
  { id: 'latencyFloor', name: '지연 하한 (하위 10%)', source: 'mlab', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 500 }, mlabBased: true,
    cite: { grade: 'A', basis: 'M-Lab ndt7: MinRTT 하위 10%의 평균(버킷별, BigQuery 분위수 집계)', url: 'https://www.measurementlab.net/tests/ndt/ndt7/',
      note: '※ 최상 조건의 지연 바닥으로, 코어망/백본 경로 품질에 가깝습니다. 단 M-Lab 서버까지의 거리(국가·서버 위치)에 의존합니다.' } },
  { id: 'lossRate', name: '손실률', source: 'mlab', unit: '%', higherIsBetter: false, hard: { min: 0, max: 100 }, mlabBased: true,
    cite: { grade: 'B', basis: 'M-Lab ndt7 TCP_INFO: 재전송 카운터 기반 손실률 집계', url: 'https://www.measurementlab.net/tests/ndt/ndt7/' } },

  // --- Netflix 스트리밍 품질 ---
  // hd_verified_percentage: HD(1080p) 재생 가능 비율(지속 처리량 ≥ 5Mbps). 등급(rating_grade) 산출 기준.
  { id: 'nfHd', name: 'HD 재생 가능 비율 (1080p)', source: 'netflix', unit: '%', higherIsBetter: true, hard: { min: 0, max: 100 }, grades: NF_GRADES, mlabBased: true,
    cite: { grade: 'C', basis: 'M-Lab 처리량 실측 × Netflix 공식 권장(Full HD 1080p = 5Mbps 이상)', url: 'https://help.netflix.com/en/node/306' } },
  // 4K(UHD) 재생 가능 비율(지속 처리량 ≥ 15Mbps). 부하에 더 민감.
  { id: 'nf4k', name: '4K(UHD) 재생 가능 비율', source: 'netflix', unit: '%', higherIsBetter: true, hard: { min: 0, max: 100 }, mlabBased: true,
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
