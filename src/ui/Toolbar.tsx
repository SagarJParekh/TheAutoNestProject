import { useRef, type ReactNode } from 'react';
import { Icon } from './icons';
import { getState, redo, setState, undo, useStore } from '../state/store';
import { importFiles, setImportQuality, setTool } from '../state/actions';
import { viewerApi } from '../viewer/api';
import { importableExtensions } from '../loaders/registry';
import type { DisplayMode, ToolId } from '../state/types';

const TOOLS: { id: ToolId; label: string; icon: ReactNode; key: string }[] = [
  { id: 'transform', label: 'Transform', icon: Icon.transform, key: 'T' },
  { id: 'clip', label: 'Clip', icon: Icon.clip, key: 'C' },
  { id: 'cut', label: 'Cut', icon: Icon.cut, key: 'X' },
  { id: 'repair', label: 'Repair', icon: Icon.repair, key: 'R' },
  { id: 'hollow', label: 'Hollow', icon: Icon.hollow, key: 'H' },
  { id: 'perforate', label: 'Perforate', icon: Icon.perforate, key: 'P' },
  { id: 'extrude', label: 'Extrude', icon: Icon.extrude, key: 'E' },
  { id: 'label', label: 'Label', icon: Icon.label, key: 'L' },
  { id: 'texture', label: 'Texture', icon: Icon.texture, key: 'K' },
  { id: 'measure', label: 'Measure', icon: Icon.measure, key: 'D' },
];

export function Toolbar() {
  const fileRef = useRef<HTMLInputElement>(null);
  const tool = useStore((s) => s.tool);
  const gizmo = useStore((s) => s.gizmo);
  const display = useStore((s) => s.display);
  const ortho = useStore((s) => s.orthographic);
  const grid = useStore((s) => s.showGrid);
  const zooming = useStore((s) => s.zoomWindow);
  const importQuality = useStore((s) => s.settings.importQuality);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const undoLabel = useStore((s) => s.past[s.past.length - 1]?.label);
  const redoLabel = useStore((s) => s.future[0]?.label);
  const accept = [...importableExtensions(), 'f3d', 'bin'].map((e) => '.' + e).join(',');

  return (
    <header className="toolbar">
      <div className="brand">
        {Icon.cube}
        <span>AutoNest&nbsp;Prep</span>
      </div>
      <div className="tb-group">
        <button className="tb" title="Open files (Ctrl+O)" onClick={() => fileRef.current?.click()}>
          {Icon.open}
          <span>Open</span>
        </button>
        <select
          className="tb-select"
          value={importQuality}
          title="Tessellation quality for STEP / IGES / BREP imports (finer = more triangles)"
          onChange={(e) => setImportQuality(e.target.value as 'draft' | 'normal' | 'fine' | 'ultra')}
        >
          <option value="draft">CAD: Draft</option>
          <option value="normal">CAD: Normal</option>
          <option value="fine">CAD: Fine</option>
          <option value="ultra">CAD: Ultra</option>
        </select>
        <button className="tb" title="Export (Ctrl+E)" onClick={() => setState({ showExport: true })}>
          {Icon.export}
          <span>Export</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={accept}
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) importFiles(files);
          }}
        />
      </div>
      <div className="tb-group">
        <button className="tb icon" disabled={!canUndo} title={`Undo ${undoLabel ?? ''} (Ctrl+Z)`} onClick={undo}>
          {Icon.undo}
        </button>
        <button className="tb icon" disabled={!canRedo} title={`Redo ${redoLabel ?? ''} (Ctrl+Shift+Z)`} onClick={redo}>
          {Icon.redo}
        </button>
      </div>
      <div className="tb-group">
        <button
          className={`tb icon ${tool === 'transform' && gizmo === 'translate' ? 'active' : ''}`}
          title="Move gizmo (W)"
          onClick={() => {
            setTool('transform');
            setState({ gizmo: 'translate' });
          }}
        >
          {Icon.move}
        </button>
        <button
          className={`tb icon ${tool === 'transform' && gizmo === 'rotate' ? 'active' : ''}`}
          title="Rotate gizmo (Q)"
          onClick={() => {
            setTool('transform');
            setState({ gizmo: 'rotate' });
          }}
        >
          {Icon.rotate}
        </button>
        <button
          className="tb icon"
          title="Lay flat: click a face (F)"
          onClick={() => {
            setTool('transform');
            setState({ pickMode: getState().pickMode === 'layflat' ? null : 'layflat' });
          }}
        >
          {Icon.layflat}
        </button>
      </div>
      <div className="tb-group tools">
        {TOOLS.filter((t) => t.id !== 'transform').map((t) => (
          <button key={t.id} className={`tb ${tool === t.id ? 'active' : ''}`} title={`${t.label} (${t.key})`} onClick={() => setTool(tool === t.id ? 'transform' : t.id)}>
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="tb-spacer" />
      <div className="tb-group">
        <button className="tb icon" title="Fit to view (Home)" onClick={() => viewerApi.current?.fitView()}>
          {Icon.fit}
        </button>
        <button className={`tb icon ${zooming ? 'active' : ''}`} title="Zoom to area: drag a rectangle (Z)" onClick={() => setState({ zoomWindow: !zooming })}>
          {Icon.zoomArea}
        </button>
        <select className="tb-select" value="" onChange={(e) => e.target.value && viewerApi.current?.setView(e.target.value as never)} title="Standard views (1-4)">
          <option value="">View…</option>
          <option value="top">Top (1)</option>
          <option value="front">Front (2)</option>
          <option value="side">Right (3)</option>
          <option value="iso">Iso (4)</option>
          <option value="back">Back</option>
          <option value="bottom">Bottom</option>
        </select>
        <button className={`tb ${ortho ? 'active' : ''}`} title="Toggle orthographic (O)" onClick={() => setState({ orthographic: !ortho })}>
          <span>{ortho ? 'Ortho' : 'Persp'}</span>
        </button>
        <select className="tb-select" value={display} onChange={(e) => setState({ display: e.target.value as DisplayMode })} title="Display mode (M)">
          <option value="shaded">Shaded</option>
          <option value="edges">Shaded + edges</option>
          <option value="wireframe">Wireframe</option>
          <option value="xray">X-ray</option>
        </select>
        <button className={`tb icon ${grid ? 'active' : ''}`} title="Toggle grid (G)" onClick={() => setState({ showGrid: !grid })}>
          {Icon.grid}
        </button>
        <button className="tb icon" title="Keyboard shortcuts (?)" onClick={() => setState({ showShortcuts: true })}>
          {Icon.help}
        </button>
      </div>
    </header>
  );
}
