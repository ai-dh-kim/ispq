// 국내 3사 Cloudflare Speed Test "그날 하루" 값 수집기 → public/cfspeed_daily_cache.json (2026-11-11).
//
// 왜 따로 있나: Radar API(collect-speedtest.ts)는 Speed Test를 "직전 90일 집계"로만 준다(dateStart 무시).
//   그래서 대시보드의 날짜별 값이 실제로는 90일 누적이었다. 측정 1건 단위 원자료가 M-Lab BigQuery
//   (measurement-lab.cloudflare.speedtest_speed1)에 공개돼 있어, 국내 3사는 여기서 하루치를 직접 계산한다.
//   해외 사업자는 비용 때문에 기존 Radar 90일 누적을 그대로 쓴다(사용자 결정 2026-11-11).
//
// 비용: 이 뷰는 기간·ASN 조건과 무관하게 매 조회가 테이블 전체(2026-11 기준 약 144GB)를 읽는다.
//   그래서 조회 횟수가 비용을 정한다 → 주 1회 실행, 한 번에 전체 이력(KEEP_DAYS)을 다시 계산해 캐시를 통째로 교체.
//   dryRun 추정이 0으로 나와 쓸모없으므로, maximumBytesBilled(과금 상한)로 막는다 — 넘으면 BigQuery가 실행을 거부.
//
// 측정 1건의 값(speed.cloudflare.com 클라이언트 규칙, github.com/cloudflare/speedtest):
//   다운·업로드 = 전송별 측정치의 90번째 백분위(선형 보간). 단 10ms 미만 전송 제외 규칙은 생략(영향 <1%, 열 추가 비용 큼)
//   유휴 지연 = 지연 측정치 중앙값 · 지터 = 기록된 jitterMs
//   부하 지연 = max(다운로드 중 마지막 20개 중앙값, 업로드 중 마지막 20개 중앙값) · 부하 지터 = max(다운, 업)
//   패킷 손실 = lossRatio × 100(%)
// 하루 값 = 그날(UTC, 원자료 date 열) 측정들의 중앙값. n = 그날 측정 수.
// ⚠️ Radar 집계 방식은 비공개라 같은 90일로 계산해도 Radar와 값이 다르다(다운로드 +5~10%, 부하 지연 정의 차이).
//
// 실행: node scripts/collect-cfspeed-kr.ts  (MLAB_BQ_KEY / MLAB_BQ_PROJECT 필요 — M-Lab 수집과 같은 서비스계정)

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSign } from 'node:crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../public/cfspeed_daily_cache.json');
const DAY = 86400000;
const KEEP_DAYS = 800; // 다른 캐시와 같은 약 2년. 조회 비용은 기간과 무관.
// 과금 상한. 2026-11 실측 143.7GB/회, 테이블이 커지면 늘어난다. 넘으면 실행 거부 → 워크플로 빨간불로 알게 된다.
const MAX_BILLED_GB = Number(process.env.CFSPEED_MAX_GB) || 250;

const KEY = process.env.MLAB_BQ_KEY;
const PROJECT = process.env.MLAB_BQ_PROJECT;

// 대시보드 ISP id ← ASN. LG U+ 통합(lgu)은 두 ASN의 측정을 한데 모아 계산한다(ASN별 중앙값의 평균이 아님).
const ISP_ASNS: Record<string, number[]> = {
  lgu: [3786, 17858], 'lgu-3786': [3786], 'lgu-17858': [17858], kt: [4766], skb: [9318],
};

const b64url = (x: Buffer | string) => Buffer.from(x).toString('base64url');
async function getAccessToken(sa: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/bigquery.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${b64url(signer.sign(sa.private_key))}` }),
  });
  if (!res.ok) throw new Error(`token ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json() as { access_token: string }).access_token;
}

const MAP_SQL = Object.entries(ISP_ASNS).flatMap(([isp, asns]) => asns.map((a) => `STRUCT(${a} AS asn, '${isp}' AS isp)`)).join(', ');
const ALL_ASNS = [...new Set(Object.values(ISP_ASNS).flat())].join(', ');

export const QUERY = `
CREATE TEMP FUNCTION pctl(arr ARRAY<FLOAT64>, p FLOAT64) AS ((
  SELECT IF(ARRAY_LENGTH(s) = 0, NULL,
    s[OFFSET(CAST(FLOOR((ARRAY_LENGTH(s) - 1) * p) AS INT64))]
    + (s[OFFSET(CAST(CEIL((ARRAY_LENGTH(s) - 1) * p) AS INT64))] - s[OFFSET(CAST(FLOOR((ARRAY_LENGTH(s) - 1) * p) AS INT64))])
      * ((ARRAY_LENGTH(s) - 1) * p - FLOOR((ARRAY_LENGTH(s) - 1) * p)))
  FROM (SELECT ARRAY(SELECT x FROM UNNEST(arr) x WHERE x IS NOT NULL ORDER BY x) AS s)));
CREATE TEMP FUNCTION last20(arr ARRAY<FLOAT64>) AS (
  ARRAY(SELECT x FROM UNNEST(arr) x WITH OFFSET o WHERE o >= ARRAY_LENGTH(arr) - 20));
WITH raw AS (
  SELECT date, clientASN,
    pctl(ARRAY(SELECT b FROM UNNEST(download.bps) b WHERE b > 0), 0.9) / 1e6 AS bd,
    pctl(ARRAY(SELECT b FROM UNNEST(upload.bps) b WHERE b > 0), 0.9) / 1e6 AS bu,
    pctl(latencyMs, 0.5) AS li,
    pctl(last20(loadedLatencyMs.download), 0.5) AS dll, pctl(last20(loadedLatencyMs.upload), 0.5) AS ull,
    jitterMs AS ji, loadedJitterMs.download AS djl, loadedJitterMs.upload AS ujl,
    packetLoss.lossRatio * 100 AS pl
  FROM \`measurement-lab.cloudflare.speedtest_speed1\`
  WHERE date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL ${KEEP_DAYS} DAY) AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    AND clientASN IN (${ALL_ASNS})
),
tests AS (
  -- GREATEST는 인자 하나라도 NULL이면 NULL이라, 다운·업 중 한쪽만 측정된 건이 통째로 빠졌다(2026-11-11 수정).
  -- 한쪽이 없으면 있는 쪽 값을 쓴다(둘 다 없으면 NULL).
  SELECT date, clientASN, bd, bu, li, ji, pl,
    GREATEST(COALESCE(dll, ull), COALESCE(ull, dll)) AS ll,
    GREATEST(COALESCE(djl, ujl), COALESCE(ujl, djl)) AS jl
  FROM raw
)
SELECT m.isp, UNIX_MILLIS(TIMESTAMP(t.date)) AS day, COUNT(*) AS n,
  pctl(ARRAY_AGG(t.bd IGNORE NULLS), 0.5) AS bd, pctl(ARRAY_AGG(t.bu IGNORE NULLS), 0.5) AS bu,
  pctl(ARRAY_AGG(t.li IGNORE NULLS), 0.5) AS li, pctl(ARRAY_AGG(t.ll IGNORE NULLS), 0.5) AS ll,
  pctl(ARRAY_AGG(t.ji IGNORE NULLS), 0.5) AS ji, pctl(ARRAY_AGG(t.jl IGNORE NULLS), 0.5) AS jl,
  pctl(ARRAY_AGG(t.pl IGNORE NULLS), 0.5) AS pl
FROM tests t JOIN UNNEST([${MAP_SQL}]) m ON t.clientASN = m.asn
GROUP BY m.isp, day
ORDER BY m.isp, day`;

type DaySnap = { n: number; bd?: number; bu?: number; li?: number; ll?: number; ji?: number; jl?: number; pl?: number };

async function runQuery(token: string): Promise<{ rows: Record<string, string | null>[]; billedGb: number }> {
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}`;
  const res = await fetch(`${base}/queries`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: QUERY, useLegacySql: false, location: 'US', timeoutMs: 300000, maxResults: 10000,
      maximumBytesBilled: String(Math.round(MAX_BILLED_GB * 1e9)),
    }),
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`bq ${res.status} ${JSON.stringify(j?.error?.message ?? j).slice(0, 400)}`);
  if (!j.jobComplete) throw new Error('쿼리가 시간 안에 끝나지 않음 — 다음 실행에서 다시 시도');
  const fields: string[] = j.schema.fields.map((f: any) => f.name);
  const toObj = (r: any) => Object.fromEntries(r.f.map((c: any, i: number) => [fields[i], c.v]));
  const rows = (j.rows ?? []).map(toObj);
  // 결과가 한 페이지를 넘으면 이어 받는다(행 수 ≈ ISP 5 × 일수라 보통 한 페이지).
  let pageToken: string | undefined = j.pageToken;
  while (pageToken) {
    const p = await fetch(`${base}/queries/${j.jobReference.jobId}?location=US&maxResults=10000&pageToken=${encodeURIComponent(pageToken)}`, { headers: { Authorization: `Bearer ${token}` } });
    const pj: any = await p.json();
    if (!p.ok) throw new Error(`bq page ${p.status}`);
    rows.push(...(pj.rows ?? []).map(toObj));
    pageToken = pj.pageToken;
  }
  return { rows, billedGb: Number(j.totalBytesBilled || 0) / 1e9 };
}

async function main() {
  if (!KEY || !PROJECT) { console.error('[cfspeed-kr] MLAB_BQ_KEY / MLAB_BQ_PROJECT 없음 → 수집 불가(캐시 미변경)'); process.exit(1); }
  const token = await getAccessToken(JSON.parse(KEY));
  const t0 = Date.now();
  // 문법 확인 모드(CFSPEED_DRY_RUN=1): BigQuery dryRun은 이 뷰의 비용을 0으로 잘못 내지만 SQL 문법·열 이름은 검증한다.
  // 조회문을 고친 뒤 144GB짜리 실제 실행 없이 확인할 때 쓴다(과금 없음, 캐시 미변경).
  if (process.env.CFSPEED_DRY_RUN === '1') {
    const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, useLegacySql: false, location: 'US', dryRun: true }),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(`문법 확인 실패 ${res.status} ${JSON.stringify(j?.error?.message ?? j).slice(0, 400)}`);
    console.log('[cfspeed-kr] 문법 확인 통과(dryRun, 과금 없음) — 결과 열:', (j.schema?.fields ?? []).map((f: any) => f.name).join(', '));
    return;
  }
  const { rows, billedGb } = await runQuery(token);
  console.log(`[cfspeed-kr] 과금 ${billedGb.toFixed(1)}GB (상한 ${MAX_BILLED_GB}GB) · ${rows.length}행 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const num = (x: string | null) => (x == null ? undefined : Math.round(Number(x) * 1000) / 1000);
  const perIsp: Record<string, Record<string, DaySnap>> = {};
  for (const r of rows) {
    const snap: DaySnap = { n: Number(r.n), bd: num(r.bd), bu: num(r.bu), li: num(r.li), ll: num(r.ll), ji: num(r.ji), jl: num(r.jl), pl: num(r.pl) };
    for (const k of Object.keys(snap) as (keyof DaySnap)[]) if (snap[k] == null) delete snap[k];
    (perIsp[r.isp as string] ??= {})[String(Number(r.day))] = snap;
  }
  // 안전장치: 국내 5개 id가 모두 있고 최근 14일 안에 값이 있어야 정상. 아니면 기존 캐시를 지키고 실패.
  const recent = Date.now() - 14 * DAY;
  for (const id of Object.keys(ISP_ASNS)) {
    const days = Object.keys(perIsp[id] ?? {}).map(Number);
    if (!days.some((d) => d >= recent)) throw new Error(`${id}: 최근 14일 값 없음(${days.length}일) — 원자료 형식·발행 확인 필요`);
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    unitNote: 'perIsp[id][dayMs(UTC 자정)] = { n:측정 수, bd/bu:Mbps, li/ll/ji/jl:ms, pl:% } — 그날 측정들의 중앙값',
    source: 'measurement-lab.cloudflare.speedtest_speed1 (Cloudflare Speed Test 원자료)',
    perIsp,
  };
  await writeFile(OUT, JSON.stringify(payload));
  for (const id of Object.keys(ISP_ASNS)) {
    const ks = Object.keys(perIsp[id]).map(Number).sort((a, b) => a - b);
    const last = perIsp[id][String(ks.at(-1))];
    console.log(`[cfspeed-kr] ${id}: ${ks.length}일 (${new Date(ks[0]).toISOString().slice(0, 10)} ~ ${new Date(ks.at(-1)!).toISOString().slice(0, 10)}) 마지막 n=${last.n} 다운 ${last.bd} 업 ${last.bu}`);
  }
}

main().catch((e) => { console.error('[cfspeed-kr] 실패:', (e as Error).message); process.exit(1); });
