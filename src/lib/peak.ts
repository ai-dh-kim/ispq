// 피크타임 성능 저하 분석 (PRD §4 FR-04).
// 혼잡 시간(21:00–23:00) vs 한산 시간(02:00–05:00) 대비.

export const BUSY_HOURS = [21, 22, 23];
export const QUIET_HOURS = [2, 3, 4, 5];

const hourOf = (ts: number) => new Date(ts).getUTCHours();

function avg(points: { mean: number | null }[]): number | null {
  const vals = points.map((p) => p.mean).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

export interface PeakResult {
  busyAvg: number | null;
  quietAvg: number | null;
  defenseRate: number | null; // 처리량 방어율 % (higherIsBetter 지표)
  spikeRate: number | null; // 악화율 % (항상 "얼마나 나빠졌나")
  busyN: number;
  quietN: number;
}

export function peakAnalysis(
  points: { t: number; mean: number | null }[],
  higherIsBetter: boolean
): PeakResult {
  const busy = points.filter((p) => BUSY_HOURS.includes(hourOf(p.t)));
  const quiet = points.filter((p) => QUIET_HOURS.includes(hourOf(p.t)));
  const busyAvg = avg(busy);
  const quietAvg = avg(quiet);

  if (busyAvg == null || quietAvg == null || quietAvg === 0) {
    return { busyAvg, quietAvg, defenseRate: null, spikeRate: null, busyN: busy.length, quietN: quiet.length };
  }

  // 처리량 방어율(%): 한산 대비 피크에 유지되는 성능. 100% = 저하 없음.
  const defenseRate = higherIsBetter ? (busyAvg / quietAvg) * 100 : null;

  // 악화율(%): 피크에 얼마나 나빠지는가. 지연계열=증가율, 처리량계열=하락률.
  const spikeRate = higherIsBetter
    ? ((quietAvg - busyAvg) / quietAvg) * 100
    : ((busyAvg - quietAvg) / quietAvg) * 100;

  return { busyAvg, quietAvg, defenseRate, spikeRate, busyN: busy.length, quietN: quiet.length };
}
