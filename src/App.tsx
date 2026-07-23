import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyTheme, loadTheme } from './theme.ts';
import { useQualityData } from './data/quality.ts';
import { METRICS, METRIC_BY_ID, DEFAULT_METRIC, SOURCES } from './data/metrics.ts';
import { ALL_ISPS, NIA_ISPS } from './data/isps.ts';
import {
  RANGES, VIEWS, TIER_VIEWS, T,
  type RangeKey, type ViewKey,
} from './config.ts';
import { loadSettings } from './lib/settings.ts';
import { captureElement, timestampName } from './lib/screenshot.ts';
import IspMultiSelect from './components/IspMultiSelect.tsx';
import MetricSection from './components/MetricSection.tsx';
import SummaryPanel from './components/SummaryPanel.tsx';

// 선언 순서 기반 ISP 색상 인덱스.
const COLOR_INDEX: Record<string, number> = Object.fromEntries(ALL_ISPS.map((i, idx) => [i.id, idx]));

// 기본 출처 = 기본 지표가 속한 출처.
const DEFAULT_SOURCE = METRIC_BY_ID[DEFAULT_METRIC].source;
// 초기화 기본값.
const DEFAULT_RANGE: RangeKey = '7d';
const DEFAULT_VIEW: ViewKey = '1hour';

export default function App() {
  const [theme, setTheme] = useState(loadTheme);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(ALL_ISPS.filter((i) => i.pinned && !i.hidden).map((i) => i.id))
  );
  // NIA 탭 전용 선택(케이블사 포함, 기본 전체 선택) — 전역 선택과 분리해 다른 탭에 영향 없음.
  const [selectedNia, setSelectedNia] = useState<Set<string>>(() => new Set(NIA_ISPS.map((i) => i.id)));
  const [sourceId, setSourceId] = useState<string>(DEFAULT_SOURCE);
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
  const [view, setView] = useState<ViewKey>(DEFAULT_VIEW);
  const [chartResetKey, setChartResetKey] = useState(0);
  const [ispPanelOpen, setIspPanelOpen] = useState(true);
  // 데이터 소스 URL은 고정(설정 모달은 2026-07-21 제거) — 저장된 값이 있으면 그대로 사용.
  const [settings] = useState(loadSettings);
  const [capturing, setCapturing] = useState(false);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const appRef = useRef<HTMLDivElement>(null);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const { data, loading, error } = useQualityData(settings.dataUrl);
  const colorIndex = useCallback((ispId: string) => COLOR_INDEX[ispId] ?? 0, []);

  // 처음 켰을 때 상태로 복원: 기간 7일·집계 1시간 + 모든 차트 줌 해제(리마운트).
  const handleReset = () => {
    setRange(DEFAULT_RANGE);
    setView(DEFAULT_VIEW);
    setChartResetKey((k) => k + 1);
  };

  const handleScreenshot = async () => {
    if (!appRef.current) return;
    setCapturing(true);
    try {
      await captureElement(appRef.current, timestampName('broadband_dashboard'));
    } finally {
      setCapturing(false);
    }
  };

  // 요약 패널 셀 클릭 → 그 지표의 출처로 전환 + 해당 차트 섹션으로 스크롤.
  // 출처 전환으로 섹션이 새로 마운트된 뒤에 스크롤해야 하므로 effect에서 처리.
  const handleJump = useCallback((metricId: string) => {
    setSourceId(METRIC_BY_ID[metricId].source);
    setJumpTarget(metricId);
  }, []);
  useEffect(() => {
    if (!jumpTarget) return;
    // 차트 마운트로 레이아웃이 밀리며 smooth 스크롤이 취소될 수 있어, 즉시 이동 후 한 번 더 보정.
    const go = () => document.getElementById(`metric-${jumpTarget}`)?.scrollIntoView({ block: 'start' });
    go();
    const t = setTimeout(() => { go(); setJumpTarget(null); }, 250);
    return () => clearTimeout(t);
  }, [jumpTarget, sourceId]);

  const sourceMetrics = useMemo(() => METRICS.filter((m) => m.source === sourceId), [sourceId]);
  // 출처의 모든 지표가 일별 집계(dailyCadence)면 집계단위를 1일로 고정 — 기간을 어떻게 바꿔도 1일만 표시.
  const dailySource = sourceMetrics.length > 0 && sourceMetrics.every((m) => m.dailyCadence);

  const tier = RANGES[range].tier;
  const allowedViews = useMemo<ViewKey[]>(
    () => (dailySource ? ['1day'] : TIER_VIEWS[tier]),
    [dailySource, tier],
  );

  // 범위 변경 시 허용되지 않는 버킷이면 티어 기본으로 보정.
  useEffect(() => {
    if (!allowedViews.includes(view)) setView(allowedViews[0]);
  }, [allowedViews, view]);

  // 데이터의 최신 버킷을 기준으로 시간창 고정.
  const sinceMs = useMemo(() => {
    let latest = 0;
    const axis = data?.tiers[tier]?.t;
    if (axis && axis.length) latest = axis[axis.length - 1];
    const end = latest || Date.now();
    return end - RANGES[range].ms;
  }, [data, tier, range]);

  const niaTab = sourceId === 'nia';
  const selectedList = useMemo(
    () => (niaTab ? [...selectedNia] : [...selected]),
    [niaTab, selected, selectedNia],
  );
  const mode = data?.mode;
  const effectiveView: ViewKey = allowedViews.includes(view) ? view : allowedViews[0];

  return (
    <div className="app" ref={appRef}>
      <header className="toolbar">
        <h1>📡 {T.appTitle}</h1>
        <div className="spacer" />

        <label className="field">{T.source}
          <select value={sourceId} onChange={(e) => {
            const s = e.target.value;
            setSourceId(s);
            // Speed Test·NIA는 하루 1회 집계 → 집계 1일로 자동 맞춤(집계단위는 이후에도 1일 고정).
            // 기간 기본값: Speed Test 90일 · NIA 30일(2026-07-16 사용자 지정) — 이후 기간은 자유 변경 가능.
            if (s === 'cfspeed') { setRange('90d'); setView('1day'); }
            if (s === 'nia') { setRange('30d'); setView('1day'); }
          }}>
            {Object.values(SOURCES).map((src) => (
              <option key={src.id} value={src.id}>{src.label}</option>
            ))}
          </select>
        </label>

        <label className="field">{T.range}
          <select value={range} onChange={(e) => setRange(e.target.value as RangeKey)}>
            {Object.entries(RANGES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>

        <label className="field">{T.bucket}
          <select value={effectiveView} onChange={(e) => setView(e.target.value as ViewKey)}>
            {allowedViews.map((k) => <option key={k} value={k}>{VIEWS[k].label}</option>)}
          </select>
        </label>

        <button onClick={handleReset}>↺ {T.resetButton}</button>

        <button data-screenshot-ignore onClick={handleScreenshot} disabled={capturing}>
          📷 {capturing ? T.screenshotCapturing : T.screenshotButton}
        </button>

        <button className="theme-toggle" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>
          {theme === 'dark' ? `🌙 ${T.themeDark}` : `☀️ ${T.themeLight}`}
        </button>
      </header>

      <div className={`content${ispPanelOpen ? '' : ' isp-collapsed'}`}>
        <aside className="panel">
          <h2 className="collapsible" onClick={() => setIspPanelOpen((o) => !o)}>
            <span className="caret">{ispPanelOpen ? '▾' : '▸'}</span>
            {T.ispPanelTitle}
          </h2>
          {ispPanelOpen && (
            <>
              <IspMultiSelect
                selected={niaTab ? selectedNia : selected}
                onChange={niaTab ? setSelectedNia : setSelected}
                colorIndex={colorIndex}
                niaMode={niaTab}
              />
              <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 12 }}>{T.ispHelp}</p>
              {data && (
                <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                  {T.dataGenerated}: {new Date(data.generatedAt).toLocaleString('ko-KR')}<br />
                  {T.grid}: {data.tiers[tier].baseMin}분 · {T.retention}: 365일
                </p>
              )}
              {mode === 'live' && (
                <div className="delay-note">
                  <div className="delay-title">{T.delayTitle}</div>
                  <div className="delay-body">{T.delayBody}</div>
                </div>
              )}
            </>
          )}
        </aside>

        <main className="charts">
          {error ? (
            <section className="panel">
              <div className="empty">
                {T.loadError} ({error}).<br />
                <code>{T.runMock}</code>
              </div>
            </section>
          ) : loading || !data ? (
            <section className="panel"><div className="empty">{T.loading}</div></section>
          ) : (
            <>
            <SummaryPanel data={data} onJump={handleJump} />
            {/* 쌍둥이 패널: 사용자가 취합 기간(일)을 직접 지정 (표시 방식은 위와 동일) */}
            <SummaryPanel data={data} onJump={handleJump} adjustable defaultDays={30} />
            {sourceMetrics.map((m) => (
              <MetricSection
                key={`${m.id}-${chartResetKey}`}
                metricId={m.id}
                data={data}
                selectedIsps={selectedList}
                view={effectiveView}
                range={range}
                sinceMs={sinceMs}
                theme={theme}
                colorIndex={colorIndex}
              />
            ))}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
