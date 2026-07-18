// [임시] NIA 통계 갱신 시각 프로브 (2026-07-18 ~ 약 48시간).
// 매시간 사업자별 값을 찍어 nia-probe 브랜치의 probe/nia_probe.jsonl 에 누적 —
// 값이 바뀌는 시각으로 NIA 배치 실행 시각(= 집계 창의 대략적 컷오프)을 실증한다.
// 72시간 경과 시 자동으로 수집을 멈춘다(워크플로를 지우는 걸 잊어도 무한 실행 방지).
// 분석이 끝나면 이 파일·probe-nia.yml·nia-probe 브랜치를 삭제할 것.
//
// 실행: node scripts/probe-nia.ts  (probe/nia_probe.jsonl 에 1줄 append)

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { rootCertificates } from 'node:tls';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, '../probe/nia_probe.jsonl');
const STOP_AFTER_H = 72;

const API = 'https://speed.nia.or.kr/statistics/statistic_isp.asp';
const API_KR = 'https://speed.nia.or.kr/statistics/statistic_kr.asp';
const REFERER = 'https://speed.nia.or.kr/statistics/statistic.asp';
const CA = [...rootCertificates, readFileSync(resolve(__dir, 'nia-ca-chain.pem'), 'utf8')];
const COMPANY: Record<number, string> = { 1: 'kt', 2: 'skb', 3: 'lgu', 4: 'dlive', 5: 'lghv', 7: 'hcn', 8: 'etc', 9: 'cmb' };

function httpsPost(url: string, body: string): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const u = new URL(url);
    const req = request({
      hostname: u.hostname, path: u.pathname, method: 'POST', ca: CA, timeout: 30000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Referer: REFERER },
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

async function isps(params: string): Promise<Record<string, number>> {
  const rows = JSON.parse(await httpsPost(API, params));
  const out: Record<string, number> = {};
  for (const r of rows) { const k = COMPANY[Number(r.company_id)]; if (k && Number.isFinite(r.AVG)) out[k] = r.AVG; }
  return out;
}

async function main() {
  // 자동 종료: 첫 기록으로부터 STOP_AFTER_H 시간이 지나면 더 수집하지 않는다.
  try {
    const first = (await readFile(OUT, 'utf8')).split('\n')[0];
    const t0 = Date.parse(JSON.parse(first).t);
    if (Number.isFinite(t0) && Date.now() - t0 > STOP_AFTER_H * 3600_000) {
      console.log(`[probe] 첫 기록 후 ${STOP_AFTER_H}시간 경과 — 자동 종료(append 안 함)`);
      return;
    }
  } catch { /* 파일 없으면 첫 실행 */ }

  const line = {
    t: new Date().toISOString(),
    d1g: await isps('service_type=2&service_type_sub=2&Period=3&direct=1'),
    u1g: await isps('service_type=2&service_type_sub=2&Period=3&direct=2'),
    d100: await isps('service_type=1&service_type_sub=1&Period=3&direct=1'),
    kr1g: JSON.parse(await httpsPost(API_KR, 'service_type=2&service_type_sub=2&Period=3&direct=1'))[0]?.KR_AVG ?? null,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await appendFile(OUT, JSON.stringify(line) + '\n');
  console.log('[probe] appended:', line.t, 'kt_d1g=' + line.d1g.kt, 'kr1g=' + line.kr1g);
}

main().catch((err) => { console.error('[probe] fatal:', err); process.exit(1); });
