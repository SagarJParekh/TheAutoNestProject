import { Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { previewHollow } from '../../state/actions';
import type { Part, ToolSettings } from '../../state/types';

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
            { value: 'draft', label: 'Draft', title: '~2M voxels' },
            { value: 'normal', label: 'Normal', title: '~6M voxels' },
            { value: 'fine', label: 'Fine', title: '~16M voxels (slow)' },
          ]}
        />
      </Row>
      <h4>Drain holes</h4>
      <Row label="Diameter">
        <NumberField value={h.drainDiameter} min={0.5} step={0.5} suffix="mm" onChange={(drainDiameter) => set({ drainDiameter })} />
      </Row>
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
      <button className="btn primary wide" disabled={!target || !!preview} onClick={previewHollow}>
        Preview hollow
      </button>
      <Hint>
        The inner wall is extracted from a signed distance field (voxel offset), so it never self-intersects. Use the Clip tool to
        inspect the cavity.
      </Hint>
    </Section>
  );
}
