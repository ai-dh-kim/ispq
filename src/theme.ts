// 테마 영속화 (FR-06) + ISP별 안정적 색상 팔레트.

export type ThemeMode = 'dark' | 'light';
const KEY = 'fbqd-theme';

export function loadTheme(): ThemeMode {
  return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(KEY, theme);
}

// 다크(#121212)·라이트(#ffffff) 양쪽에서 잘 보이는 고대비 팔레트.
const PALETTE = [
  '#4da3ff', '#ff6f61', '#42d6a4', '#ffb300', '#b388ff',
  '#26c6da', '#ff80ab', '#9ccc65', '#ffa726', '#7e9eff',
  '#ef5350', '#66bb6a', '#ab47bc', '#29b6f6', '#d4e157',
  '#ec407a', '#5c6bc0', '#26a69a', '#ffca28', '#8d6e63',
];

// 국내 3사 브랜드(BI) 색상 — 해당 ISP는 팔레트 대신 이 색을 사용.
const BRAND_COLORS: Record<string, string> = {
  skb: '#3617CE',         // SK 브로드밴드 (54,23,206)
  kt: '#00BEAC',          // KT (0,190,172)
  lgu: '#E5007A',         // LG U+ 통합 (229,0,122)
  'lgu-3786': '#E5007A',  // LG U+ AS3786
  'lgu-17858': '#ff66ab', // LG U+ AS17858 (구분 위해 약간 밝게)
  // NIA 속도측정 전용 케이블사(3사 브랜드색과 겹치지 않는 색으로 고정)
  dlive: '#1E88E5',       // 딜라이브 (파랑)
  lghv: '#8E24AA',        // LG헬로비전 (보라)
  hcn: '#F57C00',         // HCN (주황)
  cmb: '#2E7D32',         // CMB (초록)
  etc: '#9E9E9E',         // 기타 (회색)
};

export function colorForIsp(index: number, ispId?: string): string {
  if (ispId && BRAND_COLORS[ispId]) return BRAND_COLORS[ispId];
  return PALETTE[index % PALETTE.length];
}
