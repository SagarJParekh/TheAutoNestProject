import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { previewOffset } from '../../state/modifyActions';
import { PickButton } from './RepairTabs';
import { clearPick } from '../../state/repairActions';
import { cancelPreview } from '../../state/actions';
import type { Part } from '../../state/types';
import { live } from '../../state/livePreview';

export function OffsetPanel({ parts }: { parts: Part[] }) {
  const st = useStore((s) => s.settings.offset);
  const preview = useStore((s) => s.preview);
  const target = parts.find((p) => !p.locked);
  const picked = useStore((s) => !!s.facePicks.offset);
  const setO = (patch: Partial<typeof st>) => setState({ settings: { ...getState().settings, offset: { ...getState().settings.offset, ...patch } }, preview: null });
  return (
    <>
      <Section title="Offset">
        <Segmented
          value={st.mode}
          onChange={(mode) => setO({ mode })}
          options={[
            { value: 'global', label: 'Global (whole part)' },
            { value: 'local', label: 'Local (a face)' },
          ]}
        />
        <Row label="Distance">
          <NumberField value={st.distance} step={0.5} suffix="mm" title="Positive grows / pushes out, negative shrinks / pulls in" onChange={(distance) => setO({ distance })} />
        </Row>
        {st.mode === 'global' ? (
          <>
            <Row label="Voxel size">
              <NumberField value={st.voxel} min={0} step={0.05} precision={3} suffix="mm" title="0 = automatic. Smaller keeps more detail but is slower" onChange={(voxel) => setO({ voxel })} />
            </Row>
            <Check checked={st.asCopy} onChange={(asCopy) => setO({ asCopy })}>
              Keep the original (add the offset as a new part)
            </Check>
            <button className="btn primary wide" disabled={!target || !!preview || !st.distance} onClick={() => live(previewOffset)}>
              Preview offset
            </button>
            <Hint>
              Grows (+) or shrinks (−) the whole part by the distance, like a shell offset: outside corners become rounded with that radius. Works on closed
              parts; the surface is rebuilt on a voxel grid (voxel size 0 = automatic).
            </Hint>
          </>
        ) : (
          <>
            <Check checked={st.smooth} onChange={(smooth) => setO({ smooth })}>
              Grow across smooth curvature
            </Check>
            {st.smooth && (
              <Row label="Max crease">
                <NumberField value={st.angle} min={1} max={89} suffix="°" onChange={(angle) => setO({ angle })} />
              </Row>
            )}
            <PickButton slot="offset" label="Pick faces to offset" multi />
            <button
              className="btn wide"
              disabled={!picked}
              onClick={() => {
                cancelPreview();
                clearPick('offset');
                if (getState().pickMode === 'face') setState({ pickMode: null });
              }}
            >
              Clear selection
            </button>
            <button className="btn primary wide" disabled={!!preview || !st.distance} onClick={() => live(previewOffset)}>
              Preview face offset
            </button>
            <Hint>Click one or more faces (flat or curved; click a picked face again to drop it). They move along their normals by the distance; side walls keep the part closed.</Hint>
          </>
        )}
      </Section>
    </>
  );
}
