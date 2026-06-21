// 데이터 소스 설정 (localStorage 영속).
// 동작의 핵심은 "데이터 소스 URL" 하나뿐 — 수집기(GitHub Actions)가 토큰으로 생성해 둔
// quality_data.json 을 가리킨다. 클라이언트는 토큰을 다루지 않는다(NFR-02).

const BASE = import.meta.env.BASE_URL || '/';
const KEY = 'fbqd-api-settings';

// 배포(프로덕션)에서는 GitHub의 정적 quality_data.json(raw)을 기본으로 fetch.
// 로컬 개발(npm run dev)에서는 로컬 public 파일을 쓴다(원격 의존/CORS 회피).
// 수집기(GitHub Actions)가 이 파일을 주기적으로 갱신하므로 클라이언트는 토큰 0.
const RAW_DATA_URL =
  'https://raw.githubusercontent.com/ai-dh-kim/fixed-broadband-quality-dashboard/main/public/quality_data.json';

export interface ApiSettings {
  // 대시보드가 실제로 페치하는 정적 JSON 위치(내 GitHub raw URL 또는 로컬).
  dataUrl: string;
}

export const DEFAULT_SETTINGS: ApiSettings = {
  dataUrl: import.meta.env.PROD ? RAW_DATA_URL : `${BASE}quality_data.json`,
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
