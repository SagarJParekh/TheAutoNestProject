import type { ReactNode } from 'react';
import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { useStore } from '../../state/store';
import { previewLattice, previewMinBox, previewMoulds, previewShape, previewShrinkwrap, previewSolidify, vcParts } from '../../state/makeActions';
import { DEFAULT_SOLIDIFY } from '../../geometry/solidify';
import { FacePickSection } from './FacePickSection';
import { live } from '../../state/livePreview';
import { regrowFace } from '../../state/actions';
import { useSetting } from './RepairTabs';
import { SHAPES, shapeFields, DEFAULT_SHAPE, type ShapeKind, type ShapeParams } from '../../geometry/shapes';
import { LATTICES, DEFAULT_LATTICE } from '../../geometry/lattice';
import { DEFAULT_WRAP } from '../../geometry/wrap';
import type { Part } from '../../state/types';

// ------------------------------------------------------------------ basic shapes

const g = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
    {d}
  </svg>
);
const SHAPE_ICONS: Record<ShapeKind, ReactNode> = {
  box: g(<><path d="M4 8l8-4 8 4v9l-8 4-8-4z" /><path d="M4 8l8 4 8-4M12 12v9" /></>),
  cylinder: g(<><ellipse cx="12" cy="6" rx="7" ry="2.5" /><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" /></>),
  cone: g(<><path d="M12 3L5 18M12 3l7 15" /><ellipse cx="12" cy="18" rx="7" ry="2.5" /></>),
  sphere: g(<><circle cx="12" cy="12" r="8" /><ellipse cx="12" cy="12" rx="8" ry="3" /></>),
  hemisphere: g(<><path d="M4 16a8 8 0 0 1 16 0" /><ellipse cx="12" cy="16" rx="8" ry="2.5" /></>),
  torus: g(<><ellipse cx="12" cy="12" rx="9" ry="5" /><ellipse cx="12" cy="11.5" rx="3.5" ry="1.6" /></>),
  tube: g(<><ellipse cx="12" cy="6" rx="7" ry="2.5" /><ellipse cx="12" cy="6" rx="3.5" ry="1.2" /><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" /></>),
  pyramid: g(<><path d="M12 3L3 17l9 4 9-4z" /><path d="M12 3v18" /></>),
  prism: g(<><path d="M8 4h8l3 3v11l-3 3H8l-3-3V7z" /><path d="M5 7h14" /></>),
  wedge: g(<><path d="M3 18l6 3h12L9 8 3 11z" /><path d="M9 8v13M3 11l6 3" /></>),
  capsule: g(<><rect x="7" y="3" width="10" height="18" rx="5" /></>),
  ellipsoid: g(<><ellipse cx="12" cy="12" rx="9" ry="6" /><ellipse cx="12" cy="12" rx="9" ry="2.2" /></>),
};

/** Labels of the size fields, per shape. */
function fieldLabel(kind: ShapeKind, f: keyof ShapeParams): string {
  switch (f) {
    case 'x':
      return kind === 'pyramid' ? 'Base width' : kind === 'wedge' ? 'Length (X)' : 'Width (X)';
    case 'y':
      return 'Depth (Y)';
    case 'z':
      return 'Height (Z)';
    case 'h':
      return kind === 'capsule' ? 'Length' : 'Height';
    case 'd':
      return kind === 'torus' ? 'Ring diameter' : kind === 'cone' ? 'Base diameter' : kind === 'tube' ? 'Outside diameter' : kind === 'prism' ? 'Diameter (corners)' : 'Diameter';
    case 'd2':
      return kind === 'torus' ? 'Tube diameter' : kind === 'cone' ? 'Top diameter' : 'Inside diameter';
    case 'sides':
      return 'Sides';
    default:
      return f;
  }
}

export function ShapesPanel() {
  const [shape, setShape] = useSetting('shape');
  const preview = useStore((s) => s.preview);
  const round = !['box', 'pyramid', 'prism', 'wedge'].includes(shape.kind);
  return (
    <Section title="Create a shape">
      <div className="shape-grid">
        {SHAPES.map((o) => (
          <button key={o.value} className={`joint-btn ${shape.kind === o.value ? 'on' : ''}`} onClick={() => setShape({ kind: o.value })} title={o.label}>
            {SHAPE_ICONS[o.value]}
            <span>{o.label}</span>
          </button>
        ))}
      </div>
      {shapeFields(shape.kind).map((f) => (
        <Row key={f} label={fieldLabel(shape.kind, f)}>
          {f === 'sides' ? (
            <NumberField value={shape.sides} min={3} max={64} step={1} precision={0} onChange={(sides) => setShape({ sides: Math.max(3, Math.round(sides)) })} />
          ) : (
            <NumberField
              value={shape[f] as number}
              min={0}
              step={1}
              suffix="mm"
              title={shape.kind === 'cone' && f === 'd2' ? '0 = a sharp point' : undefined}
              onChange={(v) => setShape({ [f]: Math.max(0, v) } as Partial<ShapeParams>)}
            />
          )}
        </Row>
      ))}
      {round && (
        <Row label="Smoothness">
          <NumberField value={shape.segments} min={8} max={512} step={8} precision={0} title="Segments round a full circle" onChange={(segments) => setShape({ segments: Math.round(segments) })} />
        </Row>
      )}
      {shape.kind !== 'tube' && (
        <>
          <Check checked={!!shape.hollow} onChange={(hollow) => setShape({ hollow })}>
            Hollow (closed shell)
          </Check>
          {shape.hollow && (
            <Row label="Wall thickness">
              <NumberField value={shape.wall ?? 2} min={0.1} step={0.5} suffix="mm" title="Thickness of the walls all round; the inside is an empty closed cavity" onChange={(wall) => setShape({ wall: Math.max(0.1, wall) })} />
            </Row>
          )}
        </>
      )}
      <div className="btn-row">
        <button className="btn primary grow" disabled={!!preview} onClick={() => live(previewShape)}>
          Preview shape
        </button>
        <button className="btn" onClick={() => setShape({ ...DEFAULT_SHAPE, kind: shape.kind })}>
          Reset
        </button>
      </div>
      <Hint>The new part stands on the platform next to the other parts, as a closed solid ready for booleans (e.g. subtract a cylinder to make a hole).</Hint>
    </Section>
  );
}

// ------------------------------------------------------------------ lattice

export function LatticePanel({ parts }: { parts: Part[] }) {
  const [lat, setLat] = useSetting('lattice');
  const preview = useStore((s) => s.preview);
  const target = parts.find((p) => !p.locked);
  return (
    <Section title="Lattice (lightweighting)">
      {!target && <Hint>Select one unlocked, watertight part.</Hint>}
      <Row label="Lattice">
        <select className="tb-select wide" value={lat.type} onChange={(e) => setLat({ type: e.target.value as typeof lat.type })}>
          {LATTICES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Layout">
        <Segmented
          value={lat.layout ?? 'projected'}
          onChange={(layout) => setLat({ layout })}
          options={[
            { value: 'projected', label: 'Projected' },
            { value: 'contour', label: 'Contour' },
          ]}
        />
      </Row>
      <Row label="Cell size">
        <NumberField value={lat.cell} min={1} step={1} suffix="mm" title={lat.type === 'honeycomb' ? 'Width of one hexagon, across its flats' : 'Size of one repeating lattice cell'} onChange={(cell) => setLat({ cell: Math.max(1, cell) })} />
      </Row>
      <Row label={lat.type === 'cubic' ? 'Strut thickness' : 'Wall thickness'}>
        <NumberField value={lat.thickness} min={0.2} step={0.1} suffix="mm" onChange={(thickness) => setLat({ thickness: Math.max(0.2, thickness) })} />
      </Row>
      {lat.type === 'honeycomb' && (
        <Row label="Cells along">
          <Segmented
            value={lat.axis ?? 'z'}
            onChange={(axis) => setLat({ axis })}
            options={[
              { value: 'x', label: 'X' },
              { value: 'y', label: 'Y' },
              { value: 'z', label: 'Z' },
            ]}
          />
        </Row>
      )}
      <Row label="Skin thickness">
        <NumberField value={lat.skin} min={0} step={0.5} suffix="mm" title="Solid wall kept under the outer surface (0 = the lattice reaches the surface)" onChange={(skin) => setLat({ skin: Math.max(0, skin) })} />
      </Row>
      <Row label="Quality">
        <Segmented
          value={lat.quality}
          onChange={(quality) => setLat({ quality })}
          options={[
            { value: 'draft', label: 'Draft' },
            { value: 'normal', label: 'Normal' },
            { value: 'fine', label: 'Fine' },
          ]}
        />
      </Row>
      <div className="btn-row">
        <button className="btn primary grow" disabled={!target || !!preview} onClick={() => live(previewLattice)}>
          Preview lattice
        </button>
        <button className="btn" onClick={() => setLat({ ...DEFAULT_LATTICE })}>
          Reset
        </button>
      </div>
      <Hint>
        Keeps the outer surface and a solid skin, and fills the inside with the lattice. Gyroid, diamond and Schwarz P are smooth self-supporting walls, good for
        powder and resin printing; cubic is a grid of struts; honeycomb is hexagonal cells running straight through the part along X, Y or Z (Z = the build direction, self-supporting walls). Projected lays one straight lattice through the part; Contour lays the cells in layers that follow the outer shape, so every face meets the lattice the same way. The preview shows how much lighter the part gets; use Clip to look inside.
      </Hint>
    </Section>
  );
}

// ------------------------------------------------------------------ shrinkwrap

export function WrapPanel({ parts }: { parts: Part[] }) {
  const [wrap, setWrap] = useSetting('wrap');
  const preview = useStore((s) => s.preview);
  const target = parts.find((p) => !p.locked);
  return (
    <Section title="Shrinkwrap">
      {!target && <Hint>Select one unlocked part.</Hint>}
      <Row label="Close gaps up to">
        <NumberField value={wrap.gap} min={0} step={0.5} suffix="mm" title="Holes, slots, openings and cavities up to this size are closed over" onChange={(gap) => setWrap({ gap: Math.max(0, gap) })} />
      </Row>
      <Row label="Offset">
        <NumberField value={wrap.offset} min={0} step={0.1} suffix="mm" title="How far the wrap stands off the surface" onChange={(offset) => setWrap({ offset: Math.max(0, offset) })} />
      </Row>
      <Row label="Quality">
        <Segmented
          value={wrap.quality}
          onChange={(quality) => setWrap({ quality })}
          options={[
            { value: 'draft', label: 'Draft' },
            { value: 'normal', label: 'Normal' },
            { value: 'fine', label: 'Fine' },
          ]}
        />
      </Row>
      <Row label="Voxel size">
        <NumberField value={wrap.voxel} min={0} step={0.05} precision={3} suffix="mm" title="0 = automatic from the quality" onChange={(voxel) => setWrap({ voxel: Math.max(0, voxel) })} />
      </Row>
      <Check checked={wrap.keep} onChange={(keep) => setWrap({ keep })}>
        Keep the original part (add the wrap as a new part)
      </Check>
      <div className="btn-row">
        <button className="btn primary grow" disabled={!target || !!preview} onClick={() => live(previewShrinkwrap)}>
          Preview shrinkwrap
        </button>
        <button className="btn" onClick={() => setWrap({ ...DEFAULT_WRAP, keep: wrap.keep })}>
          Reset
        </button>
      </div>
      <Hint>
        Wraps one closed surface around the part and makes it a solid: holes, gaps and inner cavities up to the gap size are filled, the rest follows the
        part. Works on broken scans and meshes with many shells or open edges. Detail finer than the voxel size is smoothed.
      </Hint>
    </Section>
  );
}

// ------------------------------------------------------------------ surface to solid

/**
 * Surface to solid: take a surface (picked faces of a part, or a whole open
 * part) and make it a solid: thicken it, or fill it to a flat base (fixture).
 */
export function SolidifyPanel({ parts }: { parts: Part[] }) {
  const [st, setSt] = useSetting('solidify');
  const preview = useStore((s) => s.preview);
  const fs = useStore((s) => s.faceSelection);
  const te = useStore((s) => s.triEdit);
  const ready = st.source === 'faces' ? !!fs : st.source === 'marked' ? !!te?.tris.length : parts.some((p) => !p.locked);
  return (
    <>
      <Section title="1. Surface">
        <Row label="Surface">
          <Segmented
            value={st.source}
            onChange={(source) => {
              setSt({ source });
            }}
            options={[
              { value: 'faces', label: 'Picked faces', title: 'Pick the surface on a part: it is taken off the part (the part is not changed)' },
              { value: 'marked', label: 'Marked', title: 'The triangles marked with the Mark row above the view (brush, window, surface…)' },
              { value: 'part', label: 'Whole part', title: 'The selected part is the surface (e.g. an imported open sheet)' },
            ]}
          />
        </Row>
        {st.source === 'faces' && (
          <Row label="Pick grows">
            <Segmented
              value={st.grow}
              onChange={(grow) => {
                setSt({ grow });
                void regrowFace();
              }}
              options={[
                { value: 'smooth', label: 'Follow curvature', title: 'Across smooth curvature, up to edges sharper than the angle tolerance (a whole organic surface)' },
                { value: 'angle', label: 'Within angle of click', title: 'Only triangles turned less than the angle tolerance from the clicked one (a limited patch, e.g. the underside of a smooth part)' },
              ]}
            />
          </Row>
        )}
        {st.source === 'faces' ? (
          <FacePickSection tool="solidify" />
        ) : st.source === 'marked' ? (
          <Hint>{te?.tris.length ? `${te.tris.length.toLocaleString()} triangles marked.` : 'Mark the surface with the Mark row above the view (e.g. Brush or Surface).'}</Hint>
        ) : (
          !ready && <Hint>Select the part that is the surface.</Hint>
        )}
      </Section>
      <Section title="2. Solid">
        <Row label="Make">
          <Segmented
            value={st.mode}
            onChange={(mode) => setSt({ mode })}
            options={[
              { value: 'thicken', label: 'Thicken', title: 'A shell of even thickness following the surface' },
              { value: 'base', label: 'Fill to base', title: 'Fill the surface straight down (or up) to a flat base: a fixture shaped like the part' },
            ]}
          />
        </Row>
        {st.mode === 'thicken' ? (
          <>
            <Row label="Thickness">
              <NumberField value={st.thickness} min={0.05} step={0.5} suffix="mm" title="Wall thickness, square to the surface" onChange={(thickness) => setSt({ thickness: Math.max(0.05, thickness) })} />
            </Row>
            <Row label="Grow">
              <Segmented
                value={st.side}
                onChange={(side) => setSt({ side })}
                options={[
                  { value: 'out', label: 'Outwards', title: 'Away from the part (along the surface normals)' },
                  { value: 'in', label: 'Inwards', title: 'Into the part (against the normals)' },
                  { value: 'both', label: 'Both', title: 'Half the thickness on each side' },
                ]}
              />
            </Row>
          </>
        ) : (
          <>
            <Row label="Fill towards">
              <Segmented
                value={st.baseDir}
                onChange={(baseDir) => setSt({ baseDir })}
                options={[
                  { value: 'down', label: 'Base below', title: 'A cradle under the part (pick the part’s underside)' },
                  { value: 'up', label: 'Base above', title: 'A clamp over the part (pick its top)' },
                ]}
              />
            </Row>
            <Row label="Base beyond surface">
              <NumberField value={st.baseThickness} min={0.1} step={0.5} suffix="mm" title="How far the flat base reaches past the surface’s lowest (highest) point" onChange={(baseThickness) => setSt({ baseThickness: Math.max(0.1, baseThickness) })} />
            </Row>
          </>
        )}
        {(st.mode === 'base' || st.side !== 'both') && (
          <Row label="Gap to surface">
            <NumberField value={st.gap} min={0} step={0.1} suffix="mm" title="Clearance between the surface and the solid (0 = touching)" onChange={(gap) => setSt({ gap: Math.max(0, gap) })} />
          </Row>
        )}
        {st.mode === 'base' && (
          <Check checked={st.facingOnly} onChange={(facingOnly) => setSt({ facingOnly })}>
            Use only the surface facing the base (the fixture stops at the part's outline)
          </Check>
        )}
        {st.mode === 'base' && (
          <Check checked={st.cutPart} onChange={(cutPart) => setSt({ cutPart })}>
            Cut the part out of the fixture (where it reaches past the picked surface)
          </Check>
        )}
        <Check checked={st.keep} onChange={(keep) => setSt({ keep })}>
          Keep the part (add the solid as a new part)
        </Check>
        <div className="btn-row">
          <button className="btn primary grow" disabled={!ready || !!preview} onClick={() => live(previewSolidify)}>
            Preview solid
          </button>
          <button className="btn" onClick={() => setSt({ ...DEFAULT_SOLIDIFY, source: st.source, angleTolerance: 20, grow: 'smooth', keep: st.keep, cutPart: false })}>
            Reset
          </button>
        </div>
        <Hint>
          Turns a zero-thickness surface into a solid. To make a fixture: pick the organic surface of the part where it should rest (e.g. its underside),
          choose Fill to base with a small gap, and keep the part: the new solid is shaped like the part and holds it. Thicken makes an even shell instead
          (a skin, a cover, a sheet from a scan).
        </Hint>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ VC module

export function VcPanel() {
  const [vc, setVc] = useSetting('vc');
  const preview = useStore((s) => s.preview);
  useStore((s) => s.selection);
  useStore((s) => s.parts);
  const parts = vcParts();
  return (
    <>
      <Section title="VC module (vacuum casting)">
        <Row label="Parts">
          <Segmented
            value={vc.scope}
            onChange={(scope) => setVc({ scope })}
            options={[
              { value: 'all', label: 'All parts' },
              { value: 'selected', label: 'Selected parts' },
            ]}
          />
        </Row>
        <Hint>{parts.length ? `${parts.length} part${parts.length > 1 ? 's' : ''}.` : vc.scope === 'all' ? 'No parts yet.' : 'Select the parts.'}</Hint>
      </Section>
      <Section title="1. Minimum bounding box">
        <button className="btn wide" disabled={!parts.length || !!preview} onClick={() => previewMinBox(parts)}>
          Arrange in minimum bounding box
        </button>
        <Hint>Turns each part so its smallest box lines up with X / Y / Z (longest side along X, shortest along Z), so the mould comes out as small as possible.</Hint>
      </Section>
      <Section title="2. Mould">
        <table className="vc-rule">
          <tbody>
            <tr>
              <td>Largest side under 300 mm</td>
              <td>20 mm</td>
            </tr>
            <tr>
              <td>300 – 900 mm</td>
              <td>30 mm</td>
            </tr>
            <tr>
              <td>Over 900 mm</td>
              <td>50 mm</td>
            </tr>
          </tbody>
        </table>
        <Check checked={vc.split} onChange={(split) => setVc({ split })}>
          Split each mould in two halves at mid-height
        </Check>
        <Check checked={vc.keepOriginal} onChange={(keepOriginal) => setVc({ keepOriginal })}>
          Keep the master parts
        </Check>
        <Check checked={vc.spread} onChange={(spread) => setVc({ spread })}>
          Space the parts so the moulds do not overlap
        </Check>
        <button className="btn primary wide" disabled={!parts.length || !!preview} onClick={() => live(previewMoulds)}>
          Create mould{parts.length > 1 ? 's' : ''} for {vc.scope === 'all' ? 'all' : 'selected'} parts
        </button>
        <Hint>
          A block is put around each part with the clearance above on all six sides (chosen from the part’s largest bounding-box side), and the part is
          taken out of it as the cavity. Parts must be watertight. Moulds are named name_mould (or name_mould_bottom / name_mould_top).
        </Hint>
      </Section>
    </>
  );
}
