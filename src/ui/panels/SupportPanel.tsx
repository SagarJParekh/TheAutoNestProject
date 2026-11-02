import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { analyseSupports, clearOverhangSkips, previewSupports, startOverhangPick } from '../../state/makeActions';
import { cancelPreview } from '../../state/actions';
import { live } from '../../state/livePreview';
import { SUPPORT_PRESETS, type SupportParams, type SupportTech } from '../../geometry/supports';
import type { Part } from '../../state/types';

const setSup = (patch: Partial<SupportParams>) => {
  const s = getState().settings;
  setState({ settings: { ...s, supports: { ...s.supports, ...patch } }, preview: null });
};

/**
 * Support generation for SLA, DLP and DMLS (like the support module of
 * Netfabb): analyse the overhangs (red), leave areas out by clicking them,
 * pick the standard script of the technology, and generate the supports.
 */
export function SupportPanel({ parts }: { parts: Part[] }) {
  const st = useStore((s) => s.settings.supports);
  const view = useStore((s) => s.overhangView);
  const preview = useStore((s) => s.preview);
  const picking = useStore((s) => s.pickMode === 'overhang');
  const target = parts.find((p) => !p.locked);
  const mm = (label: string, key: keyof SupportParams, title: string, step = 0.1, min = 0) => (
    <Row label={label}>
      <NumberField value={st[key] as number} min={min} step={step} suffix="mm" title={title} onChange={(v) => setSup({ [key]: Math.max(min, v) })} />
    </Row>
  );
  const resin = st.tech !== 'dmls';
  return (
    <>
      <Section title="Support generation">
        <Row label="Technology">
          <Segmented
            value={st.tech}
            onChange={(tech: SupportTech) => setSup({ ...SUPPORT_PRESETS[tech] })}
            options={[
              { value: 'sla', label: 'SLA', title: 'Resin, laser: tip supports with a raft (standard SLA script)' },
              { value: 'dlp', label: 'DLP', title: 'Resin, projector: finer tip supports with a raft (standard DLP script)' },
              { value: 'dmls', label: 'DMLS', title: 'Metal powder bed: volume (wall) supports fused to the part (standard DMLS script)' },
            ]}
          />
        </Row>
        <div className="sub-title">Overhang analysis</div>
        <Row label="Critical angle">
          <NumberField value={st.criticalAngle} min={0} max={89} step={1} suffix="°" title="Surfaces making less than this angle with the platform get supports" onChange={(criticalAngle) => setSup({ criticalAngle: Math.max(0, Math.min(89, criticalAngle)) })} />
        </Row>
        <Row label="Minimal area">
          <NumberField value={st.minArea} min={0} step={0.1} suffix="mm²" title="Overhang areas smaller than this are left without supports" onChange={(minArea) => setSup({ minArea: Math.max(0, minArea) })} />
        </Row>
        {mm('Distance from platform', 'lift', 'The part is lifted this far above the platform; the supports fill the gap', 0.5)}
        <div className="btn-row">
          <button className="btn grow" disabled={!target} onClick={() => void analyseSupports()}>
            Analyse overhangs
          </button>
          <button className={`btn ${picking ? 'primary' : ''}`} disabled={!target} onClick={startOverhangPick} title="Click red areas to leave them without supports (click again to bring them back)">
            {picking ? 'Done' : 'Leave out areas…'}
          </button>
        </div>
        {view && (
          <p className="muted small">
            {view.areas} area{view.areas === 1 ? '' : 's'} to support · {view.area.toFixed(1)} mm²{view.skipped ? ` · ${view.skipped} left out` : ''}{' '}
            {st.skip.length > 0 && (
              <button className="mini" onClick={clearOverhangSkips}>
                Support all again
              </button>
            )}{' '}
            <button className="mini" onClick={() => setState({ overhangView: null, pickMode: getState().pickMode === 'overhang' ? null : getState().pickMode })}>
              Hide
            </button>
          </p>
        )}

        <div className="sub-title">Support script ({st.tech.toUpperCase()})</div>
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
        <div className="btn-row">
          <button className="btn primary grow" disabled={!target || !!preview} onClick={() => live(previewSupports)}>
            Generate supports
          </button>
          <button className="btn" onClick={() => setSup({ ...SUPPORT_PRESETS[st.tech] })} title="Back to the standard script of this technology">
            Reset
          </button>
          {preview && (
            <button className="btn" onClick={cancelPreview}>
              Cancel
            </button>
          )}
        </div>
        <Hint>
          The part is lifted by the distance from the platform; surfaces facing down at less than the critical angle (red) get supports down to the
          platform, or onto the part where it lies below. Apply keeps the lifted part and adds the supports as a separate part (name_sup), ready for
          export or Build generation.
        </Hint>
      </Section>
    </>
  );
}
