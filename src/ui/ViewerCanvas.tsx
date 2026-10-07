import { useEffect, useRef } from 'react';
import { Viewer } from '../viewer/Viewer';
import { viewerApi } from '../viewer/api';
import { getState, setState, setTransform, updateParts, useStore, type AppState } from '../state/store';
import { buildDisplayParts, currentPrinter, partOfKey, selectBuildPart } from '../state/buildActions';
import type { Part } from '../state/types';
import { layFlat, pickFace, requestEdges, select } from '../state/actions';
import { pickFaceFor } from '../state/repairActions';
import { onPointPick } from '../state/featureActions';
import { onMeasurePick } from '../state/measureActions';
import { onSharpEdgePick } from '../state/modifyActions';
import { onBridgeEdgePick, onBrush, onLassoDone, onPolylineDone, onTrianglePick, onVertexPick, onWindowMark } from '../state/editActions';

const SLOT_TEXT: Record<string, string> = {
  primary: 'Click a face to select it',
  flip: 'Click the faces whose normals should be flipped',
  alignSource: 'Click a face on the part you want to move',
  alignTarget: 'Click the face to align it to (on another part)',
  propsA: 'Click the face the props start from',
  propsB: 'Click the face or shell the props should reach',
  texture: 'Click the face to texture',
  offset: 'Click the face to offset',
};

const POINT_TEXT: Record<string, string> = {
  label: 'Click where the label should go',
  propStart: 'Click the point where the prop starts',
  propEnd: 'Click the point where the prop ends',
  perfPoint: 'Click to add hole locations (click Done when finished)',
};

function PointBanner() {
  const slot = useStore((s) => s.pointSlot);
  return <>{POINT_TEXT[slot]}</>;
}

function FaceBanner() {
  const slot = useStore((s) => s.pickSlot);
  return <>{SLOT_TEXT[slot]}</>;
}

/**
 * What the viewer shows: the Prep parts, or in Build Generation the parts of
 * the active build inside the printer's build volume (no editing tools).
 */
let lastBuild: { gen: AppState['buildGen']; parts: Part[] } | null = null;
let lastView: { src: AppState; view: AppState } | null = null;
function viewState(s: AppState): AppState {
  if (s.workspace !== 'build') return s;
  if (lastView && lastView.src === s) return lastView.view;
  if (!lastBuild || lastBuild.gen !== s.buildGen) lastBuild = { gen: s.buildGen, parts: buildDisplayParts(s.buildGen) };
  const printer = currentPrinter(s.buildGen);
  const view: AppState = {
    ...s,
    parts: lastBuild.parts,
    tool: 'build',
    pickMode: null,
    preview: null,
    selection: (() => {
      const ids = new Set(s.selection.map(partOfKey));
      return lastBuild.parts.filter((p) => ids.has(partOfKey(p.id))).map((p) => p.id);
    })(),
    clipEnabled: false,
    zoomWindow: false,
    lassoMode: false,
    polyMode: false,
    buildView: { volume: printer.volume, margin: s.buildGen.margin, zOffset: s.buildGen.zOffset },
  };
  lastView = { src: s, view };
  return view;
}

export function ViewerCanvas() {
  const ref = useRef<HTMLDivElement>(null);
  const pickMode = useStore((s) => s.pickMode);
  const zooming = useStore((s) => s.zoomWindow);
  const lassoing = useStore((s) => s.lassoMode);
  const drawing = useStore((s) => s.polyMode);
  const measuring = useStore((s) => s.tool === 'measure');
  const placing = useStore((s) => s.tool === 'transform' && s.gizmo === 'place' && !s.pickMode);

  useEffect(() => {
    const el = ref.current!;
    const viewer = new Viewer(el, {
      onPick(info, mods) {
        const s = getState();
        if (s.workspace === 'build') {
          // Build generation: clicks only select parts (Ctrl / Shift toggles)
          selectBuildPart(info?.partId ?? null, mods.ctrl || mods.shift);
          return;
        }
        if (s.pickMode === 'layflat') {
          if (info) layFlat(info.partId, info.normal);
          return;
        }
        if (s.pickMode === 'face') {
          if (info) {
            if (s.pickSlot === 'primary') pickFace(info.partId, info.faceIndex);
            else pickFaceFor(s.pickSlot, info.partId, info.faceIndex);
          }
          return;
        }
        if (s.pickMode === 'triangle') {
          if (info) onTrianglePick(info);
          return;
        }
        if (s.pickMode === 'sharpEdge') {
          if (info) onSharpEdgePick(info);
          return;
        }
        if (s.pickMode === 'edge') {
          if (info) onBridgeEdgePick(info);
          return;
        }
        if (s.pickMode === 'vertex') {
          onVertexPick(info, mods.clientX, mods.clientY);
          return;
        }
        if (s.pickMode === 'point') {
          if (info) onPointPick(info);
          return;
        }
        if (s.tool === 'measure' && !s.pickMode) {
          if (info) onMeasurePick(info);
          return;
        }
        if (s.pickMode === 'drain') {
          if (info) {
            const h = s.settings.hollow;
            setState({
              settings: { ...s.settings, hollow: { ...h, drainHoles: [...h.drainHoles, { point: info.point, normal: info.normal }] } },
              preview: null,
            });
          }
          return;
        }
        if (!info) {
          if (!mods.shift && !mods.ctrl) select(null);
          return;
        }
        select(info.partId, mods.ctrl ? 'toggle' : mods.shift ? 'add' : 'set');
      },
      onTransformEnd(id, t) {
        setTransform(id, t, 'Move / rotate');
      },
      onZoomDone() {
        setState({ zoomWindow: false });
      },
      onLasso(points) {
        onLassoDone(points);
      },
      onBrush(info, erase) {
        onBrush(info, erase);
      },
      onRect(x0, y0, x1, y1, erase) {
        onWindowMark(x0, y0, x1, y1, erase);
      },
      onPolyline(points) {
        onPolylineDone(points);
      },
      onPlaceEnd(moves) {
        const at = new Map(moves.map((m) => [m.id, m.position]));
        updateParts(moves.length > 1 ? `Place ${moves.length} parts` : 'Place part', [...at.keys()], (p) => ({
          ...p,
          transform: { ...p.transform, position: at.get(p.id)! },
        }));
      },
    });
    viewer.edgeRequest = requestEdges;
    viewerApi.current = { fitView: (sel) => viewer.fitView(sel), setView: (v) => viewer.setView(v), viewer };
    viewer.sync(viewState(getState()));
    const unsub = useStore.subscribe((s) => viewer.sync(viewState(s)));
    (window as unknown as { __viewer: Viewer; __store: typeof useStore }).__viewer = viewer;
    (window as unknown as { __store: typeof useStore }).__store = useStore;
    return () => {
      unsub();
      viewerApi.current = null;
      viewer.dispose();
    };
  }, []);

  return (
    <div className={`viewport ${pickMode || measuring ? 'picking' : ''} ${zooming ? 'zooming' : ''} ${lassoing || drawing ? 'lassoing' : ''} ${placing ? 'placing' : ''}`} ref={ref}>
      {lassoing && (
        <div className="pick-banner">
          Drag around the area to cut out
          <button onClick={() => setState({ lassoMode: false })}>Cancel (Esc)</button>
        </div>
      )}
      {drawing && (
        <div className="pick-banner">
          Click points across the part · Shift snaps angles · double-click / Enter to finish
          <button onClick={() => viewerApi.current?.viewer?.undoPolyPoint()}>Undo point</button>
          <button onClick={() => viewerApi.current?.viewer?.finishPolyline()}>Finish</button>
          <button onClick={() => setState({ polyMode: false })}>Cancel (Esc)</button>
        </div>
      )}
      {zooming && (
        <div className="pick-banner">
          Drag a rectangle to zoom into
          <button onClick={() => setState({ zoomWindow: false })}>Cancel (Esc)</button>
        </div>
      )}
      {pickMode && (
        <div className="pick-banner">
          {pickMode === 'layflat' && 'Click a face to lay it flat on the bed'}
          {pickMode === 'face' && <FaceBanner />}
          {pickMode === 'drain' && 'Click on the surface to place a drain hole'}
          {pickMode === 'point' && <PointBanner />}
          {pickMode === 'triangle' && 'Click to mark triangles · click a marked one (or Ctrl-click) to unmark'}
          {pickMode === 'brush' && 'Drag over the surface to mark · Ctrl-drag to unmark · drag empty space to orbit'}
          {pickMode === 'window' && 'Drag a rectangle to mark · Ctrl-drag to unmark · right-drag to orbit'}
          {pickMode === 'vertex' && 'Click three corners to create a triangle'}
          {pickMode === 'sharpEdge' && 'Click near sharp edges to fillet / chamfer them (click again to remove)'}
          {pickMode === 'edge' && 'Click next to open edges to add them to the current side (click again to remove)'}
          <button onClick={() => setState({ pickMode: null })}>Done (Esc)</button>
        </div>
      )}
    </div>
  );
}
