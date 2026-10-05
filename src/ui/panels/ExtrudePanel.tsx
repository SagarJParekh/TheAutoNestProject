import { useEffect } from 'react';
import { Hint, NumberField, Row, Section } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { previewExtrude } from '../../state/actions';
import { FacePickSection } from './FacePickSection';

export function ExtrudePanel() {
  const fs = useStore((s) => s.faceSelection);
  const distance = useStore((s) => s.settings.extrude.distance);
  useEffect(() => {
    if (!fs) return;
    const t = setTimeout(previewExtrude, 250);
    return () => clearTimeout(t);
  }, [fs, distance]);
  return (
    <Section title="Extrude surface">
      <FacePickSection tool="extrude" />
      <Row label="Distance">
        <NumberField
          value={distance}
          step={0.5}
          suffix="mm"
          title="Positive pulls the face out, negative pushes it in"
          onChange={(d) => setState({ settings: { ...getState().settings, extrude: { ...getState().settings.extrude, distance: d } } })}
        />
      </Row>
      <Hint>Moves the selected faces along their average normal and stitches side walls, so a watertight part stays watertight.</Hint>
    </Section>
  );
}
