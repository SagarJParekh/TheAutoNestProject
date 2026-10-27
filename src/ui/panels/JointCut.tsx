import { Hint, NumberField, Row, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { previewJointCut } from '../../state/actions';
import { live } from '../../state/livePreview';
import { PlaneControls } from './PlaneControls';
import { LAP_JOINTS, TONGUE_JOINTS, isTongueJoint, jointProfile, type JointKind, type JointParams } from '../../geometry/joint';
import type { Part } from '../../state/types';

const setJoint = (patch: Partial<JointParams>) => {
  const s = getState().settings;
  setState({ settings: { ...s, joint: { ...s.joint, ...patch } }, preview: null });
};

/** Small cross-section drawing of a joint, made from the same profile the cut uses. */
function JointIcon({ kind, params }: { kind: JointKind; params: JointParams }) {
  const W = 48, H = 30, tongue = isTongueJoint(kind);
  // a 12 mm section; sizes as automatic except count / angle so the icon follows those settings
  const prof = jointProfile({ ...params, kind, depth: tongue ? (kind === 'finger' ? 6 : kind === 'scarf' ? 16 : 10) : 4, width: kind === 'multiple' ? 0 : 4, count: Math.min(params.count, 6) }, 0, 12);
  const ns = prof.map(([, n]) => n);
  const lo = Math.min(...ns, 0), hi = Math.max(...ns, 0), pad = (hi - lo) * 0.6 + 2;
  // s runs across (horizontal), n runs up
  const x = (s: number) => 3 + (s / 12) * (W - 6);
  const y = (n: number) => H / 2 - ((n - (lo + hi) / 2) / (hi - lo + 2 * pad)) * H;
  const line = [[0, prof[0][1]], ...prof, [12, prof[prof.length - 1][1]]] as [number, number][];
  const pts = line.map(([s, n]) => `${x(s).toFixed(1)},${y(n).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="joint-icon" aria-hidden>
      <rect x={3} y={1} width={W - 6} height={H - 2} className="upper" />
      <polygon points={`${pts} ${x(12)},${H - 1} ${x(0)},${H - 1}`} className="lower" />
      <polyline points={pts} className="edge" />
    </svg>
  );
}

export function JointCut({ target }: { target?: Part }) {
  const plane = useStore((s) => s.cutPlane);
  const gap = useStore((s) => s.settings.cut.gap);
  const j = useStore((s) => s.settings.joint);
  const preview = useStore((s) => s.preview);
  const tongue = isTongueJoint(j.kind);
  const list = tongue ? TONGUE_JOINTS : LAP_JOINTS;
  const counted = j.kind === 'multiple' || j.kind === 'toothed' || j.kind === 'finger';
  const widthUsed = !tongue && j.kind !== 'step' && j.kind !== 'toothed';
  return (
    <>
      <div className="repair-tabs joint-family">
        <Segmented
          value={tongue ? 'tongue' : 'lap'}
          onChange={(f) => setJoint({ kind: f === 'tongue' ? 'halfLap' : 'square', depth: 0, width: 0 })}
          options={[
            { value: 'lap', label: 'Lap joint', title: 'Tongues and grooves on the cut surface' },
            { value: 'tongue', label: 'Tongue joint', title: 'The pieces overlap across the cross-section' },
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
      <PlaneControls value={plane} parts={target ? [target] : []} onChange={(p) => setState({ cutPlane: p, preview: null })} />
      <Row label={tongue ? 'Overlap length' : 'Depth'}>
        <NumberField
          value={j.depth}
          min={0}
          step={0.5}
          suffix="mm"
          title={tongue ? 'How far the two pieces overlap along the plane normal (0 = automatic, from the section size)' : 'Height of the tongues (0 = automatic: a third of the section)'}
          onChange={(depth) => setJoint({ depth: Math.max(0, depth) })}
        />
      </Row>
      {widthUsed && (
        <Row label="Tongue width">
          <NumberField value={j.width} min={0} step={0.5} suffix="mm" title="Width of each tongue at its root (0 = automatic)" onChange={(width) => setJoint({ width: Math.max(0, width) })} />
        </Row>
      )}
      {counted && (
        <Row label={j.kind === 'finger' ? 'Fingers' : j.kind === 'toothed' ? 'Teeth' : 'Tongues'}>
          <NumberField value={j.count} min={1} max={50} step={1} precision={0} onChange={(count) => setJoint({ count: Math.max(1, Math.round(count)) })} />
        </Row>
      )}
      {(j.kind === 'dovetail' || j.kind === 'finger') && (
        <Row label={j.kind === 'dovetail' ? 'Flare angle' : 'Taper angle'}>
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
      <Row label="Fit clearance">
        <NumberField
          value={j.clearance}
          min={0}
          step={0.05}
          suffix="mm"
          title="Gap between the mating faces so the printed pieces slide together (taken half from each piece)"
          onChange={(clearance) => setJoint({ clearance: Math.max(0, clearance) })}
        />
      </Row>
      <Row label="Gap">
        <NumberField value={gap} min={0} suffix="mm" onChange={(g) => setState({ settings: { ...getState().settings, cut: { gap: g } }, preview: null })} title="Move the two pieces apart after cutting" />
      </Row>
      <button className="btn primary wide" disabled={!target || !!preview} onClick={() => live(previewJointCut)}>
        Preview joint
      </button>
      <Hint>
        {tongue
          ? 'Tongue joints work on the cross-section at the plane: a half lap halves the thickness, a scarf runs a slope through it and finger joints interlock across the width. The overlap length is measured along the plane normal.'
          : 'Lap joints shape the cut surface: tongues on one piece fit grooves in the other (U, square, several, a step, V teeth or a dovetail), running across the section’s thickness.'}{' '}
        Place the plane where the part should be split; Gap moves the pieces apart so you can see the joint. Needs a watertight part.
      </Hint>
    </>
  );
}
