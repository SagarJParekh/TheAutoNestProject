import { Check, Hint, Section } from '../controls';
import { setState, useStore } from '../../state/store';
import { PlaneControls } from './PlaneControls';

export function ClipPanel() {
  const enabled = useStore((s) => s.clipEnabled);
  const clip = useStore((s) => s.clip);
  const all = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  // position the plane relative to the selection when there is one
  const parts = selection.length ? all.filter((p) => selection.includes(p.id)) : all;
  return (
    <Section title="Section clip">
      <Check checked={enabled} onChange={(clipEnabled) => setState({ clipEnabled })}>
        Enable section plane
      </Check>
      <PlaneControls value={clip} parts={parts} onChange={(c) => setState({ clip: c, clipEnabled: true })} />
      <Hint>Non-destructive: hides everything on one side of the plane and caps the cross-section. Geometry is unchanged.</Hint>
    </Section>
  );
}
