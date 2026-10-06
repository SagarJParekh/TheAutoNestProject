import { useState } from 'react';
import { Icon } from './icons';
import { Check, NumberField, Row, Segmented } from './controls';
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

type QualityPreset = 'original' | 'high' | 'medium' | 'low' | 'draft' | 'custom';
const QUALITY: Record<Exclude<QualityPreset, 'custom'>, number> = { original: 1, high: 0.75, medium: 0.5, low: 0.25, draft: 0.1 };

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function ExportDialog() {
  const open = useStore((s) => s.showExport);
  const selection = useStore((s) => s.selection);
  const parts = useStore((s) => s.parts);
  const selCount = selection.length;
  const total = parts.length;
  const [format, setFormat] = useState<'stl' | '3mf' | 'obj'>('stl');
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [zip, setZip] = useState(false);
  const [preset, setPreset] = useState<QualityPreset>('original');
  const [custom, setCustom] = useState(50);
  const [stlAscii, setStlAscii] = useState(false);
  const [decimals, setDecimals] = useState<'full' | '4' | '3' | '2'>('full');
  if (!open) return null;
  const effScope = selCount === 0 ? 'all' : scope;
  const chosen = effScope === 'all' ? parts : parts.filter((p) => selection.includes(p.id));
  const n = chosen.length;
  const tris = chosen.reduce((sum, p) => sum + p.mesh.indices.length / 3, 0);
  const verts = chosen.reduce((sum, p) => sum + p.mesh.positions.length / 3, 0);
  const ratio = preset === 'custom' ? Math.min(100, Math.max(1, custom)) / 100 : QUALITY[preset];
  const outTris = Math.round(tris * ratio);
  const outVerts = Math.round(verts * ratio);
  const text = format !== 'stl' || stlAscii;
  const dec = decimals === 'full' ? undefined : Number(decimals);
  const numLen = dec === undefined ? 11 : dec + 5;
  const size =
    format === 'stl'
      ? stlAscii
        ? outTris * (3 * (3 * numLen + 12) + 110)
        : 84 + outTris * 50
      : format === 'obj'
        ? outVerts * (3 * numLen + 4) + outTris * 24
        : (outVerts * (3 * numLen + 22) + outTris * 40) * 0.3; // 3MF is zipped
  const close = () => setState({ showExport: false });
  return (
    <Modal title="Export" onClose={close}>
      <div className="modal-body">
        <Row label="Format">
          <Segmented
            value={format}
            onChange={setFormat}
            options={[
              { value: 'stl', label: 'STL' },
              { value: '3mf', label: '3MF' },
              { value: 'obj', label: 'OBJ' },
            ]}
          />
        </Row>
        {format === 'stl' && (
          <Row label="STL encoding">
            <Segmented
              value={stlAscii ? 'ascii' : 'binary'}
              onChange={(v) => setStlAscii(v === 'ascii')}
              options={[
                { value: 'binary', label: 'Binary' },
                { value: 'ascii', label: 'ASCII' },
              ]}
            />
          </Row>
        )}
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
        <Row label="Quality">
          <Segmented
            value={preset}
            onChange={setPreset}
            options={[
              { value: 'original', label: 'Original' },
              { value: 'high', label: 'High' },
              { value: 'medium', label: 'Medium' },
              { value: 'low', label: 'Low' },
              { value: 'draft', label: 'Draft' },
              { value: 'custom', label: 'Custom' },
            ]}
          />
        </Row>
        {preset === 'custom' && (
          <Row label="Keep triangles">
            <NumberField value={custom} min={1} max={100} step={5} precision={0} suffix="%" onChange={(v) => setCustom(Math.round(v))} />
          </Row>
        )}
        {text && (
          <Row label="Coordinates">
            <Segmented
              value={decimals}
              onChange={setDecimals}
              options={[
                { value: 'full', label: 'Full' },
                { value: '4', label: '0.0001 mm' },
                { value: '3', label: '0.001 mm' },
                { value: '2', label: '0.01 mm' },
              ]}
            />
          </Row>
        )}
        <Row>
          <Check checked={zip} onChange={setZip}>
            One file per part (ZIP)
          </Check>
        </Row>
        <p className="muted small export-estimate">
          {ratio < 1
            ? `${Math.round(tris).toLocaleString()} → about ${outTris.toLocaleString()} triangles (${Math.round(ratio * 100)}%).`
            : `${Math.round(tris).toLocaleString()} triangles, unchanged.`}{' '}
          Estimated size ≈ {fmtBytes(size)}.
        </p>
        <p className="muted small">
          {ratio < 1 ? 'Triangles are reduced with quadric edge collapse: flat areas lose detail first, edges, borders and the overall shape are kept. ' : ''}
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
            exportParts(format, effScope, zip, { quality: ratio, stlAscii: format === 'stl' && stlAscii, decimals: text ? dec : undefined });
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
  ['L K D A S', 'Label, Texture, Measure, Align, Props'],
  ['I / N / U', 'Dimensions / Report / Offset & fillet'],
  ['Y', 'Pick and place: drag parts with the mouse (Shift: up/down, Ctrl: 1 mm steps)'],
  ['Enter / Backspace', 'Finish / undo point while drawing a cut line'],
  ['Ctrl+K or /', 'Search all functions'],
  ['Z', 'Zoom to area (drag a rectangle)'],
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
