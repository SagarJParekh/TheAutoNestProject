import { useRef, useState } from 'react';
import { Check, Hint, NumberField, Row, Section, Segmented } from '../controls';
import { useStore } from '../../state/store';
import { importFiles } from '../../state/actions';
import {
  addPartsFromPrep, clearBuildParts, currentPrinter, exportBuilds, openBuildInPrep, partOfKey, removeBuildPart, setActiveBuild, setPartQuantity,
  setPartTilt, updateBuildSettings,
} from '../../state/buildActions';
import { PRINTERS, TECHNOLOGIES, printerById, type Technology } from '../../state/printers';
import { importableExtensions } from '../../loaders/registry';
import type { BuildPart, Tilt } from '../../state/types';

const f1 = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });

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
          <Hint>Builds are created automatically as soon as files are added; you can also drop files on the window.</Hint>
        </Section>
        <Section title="Printer">
          <div className="printer-tree">
            {TECHNOLOGIES.map((t) => (
              <div key={t.id} className={`tech ${open === t.id ? 'open' : ''}`}>
                <button className="tech-head" onClick={() => setOpen(open === t.id ? (null as never) : t.id)}>
                  <span className="caret">{open === t.id ? '▾' : '▸'}</span>
                  {t.label}
                  {printer.tech === t.id && <span className="tech-current">{printer.name}</span>}
                </button>
                {open === t.id && (
                  <ul>
                    {PRINTERS.filter((p) => p.tech === t.id).map((p) => (
                      <li key={p.id}>
                        <label className={g.printerId === p.id ? 'active' : ''}>
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
          <Row label="Clearance between parts">
            <NumberField value={g.gap} min={0} step={0.5} suffix="mm" onChange={(gap) => updateBuildSettings({ gap })} />
          </Row>
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
            Largest flat face down
          </Check>
          <Check checked={g.allowRotate} onChange={(allowRotate) => updateBuildSettings({ allowRotate })}>
            Allow turning parts 90° to fit
          </Check>
          {printer.tech === 'powder' && (
            <Check checked={g.stack} onChange={(stack) => updateBuildSettings({ stack })}>
              Stack parts in Z (powder bed)
            </Check>
          )}
          <Hint>
            Each build is filled completely before a new one is started. Parts are placed tallest first, so similar heights end up together; when
            everything fits on one platform it stays one build. Parts that do not fit are tilted (smallest angle first) until they do.
          </Hint>
        </Section>
        <Section title="Tilt (all parts)">
          <TiltControls tilt={g.tilt} onChange={(tilt) => updateBuildSettings({ tilt })} />
          <Hint>Parts can also be tilted one by one in the parts list. A part that no longer fits after tilting moves to another build.</Hint>
        </Section>
      </div>
    </aside>
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
  const selectedPart = selection.length ? partOfKey(selection[0]) : null;
  const sel = g.parts.find((p) => p.id === selectedPart) ?? null;
  const active = g.builds[g.active];
  const total = g.parts.reduce((a, p) => a + p.quantity, 0);
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
          {active && (
            <div className="btn-grid two">
              <button className="btn primary" onClick={() => exportBuilds(g.active, '3mf')}>
                Export {active.name} (3MF)
              </button>
              <button className="btn" onClick={() => exportBuilds(g.active, 'stl')}>
                STL
              </button>
              <button className="btn" onClick={() => openBuildInPrep(g.active)} title="Copy this build's parts, placed, into Mesh prep">
                Open in Mesh prep
              </button>
            </div>
          )}
        </Section>
        <Section
          title={`Parts (${g.parts.length})`}
          actions={
            g.parts.length > 0 && (
              <button className="mini" onClick={clearBuildParts}>
                Clear
              </button>
            )
          }
        >
          {!g.parts.length && <Hint>Add files or take parts from Mesh prep.</Hint>}
          <ul className="build-parts">
            {g.parts.map((p) => {
              const st = partStatus(p, g.builds, g.unplaced);
              return (
                <li key={p.id} className={sel?.id === p.id ? 'selected' : ''} onClick={() => useStore.setState({ selection: [`${p.id}#0`] })}>
                  <i className="dot" style={{ background: p.color }} />
                  <span className="name" title={p.name}>
                    {p.name}
                  </span>
                  {p.tilt ? (
                    <span className="badge" title="Own tilt">{p.tilt.angle}°</span>
                  ) : g.autoTilts[p.id] ? (
                    <span className="badge auto" title="Turned or tilted automatically to fit the printer">
                      {g.autoTilts[p.id].angle ? `auto ${g.autoTilts[p.id].angle}°` : `turned ${g.autoTilts[p.id].turn}°`}
                    </span>
                  ) : null}
                  <span className={`where ${st.missing ? 'bad' : ''}`}>{st.missing ? 'too big' : st.where.join(' ')}</span>
                  <NumberField value={p.quantity} min={1} max={999} step={1} precision={0} title="Quantity" onChange={(q) => setPartQuantity(p.id, q)} />
                </li>
              );
            })}
          </ul>
        </Section>
        {sel && (
          <Section
            title={sel.name}
            actions={
              <button className="mini" onClick={() => removeBuildPart(sel.id)}>
                Remove
              </button>
            }
          >
            <Check checked={!!sel.tilt} onChange={(own) => setPartTilt(sel.id, own ? { ...g.tilt, angle: g.tilt.angle || 15 } : null)}>
              Own tilt for this part
            </Check>
            {sel.tilt ? (
              <TiltControls tilt={sel.tilt} onChange={(t) => setPartTilt(sel.id, t)} />
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
