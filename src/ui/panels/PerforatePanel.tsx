import { useEffect } from 'react';
import { Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { previewPerforationPattern } from '../../state/actions';
import { FacePickSection } from './FacePickSection';
import type { ToolSettings } from '../../state/types';

export function PerforatePanel() {
  const fs = useStore((s) => s.faceSelection);
  const p = useStore((s) => s.settings.perforate);
  const set = (patch: Partial<ToolSettings['perforate']>) =>
    setState({ settings: { ...getState().settings, perforate: { ...getState().settings.perforate, ...patch } } });
  useEffect(() => {
    if (!fs) return;
    const t = setTimeout(previewPerforationPattern, 200);
    return () => clearTimeout(t);
  }, [fs, p.pattern, p.size, p.spacing, p.margin, p.depth, p.angle]);
  return (
    <Section title="Perforation">
      <FacePickSection tool="perforate" />
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
      <Row label="Spacing (web)">
        <NumberField value={p.spacing} min={0.2} step={0.5} suffix="mm" onChange={(spacing) => set({ spacing })} />
      </Row>
      <Row label="Border margin">
        <NumberField value={p.margin} min={0} step={0.5} suffix="mm" onChange={(margin) => set({ margin })} />
      </Row>
      <Row label="Depth">
        <NumberField value={p.depth ?? 0} min={0} step={0.5} suffix="mm" title="0 = through the wall (measured per hole)" onChange={(depth) => set({ depth })} />
      </Row>
      <Row label="Rotation">
        <NumberField value={p.angle ?? 0} step={5} suffix="°" onChange={(angle) => set({ angle })} />
      </Row>
      <Hint>The pattern preview is drawn on the face. Apply runs a boolean subtraction (requires a watertight part).</Hint>
    </Section>
  );
}
