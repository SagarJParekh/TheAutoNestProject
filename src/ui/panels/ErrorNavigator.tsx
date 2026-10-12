import { useEffect } from 'react';
import { Check, Hint, Row, Section } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { previewFillHoles } from '../../state/actions';
import { previewCleanTriangles, previewFixNonManifold, previewRemoveOverlaps, unifyNormals } from '../../state/repairActions';
import { clearErrorFocus, focusError, loopsOfGroup, markErrorForEdit, partErrorGroups, stepError } from '../../state/errorActions';
import { ERROR_LABEL } from '../../geometry';
import type { ErrorGroup, ErrorKind } from '../../geometry';
import type { Part, ToolSettings } from '../../state/types';
import { highlightColors } from '../../state/contrast';

export function errorColor(kind: ErrorKind, partColor: string): string {
  const hc = highlightColors(partColor);
  return { open: hc.open, crack: hc.crack, nonManifold: hc.nonManifold, flipped: '#d040ff', degenerate: '#00e0ff', intersecting: '#ff7a1a', overlapping: '#22d3ee' }[kind];
}

function sizeOf(g: ErrorGroup) {
  const d = Math.hypot(g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]);
  return d < 0.01 ? '< 0.01 mm' : `${d.toFixed(2)} mm`;
}

function describe(g: ErrorGroup) {
  const [label, unit] = ERROR_LABEL[g.kind];
  return `${label} · ${g.count.toLocaleString()} ${unit}${g.count === 1 ? '' : 's'} · ${sizeOf(g)}`;
}

/** The quick fix offered for a problem, if there is one. */
function quickFix(part: Part, g: ErrorGroup): { label: string; title: string; run: () => void } | null {
  switch (g.kind) {
    case 'open':
    case 'crack': {
      const loops = loopsOfGroup(part.id, g);
      return loops.length ? { label: 'Fill', title: 'Fill this hole', run: () => previewFillHoles(loops) } : null;
    }
    case 'nonManifold':
      return { label: 'Fix', title: 'Fix all non-manifold edges (keeps the best pair of triangles per edge)', run: () => previewFixNonManifold(true) };
    case 'flipped':
      return { label: 'Fix', title: 'Orient all normals consistently outward', run: () => void unifyNormals() };
    case 'degenerate':
      return { label: 'Remove', title: 'Remove all degenerate triangles', run: () => previewCleanTriangles('degenerate') };
    case 'overlapping':
      return { label: 'Remove', title: 'Remove coplanar overlapping triangles', run: () => previewRemoveOverlaps() };
    default:
      return null;
  }
}

/**
 * Remaining problems of the part, one row per connected cluster. Clicking a
 * row zooms the view to it; "Mark" selects its triangles in the Edit tab.
 * `compact` shows only the summary, highlight toggles and previous / next.
 */
export function ErrorNavigator({ part, compact = false }: { part: Part; compact?: boolean }) {
  const report = useStore((s) => {
    const a = s.analysis[part.id];
    return a && a.mesh === part.mesh ? a.report : null;
  });
  useStore((s) => s.intersections[part.id]);
  const focus = useStore((s) => (s.errorFocus?.partId === part.id && s.errorFocus.mesh === part.mesh ? s.errorFocus : null));
  const preview = useStore((s) => s.preview);
  const shownColor = useStore((s) => s.appearance.selection);
  const hl = useStore((s) => s.settings.highlight);
  const setHl = (patch: Partial<ToolSettings['highlight']>) =>
    setState({ settings: { ...getState().settings, highlight: { ...getState().settings.highlight, ...patch } } });

  // a new mesh (after a fix) invalidates the focus
  useEffect(() => {
    const f = getState().errorFocus;
    if (f && f.partId === part.id && f.mesh !== part.mesh) clearErrorFocus();
  }, [part.id, part.mesh]);

  if (!report) return compact ? <Section title="Problems"><Hint>Analysing…</Hint></Section> : null;
  const groups = partErrorGroups(part.id) ?? [];
  const busy = !!preview || part.locked;

  const nav = (
    <div className="err-nav">
      <button className="mini" disabled={!groups.length} onClick={() => stepError(part.id, -1)} title="Previous problem">
        ◀
      </button>
      <span className="err-pos">{groups.length ? `${focus ? focus.index + 1 : '–'} / ${groups.length}` : 'none'}</span>
      <button className="mini" disabled={!groups.length} onClick={() => stepError(part.id, 1)} title="Next problem (zooms to it)">
        ▶
      </button>
      {focus && (
        <>
          <button className="mini" disabled={busy} onClick={() => markErrorForEdit(part.id, focus.index)} title="Select its triangles in the Edit tab (delete, fill, remesh by hand)">
            Mark
          </button>
          {(() => {
            const fx = quickFix(part, focus.group);
            return fx ? (
              <button className="mini primary" disabled={busy} onClick={fx.run} title={fx.title}>
                {fx.label}
              </button>
            ) : null;
          })()}
        </>
      )}
    </div>
  );

  return (
    <Section title={groups.length ? `Problems to fix (${groups.length})` : 'Problems to fix'} actions={focus ? <button className="mini" onClick={clearErrorFocus}>Clear</button> : undefined}>
      {!groups.length ? (
        <div className="verdict ok">{report.watertight ? 'No problems left — ready to print' : 'No problem clusters found'}</div>
      ) : (
        <>
          {compact && <div className="verdict bad small">{focus ? describe(focus.group) : `${groups.length} problem${groups.length > 1 ? 's' : ''} highlighted on the part`}</div>}
          {nav}
          {!compact && (
            <ul className="err-list">
              {groups.slice(0, 300).map((g, i) => {
                const fx = quickFix(part, g);
                return (
                  <li key={i} className={focus?.index === i ? 'active' : ''} onClick={() => focusError(part.id, i)} title="Zoom to this problem">
                    <i className="dot" style={{ background: errorColor(g.kind, shownColor) }} />
                    <span className="err-text">
                      #{i + 1} {describe(g)}
                    </span>
                    <span className="err-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="mini" disabled={busy} onClick={() => markErrorForEdit(part.id, i)} title="Select its triangles in the Edit tab">
                        Mark
                      </button>
                      {fx && (
                        <button className="mini" disabled={busy} onClick={fx.run} title={fx.title}>
                          {fx.label}
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {!compact && groups.length > 300 && <Hint>Showing the first 300 problems.</Hint>}
          {!compact && <Hint>Problems left after auto repair: click one to zoom to it, Mark selects its triangles in the Edit tab to delete, fill, bridge or remesh them by hand.</Hint>}
        </>
      )}
      {compact && (
        <Row label="Highlight">
          <Check checked={hl.open} onChange={(open) => setHl({ open })}>Open</Check>
          <Check checked={hl.nonManifold} onChange={(nonManifold) => setHl({ nonManifold })}>Non-manifold</Check>
          <Check checked={hl.flipped} onChange={(flipped) => setHl({ flipped })}>Flipped</Check>
        </Row>
      )}
    </Section>
  );
}
