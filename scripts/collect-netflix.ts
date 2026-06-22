// Netflix ISP Speed Index 공개 API 수집기 → public/netflix_cache.json (인증 불필요).
// 통신사별 "월별 프라임타임 평균 재생 Mbps"(historicalSpeeds)를 받아 캐시. 10분 생성기는 캐시만 읽음.
// 엔드포인트: /api/v1/rankings/current-summary/countries/{국가코드}
//
// 실행: node scripts/collect-netflix.ts

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_ISPS } from '../src/data/isps.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../public/netflix_cache.json');

// 우리 ISP groupId(국가) → Netflix 국가코드(소문자)
const CC: Record<string, string> = { KR: 'kr', US: 'us', CA: 'ca', UK: 'gb', DE: 'de', FR: 'fr', IT: 'it', ES: 'es', NL: 'nl', JP: 'jp', AU: 'au' };
// 우리 ISP id → Netflix ISP 이름(소문자, 정확매칭 우선 + 부분매칭 폴백)
const NF_NAME: Record<string, string> = {
  lgu: 'lg u+', kt: 'kt', skb: 'sk broadband',
  comcast: 'comcast', bell: 'bell', bt: 'bt', dtag: 'deutsche telekom',
  orange: 'orange', tim: 'telecom italia', movistar: 'movistar', kpn: 'kpn', ntt: 'ntt', telstra: 'telstra',
};
const API = (cc: string) => `https://ispspeedindex.netflix.net/api/v1/rankings/current-summary/countries/${cc}`;

async function fetchJson(url: string, sec = 30): Promise<any> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), sec * 1000);
  try { const r = await fetch(url, { signal: ac.signal }); return r.ok ? await r.json() : { __s: r.status }; }
  catch (e) { return { __e: (e as Error).message }; } finally { clearTimeout(t); }
}

async function main() {
  const byCC: Record<string, any[]> = {};
  // perIsp[ispId] = [{ ym:'YYYYMM', speed }] (월별)
  const perIsp: Record<string, { ym: string; speed: number }[]> = {};

  for (const isp of ALL_ISPS) {
    const cc = CC[isp.groupId]; const token = NF_NAME[isp.id];
    if (!cc || !token) continue;
    if (!byCC[cc]) {
      const r = await fetchJson(API(cc));
      byCC[cc] = Array.isArray(r) ? r : [];
      if (!Array.isArray(r)) console.warn(`[netflix] ${cc} ${r.__s ?? r.__e}`);
    }
    // 국가의 모든 ISP 평탄화 후 매칭(정확 → 부분)
    const candidates: any[] = [];
    for (const e of byCC[cc]) for (const nf of (e.isps ?? [])) candidates.push(nf);
    let match = candidates.find((nf) => (nf.name ?? '').toLowerCase() === token);
    if (!match) match = candidates.find((nf) => { const nm = (nf.name ?? '').toLowerCase(); return nm.includes(token) || token.includes(nm); });
    if (match?.historicalSpeeds) {
      perIsp[isp.id] = match.historicalSpeeds
        .filter((h: any) => Number.isFinite(h.speed))
        .map((h: any) => ({ ym: String(h.date).slice(0, 6), speed: Number(h.speed) }));
    }
  }

  console.log(`[netflix] matched ISPs: ${Object.keys(perIsp).join(',') || 'none'}`);
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), perIsp }));
  console.log(`[netflix] wrote ${OUT}`);
}

main().catch((err) => { console.error('[netflix] fatal:', err); process.exit(1); });
