import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyTheme, loadTheme } from './theme.ts';
import { useQualityData } from './data/quality.ts';
import { METRICS, METRIC_BY_ID, DEFAULT_METRIC, SOURCES } from './data/metrics.ts';
import { ALL_ISPS } from './data/isps.ts';
import {
  RANGES, VIEWS, TIER_VIEWS, T,
  type RangeKey, type ViewKey,
} from './config.ts';
import { loadSettings, saveSettings, type ApiSettings as ApiSettingsType } from './lib/settings.ts';
import { captureElement, timestampName } from './lib/screenshot.ts';
import IspMultiSelect from './components/IspMultiSelect.tsx';
import MetricSection from './components/MetricSection.tsx';
import SnapshotTable from './components/SnapshotTable.tsx';
import ApiSettings from './components/ApiSettings.tsx';

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
    () => new Set(ALL_ISPS.filter((i) => i.pinned).map((i) => i.id))
  );
  const [sourceId, setSourceId] = useState<string>(DEFAULT_SOURCE);
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
  const [view, setView] = useState<ViewKey>(DEFAULT_VIEW);
  const [chartResetKey, setChartResetKey] = useState(0);
  const [ispPanelOpen, setIspPanelOpen] = useState(true);
  const [settings, setSettings] = useState<ApiSettingsType>(loadSettings);
  const [showApi, setShowApi] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const appRef = useRef<HTMLDivElement>(null);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const { data, loading, error } = useQualityData(settings.dataUrl);
  const colorIndex = useCallback((ispId: string) => COLOR_INDEX[ispId] ?? 0, []);

  const handleSaveApi = (s: ApiSettingsType) => { setSettings(s); saveSettings(s); setShowApi(false); };

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

  const tier = RANGES[range].tier;
  const allowedViews = TIER_VIEWS[tier];

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

  const selectedList = useMemo(() => [...selected], [selected]);
  const sourceMetrics = useMemo(() => METRICS.filter((m) => m.source === sourceId), [sourceId]);
  const mode = data?.mode;
  const effectiveView: ViewKey = allowedViews.includes(view) ? view : allowedViews[0];

  return (
    <div className="app" ref={appRef}>
      <header className="toolbar">
        <h1>📡 {T.appTitle}</h1>
        {mode && <span className={`mode-badge ${mode}`}>{mode === 'sim' ? T.modeSim : T.liveMixed}</span>}
        <div className="spacer" />

        <label className="field">{T.source}
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
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

        <button onClick={() => setShowApi(true)}>⚙ {T.apiButton}</button>

        <button data-screenshot-ignore onClick={handleScreenshot} disabled={capturing}>
          📷 {capturing ? T.screenshotCapturing : T.screenshotButton}
        </button>

        <button className="theme-toggle" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>
          {theme === 'dark' ? `🌙 ${T.themeDark}` : `☀️ ${T.themeLight}`}
        </button>
      </header>

      {showApi && (
        <ApiSettings settings={settings} onSave={handleSaveApi} onClose={() => setShowApi(false)} />
      )}

      <div className={`content${ispPanelOpen ? '' : ' isp-collapsed'}`}>
        <aside className="panel">
          <h2 className="collapsible" onClick={() => setIspPanelOpen((o) => !o)}>
            <span className="caret">{ispPanelOpen ? '▾' : '▸'}</span>
            {T.ispPanelTitle}
          </h2>
          {ispPanelOpen && (
            <>
              <IspMultiSelect selected={selected} onChange={setSelected} colorIndex={colorIndex} />
              <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 12 }}>{T.ispHelp}</p>
              {data && (
                <p style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                  {T.dataGenerated}: {new Date(data.generatedAt).toLocaleString('ko-KR')}<br />
                  {T.grid}: {data.tiers[tier].baseMin}분 · {T.retention}: 365일
                </p>
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
              <SnapshotTable
                sourceId={sourceId}
                data={data}
                selectedIsps={selectedList}
                colorIndex={colorIndex}
              />
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
