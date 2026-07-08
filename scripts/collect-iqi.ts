// Cloudflare Radar IQI 일별 스냅샷 수집기 → public/iqi_cache.json (CLOUDFLARE_API_TOKEN 필요).
// Radar IQI API는 최근 ~90일까지만 제공 → 매일 최근 며칠치를 받아 자체 캐시에 누적하면
// "오늘 이후"의 이력은 90일 제한 없이 보존된다(약 2년 = KEEP_DAYS). UI는 그대로(장기 보관용).
// generate-mock.ts는 coarse(1일) 티어에서 라이브 IQI가 없는 과거 버킷을 이 캐시로 채운다.
//
// 실행: node scripts/collect-iqi.ts
//   env BACKFILL_DAYS: 며칠 전까지 받아올지(기본 7, 최초 시드 시 90 권장 — API 이력 한계).

import { writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_ISPS } from '../src/data/isps.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../public/iqi_cache.json');
const DAY = 86400000;
const IQI_API = 'https://api.cloudflare.com/client/v4/radar/quality/iqi/timeseries_groups';
const IPV6_API = 'https://api.cloudflare.com/client/v4/radar/http/timeseries_groups/ip_version';
const BGP_STATS_API = 'https://api.cloudflare.com/client/v4/radar/bgp/routes/stats'; // RPKI 현재 스냅샷(이력 미제공)
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BACKFILL_DAYS = Math.min(Math.max(Number(process.env.BACKFILL_DAYS) || 7, 2), 90); // API 이력 ~90일
const KEEP_DAYS = 800; // 약 2년 보관(용량 ~1MB 수준)

// 일별 스냅샷: perIsp[ispId][dayMs] = { lat, bw, p25, dns, v6, rpki } (없는 필드는 그 날 값 없음)
// rpki: BGP 경로 중 RPKI 유효(valid) 비율(%) — API가 현재 상태만 제공하므로 '오늘' 날짜에 기록해 누적.
type DaySnap = { lat?: number; bw?: number; p25?: number; dns?: number; v6?: number; rpki?: number };
type Cache = { generatedAt: string; unitNote: string; perIsp: Record<string, Record<string, DaySnap>> };

async function loadCache(): Promise<Cache['perIsp']> {
  try { return (JSON.parse(await readFile(OUT, 'utf8')) as Cache).perIsp ?? {}; }
  catch { return {}; }
}

const isoSec = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const round3 = (x: number) => Math.round(x * 1000) / 1000;

// Cloudflare GET + 429 백오프 (generate-mock.ts의 cfGet과 동일 패턴).
async function cfGet(url: URL): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }
}

// serie_0의 timestamps × 필드배열 → dayMs → 값 맵.
function serieToDays(serie: any, field: string): Map<number, number> {
  const out = new Map<number, number>();
  const arr: unknown[] = serie?.[field] ?? [];
  (serie?.timestamps ?? []).forEach((ts: string, i: number) => {
    const v = Number(arr[i]);
    if (Number.isFinite(v)) out.set(Math.floor(new Date(ts).getTime() / DAY) * DAY, round3(v));
  });
  return out;
}

async function iqiSeries(asns: string[], metric: 'LATENCY' | 'BANDWIDTH' | 'DNS', ds: string, de: string): Promise<any> {
  const url = new URL(IQI_API);
  url.searchParams.set('metric', metric);
  url.searchParams.set('asn', asns.map((a) => a.replace(/^AS/i, '')).join(','));
  url.searchParams.set('aggInterval', '1d');
  url.searchParams.set('dateStart', ds);
  url.searchParams.set('dateEnd', de);
  return (await cfGet(url))?.result?.serie_0;
}

// ASN 1개의 RPKI 유효율(%) — routes_valid / routes_total. 실패 시 null.
const rpkiLog = { done: false };
async function rpkiPct(asnNum: string): Promise<{ valid: number; total: number } | null> {
  const url = new URL(BGP_STATS_API);
  url.searchParams.set('asn', asnNum);
  url.searchParams.set('format', 'JSON');
  const json: any = await cfGet(url);
  const s = json?.result?.stats;
  if (!rpkiLog.done && s) { console.log(`[iqi] rpki raw stats(AS${asnNum})=${JSON.stringify(s).slice(0, 300)}`); rpkiLog.done = true; }
  const valid = Number(s?.routes_valid); const total = Number(s?.routes_total);
  if (!Number.isFinite(valid) || !Number.isFinite(total) || total <= 0) return null;
  return { valid, total };
}

async function main() {
  if (!TOKEN) { console.error('[iqi] CLOUDFLARE_API_TOKEN 없음 → 수집 불가(캐시 미변경)'); process.exit(1); }

  const perIsp = await loadCache();
  const now = Date.now();
  const ds = isoSec(now - BACKFILL_DAYS * DAY);
  const de = isoSec(now);
  const cutoff = Math.floor(now / DAY) * DAY - KEEP_DAYS * DAY;
  const today = Math.floor(now / DAY) * DAY;

  // RPKI: ASN별 현재 스냅샷을 1회씩 조회(중복 ASN 캐시) 후 ISP별 합산.
  const rpkiByAsn = new Map<string, { valid: number; total: number } | null>();

  let ok = 0, fail = 0;
  for (const isp of ALL_ISPS) {
    const days = (perIsp[isp.id] ??= {});
    for (const k of Object.keys(days)) if (Number(k) < cutoff) delete days[k];
    const put = (m: Map<number, number>, field: keyof DaySnap) => {
      for (const [d, v] of m) { (days[String(d)] ??= {})[field] = v; }
    };
    try {
      const lat = await iqiSeries(isp.asns, 'LATENCY', ds, de);
      put(serieToDays(lat, 'p50'), 'lat'); ok++;
    } catch (e) { fail++; console.warn(`[iqi] ${isp.id}/LATENCY skip: ${(e as Error).message}`); }
    try {
      const bw = await iqiSeries(isp.asns, 'BANDWIDTH', ds, de);
      put(serieToDays(bw, 'p50'), 'bw'); put(serieToDays(bw, 'p25'), 'p25'); ok++;
    } catch (e) { fail++; console.warn(`[iqi] ${isp.id}/BANDWIDTH skip: ${(e as Error).message}`); }
    try {
      const dns = await iqiSeries(isp.asns, 'DNS', ds, de);
      put(serieToDays(dns, 'p50'), 'dns'); ok++;
    } catch (e) { fail++; console.warn(`[iqi] ${isp.id}/DNS skip: ${(e as Error).message}`); }
    try {
      const url = new URL(IPV6_API);
      url.searchParams.set('asn', isp.asns.map((a) => a.replace(/^AS/i, '')).join(','));
      url.searchParams.set('aggInterval', '1d');
      url.searchParams.set('dateStart', ds);
      url.searchParams.set('dateEnd', de);
      const serie = (await cfGet(url))?.result?.serie_0;
      put(serieToDays(serie, 'IPv6'), 'v6'); ok++;
    } catch (e) { fail++; console.warn(`[iqi] ${isp.id}/IPv6 skip: ${(e as Error).message}`); }
    // RPKI 유효율: ASN별 카운트를 합산해 오늘 날짜 스냅샷으로 기록(멀티 ASN은 경로 수 가중 자동 반영).
    try {
      let valid = 0, total = 0;
      for (const asn of isp.asns) {
        const num = asn.replace(/^AS/i, '');
        if (!rpkiByAsn.has(num)) rpkiByAsn.set(num, await rpkiPct(num));
        const r = rpkiByAsn.get(num);
        if (r) { valid += r.valid; total += r.total; }
      }
      if (total > 0) { (days[String(today)] ??= {}).rpki = round3((valid / total) * 100); ok++; }
    } catch (e) { fail++; console.warn(`[iqi] ${isp.id}/RPKI skip: ${(e as Error).message}`); }
    await new Promise((r) => setTimeout(r, 120)); // 레이트리밋 완화
  }

  const payload: Cache = {
    generatedAt: new Date().toISOString(),
    unitNote: 'lat/dns: ms(p50), bw/p25: Mbps, v6: %, rpki: %(BGP 경로 RPKI 유효율·당일 스냅샷) — dayMs=UTC 자정 epoch ms',
    perIsp,
  };
  await writeFile(OUT, JSON.stringify(payload));
  const totalSnaps = Object.values(perIsp).reduce((a, d) => a + Object.keys(d).length, 0);
  console.log(`[iqi] calls ok=${ok} fail=${fail} totalSnaps=${totalSnaps} window=${BACKFILL_DAYS}d → ${OUT}`);
}

main().catch((err) => { console.error('[iqi] fatal:', err); process.exit(1); });
