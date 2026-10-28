import { Check, Hint, Section } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { centeredPlane } from '../../state/math';
import { AxisCuts } from './PlaneControls';

export function ClipPanel() {
  const enabled = useStore((s) => s.clipEnabled);
  const clip = useStore((s) => s.clip);
  const all = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  // position the planes relative to the selection when there is one
  const parts = selection.length ? all.filter((p) => selection.includes(p.id)) : all;
  return (
    <Section title="Section clip">
      <Check checked={enabled} onChange={(clipEnabled) => setState({ clipEnabled })}>
        Enable section clip
      </Check>
      <AxisCuts kind="clip" value={clip} parts={parts} onChange={(c) => setState({ clip: c, clipEnabled: true })}>
        <div className="btn-row axis-buttons">
          <button className="btn" onClick={() => resetClip(parts)} title="Planes back through the middle of the parts, keeping the lower side">
            Reset
          </button>
        </div>
      </AxisCuts>
      <Hint>
        Non-destructive: hides everything past the planes and caps the cross-sections. Click an axis icon to switch it on, choose the side or switch it
        off; ‹ › step by 1 mm (Shift: 10 mm). The clip also works over previews in every tool (Section clip card in the view).
      </Hint>
    </Section>
  );
}

export function resetClip(parts: Parameters<typeof centeredPlane>[1]) {
  const c = centeredPlane(getState().clip, parts.length ? parts : getState().parts);
  const r = c.rows;
  setState({ clip: { ...c, rows: r && { x: { ...r.x, flip: false }, y: { ...r.y, flip: false }, z: { ...r.z, flip: false } } } });
}
