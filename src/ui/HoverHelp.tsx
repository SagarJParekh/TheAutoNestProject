import { useEffect, useState } from 'react';
import { HELP, helpKey } from './help';

const DELAY = 3000;
const KEY = 'autonest.hoverHelp';
/** controls that can explain themselves */
const TARGET = 'button, label, select, input, summary, [data-help], [title], [role="tab"]';

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
    const restore = () => {
      if (el?.dataset.hhTitle !== undefined) {
        el.setAttribute('title', el.dataset.hhTitle);
        delete el.dataset.hhTitle;
      }
    };
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      setCard(null);
    };
    const show = () => {
      if (!el || !el.isConnected) return;
      const label = (el.dataset.helpTitle || el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
      const tip = el.dataset.hhTitle || '';
      const text = el.dataset.helpText ?? HELP[el.dataset.help ?? ''] ?? HELP[helpKey(label)] ?? HELP[helpKey(tip.split('(')[0])] ?? tip;
      if (!text) return;
      const title = label && label.length <= 40 ? label : tip.split(/[(.:]/)[0].trim() || label.slice(0, 40);
      setCard({ title, text, x: at.x, y: at.y });
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(show, DELAY);
    };
    const over = (e: MouseEvent) => {
      const t = (e.target as HTMLElement | null)?.closest?.(TARGET) as HTMLElement | null;
      // the viewport canvas and plain text fields are not "functions"
      const target = t && t.tagName !== 'CANVAS' && !(t.tagName === 'INPUT' && ['text', 'number', 'search'].includes((t as HTMLInputElement).type)) ? t : null;
      if (target === el) return;
      restore();
      stop();
      el = target;
      if (!el) return;
      const title = el.getAttribute('title');
      if (title) {
        el.dataset.hhTitle = title;
        el.removeAttribute('title');
      }
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
