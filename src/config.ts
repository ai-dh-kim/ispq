// 범위/버킷/티어 매핑 + UI 문구 (한국어). 단일 출처.
import type { TierKey } from './types.ts';

export type RangeKey = '24h' | '2d' | '7d' | '30d' | '90d' | '180d' | '1y';
export type ViewKey = '10min' | '1hour' | '1day';

const DAY = 86400000;

export interface RangeDef {
  label: string;
  ms: number;
  tier: TierKey; // 이 범위에서 사용할 데이터 티어
}

// 최대 1년까지. 범위가 커질수록 더 거친 티어를 사용해 단일 파일 크기 유지.
export const RANGES: Record<RangeKey, RangeDef> = {
  '24h': { label: '최근 24시간', ms: DAY, tier: 'fine' },
  '2d': { label: '최근 2일', ms: 2 * DAY, tier: 'fine' },
  '7d': { label: '최근 7일', ms: 7 * DAY, tier: 'mid' },
  '30d': { label: '최근 30일', ms: 30 * DAY, tier: 'mid' },
  '90d': { label: '최근 90일', ms: 90 * DAY, tier: 'coarse' },
  '180d': { label: '최근 180일', ms: 180 * DAY, tier: 'coarse' },
  '1y': { label: '최근 1년', ms: 365 * DAY, tier: 'coarse' },
};

export interface ViewDef {
  label: string;
  ms: number;
  baseMin: number;
  threshTier: 'fine' | 'mid' | 'coarse'; // 저표본 임계값 선택 (FR-03)
}

export const VIEWS: Record<ViewKey, ViewDef> = {
  '10min': { label: '10분', ms: 10 * 60 * 1000, baseMin: 10, threshTier: 'fine' },
  '1hour': { label: '1시간', ms: 60 * 60 * 1000, baseMin: 60, threshTier: 'mid' },
  '1day': { label: '1일', ms: DAY, baseMin: 1440, threshTier: 'coarse' },
};

// 각 티어의 기본 해상도(분). 모크 생성기와 공유.
export const TIER_BASE_MIN: Record<TierKey, number> = { fine: 10, mid: 60, coarse: 1440 };

// 티어에서 선택 가능한 버킷 뷰 (티어 기본 해상도 이상만 허용).
export const TIER_VIEWS: Record<TierKey, ViewKey[]> = {
  fine: ['10min', '1hour', '1day'],
  mid: ['1hour', '1day'],
  coarse: ['1day'],
};

// UI 문구 (한국어)
export const T = {
  appTitle: '유선 브로드밴드 품질 대시보드',
  modeSim: '시뮬레이션 데이터',
  modeLive: '실시간',
  metric: '지표',
  source: '출처',
  bucket: '집계 단위',
  range: '기간',
  themeDark: '다크',
  themeLight: '라이트',
  resetButton: '초기화',
  ispPanelTitle: '조회 대상 ISP 선택',
  ispSelected: (n: number) => `${n}개 통신사 선택됨`,
  searchPlaceholder: '이름 또는 ASN으로 검색…',
  selectShown: '표시 항목 선택',
  clearAll: '전체 해제',
  ispHelp: '한국 통신사는 상단 고정, 해외 통신사는 국가별 그룹(접기 가능). 저표본 버킷은 차트와 툴팁에 표시됩니다.',
  dataGenerated: '데이터 생성',
  grid: '기준 해상도',
  retention: '보존',
  chartTitle: (metric: string, view: string) => `${metric} — ${view} 버킷`,
  emptyIsp: '하나 이상의 통신사를 선택하세요.',
  loading: '불러오는 중…',
  loadError: '데이터를 불러오지 못했습니다',
  runMock: 'npm run mock 으로 quality_data.json 을 생성하세요.',
  tooltipMedian: '중앙값',
  tooltipTotal: '총 측정 수',
  tooltipTrimmed: '제외된 이상치',
  tooltipRetained: '유효 데이터 비율',
  lowSampleWarn: '⚠ 측정 수 적음 — 해석에 주의',
  unitHops: '홉',
  // 스트리밍 품질 — 등급(rating_grade)
  ratingGrade: '품질 등급',
  // 지표 출처 표기 (제목 옆 ⓘ 호버)
  citeSource: '출처',
  // 지표별 실시간/시뮬 태그
  liveTag: '실시간',
  simTag: '시뮬',
  liveMixed: '일부 실시간',
  liveNote: '실측값 (표본 수 미제공)',
  // 데이터 소스 설정 모달
  apiButton: '데이터 소스',
  apiTitle: '데이터 소스 설정',
  apiDataUrl: '데이터 소스 URL (quality_data.json)',
  apiSave: '저장',
  apiCancel: '취소',
  apiReset: '기본값',
  apiSecurityNote: '※ 이 대시보드는 위 URL의 quality_data.json 한 파일만 불러옵니다. 실데이터는 GitHub Actions 수집기가 API 토큰(저장소 시크릿)으로 생성·갱신하며, 클라이언트(브라우저)에는 토큰이 전혀 저장되지 않습니다(NFR-02). 보통 내 GitHub raw URL을 가리킵니다.',
  // 스크린샷
  screenshotButton: '스크린샷',
  screenshotCapturing: '캡처 중…',
};
