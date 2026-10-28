import type { ReactNode } from 'react';
import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { useStore } from '../../state/store';
import { previewLattice, previewShape, previewShrinkwrap } from '../../state/makeActions';
import { live } from '../../state/livePreview';
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
      <Row label="Cell size">
        <NumberField value={lat.cell} min={1} step={1} suffix="mm" title="Size of one repeating lattice cell" onChange={(cell) => setLat({ cell: Math.max(1, cell) })} />
      </Row>
      <Row label={lat.type === 'cubic' ? 'Strut thickness' : 'Wall thickness'}>
        <NumberField value={lat.thickness} min={0.2} step={0.1} suffix="mm" onChange={(thickness) => setLat({ thickness: Math.max(0.2, thickness) })} />
      </Row>
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
        powder and resin printing; cubic is a grid of struts. The preview shows how much lighter the part gets; use Clip to look inside.
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
