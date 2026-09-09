// 품질 이상 자동 알림 — 트리거 판정기 (2026-09-09, 핸드오프 §17).
//
// 입력은 public/quality_data.json(coarse=1일 티어)과 public/*_cache.json 의 generatedAt 뿐이다(새 수집 없음).
// A1~A6(사업자 구조 변화·품질 장애) · D1(수집 정지) · D2(원본 정체)를 판정해 public/alerts.json 에
// '활성 알림 + 이력'을 누적한다. 메일 발송 여부는 워크플로(alert.yml)가 이 스크립트의 출력으로 결정한다.
//
// 발송 규칙(§17): 조건 최초 충족 시 1회(fire) → 상태가 유지되는 동안 재발송 없음 → 반대 조건이
// 7일 연속이면 해소(clear) 1회 후 재장전. D 그룹은 상태형이라 조건이 풀리면 즉시 해소.
//
// 순수 함수 evaluate()는 IO가 없어 detect-anomaly.test.ts 가 합성 데이터로 트리거별 발동을 검증한다.

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ISP_BY_ID, NIA_NAME_BY_ID } from '../src/data/isps.ts';
import { METRIC_BY_ID } from '../src/data/metrics.ts';
import { SUMMARY_METRICS, buildSummary } from '../src/lib/summary.ts';
import type { QualityData } from '../src/types.ts';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dir, '../public');
const DATA_FILE = resolve(PUBLIC, 'quality_data.json');
const STATE_FILE = resolve(PUBLIC, 'alerts.json');
const REPORT_FILE = process.env.ALERT_REPORT ?? resolve(__dir, '../alert_report.md');

export const KR3 = ['kt', 'skb', 'lgu'];
const CLEAR_DAYS = 7; // 해소 판정: 반대 조건(=미충족) 연속 일수
const BASE_DAYS = 28; // rise_pp 기준선 창(요일 상쇄를 위해 7의 배수)
const K_GATE_RATIO = 0.3; // 표본 게이트: 당일 k < 28일 중앙값 × 0.3 이면 그날은 판정 제외
const D1A_HOURS = 24; // quality_data.json 미갱신 허용(정상 시 최대 공백 10.4h 관측)
const D1B_HOURS = 72; // 일별 캐시 미갱신 허용(전체 이력 최대 공백 48.8h)
const D2_DAYS = 3; // 전 사업자·전 값 완전 동일 연속 일수
const D2_MIN_VALUES = 5; // D2 판정에 필요한 최소 non-null 값 수(케이블사 결측 등 감안)

// ---- 트리거 정의 (§17 표와 1:1) ----
type Cmp = 'gte' | 'lte' | 'gt0' | 'rise_pp' | 'drop_pct';
interface Rule { key: string; cmp: Cmp; th: number; days: number; meaning: string }
export interface Trigger {
  id: string;
  metric: string;
  isps: string[];
  kGate?: boolean; // 표본수(k) 제공 지표에만 — 저표본일 판정 제외
  rules: Rule[]; // 규칙 간 OR. 각 규칙이 독립된 알림 키를 가진다(A2 상승/하락)
}
export const TRIGGERS: Trigger[] = [
  { id: 'A1', metric: 'ipv6', isps: ['kt', 'skb'],
    rules: [{ key: 'rise', cmp: 'gte', th: 1.0, days: 3, meaning: '유선 IPv6 서비스 개시 신호 — 평소 0.0X%, 관측 최대 0.042%' }] },
  { id: 'A2', metric: 'ipv6', isps: ['lgu'],
    rules: [
      { key: 'rise', cmp: 'gte', th: 30, days: 3, meaning: 'IPv6 적용 범위 전면 확대 — 평소 14~20%' },
      { key: 'drop', cmp: 'lte', th: 10, days: 7, meaning: 'IPv6 경로 단절·후퇴 — 평소 14~20% (주말 변동 감안 7일)' },
    ] },
  { id: 'A3', metric: 'dnssec', isps: ['kt', 'lgu'], kGate: true,
    rules: [{ key: 'rise', cmp: 'gte', th: 10, days: 3, meaning: 'DNSSEC 검증 활성화 — 평소 2%대, 1년 최대 8.2%' }] },
  { id: 'A4', metric: 'dnssec', isps: ['skb'], kGate: true,
    rules: [{ key: 'drop', cmp: 'lte', th: 25, days: 7, meaning: 'DNSSEC 검증 비활성화·후퇴 — 평소 33~60%' }] },
  { id: 'A5', metric: 'rpkiValid', isps: KR3,
    rules: [{ key: 'rise', cmp: 'rise_pp', th: 10, days: 3, meaning: 'RPKI 라우팅 경로 인증 적용 — 평소 한 자릿수에서 거의 고정' }] },
  { id: 'A6', metric: 'packetLoss', isps: KR3,
    rules: [{ key: 'loss', cmp: 'gt0', th: 0, days: 2, meaning: '실제 패킷 손실 발생 — 3사 모두 88일 연속 0.000' }] },
  // S: 속도 저하(2026-09-09 추가). 사업자별 수준이 달라 절대 바닥 대신 '자기 직전 28일 중앙값 대비 하락률'.
  // 다운로드는 접점(Speed Test)·망 내부(NIA) 두 지점 — 동시 발동이면 망 문제, S1만이면 접점·단말, S3만이면 망 내부.
  { id: 'S1', metric: 'downloadBandwidth', isps: KR3,
    rules: [{ key: 'drop', cmp: 'drop_pct', th: 10, days: 3, meaning: '이용자 실측 다운로드 저하(국내 접점) — 140일 최대 하락 4.4%' }] },
  { id: 'S2', metric: 'uploadBandwidth', isps: KR3,
    rules: [{ key: 'drop', cmp: 'drop_pct', th: 10, days: 3, meaning: '이용자 실측 업로드 저하(국내 접점) — 140일 최대 하락 3.1%' }] },
  { id: 'S3', metric: 'niaDl1g', isps: KR3,
    rules: [{ key: 'drop', cmp: 'drop_pct', th: 10, days: 3, meaning: '정부 측정 1G 다운로드 저하(망 내부) — 43일 최대 하락 6.2%' }] },
  { id: 'S4', metric: 'niaUl1g', isps: KR3,
    rules: [{ key: 'drop', cmp: 'drop_pct', th: 10, days: 3, meaning: '정부 측정 1G 업로드 저하(망 내부) — 43일 최대 하락 5.5%' }] },
];

// D2 대상: 일별 스냅샷으로 축적되는 출처 그룹(값이 3일 연속 완전 동일하면 원본 정체).
// Netflix(월별 갱신)는 평평한 게 정상이라 제외. NIA CMB 1G 고정값은 '전 사업자 동시' 조건이라 자동 제외.
const D2_GROUPS: Record<string, string[]> = {
  speedtest: ['downloadBandwidth', 'uploadBandwidth', 'loadedLatency', 'jitter', 'packetLoss'],
  rpki: ['rpkiValid'],
  steam: ['steamDownload'],
  nia: ['niaDl100', 'niaUl100', 'niaDl500', 'niaUl500', 'niaDl1g', 'niaUl1g', 'niaDl10g', 'niaUl10g'],
  apnic: ['dnssec'],
};
export const CACHE_NAMES = ['mlab', 'netflix', 'speedtest', 'iqi', 'apnic', 'steam', 'nia'];

// ---- 상태/이벤트 ----
export interface ActiveAlert { trigger: string; target: string; since: string; value: number | null; detail: string }
export interface AlertEvent { at: string; type: 'fire' | 'clear'; key: string; trigger: string; target: string; value: number | null; detail: string }
export interface AlertState {
  version: 1;
  updatedAt: string;
  lastRun: { at: string; events: number };
  active: Record<string, ActiveAlert>;
  history: AlertEvent[];
}
const HISTORY_CAP = 500;

export function emptyState(): AlertState {
  return { version: 1, updatedAt: '', lastRun: { at: '', events: 0 }, active: {}, history: [] };
}

// ---- 유틸 ----
const med = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ispName = (id: string) => ISP_BY_ID[id]?.name ?? NIA_NAME_BY_ID[id] ?? id;
const fmt = (v: number | null, unit = '') => (v == null ? '–' : `${Number.isInteger(v) ? v : v.toFixed(3).replace(/\.?0+$/, '')}${unit}`);

interface Pt { t: number; v: number; base: number | null }

// (isp, metric)의 유효 일별 포인트 — 결측 제외, 표본 게이트 적용, rise_pp용 28일 기준선(직전 창 중앙값) 계산.
// 생성 시각 기준 아직 끝나지 않은 날(오늘 버킷)은 제외: Cloudflare 라이브 지표는 몇 시간치만 담긴 부분일이라
// 값이 튄다(실측: LG U+ IPv6 완결일 15~16% vs 1시간짜리 부분일 9.5%). 일별 스냅샷 지표는 항상 전날 이전이라 영향 없음.
function validPoints(data: QualityData, isp: string, metric: string, kGate: boolean): Pt[] {
  const blk = data.series[isp]?.[metric]?.coarse;
  if (!blk) return [];
  const axis = data.tiers.coarse.t;
  const generated = Date.parse(data.generatedAt);
  const [v, , k] = blk;
  const out: Pt[] = [];
  for (let i = 0; i < axis.length; i++) {
    const x = v[i];
    if (x == null) continue;
    if (axis[i] + DAY > generated) continue; // 부분일 제외
    if (kGate && k[i] != null) {
      const kh: number[] = [];
      for (let j = i - BASE_DAYS; j < i; j++) { const kk = k[j]; if (j >= 0 && kk != null) kh.push(kk); }
      const km = med(kh);
      if (kh.length >= 14 && km > 0 && (k[i] as number) < km * K_GATE_RATIO) continue;
    }
    const hist: number[] = [];
    for (let j = i - BASE_DAYS; j < i; j++) { const y = v[j]; if (j >= 0 && y != null) hist.push(y); }
    out.push({ t: axis[i], v: x, base: hist.length >= 14 ? med(hist) : null });
  }
  return out;
}

function holds(p: Pt, r: Rule): boolean | null {
  switch (r.cmp) {
    case 'gte': return p.v >= r.th;
    case 'lte': return p.v <= r.th;
    case 'gt0': return p.v > 0;
    case 'rise_pp': return p.base == null ? null : p.v - p.base >= r.th; // 기준선 없으면 판정 불가
    case 'drop_pct': return p.base == null || p.base <= 0 ? null : ((p.base - p.v) / p.base) * 100 >= r.th;
  }
}

// 마지막 n개 유효일이 전부 조건 충족(true) / 전부 미충족(false) / 그 외(null)
function tail(pts: Pt[], r: Rule, n: number): { all: boolean; none: boolean; last: Pt | null; first: Pt | null } {
  const seg = pts.slice(-n);
  if (seg.length < n) return { all: false, none: false, last: null, first: null };
  const hs = seg.map((p) => holds(p, r));
  return { all: hs.every((h) => h === true), none: hs.every((h) => h === false), last: seg[seg.length - 1], first: seg[0] };
}

// ---- 판정 (순수) ----
export interface EvalInput {
  data: QualityData;
  cacheGeneratedAt: Record<string, string | null>; // 캐시 이름 → generatedAt (없으면 null)
  now: number; // epoch ms
  prev: AlertState;
}
export interface EvalResult { state: AlertState; events: AlertEvent[]; checks: string[] }

export function evaluate({ data, cacheGeneratedAt, now, prev }: EvalInput): EvalResult {
  const nowIso = new Date(now).toISOString();
  const active: Record<string, ActiveAlert> = { ...prev.active };
  const events: AlertEvent[] = [];
  const checks: string[] = [];
  const fire = (key: string, a: ActiveAlert) => { active[key] = a; events.push({ at: nowIso, type: 'fire', key, trigger: a.trigger, target: a.target, value: a.value, detail: a.detail }); };
  const clear = (key: string, value: number | null, detail: string) => { const a = active[key]; delete active[key]; events.push({ at: nowIso, type: 'clear', key, trigger: a.trigger, target: a.target, value, detail }); };

  // A1~A6
  for (const trg of TRIGGERS) {
    const unit = METRIC_BY_ID[trg.metric]?.unit ?? '';
    for (const isp of trg.isps) {
      const pts = validPoints(data, isp, trg.metric, !!trg.kGate);
      for (const r of trg.rules) {
        const key = `${trg.id}:${isp}:${r.key}`;
        const on = tail(pts, r, r.days);
        const off = tail(pts, r, CLEAR_DAYS);
        const lastV = pts.length ? pts[pts.length - 1].v : null;
        checks.push(`${key} 최근값 ${fmt(lastV, unit)} (${pts.length ? dayKey(pts[pts.length - 1].t) : '데이터 없음'}) → ${on.all ? '충족' : '미충족'}${active[key] ? ' [활성]' : ''}`);
        if (!active[key] && on.all && on.last && on.first) {
          fire(key, { trigger: trg.id, target: isp, since: dayKey(on.first.t), value: on.last.v,
            detail: `${ispName(isp)} ${METRIC_BY_ID[trg.metric]?.name ?? trg.metric} ${fmt(on.last.v, unit)} — ${r.days}일 연속 ${r.cmp === 'rise_pp' ? `28일 중앙값 대비 +${r.th}%p 이상` : r.cmp === 'drop_pct' ? `28일 중앙값 대비 -${r.th}% 이상 하락` : r.cmp === 'gt0' ? '0 초과' : `${r.cmp === 'gte' ? '≥' : '≤'} ${r.th}${unit}`}. ${r.meaning}` });
        } else if (active[key] && off.none && off.last) {
          clear(key, off.last.v, `${ispName(isp)} ${METRIC_BY_ID[trg.metric]?.name ?? trg.metric} ${fmt(off.last.v, unit)} — 조건 미충족 ${CLEAR_DAYS}일 연속, 해소`);
        }
      }
    }
  }

  // D1-a: quality_data.json 미갱신
  {
    const key = 'D1-a:quality_data';
    const ageH = (now - Date.parse(data.generatedAt)) / HOUR;
    checks.push(`${key} 마지막 갱신 ${ageH.toFixed(1)}h 전 (허용 ${D1A_HOURS}h)`);
    if (!active[key] && ageH >= D1A_HOURS) fire(key, { trigger: 'D1-a', target: 'quality_data', since: data.generatedAt, value: Math.round(ageH), detail: `quality_data.json 이 ${ageH.toFixed(0)}시간 미갱신 — Refresh 워크플로 정지 의심(GitHub 장애·Cloudflare 토큰 만료)` });
    else if (active[key] && ageH < D1A_HOURS) clear(key, Math.round(ageH), `quality_data.json 갱신 재개(${ageH.toFixed(1)}h 전)`);
  }

  // D1-b: 일별 캐시 7종 미갱신
  for (const name of CACHE_NAMES) {
    const key = `D1-b:${name}`;
    const g = cacheGeneratedAt[name];
    const ageH = g ? (now - Date.parse(g)) / HOUR : Infinity;
    checks.push(`${key} 마지막 수집 ${g ? `${ageH.toFixed(1)}h 전` : '파일 없음'} (허용 ${D1B_HOURS}h)`);
    if (!active[key] && ageH >= D1B_HOURS) fire(key, { trigger: 'D1-b', target: name, since: g ?? nowIso, value: Number.isFinite(ageH) ? Math.round(ageH) : null, detail: `${name}_cache.json 이 ${Number.isFinite(ageH) ? `${(ageH / 24).toFixed(1)}일` : '기록 없음'} 미갱신 — 수집기 정지·API 규격 변경·엔드포인트 차단 의심` });
    else if (active[key] && ageH < D1B_HOURS) clear(key, Math.round(ageH), `${name} 수집 재개(${ageH.toFixed(1)}h 전)`);
  }

  // D2: 출처 그룹의 전 사업자·전 값이 D2_DAYS 연속 완전 동일
  const axis = data.tiers.coarse.t;
  for (const [group, metrics] of Object.entries(D2_GROUPS)) {
    const key = `D2:${group}`;
    // 그룹 일자 벡터: [isp×metric] 값. non-null 수가 D2_MIN_VALUES 미만인 날은 '데이터 없는 날'로 건너뜀.
    const days: { t: number; vec: (number | null)[]; n: number }[] = [];
    for (let i = 0; i < axis.length; i++) {
      const vec: (number | null)[] = []; let n = 0;
      for (const isp of data.isps) for (const m of metrics) { const x = data.series[isp]?.[m]?.coarse?.[0]?.[i] ?? null; vec.push(x); if (x != null) n++; }
      if (n >= D2_MIN_VALUES) days.push({ t: axis[i], vec, n });
    }
    const seg = days.slice(-D2_DAYS);
    let stale = seg.length === D2_DAYS;
    for (let s = 1; stale && s < seg.length; s++) {
      const a = seg[s - 1].vec, b = seg[s].vec;
      if (seg[s - 1].n !== seg[s].n) { stale = false; break; }
      for (let q = 0; q < a.length; q++) if (a[q] !== b[q]) { stale = false; break; }
    }
    checks.push(`${key} 최근 ${D2_DAYS}일(${seg.map((d) => dayKey(d.t)).join(',')}) ${stale ? '완전 동일 → 정체' : '변동 있음'}`);
    if (!active[key] && stale) fire(key, { trigger: 'D2', target: group, since: dayKey(seg[0].t), value: null, detail: `${group} 출처의 전 사업자·전 값이 ${D2_DAYS}일 연속(${dayKey(seg[0].t)}~${dayKey(seg[seg.length - 1].t)}) 완전 동일 — 수집은 성공하나 공급처가 새 값을 내놓지 않음` });
    else if (active[key] && !stale) clear(key, null, `${group} 출처 값 변동 재개`);
  }

  const history = [...prev.history, ...events].slice(-HISTORY_CAP);
  return { state: { version: 1, updatedAt: nowIso, lastRun: { at: nowIso, events: events.length }, active, history }, events, checks };
}

// ---- 주간 요약(월요일) 재료: 3사 대표 지표 순위 + 수집 신선도 ----
export function digest(data: QualityData, cacheGeneratedAt: Record<string, string | null>, now: number): string {
  const rows = buildSummary(data, KR3, SUMMARY_METRICS.map((m) => m.id), 7);
  const lines: string[] = ['| 지표 | 1위 | 2위 | 3위 |', '|---|---|---|---|'];
  for (const m of SUMMARY_METRICS) {
    const unit = METRIC_BY_ID[m.id]?.unit ?? '';
    const cells = KR3.map((isp) => ({ isp, ...rows.get(isp)![m.id] })).filter((c) => c.rank != null).sort((a, b) => a.rank! - b.rank!);
    lines.push(`| ${m.short} | ${cells.map((c) => `${ispName(c.isp)} ${fmt(c.v == null ? null : Math.round(c.v * 10) / 10, unit)}`).join(' | ')} |`);
  }
  const fresh = CACHE_NAMES.map((n) => { const g = cacheGeneratedAt[n]; return `${n} ${g ? `${((now - Date.parse(g)) / HOUR).toFixed(0)}h` : '없음'}`; }).join(' · ');
  return `### 3사 대표 지표 순위 (최근 7일 평균)\n${lines.join('\n')}\n\n### 수집 신선도\nquality_data ${((now - Date.parse(data.generatedAt)) / HOUR).toFixed(1)}h · ${fresh}`;
}

export function buildReport(r: EvalResult, data: QualityData, cacheGeneratedAt: Record<string, string | null>, now: number): string {
  const kst = new Date(now).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  const fired = r.events.filter((e) => e.type === 'fire'), cleared = r.events.filter((e) => e.type === 'clear');
  const out: string[] = [`# 품질 이상 알림 판정 — ${kst} KST`, ''];
  if (fired.length) { out.push(`## 🔴 신규 발동 ${fired.length}건`); for (const e of fired) out.push(`- **${e.key}** — ${e.detail}`); out.push(''); }
  if (cleared.length) { out.push(`## 🟢 해소 ${cleared.length}건`); for (const e of cleared) out.push(`- **${e.key}** — ${e.detail}`); out.push(''); }
  if (!r.events.length) out.push('## 신규 이벤트 없음', '');
  const act = Object.entries(r.state.active);
  out.push(`## 활성 알림 ${act.length}건`);
  for (const [k, a] of act) out.push(`- ${k} (since ${a.since.slice(0, 10)}) — ${a.detail}`);
  if (!act.length) out.push('- 없음');
  out.push('', digest(data, cacheGeneratedAt, now), '', '<details><summary>판정 상세</summary>', '', ...r.checks.map((c) => `- ${c}`), '', '</details>');
  return out.join('\n');
}

// ---- IO ----
async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

async function main() {
  const now = Date.now();
  const data = await readJson<QualityData>(DATA_FILE);
  if (!data) { console.error('[alert] quality_data.json 없음'); process.exit(1); }
  const prev = (await readJson<AlertState>(STATE_FILE)) ?? emptyState();
  const cacheGeneratedAt: Record<string, string | null> = {};
  for (const n of CACHE_NAMES) cacheGeneratedAt[n] = (await readJson<{ generatedAt?: string }>(resolve(PUBLIC, `${n}_cache.json`)))?.generatedAt ?? null;

  const r = evaluate({ data, cacheGeneratedAt, now, prev });
  await writeFile(STATE_FILE, JSON.stringify(r.state, null, 1));
  const report = buildReport(r, data, cacheGeneratedAt, now);
  await writeFile(REPORT_FILE, report);
  console.log(report);

  // 워크플로 출력: 신규 이벤트 수 · 메일 제목 · KST 요일(1=월)
  const fired = r.events.filter((e) => e.type === 'fire');
  const weekday = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getDay();
  const subject = fired.length
    ? `[ISPQ 알림] ${fired.map((e) => e.key).join(', ')}`
    : r.events.length ? `[ISPQ 해소] ${r.events.map((e) => e.key).join(', ')}` : `[ISPQ 주간 요약] 활성 알림 ${Object.keys(r.state.active).length}건`;
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `new_events=${r.events.length}\nfired=${fired.length}\nweekday=${weekday}\nsubject=${subject}\nreport=${REPORT_FILE}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('[alert] fatal:', err); process.exit(1); });
}
