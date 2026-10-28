import { useState } from 'react';
import { Check, Hint, NumberField, Row, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { previewJointCut } from '../../state/actions';
import { live } from '../../state/livePreview';
import { PlaneControls } from './PlaneControls';
import { DEFAULT_JOINT, LAP_JOINTS, TONGUE_JOINTS, isTongueJoint, jointProfile, lapProfile, type JointKind, type JointParams } from '../../geometry/joint';
import type { Part } from '../../state/types';

const setJoint = (patch: Partial<JointParams>) => {
  const s = getState().settings;
  setState({ settings: { ...s, joint: { ...s.joint, ...patch } }, preview: null });
};

/** Small cross-section drawing of a joint, made from the same profile the cut uses. */
function JointIcon({ kind, params }: { kind: JointKind; params: JointParams }) {
  const W = 48, H = 30, tongue = isTongueJoint(kind);
  // lap joints: the outer surface on the left, the profile running inwards; tongue joints: across a 12 mm section
  const prof = tongue
    ? jointProfile({ kind, depth: kind === 'finger' ? 6 : kind === 'scarf' ? 16 : 10, count: Math.min(params.count, 6), angle: params.angle }, 0, 12)
    : lapProfile({ kind, depth: 4, offset: 2, width: kind === 'multiple' || kind === 'toothed' ? 2 : 4, spacing: 1.5, count: Math.min(params.count, 4), angle: params.angle });
  const ns = prof.map(([, n]) => n);
  const lo = Math.min(...ns, 0), hi = Math.max(...ns, 0), pad = (hi - lo) * 0.6 + 2;
  const x = (s: number) => 3 + (s / 12) * (W - 6);
  const y = (n: number) => H / 2 - ((n - (lo + hi) / 2) / (hi - lo + 2 * pad)) * H;
  const tail = tongue ? prof[prof.length - 1][1] : 0;
  const line = [[0, prof[0][1]], ...prof.filter(([s]) => s <= 12), [12, tail]] as [number, number][];
  const pts = line.map(([s, n]) => `${x(s).toFixed(1)},${y(n).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="joint-icon" aria-hidden>
      <rect x={3} y={1} width={W - 6} height={H - 2} className="upper" />
      <polygon points={`${pts} ${x(12)},${H - 1} ${x(0)},${H - 1}`} className="lower" />
      <polyline points={pts} className="edge" />
    </svg>
  );
}

/** What a, b, c, d and e mean, on a lap joint cut through (outer surface on the left). */
function LapDiagram() {
  return (
    <svg viewBox="0 0 200 120" className="joint-diagram" aria-label="Lap joint parameters">
      <path className="lower" d="M12,112 L12,72 L46,72 L46,32 L196,32 L196,112 Z" />
      <path className="upper" d="M12,4 L196,4 L196,25 L39,25 L39,64 L12,64 Z" />
      <g className="dim">
        <line x1="58" y1="32" x2="58" y2="72" />
        <text x="62" y="56">a</text>
        <line x1="12" y1="92" x2="46" y2="92" />
        <text x="26" y="88">b</text>
        <text x="2" y="71">c</text>
        <text x="38" y="80">d</text>
        <text x="120" y="31">e</text>
      </g>
    </svg>
  );
}

export function JointCut({ target }: { target?: Part }) {
  const plane = useStore((s) => s.cutPlane);
  const gap = useStore((s) => s.settings.cut.gap);
  const j = useStore((s) => s.settings.joint);
  const preview = useStore((s) => s.preview);
  const [advanced, setAdvanced] = useState(false);
  const tongue = isTongueJoint(j.kind);
  const list = tongue ? TONGUE_JOINTS : LAP_JOINTS;
  const counted = j.kind === 'multiple' || j.kind === 'toothed' || j.kind === 'finger';
  const mmField = (label: string, key: 'depth' | 'offset' | 'width' | 'spacing' | 'notchClearance' | 'frontClearance' | 'backClearance' | 'clearance', title: string, step = 0.5) => (
    <Row label={label}>
      <NumberField value={j[key]} min={0} step={step} suffix="mm" title={title} onChange={(v) => setJoint({ [key]: Math.max(0, v) })} />
    </Row>
  );
  return (
    <>
      <div className="repair-tabs joint-family">
        <Segmented
          value={tongue ? 'tongue' : 'lap'}
          onChange={(f) => setJoint(f === 'tongue' ? { kind: 'halfLap', depth: 0 } : { kind: 'step', depth: DEFAULT_JOINT.depth })}
          options={[
            { value: 'lap', label: 'Lap joint', title: 'A notch that follows the outline of the cut' },
            { value: 'tongue', label: 'Tongue joint', title: 'The pieces overlap straight across the cross-section' },
          ]}
        />
      </div>
      <div className="joint-grid">
        {list.map((o) => (
          <button key={o.value} className={`joint-btn ${j.kind === o.value ? 'on' : ''}`} onClick={() => setJoint({ kind: o.value })} title={o.label}>
            <JointIcon kind={o.value} params={j} />
            <span>{o.label}</span>
          </button>
        ))}
      </div>
      <PlaneControls value={plane} parts={target ? [target] : []} onChange={(p) => setState({ cutPlane: { ...p, rows: plane.rows, angled: plane.angled }, preview: null })} />
      {tongue ? (
        <>
          {mmField('Overlap length', 'depth', 'How far the two pieces overlap along the plane normal (0 = automatic, from the section size)')}
          {counted && (
            <Row label="Fingers">
              <NumberField value={j.count} min={1} max={50} step={1} precision={0} onChange={(count) => setJoint({ count: Math.max(1, Math.round(count)) })} />
            </Row>
          )}
          {j.kind === 'finger' && (
            <Row label="Taper angle">
              <NumberField value={j.angle} min={0} max={45} step={1} suffix="°" onChange={(angle) => setJoint({ angle: Math.max(0, Math.min(45, angle)) })} />
            </Row>
          )}
          <Row label="Turn profile">
            <NumberField
              value={j.rotate}
              step={15}
              suffix="°"
              title={j.kind === 'finger' ? 'The fingers run across the section’s width; turn them within the plane' : 'The profile runs across the section’s thinnest direction; turn it within the plane (90° = across the width)'}
              onChange={(rotate) => setJoint({ rotate })}
            />
          </Row>
          {mmField('Fit clearance', 'clearance', 'Gap between the mating faces so the printed pieces slide together (taken half from each piece)', 0.05)}
        </>
      ) : (
        <>
          <LapDiagram />
          <div className="sub-title">Parameters</div>
          {mmField('Notch height (a)', 'depth', 'How far the notch stands up from the cut plane')}
          {mmField('Offset (b)', 'offset', 'Distance of the notch from the part’s surface (measured inwards across the cut)')}
          {j.kind !== 'step' && mmField('Tongue width', 'width', j.kind === 'toothed' ? 'Width of each tooth at its root' : 'Width of each tongue at its root')}
          {j.kind === 'multiple' && mmField('Spacing', 'spacing', 'Gap between neighbouring tongues')}
          {(j.kind === 'multiple' || j.kind === 'toothed') && (
            <Row label={j.kind === 'toothed' ? 'Teeth' : 'Tongues'}>
              <NumberField value={j.count} min={1} max={50} step={1} precision={0} onChange={(count) => setJoint({ count: Math.max(1, Math.round(count)) })} />
            </Row>
          )}
          {j.kind === 'dovetail' && (
            <Row label="Flare angle">
              <NumberField value={j.angle} min={0} max={45} step={1} suffix="°" onChange={(angle) => setJoint({ angle: Math.max(0, Math.min(45, angle)) })} />
            </Row>
          )}
          <div className="sub-title">Clearances</div>
          {mmField('Notch clearance (d)', 'notchClearance', 'Gap at the sides of the notch', 0.01)}
          {mmField('Front clearance (c)', 'frontClearance', 'Gap on the ledge around the notch', 0.01)}
          {mmField('Back clearance (e)', 'backClearance', 'Gap on top of the notch', 0.01)}
        </>
      )}
      <Row label="Gap">
        <NumberField value={gap} min={0} suffix="mm" onChange={(g) => setState({ settings: { ...getState().settings, cut: { gap: g } }, preview: null })} title="Move the two pieces apart after cutting, to see the joint" />
      </Row>
      <button className="link-btn" onClick={() => setAdvanced(!advanced)}>
        {advanced ? '▾' : '▸'} Advanced options
      </button>
      {advanced && (
        <div className="joint-advanced">
          <Check checked={j.negative} onChange={(negative) => setJoint({ negative })}>
            {tongue ? 'Swap the two sides of the joint' : 'Add notch in negative direction'}
          </Check>
          <Check checked={j.recolor} onChange={(recolor) => setJoint({ recolor })}>
            Colour parts after cutting
          </Check>
        </div>
      )}
      <div className="btn-row">
        <button className="btn primary grow" disabled={!target || !!preview} onClick={() => live(previewJointCut)}>
          Preview joint
        </button>
        <button className="btn" onClick={() => setJoint({ ...DEFAULT_JOINT, kind: j.kind, depth: tongue ? 0 : DEFAULT_JOINT.depth })} title="Back to the default parameters">
          Reset
        </button>
      </div>
      <Hint>
        {tongue
          ? 'Tongue joints run straight across the cross-section at the plane: a half lap halves the thickness, a scarf runs a slope through it and finger joints interlock across the width.'
          : 'Lap joints follow the outline of the part where it is cut: one piece gets the notch (a plateau, tongues or teeth set in by the offset b), the other a matching skirt over it, with the clearances in between. On a hollow part the offset counts from both sides of the wall. A dovetail cannot be pushed together along a closed outline.'}{' '}
        Changes update the preview while it is open. Needs a watertight part.
      </Hint>
    </>
  );
}
