import { useMemo, type ReactNode } from 'react';
import { Vector3 } from 'three';
import { NumberField, Row, Segmented, Slider, Check } from '../controls';
import type { AxisRow, Part, PlaneSettings } from '../../state/types';
import { approxSceneBounds, planeNormal, TILT_AXES } from '../../state/math';

type Axis = 'x' | 'y' | 'z';
const AXES: Axis[] = ['x', 'y', 'z'];
const OFF: AxisRow = { on: false, offset: 0, flip: false };

/**
 * The cut / clip panel: one row per axis (side switch, ‹ slider › and position),
 * any combination of X, Y and Z, then which parts it applies to. "Angled plane"
 * swaps the rows for one plane at any angle.
 */
export function AxisCuts({ value, onChange, parts, kind, children }: { value: PlaneSettings; onChange: (p: PlaneSettings) => void; parts: Part[]; kind: 'clip' | 'cut'; children?: ReactNode }) {
  const rows = value.rows ?? { x: OFF, y: OFF, z: { ...OFF, on: true } };
  const setRow = (a: Axis, patch: Partial<AxisRow>) => onChange({ ...value, rows: { ...rows, [a]: { ...rows[a], ...patch } } });
  const on = AXES.filter((a) => rows[a].on).length;
  return (
    <div className="axis-cuts">
      <div className="axis-cuts-title">{kind === 'clip' ? 'Clips' : 'Cuts'}</div>
      {value.angled ? (
        <PlaneControls value={value} parts={parts} onChange={onChange} />
      ) : (
        AXES.map((a) => <AxisCutRow key={a} axis={a} row={rows[a]} parts={parts} onChange={(p) => setRow(a, p)} />)
      )}
      <Check checked={!!value.angled} onChange={(angled) => onChange({ ...value, angled, rows })}>
        Angled plane (tilt / free direction)
      </Check>
      {kind === 'clip' && !value.angled && on > 1 && (
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
      <select className="tb-select wide axis-scope" value={value.scope ?? 'all'} onChange={(e) => onChange({ ...value, scope: e.target.value as 'all' | 'selected' })}>
        <option value="all">{kind === 'clip' ? 'Clip all parts' : 'Cut all parts'}</option>
        <option value="selected">{kind === 'clip' ? 'Clip selected parts' : 'Cut selected parts'}</option>
      </select>
      {children}
    </div>
  );
}

/** Icon of an axis row: grey when off, an orange bracket open towards the side that is cut away when on. */
function SideIcon({ row }: { row: AxisRow }) {
  return (
    <svg viewBox="0 0 22 16" width="22" height="16" aria-hidden>
      {!row.on ? (
        <rect x="2" y="2.5" width="18" height="11" rx="3" className="side-off" />
      ) : row.flip ? (
        <path d="M18 2.5H7.5v11H18" className="side-on" />
      ) : (
        <path d="M4 2.5h10.5v11H4" className="side-on" />
      )}
    </svg>
  );
}

function AxisCutRow({ axis, row, parts, onChange }: { axis: Axis; row: AxisRow; parts: Part[]; onChange: (p: Partial<AxisRow>) => void }) {
  const range = useMemo(() => {
    const b = approxSceneBounds(parts);
    if (b.isEmpty()) return { min: -100, max: 100 };
    const lo = b.min[axis], hi = b.max[axis], pad = (hi - lo) * 0.02 + 0.01;
    return { min: lo - pad, max: hi + pad };
  }, [parts, axis]);
  const A = axis.toUpperCase();
  const span = range.max - range.min;
  // ‹ › step a millimetre (Shift: ten), never past the ends of the slider
  const step = (dir: number, big: boolean) => {
    const v = Math.round((row.offset + dir * (big ? 10 : 1)) * 100) / 100;
    onChange({ offset: Math.min(range.max, Math.max(range.min, v)), on: true });
  };
  // click: off → keep the lower side → keep the upper side → off
  const cycle = () => onChange(!row.on ? { on: true, flip: false } : !row.flip ? { flip: true } : { on: false, flip: false });
  const state = !row.on ? 'off' : row.flip ? `keeps the side above ${A} = ${row.offset}` : `keeps the side below ${A} = ${row.offset}`;
  return (
    <div
      className={`axis-row ${row.on ? 'on' : ''}`}
      data-help-title={`${A} plane`}
      data-help-text={`The ${A} plane: the icon switches it off, keeps the lower side or keeps the upper side; ‹ › move it 1 mm (Shift: 10 mm), the slider drags it, and the field is its position along ${A} in mm. Any combination of X, Y and Z works together.`}
    >
      <span className="axis-name">{A}:</span>
      <button className="side-btn" onClick={cycle} title={`${A} plane ${state}. Click: off → keep below → keep above`}>
        <SideIcon row={row} />
      </button>
      <button className="step-btn" onClick={(e) => step(-1, e.shiftKey)} title="−1 mm (Shift: −10 mm)">
        ‹
      </button>
      <Slider value={row.offset} min={range.min} max={range.max} step={span / 1000 || 0.01} onChange={(offset) => onChange({ offset, on: true })} />
      <button className="step-btn" onClick={(e) => step(1, e.shiftKey)} title="+1 mm (Shift: +10 mm)">
        ›
      </button>
      <NumberField value={row.offset} onChange={(offset) => onChange({ offset })} precision={2} width={70} />
      <span className="axis-unit">mm</span>
    </div>
  );
}

/** One plane: X / Y / Z or a free direction, with tilt angles, position and side. */
export function PlaneControls({ value, onChange, parts }: { value: PlaneSettings; onChange: (p: PlaneSettings) => void; parts: Part[] }) {
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
    </>
  );
}
