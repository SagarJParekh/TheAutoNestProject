import type { ImportedBody, LoaderModule } from './types';
import { ImportError } from './types';
import { decodeText } from './text';

function isBinary(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 84) return false;
  const n = new DataView(buf).getUint32(80, true);
  if (84 + n * 50 === buf.byteLength) return true;
  const head = decodeText(new Uint8Array(buf, 0, Math.min(buf.byteLength, 512))).trimStart();
  if (!head.toLowerCase().startsWith('solid')) return true;
  // "solid" header but binary content: look for "facet" in the first KB
  const probe = decodeText(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024)));
  return !/facet/i.test(probe);
}

export function parseBinarySTL(buf: ArrayBuffer, name: string): ImportedBody {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  if (84 + n * 50 > buf.byteLength) throw new ImportError('Binary STL is truncated');
  const positions = new Float32Array(n * 9);
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12; // skip normal
    for (let k = 0; k < 9; k++) {
      positions[i * 9 + k] = dv.getFloat32(o, true);
      o += 4;
    }
    o += 2;
  }
  return { name, positions };
}

export function parseAsciiSTL(text: string, fallbackName: string): ImportedBody[] {
  const bodies: ImportedBody[] = [];
  const solidRe = /solid\s*([^\r\n]*)([\s\S]*?)endsolid/gi;
  const vRe = /vertex\s+([-+0-9.eEinfINF]+)\s+([-+0-9.eEinfINF]+)\s+([-+0-9.eEinfINF]+)/g;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = solidRe.exec(text))) {
    any = true;
    const coords: number[] = [];
    let v: RegExpExecArray | null;
    vRe.lastIndex = 0;
    while ((v = vRe.exec(m[2]))) coords.push(+v[1], +v[2], +v[3]);
    if (coords.length % 9 !== 0) throw new ImportError('ASCII STL has an incomplete facet');
    const nm = m[1].trim() || fallbackName;
    if (coords.length) bodies.push({ name: nm, positions: Float32Array.from(coords) });
  }
  if (!any) {
    // tolerate missing endsolid
    const coords: number[] = [];
    let v: RegExpExecArray | null;
    while ((v = vRe.exec(text))) coords.push(+v[1], +v[2], +v[3]);
    if (coords.length >= 9) bodies.push({ name: fallbackName, positions: Float32Array.from(coords.slice(0, coords.length - (coords.length % 9))) });
  }
  return bodies;
}

export const stlLoader: LoaderModule = {
  id: 'stl',
  label: 'STL',
  extensions: ['stl'],
  async load(buffer, ctx) {
    const base = ctx.fileName.replace(/\.[^.]+$/, '');
    const bodies = isBinary(buffer) ? [parseBinarySTL(buffer, base)] : parseAsciiSTL(decodeText(buffer), base);
    if (bodies.length === 0 || bodies.every((b) => b.positions.length === 0)) throw new ImportError('STL contains no triangles');
    return bodies;
  },
};
