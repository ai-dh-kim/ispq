// 피크타임 성능 저하 분석 위젯 (PRD §4 FR-04).
// 시간대 비교가 필요하므로 항상 fine(10분) 티어를 사용.

import { useMemo } from 'react';
import { peakAnalysis } from '../lib/peak.ts';
import { getTierPoints } from '../data/quality.ts';
import { colorForIsp } from '../theme.ts';
import { ISP_BY_ID } from '../data/isps.ts';
import { METRIC_BY_ID } from '../data/metrics.ts';
import { T } from '../config.ts';
import type { QualityData } from '../types.ts';

interface Props {
  metricId: string;
  data: QualityData;
  selectedIsps: string[];
  colorIndex: (ispId: string) => number;
}

const fmt = (x: number | null, suffix = '') => (x == null ? '–' : `${x.toFixed(1)}${suffix}`);

export default function PeakTimeWidget({ metricId, data, selectedIsps, colorIndex }: Props) {
  const metric = METRIC_BY_ID[metricId];

  const rows = useMemo(() => {
    return selectedIsps.map((ispId) => {
      const base = getTierPoints(data, ispId, metricId, 'fine');
      const points = base.filter((p) => p.mean != null).map((p) => ({ t: p.t, mean: p.mean }));
      return { ispId, ...peakAnalysis(points, metric.higherIsBetter) };
    });
  }, [data, selectedIsps, metricId, metric]);

  if (selectedIsps.length === 0) {
    return <div className="empty">{T.emptyIsp}</div>;
  }

  const defenseClass = (v: number | null) => (v == null ? '' : v >= 95 ? 'good' : v >= 85 ? 'warn' : 'bad');
  const spikeClass = (v: number | null) => (v == null ? '' : v <= 10 ? 'good' : v <= 30 ? 'warn' : 'bad');

  return (
    <>
      <div className="peak-grid">
        {rows.map((r) => (
          <div className="peak-card" key={r.ispId}>
            <div className="name">
              <span className="swatch" style={{ background: colorForIsp(colorIndex(r.ispId)) }} />
              {ISP_BY_ID[r.ispId]?.name || r.ispId}
            </div>
            {metric.higherIsBetter && (
              <div className="peak-row">
                <span>{T.defenseRate}</span>
                <span className={`val ${defenseClass(r.defenseRate)}`}>{fmt(r.defenseRate, '%')}</span>
              </div>
            )}
            <div className="peak-row">
              <span>{metric.higherIsBetter ? T.peakDrop : T.latencySpike}</span>
              <span className={`val ${spikeClass(r.spikeRate)}`}>{fmt(r.spikeRate, '%')}</span>
            </div>
            <div className="peak-row">
              <span>{T.busyAvg}</span>
              <span className="val">{fmt(r.busyAvg)} {metric.unit}</span>
            </div>
            <div className="peak-row">
              <span>{T.quietAvg}</span>
              <span className="val">{fmt(r.quietAvg)} {metric.unit}</span>
            </div>
          </div>
        ))}
      </div>
      <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 10 }}>{T.peakNote}</p>
    </>
  );
}
