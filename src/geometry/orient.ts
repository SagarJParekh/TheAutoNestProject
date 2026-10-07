/**
 * Automatic orientation for printing / nesting: put a part's largest flat
 * face down on the bed and turn it so its footprint lines up with X and Y.
 */
import { Quaternion, Vector3 } from 'three';
import { MeshData } from './mesh';

export interface FlatFace {
  /** outward unit normal (in the mesh's own coordinates) */
  normal: [number, number, number];
  /** plane offset: normal · point */
  offset: number;
  /** total area of the triangles in that plane, mm² */
  area: number;
  /** true when the whole part lies on one side of the plane (it can stand on it) */
  supporting: boolean;
}

/**
 * The flat face with the largest area. Coplanar triangles count together even
 * when they are not connected (e.g. the bottoms of four feet). Faces the part
 * can stand on (supporting planes) are preferred over larger faces inside
 * cavities. Returns null when the part has no flat face at all.
 */
export function findFlattestFace(mesh: MeshData, angleTolDeg = 1): FlatFace | null {
  const p = mesh.positions, idx = mesh.indices;
  const nt = idx.length / 3;
  if (!nt) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i];
    if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1];
    if (p[i + 1] > maxY) maxY = p[i + 1];
    if (p[i + 2] < minZ) minZ = p[i + 2];
    if (p[i + 2] > maxZ) maxZ = p[i + 2];
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const distTol = Math.max(1e-4, diag * 1e-4);
  // per-triangle unit normal, offset and area
  const fn = new Float32Array(nt * 3), fd = new Float64Array(nt), fa = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    fa[t] = l / 2;
    if (!l) continue;
    fn[t * 3] = nx / l; fn[t * 3 + 1] = ny / l; fn[t * 3 + 2] = nz / l;
    fd[t] = (fn[t * 3] * p[a] + fn[t * 3 + 1] * p[a + 1] + fn[t * 3 + 2] * p[a + 2]);
  }
  // coarse bins by normal and offset, then refine the biggest bins exactly
  const K = 120;
  const bins = new Map<string, { area: number; t: number }>();
  for (let t = 0; t < nt; t++) {
    if (!fa[t]) continue;
    const key = `${Math.round(fn[t * 3] * K)},${Math.round(fn[t * 3 + 1] * K)},${Math.round(fn[t * 3 + 2] * K)},${Math.round(fd[t] / (distTol * 20))}`;
    const b = bins.get(key);
    if (b) b.area += fa[t];
    else bins.set(key, { area: fa[t], t });
  }
  const top = [...bins.values()].sort((x, y) => y.area - x.area).slice(0, 24);
  const cosTol = Math.cos((angleTolDeg * Math.PI) / 180);
  let best: FlatFace | null = null;
  for (const b of top) {
    const n: [number, number, number] = [fn[b.t * 3], fn[b.t * 3 + 1], fn[b.t * 3 + 2]];
    const d = fd[b.t];
    let area = 0;
    for (let t = 0; t < nt; t++) {
      if (!fa[t]) continue;
      if (fn[t * 3] * n[0] + fn[t * 3 + 1] * n[1] + fn[t * 3 + 2] * n[2] < cosTol) continue;
      if (Math.abs(fd[t] - d) > distTol * 10) continue;
      area += fa[t];
    }
    // can the part stand on it? nothing may stick out beyond the plane
    let maxD = -Infinity;
    const stride = Math.max(1, Math.floor(p.length / 3 / 400000));
    for (let i = 0; i < p.length; i += 3 * stride) {
      const v = p[i] * n[0] + p[i + 1] * n[1] + p[i + 2] * n[2];
      if (v > maxD) maxD = v;
    }
    const supporting = maxD <= d + distTol * 20;
    const cand: FlatFace = { normal: n, offset: d, area, supporting };
    if (!best || (cand.supporting && !best.supporting) || (cand.supporting === best.supporting && cand.area > best.area)) best = cand;
  }
  // a tiny "flat face" (e.g. one facet of a sphere) is not a real base
  if (best && best.area < 1e-9) return null;
  return best;
}

/** Convex hull (Andrew's monotone chain) of 2D points given as [x0, y0, x1, y1, ...]. */
function hull2d(xy: number[]): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < xy.length; i += 2) pts.push([xy[i], xy[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Rotation about Z (radians) that turns the smallest-area bounding rectangle
 * of the 2D points into an axis-aligned one; the longer side ends up along X.
 */
export function minAreaRectAngle(xy: number[]): number {
  const h = hull2d(xy);
  if (h.length < 3) return 0;
  let bestArea = Infinity, bestAngle = 0, bestW = 0, bestH = 0;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of h) {
      const rx = x * c - y * s, ry = x * s + y * c;
      if (rx < x0) x0 = rx;
      if (rx > x1) x1 = rx;
      if (ry < y0) y0 = ry;
      if (ry > y1) y1 = ry;
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      bestAngle = -ang;
      bestW = x1 - x0;
      bestH = y1 - y0;
    }
  }
  // longer side along X
  if (bestH > bestW) bestAngle += Math.PI / 2;
  // smallest equivalent turn
  while (bestAngle > Math.PI / 2) bestAngle -= Math.PI;
  while (bestAngle < -Math.PI / 2) bestAngle += Math.PI;
  return bestAngle;
}

export interface AutoOrientResult {
  /** new part rotation as a quaternion [x, y, z, w] */
  quaternion: [number, number, number, number];
  face: FlatFace | null;
  /** turn about Z applied to line the footprint up with X / Y, degrees */
  turnDeg: number;
}

/**
 * New rotation for a part (mesh in its own coordinates, current rotation
 * `q`) so its largest flat face lies on the bed and its footprint is aligned
 * with X and Y. Parts without a flat face keep their tilt and are only turned.
 */
export function autoOrient(mesh: MeshData, q: [number, number, number, number], alignXY = true): AutoOrientResult {
  const rot = new Quaternion(q[0], q[1], q[2], q[3]);
  const face = findFlattestFace(mesh);
  if (face && face.supporting) {
    const n = new Vector3(...face.normal).applyQuaternion(rot).normalize();
    rot.premultiply(new Quaternion().setFromUnitVectors(n, new Vector3(0, 0, -1)));
  }
  let turn = 0;
  if (alignXY) {
    const p = mesh.positions;
    const stride = Math.max(1, Math.floor(p.length / 3 / 200000));
    const xy: number[] = [];
    const v = new Vector3();
    for (let i = 0; i < p.length; i += 3 * stride) {
      v.set(p[i], p[i + 1], p[i + 2]).applyQuaternion(rot);
      xy.push(v.x, v.y);
    }
    turn = minAreaRectAngle(xy);
    if (Math.abs(turn) > 1e-9) rot.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), turn));
  }
  return { quaternion: [rot.x, rot.y, rot.z, rot.w], face, turnDeg: (turn * 180) / Math.PI };
}
