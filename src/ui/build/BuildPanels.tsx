import { useRef, useState } from 'react';
import { SaveLocationRow } from '../Dialogs';
import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { Icon } from '../icons';
import { SnapControls } from '../SnapControls';
import { getState, setState, useStore } from '../../state/store';
import { importFiles } from '../../state/actions';
import { acceptSavedSession } from '../../state/buildSession';
import {
  addPartsFromPrep, clearBuildParts, setBuildRotationLock, selectAllBuildParts, selectBuildPart, selectedBuildPartIds, setTiltFor, currentPrinter, buildDensity, setDensityAllowance, exportBuilds, checkCollisions, checkInterlocking, clearChecks, setChecksShowOnly, rearrangeBuilds, setBreakaway, cageBuildParts, uncageBuildPart, setCageSettings, DEFAULT_CAGE, stopNesting, setCopyLocks, lockTargets, repairBuildPartsInPrep, hideBuildSelection, showAllBuildParts, toggleBuildPartHidden, isHiddenKey, groupBuildParts, ungroupBuildParts, groupLabels, partOfKey, openBuildInPrep, removeBuildPart, setActiveBuild, setPartQuantity,
  updateBuildSettings,
  setSlcLayer,
} from '../../state/buildActions';
import { PRINTERS, TECHNOLOGIES, isResin, printerById, type Technology } from '../../state/printers';
import { importableExtensions } from '../../loaders/registry';
import type { BuildPart, Tilt } from '../../state/types';

const f1 = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
const pct = (v: number) => `${(v * 100).toLocaleString(undefined, { maximumFractionDigits: v < 0.1 ? 2 : 1 })}%`;
const cm3 = (mm3: number) => `${(mm3 / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} cm³`;

/** A session saved in the browser (e.g. before a crash): restore it or start new. */
function SavedSessionBanner() {
  const saved = useStore((s) => s.savedBuildSession);
  if (!saved) return null;
  return (
    <div className="manual-banner">
      <b>Last session saved</b>
      <span>
        {saved.parts} part{saved.parts > 1 ? 's' : ''} ({saved.copies} copies), saved {new Date(saved.savedAt).toLocaleString()}.
      </span>
      <div className="btn-grid two">
        <button className="btn primary" onClick={() => void acceptSavedSession(true)}>
          Restore
        </button>
        <button className="btn" onClick={() => void acceptSavedSession(false)}>
          Discard
        </button>
      </div>
    </div>
  );
}

/** Put the selected parts in a cage (sinter box) so they are not lost in the powder; or take them out of one. */
function CageBox({ ids }: { ids: string[] }) {
  const parts = useStore((s) => s.buildGen.parts);
  const settings = useStore((s) => s.buildGen.cageSettings) ?? DEFAULT_CAGE;
  const busy = useStore((s) => s.jobs.some((j) => j.label === 'Making a cage'));
  const powder = useStore((s) => currentPrinter(s.buildGen).tech === 'powder');
  const sel = parts.filter((p) => ids.includes(p.id));
  const cage = sel.length === 1 && sel[0].cage ? sel[0] : null;
  // cages keep small parts together in the powder: HP MJF / SLS only
  if (!powder && !cage) return null;
  if (cage)
    return (
      <div className="density-box">
        <h4>Cage</h4>
        <Hint>
          Holds {cage.cage!.contents.map((p) => (p.quantity > 1 ? `${p.name} ×${p.quantity}` : p.name)).join(', ')} — bars {cage.cage!.options.thickness} mm thick,{' '}
          {cage.cage!.options.barWidth} mm wide, {cage.cage!.options.gap} mm apart. Nested as one part.
        </Hint>
        <button className="btn" onClick={() => uncageBuildPart(cage.id)}>
          Take the parts out of the cage
        </button>
      </div>
    );
  return (
    <div className="density-box">
      <h4>Cage</h4>
      <Row label="Bar thickness">
        <NumberField value={settings.thickness} min={0.3} step={0.1} suffix="mm" onChange={(thickness) => setCageSettings({ thickness: Math.max(0.3, thickness) })} />
      </Row>
      <Row label="Bar width">
        <NumberField value={settings.barWidth} min={0.5} step={0.5} suffix="mm" onChange={(barWidth) => setCageSettings({ barWidth: Math.max(0.5, barWidth) })} />
      </Row>
      <Row label="Gap between bars">
        <NumberField value={settings.gap} min={0.5} step={0.5} suffix="mm" onChange={(gap) => setCageSettings({ gap: Math.max(0.5, gap) })} />
      </Row>
      <button className="btn wide" disabled={!sel.length || busy} onClick={() => void cageBuildParts(ids)} title="All copies of the selected parts, packed tightly inside a lattice box, so they are not lost in the powder">
        {busy ? 'Making the cage…' : `Put ${sel.length > 1 ? `these ${sel.length} parts` : 'it'} in a cage`}
      </button>
      <Hint>Keep the gap smaller than the smallest part, so nothing falls out. The cage keeps the clearance to the parts.</Hint>
    </div>
  );
}

/** Cups / bowls with props across the opening: let other parts be nested inside (the props are broken off later). */
function BreakawayCheck({ ids }: { ids: string[] }) {
  const parts = useStore((s) => s.buildGen.parts);
  const on = ids.length > 0 && ids.every((id) => parts.find((p) => p.id === id)?.breakaway);
  return (
    <>
      <Check checked={on} onChange={(v) => setBreakaway(ids, v)}>
        Has props to break off: nest parts inside it
      </Check>
      {on && <Hint>For cups and bowls with props across the opening: other parts may be placed inside, even where the props would hold them in; break the props off to take them out.</Hint>}
    </>
  );
}

/** Start nesting button, with the choice to nest automatically after every change. */
function StartNesting() {
  const g = useStore((s) => s.buildGen);
  if (!g.parts.length) return null;
  const pending = !g.builds.length || g.stale;
  return (
    <div className="start-nesting">
      <button className={`btn ${pending ? 'primary' : ''} big`} disabled={g.busy} onClick={rearrangeBuilds} title="Arrange all parts and quantities into builds now">
        {g.busy ? 'Nesting…' : g.builds.some((b) => !b.preview) ? 'Start nesting again' : 'Start nesting'}
      </button>
      {pending && g.builds.length > 0 && <Hint>Parts or settings changed since the last nesting.</Hint>}
      <Check checked={!!g.autoNest} onChange={(autoNest) => updateBuildSettings({ autoNest })}>
        Nest automatically after every change
      </Check>
    </div>
  );
}

/** Move / rotate / drag parts of the active build by hand. */
function EditBox() {
  const edit = useStore((s) => s.buildEdit ?? 'select');
  const pickCopies = useStore((s) => s.buildPickCopies);
  const hidden = useStore((s) => s.buildGen.hidden?.length ?? 0);
  const selCount = useStore((s) => s.selection.length);
  return (
    <div className="density-box">
      <h4>Select & edit by hand</h4>
      <Check checked={pickCopies || edit !== 'select'} onChange={(buildPickCopies) => setState({ buildPickCopies, selection: [] })}>
        Pick single copies (not all of a part's quantity)
      </Check>
      <div className="btn-grid two">
        <button className="btn" disabled={!selCount} onClick={hideBuildSelection} title="Hide the selected parts (or copies) in the view">
          Hide selected
        </button>
        <button className="btn" disabled={!hidden} onClick={showAllBuildParts}>
          Show all{hidden ? ` (${hidden} hidden)` : ''}
        </button>
      </div>
      <Segmented
        value={edit}
        onChange={(buildEdit) => setState({ buildEdit, selection: [] })}
        options={[
          { value: 'select', label: 'Select' },
          { value: 'move', label: 'Move' },
          { value: 'rotate', label: 'Rotate' },
          { value: 'drag', label: 'Drag' },
        ]}
      />
      <SnapControls />
      <Hint>
        Click a part, then use the Move / Rotate handles, or Drag it across the platform (Shift-drag moves it up / down). Run Check collisions afterwards.
      </Hint>
    </div>
  );
}

/** Lock translation / rotation axes of the selected copies: nesting keeps them, the rest is arranged around them. */
function LockBox() {
  const buildGen = useStore((s) => s.buildGen);
  const selection = useStore((s) => s.selection);
  const buildEdit = useStore((s) => s.buildEdit);
  const buildPickCopies = useStore((s) => s.buildPickCopies);
  const locks = buildGen.locks ?? {};
  const targets = lockTargets({ ...getState(), buildGen, selection, buildEdit, buildPickCopies });
  const total = Object.keys(locks).length;
  const state = (kind: 't' | 'r', i: number) => {
    const n = targets.filter((k) => locks[k]?.[kind][i]).length;
    return n === 0 ? 'off' : n === targets.length ? 'on' : 'some';
  };
  const toggle = (kind: 't' | 'r', i: number) => {
    const lock = state(kind, i) !== 'on';
    const t: (boolean | undefined)[] = [undefined, undefined, undefined];
    const r: (boolean | undefined)[] = [undefined, undefined, undefined];
    (kind === 't' ? t : r)[i] = lock;
    setCopyLocks(targets, t, r);
  };
  const axisButtons = (kind: 't' | 'r') =>
    [0, 1, 2].map((i) => (
      <button key={i} className={`mini lock-axis ${state(kind, i)}`} disabled={!targets.length} onClick={() => toggle(kind, i)} title={`${state(kind, i) === 'on' ? 'Unlock' : 'Lock'} ${kind === 't' ? 'moving along' : 'turning about'} ${'XYZ'[i]}`}>
        {'XYZ'[i]}
      </button>
    ));
  return (
    <div className="density-box">
      <h4>Lock copies in place</h4>
      <div className="lock-grid">
        <span>Position</span>
        {axisButtons('t')}
        <span>Rotation</span>
        {axisButtons('r')}
      </div>
      <div className="btn-grid two">
        <button className="btn" disabled={!targets.length} onClick={() => setCopyLocks(targets, [true, true, true], [true, true, true])}>
          Lock all axes
        </button>
        <button className="btn" disabled={!targets.some((k) => locks[k])} onClick={() => setCopyLocks(targets, [false, false, false], [false, false, false])}>
          Unlock
        </button>
      </div>
      <Hint>
        {targets.length
          ? `${targets.length} cop${targets.length > 1 ? 'ies' : 'y'} selected. `
          : 'Select copies (Pick single copies above, or a whole part). '}
        Arrange them by hand, lock them, then Start nesting: locked copies stay put on their locked axes (and are not turned), everything else is nested around them.
        {total ? ` ${total} cop${total > 1 ? 'ies are' : 'y is'} locked.` : ''}
      </Hint>
      {total > 0 && (
        <button className="mini" onClick={() => setCopyLocks(Object.keys(locks), [false, false, false], [false, false, false])}>
          Unlock every copy
        </button>
      )}
    </div>
  );
}

/** What the last nesting did: to look at, or copy and send when something goes wrong. */
function NestLogBox() {
  const lines = useStore((s) => s.nestLog);
  const [copied, setCopied] = useState(false);
  if (!lines.length) return null;
  const copy = async () => {
    const text = [`AutoNest nesting log (${new Date().toLocaleString()}, ${navigator.userAgent})`, ...lines].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy the nesting log:', text);
    }
  };
  return (
    <details className="density-box nest-log">
      <summary>
        Nesting log <span className="muted">({lines.at(-1)?.replace(/^\s*[\d.]+ s\s+/, '')})</span>
      </summary>
      <pre>{lines.join('\n')}</pre>
      <button className="mini" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy log'}
      </button>
    </details>
  );
}

/** Collision check and interlocking test of the active build. */
function ChecksBox() {
  const g = useStore((s) => s.buildGen);
  const c = g.checks && g.checks.build === g.active ? g.checks : null;
  const name = (key: string) => {
    const p = g.parts.find((x) => x.id === partOfKey(key));
    return p ? (p.quantity > 1 ? `${p.name} (${Number(key.split('#')[1]) + 1})` : p.name) : key;
  };
  return (
    <div className="density-box">
      <h4>Checks</h4>
      <div className="btn-grid two">
        <button className="btn" onClick={checkCollisions} title="Find parts that cross, sit inside each other or are closer than the clearance">
          Check collisions
        </button>
        <button className="btn" onClick={checkInterlocking} title="Can every part be taken out, one after the other, by sliding it straight out?">
          Test interlocking
        </button>
      </div>
      {c?.collisions && (
        <>
          <div className={`verdict ${c.collisions.length ? 'bad' : 'ok'} small`}>
            {c.collisions.length ? `${c.collisions.length} collision${c.collisions.length > 1 ? 's' : ''}` : 'No collisions'}
          </div>
          {c.collisions.length > 0 && (
            <ul className="err-list">
              {c.collisions.map((x, i) => (
                <li key={i}>
                  <span className="err-text">
                    {name(x.a)} ↔ {name(x.b)}: {x.kind === 'intersect' ? 'surfaces cross' : x.kind === 'inside' ? 'one inside the other' : `only ${x.distance?.toFixed(2)} mm apart`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {c?.stuck && (
        <div className={`verdict ${c.stuck.length ? 'bad' : 'ok'} small`}>
          {c.stuck.length ? `Interlocked: ${c.stuck.map(name).join(', ')}` : 'No interlocking: every part can be taken out'}
        </div>
      )}
      {c && ((c.collisions?.length ?? 0) > 0 || (c.stuck?.length ?? 0) > 0) && (
        <div className="btn-row">
          <Check checked={c.showOnly} onChange={setChecksShowOnly}>
            Show only these parts
          </Check>
          <button className="mini" onClick={clearChecks}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

/** Packing density of the active build: against the whole build volume and up to the tallest part + an allowance. */
function DensityBox() {
  const g = useStore((s) => s.buildGen);
  const d = buildDensity(g.active, g);
  if (!d) return null;
  const [X, Y, Z] = currentPrinter(g).volume;
  const b = g.builds[g.active];
  const capped = d.usedHeight >= Z - 1e-9 && b.height + (g.densityAllowance ?? 5) > Z;
  return (
    <div className="density-box">
      <h4>Packing density · {b.name}</h4>
      <dl className="info">
        <dt>Parts volume</dt>
        <dd>{cm3(d.partsVolume)}</dd>
        <dt title={`${f1(X)} × ${f1(Y)} × ${f1(Z)} mm = ${cm3(d.fullVolume)}`}>Full build volume</dt>
        <dd>
          <b>{pct(d.full)}</b> <span className="muted small">of {cm3(d.fullVolume)}</span>
        </dd>
        <dt title={`${f1(X)} × ${f1(Y)} × ${f1(d.usedHeight)} mm = ${cm3(d.usedVolume)}`}>Up to {f1(d.usedHeight)} mm</dt>
        <dd>
          <b>{pct(d.used)}</b> <span className="muted small">of {cm3(d.usedVolume)}</span>
        </dd>
      </dl>
      <Row label="Above tallest part">
        <NumberField value={g.densityAllowance ?? 5} min={0} step={1} suffix="mm" title="Height allowance added to the tallest part for the second density" onChange={setDensityAllowance} />
      </Row>
      <Hint>
        Tallest part {f1(b.height)} mm + {f1(g.densityAllowance ?? 5)} mm{capped ? `, capped at the printer height ${f1(Z)} mm` : ''}. Density = total part volume ÷ build volume
        (X × Y × height).
      </Hint>
    </div>
  );
}

const TILT_PRESETS = [0, 15, 30, 45];
const DIRECTIONS: { value: string; label: string; azimuth: number }[] = [
  { value: '0', label: '+X (right)', azimuth: 0 },
  { value: '180', label: '−X (left)', azimuth: 180 },
  { value: '90', label: '+Y (back)', azimuth: 90 },
  { value: '270', label: '−Y (front)', azimuth: 270 },
];

// ---------------------------------------------------------------- build tabs (toolbar second row)

export function BuildTabs() {
  const g = useStore((s) => s.buildGen);
  const printer = currentPrinter(g);
  return (
    <div className="tb-row tools-row build-tabs">
      <span className="build-printer" title="Printer and build volume">
        {printer.name} · {printer.volume.join(' × ')} mm
      </span>
      {g.builds.map((b, i) => (
        <button key={i} className={`tb tool ${g.active === i ? 'active' : ''}`} onClick={() => setActiveBuild(i)} title={`${b.placements.length} parts · ${f1(b.height)} mm tall · ${Math.round(b.utilization * 100)}% of the platform`}>
          <span>{b.name}</span>
          <span className="build-count">{b.placements.length}</span>
        </button>
      ))}
      {g.busy && <span className="muted small">Generating builds…</span>}
      {!g.builds.length && !g.busy && <span className="muted small">No builds yet: add files to start.</span>}
    </div>
  );
}

// ---------------------------------------------------------------- left: printer and rules

function TiltControls({ tilt, onChange }: { tilt: Tilt; onChange: (t: Tilt) => void }) {
  const preset = TILT_PRESETS.includes(tilt.angle) ? String(tilt.angle) : 'custom';
  const dir = DIRECTIONS.find((d) => d.azimuth === ((tilt.azimuth % 360) + 360) % 360)?.value ?? 'custom';
  return (
    <>
      <Row label="Tilt">
        <Segmented
          value={preset}
          onChange={(v) => onChange({ ...tilt, angle: v === 'custom' ? (TILT_PRESETS.includes(tilt.angle) ? 10 : tilt.angle) : Number(v) })}
          options={[
            { value: '0', label: '0°' },
            { value: '15', label: '15°' },
            { value: '30', label: '30°' },
            { value: '45', label: '45°' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
      </Row>
      {preset === 'custom' && (
        <Row label="Angle">
          <NumberField value={tilt.angle} min={-89} max={89} step={1} suffix="°" onChange={(angle) => onChange({ ...tilt, angle })} />
        </Row>
      )}
      {tilt.angle !== 0 && (
        <>
          <Row label="Direction">
            <select className="tb-select" value={dir} onChange={(e) => e.target.value !== 'custom' && onChange({ ...tilt, azimuth: Number(e.target.value) })}>
              {DIRECTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </Row>
          {dir === 'custom' && (
            <Row label="Direction angle">
              <NumberField value={tilt.azimuth} step={15} suffix="°" title="0° = +X, 90° = +Y" onChange={(azimuth) => onChange({ ...tilt, azimuth })} />
            </Row>
          )}
        </>
      )}
    </>
  );
}

export function BuildSetupPanel() {
  const g = useStore((s) => s.buildGen);
  const printer = printerById(g.printerId);
  const [open, setOpen] = useState<Technology>(printer.tech);
  const fileRef = useRef<HTMLInputElement>(null);
  const accept = [...importableExtensions(), 'bin'].map((e) => '.' + e).join(',');
  const custom = g.customVolumes[printer.id] ?? printer.volume;
  return (
    <aside className="panel left build-setup">
      <header className="panel-head">
        <h2>Build generation</h2>
      </header>
      <div className="panel-scroll">
        <Section title="Parts">
          <SavedSessionBanner />
          <div className="btn-grid two">
            <button className="btn primary" onClick={() => fileRef.current?.click()}>
              Add files…
            </button>
            <button className="btn" onClick={addPartsFromPrep} title="Copy the selected (or all) parts from the Mesh prep unit">
              From Mesh prep
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={accept}
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) importFiles(files);
            }}
          />
          <Hint>
            {g.autoNest
              ? 'Builds are re-arranged automatically after every change; you can also drop files on the window.'
              : 'Add all files and set the quantities first (you can also drop files on the window), then press Start nesting.'}
          </Hint>
          <StartNesting />
        </Section>
        <Section title="Printer">
          <div className="printer-tree">
            {TECHNOLOGIES.map((t) => (
              <div key={t.id} className={`tech ${open === t.id ? 'open' : ''}`}>
                <button className="tech-head" data-help={t.id === 'powder' ? 'hp mjf / sls' : t.id} data-help-title={t.label} onClick={() => setOpen(open === t.id ? (null as never) : t.id)}>
                  <span className="caret">{open === t.id ? '▾' : '▸'}</span>
                  {t.label}
                  {printer.tech === t.id && <span className="tech-current">{printer.name}</span>}
                </button>
                {open === t.id && (
                  <ul>
                    {PRINTERS.filter((p) => p.tech === t.id).map((p) => (
                      <li key={p.id}>
                        <label className={g.printerId === p.id ? 'active' : ''} data-help={p.custom ? 'custom' : undefined} data-help-title={p.custom ? 'Custom printer' : p.name} data-help-text={p.custom ? undefined : `${t.label} printer with a build volume of ${p.volume.join(' × ')} mm (X × Y × Z). Select it and the builds are arranged for this platform.`}>
                          <input type="radio" name="printer" checked={g.printerId === p.id} onChange={() => updateBuildSettings({ printerId: p.id })} />
                          <span className="pname">{p.name}</span>
                          <span className="pvol">{p.custom ? 'your size' : p.volume.join('×')}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
          {printer.custom && (
            <Row label="Size X × Y × Z">
              {[0, 1, 2].map((k) => (
                <NumberField
                  key={k}
                  value={custom[k]}
                  min={10}
                  step={10}
                  onChange={(v) => {
                    const next = [...custom] as [number, number, number];
                    next[k] = v;
                    updateBuildSettings({ customVolumes: { ...g.customVolumes, [printer.id]: next } });
                  }}
                />
              ))}
            </Row>
          )}
          <Hint>{TECHNOLOGIES.find((t) => t.id === printer.tech)!.note}{printer.provisional ? ' Build volume to be confirmed.' : ''}</Hint>
        </Section>
        <Section title="Spacing">
          {printer.tech === 'powder' && g.nest3d ? (
            <Row label="Clearance between parts">
              <NumberField
                value={g.clearance3d}
                min={0.5}
                step={0.5}
                suffix="mm"
                title="Smallest distance between the surfaces of two parts (0.5 mm and up)"
                onChange={(clearance3d) => updateBuildSettings({ clearance3d: Math.max(0.5, clearance3d) })}
              />
            </Row>
          ) : (
            <Row label="Clearance between parts">
              <NumberField value={g.gap} min={0} step={0.5} suffix="mm" onChange={(gap) => updateBuildSettings({ gap })} />
            </Row>
          )}
          <Row label="Margin at the edges">
            <NumberField value={g.margin} min={0} step={1} suffix="mm" onChange={(margin) => updateBuildSettings({ margin })} />
          </Row>
          <Row label="Distance from platform">
            <NumberField value={g.zOffset} min={0} step={0.5} suffix="mm" title="Height of the parts above the build plate (e.g. for supports)" onChange={(zOffset) => updateBuildSettings({ zOffset })} />
          </Row>
        </Section>
        <Section title="Arrangement">
          <Check checked={g.autoTilt} onChange={(autoTilt) => updateBuildSettings({ autoTilt })}>
            Tilt parts that are too tall or too big
          </Check>
          <Check checked={g.autoOrient} onChange={(autoOrient) => updateBuildSettings({ autoOrient })}>
            {printer.tech === 'powder' ? 'Orient parts automatically' : 'Largest flat face down'}
          </Check>
          {printer.tech === 'powder' && g.autoOrient && (
            <>
              <Row label="Orientation">
                <Segmented
                  value={g.powderOrient ?? 'packing'}
                  onChange={(powderOrient) => updateBuildSettings({ powderOrient })}
                  options={[
                    { value: 'packing', label: 'Best packing' },
                    { value: 'rules', label: 'SLS / MJF rules' },
                  ]}
                />
              </Row>
              <Hint>
                {(g.powderOrient ?? 'packing') === 'packing'
                  ? 'Each part rests on its largest flat face, lined up with X / Y; with 3D nesting it may also be laid on its side when that packs denser. Fits the most parts per build.'
                  : 'Each part is turned so no large flat surface lies parallel to the platform and the area per layer changes smoothly. Better surfaces, but fewer parts fit per build.'}
              </Hint>
            </>
          )}
          <Check checked={g.allowRotate} onChange={(allowRotate) => updateBuildSettings({ allowRotate })}>
            Allow turning parts 90° to fit
          </Check>
          {printer.tech === 'powder' && (
            <>
              <Check checked={g.nest3d} onChange={(nest3d) => updateBuildSettings({ nest3d })}>
                Nest by part shape in X, Y and Z (3D nesting)
              </Check>
              {!g.nest3d && (
                <Check checked={g.stack} onChange={(stack) => updateBuildSettings({ stack })}>
                  Stack parts in Z (powder bed)
                </Check>
              )}
              <Row label="Max build height">
                <NumberField
                  value={g.maxHeight}
                  min={0}
                  step={10}
                  suffix="mm"
                  title={`Build only up to this height above the platform (0 = the printer's full ${printer.volume[2]} mm)`}
                  onChange={(maxHeight) => updateBuildSettings({ maxHeight: Math.max(0, maxHeight) })}
                />
              </Row>
              {g.nest3d && (
                <Check checked={g.symmetric !== false} onChange={(symmetric) => updateBuildSettings({ symmetric })}>
                  Arrange copies symmetrically when it costs no density
                </Check>
              )}
              {g.nest3d && (
                <Row label="Nesting detail">
                  <Segmented
                    value={g.nestDetail ?? 'normal'}
                    onChange={(nestDetail) => updateBuildSettings({ nestDetail })}
                    options={[
                      { value: 'fast', label: 'Fast' },
                      { value: 'normal', label: 'Normal' },
                      { value: 'fine', label: 'Fine' },
                    ]}
                  />
                </Row>
              )}
              {g.nest3d && (
                <Row label="Time limit">
                  <NumberField
                    value={g.nestTimeLimit ?? 10}
                    min={0}
                    step={1}
                    precision={0}
                    suffix="min"
                    title="Stop nesting after this long and keep the best builds found so far (0 = no limit)"
                    onChange={(nestTimeLimit) => updateBuildSettings({ nestTimeLimit: Math.max(0, Math.round(nestTimeLimit)) })}
                  />
                </Row>
              )}
            </>
          )}
          <Hint>
            {printer.tech === 'powder' && g.nest3d
              ? `3D nesting: parts are packed by their real shape (not their bounding box), into each other's free space (inside cups, trays and U shapes too) and up in Z, with at least the clearance between surfaces${g.nestVoxel ? ` (resolution ${g.nestVoxel.toFixed(2)} mm)` : ''}. A part is only placed where it can slide straight out (along X, Y, Z or a tilted line, e.g. out of a tilted cup), so parts never interlock; cups, trays and U shapes are tried first so other parts go inside them. Packing density comes first; copies are put in a regular pattern only when that needs no more builds and no more height. Fast: one voxel per clearance. Normal: a grid twice as fine, several ways tried in parallel and the densest kept. Fine: everything Normal does, then the two best orders again on a finer grid (never less dense than Normal). Nesting stops at the time limit and keeps the best builds found. Parts are oriented by the SLS / MJF rules (or kept as they are when that is off), plus any Tilt below.`
              : 'Each build is filled completely before a new one is started. Parts are placed tallest first, so similar heights end up together; when everything fits on one platform it stays one build. Parts that do not fit are tilted (smallest angle first) until they do.'}
          </Hint>
        </Section>
        <TiltSection />
      </div>
    </aside>
  );
}

/** Tilt for all parts, or only for the selected parts (they get their own tilt). */
function TiltSection() {
  const g = useStore((s) => s.buildGen);
  const selection = useStore((s) => s.selection);
  const ids = selectedBuildPartIds(selection);
  const [target, setTarget] = useState<'all' | 'selected'>('all');
  // picking parts switches to "selected"; clearing the selection goes back to "all"
  const [lastCount, setLastCount] = useState(ids.length);
  if (ids.length !== lastCount) {
    setLastCount(ids.length);
    setTarget(ids.length ? 'selected' : 'all');
  }
  const own = g.parts.filter((p) => p.tilt);
  const first = g.parts.find((p) => p.id === ids[0]);
  const selTilt = first?.tilt ?? g.tilt;
  return (
    <Section title="Tilt">
      <Segmented
        value={target}
        onChange={setTarget}
        options={[
          { value: 'all', label: 'All parts' },
          { value: 'selected', label: `Selected (${ids.length})` },
        ]}
      />
      {target === 'all' ? (
        <>
          <TiltControls tilt={g.tilt} onChange={(tilt) => updateBuildSettings({ tilt })} />
          {own.length > 0 && (
            <div className="pick-row">
              <span className="muted small">
                {own.length} part{own.length > 1 ? 's have' : ' has'} its own tilt
              </span>
              <button className="mini" onClick={() => setTiltFor(own.map((p) => p.id), null)}>
                Use this tilt for all
              </button>
            </div>
          )}
        </>
      ) : ids.length === 0 ? (
        <Hint>Click parts in the view (Ctrl / Shift-click for more) or in the parts list to tilt only those.</Hint>
      ) : (
        <>
          <TiltControls tilt={selTilt} onChange={(t) => setTiltFor(ids, t)} />
          <div className="pick-row">
            <span className="muted small">
              {ids.length === 1 ? first?.name : `${ids.length} parts`}
              {first?.tilt ? ' · own tilt' : ' · following all parts'}
            </span>
            {ids.some((id) => g.parts.find((p) => p.id === id)?.tilt) && (
              <button className="mini" onClick={() => setTiltFor(ids, null)} title="Remove their own tilt so they follow the tilt for all parts">
                Reset
              </button>
            )}
          </div>
        </>
      )}
      <Hint>A part that no longer fits its build after tilting moves to another build.</Hint>
    </Section>
  );
}

// ---------------------------------------------------------------- right: builds and parts

function partStatus(p: BuildPart, builds: { name: string; placements: { partId: string }[] }[], unplaced: { partId: string }[]) {
  const where = builds.filter((b) => b.placements.some((pl) => pl.partId === p.id)).map((b) => b.name.replace('Build ', 'B'));
  const missing = unplaced.filter((u) => u.partId === p.id).length;
  return { where, missing };
}

export function BuildsPanel() {
  const g = useStore((s) => s.buildGen);
  const selection = useStore((s) => s.selection);
  const selIds = selectedBuildPartIds(selection);
  const sel = selIds.length === 1 ? (g.parts.find((p) => p.id === selIds[0]) ?? null) : null;
  const active = g.builds[g.active];
  const total = g.parts.reduce((a, p) => a + p.quantity, 0);
  const groups = groupLabels(g.parts);
  const resin = isResin(currentPrinter(g).tech);
  return (
    <aside className="panel right">
      <header className="panel-head">
        <h2>Builds</h2>
        <div className="grow" />
        {g.builds.length > 0 && (
          <button className="mini" onClick={() => exportBuilds('all')} title="Every build as a 3MF file, zipped">
            Export all
          </button>
        )}
      </header>
      <div className="panel-scroll">
        <Section title={`${g.builds.length} build${g.builds.length === 1 ? '' : 's'} · ${total} part${total === 1 ? '' : 's'}`}>
          <ul className="build-list">
            {g.builds.map((b, i) => (
              <li key={i} className={g.active === i ? 'active' : ''} onClick={() => setActiveBuild(i)}>
                <b>{b.name}</b>
                <span>{b.placements.length} parts</span>
                <span>{f1(b.height)} mm tall</span>
                <span className="util" title="Platform area used">
                  <i style={{ width: `${Math.min(100, Math.round(b.utilization * 100))}%` }} />
                </span>
                {(() => {
                  const d = buildDensity(i, g);
                  return d ? (
                    <span className="density" title="Packing density: parts volume ÷ full build volume · ÷ volume up to the tallest part + allowance">
                      Density {pct(d.full)} full · {pct(d.used)} to {f1(d.usedHeight)} mm
                    </span>
                  ) : null;
                })()}
              </li>
            ))}
          </ul>
          {g.unplaced.length > 0 && (
            <div className="unplaced">
              <b>{g.unplaced.length} part{g.unplaced.length > 1 ? 's' : ''} cannot be placed on this printer</b>
              <ul>
                {[...new Map(g.unplaced.map((u) => [u.partId, u])).values()].map((u) => (
                  <li key={u.partId}>
                    {g.parts.find((p) => p.id === u.partId)?.name}: {u.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {active?.preview && !g.busy && (
            <div className="manual-banner">
              <b>Not nested yet</b>
              <span>The parts are shown in a quick layout so you can see them. Set the quantities, then press Start nesting to arrange them properly.</span>
            </div>
          )}
          {g.improving && (
            <div className="manual-banner">
              <b>Still nesting</b>
              <span>
                Showing the densest builds found so far ({g.improving.done} of {g.improving.total} ways tried). Better ones replace them as they come.
              </span>
              <button className="mini" onClick={stopNesting} title="Stop trying more ways and keep the builds shown">
                Stop and keep
              </button>
            </div>
          )}
          {g.manual ? (
            <div className="manual-banner">
              <b>Edited by hand</b>
              <span>{g.stale ? 'Settings or parts changed since: re-arrange to apply them (your edits will be replaced).' : 'Automatic re-arranging is paused so your edits stay.'}</span>
              <button className="mini" onClick={rearrangeBuilds}>
                Re-arrange
              </button>
            </div>
          ) : (
            g.parts.length > 0 && (g.stale || !g.builds.length) && <StartNesting />
          )}
          {active && <EditBox />}
          <NestLogBox />
          {active && <LockBox />}
          {active?.preview && (
            <Hint>
              The parts wait beside the platform until they are nested. Arrange or lock copies by hand if you like, then press Start nesting to place them in
              builds.
            </Hint>
          )}
          {active && !active.preview && <ChecksBox />}
          {active && !active.preview && <DensityBox />}
          {active && !active.preview && (
            <div className="btn-grid two">
              <button className="btn primary" onClick={() => exportBuilds(g.active, '3mf')}>
                Export {active.name} (3MF)
              </button>
              <button className="btn" onClick={() => exportBuilds(g.active, 'stl')}>
                STL
              </button>
              {resin && (
                <button className="btn" onClick={() => exportBuilds(g.active, 'slc')} title={`Slice the build into contours every ${g.slcLayer ?? 0.05} mm (SLC, for SLA / DLP)`}>
                  SLC
                </button>
              )}
              <button className="btn" onClick={() => openBuildInPrep(g.active)} title="Copy this build's parts, placed, into Mesh prep">
                Open in Mesh prep
              </button>
            </div>
          )}
          {active && !active.preview && resin && (
            <Row label="SLC layer">
              <NumberField value={g.slcLayer ?? 0.05} min={0.005} step={0.005} precision={3} suffix="mm" title="Layer thickness of the SLC export" onChange={(v) => setSlcLayer(Math.max(0.005, v))} />
            </Row>
          )}
          {g.builds.length > 0 && <SaveLocationRow />}
        </Section>
        <Section
          title={`Parts (${g.parts.length})`}
          actions={
            g.parts.length > 0 && (
              <>
                <button className="mini" onClick={selectAllBuildParts} title="Select every part">
                  All
                </button>
                <button className="mini" onClick={clearBuildParts}>
                  Clear
                </button>
              </>
            )
          }
        >
          {!g.parts.length && <Hint>Add files or take parts from Mesh prep.</Hint>}
          {(() => {
            const bad = g.parts.filter((p) => p.watertight === false);
            if (!bad.length) return null;
            return (
              <div className="unplaced">
                <b>
                  {bad.length} part{bad.length > 1 ? 's are' : ' is'} not watertight (not repaired)
                </b>
                <span>Open edges or holes can print badly, and the nesting cannot tell inside from outside reliably.</span>
                <div className="btn-grid two">
                  <button className="btn" onClick={() => setState({ selection: bad.map((p) => `${p.id}#0`), buildPickCopies: false })}>
                    Select {bad.length > 1 ? 'them' : 'it'}
                  </button>
                  <button className="btn primary" onClick={() => repairBuildPartsInPrep(bad.map((p) => p.id))} title="Open them in Mesh prep with the Repair tool; Send to Build afterwards updates them here">
                    Repair in Mesh prep
                  </button>
                </div>
              </div>
            );
          })()}
          <ul className="build-parts">
            {g.parts.map((p) => {
              const st = partStatus(p, g.builds, g.unplaced);
              return (
                <li key={p.id} className={selIds.includes(p.id) ? 'selected' : ''} onClick={(e) => selectBuildPart(p.id, e.ctrlKey || e.metaKey || e.shiftKey)}>
                  <i className="dot" style={{ background: p.color }} />
                  <span className="name" title={p.name}>
                    {p.name}
                  </span>
                  {p.watertight === false && (
                    <span className="badge bad" title="Not watertight: repair it in Mesh prep">
                      !
                    </span>
                  )}
                  {p.breakaway && (
                    <span className="badge" title="Has props to break off: other parts may be nested inside it">
                      props
                    </span>
                  )}
                  {p.group && (
                    <span className="badge group" title="Assembly group: printed in the same orientation as the other parts of the group">
                      {groups.get(p.group)}
                    </span>
                  )}
                  {p.group ? null : p.tilt ? (
                    <span className="badge" title="Own tilt">{p.tilt.angle}°</span>
                  ) : g.autoTilts[p.id] ? (
                    <span className="badge auto" title="Turned or tilted automatically to fit the printer">
                      {g.autoTilts[p.id].angle ? `auto ${g.autoTilts[p.id].angle}°` : `turned ${g.autoTilts[p.id].turn}°`}
                    </span>
                  ) : null}
                  <span className={`where ${st.missing ? 'bad' : ''}`}>{st.missing ? 'too big' : st.where.join(' ')}</span>
                  <button
                    className="icon-btn"
                    title={isHiddenKey(g, p.id) ? 'Hidden — click to show' : 'Hide every copy of this part in the view'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleBuildPartHidden(p.id);
                    }}
                  >
                    {isHiddenKey(g, p.id) ? Icon.eyeOff : Icon.eye}
                  </button>
                  <button
                    className={`icon-btn ${p.lockRotation ? 'on' : ''}`}
                    title={p.lockRotation ? 'Orientation locked: kept as in Mesh prep, only moved — click to unlock' : 'Lock orientation (no flat-face turn, tilt or 90° turns)'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setBuildRotationLock([p.id], !p.lockRotation);
                    }}
                  >
                    {Icon.rotLock}
                  </button>
                  <NumberField value={p.quantity} min={1} max={999} step={1} precision={0} title="Quantity" onChange={(q) => setPartQuantity(p.id, q)} />
                </li>
              );
            })}
          </ul>
        </Section>
        {selIds.length > 1 && (
          <Section
            title={`${selIds.length} parts selected`}
            actions={
              <button className="mini" onClick={() => selIds.forEach((id) => removeBuildPart(id))}>
                Remove
              </button>
            }
          >
            <BreakawayCheck ids={selIds} />
            <CageBox ids={selIds} />
            <div className="btn-grid two">
              <button className="btn" onClick={() => groupBuildParts(selIds)} title="Parts that are assembled together: print them all in the same orientation so the mating faces come out alike">
                Group as assembly
              </button>
              {selIds.some((id) => g.parts.find((p) => p.id === id)?.group) && (
                <button className="btn" onClick={() => ungroupBuildParts(selIds)}>
                  Ungroup
                </button>
              )}
            </div>
            <Hint>Tilt them together under Tilt → Selected on the left. Click empty space in the view to clear the selection.</Hint>
          </Section>
        )}
        {sel && (
          <Section
            title={sel.name}
            actions={
              <button className="mini" onClick={() => removeBuildPart(sel.id)}>
                Remove
              </button>
            }
          >
            <BreakawayCheck ids={[sel.id]} />
            <CageBox ids={[sel.id]} />
            {sel.group ? (
              <>
                <Hint>
                  Assembly group {groups.get(sel.group)} with{' '}
                  {g.parts
                    .filter((p) => p.group === sel.group && p.id !== sel.id)
                    .map((p) => p.name)
                    .join(', ')}
                  : all parts of the group are printed in the orientation of the largest one (they may be turned about Z, which keeps the angle to the layers).
                </Hint>
                <button className="btn" onClick={() => ungroupBuildParts([sel.id])}>
                  Ungroup
                </button>
              </>
            ) : sel.tilt ? (
              <Hint>
                Own tilt {sel.tilt.angle}° (change it under Tilt → Selected on the left).
              </Hint>
            ) : g.autoTilts[sel.id] ? (
              <Hint>
                {g.autoTilts[sel.id].angle
                  ? `Tilted automatically by ${g.autoTilts[sel.id].angle}° (towards ${g.autoTilts[sel.id].azimuth}°) because it did not fit the printer upright.`
                  : `Turned ${g.autoTilts[sel.id].turn}° on the platform (corner to corner) because it did not fit straight.`}
              </Hint>
            ) : (
              <Hint>Uses the tilt for all parts ({g.tilt.angle}°).</Hint>
            )}
          </Section>
        )}
      </div>
    </aside>
  );
}
