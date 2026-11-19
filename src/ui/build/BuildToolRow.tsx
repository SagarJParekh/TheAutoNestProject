import { useState, type ReactNode } from 'react';
import { getState, setState, useStore } from '../../state/store';
import {
  arrayCopies, currentPrinter, deleteCopies, dropCopies, duplicateCopies, hideBuildSelection, lockTargets, rearrangeBuilds, rotateCopies, selectAllBuildParts,
  selectedBuildPartIds, setCopyLocks, showAllBuildParts, supportBuildParts,
} from '../../state/buildActions';
import { Icon } from '../icons';
import { NumberField } from '../controls';

/** One tool: icon above a short caption. */
function Tool({ icon, label, title, onClick, active, disabled, danger }: { icon: ReactNode; label: string; title: string; onClick: () => void; active?: boolean; disabled?: boolean; danger?: boolean }) {
  return (
    <button className={`bt-tool ${active ? 'active' : ''} ${danger ? 'danger' : ''}`} title={title} disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Group({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="bt-group">
      <div className="bt-tools">{children}</div>
      <div className="bt-caption">{caption}</div>
    </div>
  );
}

const axisIcon = (a: string) => (
  <span className="bt-axis">
    {Icon.rotate}
    <b>{a}</b>
  </span>
);

/**
 * Build generation: the everyday tools in one row above the view: how the
 * mouse edits copies (select, move, rotate, drag), quarter turns, duplicate /
 * array / delete copies, drop to the platform, nest, hide, lock and supports.
 */
export function BuildToolRow() {
  const workspace = useStore((s) => s.workspace);
  const edit = useStore((s) => s.buildEdit ?? 'select');
  const snap = useStore((s) => s.snap);
  const g = useStore((s) => s.buildGen);
  const selection = useStore((s) => s.selection);
  const supportEdit = useStore((s) => s.supportEdit);
  const busy = useStore((s) => s.buildGen.busy);
  const hidePlatform = useStore((s) => s.buildHidePlatform);
  const [arrayOpen, setArrayOpen] = useState(false);
  const [arr, setArr] = useState({ nx: 3, ny: 2, gx: 3, gy: 3 });
  if (workspace !== 'build') return null;
  void selection;
  const targets = lockTargets(getState());
  const n = targets.length;
  const has = n > 0;
  const parts = selectedBuildPartIds();
  const resin = currentPrinter(g).tech !== 'powder';
  const hidden = g.hidden?.length ?? 0;
  const setEdit = (buildEdit: 'select' | 'move' | 'rotate' | 'drag') => setState({ buildEdit, supportEdit: null });
  return (
    <div className="build-row" role="toolbar" aria-label="Build tools">
      <Group caption={n ? `Edit · ${n} selected` : 'Edit'}>
        <Tool icon={Icon.cursor} label="Select" title="Click parts to select them (Ctrl / Shift: several)" active={edit === 'select' && !supportEdit} onClick={() => setEdit('select')} />
        <Tool icon={Icon.move} label="Move" title="Move the selected copies with the arrows (Ctrl-click: several together)" active={edit === 'move'} onClick={() => setEdit('move')} />
        <Tool icon={Icon.rotate} label="Rotate" title="Turn the selected copies with the rings" active={edit === 'rotate'} onClick={() => setEdit('rotate')} />
        <Tool icon={Icon.hand} label="Drag" title="Drag copies across the platform (Shift-drag: up / down)" active={edit === 'drag'} onClick={() => setEdit('drag')} />
        <Tool
          icon={Icon.grid}
          label={snap.on ? `Snap ${snap.move} mm` : 'Snap'}
          title={`Snap moves to ${snap.move} mm and turns to ${snap.rotate}° (set the steps in the panel)`}
          active={snap.on}
          onClick={() => setState((s) => ({ snap: { ...s.snap, on: !s.snap.on } }))}
        />
      </Group>
      <Group caption="Turn 90°">
        <Tool icon={axisIcon('X')} label="X" title="Turn the selected copies 90° about X" disabled={!has} onClick={() => rotateCopies(0)} />
        <Tool icon={axisIcon('Y')} label="Y" title="Turn the selected copies 90° about Y" disabled={!has} onClick={() => rotateCopies(1)} />
        <Tool icon={axisIcon('Z')} label="Z" title="Turn the selected copies 90° about Z" disabled={!has} onClick={() => rotateCopies(2)} />
      </Group>
      <Group caption="Copies">
        <Tool icon={Icon.copy} label="Duplicate" title="One more copy beside each selected one" disabled={!has} onClick={() => duplicateCopies()} />
        <div className="bt-pop-host">
          <Tool icon={Icon.arrange} label="Array…" title="A grid of copies of the selected ones" disabled={!has} active={arrayOpen} onClick={() => setArrayOpen(!arrayOpen)} />
          {arrayOpen && (
            <div className="bt-pop">
              <div className="bt-pop-row">
                <NumberField label="Columns (X)" value={arr.nx} min={1} max={50} step={1} precision={0} onChange={(nx) => setArr({ ...arr, nx })} />
                <NumberField label="Rows (Y)" value={arr.ny} min={1} max={50} step={1} precision={0} onChange={(ny) => setArr({ ...arr, ny })} />
              </div>
              <div className="bt-pop-row">
                <NumberField label="Gap X" value={arr.gx} min={0} step={0.5} suffix="mm" onChange={(gx) => setArr({ ...arr, gx })} />
                <NumberField label="Gap Y" value={arr.gy} min={0} step={0.5} suffix="mm" onChange={(gy) => setArr({ ...arr, gy })} />
              </div>
              <button
                className="btn primary wide"
                disabled={!has || arr.nx * arr.ny < 2}
                onClick={() => {
                  arrayCopies(arr.nx, arr.ny, arr.gx, arr.gy);
                  setArrayOpen(false);
                }}
              >
                Make {arr.nx} × {arr.ny} array
              </button>
              <p className="muted small">Each selected copy becomes the first of the grid; the gaps are between the copies.</p>
            </div>
          )}
        </div>
        <Tool icon={Icon.trash} label="Delete" title="Delete the selected copies (a part's last copy removes the part)" disabled={!has} danger onClick={deleteCopies} />
      </Group>
      <Group caption="Place">
        <Tool icon={Icon.layflat} label="Drop" title="Drop the selected copies onto the platform" disabled={!has} onClick={dropCopies} />
        <Tool icon={Icon.arrange} label="Nest" title="Start nesting: arrange every part again (replaces edits by hand)" disabled={busy || !g.parts.length} onClick={rearrangeBuilds} />
        <Tool icon={Icon.fit} label="All" title="Select every part (or every copy while editing by hand)" disabled={!g.parts.length} onClick={selectAllBuildParts} />
      </Group>
      <Group caption="View">
        <Tool icon={Icon.eyeOff} label="Hide" title="Hide the selected parts / copies" disabled={!selection.length} onClick={hideBuildSelection} />
        <Tool icon={Icon.eye} label={hidden ? `Show (${hidden})` : 'Show'} title="Show everything again" disabled={!hidden} onClick={showAllBuildParts} />
        <Tool
          icon={Icon.grid}
          label="Platform"
          title={hidePlatform ? 'Show the platform (plate and grid) again' : 'Hide the platform (plate and grid), e.g. to look at the parts from below'}
          active={!hidePlatform}
          onClick={() => setState((s) => ({ buildHidePlatform: !s.buildHidePlatform }))}
        />
      </Group>
      <Group caption="Lock">
        <Tool icon={Icon.lock} label="Lock" title="Lock the selected copies where they are (nesting arranges the rest around them)" disabled={!has} onClick={() => setCopyLocks(targets, [true, true, true], [true, true, true])} />
        <Tool icon={Icon.unlock} label="Unlock" title="Unlock the selected copies" disabled={!has} onClick={() => setCopyLocks(targets, [false, false, false], [false, false, false])} />
      </Group>
      {resin && (
        <Group caption="Supports">
          <Tool icon={Icon.supports} label="Auto" title={parts.length ? 'Supports for the selected parts' : 'Supports for every part'} disabled={!g.parts.length} onClick={() => supportBuildParts(parts.length ? parts : undefined)} />
          <Tool icon={Icon.cursor} label="Edit" title="Select, move or delete single supports" active={supportEdit === 'select'} onClick={() => setState({ supportEdit: supportEdit === 'select' ? null : 'select', supportSel: [] })} />
          <Tool icon={Icon.brush} label="Manual" title="Click on the part to add supports" active={supportEdit === 'add'} onClick={() => setState({ supportEdit: supportEdit === 'add' ? null : 'add', supportSel: [] })} />
        </Group>
      )}
    </div>
  );
}
