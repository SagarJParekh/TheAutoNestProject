import { useState } from 'react';
import { Check, Hint, NumberField, Row } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { clearCutLine, previewPolyCut, startPolyline } from '../../state/editActions';
import { cancelPreview } from '../../state/actions';
import { endLive, live, liveActive } from '../../state/livePreview';
import { DEFAULT_POLYCUT, toothProfile, type PolyCutParams, type ToothType } from '../../geometry/polycut';
import type { Part } from '../../state/types';

const setPoly = (patch: Partial<PolyCutParams>) => {
  const s = getState().settings;
  setState({ settings: { ...s, polyCut: { ...s.polyCut, ...patch } }, preview: null });
};

/** Small drawing of a tooth type, made from the same profile the cut uses. */
function ToothIcon({ type }: { type: ToothType }) {
  const { pts } = toothProfile(40, { type, size: 34, offset: 50 });
  const line = [[0, 0], ...pts, [40, 0]].map(([x, y]) => `${(2 + x * 0.9).toFixed(1)},${(11 - y * 0.9).toFixed(1)}`).join(' ');
  return (
    <svg viewBox="0 0 40 22" width="40" height="22" aria-hidden>
      <polyline points={line} className="tooth-line" />
    </svg>
  );
}

/**
 * Draw line cut, as the Magics polyline cut: draw a line across the part, then
 * indicate one segment for teeth, round the corners, limit the depth or leave a
 * clearance. The line is kept, so the cut follows every change while previewing.
 */
export function PolylineCut({ target, drawing, preview, snap }: { target?: Part; drawing: boolean; preview: boolean; snap: boolean }) {
  const p = useStore((s) => s.settings.polyCut);
  const line = useStore((s) => s.settings.cutLine);
  const recolor = useStore((s) => s.settings.polyRecolor);
  const [teethOpen, setTeethOpen] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);
  const segs = line ? (line.closed ? line.points.length : line.points.length - 1) : 0;
  const mm = (label: string, value: number, onChange: (v: number) => void, title: string, disabled = false, step = 0.5) => (
    <Row label={label}>
      <NumberField value={value} min={0} step={step} suffix="mm" title={title} disabled={disabled} onChange={(v) => onChange(Math.max(0, v))} />
    </Row>
  );
  return (
    <>
      <div className="btn-row">
        <button className="btn primary grow" disabled={!target} onClick={() => (endLive(), startPolyline())}>
          {drawing ? 'Drawing… (Esc to cancel)' : line ? 'Redraw line…' : 'Draw cut line…'}
        </button>
        {line && (
          <button className="btn" onClick={clearCutLine} title="Forget the drawn line">
            Clear
          </button>
        )}
      </div>
      <div className="contour-pick">
        <span className={line ? 'pick-ok' : 'pick-none'}>{line ? `✓ ${line.closed ? 'Closed shape' : 'Line'}: ${segs} segment${segs === 1 ? '' : 's'}` : 'No line drawn yet'}</span>
      </div>
      <Check checked={snap} onChange={(cutSnap) => setState({ settings: { ...getState().settings, cutSnap } })}>
        Snap points to the part's corners and edges
      </Check>
      <Check checked={p.roundPolyline} onChange={(roundPolyline) => setPoly({ roundPolyline })}>
        Round polyline
      </Check>
      {p.roundPolyline && mm('Corner radius', p.polylineRadius, (polylineRadius) => setPoly({ polylineRadius }), 'Radius of the arcs at the corners of the drawn line')}
      <Check checked={p.depthOn} onChange={(depthOn) => setPoly({ depthOn })}>
        Set cutting depth
      </Check>
      {p.depthOn && mm('Cutting depth', p.depth, (depth) => setPoly({ depth }), 'How deep the cut goes, measured from the front of the part along your line of sight', false, 1)}
      <Check checked={recolor} onChange={(polyRecolor) => setState({ settings: { ...getState().settings, polyRecolor }, preview: null })}>
        Autocolor result parts
      </Check>

      <button className="link-btn" onClick={() => setClearOpen(!clearOpen)}>
        {clearOpen ? '▾' : '▸'} Clearance {p.clearanceOn ? `(${p.clearance} mm)` : '(off)'}
      </button>
      {clearOpen && (
        <div className="joint-advanced">
          <Check checked={p.clearanceOn} onChange={(clearanceOn) => setPoly({ clearanceOn })}>
            Leave a clearance between the pieces
          </Check>
          {mm('Clearance', p.clearance, (clearance) => setPoly({ clearance }), 'Gap between the two pieces along the cut (half taken from each)', !p.clearanceOn, 0.05)}
        </div>
      )}

      <button className="link-btn" onClick={() => setTeethOpen(!teethOpen)}>
        {teethOpen ? '▾' : '▸'} Teeth parameters
      </button>
      {teethOpen && (
        <div className="joint-advanced">
          <Row label="Teeth segment">
            <select
              className="tb-select wide"
              value={p.segment > segs ? 0 : p.segment}
              disabled={!line}
              onChange={(e) => setPoly({ segment: Number(e.target.value) })}
              title="The segment of the drawn line that gets the teeth (counted from the first point)"
            >
              <option value={0}>None</option>
              {Array.from({ length: segs }, (_, i) => (
                <option key={i} value={i + 1}>
                  Segment {i + 1}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Type">
            <div className="tooth-types">
              {(['triangle', 'square', 'dovetail'] as ToothType[]).map((t) => (
                <button key={t} className={`joint-btn ${p.type === t ? 'on' : ''}`} onClick={() => setPoly({ type: t })} title={t === 'triangle' ? 'Triangle (zig-zag)' : t === 'square' ? 'Square' : 'Dovetail'}>
                  <ToothIcon type={t} />
                </button>
              ))}
            </div>
          </Row>
          <Row label="Size">
            <NumberField value={p.size} min={1} max={100} step={5} suffix="%" title="Tooth pitch as a percentage of the segment's length (smaller = more, smaller teeth)" onChange={(size) => setPoly({ size: Math.min(100, Math.max(1, size)) })} />
          </Row>
          <Row label="Offset">
            <NumberField value={p.offset} min={0} max={100} step={10} suffix="%" title="Where the teeth sit across the line: 50 % centred on it, 0 % all on one side, 100 % all on the other" onChange={(offset) => setPoly({ offset: Math.min(100, Math.max(0, offset)) })} />
          </Row>
          <Check checked={p.roundTeeth} onChange={(roundTeeth) => setPoly({ roundTeeth })}>
            Round teeth
          </Check>
          {p.roundTeeth && mm('Teeth radius', p.teethRadius, (teethRadius) => setPoly({ teethRadius }), 'Radius of the rounded corners of the teeth')}
        </div>
      )}

      <div className="btn-row">
        <button className="btn primary grow" disabled={!line || !target || preview} onClick={() => !liveActive() && void live(previewPolyCut)}>
          Preview cut
        </button>
        <button className="btn" onClick={() => setPoly({ ...DEFAULT_POLYCUT, segment: p.segment })} title="Back to the default teeth, rounding, depth and clearance">
          Reset
        </button>
        {preview && (
          <button className="btn" onClick={cancelPreview}>
            Cancel
          </button>
        )}
      </div>
      <Hint>
        Look at the part from the direction you want to cut, then click points to draw a line of straight segments across the whole part; double-click or
        Enter finishes it (click the first point again for a closed shape, which cuts out the enclosed area). The cut shows at once and follows every change:
        pick a teeth segment to give that part of the line triangle, square or dovetail teeth so the pieces key together. Snapping puts points on corners
        (square marker) and sharp edges (diamond); Alt places a point freely, Shift keeps 15° angles, Backspace removes the last point. Needs a watertight part.
      </Hint>
    </>
  );
}
