import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../state/store';
import { applyPreview, cancelPreview, togglePreviewXray } from '../../state/actions';
import { liveActive, previewAnchor } from '../../state/livePreview';

/**
 * The preview card with Apply / Cancel. It opens right below the button that
 * started the preview (in the side panel), or at the top of the panel.
 */
export function PreviewBar() {
  const preview = useStore((s) => s.preview);
  const shown = !!preview;
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!shown) return;
    const anchor = previewAnchor();
    // the block in the section that holds the button (a row of buttons, a list…)
    const block = (anchor?.closest('.section-body > *') as HTMLElement | null) ?? anchor;
    if (!block || !block.parentElement) return;
    const div = document.createElement('div');
    div.className = 'preview-host';
    block.insertAdjacentElement('afterend', div);
    setHost(div);
    requestAnimationFrame(() => div.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    return () => {
      div.remove();
      setHost(null);
    };
  }, [shown]);
  if (!preview) return null;
  const card = <PreviewCard />;
  return host && host.isConnected ? createPortal(card, host) : card;
}

function PreviewCard() {
  const preview = useStore((s) => s.preview)!;
  const busy = useStore((s) => s.jobs.length > 0);
  if (!preview) return null;
  return (
    <div className="preview-bar">
      <header>
        <span className="tag">Preview</span>
        <strong>{preview.label}</strong>
        {liveActive() && (
          <span className="tag live" title="Change the settings in the panel and the preview updates by itself; nothing changes until Apply">
            Live
          </span>
        )}
      </header>
      {preview.summary && (
        <ul>
          {preview.summary.map((l, i) => (l === '—' ? <li key={i} className="sep" /> : <li key={i}>{l}</li>))}
        </ul>
      )}
      <div className="preview-actions">
        {preview.xray !== undefined && (
          <label className="check xray-toggle" title="See-through preview, to look at the inside">
            <input type="checkbox" checked={preview.xray} onChange={togglePreviewXray} /> X-ray
          </label>
        )}
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
