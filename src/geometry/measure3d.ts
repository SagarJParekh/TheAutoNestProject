/**
 * Measurement math on simple geometric entities (all world space, mm).
 * Plain functions, no UI: points, lines (edges), planes (faces), circles and
 * spheres, plus least-squares fitting of circles/cylinders/spheres.
 */
import { MeshData, Vec3, triangleCross } from './mesh';
import { buildTopology, neighbourAcross, Topology } from './topology';

export type MEntity =
  | { kind: 'point'; p: Vec3 }
  | { kind: 'line'; a: Vec3; b: Vec3 }
  | { kind: 'plane'; p: Vec3; n: Vec3 }
  | { kind: 'circle'; c: Vec3; n: Vec3; r: number }
  | { kind: 'sphere'; c: Vec3; r: number };

export interface DistanceResult {
  distance: number;
  /** closest points used to draw the dimension */
  from: Vec3;
  to: Vec3;
  /** angle between the entities, degrees, when it is meaningful */
  angle?: number;
  /** extra values, e.g. edge-to-edge gap of circles */
  extra: { label: string; value: number; unit: 'mm' | '°' }[];
  note?: string;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const deg = (r: number) => (r * 180) / Math.PI;
const PAR = 1e-6;

export const vec = { sub, add, mul, dot, cross, len, unit };

/** Angle at `vertex` formed by points a and b, degrees (0–180). */
export function angle3(a: Vec3, vertex: Vec3, b: Vec3): number {
  const u = unit(sub(a, vertex)), v = unit(sub(b, vertex));
  return deg(Math.acos(Math.max(-1, Math.min(1, dot(u, v)))));
}

function direction(e: MEntity): Vec3 | null {
  if (e.kind === 'line') return unit(sub(e.b, e.a));
  return null;
}

function normalOf(e: MEntity): Vec3 | null {
  if (e.kind === 'plane') return unit(e.n);
  if (e.kind === 'circle') return unit(e.n);
  return null;
}

/**
 * Angle between two lines/planes/circle axes in degrees (0–90).
 * Line–plane gives the angle between the line and the plane.
 */
export function angleBetween(a: MEntity, b: MEntity): number | null {
  const da = direction(a), db = direction(b), na = normalOf(a), nb = normalOf(b);
  const acute = (x: number) => deg(Math.acos(Math.min(1, Math.abs(x))));
  if (da && db) return acute(dot(da, db));
  if (na && nb) return acute(dot(na, nb));
  if (da && nb) return 90 - acute(dot(da, nb));
  if (na && db) return 90 - acute(dot(na, db));
  return null;
}

function closestOnLine(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const d = sub(b, a);
  const t = dot(sub(p, a), d) / (dot(d, d) || 1);
  return add(a, mul(d, t));
}

function closestOnPlane(p: Vec3, o: Vec3, n: Vec3): Vec3 {
  const u = unit(n);
  return sub(p, mul(u, dot(sub(p, o), u)));
}

/** Point representing an entity for point-like distances (circle/sphere -> centre). */
function anchor(e: MEntity): Vec3 {
  switch (e.kind) {
    case 'point': return e.p;
    case 'line': return e.a;
    case 'plane': return e.p;
    case 'circle': return e.c;
    case 'sphere': return e.c;
  }
}

/** Minimum distance between two entities (lines and planes are infinite). */
export function measureDistance(A: MEntity, B: MEntity): DistanceResult {
  const extra: DistanceResult['extra'] = [];
  const res = (from: Vec3, to: Vec3, note?: string): DistanceResult => {
    const angle = angleBetween(A, B) ?? undefined;
    return { distance: len(sub(to, from)), from, to, angle, extra, note };
  };
  const pointLike = (e: MEntity) => e.kind === 'point' || e.kind === 'circle' || e.kind === 'sphere';

  // radii-aware extras
  if (A.kind === 'circle' && B.kind === 'circle') {
    const cd = len(sub(B.c, A.c));
    extra.push({ label: 'Edge to edge', value: cd - A.r - B.r, unit: 'mm' });
    const axial = Math.abs(dot(sub(B.c, A.c), unit(A.n)));
    extra.push({ label: 'Along axis', value: axial, unit: 'mm' });
    extra.push({ label: 'Radial (axis to axis)', value: Math.sqrt(Math.max(0, cd * cd - axial * axial)), unit: 'mm' });
  }
  if (A.kind === 'sphere' && B.kind === 'sphere') extra.push({ label: 'Surface gap', value: len(sub(B.c, A.c)) - A.r - B.r, unit: 'mm' });

  if (pointLike(A) && pointLike(B)) return res(anchor(A), anchor(B));
  if (pointLike(A) && B.kind === 'line') return res(anchor(A), closestOnLine(anchor(A), B.a, B.b));
  if (A.kind === 'line' && pointLike(B)) return res(closestOnLine(anchor(B), A.a, A.b), anchor(B));
  if (pointLike(A) && B.kind === 'plane') return res(anchor(A), closestOnPlane(anchor(A), B.p, B.n));
  if (A.kind === 'plane' && pointLike(B)) return res(closestOnPlane(anchor(B), A.p, A.n), anchor(B));

  if (A.kind === 'line' && B.kind === 'line') {
    const d1 = sub(A.b, A.a), d2 = sub(B.b, B.a), r = sub(A.a, B.a);
    const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), c = dot(d1, r), b = dot(d1, d2);
    const den = a * e - b * b;
    if (den < PAR * a * e) {
      // parallel: distance from a point of A to line B
      return res(A.a, closestOnLine(A.a, B.a, B.b), 'parallel lines');
    }
    const s = (b * f - c * e) / den, t = (a * f - b * c) / den;
    return res(add(A.a, mul(d1, s)), add(B.a, mul(d2, t)), 'closest points of the infinite lines');
  }
  if ((A.kind === 'line' && B.kind === 'plane') || (A.kind === 'plane' && B.kind === 'line')) {
    const L = (A.kind === 'line' ? A : B) as Extract<MEntity, { kind: 'line' }>;
    const P = (A.kind === 'plane' ? A : B) as Extract<MEntity, { kind: 'plane' }>;
    const d = unit(sub(L.b, L.a)), n = unit(P.n);
    if (Math.abs(dot(d, n)) < 1e-6) {
      const foot = closestOnPlane(L.a, P.p, P.n);
      return A.kind === 'line' ? res(L.a, foot, 'line parallel to surface') : res(foot, L.a, 'line parallel to surface');
    }
    const t = dot(sub(P.p, L.a), n) / dot(d, n);
    const x = add(L.a, mul(d, t));
    return res(x, x, 'line intersects the surface');
  }
  if (A.kind === 'plane' && B.kind === 'plane') {
    const n1 = unit(A.n), n2 = unit(B.n);
    if (Math.abs(Math.abs(dot(n1, n2)) - 1) < 1e-6) return res(A.p, closestOnPlane(A.p, B.p, B.n), 'parallel surfaces');
    return res(A.p, A.p, 'surfaces intersect');
  }
  return res(anchor(A), anchor(B));
}

/** Circle through three points. */
export function circleFrom3Points(p1: Vec3, p2: Vec3, p3: Vec3): Extract<MEntity, { kind: 'circle' }> {
  const a = sub(p2, p1), b = sub(p3, p1);
  const n = cross(a, b);
  const nn = dot(n, n);
  if (nn < 1e-18) throw new Error('The three points are collinear');
  const c = add(p1, mul(add(mul(cross(n, a), dot(b, b)), mul(cross(b, n), dot(a, a))), 1 / (2 * nn)));
  return { kind: 'circle', c, n: unit(n), r: len(sub(p1, c)) };
}

// ------------------------------------------------------------------ fitting

/** Solve a small dense linear system (Gaussian elimination with pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-14) throw new Error('Degenerate fit');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Eigenvector of the smallest eigenvalue of a symmetric 3x3 matrix (Jacobi). */
export function smallestEigenvector(m: number[][]): Vec3 {
  const a = m.map((r) => [...r]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  let best = 0;
  for (let i = 1; i < 3; i++) if (a[i][i] < a[best][best]) best = i;
  return unit([v[0][best], v[1][best], v[2][best]]);
}

/** Least-squares sphere through points (flat xyz array). */
export function fitSphere(pts: ArrayLike<number>): { c: Vec3; r: number } {
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const b = [0, 0, 0, 0];
  // shift for numerical stability
  const n = pts.length / 3;
  let ox = 0, oy = 0, oz = 0;
  for (let i = 0; i < n; i++) { ox += pts[i * 3] / n; oy += pts[i * 3 + 1] / n; oz += pts[i * 3 + 2] / n; }
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3] - ox, y = pts[i * 3 + 1] - oy, z = pts[i * 3 + 2] - oz;
    const row = [x, y, z, 1];
    const rhs = -(x * x + y * y + z * z);
    for (let r = 0; r < 4; r++) {
      b[r] += row[r] * rhs;
      for (let c = 0; c < 4; c++) A[r][c] += row[r] * row[c];
    }
  }
  const [D, E, F, G] = solve(A, b);
  const c: Vec3 = [-D / 2 + ox, -E / 2 + oy, -F / 2 + oz];
  return { c, r: Math.sqrt(Math.max(0, (D * D + E * E + F * F) / 4 - G)) };
}

/** Least-squares circle through 2D points (flat xy array). */
export function fitCircle2D(pts: ArrayLike<number>): { x: number; y: number; r: number } {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  const n = pts.length / 2;
  let ox = 0, oy = 0;
  for (let i = 0; i < n; i++) { ox += pts[i * 2] / n; oy += pts[i * 2 + 1] / n; }
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2] - ox, y = pts[i * 2 + 1] - oy;
    const row = [x, y, 1];
    const rhs = -(x * x + y * y);
    for (let r = 0; r < 3; r++) {
      b[r] += row[r] * rhs;
      for (let c = 0; c < 3; c++) A[r][c] += row[r] * row[c];
    }
  }
  const [D, E, F] = solve(A, b);
  return { x: -D / 2 + ox, y: -E / 2 + oy, r: Math.sqrt(Math.max(0, (D * D + E * E) / 4 - F)) };
}

/**
 * Grow a region over a smooth surface: neighbours are added while the
 * dihedral angle across the shared edge is below `maxDihedralDeg`.
 */
export function growSmoothRegion(mesh: MeshData, seed: number, maxDihedralDeg = 20, topo: Topology = buildTopology(mesh), maxTris = 2_000_000): Uint32Array {
  const nt = mesh.indices.length / 3;
  const cosT = Math.cos((maxDihedralDeg * Math.PI) / 180);
  const visited = new Uint8Array(nt);
  const out = [seed];
  const stack = [seed];
  visited[seed] = 1;
  const n1: Vec3 = [0, 0, 0], n2: Vec3 = [0, 0, 0];
  while (stack.length && out.length < maxTris) {
    const t = stack.pop()!;
    triangleCross(mesh, t, n1);
    const l1 = len(n1) || 1;
    for (let k = 0; k < 3; k++) {
      const nb = neighbourAcross(topo, t * 3 + k);
      if (nb < 0 || visited[nb]) continue;
      triangleCross(mesh, nb, n2);
      const l2 = len(n2);
      if (!l2 || dot(n1, n2) / (l1 * l2) < cosT) continue;
      visited[nb] = 1;
      out.push(nb);
      stack.push(nb);
    }
  }
  return Uint32Array.from(out);
}

function regionPointsAndNormals(mesh: MeshData, tris: ArrayLike<number>) {
  const used = new Set<number>();
  const pts: number[] = [];
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    triangleCross(mesh, t, n);
    const w = len(n);
    if (!w) continue;
    const u = mul(n, 1 / w);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r][c] += w * u[r] * u[c];
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k];
      if (used.has(v)) continue;
      used.add(v);
      pts.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
    }
  }
  return { pts, cov };
}

/**
 * Fit a cylinder to a smooth region: the axis is the direction normals are
 * perpendicular to; the cross-section is a least-squares circle.
 * Returns the circle at the middle of the region along the axis.
 */
export function fitCylinder(mesh: MeshData, tris: ArrayLike<number>): { c: Vec3; axis: Vec3; r: number; length: number; rms: number } {
  const { pts, cov } = regionPointsAndNormals(mesh, tris);
  if (pts.length < 9) throw new Error('Not enough surface to fit a circle; click on a curved (round) surface');
  const axis = smallestEigenvector(cov);
  const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(axis, helper)), v = cross(axis, u);
  const p2: number[] = [];
  let tMin = Infinity, tMax = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const p: Vec3 = [pts[i], pts[i + 1], pts[i + 2]];
    p2.push(dot(p, u), dot(p, v));
    const t = dot(p, axis);
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  }
  const f = fitCircle2D(p2);
  let rms = 0;
  for (let i = 0; i < p2.length; i += 2) rms += (Math.hypot(p2[i] - f.x, p2[i + 1] - f.y) - f.r) ** 2;
  rms = Math.sqrt(rms / (p2.length / 2));
  const tm = (tMin + tMax) / 2;
  const c = add(add(mul(u, f.x), mul(v, f.y)), mul(axis, tm));
  return { c, axis, r: f.r, length: tMax - tMin, rms };
}

/** Fit a sphere to the vertices of a region. */
export function fitSphereRegion(mesh: MeshData, tris: ArrayLike<number>): { c: Vec3; r: number; rms: number } {
  const { pts } = regionPointsAndNormals(mesh, tris);
  if (pts.length < 12) throw new Error('Not enough surface to fit a sphere');
  const s = fitSphere(pts);
  let rms = 0;
  for (let i = 0; i < pts.length; i += 3) rms += (Math.hypot(pts[i] - s.c[0], pts[i + 1] - s.c[1], pts[i + 2] - s.c[2]) - s.r) ** 2;
  return { ...s, rms: Math.sqrt(rms / (pts.length / 3)) };
}
