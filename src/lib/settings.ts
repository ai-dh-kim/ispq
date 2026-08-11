// 데이터 소스 설정 (localStorage 영속).
// 동작의 핵심은 "데이터 소스 URL" 하나뿐 — 수집기(GitHub Actions)가 토큰으로 생성해 둔
// quality_data.json 을 가리킨다. 클라이언트는 토큰을 다루지 않는다(NFR-02).

const KEY = 'fbqd-api-settings';

// 기본 데이터 소스 = 내 GitHub raw quality_data.json (수집기가 주기적으로 갱신).
// dev/prod 구분 없이 항상 이 URL을 기본으로 fetch. 화면에서 바꾸는 경로는 없다(설정 모달 2026-07-23 제거).
// loadSettings가 localStorage를 계속 읽는 건 모달 시절에 저장된 값이 남아 있을 수 있어서다(레거시 존중).
const RAW_DATA_URL =
  'https://raw.githubusercontent.com/ai-dh-kim/ispq/main/public/quality_data.json';

export interface ApiSettings {
  // 대시보드가 실제로 페치하는 정적 JSON 위치(기본: 내 GitHub raw URL).
  dataUrl: string;
}

export const DEFAULT_SETTINGS: ApiSettings = {
  dataUrl: RAW_DATA_URL,
};

export function loadSettings(): ApiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ApiSettings>;
    return { dataUrl: parsed.dataUrl || DEFAULT_SETTINGS.dataUrl };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
