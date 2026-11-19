import { useState } from 'react';
import { setState, useStore } from '../../state/store';
import { clearTriSelection } from '../../state/editActions';
import { MarkControls } from './EditTabs';
import { Icon } from '../icons';

/**
 * Mark triangles from any tool: a card in the view (like the section clip)
 * with the Repair → Edit mark tools. The marked triangles stay while tools
 * change, and functions that work on a surface (Remesh, Surface to solid)
 * can use them.
 */
export function MarkWidget() {
  const on = useStore((s) => s.markBar);
  const tool = useStore((s) => s.tool);
  const repairTab = useStore((s) => s.repairTab);
  const workspace = useStore((s) => s.workspace);
  const all = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const te = useStore((s) => s.triEdit);
  const pickMode = useStore((s) => s.pickMode);
  const [open, setOpen] = useState(true);
  // Repair → Edit has the same tools in its panel
  if (workspace !== 'prep' || !all.length || (tool === 'repair' && repairTab === 'edit')) return null;
  const markedPart = te && all.find((p) => p.id === te.partId && p.mesh === te.mesh);
  const part = markedPart && te.tris.length ? markedPart : (all.find((p) => p.id === selection[0]) ?? (all.length === 1 ? all[0] : null));
  const count = te && markedPart ? te.tris.length : 0;
  if (!on)
    return (
      <button className="clip-chip" onClick={() => setState({ markBar: true })} title="Mark triangles (as in Repair → Edit) from any tool, e.g. to remesh only them">
        {Icon.brush} Mark{count ? ` (${count.toLocaleString()})` : ''}
      </button>
    );
  const marking = pickMode === 'triangle' || pickMode === 'brush' || pickMode === 'window';
  return (
    <div className="clip-widget mark-widget">
      <header>
        <button className="mini" onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'}
        </button>
        <strong>Mark triangles</strong>
        {count > 0 && <span className="muted small">{count.toLocaleString()} marked</span>}
        <div className="grow" />
        <button
          className="mini"
          onClick={() => {
            if (marking) setState({ pickMode: null });
            clearTriSelection();
            setState({ markBar: false });
          }}
          title="Close the mark tools and clear the marks"
        >
          Off
        </button>
      </header>
      {open && (
        <div className="clip-widget-body">
          {part ? <MarkControls part={part} compact /> : <p className="muted small">Select the part to mark (click it in the parts list or the view).</p>}
        </div>
      )}
    </div>
  );
}
