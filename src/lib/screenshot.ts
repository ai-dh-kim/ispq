// 현재 보고 있는 화면(대시보드 DOM)을 PNG로 캡처해 다운로드.
// html2canvas 는 동적 import 로 로드해 초기 번들 크기를 유지한다.

export async function captureElement(el: HTMLElement, filename: string): Promise<void> {
  const { default: html2canvas } = await import('html2canvas');
  const bg = getComputedStyle(document.body).backgroundColor || '#ffffff';
  const canvas = await html2canvas(el, {
    backgroundColor: bg,
    scale: Math.min(window.devicePixelRatio || 1, 2),
    useCORS: true,
    logging: false,
    ignoreElements: (node: Element) => node.hasAttribute('data-screenshot-ignore'),
  });
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

export function timestampName(prefix = 'dashboard'): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}
