import { useEffect, useMemo, useRef, useState } from 'react';
import { setState, useStore } from '../state/store';
import { buildCommands, searchCommands } from './commands';

export function CommandPalette() {
  const open = useStore((s) => s.showSearch);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const all = useMemo(() => buildCommands(), []);
  const results = useMemo(() => searchCommands(all, q).slice(0, 60), [all, q]);
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    document.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  if (!open) return null;
  const close = () => setState({ showSearch: false });
  const run = (i: number) => {
    const c = results[i];
    if (!c) return;
    close();
    setTimeout(c.run, 0);
  };
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={close}>
      <div className="palette" role="dialog" aria-label="Search functions" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search functions… (e.g. holes, mirror, shells, measure)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') run(active);
            else if (e.key === 'Escape') close();
          }}
        />
        <ul className="palette-list" role="listbox">
          {results.length === 0 && <li className="palette-empty">No matching functions</li>}
          {results.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === active}
              className={`palette-item ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(i)}
            >
              <span className="palette-group">{c.group}</span>
              <span className="palette-label">{c.label}</span>
              {c.shortcut && <kbd>{c.shortcut}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
