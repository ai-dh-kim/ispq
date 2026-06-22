// 스냅샷(비시계열) 지표 표. 시간 추이가 없는 "기간 집계 단일값"(예: Cloudflare 90일 집계)을
// 시계열 차트 대신 ISP × 지표 표로 보여 준다. 선택 출처에 해당하는 스냅샷 지표만 표시.

import { SNAPSHOT_METRICS } from '../data/metrics.ts';
import { ISP_BY_ID } from '../data/isps.ts';
import { colorForIsp } from '../theme.ts';
import { T } from '../config.ts';
import type { QualityData } from '../types.ts';

interface Props {
  sourceId: string;
  data: QualityData;
  selectedIsps: string[];
  colorIndex: (ispId: string) => number;
}

export default function SnapshotTable({ sourceId, data, selectedIsps, colorIndex }: Props) {
  const metrics = SNAPSHOT_METRICS.filter((m) => m.source === sourceId);
  if (metrics.length === 0 || selectedIsps.length === 0) return null;

  const snap = data.snapshot ?? {};
  const cite = metrics[0].cite; // 같은 출처라 출처 표기 공유

  return (
    <section className="panel snapshot-panel">
      <h2>
        {T.snapshotTitle}
        <span className="cite-info" tabIndex={0} aria-label={T.citeSource}>
          ⓘ
          <span className="cite-pop">
            {cite.basis}{' '}
            <a href={cite.url} target="_blank" rel="noopener noreferrer">{T.citeSource} ↗</a>
          </span>
        </span>
      </h2>
      <p className="snapshot-note">{T.snapshotNote}</p>
      <div className="snapshot-scroll">
        <table className="snapshot-table">
          <thead>
            <tr>
              <th>{T.ispCol}</th>
              {metrics.map((m) => (
                <th key={m.id}>{m.name} <span className="unit">({m.unit})</span></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {selectedIsps.map((isp) => (
              <tr key={isp}>
                <td className="isp-cell">
                  <span className="swatch" style={{ background: colorForIsp(colorIndex(isp)) }} />
                  {ISP_BY_ID[isp]?.name || isp}
                </td>
                {metrics.map((m) => {
                  const v = snap[isp]?.[m.id];
                  return (
                    <td key={m.id} className="num">
                      {v == null ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
