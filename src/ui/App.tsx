import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { Toolbar } from './Toolbar';
import { PartsPanel } from './PartsPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { ViewerCanvas } from './ViewerCanvas';
import { StatusBar, Notices, ProgressOverlay } from './StatusBar';
import { ClipWidget } from './panels/ClipCutPanel';
import { MarkRow } from './panels/MarkWidget';
import { BuildToolRow } from './build/BuildToolRow';
import { ExportDialog, ShortcutsDialog } from './Dialogs';
import { CommandPalette } from './CommandPalette';
import { HoverHelp } from './HoverHelp';
import { initBuildSession } from '../state/buildSession';
import { useShortcuts } from './shortcuts';
import { importFiles } from '../state/actions';
import { setState, useStore } from '../state/store';
import { BuildSetupPanel, BuildsPanel } from './build/BuildPanels';

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (es: FsEntry[]) => void, err: (e: unknown) => void) => void };
}

/** Files from dropped files / folders, each tagged with its path inside the drop (relPath). */
async function filesFromEntries(entries: FsEntry[]): Promise<File[]> {
  const out: File[] = [];
  const walk = async (en: FsEntry): Promise<void> => {
    if (en.isFile && en.file) {
      const f = await new Promise<File | null>((ok) => en.file!(ok, () => ok(null)));
      if (f) {
        Object.defineProperty(f, 'relPath', { value: en.fullPath, configurable: true });
        out.push(f);
      }
    } else if (en.isDirectory && en.createReader) {
      const reader = en.createReader();
      for (;;) {
        const batch = await new Promise<FsEntry[]>((ok) => reader.readEntries(ok, () => ok([])));
        if (!batch.length) break;
        for (const c of batch) await walk(c);
      }
    }
  };
  for (const en of entries) await walk(en);
  return out;
}

export function App() {
  const [dragging, setDragging] = useState(false);
  const workspace = useStore((s) => s.workspace);
  const collapsed = useStore((s) => s.panelsCollapsed);
  const toggle = (side: 'left' | 'right') =>
    setState((s) => {
      const panelsCollapsed = { ...s.panelsCollapsed, [side]: !s.panelsCollapsed[side] };
      try {
        localStorage.setItem('autonest.panels', JSON.stringify(panelsCollapsed));
      } catch {
        /* the choice is just not remembered */
      }
      return { panelsCollapsed };
    });
  // the view keeps its size in step with the panels
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    return () => cancelAnimationFrame(id);
  }, [collapsed.left, collapsed.right]);
  const openFile = useCallback(() => (document.querySelector('.toolbar input[type=file]') as HTMLInputElement | null)?.click(), []);
  useShortcuts(openFile);
  useEffect(() => {
    void initBuildSession();
  }, []);

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // folders: walk them so each file keeps its path inside the dropped folder
    const entries: FsEntry[] = [];
    for (const it of Array.from(e.dataTransfer.items ?? [])) {
      const en = it.kind === 'file' ? (it.webkitGetAsEntry?.() as unknown as FsEntry | null) : null;
      if (en) entries.push(en);
    }
    const plainFiles = Array.from(e.dataTransfer.files ?? []);
    const files = entries.some((en) => en.isDirectory) ? await filesFromEntries(entries) : plainFiles;
    if (files.length) importFiles(files);
  };

  return (
    <div
      className={`app ${collapsed.left ? 'left-collapsed' : ''} ${collapsed.right ? 'right-collapsed' : ''}`}
      style={{ ...(collapsed.left ? { ['--lw' as string]: '0px' } : {}), ...(collapsed.right ? { ['--rw' as string]: '0px' } : {}) }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !(e.relatedTarget && (e.currentTarget as Node).contains(e.relatedTarget as Node))) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <Toolbar />
      <UpdateBanner />
      {workspace === 'build' ? <BuildSetupPanel /> : <PartsPanel />}
      <main className="center">
        {/* triangle marking, usable with every function (Mesh prep) */}
        <MarkRow />
        <BuildToolRow />
        <div className="center-view">
          <ViewerCanvas />
          <ProgressOverlay />
          <button className="panel-toggle left" onClick={() => toggle('left')} title={collapsed.left ? 'Show the left panel' : 'Hide the left panel (more room for the view)'}>
            {collapsed.left ? '›' : '‹'}
          </button>
          <button className="panel-toggle right" onClick={() => toggle('right')} title={collapsed.right ? 'Show the right panel' : 'Hide the right panel (more room for the view)'}>
            {collapsed.right ? '‹' : '›'}
          </button>
          <div className="view-tools">
            <ClipWidget />
          </div>
          <Notices />
        </div>
      </main>
      {workspace === 'build' ? <BuildsPanel /> : <PropertiesPanel />}
      <StatusBar />
      <ExportDialog />
      <ShortcutsDialog />
      <CommandPalette />
      <HoverHelp />
      {dragging && (
        <div className="drop-overlay">
          <div>
            <strong>{workspace === 'build' ? 'Drop files to add them to the builds' : 'Drop files to import'}</strong>
            <span>Everything is processed locally in your browser — nothing is uploaded.</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** A newer version of the app is online: reload when convenient (or now, when something failed to load). */
function UpdateBanner() {
  const update = useStore((s) => s.updateAvailable);
  if (!update) return null;
  return (
    <div className={`update-banner ${update}`} role="alert">
      <span>
        {update === 'required'
          ? 'AutoNest was updated since this page was opened, and this page can no longer load what it needs (e.g. to import files). Reload to use the new version.'
          : 'A new version of AutoNest is available.'}{' '}
        <span className="muted">Your Build generation session is kept; export or save Mesh prep work you need first.</span>
      </span>
      <button className="btn primary" onClick={() => location.reload()}>
        Reload now
      </button>
      {update === 'available' && (
        <button className="btn" onClick={() => setState({ updateAvailable: null })}>
          Later
        </button>
      )}
    </div>
  );
}
