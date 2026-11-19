import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Numeric field that commits on Enter/blur and supports arrow-key stepping. */
export function NumberField({
  value, onChange, step = 1, min, max, suffix, precision = 3, disabled, label, title, width,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  precision?: number;
  disabled?: boolean;
  label?: ReactNode;
  title?: string;
  width?: number;
}) {
  const fmt = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 10 ** precision) / 10 ** precision) : '');
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const commit = (raw: string) => {
    // typographic minus / dashes (keyboards, copy-paste) and a decimal comma count as plain - and .
    const t = raw.replace(/[\u2212\u2012\u2013\u2014\uFE63\uFF0D]/g, '-').replace(/^(\s*-?\d+),(\d+\s*)$/, '$1.$2');
    let v: number;
    try {
      // allow simple arithmetic like "10+2.5" or "25.4*2"
      v = /^[\d\s+\-*/().eE]+$/.test(t) ? Number(Function(`"use strict";return (${t})`)()) : Number(t);
    } catch {
      v = NaN;
    }
    if (!Number.isFinite(v)) return setText(fmt(value));
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    setText(fmt(v));
    if (v !== value) onChange(v);
  };
  return (
    <label className="field" title={title} style={width ? { width } : undefined}>
      {label !== undefined && <span className="field-label">{label}</span>}
      <input
        type="text"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
        }}
        onBlur={(e) => {
          focused.current = false;
          commit(e.target.value);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setText(fmt(value));
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const s = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1);
            commit(String((Number(text) || 0) + s));
          }
          e.stopPropagation();
        }}
      />
      {suffix && <span className="field-suffix">{suffix}</span>}
    </label>
  );
}

export function Slider({
  value, min, max, step, onChange, label,
}: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label?: string }) {
  return (
    <input
      className="slider"
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function Section({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h3>{title}</h3>
        {actions}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}

export function Row({ label, children }: { label?: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      {label !== undefined && <span className="row-label">{label}</span>}
      <div className="row-content">{children}</div>
    </div>
  );
}

/** Label on its own line with three (or more) fields below — used for XYZ vectors. */
export function VecRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="vec-row">
      <span className="row-label">{label}</span>
      <div className="vec-fields">{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({
  value, options, onChange,
}: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'active' : ''}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="hint">{children}</p>;
}

/** Tabs across the top of a side panel. */
export function PanelTabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="panel-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={value === t.value ? 'active' : ''} title={t.title} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** the tab chosen last in each tabbed panel (by panel id), kept while tools change */
const chosenTab = new Map<string, string>();

/** A section's tab name: its title without numbering and counts ("2. Remesh" → "Remesh", "Parts (3)" → "Parts"). */
const tabName = (title: string) =>
  title
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The scrolling body of a side panel, with its sections as tabs: when it holds
 * two or more sections, a tab row shows their titles and only the chosen
 * section is shown, so the panel needs no long scrolling. Anything that is not
 * a section (preview card, hints) stays visible. The chosen tab is kept per
 * panel id while tools and selections change.
 */
export function SectionTabs({ id, children }: { id: string; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const [names, setNames] = useState<string[]>([]);
  const [active, setActive] = useState<string>(() => chosenTab.get(id) ?? '');
  // the sections: direct children of the body (or of a wrapper directly inside it)
  const sections = () => (body.current ? (Array.from(body.current.querySelectorAll(':scope > .section, :scope > * > .section')) as HTMLElement[]) : []);
  const apply = useCallback(() => {
    const els = sections();
    const titles = els.map((el) => tabName(el.querySelector(':scope > .section-head h3')?.textContent ?? ''));
    const key = titles.join('\u0001');
    setNames((old) => (old.join('\u0001') === key ? old : titles));
    const want = chosenTab.get(id) ?? active;
    const shown = titles.length < 2 ? null : titles.includes(want) ? want : titles[0];
    els.forEach((el, i) => {
      const hide = shown !== null && titles[i] !== shown;
      if (el.hidden !== hide) el.hidden = hide;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, active]);
  useLayoutEffect(apply);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    let frame = 0;
    // sections appear / disappear / get renamed inside child components: look again (once per frame)
    const obs = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), apply()));
    });
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      obs.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [apply]);
  const shown = names.length < 2 ? null : names.includes(chosenTab.get(id) ?? active) ? (chosenTab.get(id) ?? active) : names[0];
  const choose = (n: string) => {
    chosenTab.set(id, n);
    setActive(n);
    body.current?.scrollTo({ top: 0 });
  };
  return (
    <>
      {shown !== null && (
        <div className="section-tabs" role="tablist">
          {names.map((n, i) => (
            <button key={`${n}-${i}`} role="tab" aria-selected={n === shown} className={n === shown ? 'active' : ''} onClick={() => choose(n)} title={n}>
              {n}
            </button>
          ))}
        </div>
      )}
      <div className="panel-scroll" ref={body}>
        {children}
      </div>
    </>
  );
}
