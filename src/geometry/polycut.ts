/**
 * Polyline cut with teeth (as in Magics): a line of straight segments drawn
 * on screen splits the part along the line of sight. One segment can be
 * given teeth (triangle, square or dovetail) so the pieces key together;
 * corners of the line and of the teeth can be rounded, the cut can stop at a
 * depth below the part's front, and a clearance can be left between the
 * pieces.
 *
 * The line is kept in camera space (see LassoCamera): x / y in camera units
 * for an orthographic view, tangent-space at depth 1 for a perspective one.
 * `unit` converts mm at the part into those units.
 */
import { Matrix4, Vector3 } from 'three';
import { MeshData } from './mesh';
import { applyMatrix } from './transform';
import { fromManifold, getManifold, toManifold, NotManifoldError } from './manifold';
import { polylineToOutline, type LassoCamera } from './lasso';

export type ToothType = 'triangle' | 'square' | 'dovetail';

export interface PolyCutParams {
  /** segment that gets the teeth, from 1 (0 = none) */
  segment: number;
  type: ToothType;
  /** tooth pitch as a percentage of the segment's length */
  size: number;
  /** where the teeth sit across the line: 50 % centred on it, 0 % all on one side, 100 % all on the other */
  offset: number;
  roundTeeth: boolean;
  /** corner radius of the teeth, mm */
  teethRadius: number;
  roundPolyline: boolean;
  /** corner radius at the drawn line's own corners, mm */
  polylineRadius: number;
  /** stop the cut this deep below the part's front (along the view) */
  depthOn: boolean;
  depth: number;
  /** gap left between the two pieces */
  clearanceOn: boolean;
  clearance: number;
}

export const DEFAULT_POLYCUT: PolyCutParams = {
  segment: 0, type: 'square', size: 30, offset: 50, roundTeeth: false, teethRadius: 1, roundPolyline: false, polylineRadius: 1,
  depthOn: false, depth: 10, clearanceOn: false, clearance: 0.2,
};

type P2 = [number, number];

/** Tooth points along a segment of length L (x along it, y to its left), without its two ends. */
export function toothProfile(L: number, t: Pick<PolyCutParams, 'type' | 'size' | 'offset'>): { pts: P2[]; count: number } {
  const pitch = (Math.min(100, Math.max(1, t.size)) / 100) * L;
  const n = Math.max(1, Math.floor(L / pitch + 1e-9));
  const m = (L - n * pitch) / 2;
  const w = pitch / 2, H = pitch / 2;
  const base = -(Math.min(100, Math.max(0, t.offset)) / 100) * H;
  const pts: P2[] = [];
  if (base !== 0) pts.push([m, 0]);
  pts.push([m, base]);
  for (let k = 0; k < n; k++) {
    const x = m + k * pitch;
    if (t.type === 'triangle') pts.push([x + w, base + H], [x + pitch, base]);
    else if (t.type === 'dovetail') {
      const e = w * 0.25;
      pts.push([x + e, base], [x - e, base + H], [x + w + e, base + H], [x + w - e, base], [x + pitch, base]);
    } else pts.push([x, base + H], [x + w, base + H], [x + w, base], [x + pitch, base]);
  }
  if (base !== 0) pts.push([L - m, 0]);
  // drop repeats (a dovetail's first corner can sit on the start)
  return { pts: pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 1e-9), count: n };
}

/** Round the corners whose radius is > 0 with arcs (the radius shrinks where the segments are too short). */
export function filletCorners(pts: P2[], radius: number[], closed: boolean): P2[] {
  const n = pts.length;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const r = radius[i] ?? 0;
    const hasNeighbours = closed || (i > 0 && i < n - 1);
    if (!(r > 0) || !hasNeighbours) {
      out.push(pts[i]);
      continue;
    }
    const a = pts[(i - 1 + n) % n], v = pts[i], b = pts[(i + 1) % n];
    const la = Math.hypot(a[0] - v[0], a[1] - v[1]), lb = Math.hypot(b[0] - v[0], b[1] - v[1]);
    if (la < 1e-12 || lb < 1e-12) {
      out.push(v);
      continue;
    }
    const ua: P2 = [(a[0] - v[0]) / la, (a[1] - v[1]) / la], ub: P2 = [(b[0] - v[0]) / lb, (b[1] - v[1]) / lb];
    const cos = Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1]));
    const ang = Math.acos(cos);
    if (ang < 1e-3 || Math.PI - ang < 1e-3) {
      out.push(v);
      continue;
    }
    // tangent distance, kept within half of each neighbouring segment
    let t = r / Math.tan(ang / 2);
    const tMax = 0.5 * Math.min(la, lb);
    if (t > tMax) t = tMax;
    const rr = t * Math.tan(ang / 2);
    const p0: P2 = [v[0] + ua[0] * t, v[1] + ua[1] * t], p1: P2 = [v[0] + ub[0] * t, v[1] + ub[1] * t];
    const bis: P2 = [ua[0] + ub[0], ua[1] + ub[1]];
    const bl = Math.hypot(bis[0], bis[1]);
    const dc = rr / Math.sin(ang / 2);
    const c: P2 = [v[0] + (bis[0] / bl) * dc, v[1] + (bis[1] / bl) * dc];
    const s0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
    let s1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
    let d = s1 - s0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    s1 = s0 + d;
    const steps = Math.max(2, Math.ceil(Math.abs(d) / (Math.PI / 16)));
    for (let k = 0; k <= steps; k++) {
      const s = s0 + (d * k) / steps;
      out.push([c[0] + Math.cos(s) * rr, c[1] + Math.sin(s) * rr]);
    }
  }
  return out;
}

/** The drawn line with its teeth and rounded corners (camera space), and the number of teeth. */
export function shapePolyline(points: P2[], closed: boolean, p: PolyCutParams, unit: number): { pts: P2[]; teeth: number } {
  const n = points.length;
  const segs = closed ? n : n - 1;
  const out: P2[] = [];
  const radius: number[] = [];
  const rp = p.roundPolyline ? Math.max(0, p.polylineRadius) * unit : 0;
  const rt = p.roundTeeth ? Math.max(0, p.teethRadius) * unit : 0;
  let teeth = 0;
  for (let i = 0; i < n; i++) {
    out.push(points[i]);
    radius.push(rp);
    if (i + 1 > segs || p.segment !== i + 1) continue;
    const a = points[i], b = points[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-12) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const prof = toothProfile(L, p);
    teeth = prof.count;
    for (const [x, y] of prof.pts) {
      out.push([a[0] + ux * x - uy * y, a[1] + uy * x + ux * y]);
      radius.push(rt);
    }
  }
  return { pts: rp > 0 || rt > 0 ? filletCorners(out, radius, closed) : out, teeth };
}

export interface PolyCutArgs {
  mesh: MeshData;
  /** the drawn line, camera space */
  points: P2[];
  closed: boolean;
  camera: LassoCamera;
  /** camera-space units per mm at the part */
  unit: number;
  params: PolyCutParams;
}

/**
 * Split along the shaped line: `inside` is the piece on the line's left side
 * (inside a closed shape), `outside` the rest. With a clearance the pieces
 * are each shrunk away from the line by half of it.
 */
export async function polyCutSplit(a: PolyCutArgs): Promise<{ inside: MeshData; outside: MeshData; lines: Float32Array; teeth: number }> {
  const { points, closed, camera: cam, unit, params: p } = a;
  if (points.length < (closed ? 3 : 2)) throw new Error(closed ? 'A closed shape needs at least three points' : 'Draw a line of at least two points');
  const shaped = shapePolyline(points, closed, p, unit);
  let ext = 0;
  for (const [x, y] of shaped.pts) ext = Math.max(ext, Math.abs(x), Math.abs(y));
  const outline = closed ? shaped.pts : polylineToOutline(shaped.pts, (ext + 1) * 50);
  const wasm = await getManifold();
  const camM = new Matrix4().fromArray(cam.matrixWorld);
  const inv = camM.clone().invert();
  // depth range: the whole part, or from its front down to the cutting depth
  let zFront = Infinity, zBack = -Infinity;
  const v = new Vector3();
  const pos = a.mesh.positions;
  for (let i = 0; i < pos.length; i += 3) {
    v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(inv);
    zFront = Math.min(zFront, -v.z);
    zBack = Math.max(zBack, -v.z);
  }
  if (!Number.isFinite(zFront)) throw new Error('The part has no triangles');
  const near = cam.orthographic ? zFront - 1 : Math.max(zFront * 0.5, zFront - 1, 1e-3);
  const far = p.depthOn && p.depth > 0 ? zFront + p.depth : zBack + 1;
  const s0 = cam.orthographic ? 1 : near;
  const k = cam.orthographic ? 1 : far / near;
  const toCam = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, -near, 1];
  const half = p.clearanceOn ? (Math.max(0, p.clearance) * unit) / 2 : 0;
  const base = new wasm.CrossSection([outline.map(([x, y]) => [x * s0, y * s0] as P2)], 'NonZero');
  const part = await toManifold(a.mesh);
  if (!part) {
    base.delete();
    throw new NotManifoldError('Part');
  }
  const made: { delete(): void }[] = [base, part];
  try {
    if (base.isEmpty()) throw new Error('The line encloses no area');
    const cutter = async (grow: number) => {
      const cs = grow ? base.offset(grow * s0, 'Miter', 4) : base;
      if (cs !== base) made.push(cs);
      const solid = cs.extrude(far - near, 0, 0, [k, k]);
      made.push(solid);
      const mesh = applyMatrix(applyMatrix(fromManifold(solid), toCam), cam.matrixWorld);
      const m = await toManifold(mesh);
      if (!m) throw new Error('The line could not be turned into a cutter; draw a simpler line');
      made.push(m);
      return m;
    };
    const cIn = await cutter(-half), cOut = half ? await cutter(half) : cIn;
    const i = part.intersect(cIn), o = part.subtract(cOut);
    made.push(i, o);
    // the shaped line at the part's middle depth, for the preview
    const mid = (zFront + zBack) / 2;
    const seg: number[] = [];
    const w = (q: P2) => (cam.orthographic ? [q[0], q[1], -mid] : [q[0] * mid, q[1] * mid, -mid]);
    const L = shaped.pts.length;
    for (let j = 0; j < (closed ? L : L - 1); j++) seg.push(...w(shaped.pts[j]), ...w(shaped.pts[(j + 1) % L]));
    const lines = applyMatrix({ positions: Float32Array.from(seg), indices: new Uint32Array(0) }, cam.matrixWorld).positions as Float32Array;
    return { inside: fromManifold(i), outside: fromManifold(o), lines, teeth: shaped.teeth };
  } finally {
    made.forEach((m) => m.delete());
  }
}
