// 한 지표(metric)에 대한 섹션: 차트.
// 같은 출처의 지표들을 세로로 쌓아 한 페이지에서 스크롤로 보기 위한 단위.

import { useEffect, useMemo, useState } from 'react';
import MetricChart from './MetricChart.tsx';
import { METRIC_BY_ID } from '../data/metrics.ts';
import { VIEWS, RANGES, TRENDS, T, type ViewKey, type RangeKey } from '../config.ts';
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
  trendDays?: number; // 추이 보기(이동 중앙값) 일수, 0이면 하루 값
}

// 차트별로 고를 수 있는 추이 일수(툴바 '추이'의 '끔' 제외 항목과 같다).
const TREND_DAYS = Object.values(TRENDS).map((t) => t.days).filter((d) => d > 0);

export default function MetricSection(props: Props) {
  const { metricId, view, data, selectedIsps, range } = props;
  const metric = METRIC_BY_ID[metricId];
  // 추이 보기는 1일 버킷으로 그리는 차트(일별 지표 또는 집계 단위 1일)에만 적용, 월별 Netflix 제외(MetricChart와 같은 조건).
  const trendable = metricId !== 'nfSpeedIndex' && (!!metric.dailyCadence || view === '1day');
  // 차트별 추이 설정(2026-11-17 사용자 요청): 추이 공지 줄의 체크박스(켬/끔)와 일수(7·30일)로 지표마다 따로 고른다.
  // 기본값은 상단 툴바 '추이' — 툴바 값을 바꾸면 모든 차트가 그 값으로 다시 맞춰진다(개별 설정은 그때 초기화).
  const globalDays = props.trendDays ?? 0;
  // trendOff 지표(패킷손실·RPKI·NIA·Steam)는 기본 꺼짐 — 툴바 값을 바꿔도 꺼진 상태로 다시 맞춘다(일수는 툴바 값을 따라 둬서 켜면 그 일수).
  const defaultOn = globalDays > 0 && !metric.trendOff;
  const [local, setLocal] = useState(() => ({ on: defaultOn, days: globalDays || TREND_DAYS[0] }));
  useEffect(() => { setLocal({ on: defaultOn, days: globalDays || TREND_DAYS[0] }); }, [globalDays, defaultOn]);
  const trend = trendable && local.on ? local.days : 0;

  // dailyCadence(일별 수집) 지표는 항상 coarse(1일 버킷) — MetricChart의 티어 강제와 일치시켜야 공지 날짜가 맞음.
  // 2026-11-17: 집계 1일 차트도 coarse에서 읽는다(MetricChart의 DAY1과 같은 조건).
  const tier = metric.dailyCadence || view === '1day' ? 'coarse' : RANGES[range].tier;

  // 지연 발행(M-Lab)·일별 수집(dailyCadence) 지표의 '마지막 실데이터' 날짜(공지에 표기). 선택 ISP 중 가장 최신 non-null 시점.
  const lastLiveDate = useMemo(() => {
    if (!metric.mlabBased && !metric.dailyCadence) return null;
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
  }, [data, selectedIsps, metricId, tier, metric.mlabBased, metric.dailyCadence]);

  return (
    <section className="panel metric-section" id={`metric-${metricId}`}>
      <h2>
        {metricId === 'nfSpeedIndex' ? `${metric.name} — 최근 180일(월별)`
          : metric.dailyCadence ? T.chartTitle(metric.name, VIEWS['1day'].label) + (trend ? T.trendTitle(trend) : '')
          : T.chartTitle(metric.name, VIEWS[view].label) + (trend ? T.trendTitle(trend) : '')}
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
            {/* 실제 1일 값이 아닌(누적·월별) 지표는 설명 맨 앞에 강조 — 일별 값으로 오해하지 않게(2026-11-11). */}
            {metric.cumulativeNote && <span className="cite-note cite-cum">{metric.cumulativeNote}</span>}
            {metric.cite.note && <span className="cite-note">{metric.cite.note}</span>}
          </span>
        </span>
      </h2>
      {metric.mlabBased && <p className="mlab-delay">{T.mlabDelayNotice(lastLiveDate)}</p>}
      {/* 표본 수 미제공(noSamples): 툴팁에 ISP마다 반복하는 대신 여기 공지에 한 번만 — 일별 공지가 있으면 그 뒤에 이어 붙임. */}
      {metric.dailyCadence && (
        <p className="mlab-delay">{T.dailyDelayNotice(lastLiveDate, metric.windowNote)}{metric.noSamples ? ` ${T.noSampleNote}` : ''}</p>
      )}
      {metric.noSamples && !metric.dailyCadence && <p className="mlab-delay">ℹ {T.noSampleNote}</p>}
      {trendable && (
        <div className={`mlab-delay trend-note${trend ? '' : ' trend-off'}`}>
          <label className="trend-toggle">
            <input type="checkbox" checked={local.on}
              onChange={(e) => setLocal((l) => ({ ...l, on: e.target.checked }))} />
            {T.trendToggle}
          </label>
          {/* 일수를 고르면 꺼져 있어도 바로 켠다(고른 걸 바로 보게). */}
          <select className="trend-days" value={local.days} aria-label="추이 일수"
            onChange={(e) => setLocal({ on: true, days: Number(e.target.value) })}>
            {TREND_DAYS.map((d) => <option key={d} value={d}>{d}일 이동 중앙값</option>)}
          </select>
          <span className="trend-text">{trend ? T.trendNotice(trend) : T.trendOffNotice}</span>
        </div>
      )}
      <MetricChart {...props} trendDays={trend} />
    </section>
  );
}
