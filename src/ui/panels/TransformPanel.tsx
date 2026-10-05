import { Icon } from '../icons';
import { Check, Hint, NumberField, Row, Section, VecRow } from '../controls';
import { getState, setState, updateParts, useStore } from '../../state/store';
import { centerOnOrigin, dropToBed, mirrorParts } from '../../state/actions';
import { localBounds } from '../../state/math';
import type { Part, Transform } from '../../state/types';
import type { Vec3 } from '../../geometry';
import { useState } from 'react';
import { Vector3 } from 'three';

export function TransformPanel({ parts }: { parts: Part[] }) {
  const pickMode = useStore((s) => s.pickMode);
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
              <button key={a} className="btn" disabled={disabled} onClick={() => mirrorParts(a as 0 | 1 | 2)}>
                {'XYZ'[a]}
              </button>
            ))}
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
    </Section>
  );
}
