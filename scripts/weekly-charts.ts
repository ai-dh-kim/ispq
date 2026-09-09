// 주간 요약 메일용 '일별 추이' 차트 (2026-09-09, 핸드오프 §17).
// 지표 하나 = PNG 하나: KT | SKB | LG U+ 세 패널, 각 패널에 지난주(진한 선+점)·1주 전(연한)·2주 전(더 연한) 월~일 7점.
// 세 패널은 y축을 공유해 사업자 간 수준 차이가 그대로 보인다.
//
// 왜 PNG인가: Gmail은 <svg>·<canvas>를 제거한다. 그래서 SVG를 그린 뒤 resvg로 래스터화해 저장소에 커밋하고,
// 메일은 '커밋 SHA 고정 raw URL'로 참조한다(파일명은 매주 덮어써 저장소가 안 커지고, 옛 메일 이미지는 SHA로 영구 유지).
// 글자는 전부 ASCII(날짜·숫자·KT/SKB/LG U+)만 쓴다 — 러너(리눅스)에 한글 폰트가 없어서 한글은 HTML 쪽 캡션에만.

import { Resvg } from '@resvg/resvg-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QualityData } from '../src/types.ts';

const DAY = 86400000;
// src/theme.ts BRAND_COLORS 와 동일(그 모듈은 브라우저 저장소를 만지므로 Node에서 import하지 않고 값만 복제).
const ISP_COLOR: Record<string, string> = { kt: '#00BEAC', skb: '#3617CE', lgu: '#E5007A' };
const ISP_LABEL: Record<string, string> = { kt: 'KT', skb: 'SKB', lgu: 'LG U+' };
export const CHART_ISPS = ['lgu', 'kt', 'skb']; // 패널 순서: LG U+ 맨 앞(2026-09-09 사용자 지정)
const WEEK_STYLE = [ // [0]=지난주 [1]=1주 전 [2]=2주 전
  { opacity: 1, width: 4, dots: true },
  { opacity: 0.45, width: 3, dots: false },
  { opacity: 0.22, width: 3, dots: false },
];

export interface ChartSpec { id: string; short: string; unit: string }
export interface ChartSeries { isp: string; weeks: (number | null)[][] } // weeks[w][d] — w: 0 지난주 / 1 / 2, d: 월(0)~일(6)

// coarse 버킷에서 (주 오프셋 w, 요일 d) 값을 꺼낸다. 버킷 키 = UTC 자정 = 날짜 라벨.
export function extractSeries(data: QualityData, metric: string, weekFrom: number): ChartSeries[] {
  const axis = data.tiers.coarse.t;
  const idx = new Map<number, number>(); axis.forEach((t, i) => idx.set(t, i));
  return CHART_ISPS.map((isp) => {
    const v = data.series[isp]?.[metric]?.coarse?.[0];
    const weeks = [0, 1, 2].map((w) => Array.from({ length: 7 }, (_, d) => { const i = idx.get(weekFrom - w * 7 * DAY + d * DAY); return v && i != null ? v[i] : null; }));
    return { isp, weeks };
  });
}

const niceNum = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$/, '');

// 2배 해상도(레티나)로 그린다: 표시 640×125 → 1280×250.
export function weeklyChartSvg(series: ChartSeries[], dayLabels: string[], unit: string): string {
  const W = 1280, H = 250, PANEL_W = 400, GAP = 40, LEFT = 20;
  const PAD_L = 58, PAD_R = 14, PAD_T = 34, PAD_B = 30;
  const vals = series.flatMap((s) => s.weeks.flat()).filter((x): x is number => x != null);
  let lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1;
  if (hi === lo) { hi = lo + (Math.abs(lo) || 1) * 0.1; lo = lo - (Math.abs(lo) || 1) * 0.1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  if (lo < 0 && vals.every((x) => x >= 0)) lo = 0; // 음수 불가 지표는 0에서 시작
  const ticks = [lo, (lo + hi) / 2, hi];
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<rect width="${W}" height="${H}" fill="#ffffff"/>`];
  series.forEach((s, p) => {
    const x0 = LEFT + p * (PANEL_W + GAP), px0 = x0 + PAD_L, px1 = x0 + PANEL_W - PAD_R, py0 = PAD_T, py1 = H - PAD_B;
    const X = (d: number) => px0 + (d / 6) * (px1 - px0), Y = (v: number) => py1 - ((v - lo) / (hi - lo)) * (py1 - py0);
    out.push(`<rect x="${x0}" y="6" width="${PANEL_W}" height="${H - 12}" rx="8" fill="#ffffff" stroke="#d7e0e8" stroke-width="2"/>`);
    out.push(`<text x="${x0 + 14}" y="26" font-family="sans-serif" font-size="20" font-weight="700" fill="${ISP_COLOR[s.isp]}">${ISP_LABEL[s.isp]}</text>`);
    for (const t of ticks) out.push(`<line x1="${px0}" y1="${Y(t).toFixed(1)}" x2="${px1}" y2="${Y(t).toFixed(1)}" stroke="#e5e9ee" stroke-width="2"/>`,
      `<text x="${px0 - 8}" y="${(Y(t) + 6).toFixed(1)}" font-family="sans-serif" font-size="17" fill="#8496a4" text-anchor="end">${niceNum(t)}</text>`);
    dayLabels.forEach((lab, d) => out.push(`<text x="${X(d).toFixed(1)}" y="${H - 9}" font-family="sans-serif" font-size="17" fill="#8496a4" text-anchor="middle">${lab}</text>`));
    // 2주 전 → 지난주 순으로 그려 지난주가 맨 위에 오게
    for (let w = 2; w >= 0; w--) {
      const st = WEEK_STYLE[w]; let dpath = '', pen = false;
      s.weeks[w].forEach((v, d) => { if (v == null) { pen = false; return; } dpath += `${pen ? 'L' : 'M'}${X(d).toFixed(1)} ${Y(v).toFixed(1)} `; pen = true; });
      if (dpath) out.push(`<path d="${dpath.trim()}" fill="none" stroke="${ISP_COLOR[s.isp]}" stroke-opacity="${st.opacity}" stroke-width="${st.width}" stroke-linejoin="round" stroke-linecap="round"/>`);
      if (st.dots) s.weeks[w].forEach((v, d) => { if (v != null) out.push(`<circle cx="${X(d).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="6" fill="#ffffff" stroke="${ISP_COLOR[s.isp]}" stroke-width="3"/>`); });
    }
    // 지난주 마지막 유효값 라벨
    const last = [...s.weeks[0]].map((v, d) => ({ v, d })).filter((o) => o.v != null).pop();
    if (last) out.push(`<text x="${px1}" y="${(py0 - 8)}" font-family="sans-serif" font-size="17" fill="#54697a" text-anchor="end">${niceNum(last.v as number)}${unit}</text>`);
  });
  out.push('</svg>');
  return out.join('');
}

export function svgToPng(svg: string): Buffer {
  const r = new Resvg(svg, { font: { loadSystemFonts: true, sansSerifFamily: process.platform === 'win32' ? 'Arial' : 'DejaVu Sans' } });
  return Buffer.from(r.render().asPng());
}

export interface RenderedChart { id: string; short: string; unit: string; file: string; bytes: number }

// 지표별 PNG를 outDir 에 'weekly-<metric>.png' 로 저장(매주 덮어씀).
export async function renderWeeklyCharts(data: QualityData, weekFrom: number, specs: ChartSpec[], outDir: string): Promise<RenderedChart[]> {
  await mkdir(outDir, { recursive: true });
  const dayLabels = Array.from({ length: 7 }, (_, d) => { const t = new Date(weekFrom + d * DAY); return `${t.getUTCMonth() + 1}/${t.getUTCDate()}`; });
  const out: RenderedChart[] = [];
  for (const spec of specs) {
    const png = svgToPng(weeklyChartSvg(extractSeries(data, spec.id, weekFrom), dayLabels, spec.unit));
    const file = `weekly-${spec.id}.png`;
    await writeFile(resolve(outDir, file), png);
    out.push({ ...spec, file, bytes: png.length });
  }
  return out;
}
