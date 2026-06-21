// 데이터 소스 설정 모달.
// 동작의 핵심은 "데이터 소스 URL" 하나 — 수집기(GitHub Actions)가 생성·갱신해 둔
// quality_data.json(내 GitHub raw)을 가리킨다. 클라이언트는 토큰을 다루지 않는다(NFR-02).

import { useState } from 'react';
import { T } from '../config.ts';
import { DEFAULT_SETTINGS, type ApiSettings } from '../lib/settings.ts';

interface Props {
  settings: ApiSettings;
  onSave: (s: ApiSettings) => void;
  onClose: () => void;
}

export default function ApiSettings({ settings, onSave, onClose }: Props) {
  const [form, setForm] = useState<ApiSettings>(() => structuredClone(settings));

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
            placeholder="https://raw.githubusercontent.com/<계정>/<repo>/main/public/quality_data.json"
          />
        </label>

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
