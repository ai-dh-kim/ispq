// 티어 기본 포인트를 선택 버킷 뷰(10분/1시간/1일)로 재집계하고 NFR 추적성
// 필드(총/절단/잔존/저표본)를 도출.

import { aggregateBuckets, isLowSample } from './stats.ts';
import type { BasePoint } from '../data/quality.ts';
import type { DisplayPoint } from '../types.ts';
import type { ViewDef } from '../config.ts';

function displayFromRaw(p: BasePoint, threshTier: 'fine' | 'mid' | 'coarse'): DisplayPoint {
  return {
    t: p.t,
    v: p.mean as number,
    total: p.total,
    kept: p.kept,
    trimmed: p.total - p.kept,
    retained: p.total ? p.kept / p.total : 0,
    low: isLowSample(p.kept, threshTier),
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
