import { useEffect, useState } from 'react';
import { Check, Hint, NumberField, Row, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { cancelPreview, clearContourPicks, previewJointCut, startContourPick } from '../../state/actions';
import { live, liveActive } from '../../state/livePreview';
import { PlaneControls } from './PlaneControls';
import { DEFAULT_JOINT, LAP_JOINTS, TONGUE_JOINTS, isAcrossJoint, isTongueFamily, jointProfile, lapProfile, type JointKind, type JointParams } from '../../geometry/joint';
import type { Part } from '../../state/types';

const setJoint = (patch: Partial<JointParams>) => {
  const s = getState().settings;
  setState({ settings: { ...s, joint: { ...s.joint, ...patch } }, preview: null });
};

/** Pick a joint type, with sizes that suit it (across joints overlap automatically, tongue & groove fills the wall). */
const chooseKind = (kind: JointKind) => {
  const j = getState().settings.joint;
  const patch: Partial<JointParams> = { kind };
  if (isAcrossJoint(kind) !== isAcrossJoint(j.kind)) patch.depth = isAcrossJoint(kind) ? 0 : DEFAULT_JOINT.depth;
  if (kind === 'tongue') patch.width = 0;
  else if (!isAcrossJoint(kind) && !(j.width > 0)) patch.width = DEFAULT_JOINT.width;
  setJoint(patch);
};

/** Small cross-section drawing of a joint, made from the same profile the cut uses. */
function JointIcon({ kind, params }: { kind: JointKind; params: JointParams }) {
  const W = 48, H = 30, tongue = isAcrossJoint(kind);
  // lap joints: the outer surface on the left, the profile running inwards; tongue joints: across a 12 mm section
  const prof = tongue
    ? jointProfile({ kind, depth: kind === 'finger' ? 6 : kind === 'scarf' ? 16 : 10, count: Math.min(params.count, 6), angle: params.angle }, 0, 12)
    : kind === 'tongue'
      ? lapProfile({ kind, depth: 4, offset: 3.5, width: 5, spacing: 0, count: 1, angle: 0 })
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

/** Tongue & groove through a wall: the tongue b in from both sides, the groove around it with the clearances. */
function TongueDiagram() {
  return (
    <svg viewBox="0 0 200 120" className="joint-diagram" aria-label="Tongue joint parameters">
      <path className="lower" d="M30,112 L30,72 L70,72 L70,32 L130,32 L130,72 L170,72 L170,112 Z" />
      <path className="upper" d="M30,4 L170,4 L170,64 L137,64 L137,25 L63,25 L63,64 L30,64 Z" />
      <g className="dim">
        <line x1="100" y1="32" x2="100" y2="72" />
        <text x="104" y="56">a</text>
        <line x1="30" y1="92" x2="70" y2="92" />
        <text x="46" y="88">b</text>
        <line x1="130" y1="92" x2="170" y2="92" />
        <text x="146" y="88">b</text>
        <text x="20" y="71">c</text>
        <text x="58" y="80">d</text>
        <text x="96" y="22">e</text>
      </g>
    </svg>
  );
}

export function JointCut({ target }: { target?: Part }) {
  const plane = useStore((s) => s.cutPlane);
  const gap = useStore((s) => s.settings.cut.gap);
  const j = useStore((s) => s.settings.joint);
  const preview = useStore((s) => s.preview);
  const picking = useStore((s) => s.pickMode === 'contour');
  const [advanced, setAdvanced] = useState(false);
  // indicated contours belong to one part: a different part starts again
  const targetId = target?.id;
  useEffect(() => {
    if (getState().settings.joint.picks.length) clearContourPicks();
  }, [targetId]);
  // across joints (half lap, finger, scarf) have their own sizes; the rest follow the outline with a–e
  const tongue = isAcrossJoint(j.kind);
  const family = isTongueFamily(j.kind) ? 'tongue' : 'lap';
  const tg = j.kind === 'tongue';
  const list = family === 'tongue' ? TONGUE_JOINTS : LAP_JOINTS;
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
          value={family}
          onChange={(f) => chooseKind(f === 'tongue' ? 'tongue' : 'step')}
          options={[
            { value: 'lap', label: 'Lap joint', title: 'A notch that follows the outline of the cut: a lip on one piece, a skirt on the other' },
            { value: 'tongue', label: 'Tongue joint', title: 'A tongue in the middle of the wall that keys into a groove in the other piece (or a joint straight across the section)' },
          ]}
        />
      </div>
      <div className="joint-grid">
        {list.map((o) => (
          <button key={o.value} className={`joint-btn ${j.kind === o.value ? 'on' : ''}`} onClick={() => chooseKind(o.value)} title={o.label}>
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
          <div className="sub-title">Cut based on</div>
          <div className="contour-basis">
            {(
              [
                ['contours', 'Indicated section contour(s)', 'Click next to a cross-section: that whole region gets the joint, with the offset measured from its outer boundary (on a tube the notch runs out to the bore)'],
                ['subcontours', 'Indicated subcontour(s)', 'Click next to single loops of the section (an outer boundary or a hole): the offset is measured from those loops only, e.g. pick the bore to put the skirt on the inside'],
              ] as const
            ).map(([value, label, title]) => (
              <label key={value} className="radio-row" title={title}>
                <input type="radio" checked={(j.basis ?? 'contours') === value} onChange={() => setJoint({ basis: value })} />
                {label}
              </label>
            ))}
            <div className="contour-pick">
              <span className={j.picks.length ? 'pick-ok' : 'pick-none'} title={j.picks.length ? 'Contours indicated' : 'Nothing indicated: every region gets the joint from its outer boundary'}>
                {j.picks.length ? `✓ ${j.picks.length} indicated` : tg && !(j.width > 0) ? 'All contours' : 'All outer contours'}
              </span>
              {j.picks.length > 0 && (
                <button className="mini" onClick={clearContourPicks} title="Forget the indicated contours">
                  ✕
                </button>
              )}
              <button className={`mini ${picking ? 'on' : ''}`} disabled={!target} onClick={startContourPick} title="Click on the part next to the section contour to joint (press again to add more)">
                {picking ? 'Click the part…' : 'Indicate'}
              </button>
            </div>
          </div>
          {tg ? <TongueDiagram /> : <LapDiagram />}
          <div className="sub-title">{tg ? 'Tongue joint parameters' : 'Lap joint parameters'}</div>
          {mmField(tg ? 'Tongue height (a)' : 'Notch height (a)', 'depth', tg ? 'How far the tongue stands up from the cut plane' : 'How far the notch stands up from the cut plane', 0.5)}
          {mmField(
            'Offset (b)',
            'offset',
            tg
              ? 'Distance of the tongue from each wall of the indicated contour (outside and, on hollow parts, inside): the thickness of the groove’s sides'
              : 'Distance of the notch from the indicated contour (measured inwards across the cut): the thickness of the skirt',
            0.1,
          )}
          {j.kind !== 'step' &&
            mmField(
              'Tongue width',
              'width',
              tg ? 'Width of the tongue, from the offset inwards; 0 = fill the wall, ending b from the inner wall too' : j.kind === 'toothed' ? 'Width of each tooth at its root' : 'Width of each tongue at its root',
              0.5,
            )}
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
          {mmField('Notch clearance (d)', 'notchClearance', 'Gap at the sides of the notch', 0.05)}
          {mmField('Front clearance (c)', 'frontClearance', 'Gap on the ledge around the notch', 0.05)}
          {mmField('Back clearance (e)', 'backClearance', 'Gap on top of the notch', 0.05)}
          <Check
            checked={j.showPreview !== false}
            onChange={(showPreview) => {
              setJoint({ showPreview });
              if (!showPreview) cancelPreview();
              else if (target && !liveActive()) void live(previewJointCut);
            }}
          >
            Show preview
          </Check>
          <div className="joint-options">
            <Check checked={j.negative} onChange={(negative) => setJoint({ negative })}>
              Invert notch direction
            </Check>
            <Check checked={j.straight !== false} onChange={(straight) => setJoint({ straight })}>
              Straight cut
            </Check>
            <Check checked={j.recolor} onChange={(recolor) => setJoint({ recolor })}>
              Autocolor result parts
            </Check>
          </div>
        </>
      )}
      <Row label="Gap">
        <NumberField value={gap} min={0} suffix="mm" onChange={(g) => setState({ settings: { ...getState().settings, cut: { gap: g } }, preview: null })} title="Move the two pieces apart after cutting, to see the joint" />
      </Row>
      {tongue && (
        <button className="link-btn" onClick={() => setAdvanced(!advanced)}>
          {advanced ? '▾' : '▸'} Advanced options
        </button>
      )}
      {tongue && advanced && (
        <div className="joint-advanced">
          <Check checked={j.negative} onChange={(negative) => setJoint({ negative })}>
            Swap the two sides of the joint
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
        <button className="btn" onClick={() => setJoint({ ...DEFAULT_JOINT, kind: j.kind, depth: tongue ? 0 : DEFAULT_JOINT.depth, width: tg ? 0 : DEFAULT_JOINT.width, picks: j.picks })} title="Back to the default parameters">
          Reset
        </button>
      </div>
      <Hint>
        {tongue
          ? 'Tongue joints run straight across the cross-section at the plane: a half lap halves the thickness, a scarf runs a slope through it and finger joints interlock across the width.'
          : tg
            ? 'Tongue & groove follows the outline of the part where it is cut: one piece gets a tongue set in by the offset b from every wall of the indicated contour (on a tube, b from the outside and b from the bore), the other a matching groove, with the clearances in between. Regions not indicated are cut flat. Give a tongue width to set it from the outer wall only (e.g. on solid parts).'
            : 'Lap joints follow the outline of the part where it is cut: one piece gets the notch (a plateau, tongues or teeth set in by the offset b from the indicated contour), the other a matching skirt over it, with the clearances in between. Regions not indicated are cut flat. Straight cut keeps the notch walls square to the plane; off, they follow the slope of the surface. A dovetail cannot be pushed together along a closed outline.'}{' '}
        Changes update the preview while it is open. Needs a watertight part.
      </Hint>
    </>
  );
}
