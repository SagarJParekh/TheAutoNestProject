/**
 * Joint cuts: instead of a flat plane, the part is split along a profiled
 * surface so the two pieces key into each other when put back together.
 *
 * Two families, both laid on the cut plane (n = along the plane normal):
 * - lap joints (and tongue & groove) follow the part's
 *   outline at the cut: the profile is drawn against s = the distance inwards
 *   from the indicated contours (by default each region's outer boundary, so on
 *   a tube the notch runs out to the bore) and swept all the way round the
 *   cross-section (like a lap joint along a housing's wall). The step is the classic lap joint: one
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

export type LapJoint = 'step';
export type TongueJoint = 'tongue' | 'halfLap' | 'finger' | 'scarf';
export type PinJoint = 'pins';
export type JointKind = LapJoint | TongueJoint | PinJoint;

export const LAP_JOINTS: { value: LapJoint; label: string }[] = [{ value: 'step', label: 'Lap joint' }];
export const TONGUE_JOINTS: { value: TongueJoint; label: string }[] = [
  { value: 'tongue', label: 'Tongue & groove' },
  { value: 'halfLap', label: 'Half lap' },
  { value: 'finger', label: 'Finger joint' },
  { value: 'scarf', label: 'Scarf' },
];

/** Pins & holes: connectors placed in a row along the indicated contour. */
export const isPinJoint = (k: JointKind): boolean => k === 'pins';
/** Joints that run straight across the cross-section (the rest follow its outline). */
export const isAcrossJoint = (k: JointKind): boolean => k === 'halfLap' || k === 'finger' || k === 'scarf';
/** Joints listed under "Tongue joint" in the panel. */
export const isTongueFamily = (k: JointKind): boolean => k === 'tongue' || isAcrossJoint(k);

export interface JointParams {
  kind: JointKind;
  /** lap joints: notch height (a); tongue joints: overlap length along the normal (mm, 0 = automatic) */
  depth: number;
  /** lap joints: offset (b), distance of the notch from the outer surface, mm */
  offset: number;
  /** lap joints: width of each tongue / tooth at its root, mm (tongue & groove: 0 = fill the wall, b in from each side) */
  width: number;
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
  /**
   * lap joints, which outline the offset counts from: 'contours' = indicated section contours
   * (a whole cross-section region, measured from its outer boundary only), 'subcontours' = the
   * indicated loops themselves (an outer boundary or a hole)
   */
  basis: 'contours' | 'subcontours';
  /** lap joints: points clicked next to the contours to joint (world space); none = every region, from its outer boundary */
  picks: Vec3[];
  /** lap joints: notch walls straight along the plane normal; off = the notch follows the slope of the part's surface */
  straight: boolean;
  /** lap joints: show the preview as soon as a contour is indicated (panel only) */
  showPreview: boolean;
  /** subcontours: take the longer way round between the two indicated points */
  subFlip: boolean;
  /** pins & holes: pins on one piece and holes in the other, or holes in both (for loose pins) */
  pinType: 'pins' | 'holes';
  /** pin radius (r), mm */
  pinRadius: number;
  /** pin height (h), mm; with holes in both pieces the length of the loose pin */
  pinHeight: number;
  /** largest deviation of the faceted pin from a true cylinder, mm */
  pinTolerance: number;
  /** distance between pins (a), along the row, mm */
  pinSpacing: number;
  /** one clearance for top, side and face */
  uniformClearance: boolean;
  /** top clearance (b): extra depth of the hole above the pin's end, mm */
  pinTop: number;
  /** side clearance (c): extra radius of the hole, mm */
  pinSide: number;
  /** face clearance (d): gap between the two cut faces, mm */
  pinFace: number;
  /** distance of the row of pins in from the contour, mm (0 = automatic: clear of the surface, in the middle of thin walls) */
  pinInset: number;
  /** holes in both pieces: also make the loose pins as a part */
  loosePins: boolean;
}

export const DEFAULT_JOINT: JointParams = {
  kind: 'step', depth: 3, offset: 0.5, width: 3, count: 2, angle: 15, rotate: 0,
  notchClearance: 0.1, frontClearance: 0.1, backClearance: 0.1, clearance: 0.2, negative: false, recolor: false,
  basis: 'contours', picks: [], straight: true, showPreview: true, subFlip: false,
  pinType: 'pins', pinRadius: 0.5, pinHeight: 2, pinTolerance: 0.02, pinSpacing: 4, uniformClearance: true,
  pinTop: 0.2, pinSide: 0.2, pinFace: 0.2, pinInset: 0, loosePins: false,
};

/** The clearances a pin joint actually uses (uniform: the top clearance everywhere). */
export function pinClearances(p: Pick<JointParams, 'uniformClearance' | 'pinTop' | 'pinSide' | 'pinFace'>): { top: number; side: number; face: number } {
  const top = Math.max(0, p.pinTop);
  return p.uniformClearance ? { top, side: top, face: top } : { top, side: Math.max(0, p.pinSide), face: Math.max(0, p.pinFace) };
}

// ---------------------------------------------------------------- profiles

/**
 * Lap joint profile, from the outer surface inwards: points (s, n), s = distance
 * inwards from the outer surface, n = height above the cut plane. The piece on
 * the negative side keeps everything below the line.
 */
export function lapProfile(p: Pick<JointParams, 'kind' | 'depth' | 'offset' | 'width'>): [number, number][] {
  const a = Math.max(0, p.depth), b = Math.max(0, p.offset), w = Math.max(0.01, p.width);
  // tongue & groove with a width: a tongue b..b+w in from the outer wall; otherwise a step at b
  // (for tongue & groove the offsets count from every loop, so the step ends b from the far wall too)
  if (p.kind === 'tongue' && p.width > 0) return [[b, 0], [b, a], [b + w, a], [b + w, 0]];
  return [[b, 0], [b, a]];
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
 * Contours of a cross-section and the outline a lap joint's offset counts from.
 * Each pick (2D, in the plane's frame) indicates its nearest loop, and that
 * loop's whole region gets the joint, measured from the region's outer
 * boundary (from every loop with `allLoops`). Without picks every region gets
 * the joint. Regions left out are cut flat. (Subcontours: see below.)
 */
interface Loop {
  pts: [number, number][];
  hole: boolean;
  region: number;
}

interface LapRefs {
  /** the jointed regions, grown a little so the cutter never runs flush with the part's other walls */
  clip: CrossSection;
  /** the jointed regions as they are */
  regions: CrossSection;
  refs: { fill: CrossSection; hole: boolean; pts: [number, number][] }[];
  loops: number;
  cache: Map<number, CrossSection>;
  own: CrossSection[];
}

function loopArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function distToLoop(pts: [number, number][], q: [number, number]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t - q[0], ay + dy * t - q[1]));
  }
  return best;
}

function lapRefs(wasm: ManifoldToplevel, section: CrossSection, picks: [number, number][], allLoops = false): LapRefs | null {
  const parts = section.decompose();
  const own: CrossSection[] = [];
  try {
    const loops: Loop[] = [];
    parts.forEach((r, region) => {
      for (const poly of r.toPolygons()) {
        const pts = poly.map((v) => [v[0], v[1]] as [number, number]);
        if (pts.length >= 3) loops.push({ pts, hole: loopArea(pts) < 0, region });
      }
    });
    let used: Loop[];
    if (!picks.length) used = loops.filter((l) => allLoops || !l.hole);
    else {
      const hit = new Set<Loop>();
      for (const q of picks) {
        let best: Loop | null = null, bd = Infinity;
        for (const l of loops) {
          const d = distToLoop(l.pts, q);
          if (d < bd) (bd = d), (best = l);
        }
        if (best) hit.add(best);
      }
      used = loops.filter((l) => (allLoops || !l.hole) && [...hit].some((h) => h.region === l.region));
    }
    if (!used.length) return null;
    const keepRegions = [...new Set(used.map((l) => l.region))].map((i) => parts[i]);
    const regions = wasm.CrossSection.compose(keepRegions);
    own.push(regions);
    const clip = regions.offset(0.5, 'Miter', 2);
    own.push(clip);
    const refs = used.map((l) => {
      const fill = new wasm.CrossSection([l.pts], 'NonZero');
      own.push(fill);
      return { fill, hole: l.hole, pts: l.pts };
    });
    return { clip, regions, refs, loops: loops.length, cache: new Map(), own };
  } catch (e) {
    own.forEach((c) => c.delete());
    throw e;
  } finally {
    parts.forEach((c) => c.delete());
  }
}

function freeRefs(r: LapRefs | null) {
  if (!r) return;
  r.cache.forEach((c) => c.delete());
  r.own.forEach((c) => c.delete());
}

/** Material farther than s from the reference contours (`from` = the clip region or the plain regions). */
function lapInset(r: LapRefs, s: number, from: CrossSection = r.clip): CrossSection {
  if (s <= 0) return from;
  const temp: CrossSection[] = [];
  try {
    // band within s of each reference on the material side, reaching past the clip's growth on the other
    const bands = r.refs.map(({ fill, hole }) => {
      const a = fill.offset(hole ? s : Math.max(s, 2), 'Round', 2, 48), b = fill.offset(hole ? -Math.max(s, 2) : -s, 'Round', 2, 48);
      temp.push(a, b);
      const band = a.subtract(b);
      temp.push(band);
      return band;
    });
    const all = unionAll(bands, temp);
    return from.subtract(all);
  } finally {
    temp.forEach((c) => c.delete());
  }
}

function unionAll(list: CrossSection[], temp: CrossSection[]): CrossSection {
  let acc = list[0];
  for (let i = 1; i < list.length; i++) {
    acc = acc.add(list[i]);
    temp.push(acc);
  }
  return acc;
}

function cachedInset(r: LapRefs, s: number): CrossSection {
  const k = Math.round(s * 1e4) / 1e4;
  if (k <= 0) return r.clip;
  let c = r.cache.get(k);
  if (!c) r.cache.set(k, (c = lapInset(r, k)));
  return c;
}

/**
 * Cutter for a lap joint in the plane's local frame (z = height above the
 * plane): everything below z = base, plus, layer by layer, the parts of the
 * jointed regions whose distance from the reference contours lies under the
 * profile. `grow` adds the clearances (sides d, top e); `base` = 0 or the
 * front clearance c. `refsAt(h)` gives the contours to use for the layer at
 * height h (the plane's own for a straight cut).
 */
function lapCutter(wasm: ManifoldToplevel, refsAt: (h: number) => LapRefs | null, prof: [number, number][], box: { min: Vec3; max: Vec3 }, base: number, side: number, top: number, extra: number[]): Manifold {
  const big = 1e5;
  const first = prof[0], last = prof[prof.length - 1];
  const poly: [number, number][] = [[-big, first[1]], ...prof, [big, last[1]], [big, -big], [-big, -big]];
  const ns = prof.map(([, n]) => n);
  const peak = Math.max(...ns);
  // layer boundaries: every height of the profile (shifted up by the top clearance for the grown cutter);
  // slanted edges are cut into thin layers
  const hs = new Set<number>([0, ...extra.filter((h) => h > 0 && h < peak + top)]);
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
  const parts: Manifold[] = [];
  const temp: CrossSection[] = [];
  const eps = 1e-4;
  try {
    const w = box.max[0] - box.min[0] + 20, d = box.max[1] - box.min[1] + 20, depth = -box.min[2] + 10;
    parts.push(wasm.Manifold.cube([w, d, depth + base]).translate([box.min[0] - 10, box.min[1] - 10, -depth]));
    for (let i = 0; i + 1 < heights.length; i++) {
      const h0 = heights[i], h1 = heights[i + 1], hm = (h0 + h1) / 2;
      if (h1 <= base) continue;
      const r = refsAt(hm);
      if (!r) continue;
      // with a top clearance the grown cutter also covers what the profile holds up to `top` lower
      const samples = top > 0 ? [hm, hm - top / 2, hm - top] : [hm];
      const ivs = mergeIntervals(samples.filter((h) => h > 0).flatMap((h) => intervalsAt(poly, h)).map(([lo, hi]) => [lo - side, hi + side] as [number, number]));
      if (!ivs.length) continue;
      let region: CrossSection | null = null;
      for (const [lo, hi] of ivs) {
        let c = cachedInset(r, lo);
        if (hi < big / 2) {
          c = c.subtract(cachedInset(r, hi));
          temp.push(c);
        }
        if (c.isEmpty()) continue;
        if (region) {
          const u: CrossSection = region.add(c);
          temp.push(u);
          region = u;
        } else region = c;
      }
      if (!region || region.isEmpty()) continue;
      const z0 = Math.max(h0, base) - eps;
      parts.push(region.extrude(h1 - z0).translate([0, 0, z0]));
    }
    return wasm.Manifold.union(parts);
  } finally {
    parts.forEach((m) => m.delete());
    temp.forEach((c) => c.delete());
  }
}

/** Closed 2D loops as line segments at z = 0 (local frame). */
function loopSegments(loops: [number, number][][], out: number[]) {
  for (const l of loops)
    for (let i = 0; i < l.length; i++) {
      const [x0, y0] = l[i], [x1, y1] = l[(i + 1) % l.length];
      out.push(x0, y0, 0, x1, y1, 0);
    }
}

const polys = (c: CrossSection): [number, number][][] => c.toPolygons().map((poly) => poly.map((q) => [q[0], q[1]] as [number, number]));

// ---------------------------------------------------------------- subcontours

/** A stretch of one section loop between two indicated points, in the loop's own direction (material on its left). */
export interface Stretch {
  pts: [number, number][];
  hole: boolean;
  /** the whole loop the stretch lies on */
  loop: [number, number][];
}

/** The loops of a cross-section (outer boundaries counter-clockwise, holes clockwise). */
function sectionLoops(section: CrossSection): { pts: [number, number][]; hole: boolean }[] {
  return section
    .toPolygons()
    .map((poly) => poly.map((q) => [q[0], q[1]] as [number, number]))
    .filter((l) => l.length >= 3)
    .map((pts) => ({ pts, hole: loopArea(pts) < 0 }));
}

/** Closest point on a closed loop: its arc-length position and the point. */
function closestOnLoop(l: [number, number][], q: [number, number]): { s: number; d: number } {
  let best = { s: 0, d: Infinity }, at = 0;
  for (let i = 0; i < l.length; i++) {
    const [ax, ay] = l[i], [bx, by] = l[(i + 1) % l.length];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    const t = len > 0 ? Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / (len * len))) : 0;
    const d = Math.hypot(ax + dx * t - q[0], ay + dy * t - q[1]);
    if (d < best.d) best = { s: at + t * len, d };
    at += len;
  }
  return best;
}

/** Points of a loop from arc position s0 forward to s1 (wrapping round). */
function loopStretch(l: [number, number][], s0: number, s1: number): [number, number][] {
  const n = l.length;
  const cum: number[] = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(l[(i + 1) % n][0] - l[i][0], l[(i + 1) % n][1] - l[i][1]));
  const L = cum[n];
  const mod = (x: number) => ((x % L) + L) % L;
  const at = (s: number): [number, number] => {
    s = mod(s);
    let i = 0;
    while (i < n - 1 && cum[i + 1] < s) i++;
    const seg = cum[i + 1] - cum[i], f = seg > 0 ? (s - cum[i]) / seg : 0;
    const [ax, ay] = l[i], [bx, by] = l[(i + 1) % n];
    return [ax + (bx - ax) * f, ay + (by - ay) * f];
  };
  const len = mod(s1 - s0);
  // the loop's own corners strictly between the ends, in order
  const inner = l
    .map((q, i) => ({ q, rel: mod(cum[i] - s0) }))
    .filter((x) => x.rel > 1e-9 && x.rel < len - 1e-9)
    .sort((x, y) => x.rel - y.rel)
    .map((x) => x.q);
  return [at(s0), ...inner, at(s0 + len)];
}

/**
 * Stretches from indicated points taken in pairs (start, end): both ends go to
 * the loop nearest the start, and the stretch runs the shorter way round
 * between them (the longer way with `flip`).
 */
export function findStretches(loops: { pts: [number, number][]; hole: boolean }[], picks: [number, number][], flip: boolean): Stretch[] {
  const out: Stretch[] = [];
  for (let i = 0; i + 1 < picks.length; i += 2) {
    let best = -1, bd = Infinity;
    loops.forEach((l, k) => {
      const d = closestOnLoop(l.pts, picks[i]).d;
      if (d < bd) (bd = d), (best = k);
    });
    if (best < 0) continue;
    const l = loops[best];
    const L = l.pts.reduce((a, p, k) => a + Math.hypot(l.pts[(k + 1) % l.pts.length][0] - p[0], l.pts[(k + 1) % l.pts.length][1] - p[1]), 0);
    const s0 = closestOnLoop(l.pts, picks[i]).s, s1 = closestOnLoop(l.pts, picks[i + 1]).s;
    const fwd = (((s1 - s0) % L) + L) % L;
    if (fwd < 1e-6 || L - fwd < 1e-6) continue;
    const forward = fwd <= L / 2 !== flip;
    out.push({ pts: forward ? loopStretch(l.pts, s0, s1) : loopStretch(l.pts, s1, s0), hole: l.hole, loop: l.pts });
  }
  return out;
}

/**
 * The zone a stretch governs: everything from `out` outside it to `depth` in
 * from it, square across its two ends, grown by `grow` all round.
 */
function stretchZone(wasm: ManifoldToplevel, list: Stretch[], depth: number, grow: number, out = 2): CrossSection {
  const polys: [number, number][][] = [];
  for (const st of list) {
    const p = st.pts;
    const nrm = p.slice(0, -1).map((a, i) => {
      const b = p[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l] as [number, number];
    });
    const at = (q: [number, number], n: [number, number], d: number): [number, number] => [q[0] + n[0] * d, q[1] + n[1] * d];
    for (let i = 0; i + 1 < p.length; i++) {
      const n = nrm[i];
      polys.push([at(p[i], n, -out), at(p[i + 1], n, -out), at(p[i + 1], n, depth), at(p[i], n, depth)]);
      if (i > 0) polys.push([at(p[i], nrm[i - 1], -out), at(p[i], nrm[i - 1], depth), at(p[i], n, depth), at(p[i], n, -out)]);
    }
  }
  const parts = polys.map((q) => new wasm.CrossSection([q], 'NonZero'));
  const all = wasm.CrossSection.union(parts);
  parts.forEach((c) => c.delete());
  if (!grow) return all;
  const g = all.offset(grow, 'Miter', 2);
  all.delete();
  return g;
}

/** Material within s of a loop, on its material side (reaching 2 mm past it on the other). */
function loopBand(wasm: ManifoldToplevel, loop: [number, number][], hole: boolean, s: number): CrossSection {
  const fill = new wasm.CrossSection([loop], 'NonZero');
  const a = fill.offset(hole ? s : Math.max(s, 2), 'Round', 2, 48), b = fill.offset(hole ? -Math.max(s, 2) : -s, 'Round', 2, 48);
  const band = a.subtract(b);
  [fill, a, b].forEach((c) => c.delete());
  return band;
}

/**
 * Lap / tongue joint along subcontours only: the part is cut flat at the plane
 * and, along each stretch, a tab of the upper piece (the skirt of a lap joint,
 * or the tongue) hangs down `a` into a matching recess in the lower piece,
 * square across the stretch's ends. Clearances: d round the tab's sides and
 * ends, c at its tip, e between the flat faces.
 */
function subcontourSplit(wasm: ManifoldToplevel, part: Manifold, refs: LapRefs, stretches: Stretch[], p: JointParams, box: { min: Vec3; max: Vec3 }, maxInset: number): { lo: Manifold; hi: Manifold; lines: number[] } {
  const a = Math.max(0, p.depth), b = Math.max(0, p.offset), w = Math.max(0, p.width);
  const d = Math.max(0, p.notchClearance), c = Math.max(0, p.frontClearance), e = Math.max(0, p.backClearance);
  const tongue = p.kind === 'tongue';
  const fill = tongue && !(w > 0);
  const depth = fill ? 2 * maxInset + 1 : tongue ? b + w + 1 : b + 1;
  const temp: CrossSection[] = [];
  const keep = <T extends CrossSection>(x: T) => (temp.push(x), x);
  // the tab's footprint, grown by `g` (0 for the tab itself, d for the recess it fits in)
  const footprint = (g: number): CrossSection => {
    const zone = keep(stretchZone(wasm, stretches, depth + g, g));
    let area: CrossSection;
    if (fill) {
      // b in from every wall of the region
      const bands = refs.refs.map((r) => keep(loopBand(wasm, r.pts, r.hole, Math.max(0, b - g))));
      area = keep(refs.clip.subtract(keep(wasm.CrossSection.union(bands))));
    } else {
      const parts = stretches.map((st) => {
        const outer = keep(loopBand(wasm, st.loop, st.hole, tongue ? b + w + g : b + g));
        return tongue ? keep(outer.subtract(keep(loopBand(wasm, st.loop, st.hole, Math.max(0, b - g))))) : outer;
      });
      area = keep(wasm.CrossSection.union(parts));
    }
    return keep(zone.intersect(area));
  };
  const made: Manifold[] = [];
  try {
    const tab = footprint(0), recess = footprint(d);
    if (tab.isEmpty()) throw new Error('The joint does not fit along the indicated subcontour: reduce the offset (b) or the tongue width');
    const W = box.max[0] - box.min[0] + 20, D = box.max[1] - box.min[1] + 20;
    const below = (z: number) => wasm.Manifold.cube([W, D, z - box.min[2] + 10]).translate([box.min[0] - 10, box.min[1] - 10, box.min[2] - 10]);
    const above = (z: number) => wasm.Manifold.cube([W, D, box.max[2] - z + 10]).translate([box.min[0] - 10, box.min[1] - 10, z]);
    const eps = 1e-4;
    const lowerKeep = below(0), recessM = recess.extrude(a + c + eps).translate([0, 0, -(a + c)]);
    const upperKeep = above(e), tabM = tab.extrude(a + e + eps).translate([0, 0, -a]);
    made.push(lowerKeep, recessM, upperKeep, tabM);
    const lowerCut = lowerKeep.subtract(recessM), upperCut = upperKeep.add(tabM);
    made.push(lowerCut, upperCut);
    const lo = part.intersect(lowerCut), hi = part.intersect(upperCut);
    // preview lines: the stretches and the outline of the tab
    const lines: number[] = [];
    for (const st of stretches)
      for (let i = 0; i + 1 < st.pts.length; i++) lines.push(st.pts[i][0], st.pts[i][1], 0, st.pts[i + 1][0], st.pts[i + 1][1], 0);
    loopSegments(polys(tab), lines);
    return { lo, hi, lines };
  } finally {
    made.forEach((m) => m.delete());
    temp.forEach((x) => x.delete());
  }
}

/** Largest inset of a cross-section that still leaves material (half its thickest wall). */
function maxInsetOf(section: CrossSection, limit: number): number {
  let lo = 0, hi = limit;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2, o = section.offset(-mid, 'Round', 2, 32);
    const empty = o.isEmpty();
    o.delete();
    if (empty) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** Lap joint split in the plane's frame: the negative side gets the notch. */
async function lapSplit(mesh: MeshData, plane: Plane, p: JointParams): Promise<{ above: MeshData; below: MeshData; lines: Float32Array; contours: [number, number]; tooDeep: boolean }> {
  const wasm = await getManifold();
  const n = plane.normal, c = plane.constant;
  const { u, v } = planeBasis(n);
  // to local: x = u, y = v, z = height above the plane (u × v = n keeps it right-handed)
  const toLocal = [u[0], v[0], n[0], 0, u[1], v[1], n[1], 0, u[2], v[2], n[2], 0, 0, 0, -c, 1];
  const toWorld = [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, n[0] * c, n[1] * c, n[2] * c, 1];
  const picks = (p.picks ?? []).map((q) => [dot(q, u), dot(q, v)] as [number, number]);
  // an inside-out part (all triangles facing in) would slice to nothing: turn it right way out
  const turned = applyMatrix(mesh, toLocal);
  const local = meshVolume(turned) < 0 ? flipMesh(turned) : turned;
  const box = computeBounds(local.positions);
  if (box.min[2] >= 0 || box.max[2] <= 0) throw new Error('The cut plane does not cross the part');
  const part = await toManifold(local);
  if (!part) throw new NotManifoldError('Part');
  const prof = lapProfile(p);
  const made: Manifold[] = [];
  const layers = new Map<number, LapRefs | null>();
  let refs0: LapRefs | null = null;
  const basis = p.basis ?? 'contours';
  // tongue & groove filling the wall: the offset counts from the holes as well, so the tongue sits b in from both sides
  const allLoops = p.kind === 'tongue' && !(p.width > 0);
  try {
    const section = part.slice(0);
    try {
      if (section.isEmpty()) throw new Error('The cut plane does not cross the part');
      if (basis === 'subcontours' && picks.length) {
        // only along the indicated stretches: a tab and its recess, the rest cut flat
        if (picks.length < 2) throw new Error('Indicate the end of the subcontour too (two points on the contour)');
        const stretches = findStretches(sectionLoops(section), picks, !!p.subFlip);
        if (!stretches.length) throw new Error('The two points of the subcontour must be apart on one contour');
        refs0 = lapRefs(wasm, section, picks.filter((_, i) => i % 2 === 0), allLoops);
        if (!refs0) throw new Error('No contour to joint: indicate a subcontour');
        const maxInset = allLoops ? maxInsetOf(refs0.regions, boundsDiagonal(box)) : 0;
        const r = subcontourSplit(wasm, part, refs0, stretches, p, box, maxInset);
        made.push(r.lo, r.hi);
        const below = applyMatrix(fromManifold(r.lo), toWorld), above = applyMatrix(fromManifold(r.hi), toWorld);
        if (!below.indices.length || !above.indices.length) throw new Error('The joint does not cross the part');
        const lines = applyMatrix({ positions: Float32Array.from(r.lines), indices: new Uint32Array(0) }, toWorld).positions as Float32Array;
        const a = Math.max(0, p.depth) + Math.max(0, p.frontClearance);
        return { above, below, lines, contours: [stretches.length, sectionLoops(section).length], tooDeep: a >= -box.min[2] };
      }
      refs0 = lapRefs(wasm, section, picks, allLoops);
    } finally {
      section.delete();
    }
    if (!refs0) throw new Error('No contour to joint: indicate a section contour');
    // the notch must fit inside the outline: at the offset some of the jointed material has to be left
    const start = Math.min(...prof.map(([s]) => s));
    const left = lapInset(refs0, start, refs0.regions);
    const fits = !left.isEmpty();
    if (left !== refs0.regions) left.delete();
    if (!fits) throw new Error('The notch does not fit inside the cross-section here: reduce the offset (b) or the tongue width');
    // a notch that follows the surface re-reads the contours every thin layer
    const straight = p.straight !== false;
    const a = Math.max(...prof.map(([, h]) => h));
    const step = Math.max(a / 24, 0.1);
    const extra: number[] = [];
    if (!straight) for (let h = step; h < a + Math.max(0, p.backClearance) + step; h += step) extra.push(h);
    const refsAt = (h: number): LapRefs | null => {
      if (straight) return refs0;
      const k = Math.round(h * 1e4) / 1e4;
      if (!layers.has(k)) {
        const sec = part.slice(k);
        try {
          layers.set(k, sec.isEmpty() ? null : lapRefs(wasm, sec, picks, allLoops));
        } finally {
          sec.delete();
        }
      }
      return layers.get(k)!;
    };
    const keep = lapCutter(wasm, refsAt, prof, box, 0, 0, 0, extra);
    made.push(keep);
    const g = lapCutter(wasm, refsAt, prof, box, Math.max(0, p.frontClearance), Math.max(0, p.notchClearance), Math.max(0, p.backClearance), extra);
    made.push(g);
    let lo = part.intersect(keep), hi = part.subtract(g);
    made.push(lo, hi);
    if (!straight) {
      // the thin layers leave many flat seams on walls that do not slope: merge them
      lo = lo.simplify(0.005);
      hi = hi.simplify(0.005);
      made.push(lo, hi);
    }
    const below = applyMatrix(fromManifold(lo), toWorld), above = applyMatrix(fromManifold(hi), toWorld);
    if (!below.indices.length || !above.indices.length) throw new Error('The joint does not cross the part');
    const tooDeep = a + Math.max(0, p.backClearance) >= box.max[2];
    // preview lines: the reference contours and the offset (b) line inside them
    const seg: number[] = [];
    loopSegments(refs0.refs.map((r) => r.pts), seg);
    if (start > 0)
      for (const r of refs0.refs) {
        const o = r.fill.offset(r.hole ? start : -start, 'Round', 2, 48);
        loopSegments(o.toPolygons().map((poly) => poly.map((q) => [q[0], q[1]] as [number, number])), seg);
        o.delete();
      }
    const lines = applyMatrix({ positions: Float32Array.from(seg), indices: new Uint32Array(0) }, toWorld).positions as Float32Array;
    return { above, below, lines, contours: [refs0.refs.length, refs0.loops], tooDeep };
  } finally {
    part.delete();
    made.forEach((m) => m.delete());
    freeRefs(refs0);
    layers.forEach((r) => r !== refs0 && freeRefs(r));
  }
}


// ---------------------------------------------------------------- pins & holes

/** Point inside closed loops (even-odd). */
function insideLoops(loops: [number, number][][], x: number, y: number): boolean {
  let inside = false;
  for (const l of loops)
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
      const [xi, yi] = l[i], [xj, yj] = l[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

/** Points every `spacing` along a closed loop, half a spacing in from its start. */
function alongLoop(l: [number, number][], spacing: number): [number, number][] {
  const seg: number[] = [];
  let len = 0;
  for (let i = 0; i < l.length; i++) {
    const [x0, y0] = l[i], [x1, y1] = l[(i + 1) % l.length];
    seg.push(Math.hypot(x1 - x0, y1 - y0));
    len += seg[i];
  }
  if (len < 1e-9) return [];
  const n = Math.max(1, Math.floor(len / spacing));
  const step = len / n;
  const out: [number, number][] = [];
  let i = 0, at = 0;
  for (let k = 0; k < n; k++) {
    const d = (k + 0.5) * step;
    while (i < l.length - 1 && at + seg[i] < d) at += seg[i++];
    const f = seg[i] > 0 ? (d - at) / seg[i] : 0;
    const [x0, y0] = l[i], [x1, y1] = l[(i + 1) % l.length];
    out.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]);
  }
  return out;
}

/**
 * Pins & holes split in the plane's frame: the part is cut flat, then pins
 * stand on the negative piece and matching holes go into the positive one (or
 * holes into both, for loose pins). The pins run in a row inside the indicated
 * contours, `pinSpacing` apart; a pin is left out where it would not fit in the
 * material with its clearance.
 */
async function pinSplit(mesh: MeshData, plane: Plane, p: JointParams): Promise<{ above: MeshData; below: MeshData; loose?: MeshData; lines: Float32Array; pins: number; inset: number; contours: [number, number]; tooDeep: boolean }> {
  const wasm = await getManifold();
  const n = plane.normal, c0 = plane.constant;
  const { u, v } = planeBasis(n);
  const toLocal = [u[0], v[0], n[0], 0, u[1], v[1], n[1], 0, u[2], v[2], n[2], 0, 0, 0, -c0, 1];
  const toWorld = [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, n[0] * c0, n[1] * c0, n[2] * c0, 1];
  const picks = (p.picks ?? []).map((q) => [dot(q, u), dot(q, v)] as [number, number]);
  const r = Math.max(0.05, p.pinRadius), h = Math.max(0.1, p.pinHeight), a = Math.max(2 * r + 0.1, p.pinSpacing);
  const { top, side, face } = pinClearances(p);
  const tol = Math.min(Math.max(1e-3, p.pinTolerance || 0.02), r / 2);
  const segs = Math.max(8, Math.min(128, Math.ceil(Math.PI / Math.acos(1 - tol / (r + side)))));
  const turned = applyMatrix(mesh, toLocal);
  const local = meshVolume(turned) < 0 ? flipMesh(turned) : turned;
  const box = computeBounds(local.positions);
  if (box.min[2] >= 0 || box.max[2] <= 0) throw new Error('The cut plane does not cross the part');
  const part = await toManifold(local);
  if (!part) throw new NotManifoldError('Part');
  const made: Manifold[] = [];
  const temp: CrossSection[] = [];
  let refs: LapRefs | null = null;
  try {
    const section = part.slice(0);
    temp.push(section);
    if (section.isEmpty()) throw new Error('The cut plane does not cross the part');
    // subcontours: pins only along the stretches between pairs of indicated points
    const subMode = p.basis === 'subcontours' && picks.length > 0;
    if (subMode && picks.length < 2) throw new Error('Indicate the end of the subcontour too (two points on the contour)');
    const stretches = subMode ? findStretches(sectionLoops(section), picks, !!p.subFlip) : [];
    if (subMode && !stretches.length) throw new Error('The two points of the subcontour must be apart on one contour');
    refs = lapRefs(wasm, section, subMode ? picks.filter((_, i) => i % 2 === 0) : picks);
    if (!refs) throw new Error('No contour for the pins: indicate a section contour');
    // how far in the material reaches: in a thin wall the row runs down its middle
    let lo = 0, hi = boundsDiagonal(box);
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2, o = refs.regions.offset(-mid, 'Round', 2, 32);
      const empty = o.isEmpty();
      o.delete();
      if (empty) hi = mid;
      else lo = mid;
    }
    const inset = p.pinInset > 0 ? p.pinInset : Math.min(r + side + Math.max(r, 1), lo * 0.98);
    // a pin (with its hole) must sit fully in the material
    const fit = refs.regions.offset(-(r + side) * 0.999, 'Round', 2, 32);
    temp.push(fit);
    const fitLoops = polys(fit);
    const centres: [number, number][] = [];
    if (subMode) {
      // the row runs along each stretch itself, inset towards the material
      const zone = stretchZone(wasm, stretches, inset + r + side + 1, 0);
      temp.push(zone);
      const zoneLoops = polys(zone);
      for (const st of stretches) {
        const fill = new wasm.CrossSection([st.loop], 'NonZero');
        const row = fill.offset(st.hole ? inset : -inset, 'Round', 2, 64);
        temp.push(fill, row);
        // walk the row only where it lies along the stretch
        for (const l of polys(row)) {
          const pts = alongLoop(l, Math.min(a, 0.5)).filter((q) => insideLoops(zoneLoops, q[0], q[1]));
          let last: [number, number] | null = null, run = 0;
          for (const q of pts) {
            if (last) run += Math.hypot(q[0] - last[0], q[1] - last[1]);
            if ((!last || run >= a) && insideLoops(fitLoops, q[0], q[1])) {
              centres.push(q);
              run = 0;
            }
            last = q;
          }
        }
      }
    } else
      for (const ref of refs.refs) {
        const row = ref.fill.offset(-inset, 'Round', 2, 64);
        temp.push(row);
        for (const l of polys(row)) if (loopArea(l) > 0) for (const q of alongLoop(l, a)) if (insideLoops(fitLoops, q[0], q[1])) centres.push(q);
      }
    if (!centres.length) throw new Error('No room for pins inside the contour: use a smaller radius or side clearance, or another distance from the contour');
    const cyl = (radius: number, z0: number, z1: number) =>
      wasm.Manifold.union(centres.map(([x, y]) => wasm.Manifold.cylinder(z1 - z0, radius, radius, segs).translate([x, y, z0])));
    const [upper, lower] = part.splitByPlane([0, 0, 1], 0);
    made.push(upper, lower);
    let above = face > 0 ? upper.trimByPlane([0, 0, 1], face) : upper;
    if (above !== upper) made.push(above);
    let below = lower;
    let loose: Manifold | null = null;
    const eps = 0.01;
    if (p.pinType === 'holes') {
      // holes half the pin deep on each side, plus the top clearance
      const holeLo = cyl(r + side, -(h / 2 + top), eps), holeHi = cyl(r + side, face - eps, face + h / 2 + top);
      made.push(holeLo, holeHi);
      below = lower.subtract(holeLo);
      above = above.subtract(holeHi);
      made.push(below, above);
      if (p.loosePins) {
        loose = cyl(r, -h / 2, h / 2);
        made.push(loose);
      }
    } else {
      const pins = cyl(r, -eps, h), holes = cyl(r + side, face - eps, h + top);
      made.push(pins, holes);
      below = lower.add(pins);
      above = above.subtract(holes);
      made.push(below, above);
    }
    const belowM = applyMatrix(fromManifold(below), toWorld), aboveM = applyMatrix(fromManifold(above), toWorld);
    if (!belowM.indices.length || !aboveM.indices.length) throw new Error('The cut does not cross the part');
    // preview lines: the contours and a circle for each pin
    const seg: number[] = [];
    if (subMode) for (const st of stretches) for (let i = 0; i + 1 < st.pts.length; i++) seg.push(st.pts[i][0], st.pts[i][1], 0, st.pts[i + 1][0], st.pts[i + 1][1], 0);
    else loopSegments(refs.refs.map((x) => x.pts), seg);
    const circle = Array.from({ length: 16 }, (_, i) => [Math.cos((i / 16) * 2 * Math.PI) * r, Math.sin((i / 16) * 2 * Math.PI) * r] as [number, number]);
    loopSegments(centres.map(([x, y]) => circle.map(([cx, cy]) => [x + cx, y + cy] as [number, number])), seg);
    const lines = applyMatrix({ positions: Float32Array.from(seg), indices: new Uint32Array(0) }, toWorld).positions as Float32Array;
    const reach = p.pinType === 'holes' ? h / 2 + top : h + top;
    return {
      above: aboveM,
      below: belowM,
      loose: loose ? applyMatrix(fromManifold(loose), toWorld) : undefined,
      lines,
      pins: centres.length,
      inset,
      contours: subMode ? [stretches.length, refs.loops] : [refs.refs.length, refs.loops],
      tooDeep: reach + face >= box.max[2] || (p.pinType === 'holes' ? reach : 0) >= -box.min[2],
    };
  } finally {
    part.delete();
    made.forEach((m) => m.delete());
    temp.forEach((c) => c.delete());
    freeRefs(refs);
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
  /** lap joints: the reference contours and the offset line (world-space segments, for the preview) */
  lines?: Float32Array;
  /** lap joints: contours the offset counts from, of all the section's contours */
  contours?: [number, number];
  /** pins & holes: number of pins placed, and the loose pins (holes in both pieces) */
  pins?: number;
  loose?: MeshData;
  /** pins & holes: distance of the row in from the contour, mm */
  inset?: number;
}

/**
 * Split a closed part along a joint surface. Lap joints put the notch on the
 * piece on the negative side of the plane (the positive side with `negative`).
 */
export async function jointSplit(mesh: MeshData, plane: Plane, p: JointParams): Promise<JointResult> {
  const flip = !!p.negative;
  const pl: Plane = flip ? { normal: [-plane.normal[0], -plane.normal[1], -plane.normal[2]], constant: -plane.constant } : plane;
  const swap = (r: { above: MeshData; below: MeshData }) => (flip ? { above: r.below, below: r.above } : { above: r.above, below: r.below });
  if (isPinJoint(p.kind)) {
    // pins on the other piece: the same with the plane turned round
    const r = await pinSplit(mesh, pl, p);
    return { ...swap(r), loose: r.loose, tooDeep: r.tooDeep, lines: r.lines, contours: r.contours, pins: r.pins, inset: r.inset };
  }
  if (!isAcrossJoint(p.kind)) {
    const r = await lapSplit(mesh, pl, p);
    return { ...swap(r), tooDeep: r.tooDeep, lines: r.lines, contours: r.contours };
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
