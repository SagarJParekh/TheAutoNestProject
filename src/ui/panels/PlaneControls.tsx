import { useMemo } from 'react';
import { Vector3 } from 'three';
import { NumberField, Row, Segmented, Slider, Check } from '../controls';
import type { Part, PlaneSettings } from '../../state/types';
import { approxSceneBounds, planeNormal, TILT_AXES } from '../../state/math';

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
