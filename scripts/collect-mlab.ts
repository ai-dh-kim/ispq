// M-Lab ndt7 BigQuery 수집기 → public/mlab_cache.json (비용 안전: 하루 1회만 실행).
// 기존 10분 생성기(generate-mock.ts)는 이 캐시만 읽어 BigQuery를 호출하지 않는다.
//
// 인증: 서비스계정 키(JSON, 시크릿 MLAB_BQ_KEY) → JWT(RS256, Node crypto) → 액세스 토큰 →
//       BigQuery REST 쿼리. 외부 npm 의존성 없음.
// 비용: 각 쿼리의 totalBytesProcessed 를 로그로 출력(무료 1TB/월 확인). 기간 상한으로 스캔 제한.
//
// 실행: node scripts/collect-mlab.ts   (MLAB_BQ_KEY / MLAB_BQ_PROJECT 필요)

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSign } from 'node:crypto';

import { ALL_ISPS } from '../src/data/isps.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../public/mlab_cache.json');

const KEY = process.env.MLAB_BQ_KEY;
const PROJECT = process.env.MLAB_BQ_PROJECT;

// 대상 ASN(정수). ALL_ISPS 의 asns 에서 "AS" 접두 제거.
const ASN_LIST = [...new Set(ALL_ISPS.flatMap((i) => i.asns.map((a) => Number(a.replace(/^AS/i, '')))))].filter((n) => Number.isFinite(n));
// ASNumber -> ispId (다중 ASN ISP 합산용)
const ASN_TO_ISP: Record<number, string> = {};
for (const isp of ALL_ISPS) for (const a of isp.asns) ASN_TO_ISP[Number(a.replace(/^AS/i, ''))] = isp.id;

const b64url = (x: Buffer | string) => Buffer.from(x).toString('base64url');

async function getAccessToken(sa: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/bigquery.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(sa.private_key));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${sig}` }),
  });
  if (!res.ok) throw new Error(`token ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json() as { access_token: string }).access_token;
}

async function bq(token: string, query: string): Promise<{ rows: string[][]; bytes: number }> {
  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, useLegacySql: false, timeoutMs: 120000, location: 'US' }), // M-Lab 데이터는 US 리전
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`bq ${res.status} ${JSON.stringify(j?.error ?? j).slice(0, 300)}`);
  const bytes = Number(j.totalBytesProcessed || 0);
  if (!j.jobComplete) throw new Error('query timeout — 기간을 줄이세요');
  if (j.pageToken) console.warn('[mlab] 결과가 페이지네이션됨 — 일부 버킷 누락 가능(기간/버킷 조정 권장)');
  const rows: string[][] = (j.rows ?? []).map((r: any) => r.f.map((c: any) => c.v));
  return { rows, bytes };
}

// 한 티어 쿼리: bucketExpr(버킷 시작 ms), days(기간 상한)
function buildQuery(bucketExpr: string, days: number): string {
  return `SELECT client.Network.ASNumber AS asn,
  ${bucketExpr} AS bucket,
  APPROX_QUANTILES(a.MeanThroughputMbps, 100)[OFFSET(50)] AS thr,
  APPROX_QUANTILES(a.MinRTT, 100)[OFFSET(50)] AS rtt,
  AVG(a.LossRate) AS loss,
  COUNT(*) AS n
FROM \`measurement-lab.ndt.ndt7\`
WHERE date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY) AND CURRENT_DATE()
  AND client.Network.ASNumber IN (${ASN_LIST.join(', ')})
  AND a.MeanThroughputMbps IS NOT NULL
GROUP BY asn, bucket`;
}

const TIERS = [
  { key: 'mid', days: 30, bucket: 'UNIX_MILLIS(TIMESTAMP_TRUNC(a.TestTime, HOUR))' },
  { key: 'coarse', days: 90, bucket: 'UNIX_MILLIS(TIMESTAMP_TRUNC(a.TestTime, DAY))' },
];

interface Cell { v: number; n: number; }
type TierMetricMap = Record<string, Cell>; // bucketMs -> cell

async function main() {
  if (!KEY || !PROJECT) { console.log('[mlab] MLAB_BQ_KEY/MLAB_BQ_PROJECT 없음 → 수집 생략'); return; }
  const sa = JSON.parse(KEY) as { client_email: string; private_key: string };
  const token = await getAccessToken(sa);
  console.log(`[mlab] auth OK · project=${PROJECT} · ASN ${ASN_LIST.length}개`);

  // perIsp[ispId][tier] = { thr: TierMetricMap, rtt:..., loss:... }
  const perIsp: Record<string, Record<string, Record<string, TierMetricMap>>> = {};
  let totalBytes = 0;

  for (const t of TIERS) {
    const { rows, bytes } = await bq(token, buildQuery(t.bucket, t.days));
    totalBytes += bytes;
    console.log(`[mlab] ${t.key}: rows=${rows.length} scanned=${(bytes / 1e9).toFixed(2)}GB`);
    // 다중 ASN ISP 합산: n 가중평균
    const acc: Record<string, Record<string, Record<number, { sw: number; n: number; thr: number; rtt: number; loss: number }>>> = {};
    for (const r of rows) {
      const asn = Number(r[0]); const bucket = Number(r[1]);
      const thr = Number(r[2]); const rtt = Number(r[3]); const loss = Number(r[4]); const n = Number(r[5]);
      const isp = ASN_TO_ISP[asn]; if (!isp || !n) continue;
      acc[isp] ??= {}; acc[isp][t.key] ??= {};
      const cur = acc[isp][t.key][bucket] ??= { sw: 0, n: 0, thr: 0, rtt: 0, loss: 0 };
      cur.sw += n; cur.n += n; cur.thr += thr * n; cur.rtt += rtt * n; cur.loss += loss * n;
    }
    for (const isp of Object.keys(acc)) {
      perIsp[isp] ??= {}; perIsp[isp][t.key] = { thr: {}, rtt: {}, loss: {} };
      for (const [bucket, c] of Object.entries(acc[isp][t.key])) {
        const w = c.sw || 1;
        perIsp[isp][t.key].thr[bucket] = { v: round(c.thr / w), n: c.n };
        perIsp[isp][t.key].rtt[bucket] = { v: round(c.rtt / w), n: c.n };
        perIsp[isp][t.key].loss[bucket] = { v: round((c.loss / w) * 100), n: c.n }; // LossRate(0~1) → %
      }
    }
  }

  const payload = { generatedAt: new Date().toISOString(), totalBytes, perIsp };
  await writeFile(OUT, JSON.stringify(payload));
  console.log(`[mlab] wrote ${OUT} · 총 스캔 ${(totalBytes / 1e9).toFixed(2)}GB (무료 1TB/월 기준 확인)`);
}

const round = (x: number) => Math.round(x * 1000) / 1000;

main().catch((err) => { console.error('[mlab] fatal:', err); process.exit(1); });
