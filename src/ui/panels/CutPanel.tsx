import { Hint, NumberField, Row, Section } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { previewCut } from '../../state/actions';
import { PlaneControls } from './PlaneControls';
import type { Part } from '../../state/types';

export function CutPanel({ parts }: { parts: Part[] }) {
  const plane = useStore((s) => s.cutPlane);
  const gap = useStore((s) => s.settings.cut.gap);
  const preview = useStore((s) => s.preview);
  const target = parts.find((p) => !p.locked);
  return (
    <Section title="Cut">
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
      <Hint>Splits the part into two closed parts; the cut faces are capped.</Hint>
    </Section>
  );
}
