// 티어 기본 포인트를 선택 버킷 뷰(10분/1시간/1일)로 재집계하고 NFR 추적성
// 필드(총/절단/잔존/저표본)를 도출.

import { aggregateBuckets, isLowSample } from './stats.ts';
import type { BasePoint } from '../data/quality.ts';
import type { DisplayPoint } from '../types.ts';
import type { ViewDef } from '../config.ts';

function displayFromRaw(p: BasePoint, threshTier: 'fine' | 'mid' | 'coarse'): DisplayPoint {
  // 표본 수 미상(null)이면 추적성 필드는 null, 저표본 경고는 띄우지 않음.
  const hasCounts = p.total != null && p.kept != null;
  const total = p.total as number;
  const kept = p.kept as number;
  return {
    t: p.t,
    v: p.mean as number,
    total: p.total,
    kept: p.kept,
    trimmed: hasCounts ? total - kept : null,
    retained: hasCounts ? (total ? kept / total : 0) : null,
    low: hasCounts ? isLowSample(kept, threshTier) : false,
  };
}

export function aggregateSeries(
  basePoints: BasePoint[],
  view: ViewDef,
  tierBaseMin: number,
  sinceMs: number
): DisplayPoint[] {
  const pts = basePoints.filter((p) => p.t >= sinceMs && p.mean != null);

  // 뷰 해상도가 티어 기본과 같으면 원본 그대로 표시.
  if (view.baseMin <= tierBaseMin) {
    return pts.map((p) => displayFromRaw(p, view.threshTier));
  }

  const groups = new Map<number, BasePoint[]>();
  for (const p of pts) {
    const bucket = Math.floor(p.t / view.ms) * view.ms;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket)!.push(p);
  }

  const out: DisplayPoint[] = [];
  for (const [bucket, items] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const agg = aggregateBuckets(
      items.map((p) => ({ mean: p.mean, totalSamples: p.total, kept: p.kept })),
      view.threshTier
    );
    if (agg.mean == null) continue;
    out.push({
      t: bucket,
      v: agg.mean,
      total: agg.totalSamples,
      kept: agg.kept,
      trimmed: agg.trimmedSamples,
      retained: agg.retainedRatio,
      low: agg.lowSample,
    });
  }
  return out;
}

const DAY_MS = 86400000;

// 이동 중앙값(추이 보기): 각 날짜 = 그날 포함 직전 days일 하루 값의 중앙값.
// 그날 값이 없으면 null(데이터가 끝난 뒤로 선을 연장하지 않음), 창 안 값이 절반 미만이어도 null.
// 표본 수·저표본 표시는 하루 값의 속성이라 추이에서는 지운다.
export function rollingMedian<P extends { t: number; v: number | null }>(pts: P[], days: number): P[] {
  const need = Math.ceil(days / 2);
  return pts.map((p, i) => {
    let v: number | null = null;
    if (p.v != null) {
      const win: number[] = [];
      for (let j = i; j >= 0 && pts[j].t > p.t - days * DAY_MS; j--) if (pts[j].v != null) win.push(pts[j].v as number);
      if (win.length >= need) {
        win.sort((a, b) => a - b);
        const m = win.length >> 1;
        v = win.length % 2 ? win[m] : (win[m - 1] + win[m]) / 2;
      }
    }
    return { ...p, v, total: null, trimmed: null, retained: null, low: false };
  });
}
