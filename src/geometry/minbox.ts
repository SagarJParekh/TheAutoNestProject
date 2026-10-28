/**
 * Smallest-volume box around a part (oriented bounding box). The best box
 * has a face flush with a face of the convex hull, so every hull face
 * direction is tried as the box's third axis; in that direction the part's
 * outline gets its smallest-area rectangle (rotating calipers). The box axes
 * are returned longest first, so turning the part onto them puts the longest
 * side along X and the shortest along Z.
 */
import type { Manifold } from 'manifold-3d';
import { MeshData, Vec3, computeBounds } from './mesh';
import { getManifold, fromManifold } from './manifold';
import { planeBasis } from './triangulate';

export interface MinBox {
  /** box axes (unit, right-handed), longest side first */
  axes: [Vec3, Vec3, Vec3];
  /** side lengths along the axes, mm */
  size: Vec3;
  /** box centre (world) */
  center: Vec3;
  volume: number;
  /** volume of the current axis-aligned box, for comparison */
  aabbVolume: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** 2D convex hull (monotone chain), counter-clockwise. */
function hull2d(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const turn = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], hi: [number, number][] = [];
  for (const q of p) {
    while (lo.length >= 2 && turn(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (hi.length >= 2 && turn(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

/** Smallest-area rectangle around 2D points: its first axis (unit) and both side lengths. */
function minRect(pts: [number, number][]): { axis: [number, number]; w: number; h: number; c: [number, number] } {
  const h = hull2d(pts);
  let best = { area: Infinity, axis: [1, 0] as [number, number], w: 0, h: 0, c: [0, 0] as [number, number] };
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-12) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of h) {
      const rx = x * ux + y * uy, ry = -x * uy + y * ux;
      if (rx < x0) x0 = rx;
      if (rx > x1) x1 = rx;
      if (ry < y0) y0 = ry;
      if (ry > y1) y1 = ry;
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < best.area - 1e-12) {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      best = { area, axis: [ux, uy], w: x1 - x0, h: y1 - y0, c: [cx * ux - cy * uy, cx * uy + cy * ux] };
    }
  }
  return best;
}

export async function minimumBox(mesh: MeshData): Promise<MinBox> {
  const b = computeBounds(mesh.positions);
  const aabbVolume = (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
  // convex hull of the vertices, from one vertex per cell of a 128-cell grid so even meshes of
  // millions of triangles stay quick; the final sizes are measured on every vertex
  const p = mesh.positions;
  const G = 64;
  const ext = [0, 1, 2].map((k) => Math.max(b.max[k] - b.min[k], 1e-9));
  const seen = new Uint8Array(G * G * G);
  const pts: Vec3[] = [];
  for (let i = 0; i < p.length; i += 3) {
    const ix = Math.min(G - 1, ((p[i] - b.min[0]) / ext[0]) * G) | 0;
    const iy = Math.min(G - 1, ((p[i + 1] - b.min[1]) / ext[1]) * G) | 0;
    const iz = Math.min(G - 1, ((p[i + 2] - b.min[2]) / ext[2]) * G) | 0;
    const k = ix + G * (iy + G * iz);
    if (seen[k]) continue;
    seen[k] = 1;
    pts.push([p[i], p[i + 1], p[i + 2]]);
  }
  if (pts.length < 4) throw new Error('The part is too small or flat to measure');
  const wasm = await getManifold();
  let hullM: Manifold | null = null;
  let hull: MeshData;
  try {
    hullM = wasm.Manifold.hull(pts);
    hull = fromManifold(hullM);
  } finally {
    hullM?.delete();
  }
  const hp = hull.positions, hi = hull.indices;
  const verts: Vec3[] = [];
  for (let i = 0; i < hp.length; i += 3) verts.push([hp[i], hp[i + 1], hp[i + 2]]);
  // candidate directions: hull face normals merged within about a degree, the ones covering the
  // most hull area first (smooth curved parts have tens of thousands), plus X / Y / Z
  const dirs = new Map<string, { n: Vec3; area: number }>();
  const add = (n: Vec3, area: number) => {
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-12) return;
    let u: Vec3 = [n[0] / l, n[1] / l, n[2] / l];
    // n and −n give the same box
    if (u[2] < 0 || (u[2] === 0 && (u[1] < 0 || (u[1] === 0 && u[0] < 0)))) u = [-u[0], -u[1], -u[2]];
    const key = u.map((x) => Math.round(x * 60)).join();
    const d = dirs.get(key);
    if (d) d.area += area;
    else dirs.set(key, { n: u, area });
  };
  for (let t = 0; t < hi.length; t += 3) {
    const a = verts[hi[t]], bb = verts[hi[t + 1]], c = verts[hi[t + 2]];
    const n = cross([bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    add(n, Math.hypot(n[0], n[1], n[2]));
  }
  const candidates = [...dirs.values()].sort((x, y) => y.area - x.area).slice(0, 300).map((d) => d.n);
  candidates.push([1, 0, 0], [0, 1, 0], [0, 0, 1]);
  type Box = { vol: number; axes: [Vec3, Vec3, Vec3]; size: Vec3; center: Vec3 };
  const evaluate = (n: Vec3): Box => {
    const { u, v } = planeBasis(n);
    let lo = Infinity, up = -Infinity;
    const xy: [number, number][] = verts.map((pt) => {
      const d = dot(pt, n);
      if (d < lo) lo = d;
      if (d > up) up = d;
      return [dot(pt, u), dot(pt, v)];
    });
    const r = minRect(xy);
    const a: Vec3 = [u[0] * r.axis[0] + v[0] * r.axis[1], u[1] * r.axis[0] + v[1] * r.axis[1], u[2] * r.axis[0] + v[2] * r.axis[1]];
    const mid = (lo + up) / 2;
    const center: Vec3 = [0, 1, 2].map((k) => u[k] * r.c[0] + v[k] * r.c[1] + n[k] * mid) as Vec3;
    return { vol: r.w * r.h * (up - lo), axes: [a, cross(n, a), n], size: [r.w, r.h, up - lo], center };
  };
  let best: Box | null = null;
  for (const n of candidates) {
    const b0 = evaluate(n);
    if (!best || b0.vol < best.vol) best = b0;
  }
  // fine-tune: tilt the best direction a little each way while that makes the box smaller
  for (const deg of [3, 1.5, 0.75, 0.35, 0.15]) {
    const t = (deg * Math.PI) / 180;
    for (let improved = true, guard = 0; improved && guard < 20; guard++) {
      improved = false;
      const n = best!.axes[2], { u, v } = planeBasis(n);
      for (const [a, b2] of [[t, 0], [-t, 0], [0, t], [0, -t]]) {
        const m: Vec3 = [0, 1, 2].map((k) => n[k] * Math.cos(Math.hypot(a, b2)) + (u[k] * a + v[k] * b2)) as Vec3;
        const l = Math.hypot(m[0], m[1], m[2]);
        const c = evaluate([m[0] / l, m[1] / l, m[2] / l]);
        if (c.vol < best!.vol - 1e-9) {
          best = c;
          improved = true;
        }
      }
    }
  }
  const B = best!;
  // exact extents along the chosen axes, over every vertex
  const eLo = [Infinity, Infinity, Infinity], eHi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const ax = B.axes[k];
      const d = p[i] * ax[0] + p[i + 1] * ax[1] + p[i + 2] * ax[2];
      if (d < eLo[k]) eLo[k] = d;
      if (d > eHi[k]) eHi[k] = d;
    }
  }
  const size = [0, 1, 2].map((k) => eHi[k] - eLo[k]) as Vec3;
  const mid = [0, 1, 2].map((k) => (eLo[k] + eHi[k]) / 2);
  const center = [0, 1, 2].map((c) => B.axes[0][c] * mid[0] + B.axes[1][c] * mid[1] + B.axes[2][c] * mid[2]) as Vec3;
  // longest side first, and keep the frame right-handed
  const order = [0, 1, 2].sort((i, j) => size[j] - size[i]);
  const axes = order.map((i) => B.axes[i]) as [Vec3, Vec3, Vec3];
  axes[2] = cross(axes[0], axes[1]);
  return { axes, size: order.map((i) => size[i]) as Vec3, center, volume: size[0] * size[1] * size[2], aabbVolume };
}
