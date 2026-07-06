// 선택 지표의 시계열 차트.
// - 전역 테마와 함께 즉시 변환 (FR-06 / NFR 차트 적응성)
// - 저표본 버킷은 마커 + 툴팁 경고로 표시 (FR-03 검증기)
// - 커스텀 툴팁에 총/절단/잔존 추적성 노출 (NFR)

import Chart from 'react-apexcharts';
import { useMemo } from 'react';
import type { ApexOptions } from 'apexcharts';
import { aggregateSeries } from '../lib/aggregate.ts';
import { getTierPoints } from '../data/quality.ts';
import { colorForIsp } from '../theme.ts';
import { ISP_BY_ID, COMBINE_GROUPS } from '../data/isps.ts';
import { METRIC_BY_ID, gradeFor } from '../data/metrics.ts';
import { VIEWS, RANGES, T, type ViewKey, type RangeKey } from '../config.ts';
import type { QualityData } from '../types.ts';
import type { ThemeMode } from '../theme.ts';

interface Props {
  metricId: string;
  data: QualityData;
  selectedIsps: string[];
  view: ViewKey;
  range: RangeKey;
  sinceMs: number;
  theme: ThemeMode;
  colorIndex: (ispId: string) => number;
}

const CHROME = {
  dark: { fore: '#b0b0b0', grid: '#333333' },
  light: { fore: '#555555', grid: '#e0e0e0' },
};
// 시리즈별 선 스타일(점선 길이). 색이 같은 위치에서 겹쳐도 구분되도록.
const DASH_PATTERN = [0, 6, 2, 10, 4, 8];
// 특정 ISP 고정 선 스타일: LG U+ 실선(0), KT 점선(6), SK 점점선(2).
const DASH_BY_ISP: Record<string, number> = {
  lgu: 0, 'lgu-3786': 0, 'lgu-17858': 0, kt: 6, skb: 2,
};

// v 이상의 '깔끔한'(1·1.2·1.5·2·2.5·3…) 수로 올림.
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
function niceCeil(v: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = NICE_STEPS.find((s) => n <= s + 1e-9) ?? 10;
  return Math.round(step * mag * 1000) / 1000;
}
// 격자 간격용 '깔끔한' 단위(1·2·5·10…).
function niceStep(x: number): number {
  if (x <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / mag;
  const s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return s * mag;
}
const round3 = (x: number) => Math.round(x * 1000) / 1000;

// 보이는 구간의 데이터 [lo,hi]에 맞춰 Y축 [min,max] 산정.
//  - pctFull(가능률 등): 0~100 고정(100% 초과 불가).
//  - 데이터가 0 근처까지 내려오면 0 기준, 상한만 데이터 바로 위로(과한 여백 X).
//  - 데이터가 0에서 멀리 떨어진 좁은 띠(예: RTT 10~13ms)면 위·아래를 모두 띠에 바짝 붙임.
function computeYRange(
  lo: number, hi: number, pctFull: boolean, hardMax: number,
): { min: number; max: number } | null {
  if (pctFull) return { min: 0, max: 100 };
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) return null;
  if (hi <= lo) return { min: 0, max: Math.min(niceCeil(hi * 1.1) || 1, hardMax) };
  const range = hi - lo;
  // 0에서 데이터까지 거리가 데이터 분포폭보다 작으면 0 기준으로(낮은 값 지표).
  if (lo <= range) return { min: 0, max: Math.min(niceCeil(hi * 1.05), hardMax) };
  // 0에서 먼 좁은 띠 → 위·아래를 격자 단위로 띠에 바짝(빈 공간 최소화).
  const step = niceStep(range / 3);
  const min = Math.max(0, Math.floor((lo - range * 0.25) / step) * step);
  const max = Math.min(Math.ceil((hi + range * 0.25) / step) * step, hardMax);
  return { min: round3(min), max: round3(max) };
}

// 터치 기기(모바일/태블릿) 감지 — 차트가 스크롤 제스처를 줌으로 가로채지 않도록 줌/팬을 끈다.
const IS_TOUCH = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

// 선택된 ISP에서, 합산 그룹의 member가 모두 선택됐으면 combo 하나(합산값)로 치환.
function effectiveIsps(selected: string[]): string[] {
  const set = new Set(selected);
  const result = [...selected];
  for (const [combo, members] of Object.entries(COMBINE_GROUPS)) {
    if (members.every((m) => set.has(m))) {
      for (const m of members) { const i = result.indexOf(m); if (i >= 0) result.splice(i, 1); }
      result.push(combo);
    }
  }
  return result;
}

interface PointMeta { total: number | null; trimmed: number | null; retained: number | null; low: boolean; }
type DataPoint = { x: number; y: number | null; meta: PointMeta };

export default function MetricChart({ metricId, data, selectedIsps, view, range, sinceMs, theme, colorIndex }: Props) {
  const metric = METRIC_BY_ID[metricId];

  // 월별 인덱스(nfSpeedIndex)는 상단 기간과 무관하게 항상 고정 180일(coarse·1일 버킷)로 표시.
  const FIXED180 = metricId === 'nfSpeedIndex';
  // 일별 수집(dailyCadence) 지표: 데이터가 하루 1스냅샷 → 버킷 선택과 무관하게 항상 coarse(1일 버킷).
  const DAILY = !!metric.dailyCadence;
  const tier = FIXED180 || DAILY ? 'coarse' : RANGES[range].tier;
  const viewDef = FIXED180 || DAILY ? VIEWS['1day'] : VIEWS[view];

  // 차트에는 티어의 전체 데이터를 싣고(아래 series), 초기 보기 범위만 [effSince, maxMs]로 잡는다.
  // → zoom-out/pan 시 선택 기간 바깥의 (티어에 로드된) 과거 데이터가 실제로 드러난다.
  const axis = data.tiers[tier]?.t;
  const maxMs = axis && axis.length ? axis[axis.length - 1] : sinceMs;
  const effSince = FIXED180 ? maxMs - 180 * 86400000 : sinceMs;

  const { series, colors, discrete, dashArray, lastLiveMs } = useMemo(() => {
    const series: { name: string; data: DataPoint[] }[] = [];
    const colors: string[] = [];
    const dashArray: number[] = [];
    const discrete: { seriesIndex: number; dataPointIndex: number; size: number; fillColor: string; strokeColor: string }[] = [];
    let si = 0;
    let lastLiveMs = -Infinity; // 값이 있는 가장 최신 시점 — M-Lab 지표의 X축을 여기서 멈추는 데 사용.
    for (const ispId of effectiveIsps(selectedIsps)) {
      const base = getTierPoints(data, ispId, metricId, tier);
      // -Infinity: sinceMs로 자르지 않고 티어 전체를 차트에 공급.
      const pts = aggregateSeries(base, viewDef, data.tiers[tier].baseMin, -Infinity);
      const color = colorForIsp(colorIndex(ispId), ispId);
      series.push({
        name: ISP_BY_ID[ispId]?.name || ispId,
        data: pts.map((p) => ({
          x: p.t,
          y: p.v == null ? null : Math.round(p.v * 100) / 100,
          meta: { total: p.total, trimmed: p.trimmed, retained: p.retained, low: p.low },
        })),
      });
      colors.push(color);
      dashArray.push(DASH_BY_ISP[ispId] ?? DASH_PATTERN[si % DASH_PATTERN.length]); // ISP 고정 또는 인덱스 스타일
      pts.forEach((p, di) => {
        if (p.v != null && p.t > lastLiveMs) lastLiveMs = p.t;
        if (p.low) discrete.push({ seriesIndex: si, dataPointIndex: di, size: 5, fillColor: '#ffb300', strokeColor: color });
      });
      si++;
    }
    return { series, colors, discrete, dashArray, lastLiveMs: Number.isFinite(lastLiveMs) ? lastLiveMs : null };
  }, [data, selectedIsps, metricId, tier, viewDef, sinceMs, colorIndex]);

  const chrome = CHROME[theme];

  // 지연 발행 지표(M-Lab ~1~2일 / dailyCadence 하루 1회): X축을 '최신 실데이터' 지점에서 멈춘다(현재까지 끌고 가지 않음).
  // 창 너비(선택 기간)는 유지하고 오른쪽 끝만 lastLiveMs로 당겨, 끝의 빈 구간이 안 보이게 한다.
  // dailyCadence는 1일 버킷이므로 24시간 같은 짧은 기간에선 점 1~2개뿐 → 창을 최소 7일로 늘린다.
  const winMs = DAILY ? Math.max(RANGES[range].ms, 7 * 86400000) : RANGES[range].ms;
  const lagCap = (!!metric.mlabBased || DAILY) && lastLiveMs != null && lastLiveMs < maxMs;
  const xMax = lagCap ? (lastLiveMs as number) : maxMs;
  const xMin = lagCap ? (lastLiveMs as number) - winMs : DAILY ? maxMs - winMs : effSince;

  // Y축 산정용 데이터 min/max는 '현재 화면에 보이는 X구간 [xMin,xMax]' 안에서만 구한다.
  // (티어 전체에서 구하면 화면 밖 스파이크가 축을 끌어올려 그래프가 작아 보임.)
  const yRange = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const p of s.data) {
      if (p.y != null && p.x >= xMin && p.x <= xMax) { if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; }
    }
    return computeYRange(lo, hi, !!metric.pctFull, metric.hard.max);
  }, [series, xMin, xMax, metric.pctFull, metric.hard.max]);

  const options: ApexOptions = useMemo(() => ({
    chart: {
      type: 'line',
      height: 440,
      background: 'transparent',
      foreColor: chrome.fore,
      animations: { enabled: false },
      toolbar: { tools: { download: true, selection: !IS_TOUCH, zoom: !IS_TOUCH, pan: !IS_TOUCH, reset: !IS_TOUCH } },
      // 터치 기기에선 줌/팬을 꺼 스크롤 제스처가 차트에 가로채여 의도치 않게 확대되는 문제 방지.
      zoom: { enabled: !IS_TOUCH, type: 'x', allowMouseWheelZoom: !IS_TOUCH },
    },
    theme: { mode: theme },
    colors,
    stroke: { width: 2, curve: FIXED180 ? 'stepline' : 'straight', dashArray },
    markers: { size: 0, discrete },
    xaxis: { type: 'datetime', labels: { datetimeUTC: true }, min: xMin, max: xMax },
    yaxis: {
      title: { text: `${metric.name} (${metric.unit})` },
      // 보이는 구간 데이터에 바짝 붙는 동적 축(가능률은 0~100 고정, 0에서 먼 좁은 띠는 위·아래 모두 타이트).
      ...(yRange ? { min: yRange.min, max: yRange.max } : {}),
      labels: { formatter: (v: number) => (v == null ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })) },
    },
    grid: { borderColor: chrome.grid, strokeDashArray: 3 },
    legend: { position: 'bottom', showForSingleSeries: true },
    tooltip: {
      // 공유(shared) 툴팁: x축 기준으로 떠서 버킷 밀도와 무관하게 항상 동작하고,
      // 선택된 모든 ISP 값을 색상별로 함께 보여 준다 (단일 호버의 시리즈 오인 문제 해소).
      shared: true,
      intersect: false,
      custom: ({ dataPointIndex, w }: { dataPointIndex: number; w: any }) => {
        const cfg = w.config.series as { name: string; data: DataPoint[] }[];
        let x: number | null = null;
        for (const s of cfg) {
          const p = s.data[dataPointIndex];
          if (p && p.x != null) { x = p.x; break; }
        }
        const when = x == null ? '' : new Date(x).toLocaleString('ko-KR', {
          timeZone: 'UTC', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        });
        const blocks = cfg.map((s, i) => {
          const pt = s.data[dataPointIndex];
          if (!pt) return '';
          const color = w.globals.colors[i];
          const m = pt.meta;
          const grade = gradeFor(metric, pt.y);
          const gradeStr = grade ? ` · ${grade}` : '';
          const valStr = pt.y == null ? '–' : `${pt.y} ${metric.unit}`;
          // 표본 수 미상(실측 percentile 데이터) → 카운트 대신 안내문.
          const sub = (m == null || m.total == null)
            ? `<div class="qtt-sub">${T.liveNote}</div>`
            : `<div class="qtt-sub">${T.tooltipTotal} ${m.total} · ${T.tooltipTrimmed} ${m.trimmed} · ${T.tooltipRetained} ${m.retained != null ? (m.retained * 100).toFixed(1) : '–'}% ${m.low ? `<span class="qtt-low-inline">${T.lowSampleWarn}</span>` : ''}</div>`;
          return `<div class="qtt-series">
            <div class="qtt-row">
              <span><span class="qtt-swatch" style="background:${color}"></span>${s.name}</span>
              <span>${valStr}${gradeStr}</span>
            </div>
            ${sub}
          </div>`;
        }).join('');
        return `<div class="qtt"><div class="qtt-title">${when}</div>${blocks}</div>`;
      },
    },
  }), [theme, colors, discrete, dashArray, metric, chrome, xMin, xMax, FIXED180, yRange]);

  if (selectedIsps.length === 0) {
    return <div className="empty">{T.emptyIsp}</div>;
  }

  return (
    <div className="chart-wrap">
      <Chart key={theme} options={options} series={series} type="line" height={440} />
    </div>
  );
}
