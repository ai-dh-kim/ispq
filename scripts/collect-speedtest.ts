// Cloudflare Radar Speed Test 일별 수집기 → public/speedtest_cache.json (CLOUDFLARE_API_TOKEN 필요).
// speed.cloudflare.com 사용자 실측(스피드테스트)의 ASN별 집계를 하루 단위로 스냅샷.
//   엔드포인트: /radar/quality/speed/summary?asn=…&dateStart=…&dateEnd=…
//   summary는 기간 집계만 제공(시계열 없음) → 하루 창으로 나눠 호출해 자체 일별 시계열을 쌓는다.
// 반환 7필드 전부 저장(bd/bu=다운/업로드 Mbps, li/ll=유휴/부하 지연 ms, ji/jl=지터 ms, pl=패킷손실).
//   → 현재 지표(uploadBandwidth·loadedLatency) 외 나머지(jitter·packetLoss)도 데이터는 미리 쌓임.
//
// 실행: node scripts/collect-speedtest.ts
//   env BACKFILL_DAYS: 오늘 기준 며칠 전까지 채울지(기본 5, 최초 백필 시 90 등). 오늘(미완성일)은 제외.

import { writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_ISPS } from '../src/data/isps.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../public/speedtest_cache.json');
const DAY = 86400000;
const API = 'https://api.cloudflare.com/client/v4/radar/quality/speed/summary';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BACKFILL_DAYS = Math.min(Math.max(Number(process.env.BACKFILL_DAYS) || 5, 2), 364);
const KEEP_DAYS = 400; // 이보다 오래된 스냅샷은 정리(coarse 365일 + 여유)
const REFRESH_RECENT = 2; // 최근 N일은 캐시에 있어도 재수집(늦게 도착한 측정 반영)

// 일별 스냅샷(각 필드 없으면 그 날 그 값 없음): perIsp[ispId][dayMs] = { bd,bu,li,ll,ji,jl,pl }
type DaySnap = { bd?: number; bu?: number; li?: number; ll?: number; ji?: number; jl?: number; pl?: number };
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

const firstLog = { done: false };

// 하루 창의 speed summary → DaySnap (필드가 숫자로 파싱 안 되면 생략).
async function fetchDay(asns: string[], dayMs: number): Promise<DaySnap | null> {
  const url = new URL(API);
  url.searchParams.set('asn', asns.map((a) => a.replace(/^AS/i, '')).join(','));
  url.searchParams.set('dateStart', isoSec(dayMs));
  url.searchParams.set('dateEnd', isoSec(dayMs + DAY));
  url.searchParams.set('format', 'JSON');
  const json: any = await cfGet(url);
  const s = json?.result?.summary_0;
  if (!s) return null;
  if (!firstLog.done) {
    // 단위 검증용 원본 1회 로그: bd/bu가 Mbps 스케일(수십~수천)인지 확인할 것.
    console.log(`[speed] raw summary_0=${JSON.stringify(s)} meta=${JSON.stringify(json?.result?.meta ?? {}).slice(0, 300)}`);
    firstLog.done = true;
  }
  const num = (x: unknown) => { const v = Number(x); return Number.isFinite(v) ? round3(v) : undefined; };
  const snap: DaySnap = {
    bd: num(s.bandwidthDownload), bu: num(s.bandwidthUpload),
    li: num(s.latencyIdle), ll: num(s.latencyLoaded),
    ji: num(s.jitterIdle), jl: num(s.jitterLoaded),
    pl: num(s.packetLoss),
  };
  for (const k of Object.keys(snap) as (keyof DaySnap)[]) if (snap[k] == null) delete snap[k];
  return Object.keys(snap).length ? snap : null;
}

async function main() {
  if (!TOKEN) { console.error('[speed] CLOUDFLARE_API_TOKEN 없음 → 수집 불가(캐시 미변경)'); process.exit(1); }

  const perIsp = await loadCache();
  const today = Math.floor(Date.now() / DAY) * DAY; // UTC 자정
  const cutoff = today - KEEP_DAYS * DAY;

  let calls = 0, ok = 0, fail = 0, skipped = 0;
  for (const isp of ALL_ISPS) {
    const days = (perIsp[isp.id] ??= {});
    // 오래된 스냅샷 정리
    for (const k of Object.keys(days)) if (Number(k) < cutoff) delete days[k];
    // 어제까지 BACKFILL_DAYS일: 캐시에 없거나 최근 REFRESH_RECENT일이면 수집.
    for (let d = today - BACKFILL_DAYS * DAY; d <= today - DAY; d += DAY) {
      const key = String(d);
      if (days[key] && d < today - REFRESH_RECENT * DAY) { skipped++; continue; }
      try {
        calls++;
        const snap = await fetchDay(isp.asns, d);
        if (snap) { days[key] = snap; ok++; }
        else fail++; // 그 날 표본 부족 → 빈칸 유지
        await new Promise((r) => setTimeout(r, 120)); // 레이트리밋 완화
      } catch (e) {
        fail++;
        console.warn(`[speed] ${isp.id}/${new Date(d).toISOString().slice(0, 10)} skip: ${(e as Error).message}`);
      }
    }
  }

  const payload: Cache = {
    generatedAt: new Date().toISOString(),
    unitNote: 'bd/bu: Mbps, li/ll/ji/jl: ms, pl: % — Radar speed summary 원값(dayMs=UTC 자정 epoch ms)',
    perIsp,
  };
  await writeFile(OUT, JSON.stringify(payload));
  const totalSnaps = Object.values(perIsp).reduce((a, d) => a + Object.keys(d).length, 0);
  console.log(`[speed] calls=${calls} ok=${ok} fail=${fail} skipped=${skipped} totalSnaps=${totalSnaps} → ${OUT}`);
}

main().catch((err) => { console.error('[speed] fatal:', err); process.exit(1); });
