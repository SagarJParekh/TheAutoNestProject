import { Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { clearBlendEdges, previewBlend, startSharpEdgePick } from '../../state/modifyActions';
import type { Part } from '../../state/types';
import { live } from '../../state/livePreview';

/** Fillet & chamfer: round or bevel picked sharp edges. */
export function BlendPanel({ parts }: { parts: Part[] }) {
  const bl = useStore((s) => s.settings.blend);
  const preview = useStore((s) => s.preview);
  const pickMode = useStore((s) => s.pickMode);
  const allEdges = useStore((s) => s.blendEdges);
  const allParts = useStore((s) => s.parts);
  const edges = allEdges.filter((e) => allParts.find((p) => p.id === e.partId)?.mesh === e.mesh);
  const target = parts.find((p) => !p.locked);
  const setB = (patch: Partial<typeof bl>) => setState({ settings: { ...getState().settings, blend: { ...getState().settings.blend, ...patch } }, preview: null });
  return (
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
      <button className="btn primary wide" disabled={!edges.length || !!preview} onClick={() => live(previewBlend)}>
        Preview {bl.kind}
      </button>
      <Hint>
        Click near sharp, straight edges between flat faces (click again to remove one). Outside edges are rounded or bevelled by cutting material away;
        inside edges get material added. The part must be watertight.
      </Hint>
    </Section>
  );
}
