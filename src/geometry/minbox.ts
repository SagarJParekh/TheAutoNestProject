/**
 * Smallest-volume box around a part (oriented bounding box). The best box
 * has a face flush with a face of the convex hull, so every hull face
 * direction is tried as the box's third axis; in that direction the part's
 * outline gets its smallest-area rectangle (rotating calipers). The box axes
 * are returned longest first, so turning the part onto them puts the longest
 * side along X and the shortest along Z.
 */
import type { Manifold } from 'manifold-3d';
import { MeshData, Vec3, computeBounds, boundsDiagonal } from './mesh';
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
  // convex hull of the vertices (near-duplicates merged so huge meshes stay quick)
  const q = Math.max(1e-6, boundsDiagonal(b) * 2e-5);
  const seen = new Set<string>();
  const pts: Vec3[] = [];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const k = `${Math.round(p[i] / q)},${Math.round(p[i + 1] / q)},${Math.round(p[i + 2] / q)}`;
    if (seen.has(k)) continue;
    seen.add(k);
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
  // candidate directions: hull face normals, merged when within about half a degree, plus X / Y / Z
  const dirs = new Map<string, Vec3>();
  const add = (n: Vec3) => {
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-12) return;
    let u: Vec3 = [n[0] / l, n[1] / l, n[2] / l];
    // n and −n give the same box
    if (u[2] < 0 || (u[2] === 0 && (u[1] < 0 || (u[1] === 0 && u[0] < 0)))) u = [-u[0], -u[1], -u[2]];
    dirs.set(u.map((x) => Math.round(x * 120)).join(), u);
  };
  for (let t = 0; t < hi.length; t += 3) {
    const a = verts[hi[t]], bb = verts[hi[t + 1]], c = verts[hi[t + 2]];
    add(cross([bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
  }
  add([1, 0, 0]);
  add([0, 1, 0]);
  add([0, 0, 1]);
  let best: { vol: number; axes: [Vec3, Vec3, Vec3]; size: Vec3; center: Vec3 } | null = null;
  for (const n of dirs.values()) {
    const { u, v } = planeBasis(n);
    let lo = Infinity, up = -Infinity;
    const xy: [number, number][] = verts.map((pt) => {
      const d = dot(pt, n);
      if (d < lo) lo = d;
      if (d > up) up = d;
      return [dot(pt, u), dot(pt, v)];
    });
    const r = minRect(xy);
    const vol = r.w * r.h * (up - lo);
    if (best && vol >= best.vol) continue;
    const a: Vec3 = [u[0] * r.axis[0] + v[0] * r.axis[1], u[1] * r.axis[0] + v[1] * r.axis[1], u[2] * r.axis[0] + v[2] * r.axis[1]];
    const bAx = cross(n, a);
    const mid = (lo + up) / 2;
    const center: Vec3 = [0, 1, 2].map((k) => u[k] * r.c[0] + v[k] * r.c[1] + n[k] * mid) as Vec3;
    best = { vol, axes: [a, bAx, n], size: [r.w, r.h, up - lo], center };
  }
  const B = best!;
  // longest side first, and keep the frame right-handed
  const order = [0, 1, 2].sort((i, j) => B.size[j] - B.size[i]);
  const axes = order.map((i) => B.axes[i]) as [Vec3, Vec3, Vec3];
  axes[2] = cross(axes[0], axes[1]);
  return { axes, size: order.map((i) => B.size[i]) as Vec3, center: B.center, volume: B.vol, aabbVolume };
}
