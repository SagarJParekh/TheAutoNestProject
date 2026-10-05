import { useStore } from '../../state/store';
import { applyPreview, cancelPreview } from '../../state/actions';

export function PreviewBar() {
  const preview = useStore((s) => s.preview);
  const busy = useStore((s) => s.jobs.length > 0);
  if (!preview) return null;
  return (
    <div className="preview-bar">
      <header>
        <span className="tag">Preview</span>
        <strong>{preview.label}</strong>
      </header>
      {preview.summary && (
        <ul>
          {preview.summary.map((l, i) => (l === '—' ? <li key={i} className="sep" /> : <li key={i}>{l}</li>))}
        </ul>
      )}
      <div className="preview-actions">
        <button className="btn" onClick={cancelPreview} title="Esc">
          Cancel
        </button>
        <button className="btn primary" onClick={applyPreview} disabled={busy} title="Enter">
          Apply
        </button>
      </div>
    </div>
  );
}
