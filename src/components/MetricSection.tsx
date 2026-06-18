// 한 지표(metric)에 대한 섹션: 차트 + 피크타임 분석.
// 같은 출처의 지표들을 세로로 쌓아 한 페이지에서 스크롤로 보기 위한 단위.

import MetricChart from './MetricChart.tsx';
import PeakTimeWidget from './PeakTimeWidget.tsx';
import { METRIC_BY_ID } from '../data/metrics.ts';
import { VIEWS, T, type ViewKey, type RangeKey } from '../config.ts';
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
  const { metricId, view } = props;
  const metric = METRIC_BY_ID[metricId];

  return (
    <section className="panel metric-section">
      <h2>{T.chartTitle(metric.name, VIEWS[view].label)}</h2>
      <MetricChart {...props} />
      <h3 className="peak-subhead">{T.peakTitle}</h3>
      <PeakTimeWidget
        metricId={metricId}
        data={props.data}
        selectedIsps={props.selectedIsps}
        colorIndex={props.colorIndex}
      />
    </section>
  );
}
