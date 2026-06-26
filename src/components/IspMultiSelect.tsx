// 고해상도 멀티셀렉트 드롭다운 (PRD §4 FR-05).
// 단일 접이식 패널: 한국 통신사 상단 고정, 해외는 국가별 그룹(접기 가능),
// 패널 최대 80vh + 내부 스크롤.

import { useEffect, useRef, useState } from 'react';
import { ISP_GROUPS, type Isp } from '../data/isps.ts';
import { colorForIsp } from '../theme.ts';
import { T } from '../config.ts';

interface Props {
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  colorIndex: (ispId: string) => number;
}

export default function IspMultiSelect({ selected, onChange, colorIndex }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange(next);
  };

  const q = query.trim().toLowerCase();
  const matches = (isp: Isp) =>
    !q || isp.name.toLowerCase().includes(q) || isp.asns.join(' ').toLowerCase().includes(q);

  const selectShown = () => {
    const all = new Set(selected);
    ISP_GROUPS.forEach((g) => g.isps.forEach((i) => {
      if (i.hidden || !matches(i)) return;
      if (i.asnUnits) i.asnUnits.forEach((u) => all.add(u.id));
      else all.add(i.id);
    }));
    onChange(all);
  };
  const clearAll = () => onChange(new Set());

  return (
    <div className="ms" ref={ref}>
      <button className="ms-trigger control" onClick={() => setOpen((o) => !o)}>
        <span>{T.ispSelected(selected.size)}</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="ms-panel">
          <input
            className="ms-search"
            placeholder={T.searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />

          {ISP_GROUPS.map((group) => {
            const visible = group.isps.filter((i) => !i.hidden && matches(i));
            if (visible.length === 0) return null;
            const isCollapsed = !group.pinned && collapsed[group.id] && !q;
            return (
              <div key={group.id} className={`ms-group${group.pinned ? ' pinned' : ''}`}>
                <div
                  className="ms-group-header"
                  onClick={() => !group.pinned && setCollapsed((c) => ({ ...c, [group.id]: !c[group.id] }))}
                >
                  {group.pinned ? <span className="ms-pin">📌</span> : <span>{isCollapsed ? '▸' : '▾'}</span>}
                  <span>{group.label}</span>
                </div>

                {!isCollapsed &&
                  visible.map((isp) =>
                    isp.asnUnits ? (
                      // 멀티 ASN: 박스 하나 + ASN별 개별 체크박스
                      <div className="ms-box" key={isp.id}>
                        <div className="ms-box-head">
                          <span className="swatch" style={{ background: colorForIsp(colorIndex(isp.id), isp.id) }} />
                          <span>{isp.name}</span>
                        </div>
                        {isp.asnUnits.map((u) => (
                          <label className="ms-item ms-sub" key={u.id}>
                            <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} />
                            <span>{u.asn}</span>
                            {u.note && <small className="asn-role">{u.note}</small>}
                          </label>
                        ))}
                      </div>
                    ) : (
                      <label className="ms-item" key={isp.id}>
                        <input type="checkbox" checked={selected.has(isp.id)} onChange={() => toggle(isp.id)} />
                        <span className="swatch" style={{ background: colorForIsp(colorIndex(isp.id), isp.id) }} />
                        <span>{isp.name}</span>
                        <small>{isp.asns.join(', ')}</small>
                      </label>
                    ))}
              </div>
            );
          })}

          <div className="ms-actions">
            <button onClick={selectShown}>{T.selectShown}</button>
            <button onClick={clearAll}>{T.clearAll}</button>
          </div>
        </div>
      )}
    </div>
  );
}
