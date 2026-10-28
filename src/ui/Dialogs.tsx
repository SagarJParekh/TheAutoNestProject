import { useEffect, useState } from 'react';
import { canPickFolder, canPickLocation, chooseFolder, folderName, savedFolder, saveMode, setSaveMode } from '../state/save';
import type { SaveMode } from '../state/save';
import { Icon } from './icons';
import { NumberField, Row, Segmented } from './controls';
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

/** Where exported files go: ask each time, a remembered folder, or Downloads. */
export function SaveLocationRow() {
  const [mode, setMode] = useState<SaveMode>(saveMode());
  const [folder, setFolder] = useState<string | null>(folderName());
  useEffect(() => {
    savedFolder().then((h) => setFolder(h?.name ?? null));
  }, []);
  if (!canPickLocation && !canPickFolder)
    return (
      <p className="muted small">
        Files go to your browser's Downloads folder. To choose a folder each time, turn on “Ask where to save each file” in the browser's download
        settings, or use Chrome / Edge, which let this page ask directly.
      </p>
    );
  const options: { value: SaveMode; label: string }[] = [
    ...(canPickLocation ? [{ value: 'ask' as const, label: 'Ask where' }] : []),
    ...(canPickFolder ? [{ value: 'folder' as const, label: folder ? `Folder: ${folder}` : 'A folder…' }] : []),
    { value: 'downloads', label: 'Downloads' },
  ];
  const pick = async () => {
    const name = await chooseFolder();
    if (name) {
      setFolder(name);
      setMode('folder');
    }
  };
  return (
    <>
      <Row label="Save to">
        <Segmented
          value={mode}
          onChange={async (m) => {
            if (m === 'folder' && !folder) return pick();
            setSaveMode(m);
            setMode(m);
          }}
          options={options}
        />
      </Row>
      {canPickFolder && (
        <Row>
          <button className="mini" onClick={pick} title="Choose the folder exports are saved into">
            {folder ? 'Change folder…' : 'Choose folder…'}
          </button>
          <span className="muted small">
            {mode === 'ask' ? 'You pick the folder and file name for every export.' : mode === 'folder' ? `Saved straight into “${folder}”.` : 'Saved to the browser’s Downloads folder.'}
          </span>
        </Row>
      )}
    </>
  );
}

export function ExportDialog() {
  const open = useStore((s) => s.showExport);
  const selection = useStore((s) => s.selection);
  const parts = useStore((s) => s.parts);
  const selCount = selection.length;
  const total = parts.length;
  const [format, setFormat] = useState<'stl' | '3mf' | 'obj' | 'slc'>('stl');
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [output, setOutput] = useState<'one' | 'separate' | 'zip'>('one');
  const [layer, setLayer] = useState(0.05);
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
  const slc = format === 'slc';
  const text = !slc && (format !== 'stl' || stlAscii);
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
              { value: 'slc', label: 'SLC', title: 'Slice contours for SLA / DLP printers' },
            ]}
          />
        </Row>
        {slc && (
          <Row label="Layer thickness">
            <NumberField value={layer} min={0.005} step={0.005} precision={3} suffix="mm" title="Height of each slice (layer) in the SLC file" onChange={(v) => setLayer(Math.max(0.005, v))} />
          </Row>
        )}
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
        {!slc && <Row label="Quality">
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
        </Row>}
        {!slc && preset === 'custom' && (
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
        <Row label="Output">
          <Segmented
            value={output}
            onChange={setOutput}
            options={[
              { value: 'one', label: 'One file', title: 'All parts in one file' },
              { value: 'separate', label: 'Separate files', title: 'Every part as its own file, saved into a folder' },
              { value: 'zip', label: 'ZIP', title: 'Every part as its own file, packed in a ZIP' },
            ]}
          />
        </Row>
        {output === 'separate' ? (
          <p className="muted small">
            {canPickFolder
              ? `Every part is saved as its own file (part name${slc ? '.slc' : `.${format}`}) into a folder: the export folder set below, or one you choose when you press Export.`
              : 'Every part is saved as its own file; this browser puts them in Downloads (it may ask once to allow several downloads).'}
          </p>
        ) : (
          <SaveLocationRow />
        )}
        {!slc && <p className="muted small export-estimate">
          {ratio < 1
            ? `${Math.round(tris).toLocaleString()} → about ${outTris.toLocaleString()} triangles (${Math.round(ratio * 100)}%).`
            : `${Math.round(tris).toLocaleString()} triangles, unchanged.`}{' '}
          Estimated size ≈ {fmtBytes(size)}.
        </p>}
        <p className="muted small">
          {ratio < 1 ? 'Triangles are reduced with quadric edge collapse: flat areas lose detail first, edges, borders and the overall shape are kept. ' : ''}
          Transforms are baked in. Repaired parts are saved as name_repaired.{' '}
          {slc ? `SLC: the parts are sliced every ${layer} mm into closed contours (outer outlines counter-clockwise, holes clockwise)${output === 'one' && n > 1 ? ', all parts together in one file' : ''}.` : ''}
          {format === 'stl' && output === 'one' && n > 1 ? 'All parts are merged into one STL.' : ''}
          {format !== 'stl' && !slc && output === 'one' && n > 1 ? 'Parts are kept as separate objects in one file.' : ''}
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
            exportParts(format, effScope, output, { quality: ratio, stlAscii: format === 'stl' && stlAscii, decimals: text ? dec : undefined, layer });
          }}
        >
          Export {n} part{n === 1 ? '' : 's'}{output === 'separate' && n > 1 ? ` (${n} files)` : ''}
        </button>
      </footer>
    </Modal>
  );
}

export const SHORTCUTS: [string, string][] = [
  ['Left click', 'Select a part (Ctrl / Shift-click: add or remove)'],
  ['Left drag', 'Box select: left→right takes parts fully inside, right→left also parts it touches'],
  ['Middle drag', 'Pan (2D, in the screen plane)'],
  ['Right drag', 'Rotate the view (3D)'],
  ['Mouse wheel', 'Zoom in / out at the cursor'],
  ['Ctrl+O', 'Open files'],
  ['Ctrl+E', 'Export'],
  ['Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y', 'Undo / redo'],
  ['Ctrl+A', 'Select all'],
  ['Ctrl+D', 'Duplicate selected'],
  ['Shift+V', 'Hide all parts except the selected / show all again'],
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
