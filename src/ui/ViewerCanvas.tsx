import { useEffect, useRef } from 'react';
import { Viewer } from '../viewer/Viewer';
import { viewerApi } from '../viewer/api';
import { getState, setState, setTransform, useStore } from '../state/store';
import { layFlat, pickFace, requestEdges, select } from '../state/actions';
import { pickFaceFor } from '../state/repairActions';

const SLOT_TEXT: Record<string, string> = {
  primary: 'Click a face to select it',
  flip: 'Click the faces whose normals should be flipped',
  alignSource: 'Click a face on the part you want to move',
  alignTarget: 'Click the face to align it to (on another part)',
  propsA: 'Click the face the props start from',
  propsB: 'Click the face or shell the props should reach',
};

function FaceBanner() {
  const slot = useStore((s) => s.pickSlot);
  return <>{SLOT_TEXT[slot]}</>;
}

export function ViewerCanvas() {
  const ref = useRef<HTMLDivElement>(null);
  const pickMode = useStore((s) => s.pickMode);

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
    });
    viewer.edgeRequest = requestEdges;
    viewerApi.current = { fitView: (sel) => viewer.fitView(sel), setView: (v) => viewer.setView(v) };
    viewer.sync(getState());
    const unsub = useStore.subscribe((s) => viewer.sync(s));
    (window as unknown as { __viewer: Viewer }).__viewer = viewer;
    return () => {
      unsub();
      viewerApi.current = null;
      viewer.dispose();
    };
  }, []);

  return (
    <div className={`viewport ${pickMode ? 'picking' : ''}`} ref={ref}>
      {pickMode && (
        <div className="pick-banner">
          {pickMode === 'layflat' && 'Click a face to lay it flat on the bed'}
          {pickMode === 'face' && <FaceBanner />}
          {pickMode === 'drain' && 'Click on the surface to place a drain hole'}
          <button onClick={() => setState({ pickMode: null })}>Done (Esc)</button>
        </div>
      )}
    </div>
  );
}
