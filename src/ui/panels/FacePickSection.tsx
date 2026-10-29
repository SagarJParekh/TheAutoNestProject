import { NumberField, Row } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { cancelPreview, regrowFace } from '../../state/actions';

export function FacePickSection({ tool }: { tool: 'extrude' | 'perforate' }) {
  const fs = useStore((s) => s.faceSelection);
  const pickMode = useStore((s) => s.pickMode);
  const tol = useStore((s) => s.settings[tool].angleTolerance);
  const multi = tool === 'extrude';
  return (
    <>
      <button className={`btn wide ${pickMode === 'face' ? 'primary' : ''}`} onClick={() => setState({ pickMode: pickMode === 'face' ? null : 'face', pickSlot: 'primary' })}>
        {pickMode === 'face'
          ? multi
            ? 'Click faces… (click here to finish)'
            : 'Click a face in the viewport…'
          : multi
            ? fs
              ? 'Add / remove faces…'
              : 'Pick faces…'
            : fs
              ? 'Pick another face'
              : 'Pick face…'}
      </button>
      {fs && (
        <p className="muted small">
          Selected {multi && (fs.groups?.length ?? 1) > 1 ? `${fs.groups!.length} faces · ` : ''}
          {fs.tris.length.toLocaleString()} triangles · {fs.area.toFixed(1)} mm²{' '}
        </p>
      )}
      {multi && (
        <button
          className="btn wide"
          disabled={!fs}
          onClick={() => {
            cancelPreview();
            setState({ faceSelection: null, pickMode: getState().pickMode === 'face' ? null : getState().pickMode });
          }}
        >
          Clear selection
        </button>
      )}
      {multi && <p className="muted small">Click several faces to extrude them together; click a picked face again to drop it.</p>}
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
