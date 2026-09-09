// detect-anomaly.ts 자체 검증 — 실데이터로 (1) 현재 발동 0건인지, (2) 합성 변조로 트리거별 발동·1회 발송·해소가
// 동작하는지 확인한다. 외부 호출 없음. 실행: npm run alerts:test  (실패 시 exit 1 → CI에서 바로 드러남)

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, emptyState, buildMailHtml, buildReport, digestData, prevWeekWindow, TRIGGERS, CACHE_NAMES, KR3, type AlertState } from './detect-anomaly.ts';
import { extractSeries, weeklyChartSvg, svgToPng, renderWeeklyCharts } from './weekly-charts.ts';
import { tmpdir } from 'node:os';
import type { QualityData } from '../src/types.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dir, '../public');
let failures = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// (isp, metric) coarse의 마지막 n개 유효 '완결일' 값을 f(기존값)로 치환 — 판정기와 같이 부분일(오늘 버킷)은 건너뜀
function patchTail(d: QualityData, isp: string, metric: string, n: number, f: (v: number, i: number) => number) {
  const blk = d.series[isp][metric].coarse; const v = blk[0]; const axis = d.tiers.coarse.t;
  const generated = Date.parse(d.generatedAt);
  let done = 0;
  for (let i = v.length - 1; i >= 0 && done < n; i--) if (v[i] != null && axis[i] + 86400000 <= generated) { v[i] = f(v[i] as number, i); done++; }
  if (done < n) throw new Error(`patchTail: ${isp}/${metric} 유효일 부족`);
}
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
// 마지막 n개 완결일을 '직전 28일 중앙값 × factor'로 치환 — 추세가 있는 지표(KT NIA 1G 업로드 43일간 +12%)에서도
// 기준선 대비 하락폭이 정확히 (1-factor)가 되게 한다(현재값×factor로는 상승 추세만큼 덜 떨어진다).
function patchTailVsBase(d: QualityData, isp: string, metric: string, n: number, factor: number) {
  const v = d.series[isp][metric].coarse[0]; const axis = d.tiers.coarse.t; const generated = Date.parse(d.generatedAt);
  const idx: number[] = []; for (let i = v.length - 1; i >= 0; i--) if (v[i] != null && axis[i] + 86400000 <= generated) idx.push(i);
  const base = median(idx.slice(n, n + 28).map((i) => v[i] as number));
  for (const i of idx.slice(0, n)) v[i] = base * factor;
}

async function main() {
  const real = JSON.parse(await readFile(resolve(PUBLIC, 'quality_data.json'), 'utf8')) as QualityData;
  const caches: Record<string, string | null> = {};
  for (const n of CACHE_NAMES) caches[n] = JSON.parse(await readFile(resolve(PUBLIC, `${n}_cache.json`), 'utf8')).generatedAt;
  const now = Date.parse(real.generatedAt) + 2 * 3600000; // 생성 2시간 뒤 판정 가정
  const run = (d: QualityData, prev: AlertState = emptyState(), t = now, c = caches) => evaluate({ data: d, cacheGeneratedAt: c, now: t, prev });

  console.log('\n[1] 실데이터 기준 — 발동 0건이어야 함');
  const base = run(real);
  ok(base.events.length === 0, `이벤트 ${base.events.length}건 ${base.events.map((e) => e.key).join(',')}`);

  console.log('\n[2] 트리거별 합성 발동');
  const cases: { key: string; mutate: (d: QualityData) => void }[] = [
    { key: 'A1:kt:rise', mutate: (d) => patchTail(d, 'kt', 'ipv6', 3, () => 5) },
    { key: 'A1:skb:rise', mutate: (d) => patchTail(d, 'skb', 'ipv6', 3, () => 1.0) },
    { key: 'A2:lgu:rise', mutate: (d) => patchTail(d, 'lgu', 'ipv6', 3, () => 35) },
    { key: 'A2:lgu:drop', mutate: (d) => patchTail(d, 'lgu', 'ipv6', 7, () => 8) },
    { key: 'A3:kt:rise', mutate: (d) => patchTail(d, 'kt', 'dnssec', 3, () => 12) },
    { key: 'A3:lgu:rise', mutate: (d) => patchTail(d, 'lgu', 'dnssec', 3, () => 10) },
    { key: 'A4:skb:drop', mutate: (d) => patchTail(d, 'skb', 'dnssec', 7, () => 20) },
    { key: 'A5:lgu:rise', mutate: (d) => { const b = median(d.series.lgu.rpkiValid.coarse[0].filter((x): x is number => x != null).slice(-31, -3)); patchTail(d, 'lgu', 'rpkiValid', 3, () => b + 12); } },
    { key: 'A6:kt:loss', mutate: (d) => patchTail(d, 'kt', 'packetLoss', 2, () => 0.4) },
    { key: 'S1:kt:drop', mutate: (d) => patchTailVsBase(d, 'kt', 'downloadBandwidth', 3, 0.85) },
    { key: 'S2:skb:drop', mutate: (d) => patchTailVsBase(d, 'skb', 'uploadBandwidth', 3, 0.85) },
    { key: 'S3:lgu:drop', mutate: (d) => patchTailVsBase(d, 'lgu', 'niaDl1g', 3, 0.85) },
    { key: 'S4:kt:drop', mutate: (d) => patchTailVsBase(d, 'kt', 'niaUl1g', 3, 0.85) },
  ];
  for (const c of cases) {
    const d = clone(real); c.mutate(d);
    const r = run(d);
    const keys = r.events.map((e) => e.key);
    ok(keys.includes(c.key) && r.events.length === 1, `${c.key} → ${keys.join(',') || '없음'}`);
  }

  console.log('\n[3] 경계·게이트');
  { const d = clone(real); patchTail(d, 'kt', 'ipv6', 2, () => 5); ok(run(d).events.length === 0, 'A1 2일만 충족 → 미발동 (3일 연속 필요)'); }
  { const d = clone(real); patchTail(d, 'kt', 'packetLoss', 1, () => 0.4); ok(run(d).events.length === 0, 'A6 1일 튐 → 미발동'); }
  { const d = clone(real); patchTail(d, 'kt', 'ipv6', 3, () => 0.9); ok(run(d).events.length === 0, 'A1 0.9% → 미발동 (임계 1.0)'); }
  { // A3 표본 게이트: 값은 넘지만 마지막 날 k가 급감 → 그날 제외돼 2일만 남아 미발동
    const d = clone(real); patchTail(d, 'kt', 'dnssec', 3, () => 12);
    const kArr = d.series.kt.dnssec.coarse[2]; for (let i = kArr.length - 1; i >= 0; i--) if (kArr[i] != null) { kArr[i] = 10; break; }
    ok(run(d).events.length === 0, 'A3 저표본일 제외 → 미발동');
  }
  { const d = clone(real); patchTail(d, 'lgu', 'ipv6', 7, () => 12); ok(run(d).events.length === 0, 'A2 하락 12% → 미발동 (임계 10)'); }
  { const d = clone(real); patchTailVsBase(d, 'kt', 'downloadBandwidth', 3, 0.93); ok(run(d).events.length === 0, 'S1 -7% → 미발동 (임계 -10%)'); }
  { const d = clone(real); patchTailVsBase(d, 'kt', 'downloadBandwidth', 2, 0.8); ok(run(d).events.length === 0, 'S1 -20% 2일만 → 미발동 (3일 연속 필요)'); }
  { const d = clone(real); patchTailVsBase(d, 'kt', 'niaUl1g', 3, 0.85); ok(run(d).events.length === 1, 'S4 상승 추세 지표도 기준선 대비 -15%면 발동'); }

  console.log('\n[4] 1회 발송 원칙 + 해소');
  { const d = clone(real); patchTail(d, 'kt', 'ipv6', 3, () => 5);
    const r1 = run(d); const r2 = run(d, r1.state);
    ok(r1.events.length === 1 && r2.events.length === 0, `첫 판정 ${r1.events.length}건 → 같은 상태 재판정 ${r2.events.length}건`);
    ok(Object.keys(r2.state.active).length === 1, `활성 알림 유지 ${Object.keys(r2.state.active).join(',')}`);
    // 해소: 값이 정상으로 돌아와 7일 → clear 1건
    const d2 = clone(real); // 원본(0.0X%)이 곧 '정상 7일'
    const r3 = run(d2, r2.state);
    ok(r3.events.length === 1 && r3.events[0].type === 'clear' && !r3.state.active['A1:kt:rise'], `정상 복귀 → ${r3.events.map((e) => `${e.type}:${e.key}`).join(',')}`);
    const d3 = clone(real); patchTail(d3, 'kt', 'ipv6', 3, () => 0.1); // 마지막 3일만 정상, 그 앞은 원본(정상) → 7일 미충족이므로 해소
    ok(run(d3, r2.state).events.length === 1, '정상 7일 연속이면 해소');
    const d4 = clone(real); patchTail(d4, 'kt', 'ipv6', 7, (_, i) => (i % 2 ? 5 : 0.1)); // 7일 중 일부만 충족 → 발동도 해소도 아님
    ok(run(d4, r2.state).events.length === 0, '7일 중 일부만 충족 → 활성 유지(이벤트 없음)');
  }

  console.log('\n[5] D 그룹');
  { const r = run(real, emptyState(), Date.parse(real.generatedAt) + 25 * 3600000); ok(r.events.some((e) => e.key === 'D1-a:quality_data'), `25h 미갱신 → ${r.events.map((e) => e.key).join(',')}`); }
  { const r = run(real, emptyState(), Date.parse(real.generatedAt) + 20 * 3600000); ok(!r.events.some((e) => e.key.startsWith('D1-a')), '20h → D1-a 미발동'); }
  { const c = { ...caches, steam: new Date(now - 80 * 3600000).toISOString() }; const r = run(real, emptyState(), now, c); ok(r.events.length === 1 && r.events[0].key === 'D1-b:steam', `steam 80h → ${r.events.map((e) => e.key).join(',')}`); }
  { const c = { ...caches, nia: null }; const r = run(real, emptyState(), now, c); ok(r.events.some((e) => e.key === 'D1-b:nia'), 'nia 캐시 없음 → D1-b:nia'); }
  { // D2: steam 그룹 전 사업자 마지막 3일을 4일 전 값으로 고정
    const d = clone(real);
    for (const isp of d.isps) { const v = d.series[isp]?.steamDownload?.coarse?.[0]; if (!v) continue; const idx: number[] = []; for (let i = v.length - 1; i >= 0 && idx.length < 4; i--) if (v[i] != null) idx.push(i); if (idx.length === 4) for (const i of idx.slice(0, 3)) v[i] = v[idx[3]]; }
    const r = run(d); ok(r.events.length === 1 && r.events[0].key === 'D2:steam', `steam 3일 동일 → ${r.events.map((e) => e.key).join(',')}`);
    const r2 = run(real, r.state); ok(r2.events.some((e) => e.type === 'clear' && e.key === 'D2:steam'), '변동 재개 → 즉시 해소');
  }
  { // D1-a 해소는 즉시
    const r1 = run(real, emptyState(), Date.parse(real.generatedAt) + 25 * 3600000);
    const r2 = run(real, r1.state, Date.parse(real.generatedAt) + 26 * 3600000, caches); // 여전히 오래됨 → 이벤트 없음
    const fresh = clone(real); fresh.generatedAt = new Date(Date.parse(real.generatedAt) + 26 * 3600000).toISOString();
    const r3 = run(fresh, r1.state, Date.parse(real.generatedAt) + 26 * 3600000, caches);
    ok(r2.events.length === 0 && r3.events.length === 1 && r3.events[0].type === 'clear', `D1-a 유지 ${r2.events.length}건 · 갱신 후 ${r3.events.map((e) => e.type).join(',')}`);
  }

  console.log('\n[6] 보고서·메일 렌더링');
  { const html = buildMailHtml(base, real, caches, now, { runUrl: 'https://example/run/1' });
    ok(html.includes('국내 3사 대표 지표 순위') && html.includes('A1') && html.includes('D2') && html.includes('이상 없음') && html.includes('example/run/1'), 'HTML 메일: 순위·판정 현황·상태·링크 포함');
    ok(!html.includes('<style') && !/display:\s*(flex|grid)/.test(html), 'HTML 메일: <style>·flex·grid 미사용(메일 클라이언트 호환)');
    const md = buildReport(base, real, caches, now); ok(md.includes('| 지표 | 1위 |') && md.includes('A1:kt:rise 최근값'), 'markdown 보고서: 표·판정 상세 포함'); }
  { const d = clone(real); patchTail(d, 'kt', 'ipv6', 3, () => 5); const rr = run(d);
    const html = buildMailHtml(rr, d, caches, now, { test: true });
    ok(html.includes('신규 발동') && html.includes('A1:kt:rise') && html.includes('테스트 발송') && html.includes('발동 중'), 'HTML 메일: 발동 카드·활성 상태·테스트 표기'); }

  console.log('\n[7] 주간 요약 (지난주 월~일 창)');
  { // 2026-09-09(수) 09:00 KST → 지난주 = 8/31(월)~9/6(일)
    const w = prevWeekWindow(Date.UTC(2026, 8, 9, 0, 0)); // 00:00Z = 09:00 KST
    ok(w.label === '8/31(월)~9/6(일)' && new Date(w.from).toISOString().slice(0, 10) === '2026-08-31' && new Date(w.to).toISOString().slice(0, 10) === '2026-09-07', `창 ${w.label} (${new Date(w.from).toISOString().slice(0, 10)}~)`);
    const mon = prevWeekWindow(Date.UTC(2026, 8, 6, 22, 0)); // 9/6(일) 22:00Z = 9/7(월) 07:00 KST → 월요일 아침 실행
    ok(mon.label === '8/31(월)~9/6(일)', `월요일 아침 실행도 같은 창: ${mon.label}`);
    const sun = prevWeekWindow(Date.UTC(2026, 8, 6, 12, 0)); // 9/6(일) 21:00 KST → 아직 그 전주
    ok(sun.label === '8/24(월)~8/30(일)', `일요일 밤은 전주 창: ${sun.label}`);
    const dg = digestData(real, caches, now, w);
    const dl = dg.ranks.find((m) => m.id === 'downloadBandwidth')!;
    // 수동 계산과 대조: kt 다운로드의 8/31~9/6 평균
    const axis = real.tiers.coarse.t, v = real.series.kt.downloadBandwidth.coarse[0]; let s = 0, n = 0;
    for (let i = 0; i < axis.length; i++) if (v[i] != null && axis[i] >= w.from && axis[i] < w.to) { s += v[i] as number; n++; }
    const kt = dl.cells.find((c) => c.isp === 'kt')!;
    ok(n === 7 && Math.abs((kt.v ?? 0) - s / n) < 1e-9, `kt 다운로드 지난주 평균 ${kt.v?.toFixed(1)} (버킷 ${n}개) = 수동 계산`);
    ok(dl.cells.every((c) => c.rank != null && c.delta != null) && new Set(dl.cells.map((c) => c.rank)).size === 3, `순위 1~3 부여 · 전전주 대비 Δ 계산: ${dl.cells.map((c) => `${c.isp}=${c.rank}위 ${c.delta!.toFixed(1)}%`).join(' ')}`);
    const html = buildMailHtml(base, real, caches, now, { week: w });
    ok(html.includes('주간 요약 — 지난주 8/31(월)~9/6(일)') && html.includes('지난주 이벤트') && /[▲▼]|보합/.test(html), 'HTML 주간 요약: 제목·지난주 이벤트·Δ 표시');
    const md = buildReport(base, real, caches, now, w);
    ok(md.startsWith('# 주간 요약 (8/31(월)~9/6(일))') && md.includes('지난주 이벤트 0건'), 'markdown 주간 요약 제목·이벤트 수'); }

  console.log('\n[8] 주간 추이 차트 (SVG → PNG)');
  { const w = prevWeekWindow(Date.UTC(2026, 8, 9, 0, 0));
    const ser = extractSeries(real, 'downloadBandwidth', w.from);
    ok(ser.length === 3 && ser.every((s) => s.weeks.length === 3 && s.weeks.every((wk) => wk.length === 7)), '시리즈: 3사 × 3주 × 7일');
    const ktLastWeek = ser.find((s) => s.isp === 'kt')!.weeks[0];
    ok(ktLastWeek.filter((x) => x != null).length === 7 && ktLastWeek[0] === real.series.kt.downloadBandwidth.coarse[0][real.tiers.coarse.t.indexOf(w.from)], 'kt 지난주 월요일 값 = coarse 버킷 값');
    const svg = weeklyChartSvg(ser, ['8/31', '9/1', '9/2', '9/3', '9/4', '9/5', '9/6'], 'Mbps');
    ok(svg.startsWith('<svg') && (svg.match(/<path /g) ?? []).length === 9 && (svg.match(/<circle /g) ?? []).length === 21, `SVG: 선 9개(3사×3주) · 지난주 점 21개 (${(svg.match(/<path /g) ?? []).length}/${(svg.match(/<circle /g) ?? []).length})`);
    // 결측이 있으면 선이 끊긴다(M 명령이 늘어남)
    const gap = clone(ser); gap[0].weeks[0][3] = null;
    ok((weeklyChartSvg(gap, ['a', 'b', 'c', 'd', 'e', 'f', 'g'], '').match(/M[\d.]+ [\d.]+/g) ?? []).length === 10, '결측일은 선을 끊음');
    const png = svgToPng(svg);
    ok(png.length > 2000 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, `PNG 변환 ${(png.length / 1024).toFixed(0)}KB, 시그니처 정상`);
    const dir = resolve(tmpdir(), `ispq-charts-${Date.now()}`);
    const charts = await renderWeeklyCharts(real, w.from, [{ id: 'latency', short: 'RTT', unit: 'ms' }, { id: 'ipv6', short: 'IPv6', unit: '%' }], dir);
    ok(charts.length === 2 && charts.every((c) => c.bytes > 1000 && c.file.startsWith('weekly-')), `renderWeeklyCharts: ${charts.map((c) => `${c.file} ${(c.bytes / 1024).toFixed(0)}KB`).join(', ')}`);
    const html = buildMailHtml(base, real, caches, now, { week: w, charts, chartBase: 'https://x/y' });
    ok(html.includes('지난주 일별 추이') && html.includes('https://x/y/weekly-latency.png') && html.includes('<img '), 'HTML 주간 메일: 추이 섹션 + 차트 URL'); }

  console.log('\n[9] 정의 무결성');
  ok(TRIGGERS.every((t) => t.isps.every((i) => real.series[i]?.[t.metric])), '트리거의 모든 (isp, metric)이 데이터에 존재');
  ok(KR3.every((i) => real.series[i]), 'KR3 존재');
  ok(new Set(TRIGGERS.flatMap((t) => t.rules.map((r) => `${t.id}:${r.key}`))).size === TRIGGERS.reduce((n, t) => n + t.rules.length, 0), '규칙 키 중복 없음');

  console.log(`\n${failures ? `실패 ${failures}건` : '전부 통과'}`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
