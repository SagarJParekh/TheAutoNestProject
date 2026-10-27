/**
 * Joint cuts: instead of a flat plane, the part is split along a profiled
 * surface so the two pieces key into each other when put back together.
 *
 * The profile is a 2D line drawn across the part's cross-section at the cut
 * plane (s = across the section, n = along the plane normal) and extruded
 * through the rest of the section (t). Two families:
 * - lap joints (U, square, multiple, step, toothed, dovetail): small tongues and
 *   grooves on the cut surface, sized in mm;
 * - tongue joints (half lap, finger, scarf): the pieces overlap over a length
 *   along the normal, worked out from the cross-section itself.
 */
import { MeshData, Plane, Vec3, computeBounds, boundsDiagonal, triangleCount } from './mesh';
import { applyMatrix } from './transform';
import { planeBasis } from './triangulate';
import { fromManifold, getManifold, toManifold, NotManifoldError } from './manifold';

export type LapJoint = 'u' | 'square' | 'multiple' | 'step' | 'toothed' | 'dovetail';
export type TongueJoint = 'halfLap' | 'finger' | 'scarf';
export type JointKind = LapJoint | TongueJoint;

export const LAP_JOINTS: { value: LapJoint; label: string }[] = [
  { value: 'u', label: 'U' },
  { value: 'square', label: 'Square' },
  { value: 'multiple', label: 'Multiple' },
  { value: 'step', label: 'Step / Z / Rabbet' },
  { value: 'toothed', label: 'Toothed (multiple V)' },
  { value: 'dovetail', label: 'Dovetail' },
];
export const TONGUE_JOINTS: { value: TongueJoint; label: string }[] = [
  { value: 'halfLap', label: 'Half lap' },
  { value: 'finger', label: 'Finger joint' },
  { value: 'scarf', label: 'Scarf' },
];

export const isTongueJoint = (k: JointKind): k is TongueJoint => k === 'halfLap' || k === 'finger' || k === 'scarf';

export interface JointParams {
  kind: JointKind;
  /** lap joints: tongue height; tongue joints: overlap length along the normal (mm, 0 = automatic) */
  depth: number;
  /** lap joints: tongue width at its root (mm, 0 = automatic) */
  width: number;
  /** number of tongues / teeth / fingers (multiple, toothed, finger) */
  count: number;
  /** dovetail flare / finger taper, degrees */
  angle: number;
  /** extra turn of the profile direction within the plane, degrees */
  rotate: number;
  /** fit gap between the two pieces, mm (split evenly between both sides) */
  clearance: number;
}

export const DEFAULT_JOINT: JointParams = { kind: 'square', depth: 0, width: 0, count: 3, angle: 15, rotate: 0, clearance: 0.2 };

/** The sizes actually used, after the automatic ones are worked out from the section. */
export interface JointSizes {
  depth: number;
  width: number;
  count: number;
  /** section extent across which the profile runs, mm */
  span: number;
  /** the tongues reach further than the part on one side of the plane (a piece would fall apart) */
  tooDeep?: boolean;
}

/**
 * `room`: how far the part reaches past the plane on its positive and negative
 * sides; automatic sizes stay well inside it.
 */
export function jointSizes(p: JointParams, span: number, room: [number, number] = [Infinity, Infinity]): JointSizes {
  const count = Math.max(1, Math.round(p.count) || 1);
  const pitch = span / count;
  let depth = p.depth > 0 ? p.depth : 0;
  let width = p.width > 0 ? p.width : 0;
  switch (p.kind) {
    case 'halfLap':
      depth ||= 1.5 * span;
      break;
    case 'scarf':
      depth ||= 3 * span;
      break;
    case 'finger':
      depth ||= Math.max(2 * pitch, span / 4);
      break;
    case 'multiple':
      depth ||= Math.min(span / 3, pitch);
      width = Math.min(width || pitch / 2, pitch * 0.8);
      break;
    case 'toothed':
      depth ||= Math.min(span / 3, pitch);
      break;
    default:
      depth ||= span / 3;
      width = Math.min(width || span / 3, span * 0.9);
  }
  // lap tongues go into the positive side; tongue joints overlap half their length on each side
  const tongue = isTongueJoint(p.kind);
  const fit = tongue ? 1.8 * Math.min(room[0], room[1]) : 0.6 * room[0];
  if (!(p.depth > 0) && depth > fit) depth = fit;
  return { depth, width, count, span, tooDeep: (tongue ? depth / 2 : depth) >= (tongue ? Math.min(room[0], room[1]) : room[0]) };
}

/**
 * The profile line, left to right across the section [a, b]: points (s, n),
 * the second piece (on the negative side of the plane) being everything below it.
 */
export function jointProfile(p: JointParams, a: number, b: number, room?: [number, number]): [number, number][] {
  const z = jointSizes(p, b - a, room);
  const { depth: d, width: w, count: k } = z;
  const c = (a + b) / 2, pitch = (b - a) / k;
  const tan = Math.tan((Math.max(0, Math.min(p.angle, 60)) * Math.PI) / 180);
  const out: [number, number][] = [];
  switch (p.kind) {
    case 'square':
      out.push([c - w / 2, 0], [c - w / 2, d], [c + w / 2, d], [c + w / 2, 0]);
      break;
    case 'dovetail': {
      const e = Math.min(d * tan, w);
      out.push([c - w / 2, 0], [c - w / 2 - e, d], [c + w / 2 + e, d], [c + w / 2, 0]);
      break;
    }
    case 'u': {
      const seg = 24;
      for (let i = 0; i <= seg; i++) {
        const f = Math.PI * (1 - i / seg);
        out.push([c + (w / 2) * Math.cos(f), d * Math.sin(f)]);
      }
      break;
    }
    case 'multiple':
      for (let i = 0; i < k; i++) {
        const m = a + (i + 0.5) * pitch;
        out.push([m - w / 2, 0], [m - w / 2, d], [m + w / 2, d], [m + w / 2, 0]);
      }
      break;
    case 'toothed':
      out.push([a, 0]);
      for (let i = 0; i < k; i++) out.push([a + (i + 0.5) * pitch, d], [a + (i + 1) * pitch, 0]);
      break;
    case 'step':
      out.push([c, 0], [c, d]);
      break;
    case 'halfLap':
      out.push([c, -d / 2], [c, d / 2]);
      break;
    case 'scarf':
      out.push([a, -d / 2], [b, d / 2]);
      break;
    case 'finger': {
      // square wave between -d/2 and +d/2, fingers narrowing towards their tips by the taper angle
      const e = Math.min(d * tan, pitch / 4);
      for (let i = 0; i < k; i++) {
        const s0 = a + i * pitch, s1 = s0 + pitch / 2, s2 = s0 + pitch;
        out.push([s0 + e, -d / 2], [s1 - e, -d / 2], [s1 + e, d / 2], [s2 - e, d / 2]);
      }
      break;
    }
  }
  return out;
}

/** Points where the plane crosses the mesh's edges. */
function sectionPoints(mesh: MeshData, plane: Plane): Vec3[] {
  const p = mesh.positions, idx = mesh.indices, n = plane.normal;
  const nv = p.length / 3;
  const s = new Float64Array(nv);
  for (let v = 0; v < nv; v++) s[v] = n[0] * p[v * 3] + n[1] * p[v * 3 + 1] + n[2] * p[v * 3 + 2] - plane.constant;
  const out: Vec3[] = [];
  const nt = triangleCount(mesh);
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const i = idx[t * 3 + e], j = idx[t * 3 + ((e + 1) % 3)];
      if (i > j) continue; // each edge once (shared edges appear in both directions)
      if ((s[i] < 0) === (s[j] < 0)) continue;
      const f = s[i] / (s[i] - s[j]);
      out.push([p[i * 3] + (p[j * 3] - p[i * 3]) * f, p[i * 3 + 1] + (p[j * 3 + 1] - p[i * 3 + 1]) * f, p[i * 3 + 2] + (p[j * 3 + 2] - p[i * 3 + 2]) * f]);
    }
  }
  return out;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export interface JointFrame {
  /** direction the profile runs across (in the plane) */
  s: Vec3;
  /** direction it is extruded along (in the plane) */
  t: Vec3;
  sRange: [number, number];
  tRange: [number, number];
  /** how far the part reaches past the plane on its positive / negative side */
  room: [number, number];
}

/**
 * Directions for the profile: lap joints, half laps and scarfs run across the
 * section's thinnest direction (its thickness), finger joints across its width.
 */
export function jointFrame(mesh: MeshData, plane: Plane, p: Pick<JointParams, 'kind' | 'rotate'>): JointFrame {
  const pts = sectionPoints(mesh, plane);
  if (pts.length < 3) throw new Error('The cut plane does not cross the part');
  const n = plane.normal;
  const { u, v } = planeBasis(n);
  const step = Math.max(1, Math.floor(pts.length / 4000));
  const uv: [number, number][] = [];
  for (let i = 0; i < pts.length; i += step) uv.push([dot(pts[i], u), dot(pts[i], v)]);
  let best = 0, bestExt = Infinity;
  for (let deg = 0; deg < 180; deg++) {
    const c = Math.cos((deg * Math.PI) / 180), sn = Math.sin((deg * Math.PI) / 180);
    let lo = Infinity, hi = -Infinity;
    for (const [x, y] of uv) {
      const d = x * c + y * sn;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    if (hi - lo < bestExt - 1e-9) (bestExt = hi - lo), (best = deg);
  }
  const ang = ((best + (p.kind === 'finger' ? 90 : 0) + (p.rotate || 0)) * Math.PI) / 180;
  const c = Math.cos(ang), sn = Math.sin(ang);
  const s: Vec3 = [u[0] * c + v[0] * sn, u[1] * c + v[1] * sn, u[2] * c + v[2] * sn];
  const t = cross(s, n);
  const range = (d: Vec3): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    for (const q of pts) {
      const x = dot(q, d);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    return [lo, hi];
  };
  const p3 = mesh.positions;
  let nLo = Infinity, nHi = -Infinity;
  for (let i = 0; i < p3.length; i += 3) {
    const d = p3[i] * n[0] + p3[i + 1] * n[1] + p3[i + 2] * n[2] - plane.constant;
    if (d < nLo) nLo = d;
    if (d > nHi) nHi = d;
  }
  return { s, t, sRange: range(s), tRange: range(t), room: [Math.max(0, nHi), Math.max(0, -nLo)] };
}

/**
 * Closed solid filling the negative side of the joint surface (everything
 * "below" the profile), grown or shrunk by `grow` mm, in world space.
 */
export async function jointCutter(mesh: MeshData, plane: Plane, p: JointParams, grow = 0, frame = jointFrame(mesh, plane, p)): Promise<MeshData> {
  const wasm = await getManifold();
  const { s, t, sRange: [a, b], tRange: [t0, t1] } = frame;
  const z = jointSizes(p, b - a, frame.room);
  const reach = boundsDiagonal(computeBounds(mesh.positions)) + 2 * z.depth + 10;
  const prof = jointProfile(p, a, b, frame.room);
  const first = prof[0], last = prof[prof.length - 1];
  const poly: [number, number][] = [[a - reach, first[1]], ...prof, [b + reach, last[1]], [b + reach, -reach], [a - reach, -reach]];
  let cs = new wasm.CrossSection([poly], 'NonZero');
  if (grow) {
    const g = cs.offset(grow, 'Miter', 4);
    cs.delete();
    cs = g;
  }
  const h = t1 - t0 + 2 * reach;
  const solid = cs.extrude(h);
  cs.delete();
  const local = fromManifold(solid);
  solid.delete();
  // local x = s, y = n, z = t (from t0 - reach); s × n = t keeps the frame right-handed
  const n = plane.normal, o = plane.constant, zt = t0 - reach;
  const m = [s[0], s[1], s[2], 0, n[0], n[1], n[2], 0, t[0], t[1], t[2], 0, n[0] * o + t[0] * zt, n[1] * o + t[1] * zt, n[2] * o + t[2] * zt, 1];
  return applyMatrix(local, m);
}

export interface JointResult {
  /** piece on the positive side of the plane */
  above: MeshData;
  /** piece on the negative side */
  below: MeshData;
  sizes: JointSizes;
}

/** Split a closed part along a joint surface; the clearance is taken off both pieces equally. */
export async function jointSplit(mesh: MeshData, plane: Plane, p: JointParams): Promise<JointResult> {
  const a = await toManifold(mesh);
  if (!a) throw new NotManifoldError('Part');
  const frame = jointFrame(mesh, plane, p);
  const g = Math.max(0, p.clearance || 0) / 2;
  const tools = g ? [await jointCutter(mesh, plane, p, -g, frame), await jointCutter(mesh, plane, p, g, frame)] : [await jointCutter(mesh, plane, p, 0, frame)];
  const ms = await Promise.all(tools.map((m) => toManifold(m)));
  try {
    if (ms.some((m) => !m)) throw new Error('The joint profile could not be built; try other sizes');
    const lo = a.intersect(ms[0]!), hi = a.subtract(ms[ms.length - 1]!);
    const below = fromManifold(lo), above = fromManifold(hi);
    lo.delete();
    hi.delete();
    if (!below.indices.length || !above.indices.length) throw new Error('The joint does not cross the part');
    return { above, below, sizes: jointSizes(p, frame.sRange[1] - frame.sRange[0], frame.room) };
  } finally {
    a.delete();
    ms.forEach((m) => m?.delete());
  }
}
