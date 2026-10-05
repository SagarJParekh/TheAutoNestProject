import { useEffect, useRef } from 'react';
import { Viewer } from '../viewer/Viewer';
import { viewerApi } from '../viewer/api';
import { getState, setState, setTransform, useStore } from '../state/store';
import { layFlat, pickFace, requestEdges, select } from '../state/actions';
import { pickFaceFor } from '../state/repairActions';
import { onPointPick } from '../state/featureActions';
import { onMeasurePick } from '../state/measureActions';
import { onLassoDone, onTrianglePick, onVertexPick } from '../state/editActions';

const SLOT_TEXT: Record<string, string> = {
  primary: 'Click a face to select it',
  flip: 'Click the faces whose normals should be flipped',
  alignSource: 'Click a face on the part you want to move',
  alignTarget: 'Click the face to align it to (on another part)',
  propsA: 'Click the face the props start from',
  propsB: 'Click the face or shell the props should reach',
  texture: 'Click the face to texture',
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

export function ViewerCanvas() {
  const ref = useRef<HTMLDivElement>(null);
  const pickMode = useStore((s) => s.pickMode);
  const zooming = useStore((s) => s.zoomWindow);
  const lassoing = useStore((s) => s.lassoMode);
  const measuring = useStore((s) => s.tool === 'measure');

  useEffect(() => {
    const el = ref.current!;
    const viewer = new Viewer(el, {
      onPick(info, mods) {
        const s = getState();
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
    });
    viewer.edgeRequest = requestEdges;
    viewerApi.current = { fitView: (sel) => viewer.fitView(sel), setView: (v) => viewer.setView(v), viewer };
    viewer.sync(getState());
    const unsub = useStore.subscribe((s) => viewer.sync(s));
    (window as unknown as { __viewer: Viewer; __store: typeof useStore }).__viewer = viewer;
    (window as unknown as { __store: typeof useStore }).__store = useStore;
    return () => {
      unsub();
      viewerApi.current = null;
      viewer.dispose();
    };
  }, []);

  return (
    <div className={`viewport ${pickMode || measuring ? 'picking' : ''} ${zooming ? 'zooming' : ''} ${lassoing ? 'lassoing' : ''}`} ref={ref}>
      {lassoing && (
        <div className="pick-banner">
          Drag around the area to cut out
          <button onClick={() => setState({ lassoMode: false })}>Cancel (Esc)</button>
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
          {pickMode === 'triangle' && 'Click triangles to select or deselect them'}
          {pickMode === 'vertex' && 'Click three corners to create a triangle'}
          <button onClick={() => setState({ pickMode: null })}>Done (Esc)</button>
        </div>
      )}
    </div>
  );
}
