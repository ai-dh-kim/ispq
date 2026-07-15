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
  // 실데이터가 '하루 1회 스냅샷'(일별 집계)으로만 수집되는 지표(예: Cloudflare Speed Test 캐시).
  //  (1) 차트를 항상 coarse(1일 버킷)로 표시  (2) X축을 마지막 실데이터에서 멈춤  (3) 일별 수집 공지 표시.
  dailyCadence?: boolean;
  pctFull?: boolean; // 0~100% 완료율(가능률 등) — Y축을 0~100 고정(100% 초과 불가).
  // 출처가 표본 수(n)를 공개하지 않는 지표(IQI percentile·Speed Test 집계 등).
  // 툴팁에 ISP마다 "실측값 (표본 수 미제공)"을 반복하는 대신 차트 상단 공지에 한 번만 안내(2026-07-10).
  noSamples?: boolean;
  cite: MetricCite; // 근거(등급/출처) — 모든 지표 필수(형평성). 차트 하단에 표시.
}

export const SOURCES: Record<string, SourceDef> = {
  cloudflare: { id: 'cloudflare', label: 'Cloudflare Radar' },
  // Speed Test는 같은 Cloudflare지만 측정 방식이 다름(실트래픽 수동측정 vs 사용자 자발 실행 능동측정) → 별도 출처 탭.
  cfspeed: { id: 'cfspeed', label: 'Cloudflare Speed Test' },
  // NIA(한국지능정보사회진흥원, 과기정통부 산하) 인터넷 품질측정 공개 통계 — 정부기관 측정 시스템(2026-07-15 추가).
  nia: { id: 'nia', label: 'NIA 속도측정 (정부기관)' },
  mlab: { id: 'mlab', label: 'M-Lab (ndt7 / BigQuery)' },
  // 단일 지표 출처들을 묶은 탭: Netflix Speed Index + APNIC DNSSEC + Steam (2026-07-08 netflix 탭에서 개편).
  etc: { id: 'etc', label: '기타 (Netflix · APNIC · Steam)' },
};

// Netflix 스트리밍 품질 등급(rating_grade) 임계값.
// HD(1080p) 재생 가능 비율 기준의 3단계. (Netflix ISP Speed Index는 순위만 매기므로
// 등급 라벨은 HD 가능 비율에서 파생한 표시용 분류이다.)
export const NF_GRADES: { min: number; label: string }[] = [
  { min: 90, label: 'HD 안정' },
  { min: 70, label: 'HD 제한적' },
  { min: 0, label: '표준화질(SD)' },
];

// NIA 속도측정 지표 공통 해석 주석(8종 동일).
const NIA_NOTE =
  '※ 정부 산하기관 NIA가 직접 운영하는 측정 시스템(speed.nia.or.kr)의 사업자별 공개 통계로, 측정통계 화면에는 날씨 아이콘(기상도)으로만 표시되는 값의 원천 수치입니다. 이용자가 자발적으로 측정한 표본(가입 상품은 이용자 신고값)이라 절대값보다 사업자 간 상대·추세 비교에 적합하며, 해당 상품을 파는 사업자만 나타납니다. 국내 전용이라 해외 ISP 비교는 없습니다. 원자료는 월간 집계 현재값만 제공되어 수집 시작(2026-07) 이후부터 일별 이력이 쌓입니다.';

export const METRICS: MetricDef[] = [
  // --- Cloudflare Radar ---
  { id: 'latency', name: '지연시간 (RTT)', source: 'cloudflare', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 500 }, noSamples: true,
    cite: { grade: 'A', basis: 'Cloudflare Radar 인터넷 품질(IQI): ASN별 idle 지연(RTT) 실측', url: 'https://radar.cloudflare.com/quality',
      note: '※ 데이터가 서버까지 갔다 오는 왕복 시간입니다. 낮을수록 웹 클릭 반응·게임·화상회의가 빠릿해집니다. 회선에 부하가 없는 유휴(idle) 상태 기준의 중앙값이라 "그 통신사 망의 기본 지연"에 가깝고, 이용자 지역 구성에 따라 달라지므로 ISP 간 상대·추세 비교용입니다.' } },
  // DNS 응답시간: ISP DNS 해석 속도. Cloudflare IQI가 ASN별로 시계열 제공(낮을수록 좋음). RTT 바로 아래에 배치.
  { id: 'dnsResponse', name: 'DNS 응답시간', source: 'cloudflare', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 2000 }, noSamples: true,
    cite: { grade: 'A', basis: 'Cloudflare Radar 인터넷 품질(IQI): ASN별 DNS 응답시간(중앙값) 실측', url: 'https://radar.cloudflare.com/quality',
      note: '※ 주소창에 사이트 이름을 치면 그 이름을 실제 주소(IP)로 바꿔주는 조회에 걸리는 시간입니다. 모든 사이트 접속의 첫 단계라, 낮을수록 "첫 화면이 뜨기 시작하는" 체감이 빨라집니다. 이 통신사 이용자들의 DNS 조회 응답시간 중앙값(실측)입니다.' } },
  { id: 'bandwidth', name: '대역폭(기준)', source: 'cloudflare', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 }, noSamples: true,
    cite: { grade: 'A', basis: 'Cloudflare Radar 인터넷 품질(IQI): ASN별 다운로드 속도(중앙값) 실측', url: 'https://radar.cloudflare.com/quality',
      note: '※ Cloudflare가 실측한 다운로드 속도의 중앙값(체감 속도)입니다. 가입 상품의 회선 용량(예: 1G)이 아니며, 측정 환경·서버 영향으로 표기 속도보다 낮게 나옵니다. ISP 간 상대·추세 비교용입니다.' } },
  // 보장 처리량(하위 25%): Cloudflare가 ASN별 다운로드 25퍼센타일을 직접 공개. "최악 체감 속도".
  { id: 'p25Throughput', name: '보장 처리량 (하위 25%)', source: 'cloudflare', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 }, noSamples: true,
    cite: { grade: 'A', basis: 'Cloudflare Radar 인터넷 품질(IQI): ASN별 다운로드 25퍼센타일 실측 공개값', url: 'https://radar.cloudflare.com/quality',
      note: '※ 다운로드 속도 하위 25%(최악 체감 구간)의 측정 중앙값입니다. 가입 회선 용량이 아닌 체감 속도이며, ISP 간 상대 비교용입니다.' } },
  // IPv6 채택률: ISP 망 현대화 수준(높을수록 최신). Cloudflare가 ASN별 IPv6 트래픽 비율을 시계열로 공개.
  { id: 'ipv6', name: 'IPv6 채택률', source: 'cloudflare', unit: '%', higherIsBetter: true, hard: { min: 0, max: 100 }, noSamples: true,
    cite: { grade: 'A', basis: 'Cloudflare Radar HTTP: ASN별 IPv6 트래픽 비율 실측(망 현대화 지표)', url: 'https://developers.cloudflare.com/radar/investigate/http-requests/',
      note: '※ Cloudflare HTTP 트래픽 중 IPv6 비율(실측)입니다. 한국 유선망은 IPv6 도입률이 낮아 일부 ISP(예: KT·SK브로드밴드)는 0%에 가깝게 나올 수 있으며, 이는 측정값이지 오류가 아닙니다.' } },
  // RPKI 라우팅 보안: ISP가 광고하는 BGP 경로 중 암호학적으로 검증(RPKI valid)되는 비율 — 경로 하이재킹 방어 수준.
  // API가 현재 상태만 제공 → collect-iqi.ts가 매일 스냅샷을 누적(수집 시작 2026-07-08 이후 이력만 존재).
  { id: 'rpkiValid', name: 'RPKI 라우팅 보안 적용률', source: 'cloudflare', unit: '%', higherIsBetter: true, hard: { min: 0, max: 100 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'Cloudflare Radar 라우팅: ASN별 BGP 경로 중 RPKI 유효(valid) 비율 — 공개 BGP 데이터 기반, 2시간 주기 갱신', url: 'https://radar.cloudflare.com/routing',
      note: '※ 경로 위·변조(BGP 하이재킹)에 대한 방어 수준입니다. 높을수록 이 통신사가 인터넷에 광고하는 경로가 암호학적으로 검증됩니다. 수집 시작(2026-07) 이후부터 이력이 쌓입니다.' } },

  // --- Cloudflare Speed Test (speed.cloudflare.com) ---
  // 사용자가 자발적으로 실행한 스피드테스트의 ASN별 일별 집계(collect-speedtest.ts 캐시).
  // 전 지표 dailyCadence(하루 1스냅샷·coarse 고정). 공통 한계: 측정자 자기선택·WiFi/단말 영향.
  { id: 'downloadBandwidth', name: '다운로드 속도', source: 'cfspeed', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'Cloudflare Speed Test(speed.cloudflare.com): ASN별 다운로드 속도 실측의 일별 집계', url: 'https://radar.cloudflare.com/quality',
      note: '※ Cloudflare Radar 탭의 대역폭(실트래픽 기반 IQI)과 측정 방식이 다른 독립 실측이라 값이 다를 수 있으며, 상호 교차검증용입니다. 가입 상품 속도가 아닌 체감 속도입니다.' } },
  // 업로드: M-Lab 업로드는 BigQuery 스캔 비용 ~2배라 보류(§8) → Speed Test로 무비용 확보.
  { id: 'uploadBandwidth', name: '업로드 속도', source: 'cfspeed', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'Cloudflare Speed Test(speed.cloudflare.com): ASN별 업로드 속도 실측의 일별 집계', url: 'https://radar.cloudflare.com/quality',
      note: '※ 사용자가 자발적으로 실행한 스피드테스트 집계라 측정자 자기선택·WiFi/단말 영향이 있습니다. 가입 상품 속도가 아닌 체감 업로드 속도이며, ISP 간 상대·추세 비교용입니다.' } },
  // 부하 시 지연(버퍼블로트): 다운/업로드 진행 중 측정한 지연. 유휴 RTT와의 차이가 클수록 동시사용 체감 악화.
  { id: 'loadedLatency', name: '부하 시 지연 (버퍼블로트)', source: 'cfspeed', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 2000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'Cloudflare Speed Test: 전송(다운/업로드) 진행 중 측정한 지연(loaded latency)의 ASN별 일별 집계', url: 'https://radar.cloudflare.com/quality',
      note: '※ 회선이 가득 찼을 때의 지연입니다. 유휴 지연(RTT)보다 얼마나 커지는지가 핵심(버퍼블로트) — 값이 클수록 대용량 전송 중 화상회의·게임이 끊기는 체감이 나빠집니다.' } },
  // 지터: 지연시간의 변동폭. 유휴 상태 측정(일반 스피드테스트 표기와 동일 기준). 부하 중 지터(jl)도 캐시에 수집 중.
  { id: 'jitter', name: '지터 (유휴)', source: 'cfspeed', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 2000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'Cloudflare Speed Test: 유휴 상태 지연 변동(지터)의 ASN별 일별 집계', url: 'https://radar.cloudflare.com/quality',
      note: '※ 지연시간이 얼마나 출렁이는지(변동폭)입니다. 낮을수록 화상회의·게임·실시간 스트리밍이 안정적입니다.' } },
  // 패킷 손실률: API 원값이 이미 %단위(실데이터 분포로 검증: 0~0.2% 수준). M-Lab lossRate와 독립 측정이라 교차검증 가능.
  { id: 'packetLoss', name: '패킷 손실률', source: 'cfspeed', unit: '%', higherIsBetter: false, hard: { min: 0, max: 100 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'Cloudflare Speed Test: 패킷 손실률의 ASN별 일별 집계', url: 'https://radar.cloudflare.com/quality',
      note: '※ M-Lab 손실률(TCP 재전송 기반)과 측정 방식이 다른 독립 실측입니다. 두 값을 함께 보면 교차검증이 됩니다. 0%가 정상이며 0.5%만 넘어도 체감 품질이 떨어집니다.' } },

  // --- NIA 속도측정 (speed.nia.or.kr, 정부기관) ---
  // 측정통계 페이지의 데이터 피드(statistic_isp.asp)에서 상품별 사업자 평균을 일별 스냅샷으로 수집(collect-nia.ts).
  // 국내 전용(해외 ISP 데이터 없음). 상품 4종 × 다운/업 8종 전부 노출 — 필요 없는 것은 나중에 제거(2026-07-15 결정).
  { id: 'niaDl100', name: '다운로드 속도 (100M 상품)', source: 'nia', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 1000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'NIA(한국지능정보사회진흥원) 인터넷 품질측정: 100M 상품 가입자의 사업자별 평균 다운로드 속도 공개 통계(월간 집계)', url: 'https://speed.nia.or.kr/statistics/statistic.asp', note: NIA_NOTE } },
  { id: 'niaUl100', name: '업로드 속도 (100M 상품)', source: 'nia', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 1000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'NIA(한국지능정보사회진흥원) 인터넷 품질측정: 100M 상품 가입자의 사업자별 평균 업로드 속도 공개 통계(월간 집계)', url: 'https://speed.nia.or.kr/statistics/statistic.asp', note: NIA_NOTE } },
  { id: 'niaDl500', name: '다운로드 속도 (500M 상품)', source: 'nia', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 5000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'NIA(한국지능정보사회진흥원) 인터넷 품질측정: 500M 상품 가입자의 사업자별 평균 다운로드 속도 공개 통계(월간 집계)', url: 'https://speed.nia.or.kr/statistics/statistic.asp', note: NIA_NOTE } },
  { id: 'niaUl500', name: '업로드 속도 (500M 상품)', source: 'nia', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 5000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'NIA(한국지능정보사회진흥원) 인터넷 품질측정: 500M 상품 가입자의 사업자별 평균 업로드 속도 공개 통계(월간 집계)', url: 'https://speed.nia.or.kr/statistics/statistic.asp', note: NIA_NOTE } },
  { id: 'niaDl1g', name: '다운로드 속도 (1G 상품)', source: 'nia', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'NIA(한국지능정보사회진흥원) 인터넷 품질측정: 1G 상품 가입자의 사업자별 평균 다운로드 속도 공개 통계(월간 집계)', url: 'https://speed.nia.or.kr/statistics/statistic.asp', note: NIA_NOTE } },
  { id: 'niaUl1g', name: '업로드 속도 (1G 상품)', source: 'nia', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'NIA(한국지능정보사회진흥원) 인터넷 품질측정: 1G 상품 가입자의 사업자별 평균 업로드 속도 공개 통계(월간 집계)', url: 'https://speed.nia.or.kr/statistics/statistic.asp', note: NIA_NOTE } },
  { id: 'niaDl10g', name: '다운로드 속도 (10G 상품)', source: 'nia', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 20000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'NIA(한국지능정보사회진흥원) 인터넷 품질측정: 10G 상품 가입자의 사업자별 평균 다운로드 속도 공개 통계(월간 집계)', url: 'https://speed.nia.or.kr/statistics/statistic.asp', note: NIA_NOTE } },
  { id: 'niaUl10g', name: '업로드 속도 (10G 상품)', source: 'nia', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 20000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'NIA(한국지능정보사회진흥원) 인터넷 품질측정: 10G 상품 가입자의 사업자별 평균 업로드 속도 공개 통계(월간 집계)', url: 'https://speed.nia.or.kr/statistics/statistic.asp', note: NIA_NOTE } },

  // --- M-Lab (ndt7) ---
  { id: 'meanThroughput', name: '평균 처리량', source: 'mlab', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 }, mlabBased: true,
    cite: { grade: 'A', basis: 'M-Lab ndt7: 다운로드 처리량 실측 (BigQuery 공개셋 measurement-lab.ndt.ndt7)', url: 'https://www.measurementlab.net/tests/ndt/ndt7/',
      note: '※ M-Lab 서버로의 단일 TCP 측정값입니다. 경로·서버 한계와 측정자 자기선택(문제 시 측정), WiFi·단말 영향으로 가입 상품 속도(예: 500M·1G)보다 낮게 나올 수 있어 절대속도보다 ISP 간 상대·추세 비교에 적합합니다.' } },
  // 피크 처리량: 버킷 내 처리량 상위 10%의 평균(관측된 단일 TCP 피크). '공급 한계'의 하한 프록시.
  { id: 'peakCapacity', name: '피크 처리량 (상위 10%)', source: 'mlab', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 }, mlabBased: true,
    cite: { grade: 'A', basis: 'M-Lab ndt7: 다운로드 처리량 상위 10%의 평균(버킷별, BigQuery 분위수 집계)', url: 'https://www.measurementlab.net/tests/ndt/ndt7/',
      note: '※ 단일 TCP→M-Lab 서버 측정의 상위 10% 평균입니다. 경로·단일스트림 상한에 막혀 OLT/백본의 실제 공급 한계를 과소평가할 수 있어 "관측된 피크"로 해석하세요(ISP 간 상대 비교용).' } },
  { id: 'minRtt', name: '최소 RTT', source: 'mlab', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 500 }, mlabBased: true,
    cite: { grade: 'A', basis: 'M-Lab ndt7 TCP_INFO: 최소 RTT(tcpi_min_rtt) 실측', url: 'https://www.measurementlab.net/tests/ndt/ndt7/',
      note: '※ 측정 중 관측된 가장 짧은 왕복 시간입니다. 혼잡·대기열 영향이 빠진 "회선 자체의 지연"에 가까워, 평균 지연과의 차이가 크면 혼잡 시간대 품질 저하를 의심할 수 있습니다. M-Lab 서버까지의 거리(서버 위치)에 의존하므로 ISP 간 상대 비교용입니다.' } },
  // 지연 하한: 버킷 내 MinRTT 하위 10%의 평균(최상 조건의 '지연 바닥'). 백본/물리 경로 품질 프록시.
  { id: 'latencyFloor', name: '지연 하한 (하위 10%)', source: 'mlab', unit: 'ms', higherIsBetter: false, hard: { min: 0, max: 500 }, mlabBased: true,
    cite: { grade: 'A', basis: 'M-Lab ndt7: MinRTT 하위 10%의 평균(버킷별, BigQuery 분위수 집계)', url: 'https://www.measurementlab.net/tests/ndt/ndt7/',
      note: '※ 최상 조건의 지연 바닥으로, 코어망/백본 경로 품질에 가깝습니다. 단 M-Lab 서버까지의 거리(국가·서버 위치)에 의존합니다.' } },
  { id: 'lossRate', name: '손실률', source: 'mlab', unit: '%', higherIsBetter: false, hard: { min: 0, max: 100 }, mlabBased: true,
    cite: { grade: 'B', basis: 'M-Lab ndt7 TCP_INFO: 재전송 카운터 기반 손실률 집계', url: 'https://www.measurementlab.net/tests/ndt/ndt7/',
      note: '※ 보낸 데이터가 도중에 사라져 다시 보내야 했던 비율입니다. 0%에 가까울수록 좋고, 높으면 속도 저하·화상회의 끊김으로 이어집니다. TCP 재전송 카운터 기반 추정(집계 B등급)이라 손실 외 요인이 일부 섞일 수 있어, 정밀 절대값보다 ISP 간 상대·추세 비교에 적합합니다. Speed Test 탭의 패킷 손실률과 교차검증할 수 있습니다.' } },
  // (제거됨 2026-07-15, 사용자 요청) nfHd 'HD 스트리밍 가능률(≥5Mbps)' · nf4k '4K 스트리밍 가능률(≥15Mbps)':
  // M-Lab 처리량 × Netflix 권장 임계 파생(grade C). 원천 수집은 계속됨(collect-mlab.ts → mlab_cache.json의 hd/k4 필드,
  // generate-mock.ts MLAB_FIELD 매핑도 유지) — 재추가하려면 여기 지표 정의 2줄만 복원하면 과거 이력까지 그대로 살아난다.

  // --- 기타 (단일 지표 출처 묶음: Netflix · APNIC) ---
  // Netflix ISP Speed Index: 통신사별 프라임타임 평균 재생 처리량(실측 공개값). Netflix가 비트레이트를 캡하므로 값이 작다.
  { id: 'nfSpeedIndex', name: 'Netflix ISP Speed Index (프라임타임 평균)', source: 'etc', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 6 }, noSamples: true,
    cite: { grade: 'A', basis: 'Netflix ISP Speed Index: 통신사별 프라임타임 평균 재생 Mbps 공개값(월별)', url: 'https://ispspeedindex.netflix.net/',
      note: '※ Netflix가 자사 시청 트래픽에서 집계한 프라임타임(저녁 시청 몰림 시간대) 평균 재생 속도입니다. 영상 재생은 화질에 필요한 만큼만 받으므로(비트레이트 상한) 값이 수 Mbps로 작게 나오는 게 정상이며, 회선 최대 속도가 아니라 "가장 붐빌 때 스트리밍 품질을 유지하는 능력"을 ISP끼리 비교하는 지표입니다. 월 1회 갱신됩니다.' } },
  // Steam 다운로드 속도: Valve가 공개하는 국가별 주요 ISP의 Steam 클라이언트 평균 다운로드 Mbps(실제 게임 다운로드 트래픽).
  // 엔드포인트가 현재 창 집계만 제공 → collect-steam.ts가 매일 스냅샷 누적(수집 시작 2026-07-10 이후 이력만 존재).
  { id: 'steamDownload', name: 'Steam 다운로드 속도', source: 'etc', unit: 'Mbps', higherIsBetter: true, hard: { min: 0, max: 10000 }, dailyCadence: true, noSamples: true,
    cite: { grade: 'A', basis: 'Valve Steam 다운로드 통계: 국가별 주요 ISP의 Steam 클라이언트 평균 다운로드 속도(실제 게임 다운로드 트래픽) 공개값', url: 'https://store.steampowered.com/stats/content/',
      note: '※ 전 세계 Steam 이용자의 실제 게임 다운로드에서 집계한 평균 속도로, 대용량 CDN 전송 성능을 보여줍니다(Netflix Speed Index의 게임판 격). 통신사 내 캐시 서버 유무·이용자 회선 구성에 따라 달라져 ISP 간 상대·추세 비교용이며, 가입 상품 속도가 아닙니다. 수집 시작(2026-07) 이후부터 이력이 쌓입니다.' } },
  // DNSSEC 검증률: 이 통신사 이용자 중 DNS 응답 위조를 검증(DNSSEC)하는 리졸버 사용 비율. APNIC(아태 IP주소 관리기구) 실측.
  { id: 'dnssec', name: 'DNSSEC 검증률', source: 'etc', unit: '%', higherIsBetter: true, hard: { min: 0, max: 100 }, dailyCadence: true,
    cite: { grade: 'A', basis: 'APNIC Labs(아시아·태평양 IP주소 관리기구): ASN별 DNSSEC 검증 사용자 비율 실측(구글 광고망 대규모 표본, 일별)', url: 'https://stats.labs.apnic.net/dnssec',
      note: '※ 주소창에 사이트 이름을 치면 통신사 DNS 서버가 실제 주소(IP)를 알려주는데, 이 응답은 중간에서 위조될 수 있습니다(가짜 은행 사이트로 연결되는 파밍 공격). DNSSEC은 응답에 붙은 디지털 서명(인감)을 대조해 위조를 걸러내는 기능으로, 통신사가 자기 DNS 서버에서 검증 옵션을 켜기만 하면 전 가입자가 자동 보호됩니다(가입자가 할 일 없음). 즉 이 수치는 "통신사가 가입자를 기본 보호해 주는가"를 보여주는 통신사 설정·투자 지표입니다 — 켠 통신사는 ~99%(Comcast·도이치텔레콤 등), 안 켠 통신사는 구글 DNS(8.8.8.8)로 직접 바꾼 소수만 잡혀 ~2%(KT·LG U+), 서버 일부에만 켠 경우 중간값(~40%대, SK브로드밴드로 추정)이 나옵니다. 표본수(n)는 값 위에 마우스를 올리면 표시됩니다.' } },
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

// 첫 진입 기본 = Cloudflare Radar 출처(이 지표가 속한 출처가 초기 선택됨).
export const DEFAULT_METRIC = 'latency';
