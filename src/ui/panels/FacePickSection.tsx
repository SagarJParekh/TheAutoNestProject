import { NumberField, Row } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { regrowFace } from '../../state/actions';

export function FacePickSection({ tool }: { tool: 'extrude' | 'perforate' }) {
  const fs = useStore((s) => s.faceSelection);
  const pickMode = useStore((s) => s.pickMode);
  const tol = useStore((s) => s.settings[tool].angleTolerance);
  return (
    <>
      <button className={`btn wide ${pickMode === 'face' ? 'primary' : ''}`} onClick={() => setState({ pickMode: pickMode === 'face' ? null : 'face' })}>
        {pickMode === 'face' ? 'Click a face in the viewport…' : fs ? 'Pick another face' : 'Pick face…'}
      </button>
      {fs && (
        <p className="muted small">
          Selected {fs.tris.length.toLocaleString()} triangles · {fs.area.toFixed(1)} mm²
        </p>
      )}
      <Row label="Angle tolerance">
        <NumberField
          value={tol}
          min={0}
          max={89}
          step={0.5}
          suffix="°"
          title="Grow the selection across neighbouring triangles within this angle of the picked face"
          onChange={(v) => {
            const s = getState();
            setState({ settings: { ...s.settings, [tool]: { ...s.settings[tool], angleTolerance: v } } });
            regrowFace();
          }}
        />
      </Row>
    </>
  );
}
