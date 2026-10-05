import { useState } from 'react';
import { Icon } from './icons';
import { useStore } from '../state/store';
import {
  deleteParts, duplicateParts, renamePart, select, selectAll, selectRange, setPartColor, toggleLocked, toggleVisible,
} from '../state/actions';
import type { Part } from '../state/types';

export function PartsPanel() {
  const parts = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const sel = new Set(selection);
  return (
    <aside className="panel left">
      <header className="panel-head">
        <h2>Parts</h2>
        <span className="muted">{parts.length}</span>
        <div className="grow" />
        <button className="mini" onClick={selectAll} disabled={!parts.length} title="Select all (Ctrl+A)">
          All
        </button>
        <button className="mini" onClick={() => select(null)} disabled={!selection.length} title="Select none">
          None
        </button>
      </header>
      <div className="parts-list" role="listbox" aria-multiselectable>
        {parts.length === 0 && (
          <div className="empty">
            <p>No parts yet.</p>
            <p className="muted">Drop files anywhere or use Open. STL, OBJ, PLY, 3MF, AMF, 3DM, STEP, IGES, BREP, GLB/GLTF, OFF.</p>
          </div>
        )}
        {parts.map((p) => (
          <PartRow key={p.id} part={p} selected={sel.has(p.id)} />
        ))}
      </div>
      {selection.length > 0 && (
        <footer className="panel-foot">
          <button className="btn" onClick={() => duplicateParts()} title="Duplicate (Ctrl+D)">
            {Icon.copy} Duplicate
          </button>
          <button className="btn danger" onClick={() => deleteParts()} title="Delete (Del)">
            {Icon.trash} Delete
          </button>
        </footer>
      )}
    </aside>
  );
}

function PartRow({ part, selected }: { part: Part; selected: boolean }) {
  const [editing, setEditing] = useState(false);
  const tris = part.mesh.indices.length / 3;
  return (
    <div
      className={`part-row ${selected ? 'selected' : ''} ${part.visible ? '' : 'hidden-part'}`}
      role="option"
      aria-selected={selected}
      onClick={(e) => {
        if (e.shiftKey) selectRange(part.id);
        else select(part.id, e.ctrlKey || e.metaKey ? 'toggle' : 'set');
      }}
    >
      <label className="swatch" style={{ background: part.color }} title="Change colour" onClick={(e) => e.stopPropagation()}>
        <input type="color" value={part.color} onChange={(e) => setPartColor(part.id, e.target.value)} />
      </label>
      <div className="part-name">
        {editing ? (
          <input
            autoFocus
            defaultValue={part.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setEditing(false);
              const v = e.target.value.trim();
              if (v && v !== part.name) renamePart(part.id, v);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span onDoubleClick={() => setEditing(true)} title={`${part.name} — double-click to rename`}>
            {part.name}
          </span>
        )}
        <small className="muted">{tris.toLocaleString()} tris</small>
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title={part.visible ? 'Hide' : 'Show'} onClick={() => toggleVisible(part.id)}>
          {part.visible ? Icon.eye : Icon.eyeOff}
        </button>
        <button className={`icon-btn ${part.locked ? 'on' : ''}`} title={part.locked ? 'Unlock' : 'Lock'} onClick={() => toggleLocked(part.id)}>
          {part.locked ? Icon.lock : Icon.unlock}
        </button>
        <button className="icon-btn" title="Duplicate" onClick={() => duplicateParts([part.id])}>
          {Icon.copy}
        </button>
        <button className="icon-btn" title="Delete" disabled={part.locked} onClick={() => deleteParts([part.id])}>
          {Icon.trash}
        </button>
      </div>
    </div>
  );
}
