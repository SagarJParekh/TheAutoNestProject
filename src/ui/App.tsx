import { useCallback, useState, type DragEvent } from 'react';
import { Toolbar } from './Toolbar';
import { PartsPanel } from './PartsPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { ViewerCanvas } from './ViewerCanvas';
import { StatusBar, Notices } from './StatusBar';
import { ExportDialog, ShortcutsDialog } from './Dialogs';
import { CommandPalette } from './CommandPalette';
import { useShortcuts } from './shortcuts';
import { importFiles } from '../state/actions';

export function App() {
  const [dragging, setDragging] = useState(false);
  const openFile = useCallback(() => (document.querySelector('.toolbar input[type=file]') as HTMLInputElement | null)?.click(), []);
  useShortcuts(openFile);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
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
      <PartsPanel />
      <main className="center">
        <ViewerCanvas />
        <Notices />
      </main>
      <PropertiesPanel />
      <StatusBar />
      <ExportDialog />
      <ShortcutsDialog />
      <CommandPalette />
      {dragging && (
        <div className="drop-overlay">
          <div>
            <strong>Drop files to import</strong>
            <span>Everything is processed locally in your browser — nothing is uploaded.</span>
          </div>
        </div>
      )}
    </div>
  );
}
