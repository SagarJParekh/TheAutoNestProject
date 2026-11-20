/**
 * CLS (Concept Laser slice file, version 0004) export for Concept Laser metal
 * printers (M2, MLab): the parts are sliced into layers and every layer is
 * written as closed contours. Worked out from a file written by Concept Laser's
 * own software (a 20 mm cube) and checked against it byte for byte.
 *
 * File layout (little-endian):
 *   header   ASCII "CONCEPT Laser Slice File version 0004;KEY=value;…" padded
 *            with zeros to 512 bytes: platform size (PSZX, PSZY), offsets
 *            (NIIO, IIOD inner; NOIO, OIOD outer), SLTH, beam compensation
 *            (BCMP), skin thickness (SKTH) and BOUNDS=(x,y,z)::(x,y,z) in mm
 *   layers   "NEW_LAYER" z, 1, 1                       (int32; z in 0.1 µm)
 *            "NEW_BORDER" contours                     the part's contours
 *            "NEW_BORDER" contours                     beam-compensated (BCMP = 0: the same)
 *            "INC_OFFSETS" 0, 1
 *            "NEW_BORDER" contours                     the outer offset (NOIO = 1, OIOD = 0: the same)
 *            "NEW_QUADRANT" 0, width, 0, depth         (0.1 µm) the platform
 *            "NEW_SKIN" 0, "NEW_CORE" 0                no skin / core areas
 *            "SUPPORT" "NEW_BORDER" contours           the support contours
 *   contours count (int32), then per contour: 1 (byte), point count (int32),
 *            points (x, y as int32 in 0.1 µm, the first point not repeated)
 *
 * Coordinates are platform coordinates (0 … platform size, origin at a corner),
 * layers are labelled with the height of their bottom (0, 0.05, …) and sliced
 * in their middle. Outer contours run clockwise (as in the reference file),
 * holes counter-clockwise.
 */
import type { MeshData } from '../geometry';
import { sliceMesh, type Contour } from './slc';

export interface ClsOptions {
  /** layer thickness, mm */
  layer: number;
  /** platform size (x, y), mm */
  plate: [number, number];
  /** added to x, y to turn the app's coordinates (platform centre at 0, 0) into platform coordinates */
  shift: [number, number];
}

const UNIT = 1e4; // 0.1 µm per mm

function signedVolume(m: MeshData): number {
  const p = m.positions, idx = m.indices;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/**
 * A sliced loop (counter-clockwise outer, last point = first) as CLS points:
 * clockwise outer, in 0.1 µm, not closed, without repeated points or points in
 * the middle of a straight run (a cube's side is two triangles, its slice two
 * segments; Concept Laser writes the corners only).
 */
function toCls(c: Contour, shift: [number, number], flip: boolean): Int32Array {
  const n = c.length / 2 - 1; // drop the repeated last point
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < n; i++) {
    // reversed: the slicer's counter-clockwise outer loops become clockwise (unless the mesh is inside out)
    const j = flip ? i : n - 1 - i;
    const x = Math.round((c[j * 2] + shift[0]) * UNIT), y = Math.round((c[j * 2 + 1] + shift[1]) * UNIT);
    if (xs.length && x === xs[xs.length - 1] && y === ys[ys.length - 1]) continue;
    xs.push(x);
    ys.push(y);
  }
  while (xs.length > 1 && xs[0] === xs[xs.length - 1] && ys[0] === ys[ys.length - 1]) (xs.pop(), ys.pop());
  // drop points on a straight run (within half a unit of the line through their neighbours, going on the same way)
  for (let changed = true; changed && xs.length > 3; ) {
    changed = false;
    for (let i = 0; i < xs.length && xs.length > 3; i++) {
      const a = (i + xs.length - 1) % xs.length, b = (i + 1) % xs.length;
      const ux = xs[i] - xs[a], uy = ys[i] - ys[a], vx = xs[b] - xs[i], vy = ys[b] - ys[i];
      const len = Math.hypot(xs[b] - xs[a], ys[b] - ys[a]);
      if (ux * vx + uy * vy > 0 && len > 0 && Math.abs(ux * vy - uy * vx) / len <= 0.5) {
        xs.splice(i, 1);
        ys.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  // start at the lowest point (the rightmost of those), as Concept Laser's own files do
  let s0 = 0;
  for (let i = 1; i < xs.length; i++) if (ys[i] < ys[s0] || (ys[i] === ys[s0] && xs[i] > xs[s0])) s0 = i;
  const out = new Int32Array(xs.length * 2);
  for (let i = 0; i < xs.length; i++) {
    const k = (s0 + i) % xs.length;
    out[i * 2] = xs[k];
    out[i * 2 + 1] = ys[k];
  }
  return out;
}

/**
 * Write CLS: `parts` as the part contours and `supports` in the support section,
 * all in their build positions, sliced together on one layer grid from the platform up.
 */
export function exportCLS(parts: MeshData[], supports: MeshData[], opts: ClsOptions): Uint8Array {
  const t = opts.layer > 0 ? opts.layer : 0.05;
  const all = [...parts, ...supports];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of all)
    for (let i = 0; i < m.positions.length; i++) {
      const k = i % 3, x = m.positions[i];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  if (!Number.isFinite(min[0])) throw new Error('Nothing to export');
  // layers on one grid from the platform (z = 0), so the files of one build line up
  const k0 = Math.max(0, Math.floor(min[2] / t + 1e-6)), k1 = Math.max(k0 + 1, Math.ceil(max[2] / t - 1e-6));
  const zs = Array.from({ length: k1 - k0 }, (_, i) => (k0 + i + 0.5) * t);
  const slice = (ms: MeshData[]) => {
    const per = ms.map((m) => ({ layers: sliceMesh(m, zs), flip: signedVolume(m) < 0 }));
    return zs.map((_, i) => per.flatMap((s) => s.layers[i].filter((c) => c.length >= 6).map((c) => toCls(c, opts.shift, s.flip)).filter((c) => c.length >= 4)));
  };
  const partLayers = slice(parts), supportLayers = slice(supports);

  const f3 = (v: number) => v.toFixed(3);
  const sx = opts.shift[0], sy = opts.shift[1];
  const header =
    `CONCEPT Laser Slice File version 0004;PSZX=${f3(opts.plate[0])};PSZY=${f3(opts.plate[1])};NIIO=0;IIOD=0.000;NOIO=1;OIOD=0.000;SLTH=-0.000;BCMP=0.000;SKTH=INF;` +
    `BOUNDS=(${f3(min[0] + sx)},${f3(min[1] + sy)},${f3(min[2])})::(${f3(max[0] + sx)},${f3(max[1] + sy)},${f3(max[2])});`;
  if (header.length > 512) throw new Error('CLS header too long');

  const tag = (s: string) => s.length;
  const borderSize = (cs: Int32Array[]) => tag('NEW_BORDER') + 4 + cs.reduce((n, c) => n + 1 + 4 + c.length * 4, 0);
  let size = 512;
  zs.forEach((_, i) => {
    const b = borderSize(partLayers[i]);
    size += tag('NEW_LAYER') + 12 + 3 * b + tag('INC_OFFSETS') + 8 + tag('NEW_QUADRANT') + 16 + tag('NEW_SKIN') + 4 + tag('NEW_CORE') + 4 + tag('SUPPORT') + borderSize(supportLayers[i]);
  });
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf), bytes = new Uint8Array(buf);
  let o = 0;
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0xff;
  o = 512;
  const word = (s: string) => {
    for (let i = 0; i < s.length; i++) bytes[o++] = s.charCodeAt(i);
  };
  const int = (v: number) => {
    dv.setInt32(o, v, true);
    o += 4;
  };
  const border = (cs: Int32Array[]) => {
    word('NEW_BORDER');
    int(cs.length);
    for (const c of cs) {
      bytes[o++] = 1;
      int(c.length / 2);
      for (let k = 0; k < c.length; k++) int(c[k]);
    }
  };
  const W = Math.round(opts.plate[0] * UNIT), D = Math.round(opts.plate[1] * UNIT);
  zs.forEach((_, i) => {
    word('NEW_LAYER');
    int(Math.round((k0 + i) * t * UNIT));
    int(1);
    int(1);
    border(partLayers[i]);
    border(partLayers[i]);
    word('INC_OFFSETS');
    int(0);
    int(1);
    border(partLayers[i]);
    word('NEW_QUADRANT');
    int(0);
    int(W);
    int(0);
    int(D);
    word('NEW_SKIN');
    int(0);
    word('NEW_CORE');
    int(0);
    word('SUPPORT');
    border(supportLayers[i]);
  });
  if (o !== size) throw new Error(`CLS size mismatch (${o} of ${size})`);
  return bytes;
}

/** Read a CLS file (for tests and checks): the header and, per layer, its z (mm) and part and support contours (mm, platform coordinates). */
export function readCLS(data: Uint8Array): { header: string; layers: { z: number; parts: Float64Array[]; supports: Float64Array[]; raw: number[] }[] } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = 0;
  while (end < 512 && data[end] !== 0) end++;
  const header = String.fromCharCode(...data.subarray(0, end));
  let o = 512;
  const at = (s: string) => {
    for (let i = 0; i < s.length; i++) if (data[o + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  const expect = (s: string) => {
    if (!at(s)) throw new Error(`CLS: expected ${s} at byte ${o}`);
    o += s.length;
  };
  const int = () => {
    const v = dv.getInt32(o, true);
    o += 4;
    return v;
  };
  const border = () => {
    expect('NEW_BORDER');
    const n = int(), cs: Float64Array[] = [];
    for (let c = 0; c < n; c++) {
      if (data[o++] !== 1) throw new Error('CLS: contour flag is not 1');
      const m = int(), pts = new Float64Array(m * 2);
      for (let k = 0; k < m * 2; k++) pts[k] = int() / UNIT;
      cs.push(pts);
    }
    return cs;
  };
  const layers: { z: number; parts: Float64Array[]; supports: Float64Array[]; raw: number[] }[] = [];
  while (o < data.length) {
    expect('NEW_LAYER');
    const z = int() / UNIT, raw = [int(), int()];
    const parts = border();
    border();
    expect('INC_OFFSETS');
    raw.push(int(), int());
    border();
    expect('NEW_QUADRANT');
    raw.push(int(), int(), int(), int());
    expect('NEW_SKIN');
    raw.push(int());
    expect('NEW_CORE');
    raw.push(int());
    expect('SUPPORT');
    layers.push({ z, parts, supports: border(), raw });
  }
  return { header, layers };
}
