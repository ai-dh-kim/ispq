// 모크 데이터 생성기 (PRD §4 FR-01 + FR-07).
// 단일 public/quality_data.json 을 다중 해상도(티어)로 생성:
//   fine   : 10분 버킷 · 최근 2일  (실제 원샘플 생성 후 FR-03 절단 — "10분 정제")
//   mid    : 1시간 버킷 · 최근 30일 (대표 집계 메타)
//   coarse : 1일 버킷 · 최근 365일 (대표 집계 메타, 최대 1년 범위 지원)
// 각 버킷은 절단평균 메타(총샘플 n / 잔존 k)를 보유하므로 모든 범위에서
// 커스텀 툴팁(NFR)이 동작한다. 실 API 연동 시 simulate* 부분만 교체하면 된다.
//
// 실행: node scripts/generate-mock.ts  (Node 24 타입 스트리핑)

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_ISPS } from '../src/data/isps.ts';
import { METRICS, METRIC_BY_ID } from '../src/data/metrics.ts';
import { trimmedStats } from '../src/lib/stats.ts';
import { TIER_BASE_MIN } from '../src/config.ts';
import type { QualityData, TierBlock, TierKey } from '../src/types.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../public/quality_data.json');
const MLAB_CACHE = resolve(__dir, '../public/mlab_cache.json');
const DAY = 86400000;
const GRID_MS = 10 * 60 * 1000;

// M-Lab 캐시(collect-mlab.ts가 하루 1회 생성) 로드. 없으면 null → M-Lab 지표는 시뮬.
// perIsp[ispId][tier][field='thr'|'rtt'|'loss'|'hd'|'k4'][bucketMs] = { v, n }
type MlabCache = { perIsp: Record<string, Record<string, Record<string, Record<string, { v: number; n: number }>>>> };
async function loadMlabCache(): Promise<MlabCache | null> {
  try { return JSON.parse(await readFile(MLAB_CACHE, 'utf8')) as MlabCache; }
  catch { return null; }
}
// M-Lab 지표 id → 캐시 필드
const MLAB_FIELD: Record<string, 'thr' | 'rtt' | 'loss' | 'hd' | 'k4'> = {
  meanThroughput: 'thr', minRtt: 'rtt', lossRate: 'loss',
  // HD/4K 스트리밍 도달률 — M-Lab 다운로드 처리량의 ≥5/≥15Mbps 비율(%)에서 파생.
  nfHd: 'hd', nf4k: 'k4',
};

// Netflix 캐시(collect-netflix.ts): perIsp[ispId] = [{ym:'YYYYMM', speed}] (월별). nfSpeedIndex에 사용.
const NF_CACHE = resolve(__dir, '../public/netflix_cache.json');
type NetflixCache = { perIsp: Record<string, { ym: string; speed: number }[]> };
async function loadNetflixCache(): Promise<Map<string, { ym: number; speed: number }[]> | null> {
  try {
    const j = JSON.parse(await readFile(NF_CACHE, 'utf8')) as NetflixCache;
    const m = new Map<string, { ym: number; speed: number }[]>();
    for (const [isp, arr] of Object.entries(j.perIsp ?? {})) {
      m.set(isp, arr.map((x) => ({ ym: Number(x.ym), speed: x.speed })).sort((a, b) => b.ym - a.ym)); // 최신월 먼저
    }
    return m;
  } catch { return null; }
}
// 버킷 시각 t의 월(YYYYMM)에 해당(또는 그 이전 최신) Netflix 월별 값.
function nfSpeedAt(rows: { ym: number; speed: number }[] | undefined, t: number): number | undefined {
  if (!rows) return undefined;
  const d = new Date(t); const ym = d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
  for (const r of rows) if (r.ym <= ym) return r.speed; // 정렬: 최신→과거
  return undefined;
}

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
  loadedLatency: { good: 22, spread: 0.4, busy: 0.9 },   // 부하 중 지연: idle보다 높고 최번시에 크게 상승
  p25Throughput: { good: 600, spread: 0.2, busy: -0.28 }, // 하위 25% 처리량: 평균보다 낮고 최번시에 더 민감
  meanThroughput: { good: 920, spread: 0.18, busy: -0.22 },
  minRtt: { good: 6, spread: 0.2, busy: 0.15 },
  lossRate: { good: 0.1, spread: 1.0, busy: 2.0 },
  ipv6: { good: 40, spread: 0.1, busy: 0 }, // IPv6 채택률(%): 시간대 무관, 지역별 차이
  dnsResponse: { good: 18, spread: 0.3, busy: 0.4 }, // DNS 응답시간(ms): 낮을수록 좋음
  // Netflix 스트리밍 품질: HD/4K 가능 비율은 부하에 떨어지고(4K가 더 민감), Speed Index(Mbps)도 소폭 하락.
  nfHd: { good: 96, spread: 0.03, busy: -0.12 },
  nf4k: { good: 70, spread: 0.06, busy: -0.3 },
  nfSpeedIndex: { good: 3.6, spread: 0.08, busy: -0.15 },
};
const HIGHER_IS_BETTER = new Set(['bandwidth', 'p25Throughput', 'meanThroughput', 'ipv6', 'nfHd', 'nf4k', 'nfSpeedIndex']);
// 0~100%로 상한이 있는 지표 (생성 시 100 초과 클리핑).
const PCT_CAPPED = new Set(
  METRICS.filter((m) => m.unit === '%').map((m) => m.id)
);

// 22시 최번시 / 03시 최한시의 부하 곡선 (0..1).
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
    if (PCT_CAPPED.has(metricId)) v = Math.min(100, v);
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
  if (PCT_CAPPED.has(metricId)) mean = Math.min(100, mean);
  mean = Math.min(Math.max(mean, metric.hard.min), metric.hard.max);

  const n = tier === 'mid' ? 150 + Math.floor(rand() * 250) : 2500 + Math.floor(rand() * 3500);
  const k = Math.round(n * (0.9 - rand() * 0.04));
  return { mean: round(mean), n, k };
}

// ---- Cloudflare Radar IQI 실데이터 어댑터 (실연동) ----
// CLOUDFLARE_API_TOKEN 이 있으면 IQI에서 ASN별 percentile을 받아 실데이터로 채운다.
//   latency ← LATENCY p50 / bandwidth ← BANDWIDTH p50 / p25Throughput ← BANDWIDTH p25
// IQI는 표본 수를 제공하지 않으므로 해당 셀의 n/k는 null(미상). 실패/부재 시 시뮬 폴백.
// IQI 최대 이력 ~90일 → coarse(365일)는 최근 90일만 실데이터.
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_API = 'https://api.cloudflare.com/client/v4/radar/quality/iqi/timeseries_groups';
const CF_HTTP_IPV6_API = 'https://api.cloudflare.com/client/v4/radar/http/timeseries_groups/ip_version';
const CF_METRIC_FIELD: Record<string, 'latency' | 'bandwidth' | 'p25' | 'ipv6' | 'dns'> = {
  latency: 'latency', bandwidth: 'bandwidth', p25Throughput: 'p25', ipv6: 'ipv6', dnsResponse: 'dns',
};
interface CfTierData { latency: Map<number, number>; bandwidth: Map<number, number>; p25: Map<number, number>; ipv6: Map<number, number>; dns: Map<number, number>; }
const cfLog = { done: false };
const isoSec = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Cloudflare GET + 429(레이트리밋) 백오프 재시도. 호출이 많아도 데이터 빠짐 방지.
async function cfGet(url: URL): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${CF_TOKEN}` } });
    if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }
}

async function cfTimeseries(
  asns: string[], metric: 'LATENCY' | 'BANDWIDTH' | 'DNS', aggInterval: string,
  dateStart: string, dateEnd: string, stepMs: number,
): Promise<{ p50: Map<number, number>; p25: Map<number, number> }> {
  const url = new URL(CF_API);
  url.searchParams.set('metric', metric);
  url.searchParams.set('asn', asns.map((a) => a.replace(/^AS/i, '')).join(','));
  url.searchParams.set('aggInterval', aggInterval);
  url.searchParams.set('dateStart', dateStart);
  url.searchParams.set('dateEnd', dateEnd);
  const json: any = await cfGet(url);
  const serie = json?.result?.serie_0;
  if (!serie || !Array.isArray(serie.timestamps)) throw new Error('no serie_0');
  if (!cfLog.done) {
    console.log(`[cf] meta=${JSON.stringify(json.result?.meta)}`);
    console.log(`[cf] serieKeys=${Object.keys(serie)} firstP50=${serie.p50?.[0]} firstP25=${serie.p25?.[0]}`);
    cfLog.done = true;
  }
  const p50 = new Map<number, number>();
  const p25 = new Map<number, number>();
  const a50: unknown[] = serie.p50 ?? [];
  const a25: unknown[] = serie.p25 ?? [];
  serie.timestamps.forEach((ts: string, i: number) => {
    const bucket = Math.floor(new Date(ts).getTime() / stepMs) * stepMs;
    if (a50[i] != null) p50.set(bucket, Number(a50[i]));
    if (a25[i] != null) p25.set(bucket, Number(a25[i]));
  });
  // IQI 간격(15분/1시간)이 티어 그리드(10분 등)보다 성기면 forward-fill로 빈 버킷을 직전 값으로 채워
  // 연속 라인을 만든다(예: fine 10분 그리드에 15분 데이터).
  return { p50: fillForward(p50, stepMs), p25: fillForward(p25, stepMs) };
}

// Cloudflare HTTP ip_version: ASN별 IPv6 트래픽 비율(%) 시계열.
async function cfIpv6Timeseries(
  asns: string[], aggInterval: string, dateStart: string, dateEnd: string, stepMs: number,
): Promise<Map<number, number>> {
  const url = new URL(CF_HTTP_IPV6_API);
  url.searchParams.set('asn', asns.map((a) => a.replace(/^AS/i, '')).join(','));
  url.searchParams.set('aggInterval', aggInterval);
  url.searchParams.set('dateStart', dateStart);
  url.searchParams.set('dateEnd', dateEnd);
  const json: any = await cfGet(url);
  const serie = json?.result?.serie_0;
  if (!serie || !Array.isArray(serie.timestamps)) throw new Error('no serie_0');
  if (!cfIpv6Log.done) { console.log(`[cf-ipv6] serieKeys=${Object.keys(serie)} firstIPv6=${serie.IPv6?.[0]}`); cfIpv6Log.done = true; }
  const m = new Map<number, number>();
  const a6: unknown[] = serie.IPv6 ?? [];
  serie.timestamps.forEach((ts: string, i: number) => {
    const bucket = Math.floor(new Date(ts).getTime() / stepMs) * stepMs;
    if (a6[i] != null) m.set(bucket, Number(a6[i]));
  });
  return fillForward(m, stepMs);
}
const cfIpv6Log = { done: false };

// 첫~마지막 관측 사이의 빈 버킷을 직전 값으로 채움(이전은 비움 → 시뮬 폴백).
function fillForward(sparse: Map<number, number>, stepMs: number): Map<number, number> {
  if (sparse.size === 0) return sparse;
  const keys = [...sparse.keys()].sort((a, b) => a - b);
  const out = new Map<number, number>();
  let last: number | undefined;
  for (let t = keys[0]; t <= keys[keys.length - 1]; t += stepMs) {
    if (sparse.has(t)) last = sparse.get(t);
    if (last != null) out.set(t, last);
  }
  return out;
}

// cfCache[ispId][tierKey] = CfTierData. fine/mid/coarse 모두 채운다(fine은 15분 IQI를 10분 그리드에 forward-fill).
async function buildCfCache(now: number): Promise<Record<string, Partial<Record<TierKey, CfTierData>>>> {
  const cache: Record<string, Partial<Record<TierKey, CfTierData>>> = {};
  if (!CF_TOKEN) { console.log('[cf] CLOUDFLARE_API_TOKEN 없음 → 전부 시뮬레이션'); return cache; }
  const tiers: { key: TierKey; agg: string; days: number; stepMs: number }[] = [
    { key: 'fine', agg: '15m', days: 2, stepMs: TIER_BASE_MIN.fine * 60 * 1000 },
    { key: 'mid', agg: '1h', days: 30, stepMs: 60 * 60 * 1000 },
    { key: 'coarse', agg: '1d', days: 90, stepMs: DAY },
  ];
  let ok = 0, fail = 0;
  for (const isp of ALL_ISPS) {
    cache[isp.id] = {};
    for (const t of tiers) {
      const ds = isoSec(now - t.days * DAY);
      const de = isoSec(now);
      const data: CfTierData = { latency: new Map(), bandwidth: new Map(), p25: new Map(), ipv6: new Map(), dns: new Map() };
      try {
        const lat = await cfTimeseries(isp.asns, 'LATENCY', t.agg, ds, de, t.stepMs);
        data.latency = lat.p50; ok++;
      } catch (e) { fail++; console.warn(`[cf] ${isp.id}/${t.key}/LATENCY skip: ${(e as Error).message}`); }
      try {
        const bw = await cfTimeseries(isp.asns, 'BANDWIDTH', t.agg, ds, de, t.stepMs);
        data.bandwidth = bw.p50; data.p25 = bw.p25; ok++;
      } catch (e) { fail++; console.warn(`[cf] ${isp.id}/${t.key}/BANDWIDTH skip: ${(e as Error).message}`); }
      try {
        const dns = await cfTimeseries(isp.asns, 'DNS', t.agg, ds, de, t.stepMs);
        data.dns = dns.p50; ok++;
      } catch (e) { fail++; console.warn(`[cf] ${isp.id}/${t.key}/DNS skip: ${(e as Error).message}`); }
      try {
        data.ipv6 = await cfIpv6Timeseries(isp.asns, t.agg, ds, de, t.stepMs); ok++;
      } catch (e) { fail++; console.warn(`[cf] ${isp.id}/${t.key}/IPv6 skip: ${(e as Error).message}`); }
      cache[isp.id][t.key] = data;
    }
  }
  console.log(`[cf] IQI 호출 완료 ok=${ok} fail=${fail}`);
  return cache;
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

  const cf = await buildCfCache(now); // 토큰 있으면 실데이터, 없으면 빈 캐시(시뮬)
  const mlab = await loadMlabCache(); // 하루 1회 캐시(있으면 M-Lab 실데이터)
  if (mlab) console.log(`[mlab] 캐시 로드됨 (ISP ${Object.keys(mlab.perIsp ?? {}).length}개)`);
  const netflix = await loadNetflixCache(); // Netflix ISP Speed Index 월별 캐시
  if (netflix) console.log(`[netflix] 캐시 로드됨 (ISP ${netflix.size}개)`);
  let live = 0;
  const liveMetricSet = new Set<string>(); // 실데이터가 하나라도 들어간 지표 id

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
      // 이 지표가 이번 실행에서 "실데이터 연동" 상태인지(=실어댑터가 켜짐). 그러면 데이터 없는 구간은
      // 시뮬로 채우지 않고 빈칸으로 둔다(가짜 값으로 인한 해석 혼선 방지). 비연동이면 기존대로 시뮬.
      const liveConnected =
        (CF_METRIC_FIELD[metric.id] != null && !!CF_TOKEN) ||
        (MLAB_FIELD[metric.id] != null && !!mlab) ||
        (metric.id === 'nfSpeedIndex' && !!netflix);
      const entry = {} as Record<TierKey, TierBlock>;
      for (const g of TIER_GEN) {
        const axis = tiers[g.key].t;
        const v: (number | null)[] = [];
        const n: (number | null)[] = [];
        const k: (number | null)[] = [];
        for (const t of axis) {
          // 실데이터 우선순위: ① Cloudflare IQI(표본수 미상 n/k=null) ② M-Lab 캐시(실표본수 n) ③ 시뮬.
          const cfField = CF_METRIC_FIELD[metric.id];
          const cfReal = cfField ? cf[isp.id]?.[g.key]?.[cfField]?.get(t) : undefined;
          const mlField = MLAB_FIELD[metric.id];
          const mlReal = mlField ? mlab?.perIsp?.[isp.id]?.[g.key]?.[mlField]?.[String(t)] : undefined;
          const nfReal = metric.id === 'nfSpeedIndex' ? nfSpeedAt(netflix?.get(isp.id), t) : undefined;
          if (cfReal != null && Number.isFinite(cfReal)) {
            const clamped = Math.min(Math.max(cfReal, metric.hard.min), metric.hard.max);
            v.push(round(clamped)); n.push(null); k.push(null); live++; liveMetricSet.add(metric.id);
          } else if (mlReal && Number.isFinite(mlReal.v)) {
            const clamped = Math.min(Math.max(mlReal.v, metric.hard.min), metric.hard.max);
            v.push(round(clamped)); n.push(mlReal.n); k.push(mlReal.n); live++; liveMetricSet.add(metric.id);
          } else if (nfReal != null && Number.isFinite(nfReal)) {
            const clamped = Math.min(Math.max(nfReal, metric.hard.min), metric.hard.max);
            v.push(round(clamped)); n.push(null); k.push(null); live++; liveMetricSet.add(metric.id); // 월별 인덱스 → 표본수 미상
          } else if (liveConnected) {
            // 실데이터 연동 지표인데 해당 시점 데이터 없음 → 시뮬로 채우지 않고 빈칸(혼선 방지).
            v.push(null); n.push(null); k.push(null);
          } else if (g.key === 'fine') {
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
    mode: live > 0 ? 'live' : 'sim', // 실데이터 셀이 하나라도 있으면 live(혼합)
    lang: 'ko',
    tiers,
    isps: ALL_ISPS.map((i) => i.id),
    metrics: METRICS.map((m) => m.id),
    liveMetrics: [...liveMetricSet], // 실데이터가 들어간 지표(프론트 '실시간' 태그용)
    series,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload));
  const kb = Math.round(Buffer.byteLength(JSON.stringify(payload)) / 1024);
  console.log(`[mock] wrote ${points} points (live cells=${live}, liveMetrics=${[...liveMetricSet].join(',') || 'none'}) → ${OUT} (${(kb / 1024).toFixed(1)} MB)`);
}

main().catch((err) => { console.error('[mock] fatal:', err); process.exit(1); });
