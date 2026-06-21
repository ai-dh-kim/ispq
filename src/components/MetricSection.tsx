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

  // 현재 보기(티어)에서 이 지표가 실측 데이터인지: 실측 셀은 표본 수(n)가 null.
  // (지금은 Cloudflare 실데이터만 표본 수 미제공 → null. 표본 수를 주는 실소스를 붙이면 명시 신호로 교체.)
  const tier = RANGES[range].tier;
  const isLive = useMemo(() => {
    for (const isp of selectedIsps) {
      const blk = data.series[isp]?.[metricId]?.[tier];
      if (!blk) continue;
      const [v, n] = blk;
      for (let i = 0; i < v.length; i++) if (v[i] != null && n[i] == null) return true;
    }
    return false;
  }, [data, selectedIsps, metricId, tier]);

  return (
    <section className="panel metric-section">
      <h2>
        {T.chartTitle(metric.name, VIEWS[view].label)}
        <span className={`live-tag ${isLive ? 'live' : 'sim'}`}>{isLive ? T.liveTag : T.simTag}</span>
        <span className="cite-info" tabIndex={0} aria-label={T.citeSource}>
          ⓘ
          <span className="cite-pop">
            {metric.cite.basis}{' '}
            <a href={metric.cite.url} target="_blank" rel="noopener noreferrer">{T.citeSource} ↗</a>
          </span>
        </span>
      </h2>
      <MetricChart {...props} />
    </section>
  );
}
