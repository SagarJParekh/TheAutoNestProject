import { useState } from 'react';
import { Icon } from './icons';
import { useStore } from '../state/store';
import {
  OPACITY_LEVELS, setPartOpacity, deleteParts, duplicateParts, hideOthers, renamePart, showAllParts, repairParts, setRotationLock, select, selectAll, selectRange, setPartColor, toggleLocked, toggleVisible,
} from '../state/actions';
import { sendPartsToBuild } from '../state/buildActions';
import type { Part } from '../state/types';
import { meshEntry } from '../state/meshCache';

export function PartsPanel() {
  const parts = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const preview = useStore((s) => s.preview);
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
      {parts.length > 1 && (
        <div className="parts-vis">
          <button className="mini" onClick={() => hideOthers()} disabled={!selection.length || !parts.some((p) => !sel.has(p.id) && p.visible)} title="Hide every part except the selected ones (Shift+V)">
            {Icon.eyeOff} Hide others
          </button>
          <button className="mini" onClick={showAllParts} disabled={!parts.some((p) => !p.visible)} title="Show every part again (Shift+V)">
            {Icon.eye} Show all
          </button>
        </div>
      )}
      {selection.length > 0 && (
        <div className="parts-vis parts-opacity">
          <span className="muted">Selected:</span>
          {([
            [1, 'Solid'],
            [0.5, '50 %'],
            [0.25, 'X-ray'],
          ] as const).map(([o, label]) => (
            <button
              key={o}
              className={`mini ${parts.filter((p) => sel.has(p.id)).every((p) => (p.opacity ?? 1) === o) ? 'on' : ''}`}
              onClick={() => setPartOpacity(selection, o)}
              title={o === 1 ? 'Show the selected parts solid' : o === 0.5 ? 'Make the selected parts 50 % see-through' : 'Make the selected parts x-ray (25 %, outlined)'}
            >
              {label}
            </button>
          ))}
        </div>
      )}
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
      {parts.length > 0 && (
        <footer className="panel-foot parts-foot">
          {selection.length > 0 && (
            <div className="foot-row">
              <button className="btn" onClick={() => duplicateParts()} title="Duplicate (Ctrl+D)">
                {Icon.copy} Duplicate
              </button>
              <button className="btn danger" onClick={() => deleteParts()} title="Delete (Del)">
                {Icon.trash} Delete
              </button>
            </div>
          )}
          <div className="foot-row">
            <button
              className="btn"
              disabled={!!preview}
              onClick={() => repairParts(selection.length ? 'selected' : 'all')}
              title={selection.length ? 'Auto repair the selected parts together (one preview, one undo step)' : 'Auto repair every part together (one preview, one undo step)'}
            >
              {Icon.repair} {selection.length ? `Repair ${selection.length} selected` : 'Repair all'}
            </button>
            <button className="btn primary" onClick={sendPartsToBuild} title={selection.length ? 'Send the selected parts to Build generation' : 'Send all parts to Build generation'}>
              {Icon.export} {selection.length ? 'Send to Build' : 'Send all to Build'}
            </button>
          </div>
        </footer>
      )}
    </aside>
  );
}

function PartRow({ part, selected }: { part: Part; selected: boolean }) {
  const [editing, setEditing] = useState(false);
  useStore((s) => s.meshInfoVersion);
  const tris = part.mesh.indices.length / 3;
  const { watertight: wt, shells } = meshEntry(part.mesh);
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
      {wt === false && (
        <span className="part-status bad" title="Not print ready: not watertight — repair it first (Repair, or Repair all below)">
          {Icon.bottleEmpty}
        </span>
      )}
      {wt === true && (shells ?? 1) <= 1 && (
        <span className="part-status ok" title="Print ready: watertight">
          {Icon.bottleFull}
        </span>
      )}
      {wt === true && (shells ?? 1) > 1 && (
        <span className="part-status multi" title={`Print ready: watertight, made of ${shells} separate shells`}>
          {Icon.bottleStriped}
        </span>
      )}
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title={part.visible ? 'Hide' : 'Show'} onClick={() => toggleVisible(part.id)}>
          {part.visible ? Icon.eye : Icon.eyeOff}
        </button>
        <button
          className={`icon-btn ${part.opacity && part.opacity < 1 ? 'on' : ''}`}
          title={`Transparency: ${!part.opacity || part.opacity >= 1 ? 'solid' : part.opacity >= 0.5 ? '50 %' : 'x-ray (25 %)'} — click for ${!part.opacity || part.opacity >= 1 ? '50 %' : part.opacity >= 0.5 ? 'x-ray' : 'solid'}`}
          data-help-text="Transparency of this part: click to go from solid to 50 % see-through, to x-ray (25 %, outlined), and back to solid. It only changes how the part is shown."
          onClick={() => {
            const i = OPACITY_LEVELS.findIndex((o) => o === (part.opacity ?? 1));
            setPartOpacity([part.id], OPACITY_LEVELS[(Math.max(0, i) + 1) % OPACITY_LEVELS.length]);
          }}
        >
          {Icon.transparency}
        </button>
        <button
          className={`icon-btn ${part.lockRotation ? 'on' : ''}`}
          title={part.lockRotation ? 'Orientation locked (can only be moved) — click to unlock' : 'Lock orientation (moves only, no rotation)'}
          onClick={() => setRotationLock([part.id], !part.lockRotation)}
        >
          {Icon.rotLock}
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
