import { useEffect } from 'react';
import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import {
  clearTriSelection, deleteSelectedTriangles, hoverShell, liveShellView, loadShells, previewFixOpenEdges, selectShells, shellAction,
  startTriPick, toggleIsolate, toggleShell,
} from '../../state/editActions';
import type { Part } from '../../state/types';

const fmtVol = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} cm³` : `${v.toFixed(1)} mm³`);

// ------------------------------------------------------------------ open edges

export function OpenEdgesSection({ part, openEdges }: { part: Part; openEdges: number }) {
  const preview = useStore((s) => s.preview);
  const maxPerimeter = useStore((s) => s.settings.openEdges.maxPerimeter);
  const busy = !!preview || part.locked;
  return (
    <Section title={`Fix open edges (${openEdges.toLocaleString()})`}>
      <button className="btn wide" disabled={busy} onClick={() => previewFixOpenEdges('stitchFill')} title="Close cracks between triangles, then fill every remaining hole">
        Stitch &amp; fill all
      </button>
      <Row label="Fill holes up to">
        <NumberField
          value={maxPerimeter}
          min={0.1}
          step={5}
          suffix="mm"
          title="Largest hole perimeter to fill"
          onChange={(v) => setState({ settings: { ...getState().settings, openEdges: { maxPerimeter: v } } })}
        />
        <button className="btn" disabled={busy} onClick={() => previewFixOpenEdges('fillSmall')}>
          Fill
        </button>
      </Row>
      <button className="btn wide" disabled={busy} onClick={() => previewFixOpenEdges('trim')} title="Remove slivers and ragged borders: triangles with two or more open edges">
        Remove dangling triangles
      </button>
      <Hint>Open edges belong to only one triangle. Stitching closes hairline cracks; filling closes real holes; trimming removes loose slivers.</Hint>
    </Section>
  );
}

// ------------------------------------------------------------------ shells

export function ShellsTab({ parts }: { parts: Part[] }) {
  const part = parts.length === 1 ? parts[0] : null;
  const sv = useStore((s) => s.shellView);
  useStore((s) => s.parts);
  const preview = useStore((s) => s.preview);
  const live = liveShellView();
  const view = live && part && live.partId === part.id ? live : null;

  useEffect(() => {
    if (part && !view && part.mesh.indices.length / 3 < 3_000_000) loadShells(part.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part?.id, part?.mesh, !!view]);

  if (!part) return <Section title="Shells"><Hint>Select one part to see its shells.</Hint></Section>;
  if (!view)
    return (
      <Section title="Shells">
        <button className="btn wide" onClick={() => loadShells(part.id)}>
          Find shells
        </button>
      </Section>
    );
  void sv;
  const sel = new Set(view.selected);
  const busy = !!preview || part.locked;
  return (
    <>
      <Section
        title={`Shells (${view.shells.length})`}
        actions={
          <button className="mini" onClick={() => loadShells(part.id)}>
            Refresh
          </button>
        }
      >
        <div className="btn-row">
          <button className="mini" onClick={() => selectShells('all')}>All</button>
          <button className="mini" onClick={() => selectShells('none')}>None</button>
          <button className="mini" onClick={() => selectShells('invert')}>Invert</button>
          <button className="mini" onClick={() => selectShells('open')} title="Shells with open edges">Open</button>
          <button className="mini" onClick={() => selectShells('small')} title="Smaller than 1% of the largest shell's volume">Small</button>
        </div>
        <ul className="shell-list" onMouseLeave={() => hoverShell(null)}>
          {view.shells.slice(0, 500).map((sh) => (
            <li
              key={sh.id}
              className={`${sel.has(sh.id) ? 'selected' : ''}`}
              onMouseEnter={() => hoverShell(sh.id)}
              onClick={(e) => toggleShell(sh.id, e.ctrlKey || e.metaKey || e.shiftKey)}
            >
              <input type="checkbox" checked={sel.has(sh.id)} onChange={() => toggleShell(sh.id, true)} onClick={(e) => e.stopPropagation()} />
              <span className="shell-name">Shell {sh.id + 1}</span>
              <span className="muted small">{sh.triangles.toLocaleString()} tris</span>
              <span className="muted small">{fmtVol(sh.volume)}</span>
              <span className={`badge ${sh.closed ? 'ok' : 'bad'}`}>{sh.closed ? 'closed' : 'open'}</span>
            </li>
          ))}
        </ul>
        {view.shells.length > 500 && <Hint>Showing the 500 largest shells.</Hint>}
        <Check checked={view.isolate} onChange={toggleIsolate}>
          Show only the selected shells
        </Check>
      </Section>
      <Section title={`Selected (${view.selected.length})`}>
        <div className="btn-grid two">
          <button className="btn danger" disabled={busy || !view.selected.length} onClick={() => shellAction('delete')}>
            Delete shells
          </button>
          <button className="btn" disabled={busy || !view.selected.length} onClick={() => shellAction('keep')}>
            Keep only these
          </button>
          <button className="btn" disabled={busy || view.selected.length < 2} onClick={() => shellAction('merge')} title="Boolean union of the selected shells (they must be closed)">
            Merge shells (union)
          </button>
          <button className="btn" disabled={busy || !view.selected.length} onClick={() => shellAction('extract')}>
            Extract to new part
          </button>
        </div>
        <Hint>Hover a row to highlight the shell; click to select (Ctrl/Shift-click for several). For splitting every shell into its own part use Combine → Split shells.</Hint>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ triangle edit

export function TriEditTab({ parts }: { parts: Part[] }) {
  const part = parts.length === 1 ? parts[0] : null;
  const st = useStore((s) => s.settings.triEdit);
  const te = useStore((s) => s.triEdit);
  const pickMode = useStore((s) => s.pickMode);
  const live = te && part && te.partId === part.id && te.mesh === part.mesh ? te : null;
  const set = (patch: Partial<typeof st>) => setState({ settings: { ...getState().settings, triEdit: { ...getState().settings.triEdit, ...patch } } });
  return (
    <Section title="Edit triangles">
      <Segmented
        value={st.mode}
        onChange={(mode) => {
          set({ mode });
          setState({ pickMode: null });
          clearTriSelection();
        }}
        options={[
          { value: 'delete', label: 'Delete triangles' },
          { value: 'create', label: 'Create triangles' },
        ]}
      />
      {st.mode === 'delete' ? (
        <>
          <button className={`btn wide ${pickMode === 'triangle' ? 'primary' : ''}`} onClick={() => startTriPick('triangle')}>
            {pickMode === 'triangle' ? 'Done selecting' : 'Select triangles…'}
          </button>
          <Check checked={st.smooth} onChange={(smooth) => set({ smooth })}>
            Select connected smooth area
          </Check>
          {st.smooth && (
            <Row label="Max crease">
              <NumberField value={st.angle} min={0} max={89} suffix="°" onChange={(angle) => set({ angle })} />
            </Row>
          )}
          <p className="muted small">{live?.tris.length ? `${live.tris.length.toLocaleString()} triangles selected` : 'Click triangles to select them; click again to deselect.'}</p>
          <div className="btn-grid two">
            <button className="btn danger" disabled={!live?.tris.length || part?.locked} onClick={deleteSelectedTriangles}>
              Delete selected
            </button>
            <button className="btn" disabled={!live?.tris.length} onClick={clearTriSelection}>
              Clear selection
            </button>
          </div>
        </>
      ) : (
        <>
          <button className={`btn wide ${pickMode === 'vertex' ? 'primary' : ''}`} onClick={() => startTriPick('vertex')}>
            {pickMode === 'vertex' ? 'Done creating' : 'Pick vertices…'}
          </button>
          <p className="muted small">
            {live?.verts.length ? `${live.verts.length} of 3 vertices picked` : 'Click three existing vertices (corners) to add a triangle between them, e.g. across a hole.'}
          </p>
          {live?.verts.length ? (
            <button className="btn" onClick={clearTriSelection}>
              Restart
            </button>
          ) : null}
        </>
      )}
      <Hint>Each delete / create is one undo step (Ctrl+Z). New triangles are wound to match the neighbouring open edges.</Hint>
    </Section>
  );
}
