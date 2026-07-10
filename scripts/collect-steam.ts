// Valve Steam 다운로드 통계 수집기 → public/steam_cache.json (인증 불필요).
// Steam 클라이언트의 실제 게임 다운로드 트래픽에서 집계한 국가별 주요 ISP의 평균 다운로드 속도(Mbps).
//   엔드포인트: https://cdn.akamai.steamstatic.com/steam/publicstats/top_asns_per_country.jsonp
//   응답: jsonpFetch.onCountryASNData({ 국가ISO3: [{ asname, totalbytes, avgmbps }] }) — 최근 창의 집계만 제공.
//   ⚠️ store.steampowered.com/stats/content 페이지가 쓰는 비공식 엔드포인트라 예고 없이 바뀔 수 있음
//     → 파싱/매칭 실패 시 exit 1 로 워크플로를 실패시켜 바로 알아챈다(기존 캐시는 보존).
// 이력을 제공하지 않으므로 매일 1회 실행해 "오늘 값"을 일별 스냅샷으로 누적(speedtest/iqi 캐시와 동일 패턴).
//
// 실행: node scripts/collect-steam.ts

import { writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_ISPS } from '../src/data/isps.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../public/steam_cache.json');
const DAY = 86400000;
const KEEP_DAYS = 800; // 약 2년 보관(다른 캐시와 동일 정책)

// groupId(국가) → Steam 국가코드(ISO3).
const CC3: Record<string, string> = {
  KR: 'KOR', US: 'USA', CA: 'CAN', UK: 'GBR', DE: 'DEU', FR: 'FRA',
  IT: 'ITA', ES: 'ESP', NL: 'NLD', JP: 'JPN', AU: 'AUS',
};
// 우리 ISP id → Steam asname(소문자, 정확매칭 우선 + 부분매칭 폴백).
// LG U+는 브랜드 단위 한 줄("LG Uplus")로만 제공 → Netflix처럼 통합 lgu에만 매핑(ASN unit 분해 불가).
const STEAM_NAME: Record<string, string> = {
  lgu: 'lg uplus', kt: 'kt', skb: 'sk broadband',
  comcast: 'comcast cable', bell: 'bell canada', bt: 'bt', dtag: 'deutsche telekom ag',
  orange: 'orange', tim: 'tim', movistar: 'telefonica de espana', kpn: 'kpn',
  ntt: 'open computer network', // NTT OCN(AS4713)의 Steam 표기
  telstra: 'telstra internet',
};
const API = 'https://cdn.akamai.steamstatic.com/steam/publicstats/top_asns_per_country.jsonp';

// perIsp[ispId][dayMs] = 평균 다운로드 속도(Mbps)
type Cache = { generatedAt: string; unitNote: string; perIsp: Record<string, Record<string, number>> };

async function loadCache(): Promise<Cache['perIsp']> {
  try { return (JSON.parse(await readFile(OUT, 'utf8')) as Cache).perIsp ?? {}; }
  catch { return {}; }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

type SteamRow = { asname: string; totalbytes: string; avgmbps: number };

async function fetchCountryAsns(): Promise<Record<string, SteamRow[]>> {
  // 페이지와 동일한 MM-DD-YYYY-HH 형식의 캐시버스터(임의 신규값이면 CDN 캐시를 우회).
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const v = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${d.getUTCFullYear()}-${pad(d.getUTCHours())}`;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 60000);
  try {
    const res = await fetch(`${API}?v=${v}`, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const json = text.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, ''); // JSONP 래퍼 제거
    return JSON.parse(json);
  } finally { clearTimeout(t); }
}

async function main() {
  const data = await fetchCountryAsns(); // 실패 시 throw → exit 1 (기존 캐시 보존)
  const perIsp = await loadCache();
  const today = Math.floor(Date.now() / DAY) * DAY;
  const cutoff = today - KEEP_DAYS * DAY;

  let ok = 0; const missed: string[] = [];
  for (const isp of ALL_ISPS) {
    const cc = CC3[isp.groupId]; const token = STEAM_NAME[isp.id];
    if (!cc || !token) continue; // ASN unit(lgu-3786 등)은 매핑 없음 — 통합 lgu만 수집
    const rows = data[cc] ?? [];
    let match = rows.find((r) => (r.asname ?? '').toLowerCase() === token);
    if (!match) match = rows.find((r) => { const nm = (r.asname ?? '').toLowerCase(); return nm.includes(token) || token.includes(nm); });
    if (!match || !Number.isFinite(match.avgmbps)) { missed.push(isp.id); continue; }

    const days = perIsp[isp.id] ?? {};
    days[String(today)] = round3(match.avgmbps);
    for (const key of Object.keys(days)) if (Number(key) < cutoff) delete days[key];
    perIsp[isp.id] = days; ok++;
  }

  if (missed.length) console.warn(`[steam] 매칭 실패(기존 유지): ${missed.join(',')}`);
  if (ok === 0) { console.error('[steam] 매칭된 ISP가 0개 — 엔드포인트/표기 변경 의심, 캐시 미변경 종료'); process.exit(1); }

  const payload: Cache = {
    generatedAt: new Date().toISOString(),
    unitNote: 'Steam 클라이언트 평균 다운로드 속도(Mbps) 일별 스냅샷 — dayMs=UTC 자정 epoch ms',
    perIsp,
  };
  await writeFile(OUT, JSON.stringify(payload));
  const totalSnaps = Object.values(perIsp).reduce((a, d) => a + Object.keys(d).length, 0);
  console.log(`[steam] ISP ok=${ok}/${Object.keys(STEAM_NAME).length} totalSnaps=${totalSnaps} → ${OUT}`);
}

main().catch((err) => { console.error('[steam] fatal:', err); process.exit(1); });
