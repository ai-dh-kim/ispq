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

export function colorForIsp(index: number): string {
  return PALETTE[index % PALETTE.length];
}
