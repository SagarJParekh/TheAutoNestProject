import { Fragment } from 'react';
import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { analyzeThickness, clearMeasurements, clearThickness, deleteMeasurement, resetPending, thinArea } from '../../state/measureActions';
import { thicknessColor } from '../../geometry/thickness';
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
        {st.mode !== 'thickness' && (
          <Check checked={st.ortho} onChange={(ortho) => set({ ortho })}>
            Ortho snapping (X/Y/Z from the previous point)
          </Check>
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
      <ThicknessSection />
    </>
  );
}

const fmm = (v: number) => `${v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 2 : 1 })} mm`;

/** Wall thickness of the selected part: heat map, or only the areas thinner than a limit. */
function ThicknessSection() {
  const st = useStore((s) => s.settings.thickness);
  const selection = useStore((s) => s.selection);
  const part = useStore((s) => (s.selection.length === 1 ? s.parts.find((p) => p.id === s.selection[0]) : undefined));
  const entry = useStore((s) => (part ? s.thickness[part.id] : undefined));
  const r = entry && part && entry.mesh === part.mesh ? entry.result : null;
  const set = (patch: Partial<typeof st>) => setState({ settings: { ...getState().settings, thickness: { ...getState().settings.thickness, ...patch } } });
  const lo = st.scaleMin > 0 ? st.scaleMin : (r?.min ?? 0);
  const hi = st.scaleMax > 0 ? st.scaleMax : (r?.p95 ?? 0);
  const thin = r ? thinArea(r, st.limit) : null;
  const grad = Array.from({ length: 11 }, (_, i) => {
    const c = thicknessColor(lo + ((hi - lo) * i) / 10, lo, hi);
    return `rgb(${c.map((v) => Math.round(v * 255)).join(',')}) ${i * 10}%`;
  }).join(', ');
  return (
    <Section
      title="Thickness analysis"
      actions={
        r && part ? (
          <button className="mini" onClick={() => clearThickness(part.id)}>
            Clear
          </button>
        ) : undefined
      }
    >
      {!part ? (
        <Hint>{selection.length > 1 ? 'Select one part to analyse its wall thickness.' : 'Select a part, then analyse its wall thickness.'}</Hint>
      ) : (
        <button className="btn primary wide" onClick={() => analyzeThickness(part.id)}>
          {r ? 'Analyse again' : `Analyse wall thickness of ${part.name}`}
        </button>
      )}
      {r && (
        <>
          <Check checked={st.show} onChange={(show) => set({ show })}>
            Show on the part
          </Check>
          <Row label="Show">
            <Segmented
              value={st.view}
              onChange={(view) => set({ view })}
              options={[
                { value: 'heat', label: 'Heat map' },
                { value: 'thin', label: 'Thinner than limit' },
              ]}
            />
          </Row>
          {st.view === 'heat' && (
            <>
              <div className="thk-legend" style={{ background: `linear-gradient(to right, ${grad})` }} />
              <div className="thk-scale">
                <span>{fmm(lo)} thin</span>
                <span>{fmm((lo + hi) / 2)}</span>
                <span>thick {fmm(hi)}{st.scaleMax > 0 || !r || hi >= r.max ? '' : '+'}</span>
              </div>
              <Row label="Colour range">
                <NumberField value={st.scaleMin} min={0} step={0.5} suffix="mm" title="Thinnest colour (0 = the part's minimum)" onChange={(scaleMin) => set({ scaleMin })} />
                <NumberField value={st.scaleMax} min={0} step={0.5} suffix="mm" title="Thickest colour (0 = automatic: 95% of the surface is thinner)" onChange={(scaleMax) => set({ scaleMax })} />
              </Row>
            </>
          )}
          <Row label="Limit">
            <NumberField value={st.limit} min={0.01} step={0.1} suffix="mm" title="Areas thinner than this are flagged" onChange={(limit) => set({ limit })} />
          </Row>
          <dl className="info">
            <dt>Thinnest</dt>
            <dd>{fmm(r.min)}</dd>
            <dt>Thickest</dt>
            <dd>{fmm(r.max)}</dd>
            <dt>Average</dt>
            <dd>{fmm(r.mean)}</dd>
            <dt>Thinner than {fmm(st.limit)}</dt>
            <dd className={thin && thin.area > 0 ? 'warn' : 'okc'}>
              {thin && thin.total > 0 ? `${(thin.area / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} cm² (${((thin.area / thin.total) * 100).toFixed(1)}%)` : '—'}
            </dd>
          </dl>
          <Hint>
            Thickness at each point = distance straight into the part to the opposite wall. Use "Thinner than limit" to show only the planes and surfaces
            below the limit (pink). Grey = no opposite wall found (open or flipped areas).
          </Hint>
        </>
      )}
    </Section>
  );
}
