import { Fragment } from 'react';
import { Hint, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { clearMeasurements, deleteMeasurement, resetPending } from '../../state/measureActions';
import type { MeasureMode, MeasurePickAs } from '../../state/types';

const PICKS: Record<MeasureMode, { value: MeasurePickAs; label: string; title: string }[]> = {
  distance: [
    { value: 'point', label: 'Point', title: 'Snaps to vertices' },
    { value: 'edge', label: 'Edge', title: 'Snaps to feature edges (infinite line)' },
    { value: 'surface', label: 'Surface', title: 'Plane of the clicked face' },
    { value: 'circle', label: 'Circle', title: 'Click a round surface (hole, boss)' },
    { value: 'circle3', label: '3-pt circle', title: 'Three points on a circle' },
    { value: 'sphere', label: 'Sphere', title: 'Click a spherical surface' },
  ],
  angle: [
    { value: 'point', label: '3 points', title: 'Second point is the vertex' },
    { value: 'edge', label: 'Edges', title: 'Angle between two edges' },
    { value: 'surface', label: 'Surfaces', title: 'Angle between two faces' },
    { value: 'circle', label: 'Axes', title: 'Angle between circle axes' },
  ],
  diameter: [
    { value: 'circle', label: 'Direct circle', title: 'Click a round surface' },
    { value: 'circle3', label: '3-pt circle', title: 'Three points on the edge' },
    { value: 'sphere', label: 'Sphere', title: 'Click a spherical surface' },
  ],
  thickness: [],
};

const HELP: Record<MeasureMode, string> = {
  distance: 'Click two entities. You can mix types between clicks (change “Pick” after the first click), e.g. edge to surface or circle to circle.',
  angle: 'Pick 3 points (the second is the corner), or two edges/surfaces/circle axes.',
  diameter: 'Click a hole, boss or sphere, or 3 points on a circular edge.',
  thickness: 'Click a point on the surface; the wall thickness is measured straight through along the normal.',
};

export function MeasurePanel() {
  const st = useStore((s) => s.settings.measure);
  const pending = useStore((s) => s.measurePending);
  const list = useStore((s) => s.measurements);
  const set = (patch: Partial<typeof st>) => {
    const next = { ...getState().settings.measure, ...patch };
    if (patch.mode && !PICKS[patch.mode].some((p) => p.value === next.pickAs)) next.pickAs = PICKS[patch.mode][0]?.value ?? 'point';
    setState({ settings: { ...getState().settings, measure: next } });
    if (patch.mode || (patch.pickAs && (patch.pickAs === 'circle3' || st.pickAs === 'circle3'))) resetPending();
  };
  const need =
    st.mode === 'thickness' ? 1 : st.mode === 'diameter' ? (st.pickAs === 'circle3' ? 3 : 1) : st.mode === 'angle' && st.pickAs === 'point' ? 3 : 2;
  const have = pending.entities.length + (pending.points.length ? 0 : 0);
  return (
    <>
      <Section title="Measure">
        <Segmented<MeasureMode>
          value={st.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'distance', label: 'Distance' },
            { value: 'angle', label: 'Angle' },
            { value: 'diameter', label: 'Diameter' },
            { value: 'thickness', label: 'Thickness' },
          ]}
        />
        {PICKS[st.mode].length > 0 && (
          <Row label="Pick">
            <Segmented<MeasurePickAs> value={st.pickAs} onChange={(pickAs) => set({ pickAs })} options={PICKS[st.mode]} />
          </Row>
        )}
        <Hint>{HELP[st.mode]}</Hint>
        {(pending.entities.length > 0 || pending.points.length > 0) && (
          <div className="pending">
            <span>
              Picked: {pending.entities.map((e) => e.label).join(', ')}
              {pending.points.length > 0 && `${pending.entities.length ? ', ' : ''}${pending.points.length} point${pending.points.length > 1 ? 's' : ''}`}
              {' '}— {need === 3 && pending.points.length ? `${3 - pending.points.length} more` : `${Math.max(0, need - have)} more`}
            </span>
            <button className="mini" onClick={resetPending}>
              Reset
            </button>
          </div>
        )}
      </Section>
      <Section
        title={`Results (${list.length})`}
        actions={
          list.length > 0 && (
            <button className="mini" onClick={clearMeasurements}>
              Clear all
            </button>
          )
        }
      >
        {list.length === 0 && <Hint>No measurements yet. Click on parts in the viewport.</Hint>}
        <ul className="measure-list">
          {[...list].reverse().map((m) => (
            <li key={m.id}>
              <div className="measure-head">
                <span className="muted small">{m.title}</span>
                <button className="icon-btn" title="Delete" onClick={() => deleteMeasurement(m.id)}>
                  ✕
                </button>
              </div>
              <strong className="measure-value">
                {m.mode === 'diameter' ? 'Ø ' : ''}
                {m.value.toFixed(m.unit === 'mm' ? 3 : 2)} {m.unit}
              </strong>
              {m.extras.length > 0 && (
                <dl className="info">
                  {m.extras.map((e) => (
                    <Fragment key={e.label}>
                      <dt>{e.label}</dt>
                      <dd>
                        {e.value.toFixed(e.unit === 'mm' ? 3 : 2)} {e.unit}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              )}
              {m.note && <p className="muted small">{m.note}</p>}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
