import { useMemo } from 'react';
import { measureMesh } from '../../geometry/measure';
import { Section } from '../controls';
import { useStore } from '../../state/store';
import { matrixOf } from '../../state/math';
import { meshEntry } from '../../state/meshCache';
import type { Part } from '../../state/types';

const f = (v: number, d = 2) => v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

export function InfoPanel({ parts }: { parts: Part[] }) {
  useStore((s) => s.meshInfoVersion);
  if (parts.length === 1) return <SingleInfo part={parts[0]} />;
  const tris = parts.reduce((a, p) => a + p.mesh.indices.length / 3, 0);
  return (
    <Section title={`${parts.length} parts selected`}>
      <dl className="info">
        <dt>Triangles</dt>
        <dd>{tris.toLocaleString()}</dd>
      </dl>
    </Section>
  );
}

function SingleInfo({ part }: { part: Part }) {
  const m = useMemo(() => measureMesh(part.mesh, matrixOf(part.transform).elements), [part.mesh, part.transform]);
  const wt = meshEntry(part.mesh).watertight;
  return (
    <Section title="Info">
      <dl className="info">
        <dt>Size</dt>
        <dd>
          {f(m.size[0])} × {f(m.size[1])} × {f(m.size[2])} mm
        </dd>
        <dt>Min</dt>
        <dd>
          {f(m.bounds.min[0])}, {f(m.bounds.min[1])}, {f(m.bounds.min[2])}
        </dd>
        <dt>Triangles</dt>
        <dd>{m.triangles.toLocaleString()}</dd>
        <dt>Volume</dt>
        <dd>
          {f(Math.abs(m.volume) / 1000, 3)} cm³{m.volume < 0 ? ' (inside-out)' : ''}
        </dd>
        <dt>Surface</dt>
        <dd>{f(m.area / 100, 2)} cm²</dd>
        <dt>Watertight</dt>
        <dd>
          {wt === undefined ? (
            <span className="muted">checking…</span>
          ) : wt ? (
            <span className="badge ok">yes</span>
          ) : (
            <span className="badge bad">no</span>
          )}
        </dd>
      </dl>
    </Section>
  );
}
