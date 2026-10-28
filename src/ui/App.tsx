import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { Toolbar } from './Toolbar';
import { PartsPanel } from './PartsPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { ViewerCanvas } from './ViewerCanvas';
import { StatusBar, Notices, ProgressOverlay } from './StatusBar';
import { ClipWidget } from './panels/ClipCutPanel';
import { ExportDialog, ShortcutsDialog } from './Dialogs';
import { CommandPalette } from './CommandPalette';
import { HoverHelp } from './HoverHelp';
import { initBuildSession } from '../state/buildSession';
import { useShortcuts } from './shortcuts';
import { importFiles } from '../state/actions';
import { useStore } from '../state/store';
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
      className="app"
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
      {workspace === 'build' ? <BuildSetupPanel /> : <PartsPanel />}
      <main className="center">
        <ViewerCanvas />
        <ProgressOverlay />
        <ClipWidget />
        <Notices />
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
