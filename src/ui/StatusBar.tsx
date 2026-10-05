import { Icon } from './icons';
import { dismissNotice, useStore } from '../state/store';

export function StatusBar() {
  const jobs = useStore((s) => s.jobs);
  const parts = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const tris = parts.reduce((a, p) => a + (p.visible ? p.mesh.indices.length / 3 : 0), 0);
  return (
    <footer className="statusbar">
      <span>
        {parts.length} part{parts.length === 1 ? '' : 's'} · {tris.toLocaleString()} triangles
        {selection.length ? ` · ${selection.length} selected` : ''}
      </span>
      <div className="grow" />
      {jobs.map((j) => (
        <div className="job" key={j.id} title={j.message}>
          <span className="job-label">
            {j.label}
            {j.message && j.message !== j.label ? ` — ${j.message}` : ''}
          </span>
          <div className="progress">
            <div style={{ width: `${Math.round(j.progress * 100)}%` }} />
          </div>
          {j.cancel && (
            <button className="icon-btn" title="Cancel" onClick={j.cancel}>
              {Icon.close}
            </button>
          )}
        </div>
      ))}
      <span className="muted">mm · Z up</span>
    </footer>
  );
}

export function Notices() {
  const notices = useStore((s) => s.notices);
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.kind}`}>
          <span>{n.text}</span>
          <button className="icon-btn" onClick={() => dismissNotice(n.id)} aria-label="Dismiss">
            {Icon.close}
          </button>
        </div>
      ))}
    </div>
  );
}
