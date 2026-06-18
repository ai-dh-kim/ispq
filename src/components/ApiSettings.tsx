// 데이터 소스 / 제공자 API 설정 모달.
// 데이터 소스 URL 은 실제로 페치 대상을 바꾼다(라이브 백엔드 연동 지점).
// 제공자 토큰은 프로토타입 편의용으로 localStorage 에 보관된다(보안 주의 표기).

import { useState } from 'react';
import { SOURCES } from '../data/metrics.ts';
import { T } from '../config.ts';
import { DEFAULT_SETTINGS, type ApiSettings, type ProviderId } from '../lib/settings.ts';

interface Props {
  settings: ApiSettings;
  onSave: (s: ApiSettings) => void;
  onClose: () => void;
}

const PROVIDER_IDS: ProviderId[] = ['cloudflare', 'mlab', 'ripe'];

export default function ApiSettings({ settings, onSave, onClose }: Props) {
  const [form, setForm] = useState<ApiSettings>(() => structuredClone(settings));

  const setProvider = (id: ProviderId, patch: Partial<ApiSettings['providers'][ProviderId]>) =>
    setForm((f) => ({ ...f, providers: { ...f.providers, [id]: { ...f.providers[id], ...patch } } }));

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{T.apiTitle}</h2>

        <label className="modal-field">
          <span>{T.apiDataUrl}</span>
          <input
            type="text"
            value={form.dataUrl}
            onChange={(e) => setForm((f) => ({ ...f, dataUrl: e.target.value }))}
            placeholder="/quality_data.json"
          />
        </label>

        <h3>{T.apiProviders}</h3>
        {PROVIDER_IDS.map((id) => {
          const p = form.providers[id];
          return (
            <div className="provider-row" key={id}>
              <label className="provider-enable">
                <input type="checkbox" checked={p.enabled} onChange={(e) => setProvider(id, { enabled: e.target.checked })} />
                <span>{SOURCES[id].label}</span>
                <em className={p.enabled ? 'on' : 'off'}>{p.enabled ? T.apiStatusOn : T.apiStatusOff}</em>
              </label>
              <input
                type="password"
                value={p.token}
                disabled={!p.enabled}
                onChange={(e) => setProvider(id, { token: e.target.value })}
                placeholder={T.apiTokenPlaceholder}
              />
            </div>
          );
        })}

        <p className="modal-note">{T.apiSecurityNote}</p>

        <div className="modal-actions">
          <button onClick={() => setForm(structuredClone(DEFAULT_SETTINGS))}>{T.apiReset}</button>
          <div className="spacer" />
          <button onClick={onClose}>{T.apiCancel}</button>
          <button className="primary" onClick={() => onSave(form)}>{T.apiSave}</button>
        </div>
      </div>
    </div>
  );
}
