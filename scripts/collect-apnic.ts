// APNIC Labs DNSSEC 검증률 수집기 → public/apnic_cache.json (인증 불필요).
// APNIC(아태 IP주소 관리기구)이 구글 광고망 표본으로 측정한 ASN별 "DNSSEC 검증 사용자 비율" 일별 시계열.
//   엔드포인트: https://stats.labs.apnic.net/cgi-bin/json-table.pl?x={국가코드}{ASN숫자} (예: KR4766)
//   응답: data[] = { date:'YYYY-MM-DD', '1_day': { seen(표본수), validating_pc(%) }, ... } — 2013년~현재 전체.
//   (c) APNIC — 재사용 시 출처표기 조건. 지표 cite에 링크로 표기함.
// 응답이 전체 이력이므로 병합 불필요 — 매 실행 최근 KEEP_DAYS만 잘라 재작성(실패한 ISP는 기존 유지).
//
// 실행: node scripts/collect-apnic.ts

import { writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_ISPS } from '../src/data/isps.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../public/apnic_cache.json');
const DAY = 86400000;
const KEEP_DAYS = 800; // 약 2년 보관(다른 캐시와 동일 정책)

// groupId(국가) → APNIC 국가코드. 영국은 GB.
const CC: Record<string, string> = { KR: 'KR', US: 'US', CA: 'CA', UK: 'GB', DE: 'DE', FR: 'FR', IT: 'IT', ES: 'ES', NL: 'NL', JP: 'JP', AU: 'AU' };
const API = (cc: string, asnNum: string) => `https://stats.labs.apnic.net/cgi-bin/json-table.pl?x=${cc}${asnNum}`;

// perIsp[ispId][dayMs] = { dv: 검증률(%), n: 표본수 }
type DayCell = { dv: number; n: number };
type Cache = { generatedAt: string; unitNote: string; perIsp: Record<string, Record<string, DayCell>> };

async function loadCache(): Promise<Cache['perIsp']> {
  try { return (JSON.parse(await readFile(OUT, 'utf8')) as Cache).perIsp ?? {}; }
  catch { return {}; }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

async function fetchSeries(cc: string, asn: string): Promise<Map<number, { pc: number; n: number }> | null> {
  const asnNum = asn.replace(/^AS/i, '');
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 60000);
  try {
    const res = await fetch(API(cc, asnNum), { signal: ac.signal });
    if (!res.ok) { console.warn(`[apnic] ${cc}${asnNum} HTTP ${res.status}`); return null; }
    const j: any = await res.json();
    const out = new Map<number, { pc: number; n: number }>();
    for (const row of j?.data ?? []) {
      const d = row?.['1_day']; // 1일 창(원자료) — 표본수 n을 함께 저장해 저표본 판별 가능
      const day = Date.parse(`${row?.date}T00:00:00Z`);
      const pc = Number(d?.validating_pc); const n = Number(d?.seen);
      if (!Number.isFinite(day) || !Number.isFinite(pc) || !Number.isFinite(n) || n <= 0) continue;
      out.set(day, { pc, n });
    }
    return out.size ? out : null;
  } catch (e) { console.warn(`[apnic] ${cc}${asnNum} ${(e as Error).message}`); return null; }
  finally { clearTimeout(t); }
}

async function main() {
  const perIsp = await loadCache(); // 실패한 ISP는 기존 데이터 유지
  const cutoff = Math.floor(Date.now() / DAY) * DAY - KEEP_DAYS * DAY;

  let ok = 0, fail = 0;
  for (const isp of ALL_ISPS) {
    const cc = CC[isp.groupId];
    if (!cc) continue;
    // 멀티 ASN(lgu): ASN별 시계열을 표본수(n) 가중평균으로 합산.
    const seriesList: Map<number, { pc: number; n: number }>[] = [];
    for (const asn of isp.asns) {
      const s = await fetchSeries(cc, asn);
      if (s) seriesList.push(s);
      await new Promise((r) => setTimeout(r, 500)); // 공개 서비스 예의(과호출 방지)
    }
    if (seriesList.length === 0) { fail++; console.warn(`[apnic] ${isp.id}: 데이터 없음(기존 유지)`); continue; }
    const days: Record<string, DayCell> = {};
    const allDays = new Set<number>();
    for (const s of seriesList) for (const d of s.keys()) allDays.add(d);
    for (const d of allDays) {
      if (d < cutoff) continue;
      let wSum = 0, n = 0;
      for (const s of seriesList) { const c = s.get(d); if (c) { wSum += c.pc * c.n; n += c.n; } }
      if (n > 0) days[String(d)] = { dv: round3(wSum / n), n };
    }
    perIsp[isp.id] = days; ok++;
  }

  const payload: Cache = {
    generatedAt: new Date().toISOString(),
    unitNote: 'dv: DNSSEC 검증 사용자 비율(%), n: 표본수(seen) — APNIC Labs 1_day 창(dayMs=UTC 자정 epoch ms)',
    perIsp,
  };
  await writeFile(OUT, JSON.stringify(payload));
  const totalSnaps = Object.values(perIsp).reduce((a, d) => a + Object.keys(d).length, 0);
  console.log(`[apnic] ISP ok=${ok} fail=${fail} totalSnaps=${totalSnaps} → ${OUT}`);
}

main().catch((err) => { console.error('[apnic] fatal:', err); process.exit(1); });
