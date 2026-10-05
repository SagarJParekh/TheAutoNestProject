import { useEffect, useRef, useState, type ReactNode } from 'react';

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
  const commit = (t: string) => {
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
