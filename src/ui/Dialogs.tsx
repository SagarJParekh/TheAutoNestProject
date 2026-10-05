import { useState } from 'react';
import { Icon } from './icons';
import { Check, Row, Segmented } from './controls';
import { setState, useStore } from '../state/store';
import { exportParts } from '../state/actions';

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            {Icon.close}
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function ExportDialog() {
  const open = useStore((s) => s.showExport);
  const selCount = useStore((s) => s.selection.length);
  const total = useStore((s) => s.parts.length);
  const [format, setFormat] = useState<'stl' | '3mf' | 'obj'>('stl');
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [zip, setZip] = useState(false);
  if (!open) return null;
  const effScope = selCount === 0 ? 'all' : scope;
  const n = effScope === 'all' ? total : selCount;
  const close = () => setState({ showExport: false });
  return (
    <Modal title="Export" onClose={close}>
      <div className="modal-body">
        <Row label="Format">
          <Segmented
            value={format}
            onChange={setFormat}
            options={[
              { value: 'stl', label: 'STL (binary)' },
              { value: '3mf', label: '3MF' },
              { value: 'obj', label: 'OBJ' },
            ]}
          />
        </Row>
        <Row label="Parts">
          <Segmented
            value={effScope}
            onChange={setScope}
            options={[
              { value: 'selected', label: `Selected (${selCount})` },
              { value: 'all', label: `All (${total})` },
            ]}
          />
        </Row>
        <Row>
          <Check checked={zip} onChange={setZip}>
            One file per part (ZIP)
          </Check>
        </Row>
        <p className="muted small">
          Transforms are baked in. {format === 'stl' && !zip && n > 1 ? 'All parts are merged into one STL.' : ''}
          {format !== 'stl' && !zip && n > 1 ? 'Parts are kept as separate objects in one file.' : ''}
        </p>
      </div>
      <footer className="modal-foot">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={n === 0}
          onClick={() => {
            close();
            exportParts(format, effScope, zip);
          }}
        >
          Export {n} part{n === 1 ? '' : 's'}
        </button>
      </footer>
    </Modal>
  );
}

export const SHORTCUTS: [string, string][] = [
  ['Ctrl+O', 'Open files'],
  ['Ctrl+E', 'Export'],
  ['Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y', 'Undo / redo'],
  ['Ctrl+A', 'Select all'],
  ['Ctrl+D', 'Duplicate selected'],
  ['Delete / Backspace', 'Delete selected'],
  ['W / Q', 'Move / rotate gizmo'],
  ['F', 'Lay flat (click a face)'],
  ['B', 'Drop to bed'],
  ['Shift+C', 'Centre on origin'],
  ['T C X R H P E', 'Transform, Clip, Cut, Repair, Hollow, Perforate, Extrude'],
  ['1 2 3 4', 'Top, front, right, iso view'],
  ['Home / Shift+F', 'Fit all / fit selection'],
  ['O', 'Perspective / orthographic'],
  ['M', 'Cycle display mode'],
  ['G', 'Toggle grid'],
  ['V', 'Hide/show selected'],
  ['Enter / Esc', 'Apply / cancel preview, leave pick mode'],
  ['?', 'This help'],
];

export function ShortcutsDialog() {
  const open = useStore((s) => s.showShortcuts);
  if (!open) return null;
  return (
    <Modal title="Keyboard shortcuts" onClose={() => setState({ showShortcuts: false })}>
      <table className="shortcuts">
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
