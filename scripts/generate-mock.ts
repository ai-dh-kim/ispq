// 모크 데이터 생성기 (PRD §4 FR-01 + FR-07).
// 단일 public/quality_data.json 을 다중 해상도(티어)로 생성:
//   fine   : 10분 버킷 · 최근 2일  (실제 원샘플 생성 후 FR-03 절단 — "10분 정제")
//   mid    : 1시간 버킷 · 최근 30일 (대표 집계 메타)
//   coarse : 1일 버킷 · 최근 365일 (대표 집계 메타, 최대 1년 범위 지원)
// 각 버킷은 절단평균 메타(총샘플 n / 잔존 k)를 보유하므로 모든 범위에서
// 커스텀 툴팁(NFR)이 동작한다. 실 API 연동 시 simulate* 부분만 교체하면 된다.
//
// 실행: node scripts/generate-mock.ts  (Node 24 타입 스트리핑)

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_ISPS } from '../src/data/isps.ts';
import { METRICS, METRIC_BY_ID } from '../src/data/metrics.ts';
import { trimmedStats } from '../src/lib/stats.ts';
import { TIER_BASE_MIN } from '../src/config.ts';
import type { QualityData, TierBlock, TierKey } from '../src/types.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../public/quality_data.json');
const DAY = 86400000;
const GRID_MS = 10 * 60 * 1000;

const FORCE_SIM = process.env.DATA_MODE === 'sim'; // 현재 항상 sim (모크)
void FORCE_SIM;

// ---- 시뮬레이터 ----
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}
function rng(seedStr: string): () => number {
  let a = 0;
  for (let i = 0; i < seedStr.length; i++) a = (a + seedStr.charCodeAt(i) * (i + 1)) >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const REGION_TIER: Record<string, number> = {
  KR: 1.0, JP: 0.95, US: 0.78, CA: 0.8, UK: 0.8, DE: 0.85, FR: 0.85, IT: 0.78, ES: 0.82, NL: 0.9, AU: 0.7,
};
const BASE: Record<string, { good: number; spread: number; busy: number }> = {
  latency: { good: 8, spread: 0.25, busy: 0.4 },
  jitter: { good: 1.5, spread: 0.5, busy: 0.8 },
  bandwidth: { good: 950, spread: 0.2, busy: -0.25 },
  httpErrorRate: { good: 0.2, spread: 0.8, busy: 1.5 },
  meanThroughput: { good: 920, spread: 0.18, busy: -0.22 },
  minRtt: { good: 6, spread: 0.2, busy: 0.15 },
  lossRate: { good: 0.1, spread: 1.0, busy: 2.0 },
  cwnd: { good: 4200, spread: 0.3, busy: -0.2 },
  pacingRate: { good: 900, spread: 0.2, busy: -0.2 },
  pingAvg: { good: 9, spread: 0.25, busy: 0.4 },
  availability: { good: 99.95, spread: 0.02, busy: -0.05 },
  hops: { good: 11, spread: 0.15, busy: 0.05 },
  asPathFlaps: { good: 0.2, spread: 1.2, busy: 1.0 },
  dnsResolve: { good: 18, spread: 0.3, busy: 0.5 },
};
const HIGHER_IS_BETTER = new Set(['bandwidth', 'meanThroughput', 'cwnd', 'pacingRate', 'availability']);

// 22시 피크 / 03시 한산의 부하 곡선 (0..1).
function diurnal(hour: number): number {
  const sigma = 3;
  const raw = Math.abs(hour - 22);
  const dist = Math.min(raw, 24 - raw);
  return Math.exp(-(dist * dist) / (2 * sigma * sigma));
}

// ISP/지표/시각의 중심값 (부하·계절성 반영).
function centerValue(ispId: string, groupId: string, metricId: string, t: number, load: number): number {
  const base = BASE[metricId];
  const tier = REGION_TIER[groupId] ?? 0.8;
  const personality = hash(ispId + metricId);
  const tierPenalty = (1 - tier) + personality * 0.15;

  let center = HIGHER_IS_BETTER.has(metricId)
    ? base.good * (1 - tierPenalty * 0.5)
    : base.good * (1 + tierPenalty * 2.5);

  center *= 1 + base.busy * load * (0.5 + personality); // 부하 저하

  // 완만한 계절성 (±6%) — 1년 차트에 추세 부여.
  const doy = (t / DAY) % 365;
  center *= 1 + 0.06 * Math.sin((2 * Math.PI * doy) / 365 + personality * 6);
  return center;
}

// fine 티어: 실제 원샘플 배열 생성 (노이즈·이상치 포함).
function simulateSamples(ispId: string, groupId: string, metricId: string, t: number): number[] {
  const rand = rng(`${ispId}|${metricId}|${t}`);
  const center = centerValue(ispId, groupId, metricId, t, diurnal(new Date(t).getUTCHours()));
  const base = BASE[metricId];
  const personality = hash(ispId + metricId);

  // 표본 수: 가끔 저표본(<10) 구간 발생.
  const count = rand() < 0.08 ? 4 + Math.floor(rand() * 5) : 25 + Math.floor(rand() * 60);
  void personality;

  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let v = center * (1 + gaussian(rand) * base.spread * 0.35);
    if (rand() < 0.06) {
      // 로컬 단말 노이즈(불량 wifi/CPU 부하): 처리량 붕괴 / 지연·손실 급등.
      v = HIGHER_IS_BETTER.has(metricId) ? v * (rand() < 0.5 ? 0.15 : 1.0) : v * (3 + rand() * 8);
    }
    if (!HIGHER_IS_BETTER.has(metricId)) v = Math.max(0, v);
    if (metricId === 'availability') v = Math.min(100, v);
    if (metricId === 'hops') v = Math.round(v);
    out.push(v);
  }
  return out;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

// mid/coarse 티어: 대표 집계 직접 합성 (수천 샘플 생성 회피, 메타는 현실적으로).
function synthAggregate(ispId: string, groupId: string, metricId: string, t: number, tier: 'mid' | 'coarse', rand: () => number) {
  let load: number;
  if (tier === 'mid') {
    load = diurnal(new Date(t).getUTCHours());
  } else {
    // 일 단위: 일 평균 부하 + 주말 가중.
    const dow = new Date(t).getUTCDay();
    load = 0.42 + (dow === 0 || dow === 6 ? 0.1 : 0);
  }
  const metric = METRIC_BY_ID[metricId];
  let mean = centerValue(ispId, groupId, metricId, t, load) * (1 + gaussian(rand) * 0.03);
  if (!HIGHER_IS_BETTER.has(metricId)) mean = Math.max(0, mean);
  if (metricId === 'availability') mean = Math.min(100, mean);
  mean = Math.min(Math.max(mean, metric.hard.min), metric.hard.max);

  const n = tier === 'mid' ? 150 + Math.floor(rand() * 250) : 2500 + Math.floor(rand() * 3500);
  const k = Math.round(n * (0.9 - rand() * 0.04));
  return { mean: round(mean), n, k };
}

// ---- 티어 조립 ----
interface TierGen { key: TierKey; baseMin: number; days: number; }
const TIER_GEN: TierGen[] = [
  { key: 'fine', baseMin: TIER_BASE_MIN.fine, days: 2 },
  { key: 'mid', baseMin: TIER_BASE_MIN.mid, days: 30 },
  { key: 'coarse', baseMin: TIER_BASE_MIN.coarse, days: 365 },
];

function timeAxis(now: number, baseMin: number, days: number): number[] {
  const step = baseMin * 60 * 1000;
  const start = now - days * DAY;
  const axis: number[] = [];
  for (let t = Math.floor(start / step) * step; t <= now; t += step) axis.push(t);
  return axis;
}

async function main() {
  const now = Math.floor(Date.now() / GRID_MS) * GRID_MS;
  console.log('[mock] generating single multi-tier quality_data.json …');

  const tiers: QualityData['tiers'] = {
    fine: { baseMin: TIER_BASE_MIN.fine, t: [] },
    mid: { baseMin: TIER_BASE_MIN.mid, t: [] },
    coarse: { baseMin: TIER_BASE_MIN.coarse, t: [] },
  };
  for (const g of TIER_GEN) tiers[g.key].t = timeAxis(now, g.baseMin, g.days);

  const series: QualityData['series'] = {};
  let points = 0;

  for (const isp of ALL_ISPS) {
    series[isp.id] = {};
    for (const metric of METRICS) {
      const entry = {} as Record<TierKey, TierBlock>;
      for (const g of TIER_GEN) {
        const axis = tiers[g.key].t;
        const v: (number | null)[] = [];
        const n: (number | null)[] = [];
        const k: (number | null)[] = [];
        for (const t of axis) {
          if (g.key === 'fine') {
            const s = trimmedStats(simulateSamples(isp.id, isp.groupId, metric.id, t), { hard: metric.hard });
            v.push(s.mean == null ? null : round(s.mean));
            n.push(s.totalSamples);
            k.push(s.kept);
          } else {
            const rand = rng(`${isp.id}|${metric.id}|${g.key}|${t}`);
            const a = synthAggregate(isp.id, isp.groupId, metric.id, t, g.key, rand);
            v.push(a.mean); n.push(a.n); k.push(a.k);
          }
          points++;
        }
        entry[g.key] = [v, n, k];
      }
      series[isp.id][metric.id] = entry;
    }
  }

  const payload: QualityData = {
    generatedAt: new Date().toISOString(),
    mode: 'sim',
    lang: 'ko',
    tiers,
    isps: ALL_ISPS.map((i) => i.id),
    metrics: METRICS.map((m) => m.id),
    series,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload));
  const kb = Math.round(Buffer.byteLength(JSON.stringify(payload)) / 1024);
  console.log(`[mock] wrote ${points} points → ${OUT} (${(kb / 1024).toFixed(1)} MB)`);
}

main().catch((err) => { console.error('[mock] fatal:', err); process.exit(1); });
