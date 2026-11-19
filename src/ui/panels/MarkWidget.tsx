import { getState, setState, useStore } from '../../state/store';
import {
  clearTriSelection, deleteSelectedTriangles, extractMarked, growMarked, invertMarked, markAll, previewRemesh, shrinkMarked, startTriPick,
} from '../../state/editActions';
import { live as livePreview } from '../../state/livePreview';
import { MARK_TOOLS, PICK_FOR } from './EditTabs';
import { NumberField } from '../controls';
import type { MarkTool } from '../../state/types';

/**
 * Mark row: the Repair → Edit mark tools as one permanent row above the view
 * in Mesh prep, every option in sight, usable with every function. The marked
 * triangles stay while tools change (Remesh, Surface to Solid use them).
 */
export function MarkRow() {
  const workspace = useStore((s) => s.workspace);
  const all = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const te = useStore((s) => s.triEdit);
  const pickMode = useStore((s) => s.pickMode);
  const preview = useStore((s) => s.preview);
  const st = useStore((s) => s.settings.triEdit);
  if (workspace !== 'prep') return null;
  const markedPart = te && all.find((p) => p.id === te.partId && p.mesh === te.mesh);
  const part = markedPart && te.tris.length ? markedPart : (all.find((p) => p.id === selection[0]) ?? (all.length === 1 ? all[0] : null));
  const count = te && markedPart ? te.tris.length : 0;
  const marking = pickMode === 'triangle' || pickMode === 'brush' || pickMode === 'window';
  const set = (patch: Partial<typeof st>) => setState({ settings: { ...getState().settings, triEdit: { ...getState().settings.triEdit, ...patch } } });
  // choosing a tool starts marking with it straight away (click it again to stop)
  const choose = (markTool: MarkTool) => {
    if (marking && st.markTool === markTool) return setState({ pickMode: null });
    set({ markTool });
    if (!part) return;
    if (!selection.includes(part.id)) setState({ selection: [part.id] });
    setState({ pickMode: PICK_FOR[markTool], preview: null });
  };
  const busy = !!preview || !!part?.locked;
  const field = (label: string, value: number, onChange: (v: number) => void, suffix: string, opts: { min?: number; max?: number; step?: number } = {}) => (
    <span className="mark-field">
      <NumberField label={label} value={value} suffix={suffix} width={label.length > 6 ? 116 : 96} title={label} {...opts} onChange={onChange} />
    </span>
  );
  return (
    <div className="mark-row" role="toolbar" aria-label="Mark triangles">
      <span className="mark-row-title">Mark</span>
      <div className="mark-row-group">
        {MARK_TOOLS.map((m) => (
          <button
            key={m.value}
            className={`mini ${st.markTool === m.value ? 'active' : ''} ${marking && st.markTool === m.value ? 'marking' : ''}`}
            disabled={!part}
            title={`${m.title}${marking && st.markTool === m.value ? ' (click again to stop marking)' : ''}`}
            onClick={() => choose(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {st.markTool === 'plane' && field('Tolerance', st.planeAngle, (planeAngle) => set({ planeAngle }), '°', { min: 0, max: 45, step: 0.5 })}
      {st.markTool === 'surface' && field('Max crease', st.angle, (angle) => set({ angle }), '°', { min: 0, max: 89 })}
      {st.markTool === 'brush' && field('Radius', st.brushRadius, (brushRadius) => set({ brushRadius }), 'mm', { min: 0.05, step: 0.5 })}
      {st.markTool === 'window' && (
        <label className="mark-check" title="Also mark triangles hidden behind others">
          <input type="checkbox" checked={st.windowThrough} onChange={(e) => set({ windowThrough: e.target.checked })} />
          Through
        </label>
      )}
      <button className={`mini ${marking ? 'primary' : ''}`} disabled={!part} onClick={() => (marking ? setState({ pickMode: null }) : startTriPick(PICK_FOR[st.markTool]))}>
        {marking ? 'Done' : 'Start'}
      </button>
      <span className="mark-count" title={part ? `${count.toLocaleString()} triangles marked on ${part.name}` : 'Select a part to mark'}>
        {part ? `${count.toLocaleString()} marked` : 'select a part'}
      </span>
      <span className="mark-sep" />
      <div className="mark-row-group">
        <button className="mini" disabled={!count} onClick={() => growMarked(1)} title="Add the triangles next to the marked area">Grow</button>
        <button className="mini" disabled={!count} onClick={shrinkMarked} title="Remove the outer ring of the marked area">Shrink</button>
        <button className="mini" disabled={!part} onClick={invertMarked} title="Mark everything that is not marked, and unmark the rest">Invert</button>
        <button className="mini" disabled={!part} onClick={markAll} title="Mark every triangle of the part">All</button>
        <button className="mini" disabled={!count} onClick={clearTriSelection} title="Unmark everything">Clear</button>
      </div>
      <span className="mark-sep" />
      <div className="mark-row-group">
        <button className="mini" disabled={!count} onClick={extractMarked} title="Copy the marked triangles into a new part">Extract</button>
        <button className="mini" disabled={!count || busy} onClick={() => livePreview(() => previewRemesh('marked'))} title="Remesh only the marked triangles (edge length from Remesh / Repair → Edit)">Remesh</button>
        <button className="mini danger" disabled={!count || busy} onClick={deleteSelectedTriangles} title="Delete the marked triangles from the part">Delete</button>
      </div>
    </div>
  );
}
