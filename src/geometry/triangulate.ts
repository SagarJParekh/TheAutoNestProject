import { ShapeUtils, Vector2 } from 'three';
import type { Vec3 } from './mesh';

/** Signed area of a 2D polygon given as flat [x0,y0,x1,y1,...]. CCW is positive. */
export function polygonArea2D(pts: ArrayLike<number>): number {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += (pts[j * 2] - pts[i * 2]) * (pts[j * 2 + 1] + pts[i * 2 + 1]);
  }
  return a / 2;
}

export function pointInPolygon2D(x: number, y: number, pts: ArrayLike<number>): boolean {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], yi = pts[i * 2 + 1], xj = pts[j * 2], yj = pts[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Orthonormal basis (u, v) such that u × v = n. */
export function planeBasis(n: Vec3): { u: Vec3; v: Vec3 } {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  let t: Vec3 = ax < ay && ax < az ? [1, 0, 0] : ay < az ? [0, 1, 0] : [0, 0, 1];
  // u = normalize(t × n) ... choose u ⟂ n
  let u: Vec3 = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
  const l = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / l, u[1] / l, u[2] / l];
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  t = v;
  return { u, v: t };
}

/** Newell normal of a 3D polygon given as a list of points (not normalised). */
export function newellNormal(pts: ArrayLike<number>): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = pts[i * 3], y0 = pts[i * 3 + 1], z0 = pts[i * 3 + 2];
    const x1 = pts[j * 3], y1 = pts[j * 3 + 1], z1 = pts[j * 3 + 2];
    nx += (y0 - y1) * (z0 + z1);
    ny += (z0 - z1) * (x0 + x1);
    nz += (x0 - x1) * (y0 + y1);
  }
  return [nx, ny, nz];
}

function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True if a closed 2D polygon has no proper self-intersections (O(n²), only for small n). */
export function isSimplePolygon2D(pts: ArrayLike<number>): boolean {
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      const j2 = (j + 1) % n;
      if (j2 === i) continue;
      if (
        segmentsIntersect(
          pts[i * 2], pts[i * 2 + 1], pts[i2 * 2], pts[i2 * 2 + 1],
          pts[j * 2], pts[j * 2 + 1], pts[j2 * 2], pts[j2 * 2 + 1],
        )
      )
        return false;
    }
  }
  return true;
}

/**
 * Triangulate one outer contour with optional holes (all flat 2D arrays).
 * Output indices refer to the concatenation [outer, ...holes]; every output
 * triangle is CCW in 2D.
 */
export function triangulate2D(outer: ArrayLike<number>, holes: ArrayLike<number>[] = []): number[] {
  const toV = (a: ArrayLike<number>) => {
    const r: Vector2[] = [];
    for (let i = 0; i < a.length; i += 2) r.push(new Vector2(a[i], a[i + 1]));
    return r;
  };
  const contour = toV(outer);
  const hs = holes.map(toV);
  const all = [...contour, ...hs.flat()];
  const faces = ShapeUtils.triangulateShape(contour, hs);
  const out: number[] = [];
  for (const f of faces) {
    const [a, b, c] = f;
    const pa = all[a], pb = all[b], pc = all[c];
    const cross = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
    if (cross >= 0) out.push(a, b, c);
    else out.push(a, c, b);
  }
  return out;
}

/**
 * Group closed 2D loops into outer contours and holes using containment
 * depth (even depth = outer, odd = hole) and triangulate each group.
 * Loops may be in any orientation. Returns triangles as indices into the
 * concatenation of all loops in input order, CCW in 2D.
 */
export function triangulateNestedLoops(loops: ArrayLike<number>[]): number[] {
  const n = loops.length;
  const offsets: number[] = [];
  let off = 0;
  for (const l of loops) {
    offsets.push(off);
    off += l.length / 2;
  }
  const areas = loops.map((l) => Math.abs(polygonArea2D(l)));
  // parent = smallest loop containing a sample point of this loop
  const depth = new Array(n).fill(0);
  const parent = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const li = loops[i];
    // use midpoint of first edge, nudged, as sample (vertices may be shared)
    const sx = (li[0] + li[2]) / 2, sy = (li[1] + li[3]) / 2;
    let best = -1;
    for (let j = 0; j < n; j++) {
      if (i === j || areas[j] <= areas[i]) continue;
      if (pointInPolygon2D(sx, sy, loops[j])) {
        depth[i]++;
        if (best < 0 || areas[j] < areas[best]) best = j;
      }
    }
    parent[i] = best;
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 !== 0) continue;
    if (areas[i] === 0) continue;
    const holeIds: number[] = [];
    for (let j = 0; j < n; j++) if (parent[j] === i && depth[j] === depth[i] + 1) holeIds.push(j);
    const outer = ensureOrientation(loops[i], true);
    const holes = holeIds.map((h) => ensureOrientation(loops[h], false));
    const local = triangulate2D(outer.pts, holes.map((h) => h.pts));
    // map local indices back to original loop vertex indices
    const map: number[] = [];
    const pushMap = (loopId: number, o: { reversed: boolean }) => {
      const cnt = loops[loopId].length / 2;
      for (let k = 0; k < cnt; k++) map.push(offsets[loopId] + (o.reversed ? cnt - 1 - k : k));
    };
    pushMap(i, outer);
    holeIds.forEach((h, k) => pushMap(h, holes[k]));
    for (const li of local) out.push(map[li]);
  }
  return out;
}

function ensureOrientation(pts: ArrayLike<number>, ccw: boolean): { pts: ArrayLike<number>; reversed: boolean } {
  const a = polygonArea2D(pts);
  if (a >= 0 === ccw) return { pts, reversed: false };
  const n = pts.length / 2;
  const r = new Float64Array(pts.length);
  for (let i = 0; i < n; i++) {
    r[i * 2] = pts[(n - 1 - i) * 2];
    r[i * 2 + 1] = pts[(n - 1 - i) * 2 + 1];
  }
  return { pts: r, reversed: true };
}
