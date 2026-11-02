import { useEffect } from 'react';
import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { clearSupportEdits, removeBuildSupports, selectedBuildPartIds, supportBuildParts, supportEditCounts } from '../../state/buildActions';
import { supportTotals } from '../../state/buildSupports';
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
  const saved = useStore((s) => s.settings.supports);
  // settings from older sessions lack the newer variables: the standard values fill them in
  const st = { ...SUPPORT_PRESETS[tech], ...saved };
  const parts = useStore((s) => s.buildGen.parts);
  const selection = useStore((s) => s.selection);
  const busy = useStore((s) => s.jobs.length > 0);
  const sel = selectedBuildPartIds(selection);
  const supported = parts.filter((p) => p.supportsOn || p.supported);
  const pending = useStore((s) => s.supportPending);
  useStore((s) => s.supportTick);
  const g = useStore((s) => s.buildGen);
  const totals = supportTotals(g);
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
      <Check checked={st.auto} onChange={(auto) => setSup({ auto })}>
        Automatic supports (from the overhang analysis)
      </Check>
      {mm('Spacing X', 'spacing', 'Distance between neighbouring walls / supports along the grid', 0.25, 0.2)}
      <Row label="Spacing Y">
        <NumberField
          value={st.spacingY > 0 ? st.spacingY : st.spacing}
          min={0.2}
          step={0.25}
          suffix="mm"
          title="Distance between neighbouring walls / supports across the grid"
          onChange={(v) => setSup({ spacingY: Math.max(0.2, v) })}
        />
      </Row>
      <Row label="Grid angle">
        <NumberField value={st.gridAngle} min={-90} max={90} step={5} suffix="°" title="Turn of the support grid about the vertical axis" onChange={(v) => setSup({ gridAngle: Math.max(-90, Math.min(90, v)) })} />
      </Row>
      {resin && mm('Outline spacing', 'perimeter', 'Extra supports along the outline of every overhang area, this far apart (0 = none)', 0.25, 0)}
      <Check checked={st.lowest} onChange={(lowest) => setSup({ lowest })}>
        Support the lowest surfaces too (a lifted part that overhangs nowhere)
      </Check>
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
          {st.raft && mm('Raft margin', 'raftMargin', 'How far the raft reaches past the outermost feet', 0.25, 0)}
          <Check checked={st.braces} onChange={(braces) => setSup({ braces })}>
            Cross braces between tall supports
          </Check>
          {st.braces && mm('Brace supports taller than', 'braceHeight', 'Neighbouring supports at least this tall are joined by zigzag braces', 0.5, 0)}
        </>
      )}
      <div className="btn-grid two">
        <button className="btn primary" disabled={busy || !parts.length} onClick={() => supportBuildParts(sel.length ? sel : undefined)}>
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
            {pending ? ` · updating ${pending}…` : totals.copies ? ` · this build: ${totals.count} ${st.style === 'volume' ? 'walls' : 'supports'}, ${(totals.volume / 1000).toFixed(2)} cm³` : ''}
          </span>
          <button className="mini" onClick={() => removeBuildSupports(sel.length ? sel : undefined)}>
            {sel.length ? 'Remove from selected' : 'Remove all'}
          </button>
        </div>
      )}
      <SupportHandEdits />
      <Hint>
        Every copy gets its own supports for the orientation it has: it is lifted by the distance from the platform and every surface facing down at less
        than the critical angle is supported straight down (perpendicular to the platform), onto the platform or onto the part below. When a copy is
        turned (nesting, hand edits) or a setting changes, its supports are made again automatically. They are exported with the build. Supports added or deleted by hand belong to the part: every copy gets them and they
        follow later turns (Ctrl+Z undoes the last one).
      </Hint>
    </Section>
  );
}

/** Adding and removing supports by clicking on the parts in the build. */
function SupportHandEdits() {
  const mode = useStore((s) => s.supportEdit);
  const eraser = useStore((s) => s.supportEraser);
  const parts = useStore((s) => s.buildGen.parts);
  const selection = useStore((s) => s.selection);
  const sel = selectedBuildPartIds(selection);
  const scope = sel.length ? parts.filter((p) => sel.includes(p.id)) : parts;
  const n = supportEditCounts(scope);
  const edits = n.add + n.remove + n.skip;
  return (
    <>
      <div className="sub-title">Edit supports by hand</div>
      <Segmented
        value={mode ?? 'off'}
        onChange={(v) => setState({ supportEdit: v === 'off' ? null : v })}
        options={[
          { value: 'off', label: 'Off' },
          { value: 'add', label: 'Add', title: 'Click on a surface facing down to put a support under it (turn the view to look from below)' },
          { value: 'delete', label: 'Delete', title: 'Click on a support (or right next to where it touches the part) to remove it' },
          { value: 'area', label: 'Delete area', title: 'Click on a support to remove every support of its overhang area' },
        ]}
      />
      {mode === 'delete' && (
        <Row label="Eraser radius">
          <NumberField
            value={eraser}
            min={0}
            step={0.5}
            suffix="mm"
            title="Supports within this distance of the one clicked go too (0: just the one clicked)"
            onChange={(v) => setState({ supportEraser: Math.max(0, v) })}
          />
        </Row>
      )}
      <div className="pick-row">
        <span className="muted small">
          {edits
            ? `${n.add} added, ${n.remove} removed, ${n.skip} area${n.skip === 1 ? '' : 's'} left out${sel.length ? ' (selected)' : ''}`
            : 'No changes by hand'}
        </span>
        <button className="mini" disabled={!edits} onClick={() => clearSupportEdits(sel.length ? sel : undefined)} title="Back to the generated supports">
          {sel.length ? 'Reset selected' : 'Reset all'}
        </button>
      </div>
    </>
  );
}

