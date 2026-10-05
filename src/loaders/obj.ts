import type { ImportedBody, LoaderModule } from './types';
import { ImportError } from './types';
import { decodeText } from './text';

/** Wavefront OBJ. Each `o` object becomes a separate body; polygons are fan-triangulated. */
export function parseOBJ(text: string, fallbackName: string): ImportedBody[] {
  const verts: number[] = [];
  const bodies: { name: string; idx: number[] }[] = [];
  let cur: { name: string; idx: number[] } | null = null;
  const lines = text.split(/\r?\n/);
  const face: number[] = [];
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    while (line.endsWith('\\') && li + 1 < lines.length) line = line.slice(0, -1) + ' ' + lines[++li];
    const t = line.trim();
    if (t.length < 2 || t[0] === '#') continue;
    const c0 = t[0], c1 = t[1];
    if (c0 === 'v' && (c1 === ' ' || c1 === '\t')) {
      const p = t.split(/\s+/);
      verts.push(+p[1], +p[2], +p[3]);
    } else if (c0 === 'f' && (c1 === ' ' || c1 === '\t')) {
      if (!cur) bodies.push((cur = { name: fallbackName, idx: [] }));
      const p = t.split(/\s+/);
      face.length = 0;
      const nv = verts.length / 3;
      for (let i = 1; i < p.length; i++) {
        if (!p[i]) continue;
        let v = parseInt(p[i], 10);
        if (Number.isNaN(v)) continue;
        v = v < 0 ? nv + v : v - 1;
        if (v < 0 || v >= nv) throw new ImportError(`OBJ face references missing vertex on line ${li + 1}`);
        face.push(v);
      }
      for (let i = 1; i + 1 < face.length; i++) cur.idx.push(face[0], face[i], face[i + 1]);
    } else if (c0 === 'o' && (c1 === ' ' || c1 === '\t')) {
      const name = t.slice(2).trim() || fallbackName;
      if (cur && cur.idx.length === 0) cur.name = name;
      else bodies.push((cur = { name, idx: [] }));
    }
  }
  const positions = Float32Array.from(verts);
  return bodies
    .filter((b) => b.idx.length)
    .map((b) => ({ name: b.name, positions, indices: Uint32Array.from(b.idx) }));
}

export const objLoader: LoaderModule = {
  id: 'obj',
  label: 'Wavefront OBJ',
  extensions: ['obj'],
  async load(buffer, ctx) {
    const bodies = parseOBJ(decodeText(buffer), ctx.fileName.replace(/\.[^.]+$/, ''));
    if (!bodies.length) throw new ImportError('OBJ contains no faces');
    return bodies;
  },
};
