// 종합지표(임원 요약) 패널 — 차트 목록 최상단.
// ① 변화 카드: 최근 N일 vs 이전 30일에서 ±10% 이상 움직인 ISP×지표 (악화 상위 2 + 개선 상위 1)
// ② 순위 매트릭스: 대한민국 통신 3사(기본) × 대표 지표 6종의 최근 N일 평균 + 상대 순위(1위 초록/꼴찌 빨강)
// 셀 클릭 → 해당 지표 차트로 점프. '해외 포함' 토글로 전체 ISP 확장.
// adjustable=true면 기간(일) 입력이 나타나 사용자가 취합 기간을 직접 지정(고정 7일 패널 바로 아래 쌍둥이).
// 계산은 전부 lib/summary.ts (클라이언트, coarse 티어) — 새 수집·데이터 포맷 변경 없음.

import { useMemo, useState } from 'react';
import { buildSummary, detectChanges, SUMMARY_METRICS, DEFAULT_RECENT_DAYS } from '../lib/summary.ts';
import { METRIC_BY_ID } from '../data/metrics.ts';
import { ISP_GROUPS, ISP_BY_ID } from '../data/isps.ts';
import { T } from '../config.ts';
import type { QualityData } from '../types.ts';

interface Props {
  data: QualityData;
  onJump: (metricId: string) => void;
  // 기간 조절 패널: 기간(일) 입력 노출 + 기본값. 미지정 시 고정 7일.
  adjustable?: boolean;
  defaultDays?: number;
}

// coarse 티어 실데이터 범위(IQI·Speed Test ~90일)에 맞춘 입력 한계.
const MIN_DAYS = 1;
const MAX_DAYS = 90;

// 한국 3사(통합 lgu 사용) 고정 + 해외는 토글로 확장.
const KR_IDS = ['kt', 'skb', 'lgu'];
const FOREIGN_IDS = ISP_GROUPS.filter((g) => !g.pinned).flatMap((g) => g.isps.map((i) => i.id));

// 값 표시: 100 이상은 정수, 미만은 소수 1자리.
const fmt = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));

export default function SummaryPanel({ data, onJump, adjustable = false, defaultDays = 30 }: Props) {
  const [foreign, setForeign] = useState(false);
  const [days, setDays] = useState(adjustable ? defaultDays : DEFAULT_RECENT_DAYS);
  const ispIds = useMemo(() => (foreign ? [...KR_IDS, ...FOREIGN_IDS] : KR_IDS), [foreign]);
  const metricIds = useMemo(() => SUMMARY_METRICS.map((m) => m.id), []);

  const rows = useMemo(() => buildSummary(data, ispIds, metricIds, days), [data, ispIds, metricIds, days]);
  const changes = useMemo(() => detectChanges(data, ispIds, metricIds, days), [data, ispIds, metricIds, days]);
  // 카드: 악화 상위 2 + 개선 상위 1 (없는 쪽은 생략).
  const cards = useMemo(() => {
    const worse = changes.filter((c) => c.worse).slice(0, 2);
    const better = changes.filter((c) => !c.worse).slice(0, 1);
    return [...worse, ...better];
  }, [changes]);

  return (
    <section className="panel summary-panel">
      <h2>
        {T.summaryTitle} — {foreign ? T.summaryScopeAll : T.summaryScopeKr} · {T.summaryWindow(days)}
        <span className="cite-info" tabIndex={0} aria-label={T.citeSource}>
          ⓘ<span className="cite-pop">{T.summaryMethod}</span>
        </span>
        {adjustable && (
          <label className="sum-days">
            {T.summaryDaysLabel}
            <input
              type="number" min={MIN_DAYS} max={MAX_DAYS} value={days}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n)) setDays(Math.min(Math.max(n, MIN_DAYS), MAX_DAYS));
              }}
            />
          </label>
        )}
        <label className="sum-toggle" style={adjustable ? { marginLeft: 12 } : undefined}>
          <input type="checkbox" checked={foreign} onChange={(e) => setForeign(e.target.checked)} />
          {T.summaryToggleForeign}
        </label>
      </h2>

      {cards.length === 0 ? (
        <p className="sum-nochange">{T.summaryNoChange(days)}</p>
      ) : (
        <div className="sum-cards">
          {cards.map((c) => {
            const metric = METRIC_BY_ID[c.metricId];
            const sign = c.deltaPct > 0 ? '+' : '';
            return (
              <button
                key={`${c.ispId}-${c.metricId}`}
                className={`sum-card ${c.worse ? 'worse' : 'better'}`}
                onClick={() => onJump(c.metricId)}
                title={T.summaryJumpTip}
              >
                <span className="sum-card-head">
                  {c.worse ? '▲' : '▼'} {ISP_BY_ID[c.ispId]?.name ?? c.ispId} · {metric.name}
                </span>
                <span className="sum-card-body">
                  {c.worse ? T.summaryWorse : T.summaryBetter} {sign}{c.deltaPct.toFixed(0)}%
                  {' '}({fmt(c.base)}→{fmt(c.recent)}{metric.unit})
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="sum-table-wrap">
        <table className="sum-table">
          <thead>
            <tr>
              <th className="sum-isp">ISP</th>
              {SUMMARY_METRICS.map((m) => (
                <th key={m.id} title={`${METRIC_BY_ID[m.id].name} (${METRIC_BY_ID[m.id].unit})`}>
                  {m.short}<small> {METRIC_BY_ID[m.id].unit}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ispIds.map((isp) => {
              const cells = rows.get(isp);
              if (!cells) return null;
              return (
                <tr key={isp}>
                  <td className="sum-isp">{ISP_BY_ID[isp]?.name ?? isp}</td>
                  {SUMMARY_METRICS.map((m) => {
                    const c = cells[m.id];
                    if (!c || c.v == null || c.rank == null) {
                      return <td key={m.id} className="sum-na">–</td>;
                    }
                    const pill = c.ranked >= 2 && c.rank === 1 ? 'top'
                      : c.ranked >= 2 && c.rank === c.ranked ? 'last' : 'mid';
                    return (
                      <td key={m.id}>
                        <button className="sum-cell" onClick={() => onJump(m.id)} title={T.summaryJumpTip}>
                          <span className={`rank-pill ${pill}`}>{c.rank}</span>
                          {fmt(c.v)}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
