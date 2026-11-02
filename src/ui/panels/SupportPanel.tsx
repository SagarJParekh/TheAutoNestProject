import { useEffect } from 'react';
import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { removeBuildSupports, selectedBuildPartIds, supportBuildParts } from '../../state/buildActions';
import { SUPPORT_PRESETS, type SupportParams, type SupportTech } from '../../geometry/supports';

const setSup = (patch: Partial<SupportParams>) => {
  const s = getState().settings;
  setState({ settings: { ...s, supports: { ...s.supports, ...patch } } });
};

/**
 * Support generation in Build generation, for SLA, DLP and DMLS printers: the
 * standard script of the printer's technology, editable, applied to the
 * selected parts (or all) in the orientation they have in the builds.
 */
export function BuildSupports({ tech }: { tech: SupportTech }) {
  const st = useStore((s) => s.settings.supports);
  const parts = useStore((s) => s.buildGen.parts);
  const selection = useStore((s) => s.selection);
  const busy = useStore((s) => s.jobs.length > 0);
  const sel = selectedBuildPartIds(selection);
  const supported = parts.filter((p) => p.supported);
  // the printer decides the technology: its standard script is loaded when it changes
  useEffect(() => {
    if (getState().settings.supports.tech !== tech) setSup({ ...SUPPORT_PRESETS[tech] });
  }, [tech]);
  const mm = (label: string, key: keyof SupportParams, title: string, step = 0.1, min = 0) => (
    <Row label={label}>
      <NumberField value={st[key] as number} min={min} step={step} suffix="mm" title={title} onChange={(v) => setSup({ [key]: Math.max(min, v) })} />
    </Row>
  );
  const resin = tech !== 'dmls';
  return (
    <Section title={`Supports (${tech.toUpperCase()})`}>
      <Row label="Critical angle">
        <NumberField value={st.criticalAngle} min={0} max={89} step={1} suffix="°" title="Surfaces making less than this angle with the platform get supports" onChange={(criticalAngle) => setSup({ criticalAngle: Math.max(0, Math.min(89, criticalAngle)) })} />
      </Row>
      <Row label="Minimal area">
        <NumberField value={st.minArea} min={0} step={0.1} suffix="mm²" title="Overhang areas smaller than this are left without supports" onChange={(minArea) => setSup({ minArea: Math.max(0, minArea) })} />
      </Row>
      {mm('Distance from platform', 'lift', 'The part is lifted this far above the platform; the supports fill the gap', 0.5)}
      <Row label="Support type">
        <Segmented
          value={st.style}
          onChange={(style) => setSup({ style })}
          options={
            resin
              ? [
                  { value: 'tip', label: 'Tip (cone)', title: 'A cone tip touching the part on a rod, wide foot on the raft' },
                  { value: 'bar', label: 'Bar', title: 'Plain pins' },
                ]
              : [
                  { value: 'volume', label: 'Volume', title: 'A grid of thin walls under each area (block support)' },
                  { value: 'bar', label: 'Bar', title: 'Pins at every grid point' },
                ]
          }
        />
      </Row>
      {mm('Spacing', 'spacing', 'Distance between neighbouring walls / supports', 0.25, 0.2)}
      {st.style === 'volume' && mm('Wall thickness', 'wall', 'Thickness of the support walls', 0.05, 0.05)}
      {st.style === 'bar' && mm('Bar diameter', 'wall', 'Diameter of the pins', 0.1, 0.1)}
      {st.style === 'tip' && (
        <>
          {mm('Contact diameter', 'tipDiameter', 'Diameter where the tip touches the part (smaller = easier to remove, weaker)', 0.05, 0.05)}
          {mm('Tip length', 'tipLength', 'Length of the cone tip', 0.1, 0.1)}
          {mm('Rod diameter', 'bodyDiameter', 'Diameter of the support rod', 0.1, 0.1)}
          {mm('Foot diameter', 'baseDiameter', 'Diameter of the foot on the platform / raft', 0.1, 0.1)}
        </>
      )}
      <Row label={st.penetration >= 0 ? 'Penetration' : 'Gap to part'}>
        <NumberField value={st.penetration} step={0.05} suffix="mm" title="How far the supports reach into the part (negative: a gap left below it)" onChange={(penetration) => setSup({ penetration })} />
      </Row>
      <Check checked={st.onPart} onChange={(onPart) => setSup({ onPart })}>
        Supports may stand on the part
      </Check>
      {resin && (
        <>
          <Check checked={st.raft} onChange={(raft) => setSup({ raft })}>
            Raft (base plate)
          </Check>
          {st.raft && mm('Raft thickness', 'raftThickness', 'Thickness of the base plate under the supports', 0.1, 0.1)}
        </>
      )}
      <div className="btn-grid two">
        <button className="btn primary" disabled={busy || !parts.length} onClick={() => void supportBuildParts(sel.length ? sel : undefined)}>
          {sel.length ? `Support ${sel.length} selected` : 'Support all parts'}
        </button>
        <button className="btn" onClick={() => setSup({ ...SUPPORT_PRESETS[tech] })} title={`Back to the standard ${tech.toUpperCase()} script`}>
          Standard values
        </button>
      </div>
      {supported.length > 0 && (
        <div className="pick-row">
          <span className="muted small">
            {supported.length} part{supported.length > 1 ? 's' : ''} with supports
          </span>
          <button className="mini" onClick={() => removeBuildSupports(sel.length ? sel : undefined)}>
            {sel.length ? 'Remove from selected' : 'Remove all'}
          </button>
        </div>
      )}
      <Hint>
        Each part gets supports in the orientation it has in the builds: it is lifted by the distance from the platform and every surface facing down at less
        than the critical angle is supported, down to the platform or onto the part below. Part and supports are then nested and exported together, with
        the orientation locked. Generating again rebuilds them from the original part.
      </Hint>
    </Section>
  );
}
