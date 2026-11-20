import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { clearSupportEdits, deleteSelectedSupports, removeBuildSupports, selectTouchPoints, selectedBuildPartIds, supportBuildParts, supportEditCounts, supportTouchPoints } from '../../state/buildActions';
import { supportTotals } from '../../state/buildSupports';
import { RAFT_TYPES, SUPPORT_PRESETS, type RaftType, type SupportParams, type SupportShape, type SupportTech } from '../../geometry/supports';

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
  const [mode, setMode] = useState<'all' | 'selected'>('all');
  // Cancel goes back to the settings of the last Apply (or as they were when the panel opened)
  const applied = useRef(getState().settings.supports);
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
  const targets = mode === 'selected' ? sel : undefined;
  const apply = () => {
    if (mode === 'selected' && !sel.length) return;
    applied.current = getState().settings.supports;
    supportBuildParts(targets);
  };
  const cancel = () => {
    setState((s) => ({ settings: { ...s.settings, supports: applied.current }, supportEdit: null, supportSel: [] }));
  };
  const clearAll = () => {
    clearSupportEdits(targets);
    removeBuildSupports(targets);
    setState({ supportEdit: null, supportSel: [] });
  };
  return (
    <>
      <Section title={`Supports (${tech.toUpperCase()})`}>
        {supported.length > 0 ? <SupportHandEdits /> : <Hint>Set the supports up below, then Apply. Afterwards they can be edited by hand here.</Hint>}
      </Section>
      <Section title="Support type">
        {resin && (
          <Row label="Shape">
            <Segmented
              value={st.style}
              onChange={(style) => setSup({ style })}
              options={[
                { value: 'tip', label: 'Cone tip', title: 'A cone tip touching the part on a rod, a foot on the platform / raft' },
                { value: 'bar', label: 'Plain bar', title: 'Plain pins' },
                { value: 'block', label: 'Block', title: 'Zero-thickness walls along a hatching (traced as single laser paths), with a cross grid, teeth and fragmentation' },
              ]}
            />
          </Row>
        )}
        {!resin && (
          <Row label="Shape">
            <Segmented
              value={st.style}
              onChange={(style) => setSup({ style })}
              options={[
                { value: 'volume', label: 'Volume', title: 'A grid of thin walls under each area (block support)' },
                { value: 'bar', label: 'Bar', title: 'Pins at every grid point' },
                { value: 'block', label: 'Block', title: 'Zero-thickness walls along a hatching (traced as single laser paths), with a cross grid, teeth and fragmentation' },
              ]}
            />
          </Row>
        )}
        {st.style === 'tip' ? (
          <>
            <SupportDiagram st={st} />
          </>
        ) : st.style === 'block' ? (
          <Hint>
            Block supports: walls of zero thickness along a hatching under every overhang area: the printer traces each wall as a single laser path.
            Set them up under Block walls (with the cross grid inside them), Teeth and Fragmentation.
          </Hint>
        ) : (
          <>
            {st.style === 'volume' && mm('Wall thickness', 'wall', 'Thickness of the support walls', 0.05, 0.05)}
            {st.style === 'bar' && mm('Bar diameter', 'wall', 'Diameter of the pins', 0.1, 0.1)}
            <Row label={st.penetration >= 0 ? 'Penetration' : 'Gap to part'}>
              <NumberField value={st.penetration} step={0.05} suffix="mm" title="How far the supports reach into the part (negative: a gap left below it)" onChange={(penetration) => setSup({ penetration })} />
            </Row>
          </>
        )}
      </Section>
      {st.style === 'block' && <BlockSections st={st} />}
      <Section title="Placement">
        <Check checked={st.auto} onChange={(auto) => setSup({ auto })}>
          Automatic supports (from the overhang analysis)
        </Check>
        <Row label="Critical angle">
          <NumberField value={st.criticalAngle} min={0} max={89} step={1} suffix="°" title="Surfaces making less than this angle with the platform get supports" onChange={(criticalAngle) => setSup({ criticalAngle: Math.max(0, Math.min(89, criticalAngle)) })} />
        </Row>
        <Row label="Minimal area">
          <NumberField value={st.minArea} min={0} step={0.1} suffix="mm²" title="Overhang areas smaller than this are left without supports" onChange={(minArea) => setSup({ minArea: Math.max(0, minArea) })} />
        </Row>
        {mm('Distance from platform', 'lift', 'The part is lifted this far above the platform; the supports fill the gap', 0.5)}
        {st.style !== 'block' && mm('Spacing X', 'spacing', 'Distance between neighbouring walls / supports along the grid', 0.25, 0.2)}
        {st.style !== 'block' && (
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
        )}
        {st.style !== 'block' && (
        <Row label="Grid angle">
          <NumberField value={st.gridAngle} min={-90} max={90} step={5} suffix="°" title="Turn of the support grid about the vertical axis" onChange={(v) => setSup({ gridAngle: Math.max(-90, Math.min(90, v)) })} />
        </Row>
        )}
        {resin && st.style !== 'block' && mm('Outline spacing', 'perimeter', 'Extra supports along the outline of every overhang area, this far apart (0 = none)', 0.25, 0)}
        <Check checked={st.lowest} onChange={(lowest) => setSup({ lowest })}>
          Support the lowest surfaces too (a lifted part that overhangs nowhere)
        </Check>
        <Check checked={st.onPart} onChange={(onPart) => setSup({ onPart })}>
          Supports may stand on the part
        </Check>
        {!st.onPart && (
          <Row label="Branch angle">
            <NumberField
              value={st.branchAngle}
              min={20}
              max={80}
              step={5}
              suffix="°"
              title="Where a support would land on the part, it branches sideways at this angle (from horizontal) to a support beside it, or to a new one on the platform"
              onChange={(v) => setSup({ branchAngle: Math.max(20, Math.min(80, v)) })}
            />
          </Row>
        )}
        {resin && st.style !== 'block' && (
          <>
            <Check checked={st.braces} onChange={(braces) => setSup({ braces })}>
              Cross braces between tall supports
            </Check>
            {st.braces && mm('Brace supports taller than', 'braceHeight', 'Neighbouring supports at least this tall are joined by zigzag braces', 0.5, 0)}
          </>
        )}
      </Section>
      {resin && st.style !== 'block' && (
        <Section title="Raft setting">
          <label className="switch-row" title="A raft under the supports, holding them together on the platform">
            <span>Automatically add raft</span>
            <input type="checkbox" className="switch" checked={st.raft} onChange={(e) => setSup({ raft: e.target.checked })} />
          </label>
          {st.raft && (
            <>
              <Row label="Raft type">
                <select className="select" value={st.raftType ?? 'solid'} onChange={(e) => setSup({ raftType: e.target.value as RaftType })} title={RAFT_TYPES.find((r) => r.value === (st.raftType ?? 'solid'))?.title}>
                  {RAFT_TYPES.map((r) => (
                    <option key={r.value} value={r.value} title={r.title}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Hint>{RAFT_TYPES.find((r) => r.value === (st.raftType ?? 'solid'))?.title}</Hint>
              {(st.raftType ?? 'solid') !== 'none' && <RaftFeatures st={st} />}
            </>
          )}
        </Section>
      )}
      <Section title="Apply">
        <Row label="Mode">
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value as 'all' | 'selected')}>
            <option value="all">+ All parts</option>
            <option value="selected">+ Selected parts{sel.length ? ` (${sel.length})` : ''}</option>
          </select>
        </Row>
        <button className="btn primary wide" disabled={busy || !parts.length || (mode === 'selected' && !sel.length)} onClick={apply} title="Make the supports with these settings">
          Apply
        </button>
        <div className="btn-grid two">
          <button className="btn" onClick={cancel} title="Back to the settings of the last Apply, and stop editing by hand (Esc)">
            Cancel <span className="muted small">Esc</span>
          </button>
          <button className="btn" disabled={!supported.length} onClick={clearAll} title={mode === 'selected' ? 'Remove the supports of the selected parts' : 'Remove every support'}>
            Clear all
          </button>
        </div>
        <button className="btn wide" onClick={() => setSup({ ...SUPPORT_PRESETS[tech] })} title={`Back to the standard ${tech.toUpperCase()} script`}>
          Standard values
        </button>
        {supported.length > 0 && (
          <p className="muted small">
            {supported.length} part{supported.length > 1 ? 's' : ''} with supports
            {pending ? ` · updating ${pending}…` : totals.copies
                ? st.style === 'block'
                  ? ` · this build: ${totals.count} block walls (zero thickness), ${(totals.area / 100).toFixed(1)} cm² of wall`
                  : ` · this build: ${totals.count} ${st.style === 'volume' ? 'walls' : 'supports'}, ${(totals.volume / 1000).toFixed(2)} cm³`
                : ''}
          </p>
        )}
        <Hint>
          Every copy gets its own supports for its orientation, straight down (perpendicular to the platform), made again automatically when a copy turns
          or a setting changes, and exported with the build. Supports added, moved or deleted by hand belong to the part (Ctrl+Z undoes).
        </Hint>
      </Section>
    </>
  );
}

/**
 * Block support settings, as tabs: the walls (thickness = the laser spot,
 * hatching, offsets, border), the teeth on them, fragmentation and
 * perforations.
 */
function BlockSections({ st }: { st: SupportParams }) {
  const f = (label: string, key: keyof SupportParams, title: string, opts: { step?: number; min?: number; max?: number; suffix?: string } = {}) => (
    <Row label={label}>
      <NumberField
        value={st[key] as number}
        min={opts.min ?? 0}
        max={opts.max}
        step={opts.step ?? 0.1}
        suffix={opts.suffix ?? 'mm'}
        title={title}
        onChange={(v) => setSup({ [key]: Math.max(opts.min ?? 0, opts.max !== undefined ? Math.min(opts.max, v) : v) })}
      />
    </Row>
  );
  const check = (label: string, key: keyof SupportParams, title: string) => (
    <label className="switch-row" title={title}>
      <span>{label}</span>
      <input type="checkbox" className="switch" checked={!!st[key]} onChange={(e) => setSup({ [key]: e.target.checked })} />
    </label>
  );
  return (
    <>
      <Section title="Block walls">
        {f('X hatching', 'spacing', 'Distance between the walls in the first direction', { step: 0.1, min: 0.2 })}
        <Row label="Y hatching">
          <NumberField
            value={st.spacingY > 0 ? st.spacingY : st.spacing}
            min={0.2}
            step={0.1}
            suffix="mm"
            title="Distance between the walls in the second direction"
            onChange={(v) => setSup({ spacingY: Math.max(0.2, v) })}
          />
        </Row>
        {f('Rotation angle', 'gridAngle', 'Turn of the hatching about the vertical axis', { step: 1, min: -90, max: 90, suffix: '°' })}
        {f('XY offset', 'blockInset', 'The walls stay this far inside the outline of each area')}
        <Row label="Z offset (into the part)">
          <NumberField value={st.penetration} step={0.05} suffix="mm" title="How far the walls reach into the part above (and below) them" onChange={(penetration) => setSup({ penetration })} />
        </Row>
        {check('Border wall', 'blockBorder', 'A wall along the outline of each area')}
        {check('Cross grid in the walls', 'perforate', 'The walls are a cross grid of diagonal bars with diamond openings between them, instead of solid sheets: less material')}
        {st.perforate && (
          <>
            <CrossGridDrawing />
            {f('Bar width (a)', 'perfBeam', 'Width of the diagonal bars of the cross grid', { step: 0.05, min: 0.1 })}
            {f('Bar angle (b)', 'perfAngle', 'Angle of the bars from horizontal (steeper: taller, narrower openings)', { step: 1, min: 15, max: 80, suffix: '°' })}
            {f('Cell height (c)', 'perfHeight', 'Height of each opening between the bars (larger: more open, less material)', { step: 0.1, min: 0.2 })}
            {f('Solid band (d)', 'perfSolid', 'Solid strip without openings at the top and bottom of each wall (where the teeth and the foot are)')}
            {f('Solid ends', 'perfZone', 'Solid strip at both ends of each wall piece')}
          </>
        )}
      </Section>
      <Section title="Teeth">
        {check('Upper teeth', 'teeth', 'Teeth on top of the walls: small contacts that break off easily and leave little marks')}
        {st.teeth && (
          <>
            <TeethDrawing />
            {f('Height (a)', 'teethHeight', 'Height of the teeth')}
            {f('Top length (b)', 'teethTop', 'Length of each tooth where it touches the part', { step: 0.05 })}
            {f('Base length (c)', 'teethBase', 'Length of each tooth at its base', { step: 0.05 })}
            {f('Base interval (d)', 'teethGap', 'Gap between the bases of neighbouring teeth', { step: 0.05 })}
            {check('Lower teeth', 'lowerTeeth', 'The same teeth, upside down, where a wall stands on the part below')}
          </>
        )}
      </Section>
      <Section title="Fragmentation">
        {check('Fragment the walls', 'fragment', 'Cut gaps across the walls at regular intervals: smaller pieces, easier to remove')}
        {st.fragment && (
          <>
            {f('X interval', 'fragX', 'Distance between the gaps along the walls of the first direction', { step: 0.2, min: 0.5 })}
            {f('Y interval', 'fragY', 'Distance between the gaps along the walls of the second direction', { step: 0.2, min: 0.5 })}
            {f('Separation width', 'fragWidth', 'Width of each gap', { step: 0.1 })}
          </>
        )}
      </Section>

    </>
  );
}

/** A wall with its cross grid and the sizes a–d. */
function CrossGridDrawing() {
  const fill = '#c8cdd4';
  const cells: ReactElement[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 9; c++) {
      const x = 30 + c * 26 + (r % 2 ? 13 : 0), y = 34 + r * 15;
      if (x > 250) continue;
      cells.push(<polygon key={`${r}-${c}`} points={`${x},${y - 12} ${x + 9},${y} ${x},${y + 12} ${x - 9},${y}`} fill="var(--bg-2)" />);
    }
  return (
    <svg className="raft-preview" viewBox="0 0 280 92" width="280" height="92" aria-hidden>
      <rect x="12" y="10" width="256" height="72" fill={fill} />
      {cells}
      <g stroke="var(--muted)" strokeWidth="1" fontSize="11" fill="var(--muted)">
        <text x="70" y="8" stroke="none">a</text>
        <text x="140" y="8" stroke="none">b</text>
        <line x1="262" y1="22" x2="262" y2="46" />
        <text x="250" y="38" stroke="none">c</text>
        <line x1="6" y1="10" x2="6" y2="20" />
        <text x="0" y="92" stroke="none">d</text>
      </g>
    </svg>
  );
}

/** The teeth on a wall with their sizes a–d. */
function TeethDrawing() {
  const fill = '#e8b923';
  return (
    <svg className="raft-preview" viewBox="0 0 280 92" width="280" height="92" aria-hidden>
      <rect x="10" y="58" width="260" height="30" fill={fill} opacity="0.9" />
      {[0, 1, 2, 3, 4].map((k) => {
        const x = 22 + k * 50;
        return <polygon key={k} points={`${x},58 ${x + 40},58 ${x + 27},14 ${x + 13},14`} fill={fill} />;
      })}
      <g stroke="var(--muted)" strokeWidth="1" fontSize="11" fill="var(--muted)">
        <line x1="128" y1="14" x2="128" y2="58" />
        <text x="132" y="40" stroke="none">a</text>
        <line x1="85" y1="8" x2="99" y2="8" />
        <text x="88" y="7" stroke="none" dy="-2">b</text>
        <line x1="72" y1="64" x2="112" y2="64" />
        <text x="88" y="78" stroke="none">c</text>
        <line x1="112" y1="52" x2="122" y2="52" />
        <text x="113" y="49" stroke="none">d</text>
      </g>
    </svg>
  );
}

/**
 * The raft's features for its type (0 = worked out from the supports): its
 * thickness everywhere; the margin round a plate; hole size and rib width of
 * the hexagonal grid; bar width and pad size of the skate / cross grid; the
 * wall of the protection case. A small top view shows the pattern.
 */
function RaftFeatures({ st }: { st: SupportParams }) {
  const type = st.raftType ?? 'solid';
  const field = (label: string, key: keyof SupportParams, title: string, opts: { step?: number; min?: number; auto?: boolean } = {}) => (
    <Row label={label}>
      <NumberField
        value={st[key] as number}
        min={opts.min ?? 0}
        step={opts.step ?? 0.1}
        suffix="mm"
        title={`${title}${opts.auto ? ' (0 = automatic, from the supports)' : ''}`}
        onChange={(v) => setSup({ [key]: Math.max(opts.min ?? 0, v) })}
      />
      {opts.auto && (st[key] as number) === 0 && <span className="muted small">auto</span>}
    </Row>
  );
  const plate = type === 'hex' || type === 'solid' || type === 'case';
  return (
    <>
      <RaftPreview type={type} />
      {field('Thickness', 'raftThickness', 'Thickness of the raft', { min: 0.1 })}
      {plate && field('Margin', 'raftMargin', 'How far the raft reaches past the outermost feet', { step: 0.25 })}
      {type === 'hex' && field('Hole size', 'raftHole', 'Size of the hexagonal holes, corner to corner', { step: 0.25, auto: true })}
      {type === 'hex' && field('Rib width', 'raftRib', 'Width of the ribs between the holes', { step: 0.1, auto: true })}
      {(type === 'skate' || type === 'cross') && field('Bar width', 'raftBar', 'Width of the bars joining the feet', { step: 0.1, auto: true })}
      {(type === 'skate' || type === 'cross') && field('Pad Ø', 'raftPad', 'Diameter of the pad under each foot', { step: 0.1, auto: true })}
      {type === 'case' && field('Wall thickness', 'raftRib', 'Thickness of the wall round the raft', { step: 0.1, auto: true })}
      {type === 'case' && field('Wall height', 'caseHeight', 'Height of the wall round the raft (0 = up to the part)', { step: 0.5, auto: true })}
      <Hint>The bars and pads follow the support grid: change Spacing X / Y (Placement) to change the grid of a skate or cross grid raft.</Hint>
    </>
  );
}

/** Top view of a raft type: feet (dots) on the raft pattern. */
function RaftPreview({ type }: { type: RaftType }) {
  const feet: [number, number][] = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) feet.push([40 + i * 45, 22 + j * 23]);
  const fill = '#5f8fbf';
  return (
    <svg className="raft-preview" viewBox="0 0 280 92" width="280" height="92" aria-hidden>
      {(type === 'solid' || type === 'hex' || type === 'case') && <rect x="22" y="6" width="236" height="80" rx="10" fill={fill} opacity="0.85" />}
      {type === 'case' && <rect x="16" y="2" width="248" height="88" rx="13" fill="none" stroke={fill} strokeWidth="5" />}
      {type === 'hex' &&
        Array.from({ length: 4 }, (_, r) =>
          Array.from({ length: 10 }, (_, c) => {
            const cx = 38 + c * 22 + (r % 2 ? 11 : 0), cy = 16 + r * 19;
            if (cx > 246) return null;
            const pts = Array.from({ length: 6 }, (_, k) => `${cx + 8 * Math.cos((Math.PI / 3) * k + Math.PI / 6)},${cy + 8 * Math.sin((Math.PI / 3) * k + Math.PI / 6)}`).join(' ');
            return <polygon key={`${r}-${c}`} points={pts} fill="var(--panel)" />;
          }),
        )}
      {(type === 'skate' || type === 'cross') &&
        [0, 1, 2].map((j) => <rect key={`r${j}`} x="40" y={22 + j * 23 - 3} width="180" height="6" fill={fill} />)}
      {type === 'cross' && [0, 1, 2, 3, 4].map((i) => <rect key={`c${i}`} x={40 + i * 45 - 3} y="22" width="6" height="46" fill={fill} />)}
      {(type === 'skate' || type === 'cross') && feet.map(([x, y], k) => <circle key={`p${k}`} cx={x} cy={y} r="8" fill={fill} />)}
      {feet.map(([x, y], k) => (
        <circle key={k} cx={x} cy={y} r="4" fill="#d9dee6" stroke="#1b1f26" strokeWidth="1" />
      ))}
    </svg>
  );
}

/** One value on the support drawing: a small labelled field placed at (x, y) of the drawing. */
function DiagramField({ x, y, label, value, onChange, title, min = 0, step = 0.05 }: { x: number; y: number; label: string; value: number; onChange: (v: number) => void; title: string; min?: number; step?: number }) {
  return (
    <div className="diagram-field" style={{ left: x, top: y }} title={title}>
      <span>{label}</span>
      <NumberField value={value} min={min} step={step} precision={2} width={70} title={title} onChange={(v) => onChange(Math.max(min, v))} />
    </div>
  );
}

/**
 * The support drawn with its sizes on it (like the support parameter sheets of
 * resin slicers): a regular support on the platform at the left, one standing
 * on the part below at the right.
 */
function SupportDiagram({ st }: { st: SupportParams }) {
  const v: SupportShape = st;
  const set = (patch: Partial<SupportShape>) => setSup(patch);
  const line = 'var(--muted)';
  return (
    <div className="support-diagram">
      <svg viewBox="0 0 288 340" width="288" height="340" aria-hidden>
        {/* the part */}
        <polygon points="78,8 210,8 192,60 96,60" fill="#3fa7ff" opacity="0.9" />
        {/* left: a support on the platform / raft: tip cone, rod, foot */}
        <polygon points="108,60 112,60 118,105 102,105" fill="#9aa3b0" />
        <rect x="102" y="105" width="16" height="145" fill="#9aa3b0" />
        <polygon points="102,250 118,250 130,280 90,280" fill="#9aa3b0" />
        <rect x="76" y="280" width="140" height="10" rx="2" fill="#6b7480" />
        {/* right: a support standing on the part below */}
        <polygon points="178,60 182,60 188,100 172,100" fill="#9aa3b0" />
        <rect x="172" y="100" width="16" height="105" fill="#9aa3b0" />
        <polygon points="172,205 188,205 182,232 178,232" fill="#9aa3b0" />
        <polygon points="150,232 214,232 214,290 150,290" fill="#3fa7ff" opacity="0.55" />
        {/* leader lines from the values to what they size */}
        <g stroke={line} strokeWidth="1" fill="none" strokeDasharray="3 2">
          <path d="M72 70 L106 62" />
          <path d="M216 70 L184 62" />
          <path d="M72 117 L101 88" />
          <path d="M72 187 L101 180" />
          <path d="M72 257 L96 266" />
          <path d="M72 310 L90 286" />
          <path d="M216 222 L182 230" />
        </g>
      </svg>
      <DiagramField x={0} y={48} label="Contact Ø" value={v.tipDiameter} onChange={(tipDiameter) => set({ tipDiameter })} title="Diameter where the tip touches the part (smaller: easier to remove, weaker)" min={0.05} />
      <DiagramField x={218} y={48} label="Depth" value={v.penetration} onChange={(penetration) => set({ penetration })} title="How far the tip reaches into the part" min={-2} />
      <DiagramField x={0} y={96} label="Tip length" value={v.tipLength} onChange={(tipLength) => set({ tipLength })} title="Length of the cone tip" min={0.1} step={0.1} />
      <DiagramField x={0} y={166} label="Rod Ø" value={v.bodyDiameter} onChange={(bodyDiameter) => set({ bodyDiameter })} title="Diameter of the support rod" min={0.1} step={0.1} />
      <DiagramField x={0} y={236} label="Foot height" value={v.footHeight} onChange={(footHeight) => set({ footHeight })} title="Height of the foot cone on the platform / raft" min={0.1} step={0.1} />
      <DiagramField x={0} y={290} label="Foot Ø" value={v.baseDiameter} onChange={(baseDiameter) => set({ baseDiameter })} title="Diameter of the foot on the platform / raft" min={0.1} step={0.1} />
      <DiagramField x={218} y={200} label="On part Ø" value={v.bottomDiameter} onChange={(bottomDiameter) => set({ bottomDiameter })} title="Contact diameter where a support stands on the part below" min={0.05} />
    </div>
  );
}

/**
 * Editing supports by hand: every touch point is shown as a dot; they can be
 * selected (click, Ctrl-click, drag a rectangle), deleted, dragged to a new
 * place on the part, and new supports added by clicking on the part.
 */
function SupportHandEdits() {
  const mode = useStore((s) => s.supportEdit);
  const picked = useStore((s) => s.supportSel);
  const parts = useStore((s) => s.buildGen.parts);
  const selection = useStore((s) => s.selection);
  useStore((s) => s.supportTick);
  const g = useStore((s) => s.buildGen);
  const sel = selectedBuildPartIds(selection);
  const scope = sel.length ? parts.filter((p) => sel.includes(p.id)) : parts;
  const n = supportEditCounts(scope);
  const edits = n.add + n.remove + n.skip;
  const total = mode ? supportTouchPoints(g).length : 0;
  return (
    <>
      <div className="sub-title">Edit supports by hand (or click a support in the view)</div>
      <Segmented
        value={mode ?? 'off'}
        onChange={(v) => setState({ supportEdit: v === 'off' ? null : v, supportSel: [] })}
        options={[
          { value: 'off', label: 'Off' },
          { value: 'select', label: 'Select / move', title: 'Touch points are shown as dots: click to select, drag one to move its support, drag a rectangle to select several' },
          { value: 'add', label: 'Add supports', title: 'Click on the part to add a support there' },
        ]}
      />
      {mode === 'select' && (
        <>
          <div className="pick-row">
            <span className="muted small">
              {picked.length} of {total} support{total === 1 ? '' : 's'} selected
            </span>
            <button className="mini" disabled={!total} onClick={() => selectTouchPoints(supportTouchPoints().map((t) => ({ key: t.key, i: t.i })))}>
              Select all
            </button>
            <button className="mini" disabled={!picked.length} onClick={() => selectTouchPoints([])}>
              Clear
            </button>
          </div>
          <div className="btn-grid two">
            <button className="btn" disabled={!picked.length} onClick={() => deleteSelectedSupports()} title="Delete the selected supports (Delete key)">
              Delete selected
            </button>
            <button className="btn" disabled={!picked.length} onClick={() => deleteSelectedSupports(true)} title="Delete every support of the overhang areas the selected ones stand under">
              Delete their areas
            </button>
          </div>
        </>
      )}
      {mode && (
        <Hint>
          Dots: <b style={{ color: '#9adbff' }}>generated</b>, <b style={{ color: '#4deb73' }}>added by hand</b>, <b style={{ color: '#ffd133' }}>selected</b>.{' '}
          {mode === 'select'
            ? 'Click a dot to select it, Ctrl / Shift-click to add more, drag on empty space to select all dots in a rectangle. Drag a dot over the part to move its support there. Right-drag turns the view.'
            : 'Click on the part where it needs a support: on a surface facing down, or on top (the support goes under the surface below the click). On DMLS a small block of walls is added.'}
        </Hint>
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
