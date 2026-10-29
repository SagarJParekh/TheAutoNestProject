import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { previewHollow } from '../../state/actions';
import type { Part, ToolSettings } from '../../state/types';
import { live } from '../../state/livePreview';

export function HollowPanel({ parts }: { parts: Part[] }) {
  const h = useStore((s) => s.settings.hollow);
  const pickMode = useStore((s) => s.pickMode);
  const preview = useStore((s) => s.preview);
  const target = parts.length === 1 && !parts[0].locked ? parts[0] : null;
  const set = (patch: Partial<ToolSettings['hollow']>) =>
    setState({ settings: { ...getState().settings, hollow: { ...getState().settings.hollow, ...patch } }, preview: null });
  return (
    <Section title="Hollow">
      {!target && <Hint>Select one unlocked, watertight part.</Hint>}
      <Row label="Wall thickness">
        <NumberField value={h.thickness} min={0.2} step={0.5} suffix="mm" onChange={(thickness) => set({ thickness })} />
      </Row>
      <Row label="Resolution">
        <Segmented
          value={h.quality}
          onChange={(quality) => set({ quality })}
          options={[
            { value: 'draft', label: 'Draft', title: 'Up to 3M voxels, 2.5 across the wall' },
            { value: 'normal', label: 'Normal', title: 'Up to 12M voxels, 3 across the wall' },
            { value: 'fine', label: 'Fine', title: 'Up to 40M voxels, 4 across the wall (slow, needs memory)' },
          ]}
        />
      </Row>
      <h4>Drain holes</h4>
      <Row label="Diameter">
        <NumberField value={h.drainDiameter} min={0.5} step={0.5} suffix="mm" title="Hole size at the outer surface" onChange={(drainDiameter) => set({ drainDiameter })} />
      </Row>
      <Row label="Exit size">
        <NumberField value={h.drainExit} min={0} step={0.5} suffix="mm" title="Hole size where it reaches the cavity (0 = same as the diameter: straight hole)" onChange={(drainExit) => set({ drainExit })} />
      </Row>
      <Check checked={h.keepPlugs} onChange={(keepPlugs) => set({ keepPlugs })}>
        Retain plugs (keep the cut-out pieces as a separate part)
      </Check>
      <Hint>A different exit size makes tapered holes; a plug narrower on the inside seats back into the hole to close it after draining.</Hint>
      <button
        className={`btn wide ${pickMode === 'drain' ? 'primary' : ''}`}
        disabled={!target}
        onClick={() => setState({ pickMode: pickMode === 'drain' ? null : 'drain' })}
      >
        {pickMode === 'drain' ? 'Done placing holes' : 'Place drain holes on surface…'}
      </button>
      {h.drainHoles.length > 0 && (
        <ul className="hole-list">
          {h.drainHoles.map((d, i) => (
            <li key={i}>
              <span>
                #{i + 1} at {d.point.map((v) => v.toFixed(1)).join(', ')}
              </span>
              <button className="mini" onClick={() => set({ drainHoles: h.drainHoles.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <button className="btn primary wide" disabled={!target || !!preview} onClick={() => live(previewHollow)}>
        Preview hollow
      </button>
      <Hint>
        The inner wall is extracted from a signed distance field (voxel offset), so it never self-intersects. Use the Clip tool to
        inspect the cavity.
      </Hint>
    </Section>
  );
}
