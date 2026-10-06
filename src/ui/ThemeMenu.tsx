import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { Segmented } from './controls';
import { useStore } from '../state/store';
import { setAppearance } from '../state/actions';
import { BACKGROUNDS } from '../state/theme';

/** Toolbar button with a popover: interface theme and viewport background. */
export function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const a = useStore((s) => s.appearance);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="theme-menu" ref={ref}>
      <button className={`tb icon ${open ? 'active' : ''}`} title="Theme and background" onClick={() => setOpen(!open)}>
        {Icon.theme}
      </button>
      {open && (
        <div className="theme-pop" role="dialog" aria-label="Theme and background">
          <h4>Interface</h4>
          <Segmented
            value={a.ui}
            onChange={(ui) => setAppearance({ ui })}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
          />
          <h4>Viewport background</h4>
          <div className="bg-swatches">
            {BACKGROUNDS.map((b) => (
              <button
                key={b.id}
                className={`bg-swatch ${a.background === b.id ? 'active' : ''}`}
                style={{ background: b.css }}
                title={b.label}
                aria-label={b.label}
                onClick={() => setAppearance({ background: b.id })}
              />
            ))}
          </div>
          <label className={`bg-custom ${a.background === 'custom' ? 'active' : ''}`}>
            <input type="color" value={a.custom} onChange={(e) => setAppearance({ background: 'custom', custom: e.target.value })} />
            Custom colour
          </label>
        </div>
      )}
    </div>
  );
}
