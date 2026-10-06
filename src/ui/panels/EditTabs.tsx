import { useEffect } from 'react';
import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import {
  clearBridge, clearTriSelection, createBridge, deleteSelectedTriangles, extractMarked, growMarked, hoverShell, invertMarked, liveShellView, loadShells, markAll, previewFixOpenEdges,
  previewRemesh, selectShells, shellAction, shrinkMarked, startTriPick, suggestedEdgeLength, toggleIsolate, toggleShell,
} from '../../state/editActions';
import type { MarkTool, Part } from '../../state/types';

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

const MARK_TOOLS: { value: MarkTool; label: string; title: string }[] = [
  { value: 'triangle', label: 'Triangle', title: 'Mark single triangles by clicking' },
  { value: 'plane', label: 'Plane', title: 'Mark the flat area around the clicked triangle' },
  { value: 'surface', label: 'Surface', title: 'Mark the surface around the clicked triangle, up to sharp edges' },
  { value: 'shell', label: 'Shell', title: 'Mark the whole shell (connected piece) of the clicked triangle' },
  { value: 'brush', label: 'Brush', title: 'Paint over the surface to mark triangles' },
  { value: 'window', label: 'Window', title: 'Drag a rectangle to mark the triangles inside it' },
];

const PICK_FOR: Record<MarkTool, 'triangle' | 'brush' | 'window'> = {
  triangle: 'triangle',
  plane: 'triangle',
  surface: 'triangle',
  shell: 'triangle',
  brush: 'brush',
  window: 'window',
};

export function TriEditTab({ parts }: { parts: Part[] }) {
  const part = parts.length === 1 ? parts[0] : null;
  const st = useStore((s) => s.settings.triEdit);
  const te = useStore((s) => s.triEdit);
  const pickMode = useStore((s) => s.pickMode);
  const preview = useStore((s) => s.preview);
  const live = te && part && te.partId === part.id && te.mesh === part.mesh ? te : null;
  const marked = live?.tris.length ?? 0;
  const set = (patch: Partial<typeof st>) => setState({ settings: { ...getState().settings, triEdit: { ...getState().settings.triEdit, ...patch } } });
  const marking = pickMode === 'triangle' || pickMode === 'brush' || pickMode === 'window';
  const chooseTool = (markTool: MarkTool) => {
    set({ markTool });
    // switch the active pick mode along with the tool
    if (marking) setState({ pickMode: PICK_FOR[markTool] });
  };
  const busy = !!preview || !!part?.locked;
  return (
    <>
      <Section title="Edit triangles">
        <Segmented
          value={st.mode}
          onChange={(mode) => {
            set({ mode });
            setState({ pickMode: null });
            clearTriSelection();
          }}
          options={[
            { value: 'mark', label: 'Mark / select' },
            { value: 'create', label: 'Create triangles' },
            { value: 'bridge', label: 'Bridge' },
          ]}
        />
        {st.mode === 'bridge' ? (
          <BridgeControls part={part} />
        ) : st.mode === 'mark' ? (
          <>
            <div className="mark-tools">
              {MARK_TOOLS.map((m) => (
                <button key={m.value} className={`mini ${st.markTool === m.value ? 'active' : ''}`} title={m.title} onClick={() => chooseTool(m.value)}>
                  {m.label}
                </button>
              ))}
            </div>
            {st.markTool === 'plane' && (
              <Row label="Normal tolerance">
                <NumberField value={st.planeAngle} min={0} max={45} step={0.5} suffix="°" onChange={(planeAngle) => set({ planeAngle })} />
              </Row>
            )}
            {st.markTool === 'surface' && (
              <Row label="Max crease">
                <NumberField value={st.angle} min={0} max={89} suffix="°" onChange={(angle) => set({ angle })} />
              </Row>
            )}
            {st.markTool === 'brush' && (
              <Row label="Brush radius">
                <NumberField value={st.brushRadius} min={0.05} step={0.5} suffix="mm" onChange={(brushRadius) => set({ brushRadius })} />
              </Row>
            )}
            {st.markTool === 'window' && (
              <Check checked={st.windowThrough} onChange={(windowThrough) => set({ windowThrough })}>
                Mark through (include hidden triangles)
              </Check>
            )}
            <button className={`btn wide ${marking ? 'primary' : ''}`} disabled={!part} onClick={() => startTriPick(PICK_FOR[st.markTool])}>
              {marking ? 'Done marking' : `Start marking (${MARK_TOOLS.find((m) => m.value === st.markTool)!.label.toLowerCase()})…`}
            </button>
            <p className="muted small">{marked ? `${marked.toLocaleString()} triangles marked` : 'Nothing marked yet. Ctrl + click / drag unmarks.'}</p>
            <div className="btn-grid three">
              <button className="btn" disabled={!marked} onClick={() => growMarked(1)} title="Add the triangles next to the marked area">
                Grow
              </button>
              <button className="btn" disabled={!marked} onClick={shrinkMarked} title="Remove the outer ring of the marked area">
                Shrink
              </button>
              <button className="btn" disabled={!part} onClick={invertMarked} title="Mark everything that is not marked, and unmark the rest">
                Invert
              </button>
              <button className="btn" disabled={!part} onClick={markAll}>
                All
              </button>
              <button className="btn" disabled={!marked} onClick={clearTriSelection}>
                Clear
              </button>
              <button className="btn" disabled={!marked} onClick={extractMarked} title="Copy the marked triangles into a new part">
                Extract
              </button>
            </div>
            <div className="btn-grid two">
              <button className="btn danger" disabled={!marked || busy} onClick={deleteSelectedTriangles}>
                Delete marked
              </button>
              <button className="btn" disabled={!marked || busy} onClick={() => previewRemesh('marked')} title="Remesh only the marked area; its border stays attached">
                Remesh marked
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
        <Hint>Each delete / create / remesh is one undo step (Ctrl+Z). New triangles are wound to match the neighbouring open edges.</Hint>
      </Section>
      <RemeshSection part={part} marked={marked} />
    </>
  );
}

function BridgeControls({ part }: { part: Part | null }) {
  const st = useStore((s) => s.settings.triEdit);
  const te = useStore((s) => s.triEdit);
  const pickMode = useStore((s) => s.pickMode);
  const live = te && part && te.partId === part.id && te.mesh === part.mesh ? te : null;
  const a = live?.bridgeA?.length ?? 0, b = live?.bridgeB?.length ?? 0;
  const setSide = (bridgeSide: 'A' | 'B') => setState({ settings: { ...getState().settings, triEdit: { ...getState().settings.triEdit, bridgeSide } } });
  return (
    <>
      <div className="bridge-sides">
        <button className={`bridge-side a ${st.bridgeSide === 'A' ? 'active' : ''}`} onClick={() => setSide('A')}>
          <b>Side A</b>
          <span>{a ? `${a} edge${a > 1 ? 's' : ''}` : 'no edges'}</span>
        </button>
        <button className={`bridge-side b ${st.bridgeSide === 'B' ? 'active' : ''}`} onClick={() => setSide('B')}>
          <b>Side B</b>
          <span>{b ? `${b} edge${b > 1 ? 's' : ''}` : 'no edges'}</span>
        </button>
      </div>
      <button className={`btn wide ${pickMode === 'edge' ? 'primary' : ''}`} disabled={!part} onClick={() => startTriPick('edge')}>
        {pickMode === 'edge' ? 'Done picking edges' : `Pick edges for side ${st.bridgeSide}…`}
      </button>
      <div className="btn-grid two">
        <button className="btn primary" disabled={!a || !b || !!part?.locked} onClick={createBridge}>
          Create bridge
        </button>
        <button className="btn" disabled={!a && !b} onClick={clearBridge}>
          Clear
        </button>
      </div>
      <Hint>
        Pick one open edge (or a run of neighbouring open edges) on each side, e.g. the two borders of a gap or a slot. Click a side to choose where the
        next edges go. The bridge is a strip of triangles between them, oriented to match the surface.
      </Hint>
    </>
  );
}

export function RemeshSection({ part, marked }: { part: Part | null; marked: number }) {
  const st = useStore((s) => s.settings.remesh);
  const preview = useStore((s) => s.preview);
  const set = (patch: Partial<typeof st>) => setState({ settings: { ...getState().settings, remesh: { ...getState().settings.remesh, ...patch } } });
  const busy = !!preview || !part || part.locked;
  return (
    <Section title="Remesh">
      <Row label="Edge length">
        <NumberField value={st.edgeLength} min={0.01} step={0.1} suffix="mm" onChange={(edgeLength) => set({ edgeLength })} />
        <button
          className="mini"
          disabled={!part}
          onClick={() => set({ edgeLength: Math.round(suggestedEdgeLength(marked ? 'marked' : 'part') * 1000) / 1000 })}
          title="Use the current average edge length"
        >
          Average
        </button>
      </Row>
      <Row label="Keep sharp edges over">
        <NumberField value={st.featureAngle} min={1} max={180} suffix="°" onChange={(featureAngle) => set({ featureAngle })} />
      </Row>
      <Row label="Passes">
        <NumberField value={st.iterations} min={1} max={20} step={1} precision={0} onChange={(iterations) => set({ iterations: Math.round(iterations) })} />
      </Row>
      <div className="btn-grid two">
        <button className="btn primary" disabled={busy} onClick={() => previewRemesh('part')}>
          Remesh whole part
        </button>
        <button className="btn" disabled={busy || !marked} onClick={() => previewRemesh('marked')}>
          Remesh marked
        </button>
      </div>
      <Hint>
        Rebuilds the surface with evenly sized, well-shaped triangles of about the given edge length. Sharp edges, open borders and the border of a marked
        area stay where they are.
      </Hint>
    </Section>
  );
}
