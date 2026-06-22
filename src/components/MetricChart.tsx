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
import { ISP_BY_ID } from '../data/isps.ts';
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

interface PointMeta { total: number | null; trimmed: number | null; retained: number | null; low: boolean; }
type DataPoint = { x: number; y: number | null; meta: PointMeta };

export default function MetricChart({ metricId, data, selectedIsps, view, range, sinceMs, theme, colorIndex }: Props) {
  const metric = METRIC_BY_ID[metricId];

  // 월별 인덱스(nfSpeedIndex)는 상단 기간과 무관하게 항상 고정 180일(coarse·1일 버킷)로 표시.
  const FIXED180 = metricId === 'nfSpeedIndex';
  const tier = FIXED180 ? 'coarse' : RANGES[range].tier;
  const viewDef = FIXED180 ? VIEWS['1day'] : VIEWS[view];

  // 차트에는 티어의 전체 데이터를 싣고(아래 series), 초기 보기 범위만 [effSince, maxMs]로 잡는다.
  // → zoom-out/pan 시 선택 기간 바깥의 (티어에 로드된) 과거 데이터가 실제로 드러난다.
  const axis = data.tiers[tier]?.t;
  const maxMs = axis && axis.length ? axis[axis.length - 1] : sinceMs;
  const effSince = FIXED180 ? maxMs - 180 * 86400000 : sinceMs;

  const { series, colors, discrete } = useMemo(() => {
    const series: { name: string; data: DataPoint[] }[] = [];
    const colors: string[] = [];
    const discrete: { seriesIndex: number; dataPointIndex: number; size: number; fillColor: string; strokeColor: string }[] = [];
    let si = 0;
    for (const ispId of selectedIsps) {
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
      pts.forEach((p, di) => {
        if (p.low) discrete.push({ seriesIndex: si, dataPointIndex: di, size: 5, fillColor: '#ffb300', strokeColor: color });
      });
      si++;
    }
    return { series, colors, discrete };
  }, [data, selectedIsps, metricId, tier, viewDef, sinceMs, colorIndex]);

  const chrome = CHROME[theme];

  const options: ApexOptions = useMemo(() => ({
    chart: {
      type: 'line',
      height: 440,
      background: 'transparent',
      foreColor: chrome.fore,
      animations: { enabled: false },
      toolbar: { tools: { download: true, selection: true, zoom: true, pan: true, reset: true } },
      zoom: { enabled: true, type: 'x', allowMouseWheelZoom: true },
    },
    theme: { mode: theme },
    colors,
    stroke: { width: 2, curve: 'straight' },
    markers: { size: 0, discrete },
    xaxis: { type: 'datetime', labels: { datetimeUTC: true }, min: effSince, max: maxMs },
    yaxis: {
      title: { text: `${metric.name} (${metric.unit})` },
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
  }), [theme, colors, discrete, metric, chrome, effSince, maxMs]);

  if (selectedIsps.length === 0) {
    return <div className="empty">{T.emptyIsp}</div>;
  }

  return (
    <div className="chart-wrap">
      <Chart key={theme} options={options} series={series} type="line" height={440} />
    </div>
  );
}
