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
import { METRIC_BY_ID } from '../data/metrics.ts';
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

interface PointMeta { total: number; trimmed: number; retained: number; low: boolean; }
type DataPoint = { x: number; y: number | null; meta: PointMeta };

export default function MetricChart({ metricId, data, selectedIsps, view, range, sinceMs, theme, colorIndex }: Props) {
  const metric = METRIC_BY_ID[metricId];
  const tier = RANGES[range].tier;
  const viewDef = VIEWS[view];

  const { series, colors, discrete } = useMemo(() => {
    const series: { name: string; data: DataPoint[] }[] = [];
    const colors: string[] = [];
    const discrete: { seriesIndex: number; dataPointIndex: number; size: number; fillColor: string; strokeColor: string }[] = [];
    let si = 0;
    for (const ispId of selectedIsps) {
      const base = getTierPoints(data, ispId, metricId, tier);
      const pts = aggregateSeries(base, viewDef, data.tiers[tier].baseMin, sinceMs);
      const color = colorForIsp(colorIndex(ispId));
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
    xaxis: { type: 'datetime', labels: { datetimeUTC: true } },
    yaxis: {
      title: { text: `${metric.name} (${metric.unit})` },
      labels: { formatter: (v: number) => (v == null ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })) },
    },
    grid: { borderColor: chrome.grid, strokeDashArray: 3 },
    legend: { position: 'bottom', showForSingleSeries: true },
    tooltip: {
      shared: false,
      custom: ({ seriesIndex, dataPointIndex, w }: { seriesIndex: number; dataPointIndex: number; w: any }) => {
        const pt: DataPoint = w.config.series[seriesIndex].data[dataPointIndex];
        const name: string = w.config.series[seriesIndex].name;
        const m = pt?.meta;
        const retainedPct = m && m.retained != null ? (m.retained * 100).toFixed(1) : '–';
        const low = m?.low ? `<div class="qtt-low">${T.lowSampleWarn}</div>` : '';
        return `<div class="qtt">
          <div class="qtt-title">${name}</div>
          <div class="qtt-row"><span>${metric.name}</span><span>${pt.y == null ? '–' : pt.y} ${metric.unit}</span></div>
          ${low}
          <div class="qtt-meta">
            <div class="qtt-row"><span>${T.tooltipTotal}</span><span>${m?.total ?? '–'}</span></div>
            <div class="qtt-row"><span>${T.tooltipTrimmed}</span><span>${m?.trimmed ?? '–'}</span></div>
            <div class="qtt-row"><span>${T.tooltipRetained}</span><span>${retainedPct}%</span></div>
          </div>
        </div>`;
      },
    },
  }), [theme, colors, discrete, metric, chrome]);

  if (selectedIsps.length === 0) {
    return <div className="empty">{T.emptyIsp}</div>;
  }

  return (
    <div className="chart-wrap">
      <Chart key={theme} options={options} series={series} type="line" height={440} />
    </div>
  );
}
