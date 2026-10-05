import { Hint, NumberField, Row, Section, Segmented } from '../controls';
import { startLasso } from '../../state/editActions';
import { getState, setState, useStore } from '../../state/store';
import { previewCut } from '../../state/actions';
import { PlaneControls } from './PlaneControls';
import type { Part } from '../../state/types';

export function CutPanel({ parts }: { parts: Part[] }) {
  const plane = useStore((s) => s.cutPlane);
  const gap = useStore((s) => s.settings.cut.gap);
  const preview = useStore((s) => s.preview);
  const target = parts.find((p) => !p.locked);
  const mode = useStore((s) => s.settings.cutMode);
  const lassoing = useStore((s) => s.lassoMode);
  const setMode = (cutMode: 'plane' | 'lasso') => setState({ settings: { ...getState().settings, cutMode }, preview: null, lassoMode: false });
  if (mode === 'lasso')
    return (
      <Section title="Cut">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'plane', label: 'Plane' }, { value: 'lasso', label: 'Lasso' }]} />
        {!target && <Hint>Select one unlocked part to cut.</Hint>}
        <button className={`btn primary wide ${lassoing ? '' : ''}`} disabled={!target || !!preview} onClick={startLasso}>
          {lassoing ? 'Drawing… (Esc to cancel)' : 'Draw lasso…'}
        </button>
        <Hint>
          Turn the view so you look at the part from the direction you want to cut, then drag a freehand outline around the area. Everything inside the
          outline (all the way through the part, along your line of sight) becomes one piece, the rest another. Needs a watertight part.
        </Hint>
      </Section>
    );
  return (
    <Section title="Cut">
      <Segmented value={mode} onChange={setMode} options={[{ value: 'plane', label: 'Plane' }, { value: 'lasso', label: 'Lasso' }]} />
      {!target && <Hint>Select one unlocked part to cut.</Hint>}
      <PlaneControls value={plane} parts={target ? [target] : []} onChange={(p) => setState({ cutPlane: p, preview: null })} />
      <Row label="Gap">
        <NumberField
          value={gap}
          min={0}
          suffix="mm"
          onChange={(g) => setState({ settings: { ...getState().settings, cut: { gap: g } }, preview: null })}
          title="Move the two halves apart after cutting"
        />
      </Row>
      <button className="btn primary wide" disabled={!target || !!preview} onClick={previewCut}>
        Preview cut
      </button>
      <Hint>Splits the part into two closed parts; the cut faces are capped. Use the tilt sliders (or Free) to angle the plane.</Hint>
    </Section>
  );
}
