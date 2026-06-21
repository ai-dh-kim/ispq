// 사용자 API/데이터 소스 설정 (localStorage 영속).
// 주의(NFR-02): 운영에서는 자격증명을 서버리스 수집기에서만 사용해야 한다.
// 아래 토큰 필드는 프로토타입 편의용이며, 실제로는 입력한 키로 quality_data.json
// 을 생성하는 백엔드/수집기를 가리키는 "데이터 소스 URL"이 동작의 핵심이다.

const BASE = import.meta.env.BASE_URL || '/';
const KEY = 'fbqd-api-settings';

// 배포(프로덕션)에서는 GitHub의 정적 quality_data.json(raw)을 기본으로 fetch.
// 로컬 개발(npm run dev)에서는 로컬 public 파일을 쓴다(원격 의존/CORS 회피).
// 수집기(GitHub Actions)가 이 파일을 주기적으로 갱신하므로 클라이언트는 토큰 0.
const RAW_DATA_URL =
  'https://raw.githubusercontent.com/ai-dh-kim/fixed-broadband-quality-dashboard/main/public/quality_data.json';

export type ProviderId = 'cloudflare' | 'mlab' | 'ripe';

export interface ProviderSetting {
  enabled: boolean;
  token: string;
}

export interface ApiSettings {
  // 대시보드가 실제로 페치하는 정적 JSON 위치. 라이브 백엔드로 교체 가능.
  dataUrl: string;
  providers: Record<ProviderId, ProviderSetting>;
}

export const DEFAULT_SETTINGS: ApiSettings = {
  dataUrl: import.meta.env.PROD ? RAW_DATA_URL : `${BASE}quality_data.json`,
  providers: {
    cloudflare: { enabled: false, token: '' },
    mlab: { enabled: false, token: '' },
    ripe: { enabled: false, token: '' },
  },
};

export function loadSettings(): ApiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ApiSettings>;
    return {
      dataUrl: parsed.dataUrl || DEFAULT_SETTINGS.dataUrl,
      providers: { ...DEFAULT_SETTINGS.providers, ...(parsed.providers || {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: ApiSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
