import type { LoaderModule } from './types';
import { ImportError } from './types';
import { decodeText } from './text';

/** Object File Format (OFF / COFF / NOFF). Polygons are fan-triangulated; colours ignored. */
export const offLoader: LoaderModule = {
  id: 'off',
  label: 'Object File Format',
  extensions: ['off'],
  async load(buffer, ctx) {
    const lines = decodeText(buffer)
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*/, '').trim())
      .filter(Boolean);
    if (!lines.length) throw new ImportError('Empty OFF file');
    let first = lines[0].split(/\s+/);
    const header = first[0];
    if (!/^(ST)?C?N?4?OFF$/i.test(header)) throw new ImportError('Not an OFF file (missing OFF header)');
    let li = 1;
    let counts = first.slice(1);
    if (counts.length < 2) {
      first = lines[li++]?.split(/\s+/) ?? [];
      counts = first;
    }
    const nv = parseInt(counts[0], 10), nf = parseInt(counts[1], 10);
    if (!(nv >= 0 && nf >= 0)) throw new ImportError('Invalid OFF header counts');
    if (lines.length < li + nv + nf) throw new ImportError('OFF file is truncated');
    const positions = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const p = lines[li++].split(/\s+/);
      positions[v * 3] = +p[0];
      positions[v * 3 + 1] = +p[1];
      positions[v * 3 + 2] = +p[2];
    }
    const idx: number[] = [];
    for (let f = 0; f < nf; f++) {
      const p = lines[li++].split(/\s+/).map((s) => parseInt(s, 10));
      const k = p[0];
      for (let j = 2; j < k; j++) idx.push(p[1], p[j], p[j + 1]);
    }
    if (idx.some((v) => !(v >= 0 && v < nv))) throw new ImportError('OFF face index out of range');
    return [{ name: ctx.fileName.replace(/\.[^.]+$/, ''), positions, indices: Uint32Array.from(idx) }];
  },
};
