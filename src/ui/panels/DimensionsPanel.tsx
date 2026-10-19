import { Check, Hint, Section } from '../controls';
import { getState, setState, useStore } from '../../state/store';
import { meshEntry } from '../../state/meshCache';
import { partShellsLabel, usePartStats } from './dimensionsData';
import type { Part } from '../../state/types';

const f = (v: number, d = 2) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

function DimToggles() {
  const d = useStore((s) => s.settings.dimensions);
  const set = (patch: Partial<typeof d>) => setState({ settings: { ...getState().settings, dimensions: { ...getState().settings.dimensions, ...patch } } });
  return (
    <Section title="Show on the part">
      <div className="btn-row">
        <Check checked={d.showDims} onChange={(showDims) => set({ showDims })}>
          Dimensions
        </Check>
        <Check checked={d.showName} onChange={(showName) => set({ showName })}>
          Part name
        </Check>
        <Check checked={d.showPath} onChange={(showPath) => set({ showPath })}>
          Part path
        </Check>
      </div>
    </Section>
  );
}

export function DimensionsPanel({ parts }: { parts: Part[] }) {
  useStore((s) => s.meshInfoVersion);
  if (!parts.length)
    return (
      <Section title="Dimensions">
        <Hint>Select a part to see its bounding box and dimensions on the part, and all its information here.</Hint>
      </Section>
    );
  return (
    <>
      <DimToggles />
      {parts.length > 1 && <Combined parts={parts} />}
      {parts.map((p) => (
        <PartDims key={p.id} part={p} />
      ))}
    </>
  );
}

function Combined({ parts }: { parts: Part[] }) {
  const all = parts.map((p) => usePartStats(p));
  const min = [0, 1, 2].map((k) => Math.min(...all.map((m) => m.bounds.min[k])));
  const max = [0, 1, 2].map((k) => Math.max(...all.map((m) => m.bounds.max[k])));
  const vol = all.reduce((a, m) => a + Math.abs(m.volume), 0);
  const tris = all.reduce((a, m) => a + m.triangles, 0);
  return (
    <Section title={`${parts.length} parts together`}>
      <div className="dim-big">
        <span><b>X</b> {f(max[0] - min[0])}</span>
        <span><b>Y</b> {f(max[1] - min[1])}</span>
        <span><b>Z</b> {f(max[2] - min[2])}</span>
        <em>mm</em>
      </div>
      <dl className="info">
        <dt>Total volume</dt>
        <dd>{f(vol)} mm³</dd>
        <dt>Triangles</dt>
        <dd>{tris.toLocaleString()}</dd>
      </dl>
    </Section>
  );
}

function PartDims({ part }: { part: Part }) {
  const m = usePartStats(part);
  const wt = meshEntry(part.mesh).watertight;
  const t = part.transform;
  const c = [0, 1, 2].map((k) => (m.bounds.min[k] + m.bounds.max[k]) / 2);
  const boxVol = m.size[0] * m.size[1] * m.size[2];
  return (
    <Section title={part.name}>
      <div className="dim-big">
        <span><b>X</b> {f(m.size[0])}</span>
        <span><b>Y</b> {f(m.size[1])}</span>
        <span><b>Z</b> {f(m.size[2])}</span>
        <em>mm</em>
      </div>
      <dl className="info">
        <dt>Part name</dt>
        <dd>{part.name}</dd>
        <dt title="Browsers only reveal the file name, plus the folder path when a folder was dropped or chosen">File / path</dt>
        <dd className="path">{part.sourcePath ?? part.source ?? '—'}</dd>
        {part.importedAt && (
          <>
            <dt>Imported</dt>
            <dd>{new Date(part.importedAt).toLocaleString()}</dd>
          </>
        )}
        <dt>Min</dt>
        <dd>{m.bounds.min.map((v) => f(v)).join(', ')}</dd>
        <dt>Max</dt>
        <dd>{m.bounds.max.map((v) => f(v)).join(', ')}</dd>
        <dt>Centre</dt>
        <dd>{c.map((v) => f(v)).join(', ')}</dd>
        <dt>Volume</dt>
        <dd>
          {f(Math.abs(m.volume))} mm³{m.volume < 0 ? ' (inside-out)' : ''}
          <br />
          <span className="muted">{f(Math.abs(m.volume) / 1000, 3)} cm³</span>
        </dd>
        <dt>Surface area</dt>
        <dd>
          {f(m.area)} mm²
          <br />
          <span className="muted">{f(m.area / 100, 2)} cm²</span>
        </dd>
        <dt>Bounding box</dt>
        <dd>{f(boxVol)} mm³ ({boxVol > 0 ? f((Math.abs(m.volume) / boxVol) * 100, 1) : '0'}% filled)</dd>
        <dt>Triangles</dt>
        <dd>{m.triangles.toLocaleString()}</dd>
        <dt>Vertices</dt>
        <dd>{m.vertices.toLocaleString()}</dd>
        <dt>Shells</dt>
        <dd>{partShellsLabel(part)}</dd>
        <dt>Watertight</dt>
        <dd>
          {wt === undefined ? <span className="muted">checking…</span> : wt ? <span className="badge ok">yes</span> : <span className="badge bad">no</span>}
        </dd>
        <dt>Position</dt>
        <dd>{t.position.map((v) => f(v)).join(', ')}</dd>
        <dt>Rotation</dt>
        <dd>{t.rotation.map((v) => f(v, 1)).join('°, ')}°</dd>
        <dt>Scale</dt>
        <dd>{t.scale.map((v) => f(v * 100, 1)).join('%, ')}%</dd>
        {part.source && (
          <>
            <dt>Source</dt>
            <dd className="ellipsis" title={part.source}>
              {part.source}
            </dd>
          </>
        )}
      </dl>
    </Section>
  );
}
