// NIA 인터넷 품질측정 사업자별 통계 수집기 → public/nia_cache.json (인증 불필요).
// NIA(한국지능정보사회진흥원, 과기정통부 산하)가 speed.nia.or.kr 측정통계 페이지에서 공개하는
// 사업자별 평균 속도(이용자 자율측정의 월간 집계)를 받아 일별 스냅샷으로 누적한다.
//   엔드포인트: POST /statistics/statistic_isp.asp (통계 화면이 쓰는 데이터 피드 — 화면엔 기상도 아이콘만 표시)
//   파라미터: service_type/_sub(상품: 100M/500M/1G/10G) · Period=3(월간) · direct(1=다운,2=업)
//   응답 행: { company_id, company_desc, BAND, AVG(Mbps), RATE(전국 평균 대비 %) }
//   ⚠️ 문서화된 API가 아니라 화면용 내부 피드 → 형식 변경 시 exit 1로 워크플로 실패(기존 캐시 보존).
// 이력을 제공하지 않으므로(현재 월간 집계 1값) 매일 1회 실행해 스냅샷 누적(steam/rpki 캐시와 동일 패턴).
// 케이블사(딜라이브 등)와 RATE도 캐시에 함께 저장 — 지표 확장 시 재수집 없이 사용 가능.
//
// 실행: node scripts/collect-nia.ts

import { writeFile, readFile, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { rootCertificates } from 'node:tls';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../public/nia_cache.json');
const DAY = 86400000;
const KEEP_DAYS = 800; // 약 2년 보관(다른 캐시와 동일 정책)

const API = 'https://speed.nia.or.kr/statistics/statistic_isp.asp';
const REFERER = 'https://speed.nia.or.kr/statistics/statistic.asp';

// speed.nia.or.kr 는 TLS 중간 인증서(Sectigo DV CA)를 서버가 안 보내는 설정 오류가 있어
// 기본 검증이 UNABLE_TO_VERIFY_LEAF_SIGNATURE 로 실패한다. 검증을 끄는 대신, 공개 배포되는
// 중간 인증서(scripts/nia-ca-chain.pem, ~2030 유효)를 기본 신뢰 목록에 "추가"해 정상 검증한다.
const CA = [...rootCertificates, readFileSync(resolve(__dir, 'nia-ca-chain.pem'), 'utf8')];

function httpsPost(url: string, body: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const u = new URL(url);
    const req = request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', ca: CA, timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Referer: REFERER,
      },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); rejectP(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolveP(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', rejectP);
    req.end(body);
  });
}

// 상품 티어 → 요청 파라미터(통계 페이지 statistic.asp 인라인 스크립트의 param100/500/1000/10000과 동일).
const TIERS: { key: 't100' | 't500' | 't1g' | 't10g'; params: string }[] = [
  { key: 't100', params: 'service_type=1&service_type_sub=1' },
  { key: 't500', params: 'service_type=2&service_type_sub=1' },
  { key: 't1g', params: 'service_type=2&service_type_sub=2' },
  { key: 't10g', params: 'service_type=3&service_type_sub=1' },
];

// company_id(고정) → 캐시 키. 1~3은 대시보드 ISP id와 일치, 나머지는 케이블사(향후 확장용으로 저장만).
const COMPANY: Record<number, string> = {
  1: 'kt', 2: 'skb', 3: 'lgu', 4: 'dlive', 5: 'lghv', 7: 'hcn', 8: 'etc', 9: 'cmb',
};

// perIsp[key][dayMs][tier] = { d, u, rd, ru } — 다운/업 평균(Mbps), 전국 평균 대비(%: rd/ru)
type TierSnap = { d?: number; u?: number; rd?: number; ru?: number };
type DaySnap = Partial<Record<'t100' | 't500' | 't1g' | 't10g', TierSnap>>;
type Cache = { generatedAt: string; unitNote: string; perIsp: Record<string, Record<string, DaySnap>> };

async function loadCache(): Promise<Cache['perIsp']> {
  try { return (JSON.parse(await readFile(OUT, 'utf8')) as Cache).perIsp ?? {}; }
  catch { return {}; }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

// ── 신선도 감시 (2026-07-15) ──
// NIA 통계는 배치 재계산으로 보이는데, 만약 원본 갱신이 멈추면 우리 캐시엔 같은 값이 계속 쌓인다.
// 최근 STALE_DAYS일(오늘 포함) 스냅샷이 "전 사업자 × 전 상품 × 전 값"에서 완전히 동일하면
// 마커(nia_stale.txt)를 남긴다 → 워크플로가 캐시 커밋을 마친 뒤 이 마커를 보고 실패(빨간불 알람).
// 값이 같아도 캐시 기록·커밋은 정상 진행(공표값 기록은 계속) — 알람만 분리한다.
const STALE_DAYS = 3;
const STALE_MARKER = resolve(__dir, '../nia_stale.txt');
function checkStale(perIsp: Cache['perIsp'], today: number): string | null {
  const dayKeys = Array.from({ length: STALE_DAYS }, (_, i) => String(today - i * DAY));
  let compared = 0;
  for (const days of Object.values(perIsp)) {
    const snaps = dayKeys.map((k) => days[k]);
    if (snaps.some((s) => s == null)) continue; // 3일치가 없는 사업자는 판단에서 제외
    const [a, b, c] = snaps.map((s) => JSON.stringify(s));
    if (a !== b || a !== c) return null; // 한 사업자라도 값이 변했으면 신선
    compared++;
  }
  return compared > 0 ? `${compared}개 사업자 × ${STALE_DAYS}일 완전 동일` : null;
}

type NiaRow = { company_id: number; company_desc: string; BAND: number; AVG: number; RATE: number };

async function fetchTier(params: string, direct: 1 | 2): Promise<NiaRow[]> {
  const text = await httpsPost(API, `${params}&Period=3&direct=${direct}`);
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error('array 아님');
  return rows;
}

// 스냅샷 날짜 키 = "데이터 기준일"(= KST 달력 날짜 - 1일) — 2026-07-20 확정.
// 48시간 프로브(시간별 27회 샘플링)로 NIA 배치가 매일 KST 자정에 딱 1회 도는 것을 실증했다
// (7/18 22:40 구값 → 7/19 00:04 신값 / 7/19 22:43 → 7/20 00:05, 그 외 25회는 소수점까지 동일).
// 자정에 계산된 30일 이동평균은 전날 자정까지의 측정만 포함할 수 있으므로,
// 지금 공표 중인 값의 데이터 기준일은 "KST 오늘 - 1일"이다. 이 규칙은 수집 시각과 무관하게 성립:
//   KST 23:50 수집 → 오늘 자정 배치값(어제까지) → 키=어제 / KST 00:10 수집 → 오늘 자정 배치값 → 키=어제
const KST_MS = 9 * 3600 * 1000;

async function main() {
  const perIsp = await loadCache();
  // today = 데이터 기준일(KST 달력 날짜의 전날). 변수명은 기존 로직(신선도 검사 등)과 호환 유지.
  const today = Math.floor((Date.now() + KST_MS) / DAY) * DAY - DAY;
  const cutoff = today - KEEP_DAYS * DAY;
  const dayKey = String(today);

  let cells = 0;
  for (const tier of TIERS) {
    for (const direct of [1, 2] as const) {
      let rows: NiaRow[];
      try { rows = await fetchTier(tier.params, direct); }
      catch (e) { console.error(`[nia] ${tier.key} direct=${direct} 실패: ${(e as Error).message}`); process.exit(1); }
      for (const r of rows) {
        const key = COMPANY[Number(r.company_id)];
        if (!key || !Number.isFinite(r.AVG)) continue;
        const days = (perIsp[key] ??= {});
        const snap = (days[dayKey] ??= {});
        const ts = (snap[tier.key] ??= {});
        if (direct === 1) { ts.d = round3(r.AVG); if (Number.isFinite(r.RATE)) ts.rd = round3(r.RATE); }
        else { ts.u = round3(r.AVG); if (Number.isFinite(r.RATE)) ts.ru = round3(r.RATE); }
        cells++;
      }
      await new Promise((res) => setTimeout(res, 400)); // 공개 서비스 예의(과호출 방지)
    }
  }

  // 3사가 하나도 안 잡히면 형식 변경 의심 → 실패 처리(캐시 미변경).
  const core = ['kt', 'skb', 'lgu'].filter((k) => perIsp[k]?.[dayKey]?.t1g?.d != null);
  if (core.length === 0) { console.error('[nia] 통신 3사 1G 데이터 없음 — 응답 형식 변경 의심, 종료'); process.exit(1); }

  for (const days of Object.values(perIsp)) {
    for (const k of Object.keys(days)) if (Number(k) < cutoff) delete days[k];
  }

  const payload: Cache = {
    generatedAt: new Date().toISOString(),
    unitNote: 'perIsp[isp][dayMs][t100|t500|t1g|t10g] = { d/u: 평균 Mbps, rd/ru: 전국 평균 대비 % } — NIA 월간 집계의 일별 스냅샷(dayMs=UTC 자정)',
    perIsp,
  };
  await writeFile(OUT, JSON.stringify(payload));
  const totalSnaps = Object.values(perIsp).reduce((a, d) => a + Object.keys(d).length, 0);
  console.log(`[nia] cells=${cells} core3사=${core.join(',')} totalSnaps=${totalSnaps} → ${OUT}`);

  const staleMsg = checkStale(perIsp, today);
  if (staleMsg) {
    await writeFile(STALE_MARKER, `${new Date().toISOString()} ${staleMsg}`);
    console.warn(`[nia] ⚠ 신선도 경고: ${staleMsg} — NIA 원본 갱신 중단 의심(워크플로가 알람 처리)`);
  } else {
    try { await unlink(STALE_MARKER); } catch { /* 마커 없으면 무시 */ }
  }
}

main().catch((err) => { console.error('[nia] fatal:', err); process.exit(1); });
