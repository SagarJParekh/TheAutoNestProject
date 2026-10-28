/**
 * Joint cuts: instead of a flat plane, the part is split along a profiled
 * surface so the two pieces key into each other when put back together.
 *
 * Two families, both laid on the cut plane (n = along the plane normal):
 * - lap joints (U, square, multiple, step, toothed, dovetail) follow the part's
 *   outline at the cut: the profile is drawn against s = the distance inwards
 *   from the surface (on a hollow part from both sides of its wall) and swept all the way round the cross-section (like
 *   a lap joint along a housing's wall). The step is the classic lap joint: one
 *   piece gets a plateau inset by the offset b, the other a skirt over it.
 *   Clearances follow the usual convention: d at the notch sides, c on the
 *   ledge (front), e on top of the notch (back);
 * - tongue joints (half lap, finger, scarf) run straight across the
 *   cross-section: the pieces overlap over a length along the normal.
 */
import { MeshData, Plane, Vec3, computeBounds, boundsDiagonal, flipMesh, triangleCount } from './mesh';
import { meshVolume } from './measure';
import { applyMatrix } from './transform';
import { planeBasis } from './triangulate';
import { fromManifold, getManifold, toManifold, NotManifoldError } from './manifold';
import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';

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
  /** lap joints: notch height (a); tongue joints: overlap length along the normal (mm, 0 = automatic) */
  depth: number;
  /** lap joints: offset (b), distance of the notch from the outer surface, mm */
  offset: number;
  /** lap joints: width of each tongue / tooth at its root, mm */
  width: number;
  /** multiple: gap between neighbouring tongues, mm */
  spacing: number;
  /** number of tongues / teeth / fingers (multiple, toothed, finger) */
  count: number;
  /** dovetail flare / finger taper, degrees */
  angle: number;
  /** tongue joints: extra turn of the profile direction within the plane, degrees */
  rotate: number;
  /** lap joints: notch clearance (d), at the sides of the notch, mm */
  notchClearance: number;
  /** lap joints: front clearance (c), on the ledge around the notch, mm */
  frontClearance: number;
  /** lap joints: back clearance (e), on top of the notch, mm */
  backClearance: number;
  /** tongue joints: fit gap between the two pieces, mm (split evenly between both sides) */
  clearance: number;
  /** put the notch on the other piece (pointing the other way along the normal) */
  negative: boolean;
  /** give the second piece its own colour */
  recolor: boolean;
}

export const DEFAULT_JOINT: JointParams = {
  kind: 'step', depth: 10, offset: 2, width: 3, spacing: 3, count: 2, angle: 15, rotate: 0,
  notchClearance: 0.05, frontClearance: 0.01, backClearance: 0.05, clearance: 0.2, negative: false, recolor: true,
};

// ---------------------------------------------------------------- profiles

/**
 * Lap joint profile, from the outer surface inwards: points (s, n), s = distance
 * inwards from the outer surface, n = height above the cut plane. The piece on
 * the negative side keeps everything below the line.
 */
export function lapProfile(p: Pick<JointParams, 'kind' | 'depth' | 'offset' | 'width' | 'spacing' | 'count' | 'angle'>): [number, number][] {
  const a = Math.max(0, p.depth), b = Math.max(0, p.offset), w = Math.max(0.01, p.width), g = Math.max(0, p.spacing);
  const k = Math.max(1, Math.round(p.count) || 1);
  const out: [number, number][] = [];
  switch (p.kind) {
    case 'step':
      out.push([b, 0], [b, a]);
      break;
    case 'square':
      out.push([b, 0], [b, a], [b + w, a], [b + w, 0]);
      break;
    case 'u': {
      const seg = 24;
      for (let i = 0; i <= seg; i++) {
        const f = Math.PI * (1 - i / seg);
        out.push([b + w / 2 + (w / 2) * Math.cos(f), a * Math.sin(f)]);
      }
      break;
    }
    case 'multiple':
      for (let i = 0; i < k; i++) {
        const s0 = b + i * (w + g);
        out.push([s0, 0], [s0, a], [s0 + w, a], [s0 + w, 0]);
      }
      break;
    case 'toothed':
      for (let i = 0; i < k; i++) {
        const s0 = b + i * w;
        if (i === 0) out.push([s0, 0]);
        out.push([s0 + w / 2, a], [s0 + w, 0]);
      }
      break;
    case 'dovetail': {
      // flares out towards the top, but never past the outer surface
      const e = Math.min(a * Math.tan((Math.max(0, Math.min(p.angle, 45)) * Math.PI) / 180), b);
      out.push([b, 0], [b - e, a], [b + w + e, a], [b + w, 0]);
      break;
    }
    default:
      out.push([0, 0]);
  }
  return out;
}

/** The sizes actually used by a tongue joint, after the automatic ones are worked out from the section. */
export interface JointSizes {
  depth: number;
  count: number;
  /** section extent across which the profile runs, mm */
  span: number;
  /** the overlap reaches further than the part on one side of the plane (a piece would fall apart) */
  tooDeep?: boolean;
}

/**
 * `room`: how far the part reaches past the plane on its positive and negative
 * sides; the automatic overlap stays well inside it.
 */
export function jointSizes(p: Pick<JointParams, 'kind' | 'depth' | 'count'>, span: number, room: [number, number] = [Infinity, Infinity]): JointSizes {
  const count = Math.max(1, Math.round(p.count) || 1);
  const pitch = span / count;
  let depth = p.depth > 0 ? p.depth : 0;
  if (!depth) depth = p.kind === 'scarf' ? 3 * span : p.kind === 'finger' ? Math.max(2 * pitch, span / 4) : 1.5 * span;
  const fit = 1.8 * Math.min(room[0], room[1]);
  if (!(p.depth > 0) && depth > fit) depth = fit;
  return { depth, count, span, tooDeep: depth / 2 >= Math.min(room[0], room[1]) };
}

/**
 * Tongue joint profile, left to right across the section [a, b]: points (s, n),
 * the piece on the negative side of the plane being everything below it.
 */
export function jointProfile(p: Pick<JointParams, 'kind' | 'depth' | 'count' | 'angle'>, a: number, b: number, room?: [number, number]): [number, number][] {
  const { depth: d, count: k } = jointSizes(p, b - a, room);
  const c = (a + b) / 2, pitch = (b - a) / k;
  const tan = Math.tan((Math.max(0, Math.min(p.angle, 60)) * Math.PI) / 180);
  const out: [number, number][] = [];
  switch (p.kind) {
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
    default: // half lap
      out.push([c, -d / 2], [c, d / 2]);
  }
  return out;
}

// ---------------------------------------------------------------- frames

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

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

/** How far the part reaches past the plane on its positive / negative side. */
function roomOf(mesh: MeshData, plane: Plane): [number, number] {
  const p = mesh.positions, n = plane.normal;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const d = p[i] * n[0] + p[i + 1] * n[1] + p[i + 2] * n[2] - plane.constant;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [Math.max(0, hi), Math.max(0, -lo)];
}

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
 * Directions for a tongue joint's profile: half laps and scarfs run across the
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
  return { s, t, sRange: range(s), tRange: range(t), room: roomOf(mesh, plane) };
}

/**
 * Closed solid filling the negative side of a tongue joint's surface
 * (everything below the profile), grown or shrunk by `grow` mm, in world space.
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

// ---------------------------------------------------------------- lap joints along the outline

/** s-intervals where the horizontal line n = h lies inside the polygon. */
function intervalsAt(poly: [number, number][], h: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const [s0, n0] = poly[i], [s1, n1] = poly[(i + 1) % poly.length];
    if ((n0 <= h) === (n1 <= h)) continue;
    xs.push(s0 + ((h - n0) / (n1 - n0)) * (s1 - s0));
  }
  xs.sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}

function mergeIntervals(list: [number, number][]): [number, number][] {
  const s = [...list].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/**
 * Cutter for a lap joint in the plane's local frame (z = height above the
 * plane): everything below z = base, plus, layer by layer, the parts of the
 * cross-section whose distance from the outline lies under the profile.
 * `grow` adds the clearances (sides d, top e); `base` = 0 or the front clearance c.
 */
function lapCutter(wasm: ManifoldToplevel, section: CrossSection, prof: [number, number][], box: { min: Vec3; max: Vec3 }, base: number, side: number, top: number): Manifold {
  const big = 1e5;
  const first = prof[0], last = prof[prof.length - 1];
  const poly: [number, number][] = [[-big, first[1]], ...prof, [big, last[1]], [big, -big], [-big, -big]];
  const ns = prof.map(([, n]) => n);
  const peak = Math.max(...ns);
  // layer boundaries: every height of the profile (shifted up by the top clearance for the grown cutter);
  // slanted edges are cut into thin layers
  const hs = new Set<number>([0]);
  const fine = Math.max(peak / 48, 0.08);
  for (let i = 0; i + 1 < prof.length; i++) {
    const [s0, n0] = prof[i], [s1, n1] = prof[i + 1];
    const steps = Math.abs(s1 - s0) > 1e-9 && Math.abs(n1 - n0) > 1e-9 ? Math.ceil(Math.abs(n1 - n0) / fine) : 1;
    for (let j = 0; j <= steps; j++) {
      const h = n0 + ((n1 - n0) * j) / steps;
      if (h > 0) hs.add(h), top > 0 && hs.add(h + top);
    }
  }
  const heights = [...hs].sort((x, y) => x - y).filter((h, i, arr) => i === 0 || h - arr[i - 1] > 1e-6);
  const ins = new Map<number, CrossSection>();
  const inset = (s: number): CrossSection => {
    const k = Math.round(s * 1e4) / 1e4;
    let c = ins.get(k);
    if (!c) ins.set(k, (c = k <= 0 ? section.offset(1, 'Miter', 2) : section.offset(-k, 'Round', 2, 48)));
    return c;
  };
  const parts: Manifold[] = [];
  const temp: CrossSection[] = [];
  const eps = 1e-4;
  try {
    const w = box.max[0] - box.min[0] + 20, d = box.max[1] - box.min[1] + 20, depth = -box.min[2] + 10;
    parts.push(wasm.Manifold.cube([w, d, depth + base]).translate([box.min[0] - 10, box.min[1] - 10, -depth]));
    for (let i = 0; i + 1 < heights.length; i++) {
      const h0 = heights[i], h1 = heights[i + 1], hm = (h0 + h1) / 2;
      if (h1 <= base) continue;
      // with a top clearance the grown cutter also covers what the profile holds up to `top` lower
      const samples = top > 0 ? [hm, hm - top / 2, hm - top] : [hm];
      const ivs = mergeIntervals(samples.filter((h) => h > 0).flatMap((h) => intervalsAt(poly, h)).map(([lo, hi]) => [lo - side, hi + side] as [number, number]));
      if (!ivs.length) continue;
      let region: CrossSection | null = null;
      for (const [lo, hi] of ivs) {
        let r = inset(lo);
        if (hi < big / 2) {
          r = r.subtract(inset(hi));
          temp.push(r);
        }
        if (r.isEmpty()) continue;
        if (region) {
          const u: CrossSection = region.add(r);
          temp.push(u);
          region = u;
        } else region = r;
      }
      if (!region || region.isEmpty()) continue;
      const z0 = Math.max(h0, base) - eps;
      parts.push(region.extrude(h1 - z0).translate([0, 0, z0]));
    }
    return wasm.Manifold.union(parts);
  } finally {
    parts.forEach((m) => m.delete());
    temp.forEach((c) => c.delete());
    ins.forEach((c) => c.delete());
  }
}

/** Lap joint split in the plane's frame: the negative side gets the notch. */
async function lapSplit(mesh: MeshData, plane: Plane, p: JointParams): Promise<{ above: MeshData; below: MeshData; notes: string[]; tooDeep: boolean }> {
  const wasm = await getManifold();
  const n = plane.normal, c = plane.constant;
  const { u, v } = planeBasis(n);
  // to local: x = u, y = v, z = height above the plane (u × v = n keeps it right-handed)
  const toLocal = [u[0], v[0], n[0], 0, u[1], v[1], n[1], 0, u[2], v[2], n[2], 0, 0, 0, -c, 1];
  const toWorld = [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, n[0] * c, n[1] * c, n[2] * c, 1];
  // an inside-out part (all triangles facing in) would slice to nothing: turn it right way out
  const turned = applyMatrix(mesh, toLocal);
  const local = meshVolume(turned) < 0 ? flipMesh(turned) : turned;
  const box = computeBounds(local.positions);
  if (box.min[2] >= 0 || box.max[2] <= 0) throw new Error('The cut plane does not cross the part');
  const part = await toManifold(local);
  if (!part) throw new NotManifoldError('Part');
  const section = part.slice(0);
  const prof = lapProfile(p);
  const made: Manifold[] = [];
  try {
    if (section.isEmpty()) throw new Error('The cut plane does not cross the part');
    // the notch must fit inside the outline: at the offset some of the section has to be left
    // (distances count from every surface of the section, so on a hollow part from both sides of the wall)
    const start = Math.min(...prof.map(([s]) => s));
    const left = section.offset(-start, 'Round', 2, 48);
    const fits = !left.isEmpty();
    left.delete();
    if (!fits) throw new Error('The notch does not fit inside the cross-section here: reduce the offset (b) or the tongue width');
    const keep = lapCutter(wasm, section, prof, box, 0, 0, 0);
    made.push(keep);
    const g = lapCutter(wasm, section, prof, box, Math.max(0, p.frontClearance), Math.max(0, p.notchClearance), Math.max(0, p.backClearance));
    made.push(g);
    const lo = part.intersect(keep), hi = part.subtract(g);
    made.push(lo, hi);
    const below = applyMatrix(fromManifold(lo), toWorld), above = applyMatrix(fromManifold(hi), toWorld);
    if (!below.indices.length || !above.indices.length) throw new Error('The joint does not cross the part');
    const a = Math.max(...prof.map(([, h]) => h));
    const tooDeep = a + Math.max(0, p.backClearance) >= box.max[2];
    return { above, below, notes: [], tooDeep };
  } finally {
    section.delete();
    part.delete();
    made.forEach((m) => m.delete());
  }
}

// ---------------------------------------------------------------- split

export interface JointResult {
  /** piece on the positive side of the plane */
  above: MeshData;
  /** piece on the negative side */
  below: MeshData;
  /** tongue joints: the sizes used (automatic ones worked out) */
  sizes?: JointSizes;
  /** the notch / overlap reaches past the end of the part on one side: a piece may fall apart */
  tooDeep: boolean;
}

/**
 * Split a closed part along a joint surface. Lap joints put the notch on the
 * piece on the negative side of the plane (the positive side with `negative`).
 */
export async function jointSplit(mesh: MeshData, plane: Plane, p: JointParams): Promise<JointResult> {
  const flip = !!p.negative;
  const pl: Plane = flip ? { normal: [-plane.normal[0], -plane.normal[1], -plane.normal[2]], constant: -plane.constant } : plane;
  const swap = (r: { above: MeshData; below: MeshData }) => (flip ? { above: r.below, below: r.above } : { above: r.above, below: r.below });
  if (!isTongueJoint(p.kind)) {
    const r = await lapSplit(mesh, pl, p);
    return { ...swap(r), tooDeep: r.tooDeep };
  }
  const a = await toManifold(mesh);
  if (!a) throw new NotManifoldError('Part');
  const frame = jointFrame(mesh, pl, p);
  const g = Math.max(0, p.clearance || 0) / 2;
  const tools = g ? [await jointCutter(mesh, pl, p, -g, frame), await jointCutter(mesh, pl, p, g, frame)] : [await jointCutter(mesh, pl, p, 0, frame)];
  const ms = await Promise.all(tools.map((m) => toManifold(m)));
  try {
    if (ms.some((m) => !m)) throw new Error('The joint profile could not be built; try other sizes');
    const lo = a.intersect(ms[0]!), hi = a.subtract(ms[ms.length - 1]!);
    const below = fromManifold(lo), above = fromManifold(hi);
    lo.delete();
    hi.delete();
    if (!below.indices.length || !above.indices.length) throw new Error('The joint does not cross the part');
    const sizes = jointSizes(p, frame.sRange[1] - frame.sRange[0], frame.room);
    return { ...swap({ above, below }), sizes, tooDeep: !!sizes.tooDeep };
  } finally {
    a.delete();
    ms.forEach((m) => m?.delete());
  }
}
