import { Icon } from '../icons';
import { Check, Hint, NumberField, Row, Section, Segmented, VecRow } from '../controls';
import { getState, setState, updateParts, useStore } from '../../state/store';
import { centerOnOrigin, dropToBed, mirrorParts } from '../../state/actions';
import { alignToReference, arrangeOnBed, arrayParts, autoArrange, mirrorCopies } from '../../state/featureActions';
import { localBounds } from '../../state/math';
import type { Part, Transform } from '../../state/types';
import type { Vec3 } from '../../geometry';
import { useState } from 'react';
import { Vector3 } from 'three';

export function TransformPanel({ parts }: { parts: Part[] }) {
  const pickMode = useStore((s) => s.pickMode);
  const gizmo = useStore((s) => s.gizmo);
  const arr = useStore((s) => s.settings.arrange);
  const al = useStore((s) => s.settings.align2);
  // select raw state; deriving a new array inside the selector would re-render forever
  const selection = useStore((s) => s.selection);
  const allParts = useStore((s) => s.parts);
  const selOrder = selection.map((id) => allParts.find((p) => p.id === id)?.name ?? '');
  const setAl = (patch: Partial<typeof al>) => setState({ settings: { ...getState().settings, align2: { ...getState().settings.align2, ...patch } } });
  const setArr = (patch: Partial<typeof arr>) => setState({ settings: { ...getState().settings, arrange: { ...getState().settings.arrange, ...patch } } });
  const [uniform, setUniform] = useState(true);
  const editable = parts.filter((p) => !p.locked);
  const single = parts.length === 1 ? parts[0] : null;
  const disabled = !editable.length;

  const setT = (label: string, patch: (t: Transform, p: Part) => Partial<Transform>) =>
    updateParts(label, editable.map((p) => p.id), (p) => ({ ...p, transform: { ...p.transform, ...patch(p.transform, p) } }));

  const axisField = (key: 'position' | 'rotation', i: number, suffix: string, step: number) => (
    <NumberField
      key={key + i}
      label={'XYZ'[i]}
      value={single ? single.transform[key][i] : 0}
      disabled={!single || single.locked}
      step={step}
      suffix={suffix}
      onChange={(v) =>
        setT(key === 'position' ? 'Move' : 'Rotate', (t) => {
          const a = [...t[key]] as Vec3;
          a[i] = v;
          return { [key]: a };
        })
      }
    />
  );

  const sz = single ? localBounds(single.mesh).getSize(new Vector3()) : null;

  return (
    <Section title="Transform">
      <Row label="Mouse">
        <Segmented
          value={gizmo === 'rotate' ? 'rotate' : gizmo === 'place' ? 'place' : 'translate'}
          onChange={(g) => setState({ gizmo: g })}
          options={[
            { value: 'translate', label: 'Move gizmo' },
            { value: 'rotate', label: 'Rotate' },
            { value: 'place', label: 'Pick & place' },
          ]}
        />
      </Row>
      {gizmo === 'place' && (
        <Hint>Drag any part with the mouse to move it on the bed. Shift-drag moves it up / down, Ctrl snaps to 1 mm. Drag empty space to orbit.</Hint>
      )}
      {parts.length === 0 && <Hint>Select a part to transform it.</Hint>}
      {single && (
        <>
          <VecRow label="Position (mm)">{[0, 1, 2].map((i) => axisField('position', i, '', 1))}</VecRow>
          <VecRow label="Rotation (°)">{[0, 1, 2].map((i) => axisField('rotation', i, '', 5))}</VecRow>
          <VecRow label="Scale (%)">
            {[0, 1, 2].map((i) => (
              <NumberField
                key={'s' + i}
                label={'XYZ'[i]}
                value={single.transform.scale[i] * 100}
                disabled={single.locked}
                min={0.01}
                step={1}
                onChange={(v) =>
                  setT('Scale', (t) => {
                    const f = v / 100;
                    if (uniform) {
                      const k = f / t.scale[i];
                      return { scale: t.scale.map((s) => s * k) as Vec3 };
                    }
                    const s = [...t.scale] as Vec3;
                    s[i] = f;
                    return { scale: s };
                  })
                }
              />
            ))}
          </VecRow>
          {sz && (
            <VecRow label="Size (mm)">
              {(['x', 'y', 'z'] as const).map((k, i) => (
                <NumberField
                  key={'d' + k}
                  label={'XYZ'[i]}
                  value={sz[k] * single.transform.scale[i]}
                  disabled={single.locked || sz[k] === 0}
                  min={0.001}
                  precision={2}
                  onChange={(v) =>
                    setT('Scale', (t) => {
                      const f = v / sz[k];
                      if (uniform) {
                        const r = f / t.scale[i];
                        return { scale: t.scale.map((s) => s * r) as Vec3 };
                      }
                      const s = [...t.scale] as Vec3;
                      s[i] = f;
                      return { scale: s };
                    })
                  }
                />
              ))}
            </VecRow>
          )}
          <Row>
            <Check checked={uniform} onChange={setUniform}>
              Uniform scale
            </Check>
            <button className="mini" disabled={single.locked} onClick={() => setT('Reset scale', () => ({ scale: [1, 1, 1] }))}>
              Reset scale
            </button>
            <button className="mini" disabled={single.locked} onClick={() => setT('Reset rotation', () => ({ rotation: [0, 0, 0] }))}>
              Reset rotation
            </button>
          </Row>
        </>
      )}
      {parts.length > 0 && (
        <>
          <Row label="Mirror">
            {[0, 1, 2].map((a) => (
              <button
                key={a}
                className="btn"
                disabled={arr.mirrorCopy ? parts.length === 0 : disabled}
                onClick={() => (arr.mirrorCopy ? mirrorCopies(a as 0 | 1 | 2) : mirrorParts(a as 0 | 1 | 2))}
              >
                {'XYZ'[a]}
              </button>
            ))}
            <Check checked={arr.mirrorCopy} onChange={(mirrorCopy) => setArr({ mirrorCopy })}>
              Keep original (copy)
            </Check>
          </Row>
          <div className="btn-grid">
            <button className="btn" disabled={disabled} onClick={() => dropToBed()} title="Drop to bed (B)">
              Drop to bed
            </button>
            <button className="btn" disabled={disabled} onClick={() => centerOnOrigin()} title="Centre on origin in X/Y (Shift+C)">
              Centre on origin
            </button>
            <button
              className={`btn ${pickMode === 'layflat' ? 'primary' : ''}`}
              disabled={disabled}
              onClick={() => setState({ pickMode: getState().pickMode === 'layflat' ? null : 'layflat' })}
              title="Lay flat: click a face to make it the bottom (F)"
            >
              {Icon.layflat} Lay flat…
            </button>
          </div>
          {parts.some((p) => p.locked) && <Hint>Locked parts are not changed.</Hint>}
        </>
      )}
      <h4>Align to part</h4>
      {selOrder.length < 2 ? (
        <Hint>Select the reference part, then Ctrl-click the part(s) to move.</Hint>
      ) : (
        <p className="muted small">
          Reference: <strong>{selOrder[0]}</strong> · moving: {selOrder.slice(1).join(', ')}
        </p>
      )}
      <Row label="Location">
        <Segmented
          value={al.location}
          onChange={(location) => setAl({ location })}
          options={[
            { value: 'center', label: 'Centre' },
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
            { value: 'front', label: 'Front' },
            { value: 'back', label: 'Back' },
          ]}
        />
      </Row>
      <Row label="Axis">
        <Segmented
          value={al.axis}
          onChange={(axis) => setAl({ axis })}
          options={[
            { value: 'x', label: 'X' },
            { value: 'y', label: 'Y' },
            { value: 'both', label: 'X + Y' },
          ]}
        />
      </Row>
      {al.location !== 'center' && (
        <>
          <Check checked={al.beside} onChange={(beside) => setAl({ beside })}>
            Place beside the reference (outside its {al.location} side)
          </Check>
          {al.beside && (
            <Row label="Distance to part">
              <NumberField value={al.distance} min={0} step={1} suffix="mm" onChange={(distance) => setAl({ distance })} />
            </Row>
          )}
        </>
      )}
      <button className="btn wide" disabled={selOrder.length < 2} onClick={alignToReference}>
        Align
      </button>
      <Hint>
        {al.location === 'center'
          ? 'Centres the parts on the reference along the chosen axis.'
          : al.beside
            ? `Puts the parts ${al.distance} mm outside the reference's ${al.location} side${al.axis === 'both' ? ', centred on the other axis' : ''}.`
            : `Lines up the ${al.location} edges with the reference.`}
      </Hint>
      <h4>Array (2D)</h4>
      <Row label="Columns × rows">
        <NumberField value={arr.cols} min={1} max={50} step={1} precision={0} onChange={(cols) => setArr({ cols: Math.round(cols) })} />
        <NumberField value={arr.rows} min={1} max={50} step={1} precision={0} onChange={(rows) => setArr({ rows: Math.round(rows) })} />
      </Row>
      <Row label="Gap">
        <NumberField value={arr.gap} min={0} step={1} suffix="mm" onChange={(gap) => setArr({ gap })} />
      </Row>
      <button className="btn wide" disabled={parts.length !== 1 || !!parts[0]?.locked} onClick={arrayParts} title="Copies of the selected part in a grid on the bed">
        Create {arr.cols}×{arr.rows} array
      </button>
      <h4>Auto arrange</h4>
      <button className="btn primary wide" onClick={autoArrange} title="Lay every part (selected, or all) on its largest flat face and arrange them on the bed in X and Y">
        Auto arrange {parts.length ? `${parts.length} selected` : 'all parts'}
      </button>
      <Check checked={arr.autoAlignXY} onChange={(autoAlignXY) => setArr({ autoAlignXY })}>
        Turn parts to line up with X / Y
      </Check>
      <Hint>
        Finds each part's largest flat face it can stand on (coplanar faces like the bottoms of feet count together), puts it down on the bed, then lays
        the parts out in X and Y within the bed size below, without stacking. Parts with no flat face keep their tilt.
      </Hint>
      <h4>Arrange on bed</h4>
      <Row label="Directions">
        <div className="btn-row axis-toggles">
          {(['x', 'y', 'z'] as const).map((a) => {
            const on = arr.axes.includes(a);
            return (
              <button
                key={a}
                className={`mini ${on ? 'active' : ''}`}
                aria-pressed={on}
                title={`${on ? 'Stop arranging' : 'Arrange'} along ${a.toUpperCase()}`}
                onClick={() => {
                  const next = on ? arr.axes.filter((x) => x !== a) : [...arr.axes, a];
                  if (next.length) setArr({ axes: (['x', 'y', 'z'] as const).filter((x) => next.includes(x)) });
                }}
              >
                {a.toUpperCase()}
              </button>
            );
          })}
        </div>
      </Row>
      <Row label="Bed X × Y">
        <NumberField value={arr.bedWidth} min={10} step={10} suffix="mm" onChange={(bedWidth) => setArr({ bedWidth })} />
        <NumberField value={arr.bedDepth} min={10} step={10} suffix="mm" onChange={(bedDepth) => setArr({ bedDepth })} />
      </Row>
      <Row label="Bed Z (height)">
        <NumberField value={arr.bedHeight} min={10} step={10} suffix="mm" onChange={(bedHeight) => setArr({ bedHeight })} />
      </Row>
      <button className="btn wide" onClick={arrangeOnBed} title="Lay out the selected parts (or all) without overlaps along the chosen directions">
        Arrange along {arr.axes.map((a) => a.toUpperCase()).join(' + ')}
      </button>
      <Hint>{arrangeHint(arr.axes)}</Hint>
    </Section>
  );
}

function arrangeHint(axes: ('x' | 'y' | 'z')[]): string {
  const A = axes.map((a) => a.toUpperCase());
  if (axes.length === 1) return `One line of parts along ${A[0]}${axes[0] === 'z' ? ', stacked up from the bed' : ''}, spaced by the gap.`;
  if (axes.length === 2)
    return `Rows along ${A[0]} up to the bed ${A[0]} size; new rows step along ${A[1]}${axes[1] === 'z' ? ' (stacked)' : ''}.`;
  return 'Rows along X within the bed width, rows along Y within the bed depth, then full layers stacked along Z.';
}
