import { useEffect } from 'react';
import { getState, redo, setState, undo, updateParts } from '../state/store';
import {
  applyPreview, cancelPreview, centerOnOrigin, deleteParts, dropToBed, duplicateParts, selectAll, setTool,
} from '../state/actions';
import { viewerApi } from '../viewer/api';
import type { DisplayMode, ToolId } from '../state/types';

const TOOL_KEYS: Record<string, ToolId> = {
  t: 'transform', c: 'clip', x: 'cut', r: 'repair', h: 'hollow', p: 'perforate', e: 'extrude', l: 'label', k: 'texture', d: 'measure', a: 'align', s: 'props', i: 'dimensions', n: 'report',
};
const MODES: DisplayMode[] = ['shaded', 'edges', 'wireframe', 'xray'];

export function useShortcuts(openFile: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // only text entry swallows shortcuts; checkboxes, sliders and buttons do not
      if (t && t.tagName === 'INPUT') {
        const type = (t as HTMLInputElement).type;
        if (!['checkbox', 'radio', 'range', 'color', 'button'].includes(type)) return;
        if (type === 'range' && e.key.startsWith('Arrow')) return;
      }
      if (t && (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const s = getState();
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod) {
        if (k === 'z' && !e.shiftKey) undo();
        else if ((k === 'z' && e.shiftKey) || k === 'y') redo();
        else if (k === 'a') selectAll();
        else if (k === 'd') duplicateParts();
        else if (k === 'o') openFile();
        else if (k === 'e') setState({ showExport: true });
        else if (k === 'k') setState({ showSearch: true });
        else return;
        e.preventDefault();
        return;
      }
      if (e.altKey) return;
      switch (true) {
        case e.key === 'Escape':
          if (s.showExport || s.showShortcuts || s.showSearch) setState({ showExport: false, showShortcuts: false, showSearch: false });
          else if (s.lassoMode) setState({ lassoMode: false });
          else if (s.polyMode) setState({ polyMode: false });
          else if (s.zoomWindow) setState({ zoomWindow: false });
          else if (s.tool === 'measure' && (s.measurePending.entities.length || s.measurePending.points.length))
            setState({ measurePending: { entities: [], points: [] } });
          else if (s.pickMode) setState({ pickMode: null });
          else if (s.preview) cancelPreview();
          else if (s.faceSelection) setState({ faceSelection: null });
          else setState({ selection: [] });
          break;
        case e.key === 'Enter':
          if (s.polyMode) viewerApi.current?.viewer?.finishPolyline();
          else if (s.preview) applyPreview();
          break;
        case e.key === 'Delete' || e.key === 'Backspace':
          if (s.polyMode) viewerApi.current?.viewer?.undoPolyPoint();
          else deleteParts();
          break;
        case e.key === '/':
          setState({ showSearch: true });
          break;
        case e.key === '?':
          setState({ showShortcuts: !s.showShortcuts });
          break;
        case e.key === 'Home':
          viewerApi.current?.fitView();
          break;
        case k === 'f' && e.shiftKey:
          viewerApi.current?.fitView(true);
          break;
        case k === 'c' && e.shiftKey:
          centerOnOrigin();
          break;
        case k === 'w':
          setTool('transform');
          setState({ gizmo: 'translate' });
          break;
        case k === 'q':
          setTool('transform');
          setState({ gizmo: 'rotate' });
          break;
        case k === 'f':
          setTool('transform');
          setState({ pickMode: s.pickMode === 'layflat' ? null : 'layflat' });
          break;
        case k === 'b':
          dropToBed();
          break;
        case k === 'z':
          setState({ zoomWindow: !s.zoomWindow });
          break;
        case k === 'o':
          setState({ orthographic: !s.orthographic });
          break;
        case k === 'g':
          setState({ showGrid: !s.showGrid });
          break;
        case k === 'm':
          setState({ display: MODES[(MODES.indexOf(s.display) + 1) % MODES.length] });
          break;
        case k === 'v':
          if (s.selection.length) updateParts('Toggle visibility', s.selection, (p) => ({ ...p, visible: !p.visible }));
          break;
        case ['1', '2', '3', '4'].includes(e.key):
          viewerApi.current?.setView((['top', 'front', 'side', 'iso'] as const)[Number(e.key) - 1]);
          break;
        case k in TOOL_KEYS: {
          const tool = TOOL_KEYS[k];
          setTool(s.tool === tool && tool !== 'transform' ? 'transform' : tool);
          break;
        }
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openFile]);
}
