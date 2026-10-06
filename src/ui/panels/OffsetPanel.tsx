import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { clearBlendEdges, previewBlend, previewOffset, startSharpEdgePick } from '../../state/modifyActions';
import { PickButton } from './RepairTabs';
import type { Part } from '../../state/types';

export function OffsetPanel({ parts }: { parts: Part[] }) {
  const st = useStore((s) => s.settings.offset);
  const bl = useStore((s) => s.settings.blend);
  const preview = useStore((s) => s.preview);
  const pickMode = useStore((s) => s.pickMode);
  const allEdges = useStore((s) => s.blendEdges);
  const allParts = useStore((s) => s.parts);
  const edges = allEdges.filter((e) => allParts.find((p) => p.id === e.partId)?.mesh === e.mesh);
  const target = parts.find((p) => !p.locked);
  const setO = (patch: Partial<typeof st>) => setState({ settings: { ...getState().settings, offset: { ...getState().settings.offset, ...patch } }, preview: null });
  const setB = (patch: Partial<typeof bl>) => setState({ settings: { ...getState().settings, blend: { ...getState().settings.blend, ...patch } }, preview: null });
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
            <button className="btn primary wide" disabled={!target || !!preview || !st.distance} onClick={previewOffset}>
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
            <PickButton slot="offset" label="Pick face to offset" />
            <button className="btn primary wide" disabled={!!preview || !st.distance} onClick={previewOffset}>
              Preview face offset
            </button>
            <Hint>Moves the picked face (flat or curved) along its normals by the distance; side walls keep the part closed.</Hint>
          </>
        )}
      </Section>
      <Section title="Fillet & chamfer">
        <Segmented
          value={bl.kind}
          onChange={(kind) => setB({ kind })}
          options={[
            { value: 'fillet', label: 'Fillet (round)' },
            { value: 'chamfer', label: 'Chamfer (bevel)' },
          ]}
        />
        <Row label={bl.kind === 'fillet' ? 'Radius' : 'Distance'}>
          <NumberField value={bl.size} min={0.01} step={0.5} suffix="mm" onChange={(size) => setB({ size })} />
        </Row>
        <button className={`btn wide ${pickMode === 'sharpEdge' ? 'primary' : ''}`} disabled={!target && pickMode !== 'sharpEdge'} onClick={startSharpEdgePick}>
          {pickMode === 'sharpEdge' ? 'Done picking edges' : 'Pick edges…'}
        </button>
        <div className="pick-row">
          <span className="muted small">{edges.length ? `${edges.length} edge${edges.length > 1 ? 's' : ''} picked` : 'No edges picked'}</span>
          {edges.length > 0 && (
            <button className="mini" onClick={clearBlendEdges}>
              Clear
            </button>
          )}
        </div>
        <button className="btn primary wide" disabled={!edges.length || !!preview} onClick={previewBlend}>
          Preview {bl.kind}
        </button>
        <Hint>
          Click near sharp, straight edges between flat faces (click again to remove one). Outside edges are rounded or bevelled by cutting material away;
          inside edges get material added. The part must be watertight.
        </Hint>
      </Section>
    </>
  );
}
