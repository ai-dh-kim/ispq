// 추이 공지의 'ⓘ 자세히' 팝오버 — 1일 값과 N일 이동 중앙값의 차이 설명(2026-11-17 사용자 요청).
// 지표 제목 옆 ⓘ와 같은 팝오버 방식(.cite-info/.cite-pop): 마우스를 올리거나(데스크톱) 탭하면(모바일, focus) 뜬다.
// 예시 표는 계산 규칙을 보여 주는 고정 예시(7일)이고, 본문의 일수·반응 지연은 선택한 추이(7·28일)를 따른다.

import type { ReactNode } from 'react';

const EX = [320, 410, 290, 350, 600, 330, 340];
const EX_DATES = ['11/2', '11/3', '11/4', '11/5', '11/6', '11/7', '11/8'];
const EX_SORTED = [...EX].sort((a, b) => a - b);
const EX_MEDIAN = EX_SORTED[3];
const EX_MEAN = Math.round(EX.reduce((s, x) => s + x, 0) / EX.length);

export default function TrendHelp({ days }: { days: number }) {
  return (
    <span className="cite-info trend-help" tabIndex={0} aria-label="1일 값과 추이의 차이">
      ⓘ 자세히
      <span className="cite-pop trend-pop">
        <span className="tp-h">1일 값과 {days}일 이동 중앙값의 차이</span>

        <span className="tp-row"><b>1일 값 — 옅은 가는 선</b><br />
          그 날짜 하루 동안 들어온 측정값들의 중앙값입니다. 측정한 사람·기기·가입 상품·시간대가 날마다 달라
          하루 사이에도 크게 출렁입니다.</span>

        <span className="tp-row"><b>{days}일 이동 중앙값 — 진한 굵은 선</b><br />
          그 날짜를 포함한 직전 {days}일의 1일 값을 크기순으로 세웠을 때 가운데 값입니다.
          날짜가 하루 지날 때마다 창도 하루씩 옮겨 가며 다시 계산합니다.</span>

        <span className="tp-row"><b>예시 (7일, 단위 Mbps)</b></span>
        <table className="tp-table">
          <tbody>
            <tr>{EX_DATES.map((d) => <th key={d}>{d}</th>)}</tr>
            <tr>{EX.map((v, i) => <td key={i} className={v === 600 ? 'tp-spike' : ''}>{v}</td>)}</tr>
          </tbody>
        </table>
        <span className="tp-row">
          크기순: {EX_SORTED.map((v, i) => (i === 3 ? <b key={i}>{v}</b> : <span key={i}>{v}</span>))
            .reduce<ReactNode[]>((a, el, i) => (i ? [...a, ', ', el] : [el]), [])}
          {' '}→ 11/8의 7일 추이 = <b>{EX_MEDIAN}</b><br />
          11/6에 하루 튄 600은 추이에 영향을 주지 않습니다(평균이었다면 {EX_MEAN}으로 끌려 올라감).
          그래서 평균이 아니라 중앙값을 씁니다.
        </span>

        <span className="tp-row"><b>언제 어느 것을 보나</b><br />
          · 1일 값: 특정 날짜의 장애·급변 확인<br />
          · 추이: 지속적인 개선·악화, ISP 간 순위 비교<br />
          · 추이는 반응이 늦습니다 — 실제 변화가 생기면 약 {Math.ceil(days / 2)}일({days}일 중 절반 이상) 지나야 선이 따라 움직입니다.</span>

        <span className="tp-row"><b>알아 두실 점</b><br />
          · 추이는 화면 표시만 바꿉니다. 데이터·이상 알림·종합지표 순위는 모두 1일 값으로 계산합니다.<br />
          · 그날 1일 값이 없거나, {days}일 중 값이 있는 날이 절반 미만이면 추이도 빈칸입니다.<br />
          · 1일 값 자체가 누적인 지표(해외 Speed Test·NIA·Steam·Netflix, ⓘ 설명에 표시)는 원래 부드러워 추이와 차이가 작습니다.<br />
          · 그래프에 마우스를 올리면 툴팁에 추이 값과 &lsquo;그날 하루 값 · 측정 N건&rsquo;이 함께 나옵니다.</span>
      </span>
    </span>
  );
}
