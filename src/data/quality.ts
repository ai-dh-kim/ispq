// 단일 정적 모크(quality_data.json) 로더 + 티어 디코딩.
// 프론트엔드는 오직 이 파일만 페치한다 (라이브 API 호출 없음).

import { useEffect, useState } from 'react';
import type { QualityData, TierKey } from '../types.ts';

const BASE = import.meta.env.BASE_URL || '/';
const DEFAULT_URL = `${BASE}quality_data.json`;

export interface QualityState {
  data: QualityData | null;
  loading: boolean;
  error: string | null;
}

// url 로 데이터 소스를 지정 가능 (API 설정의 "데이터 소스 URL" 연동 지점).
export function useQualityData(url: string = DEFAULT_URL): QualityState {
  const [state, setState] = useState<QualityState>({ data: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    fetch(url || DEFAULT_URL)
      .then((r) => { if (!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); })
      .then((json: QualityData) => { if (!cancelled) setState({ data: json, loading: false, error: null }); })
      .catch((e: Error) => { if (!cancelled) setState({ data: null, loading: false, error: e.message }); });
    return () => { cancelled = true; };
  }, [url]);
  return state;
}

export interface BasePoint { t: number; mean: number | null; total: number; kept: number; }

// 한 티어의 컬럼형 배열을 시간축과 결합해 디코딩.
export function getTierPoints(
  data: QualityData,
  ispId: string,
  metricId: string,
  tier: TierKey
): BasePoint[] {
  const entry = data.series[ispId]?.[metricId];
  const axis = data.tiers[tier]?.t;
  if (!entry || !axis) return [];
  const [v, n, k] = entry[tier];
  return axis.map((t, i) => ({
    t,
    mean: v[i] ?? null,
    total: n[i] ?? 0,
    kept: k[i] ?? 0,
  }));
}
