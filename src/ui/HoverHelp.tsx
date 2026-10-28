import { useEffect, useState } from 'react';
import { HELP, helpKey } from './help';
import { INPUT_HELP } from './helpInputs';
import { getState } from '../state/store';

const DELAY = 3000;
const KEY = 'autonest.hoverHelp';
/** controls that can explain themselves */
const TARGET = 'button, label, select, input, summary, [data-help], [title], [role="tab"], .row, .vec-row, .axis-row';
const ROW = '.row, .vec-row, .axis-row';

/** Which tool a control belongs to, for explanations that differ between tools. */
function contextOf(el: HTMLElement): string {
  if (el.closest('.modal')) return 'export';
  const s = getState();
  if (s.workspace === 'build') return 'build';
  if (el.closest('.face-pick')) return 'face pick';
  return s.tool === 'clip' ? 'cut' : s.tool;
}

/** Explanation for a label in a tool: the tool's own entry first, then a general one. */
function lookup(ctx: string, label: string): string | undefined {
  const k = helpKey(label);
  if (!k) return undefined;
  return INPUT_HELP[`${ctx}:${k}`] ?? INPUT_HELP[k] ?? HELP[k];
}

const rowLabel = (row: Element) => (row.querySelector('.row-label, .vec-label, .axis-name')?.textContent ?? '').replace(/:$/, '').trim();

export function hoverHelpOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}
export function setHoverHelp(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // storage blocked: lasts for this visit
  }
  window.dispatchEvent(new Event('hoverhelp'));
}

/**
 * Rest the cursor on a function for 3 seconds and a card explains it. While
 * the pointer is on a control its native tooltip is held back (the card shows
 * that text instead), so the two never appear together.
 */
export function HoverHelp() {
  const [card, setCard] = useState<{ title: string; text: string; x: number; y: number } | null>(null);
  const [on, setOn] = useState(hoverHelpOn());
  useEffect(() => {
    const sync = () => setOn(hoverHelpOn());
    window.addEventListener('hoverhelp', sync);
    return () => window.removeEventListener('hoverhelp', sync);
  }, []);
  useEffect(() => {
    if (!on) return;
    let el: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let at = { x: 0, y: 0 };
    // tooltips held back while the cursor is on a control (its own, and those of the fields in a row)
    let held: HTMLElement[] = [];
    const hold = (n: HTMLElement) => {
      const t = n.getAttribute('title');
      if (!t) return;
      n.dataset.hhTitle = t;
      n.removeAttribute('title');
      held.push(n);
    };
    const restore = () => {
      for (const n of held) {
        if (n.dataset.hhTitle !== undefined) n.setAttribute('title', n.dataset.hhTitle);
        delete n.dataset.hhTitle;
      }
      held = [];
    };
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      setCard(null);
    };
    const show = () => {
      if (!el || !el.isConnected) return;
      const ctx = contextOf(el);
      const isRow = el.matches(ROW);
      const label = (el.dataset.helpTitle || (isRow ? rowLabel(el) : '') || el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      const tip = el.dataset.hhTitle || '';
      // the control itself, then (for buttons, fields and sliders inside a settings row) the row it is in
      const row = isRow ? null : el.closest(ROW);
      const rLabel = row ? rowLabel(row) : '';
      let title = label;
      let text: string | undefined = el.dataset.helpText ?? HELP[el.dataset.help ?? ''] ?? lookup(ctx, label);
      if (!text && row) {
        text = (row as HTMLElement).dataset.helpText ?? lookup(ctx, rLabel);
        if (text) title = (row as HTMLElement).dataset.helpTitle || rLabel;
      }
      text ??= HELP[helpKey(tip.split('(')[0])] ?? (tip || undefined);
      if (!text && row) {
        // a field without its own entry: the tooltip of the field in the row
        const inner = row.querySelector('[title], [data-hh-title]') as HTMLElement | null;
        text = inner?.dataset.hhTitle || inner?.getAttribute('title') || undefined;
        if (text) title = rLabel || title;
      }
      if (!text) return;
      if (!title || title.length > 40) title = tip.split(/[(.:]/)[0].trim() || title.slice(0, 40);
      setCard({ title, text, x: at.x, y: at.y });
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(show, DELAY);
    };
    const over = (e: MouseEvent) => {
      let t = (e.target as HTMLElement | null)?.closest?.(TARGET) as HTMLElement | null;
      // a typing field or slider explains itself through its settings row
      if (t && (t.tagName === 'INPUT' || (t.tagName === 'LABEL' && t.classList.contains('field'))) && ['text', 'number', 'search', 'range', ''].includes((t as HTMLInputElement).type ?? '')) t = (t.closest(ROW) as HTMLElement | null) ?? t;
      if (t?.tagName === 'LABEL' && t.classList.contains('field')) t = (t.closest(ROW) as HTMLElement | null) ?? t;
      const target = t && t.tagName !== 'CANVAS' ? t : null;
      if (target === el) return;
      restore();
      stop();
      el = target;
      if (!el) return;
      hold(el);
      if (el.matches(ROW)) el.querySelectorAll<HTMLElement>('[title]').forEach(hold);
      at = { x: e.clientX, y: e.clientY };
      arm();
    };
    const move = (e: MouseEvent) => {
      if (!el) return;
      // only a steady cursor counts: moving more than a few pixels starts the wait again
      if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > 6) {
        at = { x: e.clientX, y: e.clientY };
        setCard(null);
        arm();
      }
    };
    const cancel = () => {
      stop();
      if (el) arm();
    };
    document.addEventListener('mouseover', over, true);
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mousedown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    document.addEventListener('wheel', cancel, true);
    return () => {
      restore();
      stop();
      document.removeEventListener('mouseover', over, true);
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mousedown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      document.removeEventListener('wheel', cancel, true);
    };
  }, [on]);
  if (!card) return null;
  // beside the cursor, kept on screen
  const w = 300;
  const left = Math.min(card.x + 16, window.innerWidth - w - 8);
  const top = card.y + 20 + 120 > window.innerHeight ? Math.max(8, card.y - 130) : card.y + 20;
  return (
    <div className="hover-help" style={{ left, top, width: w }} role="tooltip">
      <strong>{card.title}</strong>
      <p>{card.text}</p>
    </div>
  );
}
