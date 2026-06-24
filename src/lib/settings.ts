// 데이터 소스 설정 (localStorage 영속).
// 동작의 핵심은 "데이터 소스 URL" 하나뿐 — 수집기(GitHub Actions)가 토큰으로 생성해 둔
// quality_data.json 을 가리킨다. 클라이언트는 토큰을 다루지 않는다(NFR-02).

const KEY = 'fbqd-api-settings';

// 기본 데이터 소스 = 내 GitHub raw quality_data.json (수집기가 주기적으로 갱신).
// dev/prod 구분 없이 항상 이 URL을 기본으로 fetch. 모달에서 변경 가능(예: 로컬 테스트 시 /quality_data.json).
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

export function saveSettings(s: ApiSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
