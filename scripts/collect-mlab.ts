// M-Lab ndt7 BigQuery 수집기 → public/mlab_cache.json (비용 안전: 하루 1회만 실행).
// 기존 10분 생성기(generate-mock.ts)는 이 캐시만 읽어 BigQuery를 호출하지 않는다.
//
// 인증: 서비스계정 키(JSON, 시크릿 MLAB_BQ_KEY) → JWT(RS256, Node crypto) → 액세스 토큰 →
//       BigQuery REST 쿼리. 외부 npm 의존성 없음.
// 비용: 각 쿼리의 totalBytesProcessed 를 로그로 출력(무료 1TB/월 확인). 기간 상한으로 스캔 제한.
//
// 누적 구조(2026-07-07): coarse(1일)는 매일 최근 며칠만 증분 조회해 기존 캐시에 병합·축적(약 2년 보관).
//   → 기존 "매일 90일 재조회" 대비 스캔 ~70% 감소(월 ~0.3TB, 무료 1TB 한도 내 = 비용 0).
//   mid(1시간)는 표시 창이 30일뿐이라 기존대로 30일 창을 통째로 재조회(교체).
//   과거 백필: MLAB_BACKFILL_DAYS(기본 4)·MLAB_BACKFILL_OFFSET(기본 0)으로 창 지정 —
//   예) DAYS=90 OFFSET=90 → 180~90일 전 구간. CAP_GB 상한 안에서 90일씩 나눠 수동 실행.
//
// 실행: node scripts/collect-mlab.ts   (MLAB_BQ_KEY / MLAB_BQ_PROJECT 필요)

import { writeFile, readFile } from 'node:fs/promises';
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
// ASNumber -> ispId[] (1:다). 한 ASN이 통합 entry(lgu)와 unit entry(lgu-3786 등)에 동시 기여.
// 1:1로 하면 같은 ASN을 공유하는 통합 lgu가 unit에 덮어써져 M-Lab 데이터를 못 받는다.
const ASN_TO_ISPS: Record<number, string[]> = {};
for (const isp of ALL_ISPS) for (const a of isp.asns) {
  const n = Number(a.replace(/^AS/i, ''));
  (ASN_TO_ISPS[n] ??= []).push(isp.id);
}

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

async function bq(token: string, query: string, dryRun = false): Promise<{ rows: string[][]; bytes: number }> {
  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, useLegacySql: false, timeoutMs: 120000, location: 'US', dryRun }), // US 리전 · dryRun=무과금 추정
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`bq ${res.status} ${JSON.stringify(j?.error ?? j).slice(0, 300)}`);
  const bytes = Number(j.totalBytesProcessed || 0);
  if (dryRun) return { rows: [], bytes }; // 추정만(실행·과금 없음)
  if (!j.jobComplete) throw new Error('query timeout — 기간을 줄이세요');
  if (j.pageToken) console.warn('[mlab] 결과가 페이지네이션됨 — 일부 버킷 누락 가능(기간/버킷 조정 권장)');
  const rows: string[][] = (j.rows ?? []).map((r: any) => r.f.map((c: any) => c.v));
  return { rows, bytes };
}

const CAP_GB = 50; // 쿼리당 스캔 상한(안전). 초과 시 중단 — 의도치 않은 대량 과금 방지.

// 한 티어 쿼리: bucketExpr(버킷 시작 ms), startDays~endDays(일 전) 구간
function buildQuery(bucketExpr: string, startDays: number, endDays: number): string {
  // hd/k4: 다운로드 처리량이 Netflix 권장 HD(5Mbps)/4K(15Mbps) 이상인 측정의 비율(%).
  // rtt_floor/thr_peak: MinRTT 하위10% 평균 / MeanThroughputMbps 상위10% 평균.
  //   분위수 스케치(APPROX_QUANTILES 100분할)의 꼬리 오프셋 평균으로 단일 패스 근사 → 추가 스캔 비용 0.
  //   (이미 스캔하는 a.MinRTT / a.MeanThroughputMbps 컬럼만 사용)
  return `SELECT asn, bucket, thr, rtt, loss, hd_n, k4_n, n,
  (SELECT AVG(v) FROM UNNEST(rtt_q) v WITH OFFSET o WHERE o <= 10) AS rtt_floor,
  (SELECT AVG(v) FROM UNNEST(thr_q) v WITH OFFSET o WHERE o >= 90) AS thr_peak
FROM (
  SELECT client.Network.ASNumber AS asn,
    ${bucketExpr} AS bucket,
    APPROX_QUANTILES(a.MeanThroughputMbps, 100)[OFFSET(50)] AS thr,
    APPROX_QUANTILES(a.MinRTT, 100)[OFFSET(50)] AS rtt,
    AVG(a.LossRate) AS loss,
    COUNTIF(a.MeanThroughputMbps >= 5) AS hd_n,
    COUNTIF(a.MeanThroughputMbps >= 15) AS k4_n,
    COUNT(*) AS n,
    APPROX_QUANTILES(a.MinRTT, 100) AS rtt_q,
    APPROX_QUANTILES(a.MeanThroughputMbps, 100) AS thr_q
  FROM \`measurement-lab.ndt.ndt7\`
  WHERE date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL ${startDays} DAY) AND DATE_SUB(CURRENT_DATE(), INTERVAL ${endDays} DAY)
    AND client.Network.ASNumber IN (${ASN_LIST.join(', ')})
    AND a.MeanThroughputMbps IS NOT NULL
  GROUP BY asn, bucket
)`;
}

// coarse 증분 창: 기본 최근 4일(발행 지연 1~2일 + 여유). 수동 백필 시 env로 조정.
const BF_DAYS = Math.min(Math.max(Number(process.env.MLAB_BACKFILL_DAYS) || 4, 2), 120);
const BF_OFFSET = Math.min(Math.max(Number(process.env.MLAB_BACKFILL_OFFSET) || 0, 0), 800);
const KEEP_DAYS = 800; // coarse 누적 보관 기간(약 2년)

const TIERS = [
  { key: 'mid', start: 30, end: 0, bucket: 'UNIX_MILLIS(TIMESTAMP_TRUNC(a.TestTime, HOUR))', mode: 'replace' as const },
  { key: 'coarse', start: BF_OFFSET + BF_DAYS, end: BF_OFFSET, bucket: 'UNIX_MILLIS(TIMESTAMP_TRUNC(a.TestTime, DAY))', mode: 'merge' as const },
];

interface Cell { v: number; n: number; }
type TierMetricMap = Record<string, Cell>; // bucketMs -> cell
const FIELDS = ['thr', 'rtt', 'loss', 'hd', 'k4', 'rttFloor', 'thrPeak'] as const;

// 기존 캐시 로드(누적 병합의 기반). 없으면 빈 구조.
async function loadOldCache(): Promise<Record<string, Record<string, Record<string, TierMetricMap>>>> {
  try { return (JSON.parse(await readFile(OUT, 'utf8')) as { perIsp?: any }).perIsp ?? {}; }
  catch { return {}; }
}

async function main() {
  if (!KEY || !PROJECT) { console.log('[mlab] MLAB_BQ_KEY/MLAB_BQ_PROJECT 없음 → 수집 생략'); return; }
  const sa = JSON.parse(KEY) as { client_email: string; private_key: string };
  const token = await getAccessToken(sa);
  console.log(`[mlab] auth OK · project=${PROJECT} · ASN ${ASN_LIST.length}개`);

  // ── 비용 사전 점검: dry-run(무과금)으로 예상 스캔량 먼저 확인, 상한 초과 시 중단 ──
  let estTotal = 0;
  for (const t of TIERS) {
    const { bytes } = await bq(token, buildQuery(t.bucket, t.start, t.end), true);
    estTotal += bytes;
    const gb = bytes / 1e9;
    console.log(`[mlab] ${t.key} 예상 스캔 ${gb.toFixed(2)}GB (dry-run·무과금)`);
    if (gb > CAP_GB) { console.error(`[mlab] ${t.key} 예상 ${gb.toFixed(1)}GB > 상한 ${CAP_GB}GB → 중단(기간 축소 필요)`); process.exit(1); }
  }
  console.log(`[mlab] 총 예상 ${(estTotal / 1e9).toFixed(2)}GB/회 → 일1회 가정 월 ~${(estTotal / 1e9 * 30).toFixed(0)}GB (무료 1000GB/월 대비)`);

  // perIsp[ispId][tier] = { thr, rtt, loss, hd, k4, rttFloor, thrPeak }
  // 기존 캐시에서 시작: mid는 이번 결과로 교체, coarse는 버킷 단위 병합(누적).
  const perIsp = await loadOldCache();
  const oldSnaps = Object.values(perIsp).reduce((a, t) => a + Object.keys(t?.coarse?.thr ?? {}).length, 0);
  console.log(`[mlab] 기존 캐시 coarse 스냅샷 ${oldSnaps}개 로드(누적 병합 기반)`);
  let totalBytes = 0;

  for (const t of TIERS) {
    const { rows, bytes } = await bq(token, buildQuery(t.bucket, t.start, t.end));
    totalBytes += bytes;
    console.log(`[mlab] ${t.key}: rows=${rows.length} scanned=${(bytes / 1e9).toFixed(2)}GB`);
    // 다중 ASN ISP 합산: thr/rtt/loss는 n 가중평균, hd/k4는 카운트 합산.
    // 한 ASN이 여러 ISP entry(통합 lgu + lgu-3786 등)에 동시 기여 → 1:다.
    const acc: Record<string, Record<string, Record<number, { sw: number; n: number; thr: number; rtt: number; loss: number; hd: number; k4: number; rf: number; tp: number }>>> = {};
    for (const r of rows) {
      const asn = Number(r[0]); const bucket = Number(r[1]);
      const thr = Number(r[2]); const rtt = Number(r[3]); const loss = Number(r[4]);
      const hd = Number(r[5]); const k4 = Number(r[6]); const n = Number(r[7]);
      const rf = Number(r[8]); const tp = Number(r[9]); // rtt_floor(하위10% 평균), thr_peak(상위10% 평균)
      const isps = ASN_TO_ISPS[asn]; if (!isps || !n) continue;
      for (const isp of isps) {
        acc[isp] ??= {}; acc[isp][t.key] ??= {};
        const cur = acc[isp][t.key][bucket] ??= { sw: 0, n: 0, thr: 0, rtt: 0, loss: 0, hd: 0, k4: 0, rf: 0, tp: 0 };
        cur.sw += n; cur.n += n; cur.thr += thr * n; cur.rtt += rtt * n; cur.loss += loss * n;
        cur.hd += hd; cur.k4 += k4; cur.rf += rf * n; cur.tp += tp * n;
      }
    }
    for (const isp of Object.keys(acc)) {
      perIsp[isp] ??= {};
      if (t.mode === 'replace') {
        // mid: 표시 창(30일)을 통째로 최신 결과로 교체.
        perIsp[isp][t.key] = { thr: {}, rtt: {}, loss: {}, hd: {}, k4: {}, rttFloor: {}, thrPeak: {} };
      } else {
        // coarse: 기존 버킷 유지 + 이번 조회 구간만 갱신(누적).
        perIsp[isp][t.key] ??= {} as Record<string, TierMetricMap>;
        for (const f of FIELDS) perIsp[isp][t.key][f] ??= {};
      }
      for (const [bucket, c] of Object.entries(acc[isp][t.key])) {
        const w = c.sw || 1;
        perIsp[isp][t.key].thr[bucket] = { v: round(c.thr / w), n: c.n };
        perIsp[isp][t.key].rtt[bucket] = { v: round(c.rtt / w), n: c.n };
        perIsp[isp][t.key].loss[bucket] = { v: round((c.loss / w) * 100), n: c.n }; // LossRate(0~1) → %
        perIsp[isp][t.key].hd[bucket] = { v: round((c.hd / c.n) * 100), n: c.n }; // HD(≥5Mbps) 도달률 %
        perIsp[isp][t.key].k4[bucket] = { v: round((c.k4 / c.n) * 100), n: c.n }; // 4K(≥15Mbps) 도달률 %
        perIsp[isp][t.key].rttFloor[bucket] = { v: round(c.rf / w), n: c.n }; // MinRTT 하위10% 평균(지연 하한)
        perIsp[isp][t.key].thrPeak[bucket] = { v: round(c.tp / w), n: c.n }; // 처리량 상위10% 평균(관측 피크)
      }
    }
  }

  // coarse 보관 기간 정리(약 2년 초과분 제거).
  const cutoff = Math.floor(Date.now() / 86400000) * 86400000 - KEEP_DAYS * 86400000;
  for (const tiers of Object.values(perIsp)) {
    const coarse = tiers?.coarse; if (!coarse) continue;
    for (const f of Object.keys(coarse)) {
      for (const k of Object.keys(coarse[f])) if (Number(k) < cutoff) delete coarse[f][k];
    }
  }
  const newSnaps = Object.values(perIsp).reduce((a, t) => a + Object.keys(t?.coarse?.thr ?? {}).length, 0);

  const payload = { generatedAt: new Date().toISOString(), totalBytes, perIsp };
  await writeFile(OUT, JSON.stringify(payload));
  console.log(`[mlab] wrote ${OUT} · coarse 스냅샷 ${newSnaps}개 · 총 스캔 ${(totalBytes / 1e9).toFixed(2)}GB (무료 1TB/월 기준 확인)`);
}

const round = (x: number) => Math.round(x * 1000) / 1000;

main().catch((err) => { console.error('[mlab] fatal:', err); process.exit(1); });
