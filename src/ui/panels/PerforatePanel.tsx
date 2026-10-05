import { useEffect } from 'react';
import { Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { previewPerforationPattern } from '../../state/actions';
import { previewPointHoles, removePerfPoint, startPointPick } from '../../state/featureActions';
import { FacePickSection } from './FacePickSection';
import type { ToolSettings } from '../../state/types';

export function PerforatePanel() {
  const fs = useStore((s) => s.faceSelection);
  const p = useStore((s) => s.settings.perforate);
  const points = useStore((s) => s.perfPoints);
  const placing = useStore((s) => s.pickMode === 'point' && s.pointSlot === 'perfPoint');
  const set = (patch: Partial<ToolSettings['perforate']>) =>
    setState({ settings: { ...getState().settings, perforate: { ...getState().settings.perforate, ...patch } } });
  useEffect(() => {
    if (p.mode === 'points') {
      const t = setTimeout(previewPointHoles, 100);
      return () => clearTimeout(t);
    }
    if (!fs) return;
    const t = setTimeout(previewPerforationPattern, 200);
    return () => clearTimeout(t);
  }, [fs, points, p.mode, p.pattern, p.size, p.exitSize, p.spacing, p.margin, p.depth, p.angle]);
  return (
    <Section title="Perforation">
      <Row label="Layout">
        <Segmented
          value={p.mode}
          onChange={(mode) => setState({ settings: { ...getState().settings, perforate: { ...getState().settings.perforate, mode } }, preview: null, pickMode: null })}
          options={[
            { value: 'array', label: 'Array on face' },
            { value: 'points', label: 'Single holes' },
          ]}
        />
      </Row>
      {p.mode === 'array' ? (
        <FacePickSection tool="perforate" />
      ) : (
        <>
          <button className={`btn wide ${placing ? 'primary' : ''}`} onClick={() => startPointPick('perfPoint')}>
            {placing ? 'Done placing holes' : 'Add hole locations…'}
          </button>
          {points.length > 0 && (
            <ul className="hole-list">
              {points.map((pt, i) => (
                <li key={i}>
                  <span>
                    #{i + 1} · {pt.point.map((v) => v.toFixed(1)).join(', ')} (local)
                  </span>
                  <button className="mini" onClick={() => removePerfPoint(i)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <Row label="Pattern">
        <Segmented
          value={p.pattern}
          onChange={(pattern) => set({ pattern })}
          options={[
            { value: 'round', label: 'Round' },
            { value: 'hex', label: 'Hex' },
            { value: 'square', label: 'Square' },
          ]}
        />
      </Row>
      <Row label={p.pattern === 'round' ? 'Diameter' : p.pattern === 'hex' ? 'Across flats' : 'Side'}>
        <NumberField value={p.size} min={0.2} step={0.5} suffix="mm" onChange={(size) => set({ size })} />
      </Row>
      <Row label="Exit size">
        <NumberField
          value={p.exitSize ?? 0}
          min={0}
          step={0.5}
          suffix="mm"
          title="Size at the far end for tapered (conical) holes; 0 = straight hole"
          onChange={(exitSize) => set({ exitSize })}
        />
      </Row>
      {p.mode === 'array' && (
        <>
      <Row label="Spacing (web)">
        <NumberField value={p.spacing} min={0.2} step={0.5} suffix="mm" onChange={(spacing) => set({ spacing })} />
      </Row>
      <Row label="Border margin">
        <NumberField value={p.margin} min={0} step={0.5} suffix="mm" onChange={(margin) => set({ margin })} />
      </Row>
        </>
      )}
      <Row label="Depth">
        <NumberField value={p.depth ?? 0} min={0} step={0.5} suffix="mm" title="0 = through the wall (measured per hole)" onChange={(depth) => set({ depth })} />
      </Row>
      <Row label="Rotation">
        <NumberField value={p.angle ?? 0} step={5} suffix="°" onChange={(angle) => set({ angle })} />
      </Row>
      <Hint>Holes go along the surface normal. Set an exit size for tapered holes (different diameter at each end). The preview outlines show the entry size; Apply runs a boolean subtraction (needs a watertight part).</Hint>
    </Section>
  );
}
