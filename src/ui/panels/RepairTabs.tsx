import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import {
  booleanOperands, checkIntersections, clearPick, flipAllNormals, flipPickedFaces, mergeSelectedParts, previewAlign, previewBoolean,
  previewMakeSolid, previewProps, previewRemoveOverlaps, previewStitch, previewUnifyShells, splitShellsToParts, startPick, unifyNormals,
} from '../../state/repairActions';
import type { Part, PickSlot, ToolSettings } from '../../state/types';

type Key = keyof ToolSettings;
function useSetting<K extends Key>(k: K) {
  const v = useStore((s) => s.settings[k]);
  const set = (patch: Partial<ToolSettings[K]>) =>
    setState({ settings: { ...getState().settings, [k]: { ...getState().settings[k], ...patch } }, preview: null });
  return [v, set] as const;
}

/** Button that arms a face pick, plus what was picked. */
function PickButton({ slot, label }: { slot: Exclude<PickSlot, 'primary'>; label: string }) {
  const armed = useStore((s) => s.pickMode === 'face' && s.pickSlot === slot);
  const pick = useStore((s) => s.facePicks[slot]);
  const part = useStore((s) => (pick ? s.parts.find((p) => p.id === pick.partId) : undefined));
  const stale = pick && part && part.mesh !== pick.mesh;
  return (
    <div className="pick-row">
      <button className={`btn ${armed ? 'primary' : ''}`} onClick={() => startPick(slot)}>
        {armed ? 'Click a face…' : label}
      </button>
      <span className="muted small">
        {pick && part && !stale ? `${part.name} · ${pick.tris.length} tris · ${pick.area.toFixed(1)} mm²` : stale ? 'part changed — pick again' : 'not picked'}
      </span>
      {pick && (
        <button className="mini" onClick={() => clearPick(slot)}>
          Clear
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Fix tab extras

export function FixExtras({ part }: { part: Part }) {
  const preview = useStore((s) => s.preview);
  const ix = useStore((s) => s.intersections[part.id]);
  const inter = ix && ix.mesh === part.mesh ? ix.report : null;
  const [stitch, setStitch] = useSetting('stitch');
  const [normals, setNormals] = useSetting('normals');
  const busy = !!preview || part.locked;
  return (
    <>
      <Section title="Stitch triangles">
        <Row label="Tolerance">
          <NumberField value={stitch.tolerance} min={0} step={0.01} precision={4} suffix="mm" title="0 = automatic (0.01% of part size)" onChange={(tolerance) => setStitch({ tolerance })} />
        </Row>
        <button className="btn wide" disabled={busy} onClick={previewStitch}>
          Stitch cracks…
        </button>
        <Hint>Merges open-edge vertices closer than the tolerance and splits edges at T-junctions, closing cracks between triangles.</Hint>
      </Section>

      <Section
        title="Overlapping triangles"
        actions={
          <button className="mini" onClick={() => checkIntersections(part.id)}>
            {inter ? 'Re-check' : 'Check'}
          </button>
        }
      >
        {inter ? (
          <dl className="info">
            <dt>
              <i className="dot" style={{ background: '#ff7a1a' }} />
              Self-intersecting
            </dt>
            <dd className={inter.intersecting.length ? 'warn' : 'okc'}>{inter.intersecting.length.toLocaleString()}</dd>
            <dt>
              <i className="dot" style={{ background: '#22d3ee' }} />
              Overlapping (coplanar)
            </dt>
            <dd className={inter.overlapping.length ? 'warn' : 'okc'}>{inter.overlapping.length.toLocaleString()}</dd>
          </dl>
        ) : (
          <Hint>Finds triangles that cross each other or lie on top of each other (doubled surfaces).</Hint>
        )}
        {inter?.truncated && <Hint>Stopped after 500,000 pairs; results are partial.</Hint>}
        <button className="btn wide" disabled={busy} onClick={previewRemoveOverlaps}>
          Remove overlapping triangles…
        </button>
        <Hint>For crossing shells use Combine → Unify shells or Make solid.</Hint>
      </Section>

      <Section title="Surface normals">
        <Check checked={normals.show} onChange={(show) => setNormals({ show })}>
          Show normals
        </Check>
        <div className="btn-grid two">
          <button className="btn" disabled={part.locked} onClick={unifyNormals} title="Make winding consistent and outward-facing">
            Unify outward
          </button>
          <button className="btn" disabled={part.locked} onClick={flipAllNormals}>
            Flip all
          </button>
        </div>
        <PickButton slot="flip" label="Pick faces to flip" />
        <button className="btn wide" disabled={part.locked} onClick={flipPickedFaces}>
          Flip picked faces
        </button>
        <Hint>Back faces render red, so inverted regions stand out.</Hint>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ Combine tab

export function CombineTab({ parts }: { parts: Part[] }) {
  const preview = useStore((s) => s.preview);
  useStore((s) => s.selection);
  const [solid, setSolid] = useSetting('solid');
  const [bool, setBool] = useSetting('boolean');
  const single = parts.length === 1 ? parts[0] : null;
  const ops = booleanOperands();
  return (
    <>
      <Section title="Shells">
        {!single && <Hint>Select one part.</Hint>}
        <button className="btn wide" disabled={!single || single.locked || !!preview} onClick={splitShellsToParts}>
          Split shells into parts
        </button>
        <button className="btn wide" disabled={!single || single.locked || !!preview} onClick={previewUnifyShells}>
          Unify shells (exact boolean)…
        </button>
        <Hint>Merges overlapping shells into one solid. Needs every shell to be closed.</Hint>
        <Row label="Voxel size">
          <NumberField value={solid.voxelSize} min={0} step={0.05} precision={3} suffix="mm" title="0 = automatic" onChange={(voxelSize) => setSolid({ voxelSize })} />
        </Row>
        <button className="btn wide" disabled={!single || single.locked || !!preview} onClick={previewMakeSolid}>
          Make solid (voxel remesh)…
        </button>
        <Hint>Rebuilds a clean watertight solid from overlapping, self-intersecting or leaky shells. Detail below the voxel size is smoothed.</Hint>
      </Section>
      <Section title="Boolean">
        <Row label="Operation">
          <Segmented
            value={bool.op}
            onChange={(op) => setBool({ op })}
            options={[
              { value: 'union', label: 'Union' },
              { value: 'subtract', label: 'Subtract' },
              { value: 'intersect', label: 'Intersect' },
            ]}
          />
        </Row>
        {ops.length >= 2 ? (
          <ol className="operand-list">
            {ops.map((p, i) => (
              <li key={p.id}>
                <i className="dot" style={{ background: p.color }} /> {p.name} {i === 0 && <span className="muted">(base)</span>}
              </li>
            ))}
          </ol>
        ) : (
          <Hint>Ctrl-click two or more parts. The first one you select is the base (subtract removes the others from it).</Hint>
        )}
        <button className="btn primary wide" disabled={ops.length < 2 || !!preview} onClick={previewBoolean}>
          Preview boolean
        </button>
        <button className="btn wide" disabled={ops.length < 2} onClick={mergeSelectedParts} title="Combine into one part without a boolean; shells stay separate">
          Merge into one part (no boolean)
        </button>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ Align tab

export function AlignTab() {
  const preview = useStore((s) => s.preview);
  const [align, setAlign] = useSetting('align');
  return (
    <Section title="Align by faces">
      <PickButton slot="alignSource" label="1. Face to move" />
      <PickButton slot="alignTarget" label="2. Target face" />
      <Row label="Mode">
        <Segmented
          value={align.mode}
          onChange={(mode) => setAlign({ mode })}
          options={[
            { value: 'mate', label: 'Mate', title: 'Faces touch, facing each other' },
            { value: 'flush', label: 'Flush', title: 'Faces coplanar, facing the same way' },
          ]}
        />
      </Row>
      <Row label="Offset">
        <NumberField value={align.offset} step={0.5} suffix="mm" title="Gap along the target face normal" onChange={(offset) => setAlign({ offset })} />
      </Row>
      <Check checked={align.center} onChange={(center) => setAlign({ center })}>
        Centre the faces on each other
      </Check>
      <button className="btn primary wide" disabled={!!preview} onClick={previewAlign}>
        Preview alignment
      </button>
      <Hint>The part with the first face moves; its geometry is not changed, only its position and rotation.</Hint>
    </Section>
  );
}

// ------------------------------------------------------------------ Props tab

export function PropsTab() {
  const preview = useStore((s) => s.preview);
  const [props, setProps] = useSetting('props');
  return (
    <Section title="Props between faces / shells">
      <PickButton slot="propsA" label="1. Start face" />
      <PickButton slot="propsB" label="2. Target face / shell" />
      <Row label="Diameter">
        <NumberField value={props.diameter} min={0.2} step={0.5} suffix="mm" onChange={(diameter) => setProps({ diameter })} />
      </Row>
      <Row label="Spacing">
        <NumberField value={props.spacing} min={0.5} step={1} suffix="mm" title="Centre-to-centre distance" onChange={(spacing) => setProps({ spacing })} />
      </Row>
      <Row label="Border margin">
        <NumberField value={props.margin} min={0} step={0.5} suffix="mm" onChange={(margin) => setProps({ margin })} />
      </Row>
      <Row label="Max length">
        <NumberField value={props.maxLength} min={0.5} step={5} suffix="mm" onChange={(maxLength) => setProps({ maxLength })} />
      </Row>
      <Row label="Embed depth">
        <NumberField value={props.embed} min={0} step={0.1} suffix="mm" title="How far each prop sinks into the faces" onChange={(embed) => setProps({ embed })} />
      </Row>
      <Check checked={props.merge} onChange={(merge) => setProps({ merge })}>
        Merge props and parts into one solid
      </Check>
      <button className="btn primary wide" disabled={!!preview} onClick={previewProps}>
        Preview props
      </button>
      <Hint>
        Props are laid out on a grid over the start face and run along its normal to the first surface hit. Pick both faces on the same part to
        prop between two of its shells.
      </Hint>
    </Section>
  );
}
