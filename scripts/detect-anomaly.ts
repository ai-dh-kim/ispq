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
import { METRIC_BY_ID, SOURCES } from '../src/data/metrics.ts';
import { SUMMARY_METRICS, buildSummary } from '../src/lib/summary.ts';
import type { QualityData } from '../src/types.ts';
import { renderWeeklyCharts, CHART_ISPS, type ChartSpec, type RenderedChart, type Guide } from './weekly-charts.ts';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dir, '../public');
const DATA_FILE = resolve(PUBLIC, 'quality_data.json');
const STATE_FILE = resolve(PUBLIC, 'alerts.json');
const REPORT_FILE = process.env.ALERT_REPORT ?? resolve(__dir, '../alert_report.md'); // Step Summary용(markdown)
const REPORT_HTML = process.env.ALERT_REPORT_HTML ?? resolve(__dir, '../alert_report.html'); // 메일 본문용(인라인 스타일 HTML)
const DASHBOARD_URL = 'https://ai-dh-kim.github.io/ispq/';
const CHARTS_DIR = resolve(PUBLIC, 'alert_charts'); // 주간 추이 PNG(매주 덮어씀, 커밋됨)
// 메일의 <img src>는 커밋 SHA 고정 raw URL이어야 하는데 SHA는 커밋 뒤에야 안다 → 자리표시자를 쓰고 워크플로가 sed로 치환.
const CHART_BASE = process.env.ALERT_CHART_BASE ?? '__CHART_BASE__';
// 추이 차트 대상: 종합지표 5종 + 사건 트리거 지표 4종(값이 계단형·저수준이라 순위표엔 없지만 주간 변화는 선으로 봐야 보인다).
const CHART_SPECS: ChartSpec[] = [
  ...SUMMARY_METRICS.map((m) => ({ id: m.id, short: m.short, unit: METRIC_BY_ID[m.id]?.unit ?? '' })),
  { id: 'ipv6', short: 'IPv6 채택률 (Radar)', unit: '%' }, { id: 'dnssec', short: 'DNSSEC 검증률 (APNIC)', unit: '%' },
  { id: 'rpkiValid', short: 'RPKI 유효율 (Radar)', unit: '%' }, { id: 'packetLoss', short: '패킷 손실률 (SpeedTest)', unit: '%' },
];

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
// 판정 1건의 구조화 결과 — 보고서(markdown)와 메일(HTML 표) 양쪽이 이걸로 렌더링한다.
export interface Check {
  key: string; group: 'A' | 'S' | 'D'; trigger: string; target: string; // target: ISP id 또는 캐시/출처 그룹명
  metric: string; // 사람이 읽는 지표명 + 출처 — "IPv6 채택률 (Cloudflare Radar)" · D는 감시 대상 파일/출처
  metricId?: string; // A/S만 — 주간 메일에서 같은 지표의 차트 아래에 묶기 위한 키
  meaning: string; // 걸리면 무슨 상황인지 한 줄
  cond: string; value: number | null; unit: string; date: string; // 최근 유효값과 그 날짜(D는 경과시간·기준시각)
  met: boolean; active: boolean;
}
// '기타' 탭(etc)은 출처 3곳을 묶은 화면용 라벨이라 지표별 실제 제공처로 바꿔 표기.
const PROVIDER_OVERRIDE: Record<string, string> = { dnssec: 'APNIC', steamDownload: 'Steam', nfSpeedIndex: 'Netflix' };
const metricLabel = (id: string) => { const m = METRIC_BY_ID[id]; return m ? `${m.name} (${PROVIDER_OVERRIDE[id] ?? SOURCES[m.source]?.label ?? m.source})` : id; };
export interface EvalResult { state: AlertState; events: AlertEvent[]; checks: Check[] }

const condText = (r: Rule, unit: string) =>
  r.cmp === 'rise_pp' ? `28일 중앙값 대비 +${r.th}%p 이상 · ${r.days}일 연속`
  : r.cmp === 'drop_pct' ? `28일 중앙값 대비 -${r.th}% 이상 하락 · ${r.days}일 연속`
  : r.cmp === 'gt0' ? `0 초과 · ${r.days}일 연속`
  : `${r.cmp === 'gte' ? '≥' : '≤'} ${r.th}${unit} · ${r.days}일 연속`;

export function evaluate({ data, cacheGeneratedAt, now, prev }: EvalInput): EvalResult {
  const nowIso = new Date(now).toISOString();
  const active: Record<string, ActiveAlert> = { ...prev.active };
  const events: AlertEvent[] = [];
  const checks: Check[] = [];
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
        const mname = METRIC_BY_ID[trg.metric]?.name ?? trg.metric;
        if (!active[key] && on.all && on.last && on.first) {
          fire(key, { trigger: trg.id, target: isp, since: dayKey(on.first.t), value: on.last.v,
            detail: `${ispName(isp)} ${mname} ${fmt(on.last.v, unit)} — ${condText(r, unit)}. ${r.meaning}` });
        } else if (active[key] && off.none && off.last) {
          clear(key, off.last.v, `${ispName(isp)} ${mname} ${fmt(off.last.v, unit)} — 조건 미충족 ${CLEAR_DAYS}일 연속, 해소`);
        }
        checks.push({ key, group: trg.id.startsWith('S') ? 'S' : 'A', trigger: trg.id, target: isp, metric: metricLabel(trg.metric), metricId: trg.metric, meaning: r.meaning, cond: condText(r, unit),
          value: lastV, unit, date: pts.length ? dayKey(pts[pts.length - 1].t) : '데이터 없음', met: on.all, active: !!active[key] });
      }
    }
  }

  // D1-a: quality_data.json 미갱신
  {
    const key = 'D1-a:quality_data';
    const ageH = (now - Date.parse(data.generatedAt)) / HOUR;
    if (!active[key] && ageH >= D1A_HOURS) fire(key, { trigger: 'D1-a', target: 'quality_data', since: data.generatedAt, value: Math.round(ageH), detail: `quality_data.json 이 ${ageH.toFixed(0)}시간 미갱신 — Refresh 워크플로 정지 의심(GitHub 장애·Cloudflare 토큰 만료)` });
    else if (active[key] && ageH < D1A_HOURS) clear(key, Math.round(ageH), `quality_data.json 갱신 재개(${ageH.toFixed(1)}h 전)`);
    checks.push({ key, group: 'D', trigger: 'D1-a', target: 'quality_data', metric: 'quality_data.json 갱신 시각 (10분 Refresh)', meaning: 'Refresh 워크플로 정지 — GitHub 장애·Cloudflare 토큰 만료', cond: `${D1A_HOURS}h 이상 미갱신`, value: Math.round(ageH * 10) / 10, unit: 'h',
      date: data.generatedAt.slice(0, 16).replace('T', ' ') + 'Z', met: ageH >= D1A_HOURS, active: !!active[key] });
  }

  // D1-b: 일별 캐시 7종 미갱신
  for (const name of CACHE_NAMES) {
    const key = `D1-b:${name}`;
    const g = cacheGeneratedAt[name];
    const ageH = g ? (now - Date.parse(g)) / HOUR : Infinity;
    if (!active[key] && ageH >= D1B_HOURS) fire(key, { trigger: 'D1-b', target: name, since: g ?? nowIso, value: Number.isFinite(ageH) ? Math.round(ageH) : null, detail: `${name}_cache.json 이 ${Number.isFinite(ageH) ? `${(ageH / 24).toFixed(1)}일` : '기록 없음'} 미갱신 — 수집기 정지·API 규격 변경·엔드포인트 차단 의심` });
    else if (active[key] && ageH < D1B_HOURS) clear(key, Math.round(ageH), `${name} 수집 재개(${ageH.toFixed(1)}h 전)`);
    checks.push({ key, group: 'D', trigger: 'D1-b', target: name, metric: `${name}_cache.json 갱신 시각 (일별 수집)`, meaning: '해당 수집기 정지 — API 규격 변경·엔드포인트 차단', cond: `${D1B_HOURS}h 이상 미갱신`, value: Number.isFinite(ageH) ? Math.round(ageH * 10) / 10 : null, unit: 'h',
      date: g ? g.slice(0, 16).replace('T', ' ') + 'Z' : '파일 없음', met: ageH >= D1B_HOURS, active: !!active[key] });
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
    if (!active[key] && stale) fire(key, { trigger: 'D2', target: group, since: dayKey(seg[0].t), value: null, detail: `${group} 출처의 전 사업자·전 값이 ${D2_DAYS}일 연속(${dayKey(seg[0].t)}~${dayKey(seg[seg.length - 1].t)}) 완전 동일 — 수집은 성공하나 공급처가 새 값을 내놓지 않음` });
    else if (active[key] && !stale) clear(key, null, `${group} 출처 값 변동 재개`);
    checks.push({ key, group: 'D', trigger: 'D2', target: group, metric: `${group} 출처의 전 사업자 일별 값`, meaning: '수집은 성공하나 공급처가 새 값을 내놓지 않음(원본 정체)', cond: `전 사업자·전 값 ${D2_DAYS}일 연속 동일`, value: null, unit: '',
      date: seg.length ? `${dayKey(seg[0].t)}~${dayKey(seg[seg.length - 1].t).slice(5)}` : '데이터 없음', met: stale, active: !!active[key] });
  }

  const history = [...prev.history, ...events].slice(-HISTORY_CAP);
  return { state: { version: 1, updatedAt: nowIso, lastRun: { at: nowIso, events: events.length }, active, history }, events, checks };
}

// ---- 주간 창: 지난주 월~일 (KST 달력 기준) ----
// coarse 버킷은 UTC 자정 키라 '날짜 라벨'로 다룬다 — 월요일 라벨 버킷 ~ 일요일 라벨 버킷 7개.
export interface WeekWindow { from: number; to: number; prevFrom: number; label: string } // [from,to) · prev=[prevFrom,from)
const mdLabel = (ms: number) => { const d = new Date(ms); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
export function prevWeekWindow(now: number): WeekWindow {
  const kst = new Date(now + 9 * HOUR); // UTC getter = KST 달력
  const sinceMon = (kst.getUTCDay() + 6) % 7; // 월=0
  const thisMon = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - sinceMon);
  const from = thisMon - 7 * DAY;
  return { from, to: thisMon, prevFrom: thisMon - 14 * DAY, label: `${mdLabel(from)}(월)~${mdLabel(thisMon - DAY)}(일)` };
}
function windowMean(data: QualityData, isp: string, metric: string, from: number, to: number): number | null {
  const v = data.series[isp]?.[metric]?.coarse?.[0]; if (!v) return null;
  const axis = data.tiers.coarse.t; let s = 0, n = 0;
  for (let i = 0; i < axis.length; i++) { const x = v[i]; if (x != null && axis[i] >= from && axis[i] < to) { s += x; n++; } }
  return n ? s / n : null;
}

// ---- 요약 재료: 3사 대표 지표 순위(종합지표 패널과 동일 지표·색 규칙) + 수집 신선도 ----
export interface RankCell { isp: string; v: number | null; rank: number | null; ranked: number; delta?: number | null } // delta: 전전주 대비 %
export interface DigestData {
  ranks: { id: string; short: string; unit: string; hib: boolean; cells: RankCell[] }[];
  fresh: { name: string; ageH: number | null; limitH: number }[];
  week?: WeekWindow;
}
export function digestData(data: QualityData, cacheGeneratedAt: Record<string, string | null>, now: number, week?: WeekWindow): DigestData {
  let ranks: DigestData['ranks'];
  if (week) {
    // 주간: 지난주 7일 평균으로 순위, 전전주 평균 대비 변화율
    ranks = SUMMARY_METRICS.map((m) => {
      const hib = METRIC_BY_ID[m.id]?.higherIsBetter ?? true;
      const cells: RankCell[] = KR3.map((isp) => {
        const v = windowMean(data, isp, m.id, week.from, week.to), p = windowMean(data, isp, m.id, week.prevFrom, week.from);
        return { isp, v, rank: null, ranked: 0, delta: v != null && p != null && p !== 0 ? ((v - p) / p) * 100 : null };
      });
      const vals = cells.filter((c) => c.v != null);
      for (const c of cells) if (c.v != null) { c.rank = vals.filter((o) => (hib ? o.v! > c.v! : o.v! < c.v!)).length + 1; c.ranked = vals.length; }
      return { id: m.id, short: m.short, unit: METRIC_BY_ID[m.id]?.unit ?? '', hib, cells };
    });
  } else {
    const rows = buildSummary(data, KR3, SUMMARY_METRICS.map((m) => m.id), 7);
    ranks = SUMMARY_METRICS.map((m) => ({ id: m.id, short: m.short, unit: METRIC_BY_ID[m.id]?.unit ?? '', hib: METRIC_BY_ID[m.id]?.higherIsBetter ?? true, cells: KR3.map((isp) => ({ isp, ...rows.get(isp)![m.id] })) }));
  }
  const fresh = [
    { name: 'quality_data', ageH: (now - Date.parse(data.generatedAt)) / HOUR, limitH: D1A_HOURS },
    ...CACHE_NAMES.map((n) => { const g = cacheGeneratedAt[n]; return { name: n, ageH: g ? (now - Date.parse(g)) / HOUR : null, limitH: D1B_HOURS }; }),
  ];
  return { ranks, fresh, week };
}
const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

// 차트 임계선: 트리거 규칙을 지표별·ISP별 y값으로. 상대 규칙(rise_pp·drop_pct)은 주 마지막 날 기준 직전 28일 중앙값으로 환산.
export function chartGuides(data: QualityData, week: WeekWindow): Record<string, Guide[]> {
  const out: Record<string, Guide[]> = {};
  const baseline = (isp: string, metric: string): number | null => {
    const v = data.series[isp]?.[metric]?.coarse?.[0]; if (!v) return null;
    const axis = data.tiers.coarse.t; const h: number[] = [];
    for (let i = 0; i < axis.length; i++) { const x = v[i]; if (x != null && axis[i] >= week.to - BASE_DAYS * DAY && axis[i] < week.to) h.push(x); }
    return h.length >= 14 ? med(h) : null;
  };
  for (const trg of TRIGGERS) for (const isp of trg.isps) for (const r of trg.rules) {
    let y: number | null = null, label = '';
    switch (r.cmp) {
      case 'gte': y = r.th; label = `${trg.id} ≥ ${r.th}`; break; // ≥/≤ 는 DejaVu·Arial 모두 있음(차트 폰트)
      case 'lte': y = r.th; label = `${trg.id} ≤ ${r.th}`; break;
      case 'gt0': y = 0; label = `${trg.id} > 0`; break;
      case 'rise_pp': { const b = baseline(isp, trg.metric); if (b != null) { y = b + r.th; label = `${trg.id} +${r.th}pp`; } break; }
      case 'drop_pct': { const b = baseline(isp, trg.metric); if (b != null) { y = b * (1 - r.th / 100); label = `${trg.id} -${r.th}%`; } break; }
    }
    if (y != null) (out[trg.metric] ??= []).push({ isp, y, label });
  }
  return out;
}
const weekEvents = (state: AlertState, week: WeekWindow) => state.history.filter((e) => { const t = Date.parse(e.at) + 9 * HOUR; return t >= week.from && t < week.to; });

// Step Summary(markdown)용
export function digest(data: QualityData, cacheGeneratedAt: Record<string, string | null>, now: number, week?: WeekWindow): string {
  const dg = digestData(data, cacheGeneratedAt, now, week);
  const lines: string[] = ['| 지표 | 1위 | 2위 | 3위 |', '|---|---|---|---|'];
  for (const m of dg.ranks) {
    const cells = m.cells.filter((c) => c.rank != null).sort((a, b) => a.rank! - b.rank!);
    lines.push(`| ${m.short} | ${cells.map((c) => `${ispName(c.isp)} ${fmt(round1(c.v), m.unit)}${c.delta != null ? ` (${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(1)}%)` : ''}`).join(' | ')} |`);
  }
  const fresh = dg.fresh.map((f) => `${f.name} ${f.ageH == null ? '없음' : `${f.ageH.toFixed(f.name === 'quality_data' ? 1 : 0)}h`}`).join(' · ');
  return `### 3사 대표 지표 순위 (${week ? `지난주 ${week.label} 평균 · 괄호는 전전주 대비` : '최근 7일 평균'})\n${lines.join('\n')}\n\n### 수집 신선도\n${fresh}`;
}

export function buildReport(r: EvalResult, data: QualityData, cacheGeneratedAt: Record<string, string | null>, now: number, week?: WeekWindow): string {
  const kst = new Date(now).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  const fired = r.events.filter((e) => e.type === 'fire'), cleared = r.events.filter((e) => e.type === 'clear');
  const out: string[] = [`# ${week ? `주간 요약 (${week.label})` : '품질 이상 알림 판정'} — ${kst} KST`, ''];
  if (week) { const ev = weekEvents(r.state, week); out.push(`## 지난주 이벤트 ${ev.length}건`); for (const e of ev) out.push(`- ${e.at.slice(0, 10)} ${e.type === 'fire' ? '발동' : '해소'} **${e.key}** — ${e.detail}`); if (!ev.length) out.push('- 없음'); out.push(''); }
  if (fired.length) { out.push(`## 🔴 신규 발동 ${fired.length}건`); for (const e of fired) out.push(`- **${e.key}** — ${e.detail}`); out.push(''); }
  if (cleared.length) { out.push(`## 🟢 해소 ${cleared.length}건`); for (const e of cleared) out.push(`- **${e.key}** — ${e.detail}`); out.push(''); }
  if (!r.events.length) out.push('## 신규 이벤트 없음', '');
  const act = Object.entries(r.state.active);
  out.push(`## 활성 알림 ${act.length}건`);
  for (const [k, a] of act) out.push(`- ${k} (since ${a.since.slice(0, 10)}) — ${a.detail}`);
  if (!act.length) out.push('- 없음');
  out.push('', digest(data, cacheGeneratedAt, now, week), '', '<details><summary>판정 상세</summary>', '',
    ...r.checks.map((c) => `- ${c.key} · ${c.metric} · ${c.group === 'D' ? c.target : ispName(c.target)} — 최근값 ${fmt(c.value, c.unit)} (${c.date}) → ${c.met ? '충족' : '미충족'}${c.active ? ' [활성]' : ''}`), '', '</details>');
  return out.join('\n');
}

// ---- 메일 본문(HTML) — 메일 클라이언트는 <style>·flex·grid를 못 믿으므로 표 레이아웃 + 인라인 스타일만 쓴다 ----
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
const C = { ink: '#16242f', soft: '#54697a', faint: '#8496a4', line: '#d7e0e8', paper: '#eef2f6', card: '#ffffff', card2: '#f7fafc',
  accent: '#1f6091', accentSoft: '#e2edf6', good: '#237a4d', goodSoft: '#e0f0e7', warn: '#9a6a13', warnSoft: '#f6ecd6',
  bad: '#a53a3a', badSoft: '#f7e3e3', ops: '#5a6b7a', opsSoft: '#e9eef2' };
// 셀마다 반복되는 문자열이라 짧게 유지(Gmail은 본문 102KB 초과 시 잘라냄). 한글은 각 OS 기본 한글 폰트로 폴백된다.
const FONT = 'font-family:Malgun Gothic,Arial,sans-serif;';
const GROUP_LABEL: Record<Check['group'], string> = { A: '사건 트리거 (A) — 구조 변화·장애', S: '속도 트리거 (S) — 28일 대비 하락', D: '운영 트리거 (D) — 수집 상태' };

export function buildMailHtml(r: EvalResult, data: QualityData, cacheGeneratedAt: Record<string, string | null>, now: number,
  opts: { runUrl?: string; test?: boolean; week?: WeekWindow; charts?: RenderedChart[]; chartBase?: string } = {}): string {
  const kst = new Date(now).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
  const fired = r.events.filter((e) => e.type === 'fire'), cleared = r.events.filter((e) => e.type === 'clear');
  const act = Object.entries(r.state.active);
  const week = opts.week;
  const dg = digestData(data, cacheGeneratedAt, now, week);
  const wev = week ? weekEvents(r.state, week) : [];
  const freshState = (f: DigestData['fresh'][number]) => f.ageH == null ? 'none' : f.ageH >= f.limitH ? 'over' : f.ageH >= f.limitH * 0.5 ? 'warn' : 'ok';
  const freshBad = dg.fresh.filter((f) => freshState(f) === 'over' || freshState(f) === 'none').length;
  const freshWarn = dg.fresh.filter((f) => freshState(f) === 'warn').length;

  const chip = (text: string, color: string, bg: string) =>
    `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;color:${color};background:${bg};white-space:nowrap;${FONT}">${esc(text)}</span>`;
  const status = fired.length ? chip(`사건 ${fired.length}건`, C.bad, C.badSoft)
    : cleared.length ? chip(`해소 ${cleared.length}건`, C.good, C.goodSoft)
    : act.length ? chip(`활성 알림 ${act.length}건 유지`, C.warn, C.warnSoft)
    : week ? chip(wev.length ? `지난주 이벤트 ${wev.length}건` : '지난주 이상 없음', wev.length ? C.warn : C.good, wev.length ? C.warnSoft : C.goodSoft)
    : chip('이상 없음', C.good, C.goodSoft);
  const tile = (num: string, lab: string, color: string) =>
    `<td width="25%" style="padding:0 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:10px 12px;background:${C.card};border:1px solid ${C.line};border-left:3px solid ${color};border-radius:6px">` +
    `<div style="font-size:21px;font-weight:700;color:${C.ink};${FONT}">${esc(num)}</div><div style="font-size:11px;color:${C.soft};${FONT}">${esc(lab)}</div></td></tr></table></td>`;
  const section = (title: string, body: string, sub = '') =>
    `<tr><td style="padding:18px 0 0"><div style="font-size:14px;font-weight:700;color:${C.ink};${FONT}">${esc(title)}</div>` +
    (sub ? `<div style="font-size:11.5px;color:${C.faint};margin:2px 0 8px;${FONT}">${esc(sub)}</div>` : '<div style="height:8px"></div>') + body + '</td></tr>';
  const th = (t: string, extra = '') => `<th align="left" style="padding:6px 10px;font-size:11px;color:${C.faint};font-weight:600;background:${C.card2};border-bottom:1px solid ${C.line};${FONT}${extra}">${esc(t)}</th>`;
  const td = (html: string, extra = '') => `<td style="padding:7px 10px;font-size:12.5px;color:${C.ink};border-bottom:1px solid ${C.line};${FONT}${extra}">${html}</td>`;
  const table = (inner: string) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:6px;border-collapse:separate;overflow:hidden">${inner}</table>`;

  // 이벤트 카드
  const eventCard = (e: AlertEvent) => { const f = e.type === 'fire'; return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px"><tr><td style="padding:10px 12px;background:${f ? C.badSoft : C.goodSoft};border-left:4px solid ${f ? C.bad : C.good};border-radius:6px;${FONT}">` +
    `<div style="font-size:11px;font-weight:700;color:${f ? C.bad : C.good}">${f ? '🔴 신규 발동' : '🟢 해소'} · ${esc(e.key)}</div><div style="font-size:13px;color:${C.ink};margin-top:3px">${esc(e.detail)}</div></td></tr></table>`; };
  const eventsHtml = r.events.length ? r.events.map(eventCard).join('')
    : `<div style="padding:10px 12px;background:${C.card};border:1px solid ${C.line};border-radius:6px;font-size:13px;color:${C.soft};${FONT}">신규 이벤트 없음 — 모든 트리거가 정상 범위입니다.</div>`;
  const activeHtml = act.length ? table(act.map(([k, a]) => `<tr>${td(`<b>${esc(k)}</b><div style="font-size:11px;color:${C.faint}">since ${esc(a.since.slice(0, 10))}</div>`, 'white-space:nowrap')}${td(esc(a.detail))}</tr>`).join(''))
    : `<div style="font-size:12.5px;color:${C.soft};${FONT}">없음</div>`;

  // 3사 순위 매트릭스 — 종합지표 패널과 같은 색 규칙(1위 초록 · 꼴찌 빨강)
  const rankCell = (c: RankCell, unit: string, hib: boolean) => {
    const bg = c.rank === 1 ? C.goodSoft : c.rank != null && c.rank === c.ranked && c.ranked > 1 ? C.badSoft : 'transparent';
    const col = c.rank === 1 ? C.good : c.rank != null && c.rank === c.ranked && c.ranked > 1 ? C.bad : C.soft;
    // 전전주 대비 변화: 개선이면 초록, 악화면 빨강(지표 방향 반영). ±0.5% 미만은 회색 "보합".
    const delta = c.delta == null ? '' : Math.abs(c.delta) < 0.5 ? `<div style="font-size:10.5px;color:${C.faint}">보합</div>`
      : `<div style="font-size:10.5px;font-weight:700;color:${(c.delta > 0) === hib ? C.good : C.bad}">${c.delta > 0 ? '▲' : '▼'} ${Math.abs(c.delta).toFixed(1)}%</div>`;
    return td(`<span style="font-size:13px;font-weight:700;color:${C.ink}">${esc(fmt(round1(c.v), ''))}</span><span style="font-size:10.5px;color:${C.faint}"> ${esc(unit)}</span>` +
      (c.rank != null ? `<span style="float:right;font-size:10.5px;font-weight:700;color:${col}">${c.rank}위</span>` : '') + delta, `background:${bg};text-align:left`);
  };
  const ranksHtml = table(`<tr>${th(week ? `지표 (지난주 ${week.label} 평균)` : '지표 (최근 7일 평균)')}${KR3.map((i) => th(ispName(i), 'text-align:left;width:22%')).join('')}</tr>` +
    dg.ranks.map((m) => `<tr>${td(`<b>${esc(m.short)}</b>`)}${m.cells.map((c) => rankCell(c, m.unit, m.hib)).join('')}</tr>`).join(''));
  const weekEventsHtml = wev.length ? wev.map(eventCard).join('')
    : `<div style="padding:10px 12px;background:${C.card};border:1px solid ${C.line};border-radius:6px;font-size:13px;color:${C.soft};${FONT}">지난주 발동·해소 이벤트 없음 — 트리거 전부 정상 범위였습니다.</div>`;
  // 판정 행 렌더러 — 전체 표(일별 메일)와 지표 카드(주간 메일) 양쪽에서 씀. withMetric=false 면 지표명 열을 생략(카드 제목에 이미 있음).
  const stateChip = (c: Check) => c.active ? chip('발동 중', C.bad, C.badSoft) : c.met ? chip('충족', C.warn, C.warnSoft) : chip('정상', C.ops, C.opsSoft);
  const checkRow = (c: Check, withMetric: boolean) => `<tr>${td(withMetric ? `<b style="color:${C.accent}">${esc(c.trigger)}</b> · <b>${esc(c.metric)}</b>` : `<b style="color:${C.accent}">${esc(c.trigger)}</b>`, withMetric ? '' : 'white-space:nowrap')}` +
    `${td(esc(c.group === 'D' ? c.target : ispName(c.target)), 'white-space:nowrap')}${td(`${esc(c.cond)}<div style="color:${C.faint};font-size:11px">${esc(c.meaning)}</div>`, 'font-size:11.5px;color:' + C.soft)}` +
    `${td(esc(fmt(c.value, c.unit)), 'text-align:right;white-space:nowrap')}${td(`<span style="color:${C.faint};font-size:11px">${esc(c.date)}</span>`, 'white-space:nowrap')}${td(stateChip(c))}</tr>`;
  // 지표 카드(주간) — 차트 + 그 지표의 A/S 판정. 규칙당 1행, 열은 차트 패널과 같은 순서(LG U+ · KT · SKB)라 점선↔셀이 바로 대응된다.
  // (ISP별 행으로 풀면 조건·의미가 3번 반복돼 본문이 Gmail 102KB 한도에 닿았음 — 2026-09-09)
  const tdc = (html: string, extra = '') => `<td style="padding:6px 8px;font-size:12px;border-bottom:1px solid ${C.line};${FONT}${extra}">${html}</td>`;
  const metricCards = (opts.charts ?? []).map((c) => {
    const rows = r.checks.filter((k) => k.metricId === c.id);
    const rules = [...new Map(rows.map((k) => [`${k.trigger}:${k.key.split(':')[2]}`, k])).entries()]; // 규칙 대표 행
    const ids = [...new Set(rows.map((k) => k.trigger))];
    const head = `<tr><td style="padding:0 0 6px;${FONT}"><span style="font-size:13.5px;font-weight:700;color:${C.ink}">${esc(c.short)}</span> ` +
      (ids.length ? ids.map((id) => chip(id, C.accent, C.accentSoft)).join(' ') : `<span style="font-size:11px;color:${C.faint}">트리거 없음 · 순위 비교용</span>`) +
      (rows.some((k) => k.active) ? ' ' + chip('발동 중', C.bad, C.badSoft) : '') + `</td></tr>`;
    const img = `<tr><td><img src="${esc(`${opts.chartBase ?? CHART_BASE}/${c.file}`)}" width="640" height="125" alt="${esc(c.short)} 지난주 일별 추이" style="display:block;width:100%;max-width:640px;height:auto;border:0"></td></tr>`;
    const cell = (k: Check | undefined) => !k ? tdc(`<span style="color:${C.faint}">—</span>`, 'text-align:center')
      : tdc(`<b style="color:${C.ink}">${esc(fmt(k.value, k.unit))}</b> ${stateChip(k)}<div style="font-size:10.5px;color:${C.faint}">${esc(k.date)}</div>`, 'white-space:nowrap');
    const tbl = rules.length ? `<tr><td style="padding:6px 0 0">${table(`<tr>${th('트리거', 'width:8%')}${th('조건 (차트 점선) · 걸리면 이런 상황', 'width:41%')}${CHART_ISPS.map((i) => th(ispName(i), 'width:17%')).join('')}</tr>` +
      rules.map(([rk, k0]) => `<tr>${tdc(`<b style="color:${C.accent}">${esc(k0.trigger)}</b>`, 'white-space:nowrap')}${tdc(`<span style="color:${C.soft}">${esc(k0.cond)}</span><div style="color:${C.faint};font-size:10.5px">${esc(k0.meaning)}</div>`, 'font-size:11.5px')}` +
        CHART_ISPS.map((isp) => cell(rows.find((k) => k.target === isp && `${k.trigger}:${k.key.split(':')[2]}` === rk))).join('') + '</tr>').join(''))}</td></tr>` : '';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;padding:10px 12px;background:${C.card2};border:1px solid ${C.line};border-radius:8px">${head}${img}${tbl}</table>`;
  }).join('');

  // 수집 신선도
  const freshChip = (f: DigestData['fresh'][number]) => { const s = freshState(f); return s === 'ok' ? chip('정상', C.good, C.goodSoft) : s === 'warn' ? chip('주의', C.warn, C.warnSoft) : s === 'over' ? chip('허용 초과', C.bad, C.badSoft) : chip('파일 없음', C.bad, C.badSoft); };
  const freshHtml = table(`<tr>${th('출처')}${th('마지막 갱신', 'text-align:right')}${th('허용', 'text-align:right')}${th('상태')}</tr>` +
    dg.fresh.map((f) => `<tr>${td(esc(f.name))}${td(f.ageH == null ? '–' : `${f.ageH.toFixed(1)}h 전`, 'text-align:right;white-space:nowrap')}${td(`${f.limitH}h`, 'text-align:right;color:' + C.faint)}${td(freshChip(f))}</tr>`).join(''));

  // 트리거 판정 현황 — 주간 메일에선 A/S가 지표 카드로 올라가므로 D만, 일별 메일에선 전체.
  // 한 행 = "A1 · IPv6 채택률 (Cloudflare Radar)" / KT / 조건 + 의미 한 줄 / 최근값 / 기준일 / 상태 — ID만으론 무슨 지표인지 안 보여서(2026-09-09) 지표명·의미를 같이 표기.
  const tableGroups: Check['group'][] = week && opts.charts?.length ? ['D'] : ['A', 'S', 'D'];
  const checksHtml = table(`<tr>${th('트리거 · 지표', 'width:27%')}${th('대상', 'width:11%')}${th('조건 · 걸리면 이런 상황', 'width:36%')}${th('최근값', 'text-align:right;width:9%')}${th('기준일', 'width:10%')}${th('상태', 'width:7%')}</tr>` +
    tableGroups.map((g) => `<tr><td colspan="6" style="padding:6px 10px;font-size:11px;font-weight:700;color:${C.accent};background:${C.accentSoft};${FONT}">${esc(GROUP_LABEL[g])}</td></tr>` +
      r.checks.filter((c) => c.group === g).map((c) => checkRow(c, true)).join('')).join(''));

  const links = `<a href="${DASHBOARD_URL}" style="color:${C.accent};text-decoration:none">대시보드 열기</a>` + (opts.runUrl ? ` · <a href="${esc(opts.runUrl)}" style="color:${C.accent};text-decoration:none">판정 실행 로그</a>` : '');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ISPQ 알림</title></head>` +
    `<body style="margin:0;padding:0;background:${C.paper}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper}"><tr><td align="center" style="padding:20px 10px">` +
    `<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">` +
    `<tr><td style="padding:0 0 12px;border-bottom:3px solid ${C.accent}"><div style="font-size:11px;letter-spacing:.12em;color:${C.accent};font-weight:700;${FONT}">ISP 품질 대시보드 · ${week ? '주간 요약' : '자동 알림'}${opts.test ? ' · 테스트 발송' : ''}</div>` +
    `<div style="font-size:20px;font-weight:700;color:${C.ink};margin:4px 0 6px;${FONT}">${week ? `주간 요약 — 지난주 ${esc(week.label)}` : '품질 이상 알림 판정'}</div><div style="font-size:12px;color:${C.faint};${FONT}">${esc(kst)} KST &nbsp; ${status}</div></td></tr>` +
    `<tr><td style="padding:14px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>` +
    (week ? tile(String(wev.length), '지난주 이벤트', wev.length ? C.warn : C.accent) : tile(String(fired.length), '신규 발동', fired.length ? C.bad : C.accent)) +
    tile(String(act.length), '활성 알림', act.length ? C.warn : C.accent) +
    tile(freshBad ? `${freshBad} 초과` : freshWarn ? `${freshWarn} 주의` : '정상', '수집 신선도', freshBad ? C.bad : freshWarn ? C.warn : C.good) + tile(String(r.checks.length), '판정 항목', C.accent) +
    `</tr></table></td></tr>` +
    (week ? section(`지난주 이벤트 (${week.label})`, weekEventsHtml) + (r.events.length ? section('오늘 신규 이벤트', eventsHtml) : '') : section('이벤트', eventsHtml)) +
    section('활성 알림', activeHtml) +
    section('국내 3사 대표 지표 순위', ranksHtml, week ? `지난주 ${week.label} 일별 집계 평균 · 1위 초록 · 꼴찌 빨강 · 화살표는 전전주 대비 변화(초록=개선, 빨강=악화)` : '종합지표 패널과 같은 계산 · 1위 초록 · 꼴찌 빨강') +
    (week && opts.charts?.length ? section('지표별 지난주 추이 + 트리거 판정', metricCards, `진한 선·점 = 지난주 ${week.label} · 연한 선 = 1주 전 · 더 연한 선 = 2주 전 · 빨간 점선 = 아래 표의 트리거 임계값(상대 조건은 28일 기준선으로 환산) · 패널 눈금은 공유, 사업자 간 수준이 5배 이상 벌어지면 개별(own scale)`) : '') +
    section('수집 신선도', freshHtml) +
    section(week && opts.charts?.length ? '운영 트리거 판정 현황' : '트리거 판정 현황', checksHtml, '"정상" = 조건 미충족. "충족"은 조건은 넘었으나 아직 발동 처리 전, "발동 중"은 해소 전까지 재발송 없음') +
    `<tr><td style="padding:18px 0 0;border-top:1px solid ${C.line};margin-top:18px;font-size:11px;color:${C.faint};${FONT}">${links} · 판정 규칙: 핸드오프 문서 §17 · 이 메일은 자동 발송됩니다</td></tr>` +
    `</table></td></tr></table></body></html>`;
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

  const weekly = process.env.ALERT_WEEKLY === 'true'; // 월요일 아침 크론(또는 수동 weekly) → 지난주 월~일 기준 요약
  const week = weekly ? prevWeekWindow(now) : undefined;
  const r = evaluate({ data, cacheGeneratedAt, now, prev });
  await writeFile(STATE_FILE, JSON.stringify(r.state, null, 1));
  const charts = week ? await renderWeeklyCharts(data, week.from, CHART_SPECS, CHARTS_DIR, chartGuides(data, week)) : [];
  if (charts.length) console.log(`[alert] 주간 추이 차트 ${charts.length}장 → ${CHARTS_DIR} (${charts.map((c) => `${c.id} ${(c.bytes / 1024).toFixed(0)}KB`).join(', ')})`);
  const report = buildReport(r, data, cacheGeneratedAt, now, week);
  await writeFile(REPORT_FILE, report);
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  await writeFile(REPORT_HTML, buildMailHtml(r, data, cacheGeneratedAt, now, { runUrl, test: process.env.ALERT_TEST_MAIL === 'true', week, charts }));
  console.log(report);

  // 워크플로 출력: 신규 이벤트 수 · 주간 여부 · 메일 제목
  const fired = r.events.filter((e) => e.type === 'fire');
  const subject = fired.length
    ? `[ISPQ 알림] ${fired.map((e) => e.key).join(', ')}${week ? ` · 주간 요약 ${week.label}` : ''}`
    : r.events.length ? `[ISPQ 해소] ${r.events.map((e) => e.key).join(', ')}${week ? ` · 주간 요약 ${week.label}` : ''}`
    : week ? `[ISPQ 주간 요약] ${week.label} · 이벤트 ${weekEvents(r.state, week).length}건 · 활성 ${Object.keys(r.state.active).length}건`
    : `[ISPQ 판정] 이벤트 없음 · 활성 ${Object.keys(r.state.active).length}건`;
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `new_events=${r.events.length}\nfired=${fired.length}\nweekly=${weekly}\nsubject=${subject}\nreport=${REPORT_FILE}\nreport_html=${REPORT_HTML}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('[alert] fatal:', err); process.exit(1); });
}
