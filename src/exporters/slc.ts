/**
 * SLC (3D Systems "StereoLithography Contour") export for SLA / DLP: the
 * parts are sliced into layers and every layer is written as closed contour
 * polylines. Outer boundaries run counter-clockwise, holes clockwise (seen
 * from +Z), units are mm.
 *
 * File layout (little-endian):
 *   header   ASCII keywords ("-SLCVER 2.0 -UNIT MM …"), ended by CR LF 0x1A
 *   reserved 256 bytes
 *   sampling table: count (u8), then per entry min Z, layer thickness,
 *            line width compensation, reserved (4 × f32)
 *   layers:  Z (f32), boundary count (u32), per boundary: vertex count (u32),
 *            gap count (u32), vertices (x, y as f32; the last equals the first)
 *   end:     Z (f32), 0xFFFFFFFF
 */
import type { MeshData } from '../geometry';

export interface SlcOptions {
  /** layer thickness, mm */
  layer: number;
}

export type Contour = Float32Array; // x0, y0, x1, y1, … closed (last point = first)

/**
 * Slice a mesh at the given heights. Each loop is oriented so the material is
 * on its left: counter-clockwise outer boundaries, clockwise holes. Works on
 * unwelded meshes too (segment ends are matched by position).
 */
export function sliceMesh(mesh: MeshData, zs: number[]): Contour[][] {
  const p = mesh.positions, idx = mesh.indices;
  const nt = idx.length / 3;
  // triangles sorted by their lowest point, swept upwards through the layers
  const lo = new Float32Array(nt), hi = new Float32Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = p[idx[t * 3] * 3 + 2], b = p[idx[t * 3 + 1] * 3 + 2], c = p[idx[t * 3 + 2] * 3 + 2];
    lo[t] = Math.min(a, b, c);
    hi[t] = Math.max(a, b, c);
  }
  const order = Array.from({ length: nt }, (_, i) => i).sort((x, y) => lo[x] - lo[y]);
  let next = 0;
  let active: number[] = [];
  const out: Contour[][] = [];
  const v = (i: number, k: number) => p[i * 3 + k];
  for (const z of zs) {
    while (next < nt && lo[order[next]] <= z) active.push(order[next++]);
    active = active.filter((t) => hi[t] >= z);
    // segments: start key → [x0, y0, x1, y1, end key]
    const starts = new Map<string, { x0: number; y0: number; x1: number; y1: number; end: string; used: boolean }>();
    const keyOf = (x: number, y: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`;
    for (const t of active) {
      const ids = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
      // a vertex exactly on the plane counts as above it
      const above = ids.map((i) => v(i, 2) >= z);
      if (above[0] === above[1] && above[1] === above[2]) continue;
      const pts: [number, number][] = [];
      for (let e = 0; e < 3; e++) {
        const i = ids[e], j = ids[(e + 1) % 3];
        if (above[e] === above[(e + 1) % 3]) continue;
        // interpolate from the lower-sorted end so both triangles sharing the edge get the same point
        const [a, b] = v(i, 0) < v(j, 0) || (v(i, 0) === v(j, 0) && (v(i, 1) < v(j, 1) || (v(i, 1) === v(j, 1) && v(i, 2) < v(j, 2)))) ? [i, j] : [j, i];
        const f = (z - v(a, 2)) / (v(b, 2) - v(a, 2));
        pts.push([v(a, 0) + (v(b, 0) - v(a, 0)) * f, v(a, 1) + (v(b, 1) - v(a, 1)) * f]);
      }
      if (pts.length !== 2) continue;
      // orient so the material is on the left: along ẑ × n
      const [i0, i1, i2] = ids;
      const ux = v(i1, 0) - v(i0, 0), uy = v(i1, 1) - v(i0, 1), uz = v(i1, 2) - v(i0, 2);
      const wx = v(i2, 0) - v(i0, 0), wy = v(i2, 1) - v(i0, 1), wz = v(i2, 2) - v(i0, 2);
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz;
      let [s, e] = pts;
      if ((e[0] - s[0]) * -ny + (e[1] - s[1]) * nx < 0) [s, e] = [e, s];
      const ks = keyOf(s[0], s[1]), ke = keyOf(e[0], e[1]);
      if (ks === ke) continue;
      starts.set(ks, { x0: s[0], y0: s[1], x1: e[0], y1: e[1], end: ke, used: false });
    }
    // chain the segments into loops
    const loops: Contour[] = [];
    for (const [k0, seg0] of starts) {
      if (seg0.used) continue;
      const xy: number[] = [seg0.x0, seg0.y0];
      let seg = seg0;
      let guard = starts.size + 1;
      while (seg && !seg.used && guard-- > 0) {
        seg.used = true;
        xy.push(seg.x1, seg.y1);
        if (seg.end === k0) break;
        seg = starts.get(seg.end)!;
      }
      if (xy.length < 8) continue; // fewer than three corners
      // close it (an open chain from a broken mesh is closed straight)
      if (xy[xy.length - 2] !== xy[0] || xy[xy.length - 1] !== xy[1]) xy.push(xy[0], xy[1]);
      loops.push(Float32Array.from(xy));
    }
    out.push(loops);
  }
  return out;
}

function signedVolume(m: MeshData): number {
  const p = m.positions, idx = m.indices;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

function reverseLoop(c: Contour): Contour {
  const out = new Float32Array(c.length);
  for (let i = 0; i < c.length; i += 2) {
    out[c.length - 2 - i] = c[i];
    out[c.length - 1 - i] = c[i + 1];
  }
  return out;
}

/** Write SLC: all meshes sliced together (in their world positions). */
export function exportSLC(meshes: MeshData[], opts: SlcOptions): Uint8Array {
  const t = opts.layer > 0 ? opts.layer : 0.05;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes)
    for (let i = 0; i < m.positions.length; i++) {
      const k = i % 3, x = m.positions[i];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  if (!Number.isFinite(min[0])) throw new Error('Nothing to export');
  // one slice in the middle of every layer
  const n = Math.max(1, Math.ceil((max[2] - min[2]) / t - 1e-6));
  const zs = Array.from({ length: n }, (_, i) => min[2] + (i + 0.5) * t);
  // an inside-out part (all triangles facing in) would come out as holes: turn its loops round
  const perMesh = meshes.map((m) => {
    const layers = sliceMesh(m, zs);
    if (signedVolume(m) >= 0) return layers;
    return layers.map((l) => l.map(reverseLoop));
  });
  const layers = zs.map((_, i) => perMesh.flatMap((s) => s[i]));

  const f = (v: number) => +v.toFixed(4);
  const header = `-SLCVER 2.0 -UNIT MM -TYPE PART -PACKAGE AUTONEST -EXTENTS ${f(min[0])},${f(max[0])} ${f(min[1])},${f(max[1])} ${f(min[2])},${f(max[2])}\r\n\x1a`;
  let size = header.length + 256 + 1 + 16 + 8;
  for (const l of layers) {
    size += 8;
    for (const c of l) size += 8 + c.length * 4;
  }
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;
  for (let i = 0; i < header.length; i++) bytes[o++] = header.charCodeAt(i) & 0xff;
  o += 256; // reserved
  dv.setUint8(o, 1);
  o += 1;
  for (const v of [zs[0], t, 0, 0]) (dv.setFloat32(o, v, true), (o += 4));
  layers.forEach((l, i) => {
    dv.setFloat32(o, zs[i], true);
    dv.setUint32(o + 4, l.length, true);
    o += 8;
    for (const c of l) {
      dv.setUint32(o, c.length / 2, true);
      dv.setUint32(o + 4, 0, true);
      o += 8;
      for (let k = 0; k < c.length; k++) (dv.setFloat32(o, c[k], true), (o += 4));
    }
  });
  dv.setFloat32(o, zs[zs.length - 1] + t, true);
  dv.setUint32(o + 4, 0xffffffff, true);
  return bytes;
}

/** Read an SLC file back (for tests and checks): the layers with their contours. */
export function readSLC(data: Uint8Array): { header: string; layer: number; layers: { z: number; contours: Contour[] }[] } {
  let o = data.indexOf(0x1a);
  const header = new TextDecoder().decode(data.subarray(0, o));
  o += 1 + 256;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = dv.getUint8(o);
  o += 1;
  const layer = dv.getFloat32(o + 4, true);
  o += 16 * count;
  const layers: { z: number; contours: Contour[] }[] = [];
  for (;;) {
    const z = dv.getFloat32(o, true), nb = dv.getUint32(o + 4, true);
    o += 8;
    if (nb === 0xffffffff) break;
    const contours: Contour[] = [];
    for (let b = 0; b < nb; b++) {
      const nv = dv.getUint32(o, true);
      o += 8;
      const c = new Float32Array(nv * 2);
      for (let k = 0; k < nv * 2; k++) (c[k] = dv.getFloat32(o, true), (o += 4));
      contours.push(c);
    }
    layers.push({ z, contours });
  }
  return { header, layer, layers };
}
