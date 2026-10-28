import { useMemo } from 'react';
import { Vector3 } from 'three';
import { NumberField, Row, Segmented, Slider, Check } from '../controls';
import type { AxisPlane, Part, PlaneSettings } from '../../state/types';
import { approxSceneBounds, planeNormal, TILT_AXES } from '../../state/math';

type Axis = 'x' | 'y' | 'z';
const AXES: Axis[] = ['x', 'y', 'z'];

/** Position slider + flip for one axis plane (several-axes mode). */
function AxisRows({ axis, offset, flip, parts, onChange }: { axis: Axis; offset: number; flip: boolean; parts: Part[]; onChange: (p: { offset?: number; flip?: boolean }) => void }) {
  const range = useMemo(() => {
    const b = approxSceneBounds(parts);
    if (b.isEmpty()) return { min: -100, max: 100 };
    const lo = b.min[axis], hi = b.max[axis], pad = (hi - lo) * 0.02 + 0.01;
    return { min: lo - pad, max: hi + pad };
  }, [parts, axis]);
  const A = axis.toUpperCase();
  return (
    <>
      <Row label={`${A} position`}>
        <Slider value={offset} min={range.min} max={range.max} step={(range.max - range.min) / 1000 || 0.01} onChange={(o) => onChange({ offset: o })} />
        <NumberField value={offset} onChange={(o) => onChange({ offset: o })} suffix="mm" precision={2} width={90} />
      </Row>
      <Row>
        <Check checked={flip} onChange={(f) => onChange({ flip: f })}>
          Flip {A} side
        </Check>
      </Row>
    </>
  );
}

/**
 * Plane settings. With `multi`, several axis planes can be used at once (X, Y and Z together);
 * with `combine`, the choice of how a section clip combines them is shown too.
 */
export function PlaneControls({ value, onChange, parts, multi = false, combine = false }: { value: PlaneSettings; onChange: (p: PlaneSettings) => void; parts: Part[]; multi?: boolean; combine?: boolean }) {
  if (multi && value.extra) return <MultiAxis value={value} onChange={onChange} parts={parts} combine={combine} />;
  return <SinglePlane value={value} onChange={onChange} parts={parts} multi={multi} />;
}

const centreOf = (parts: Part[], axis: Axis) => {
  const b = approxSceneBounds(parts);
  return b.isEmpty() ? 0 : Math.round(((b.min[axis] + b.max[axis]) / 2) * 100) / 100;
};

function MultiAxis({ value, onChange, parts, combine }: { value: PlaneSettings; onChange: (p: PlaneSettings) => void; parts: Part[]; combine: boolean }) {
  const main = value.axis as Axis;
  const extra = value.extra ?? [];
  const active = new Set<Axis>([main, ...extra.map((e) => e.axis)]);
  const toggle = (a: Axis) => {
    if (!active.has(a)) return onChange({ ...value, extra: [...extra, { axis: a, offset: centreOf(parts, a), flip: false }] });
    if (active.size === 1) return;
    if (a !== main) return onChange({ ...value, extra: extra.filter((e) => e.axis !== a) });
    // the main axis goes: the first extra plane takes its place
    const [first, ...rest] = extra;
    onChange({ ...value, axis: first.axis, offset: first.offset, flip: first.flip, extra: rest });
  };
  const setExtra = (a: Axis, patch: Partial<AxisPlane>) => onChange({ ...value, extra: extra.map((e) => (e.axis === a ? { ...e, ...patch } : e)) });
  return (
    <>
      <Row>
        <Check checked onChange={() => onChange({ ...value, extra: undefined })}>
          Several axes at once
        </Check>
      </Row>
      <Row label="Axes">
        <div className="segmented" role="group">
          {AXES.map((a) => (
            <button key={a} className={active.has(a) ? 'active' : ''} aria-pressed={active.has(a)} onClick={() => toggle(a)} title={`Use a ${a.toUpperCase()} plane`}>
              {a.toUpperCase()}
            </button>
          ))}
        </div>
      </Row>
      {AXES.filter((a) => active.has(a)).map((a) =>
        a === main ? (
          <AxisRows key={a} axis={a} offset={value.offset} flip={value.flip} parts={parts} onChange={(p) => onChange({ ...value, ...p })} />
        ) : (
          <AxisRows key={a} axis={a} offset={extra.find((e) => e.axis === a)!.offset} flip={extra.find((e) => e.axis === a)!.flip} parts={parts} onChange={(p) => setExtra(a, p)} />
        ),
      )}
      {combine && active.size > 1 && (
        <Row label="Cut away">
          <Segmented
            value={value.combine ?? 'corner'}
            onChange={(c) => onChange({ ...value, combine: c })}
            options={[
              { value: 'corner', label: 'Corner', title: 'Remove only the corner where all the planes meet; the rest of the part stays' },
              { value: 'common', label: 'All sides', title: 'Remove everything past any of the planes; only the common part stays' },
            ]}
          />
        </Row>
      )}
    </>
  );
}

function SinglePlane({ value, onChange, parts, multi }: { value: PlaneSettings; onChange: (p: PlaneSettings) => void; parts: Part[]; multi: boolean }) {
  const n = planeNormal({ ...value, flip: false });
  const range = useMemo(() => {
    const b = approxSceneBounds(parts);
    if (b.isEmpty()) return { min: -100, max: 100 };
    let min = Infinity, max = -Infinity;
    for (const x of [b.min.x, b.max.x])
      for (const y of [b.min.y, b.max.y])
        for (const z of [b.min.z, b.max.z]) {
          const d = new Vector3(x, y, z).dot(new Vector3(...n));
          min = Math.min(min, d);
          max = Math.max(max, d);
        }
    const pad = (max - min) * 0.02 + 0.01;
    return { min: min - pad, max: max + pad };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts, n[0], n[1], n[2]]);
  const set = (patch: Partial<PlaneSettings>) => onChange({ ...value, ...patch });
  const span = range.max - range.min;
  const tiltAxes = TILT_AXES[value.axis];
  // tilting pivots the plane about the point where it currently crosses the parts' centre line
  const setTilt = (patch: Partial<PlaneSettings>) => {
    const b = approxSceneBounds(parts);
    const c = b.isEmpty() ? new Vector3() : b.getCenter(new Vector3());
    const old = new Vector3(...n);
    const pivot = c.clone().addScaledVector(old, value.offset - c.dot(old));
    const next = { ...value, ...patch };
    const nn = new Vector3(...planeNormal({ ...next, flip: false }));
    onChange({ ...next, offset: Math.round(pivot.dot(nn) * 1000) / 1000 });
  };
  return (
    <>
      <Row label="Normal">
        <Segmented
          value={value.axis}
          onChange={(axis) => {
            // keep the plane through the middle of the parts when switching axis
            const nn = planeNormal({ ...value, axis, flip: false });
            const b = approxSceneBounds(parts);
            const c = b.isEmpty() ? new Vector3() : b.getCenter(new Vector3());
            set({ axis, offset: Math.round(c.dot(new Vector3(...nn)) * 100) / 100 });
          }}
          options={[
            { value: 'x', label: 'X' },
            { value: 'y', label: 'Y' },
            { value: 'z', label: 'Z' },
            { value: 'free', label: 'Free' },
          ]}
        />
      </Row>
      {value.axis === 'free' && (
        <>
          <Row label="Azimuth">
            <Slider value={value.azimuth} min={-180} max={180} step={1} onChange={(azimuth) => set({ azimuth })} />
            <NumberField value={value.azimuth} onChange={(azimuth) => set({ azimuth })} suffix="°" width={74} />
          </Row>
          <Row label="Elevation">
            <Slider value={value.elevation} min={-90} max={90} step={1} onChange={(elevation) => set({ elevation })} />
            <NumberField value={value.elevation} onChange={(elevation) => set({ elevation })} suffix="°" width={74} />
          </Row>
        </>
      )}
      {tiltAxes && (
        <>
          <Row label={`Tilt about ${tiltAxes[0]}`}>
            <Slider value={value.tiltA ?? 0} min={-90} max={90} step={1} onChange={(tiltA) => setTilt({ tiltA })} />
            <NumberField value={value.tiltA ?? 0} min={-180} max={180} onChange={(tiltA) => setTilt({ tiltA })} suffix="°" width={74} />
          </Row>
          <Row label={`Tilt about ${tiltAxes[1]}`}>
            <Slider value={value.tiltB ?? 0} min={-90} max={90} step={1} onChange={(tiltB) => setTilt({ tiltB })} />
            <NumberField value={value.tiltB ?? 0} min={-180} max={180} onChange={(tiltB) => setTilt({ tiltB })} suffix="°" width={74} />
          </Row>
          {((value.tiltA ?? 0) !== 0 || (value.tiltB ?? 0) !== 0) && (
            <Row>
              <button className="mini" onClick={() => setTilt({ tiltA: 0, tiltB: 0 })}>
                Reset angle
              </button>
            </Row>
          )}
        </>
      )}
      <Row label="Position">
        <Slider value={value.offset} min={range.min} max={range.max} step={span / 1000 || 0.01} onChange={(offset) => set({ offset })} />
        <NumberField value={value.offset} onChange={(offset) => set({ offset })} suffix="mm" precision={2} width={90} />
      </Row>
      <Row>
        <Check checked={value.flip} onChange={(flip) => set({ flip })}>
          Flip side
        </Check>
      </Row>
      {multi && (
        <Row>
          <Check
            checked={false}
            onChange={() => {
              // start from the current axis (a free plane becomes Z) plus the next one
              const main: Axis = value.axis === 'free' ? 'z' : value.axis;
              const next: Axis = main === 'z' ? 'x' : main === 'x' ? 'y' : 'z';
              onChange({
                ...value,
                axis: main,
                tiltA: 0,
                tiltB: 0,
                offset: value.axis === 'free' || value.tiltA || value.tiltB ? centreOf(parts, main) : value.offset,
                extra: [{ axis: next, offset: centreOf(parts, next), flip: false }],
              });
            }}
          >
            Several axes at once
          </Check>
        </Row>
      )}
    </>
  );
}
