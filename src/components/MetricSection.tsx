// 한 지표(metric)에 대한 섹션: 차트.
// 같은 출처의 지표들을 세로로 쌓아 한 페이지에서 스크롤로 보기 위한 단위.

import { useMemo } from 'react';
import MetricChart from './MetricChart.tsx';
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

export default function MetricSection(props: Props) {
  const { metricId, view, data, selectedIsps, range } = props;
  const metric = METRIC_BY_ID[metricId];

  const tier = RANGES[range].tier;

  // M-Lab 기반 지표의 '마지막 실데이터' 날짜(공지에 표기). 선택 ISP 중 가장 최신 non-null 시점.
  const mlabLastDate = useMemo(() => {
    if (!metric.mlabBased) return null;
    const axis = data.tiers[tier]?.t;
    if (!axis) return null;
    let last = -1;
    for (const isp of selectedIsps) {
      const blk = data.series[isp]?.[metricId]?.[tier];
      if (!blk) continue;
      const v = blk[0];
      for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) { if (i > last) last = i; break; }
    }
    return last >= 0
      ? new Date(axis[last]).toLocaleDateString('ko-KR', { timeZone: 'UTC', month: '2-digit', day: '2-digit' })
      : null;
  }, [data, selectedIsps, metricId, tier, metric.mlabBased]);

  return (
    <section className="panel metric-section">
      <h2>
        {metricId === 'nfSpeedIndex' ? `${metric.name} — 최근 180일(월별)` : T.chartTitle(metric.name, VIEWS[view].label)}
        {/* 근거 등급: 직접측정(A)은 기본이라 생략, 집계(B)·파생(C)만 표시해 주의 환기. */}
        {metric.cite.grade !== 'A' && (
          <span className={`grade-tag grade-${metric.cite.grade}`} title={T.gradeTip[metric.cite.grade]}>
            {T.gradeTag[metric.cite.grade]}
          </span>
        )}
        <span className="cite-info" tabIndex={0} aria-label={T.citeSource}>
          ⓘ
          <span className="cite-pop">
            {metric.cite.basis}{' '}
            <a href={metric.cite.url} target="_blank" rel="noopener noreferrer">{T.citeSource} ↗</a>
            {metric.cite.note && <span className="cite-note">{metric.cite.note}</span>}
          </span>
        </span>
      </h2>
      {metric.mlabBased && <p className="mlab-delay">{T.mlabDelayNotice(mlabLastDate)}</p>}
      <MetricChart {...props} />
    </section>
  );
}
