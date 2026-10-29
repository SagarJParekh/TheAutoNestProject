import { Hint, NumberField, Row, Section, Segmented } from '../controls';
import { startLasso } from '../../state/editActions';
import { PolylineCut } from './PolylineCut';
import { getState, setState, useStore } from '../../state/store';
import { executeCut, previewCut, resetCutPlanes } from '../../state/actions';
import { AxisCuts } from './PlaneControls';
import { JointCut } from './JointCut';
import type { Part } from '../../state/types';
import { live } from '../../state/livePreview';

export function CutPanel({ parts }: { parts: Part[] }) {
  const plane = useStore((s) => s.cutPlane);
  const gap = useStore((s) => s.settings.cut.gap);
  const preview = useStore((s) => s.preview);
  const target = parts.find((p) => !p.locked);
  const all = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const scoped = (plane.scope ?? 'all') === 'all' ? all.filter((p) => p.visible && !p.locked) : all.filter((p) => selection.includes(p.id) && !p.locked);
  const busy = useStore((s) => s.jobs.length > 0);
  const mode = useStore((s) => s.settings.cutMode);
  const lassoing = useStore((s) => s.lassoMode);
  const drawing = useStore((s) => s.polyMode);
  const snap = useStore((s) => s.settings.cutSnap);
  const setMode = (cutMode: 'plane' | 'lasso' | 'polyline' | 'joint') =>
    setState({ settings: { ...getState().settings, cutMode }, preview: null, lassoMode: false, polyMode: false });
  const modes = (
    <Segmented
      value={mode}
      onChange={setMode}
      options={[
        { value: 'plane', label: 'Plane' },
        { value: 'polyline', label: 'Draw line' },
        { value: 'lasso', label: 'Lasso' },
        { value: 'joint', label: 'Joint', title: 'Advanced cuts: lap and tongue joints' },
      ]}
    />
  );
  if (mode === 'joint')
    return (
      <Section title="Cut">
        {modes}
        {!target && <Hint>Select one unlocked part to cut.</Hint>}
        <JointCut target={target} />
      </Section>
    );
  if (mode === 'polyline')
    return (
      <Section title="Cut">
        {modes}
        {!target && <Hint>Select one unlocked part to cut.</Hint>}
        <PolylineCut target={target} drawing={drawing} preview={!!preview} snap={snap} />
      </Section>
    );
  if (mode === 'lasso')
    return (
      <Section title="Cut">
        {modes}
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
      {modes}
      <AxisCuts kind="cut" value={plane} parts={scoped.length ? scoped : all} onChange={(p) => setState({ cutPlane: p, preview: null })}>
        <Row label="Gap">
          <NumberField
            value={gap}
            min={0}
            suffix="mm"
            onChange={(g) => setState({ settings: { ...getState().settings, cut: { gap: g } }, preview: null })}
            title="Move the pieces apart after cutting"
          />
        </Row>
        {!scoped.length && <Hint>{(plane.scope ?? 'all') === 'all' ? 'No unlocked parts to cut.' : 'Select the parts to cut.'}</Hint>}
        <div className="btn-row axis-buttons">
          <button className="btn" disabled={!scoped.length || !!preview || busy} onClick={() => live(previewCut)} title="Show the pieces first; Apply or Cancel on the preview card">
            Preview
          </button>
          <button className="btn primary" disabled={!scoped.length || busy} onClick={() => executeCut()} title="Cut now (undo with Ctrl+Z)">
            Execute cut
          </button>
          <button className="btn" onClick={resetCutPlanes} title="Planes back through the middle of the parts">
            Reset
          </button>
        </div>
      </AxisCuts>
      <Hint>
        Click an axis icon to switch that plane on, choose the side or switch it off; ‹ › step by 1 mm (Shift: 10 mm). Every plane that is on cuts the
        parts: X and Y give four pieces, X, Y and Z eight. Angled plane cuts with one plane at any angle. The cut faces are capped.
      </Hint>
    </Section>
  );
}
