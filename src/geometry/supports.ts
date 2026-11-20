/**
 * Support generation for SLA, DLP and DMLS.
 *
 * 1. Overhang analysis: downward-facing triangles that make less than the
 *    critical angle with the platform need support; they are grouped into
 *    connected areas ("clusters"), and areas below the minimal size are dropped.
 * 2. Supports below the areas, down to the platform (or onto the part below):
 *    - volume: a grid of thin walls under each area (DMLS block / lattice support),
 *    - bar: a pin (cylinder) at every grid point,
 *    - tip: SLA / DLP supports, a cone tip at the contact point on a rod, with a
 *      wider foot on the platform, a cone onto the part below, and an optional raft.
 *
 * The part is lifted `lift` mm above the platform (z = 0) first; everything is
 * returned in that lifted position.
 */
import { DoubleSide, Ray, ShapeUtils, Vector2, Vector3 } from 'three';

import type { Manifold } from 'manifold-3d';
import { MeshData, Vec3, computeBounds, triangleCount } from './mesh';
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { buildTopology } from './topology';
import { fromManifold, getManifold } from './manifold';

export type SupportTech = 'sla' | 'dlp' | 'dmls';
export type SupportStyle = 'volume' | 'bar' | 'tip' | 'block';

export interface SupportParams {
  tech: SupportTech;
  style: SupportStyle;
  /** surfaces making less than this angle with the platform get supports, degrees */
  criticalAngle: number;
  /** support areas smaller than this are left out, mm² */
  minArea: number;
  /** distance between the part and the platform, mm */
  lift: number;
  /** grid spacing of walls / bars / tips, mm */
  spacing: number;
  /** volume: wall thickness; bar: bar diameter, mm */
  wall: number;
  /** tip: contact diameter at the part, mm */
  tipDiameter: number;
  /** bar (and the branch bars of block supports): diameter of the touch point on the part, mm; 0 = as thick as the bar */
  touchDiameter: number;
  /** bar: length of the taper from the bar down to the touch point, mm */
  touchLength: number;
  /** tip: length of the cone tip, mm */
  tipLength: number;
  /** tip: rod diameter, mm */
  bodyDiameter: number;
  /** tip: foot diameter on the platform, mm */
  baseDiameter: number;
  /** how far the supports reach into the part (+) or stop short of it (−), mm */
  penetration: number;
  /** supports may stand on the part itself where it lies below an area */
  onPart: boolean;
  /** SLA / DLP: a raft (base plate) under the supports */
  raft: boolean;
  raftThickness: number;
  /** grid spacing across (Y direction of the grid), mm; 0 = same as `spacing` */
  spacingY: number;
  /** turn of the support grid about Z, degrees */
  gridAngle: number;
  /** tip / bar: supports along the outline of each area, this far apart (0 = none), mm */
  perimeter: number;
  /** supports from the overhang analysis (off: only the supports added by hand) */
  auto: boolean;
  /** a lifted part also stands on its lowest surfaces where nothing overhangs */
  lowest: boolean;
  /** raft: how far it reaches past the outermost feet, mm */
  raftMargin: number;
  /** tip / bar: zigzag braces between neighbouring supports taller than `braceHeight` */
  braces: boolean;
  braceHeight: number;
  /** supports not allowed to stand on the part: slope of the branch to the support beside them, degrees from horizontal */
  branchAngle: number;
  /** tip: height of the foot (cone onto the platform / raft), mm; 0 = from the diameters */
  footHeight: number;
  /** tip: contact diameter where a support stands on the part below, mm; 0 = the tip's */
  bottomDiameter: number;
  /** raft shape under the supports (when `raft` is on) */
  raftType: RaftType;
  /** protection case: height of the wall round the raft, mm; 0 = up to the part's bottom (the lift) */
  caseHeight: number;
  /** hexagonal grid: size of the holes (corner to corner), mm; 0 = from the support spacing */
  raftHole: number;
  /** hexagonal grid: width of the ribs between the holes; protection case: thickness of the wall, mm; 0 = from the foot size */
  raftRib: number;
  /** skate / cross grid: width of the bars, mm; 0 = from the foot size */
  raftBar: number;
  /** skate / cross grid: diameter of the pad under each foot, mm; 0 = the foot's diameter */
  raftPad: number;
  /**
   * block supports: thickness of the walls, mm: the printer's laser spot size
   * (or pixel size), so each wall is one path of the laser (filled in from the
   * printer when 0)
   */
  spot: number;
  /** block: walls kept this far inside the outline of each area (XY offset), mm */
  blockInset: number;
  /** block: a wall along the outline of each area */
  blockBorder: boolean;
  /** block: teeth on top of the walls (small contacts, easy to break off): height, top length, base length, gap between teeth bases, mm */
  teeth: boolean;
  teethHeight: number;
  teethTop: number;
  teethBase: number;
  teethGap: number;
  /** block: the same teeth at the bottom where a wall stands on the part */
  lowerTeeth: boolean;
  /** block: walls cut into pieces (easier removal): interval along X / Y hatching, gap width, mm */
  fragment: boolean;
  fragX: number;
  fragY: number;
  fragWidth: number;
  /** block: a cross grid inside the walls (diagonal bars between diamond openings, less material): bar width, bar angle, cell (opening) height, solid band at top and bottom, solid zone at the wall ends */
  perforate: boolean;
  perfBeam: number;
  perfAngle: number;
  perfHeight: number;
  perfSolid: number;
  perfZone: number;
}

/** Touch points of bar supports (and of the bars block supports branch out with): a short taper onto the part. */
export const TOUCH_DEFAULTS = { touchDiameter: 0.3, touchLength: 0.6 };

/** Radius and taper length of a bar's touch point (bar radius `r`, support `len` long). */
export function touchOf(p: Pick<SupportParams, 'touchDiameter' | 'touchLength'>, r: number, len: number): { rt: number; l: number } {
  const d = p.touchDiameter ?? 0;
  if (!(d > 0) || d / 2 >= r - 1e-6) return { rt: r, l: 0 };
  return { rt: Math.max(0.025, d / 2), l: Math.min(Math.max(0, p.touchLength ?? 0), len * 0.4) };
}

/** The block support defaults (as in the usual block support profiles); the hatching uses spacing / spacing Y / grid angle. */
export const BLOCK_DEFAULTS = {
  spot: 0,
  blockInset: 0.5,
  blockBorder: true,
  teeth: true,
  teethHeight: 1.2,
  teethTop: 0.3,
  teethBase: 0.6,
  teethGap: 0.1,
  lowerTeeth: true,
  fragment: true,
  fragX: 4.8,
  fragY: 4.8,
  fragWidth: 1.2,
  perforate: true,
  perfBeam: 0.4,
  perfAngle: 50,
  perfHeight: 1,
  perfSolid: 1,
  perfZone: 0,
};

/** Raft shapes: none, rails (skate), a grid of bars, a plate with hexagonal holes, a solid plate, a solid plate walled round (protection case). */
export type RaftType = 'none' | 'skate' | 'cross' | 'hex' | 'solid' | 'case';
export const RAFT_TYPES: { value: RaftType; label: string; title: string }[] = [
  { value: 'none', label: 'None', title: 'No raft: the supports stand on the platform' },
  { value: 'skate', label: 'Skate', title: 'Rails under each row of supports' },
  { value: 'cross', label: 'Cross grid', title: 'Bars joining every support to its neighbours in both directions' },
  { value: 'hex', label: 'Hexagonal grid', title: 'A plate with hexagonal holes: light, peels off easily' },
  { value: 'solid', label: 'Bottom connected', title: 'A solid plate joining the bottoms of all supports' },
  { value: 'case', label: 'Protection case', title: 'A solid plate with a wall round it, protecting the supports' },
];

/** Supports changed by hand, in the frame the supports are made in (the turned part, before lifting). */
export interface SupportEdits {
  /** points on the part (surface facing down) that get a support */
  add: Vec3[];
  /** contact points whose supports are removed, with a radius (0: just that one) */
  remove: [number, number, number, number][];
}

/** The sizes of a support (drawn with their values in the Supports panel). */
export type SupportShape = Pick<SupportParams, 'tipDiameter' | 'penetration' | 'tipLength' | 'bodyDiameter' | 'bottomDiameter' | 'footHeight' | 'baseDiameter'>;

/** The standard support scripts. */
export const SUPPORT_PRESETS: Record<SupportTech, SupportParams> = {
  sla: {
    tech: 'sla', style: 'tip', criticalAngle: 40, minArea: 0.5, lift: 5, spacing: 2.5, wall: 0.4, tipDiameter: 0.4, tipLength: 1.5,
    bodyDiameter: 1.0, baseDiameter: 2.5, penetration: 0.2, onPart: true, raft: true, raftThickness: 1,
    spacingY: 2.5, gridAngle: 0, perimeter: 0, auto: true, lowest: true, raftMargin: 1, braces: true, braceHeight: 10, branchAngle: 45, footHeight: 1, bottomDiameter: 0.5, raftType: 'solid', caseHeight: 0, raftHole: 0, raftRib: 0, raftBar: 0, raftPad: 0, ...TOUCH_DEFAULTS, ...BLOCK_DEFAULTS,
  },
  dlp: {
    tech: 'dlp', style: 'tip', criticalAngle: 40, minArea: 0.3, lift: 5, spacing: 2, wall: 0.4, tipDiameter: 0.35, tipLength: 1.2,
    bodyDiameter: 0.8, baseDiameter: 2, penetration: 0.15, onPart: true, raft: true, raftThickness: 0.8,
    spacingY: 2, gridAngle: 0, perimeter: 0, auto: true, lowest: true, raftMargin: 1, braces: true, braceHeight: 10, branchAngle: 45, footHeight: 1, bottomDiameter: 0.5, raftType: 'solid', caseHeight: 0, raftHole: 0, raftRib: 0, raftBar: 0, raftPad: 0, ...TOUCH_DEFAULTS, ...BLOCK_DEFAULTS,
  },
  dmls: {
    tech: 'dmls', style: 'block', criticalAngle: 45, minArea: 0.1, lift: 3, spacing: 1, wall: 0.3, tipDiameter: 0.4, tipLength: 1,
    bodyDiameter: 1, baseDiameter: 1, penetration: 0.1, onPart: true, raft: false, raftThickness: 0,
    spacingY: 1, gridAngle: 0, perimeter: 0, auto: true, lowest: true, raftMargin: 0, braces: false, braceHeight: 10, branchAngle: 45, footHeight: 1, bottomDiameter: 0.5, raftType: 'none', caseHeight: 0, raftHole: 0, raftRib: 0, raftBar: 0, raftPad: 0, ...TOUCH_DEFAULTS, ...BLOCK_DEFAULTS,
  },
};

export interface OverhangArea {
  /** triangle ids (into the lifted mesh) */
  tris: number[];
  area: number;
}

export interface SupportResult {
  /** the part, lifted */
  part: MeshData;
  /** how far it was moved up, mm */
  dz: number;
  /** the overhang areas (to show in red) */
  overhangs: MeshData;
  areas: number;
  /** areas left out by the user */
  skipped: number;
  supports: MeshData;
  /** the raft under the supports (its own mesh, so it can be hidden while editing supports) */
  raft: MeshData;
  /** bars / tips / walls made */
  count: number;
  supportVolume: number;
  /** block supports: area of the zero-thickness walls, mm² */
  supportArea: number;
  /** where each support touches the part (x, y, z in the lifted frame), for picking supports by hand */
  contacts: Float32Array;
  /** for each touch point: the index of the point added by hand it belongs to, −1 for generated ones */
  manual: Int32Array;
}

/** Overhang areas of a mesh (already in its printing position), largest first. */
export function overhangAreas(mesh: MeshData, criticalAngle: number, minArea: number, floorZ: number): OverhangArea[] {
  const p = mesh.positions, idx = mesh.indices, nt = triangleCount(mesh);
  const limit = Math.cos((Math.max(0, Math.min(89.9, criticalAngle)) * Math.PI) / 180);
  const need = new Uint8Array(nt);
  const area = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    area[t] = l / 2;
    // facing down, and flatter than the critical angle (angle to the platform = acos(-nz))
    if (-nz / l < limit) continue;
    // resting on the platform needs nothing
    if (Math.max(p[a + 2], p[b + 2], p[c + 2]) <= floorZ + 1e-4) continue;
    need[t] = 1;
  }
  // connected areas
  const topo = buildTopology(mesh);
  const seen = new Uint8Array(nt);
  const out: OverhangArea[] = [];
  for (let s = 0; s < nt; s++) {
    if (!need[s] || seen[s]) continue;
    const tris: number[] = [];
    const stack = [s];
    seen[s] = 1;
    let sum = 0;
    while (stack.length) {
      const t = stack.pop()!;
      tris.push(t);
      sum += area[t];
      for (let e = 0; e < 3; e++) {
        const edge = topo.halfEdgeEdge[t * 3 + e];
        const h0 = topo.edgeHE0[edge], h1 = topo.edgeHE1[edge];
        const o = h0 === t * 3 + e ? h1 : h0;
        if (o < 0) continue;
        const u = (o / 3) | 0;
        if (need[u] && !seen[u]) {
          seen[u] = 1;
          stack.push(u);
        }
      }
    }
    if (sum >= minArea) out.push({ tris, area: sum });
  }
  return out.sort((a, b) => b.area - a.area);
}

/** Triangles of a mesh as a mesh of their own, moved out along their normals a little (to draw on top). */
function subMesh(mesh: MeshData, tris: number[], lift = 0.02): MeshData {
  const p = mesh.positions, idx = mesh.indices;
  const pos = new Float32Array(tris.length * 9);
  tris.forEach((t, k) => {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx = (nx / l) * lift;
    ny = (ny / l) * lift;
    nz = (nz / l) * lift;
    [a, b, c].forEach((v, j) => {
      pos[k * 9 + j * 3] = p[v] + nx;
      pos[k * 9 + j * 3 + 1] = p[v + 1] + ny;
      pos[k * 9 + j * 3 + 2] = p[v + 2] + nz;
    });
  });
  return { positions: pos, indices: Uint32Array.from({ length: tris.length * 3 }, (_, i) => i) };
}

/** BVH whose face indices are the mesh's own triangle ids (the default one reorders them). */
function makeBVH(mesh: MeshData): MeshBVH {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  g.setIndex(new BufferAttribute(mesh.indices, 1));
  return new MeshBVH(g, { indirect: true });
}

/** A support column at (x, y): from `bottom` (platform or part below) up to the area at `top`. */
interface Column {
  x: number;
  y: number;
  top: number;
  bottom: number;
  onPart: boolean;
  /** area index; −1 for supports added by hand */
  area: number;
  /** grid position (along the grid's two directions) and grid index, for walls and braces; NaN off the grid */
  u: number;
  v: number;
  gi: number;
  gj: number;
  /** added by hand: the index of its point in the edits */
  manual?: number;
  /** part of a block added by hand, but not its centre (no touch point of its own) */
  noContact?: boolean;
}

interface Grid {
  su: number;
  sv: number;
  cos: number;
  sin: number;
}

const gridOf = (p: Pick<SupportParams, 'spacing' | 'spacingY' | 'gridAngle'>): Grid => {
  const a = ((p.gridAngle ?? 0) * Math.PI) / 180;
  const su = Math.max(0.2, p.spacing);
  return { su, sv: p.spacingY > 0 ? Math.max(0.2, p.spacingY) : su, cos: Math.cos(a), sin: Math.sin(a) };
};

/** Vertical ray through (x, y): the hits sorted from the bottom up. */
function hitsAt(bvh: MeshBVH, x: number, y: number) {
  const ray = new Ray(new Vector3(x, y, -1e4), new Vector3(0, 0, 1));
  return bvh.raycast(ray, DoubleSide).sort((a, b) => a.distance - b.distance);
}

/** Normal z of a triangle (unit normal). */
function normalZ(mesh: MeshData, t: number): number {
  const p = mesh.positions, idx = mesh.indices;
  const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return nz / (Math.hypot(nx, ny, nz) || 1);
}

/**
 * Columns under the areas on a grid (turned by the grid angle, its own
 * spacing in each direction): a vertical ray at each grid point; where it
 * meets an overhang triangle from below, the column runs from the surface
 * below it (or the platform) up to that triangle. With `perimeter` > 0,
 * columns also follow the outline of each area.
 */
function columnsUnder(mesh: MeshData, bvh: MeshBVH, areas: OverhangArea[], g: Grid, perimeter: number): Column[] {
  const p = mesh.positions, idx = mesh.indices;
  const areaOf = new Int32Array(triangleCount(mesh)).fill(-1);
  areas.forEach((a, i) => a.tris.forEach((t) => (areaOf[t] = i)));
  const out: Column[] = [];
  const toUV = (x: number, y: number): [number, number] => [x * g.cos + y * g.sin, -x * g.sin + y * g.cos];
  const toXY = (u: number, v: number): [number, number] => [u * g.cos - v * g.sin, u * g.sin + v * g.cos];
  const offU = g.su / 2, offV = g.sv / 2;
  areas.forEach((ar, ai) => {
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const t of ar.tris)
      for (let k = 0; k < 3; k++) {
        const vi = idx[t * 3 + k] * 3;
        const [u, v] = toUV(p[vi], p[vi + 1]);
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
        v0 = Math.min(v0, v);
        v1 = Math.max(v1, v);
      }
    const found: Column[] = [];
    /** the column at (x, y) up to this area (nearest to `nearZ` when given) */
    const tryAt = (x: number, y: number, u: number, v: number, gi: number, gj: number, nearZ?: number) => {
      const hits = hitsAt(bvh, x, y);
      let best = -1;
      for (let h = 0; h < hits.length; h++) {
        const f = hits[h].faceIndex ?? -1;
        if (f < 0 || areaOf[f] !== ai) continue;
        if (nearZ === undefined) {
          best = h;
          break;
        }
        if (best < 0 || Math.abs(hits[h].point.z - nearZ) < Math.abs(hits[best].point.z - nearZ)) best = h;
      }
      if (best < 0) return false;
      const below = best > 0 ? hits[best - 1].point.z : null;
      found.push({ x, y, top: hits[best].point.z, bottom: below ?? 0, onPart: below !== null, area: ai, u, v, gi, gj });
      return true;
    };
    // grid points over the area (offset so neighbouring areas line up)
    for (let gi = Math.ceil((u0 - offU) / g.su); gi * g.su + offU <= u1; gi++)
      for (let gj = Math.ceil((v0 - offV) / g.sv); gj * g.sv + offV <= v1; gj++) {
        const u = gi * g.su + offU, v = gj * g.sv + offV;
        const [x, y] = toXY(u, v);
        tryAt(x, y, u, v, gi, gj);
      }
    if (!found.length) {
      // a small area between grid points: one support at its middle
      let cx = 0, cy = 0;
      for (const t of ar.tris)
        for (let k = 0; k < 3; k++) {
          const vi = idx[t * 3 + k] * 3;
          cx += p[vi];
          cy += p[vi + 1];
        }
      tryAt(cx / (ar.tris.length * 3), cy / (ar.tris.length * 3), NaN, NaN, NaN, NaN);
    }
    if (perimeter > 0) {
      // the outline: edges between a triangle of the area and one outside it, walked as loops
      const inArea = new Set(ar.tris);
      const next = new Map<number, [number, number, number]>(); // start vertex → [end vertex, triangle, ]
      for (const t of ar.tris)
        for (let e = 0; e < 3; e++) {
          const a = idx[t * 3 + e], b = idx[t * 3 + ((e + 1) % 3)];
          const o = otherSide(mesh, t, e);
          if (o >= 0 && inArea.has(o)) continue;
          next.set(a, [b, t, 0]);
        }
      const step = Math.max(0.3, perimeter);
      const inset = Math.min(0.5, step / 4);
      const done = new Set<number>();
      for (const start of next.keys()) {
        if (done.has(start)) continue;
        let carry = step / 2;
        let a = start;
        while (!done.has(a) && next.has(a)) {
          done.add(a);
          const [b, t] = next.get(a)!;
          const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2], bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2];
          const len = Math.hypot(bx - ax, by - ay);
          // towards the inside: the middle of the area's triangle on this edge
          const c = idx[t * 3] * 3, d = idx[t * 3 + 1] * 3, f = idx[t * 3 + 2] * 3;
          const mx = (p[c] + p[d] + p[f]) / 3, my = (p[c + 1] + p[d + 1] + p[f + 1]) / 3;
          while (carry <= len) {
            const s = len > 0 ? carry / len : 0;
            let x = ax + (bx - ax) * s, y = ay + (by - ay) * s;
            const z = az + (bz - az) * s;
            const ix = mx - x, iy = my - y, il = Math.hypot(ix, iy);
            if (il > 1e-9) {
              const k = Math.min(inset, il * 0.9) / il;
              x += ix * k;
              y += iy * k;
            }
            const [u, v] = toUV(x, y);
            // keep away from the grid supports
            if (!found.some((q) => Math.hypot(q.x - x, q.y - y) < step * 0.45)) tryAt(x, y, u, v, NaN, NaN, z);
            carry += step;
          }
          carry -= len;
          a = b;
        }
      }
    }
    out.push(...found);
  });
  return out;
}

/** The triangle on the other side of edge e of triangle t (−1 at an open edge). */
let topoCache: { mesh: MeshData; topo: ReturnType<typeof buildTopology> } | null = null;
function otherSide(mesh: MeshData, t: number, e: number): number {
  if (topoCache?.mesh !== mesh) topoCache = { mesh, topo: buildTopology(mesh) };
  const topo = topoCache.topo;
  const edge = topo.halfEdgeEdge[t * 3 + e];
  const h0 = topo.edgeHE0[edge], h1 = topo.edgeHE1[edge];
  const o = h0 === t * 3 + e ? h1 : h0;
  return o < 0 ? -1 : (o / 3) | 0;
}

/**
 * A support added by hand under the point q: on the surface facing down at
 * q, or (q clicked on top of the part) on the nearest surface facing down
 * below it; null when there is none there.
 */
function manualColumn(mesh: MeshData, bvh: MeshBVH, q: Vec3, index: number, near?: number, within = Infinity): Column | null {
  const hits = hitsAt(bvh, q[0], q[1]);
  const z = near ?? q[2];
  let best = -1, bestBelow = -1;
  for (let h = 0; h < hits.length; h++) {
    const f = hits[h].faceIndex ?? -1;
    if (f < 0 || normalZ(mesh, f) > -0.02) continue;
    const hz = hits[h].point.z;
    if (hz <= z + 0.05 && (bestBelow < 0 || hz > hits[bestBelow].point.z)) bestBelow = h;
    if (best < 0 || Math.abs(hz - z) < Math.abs(hits[best].point.z - z)) best = h;
  }
  const pick = near === undefined && bestBelow >= 0 ? bestBelow : best;
  if (pick < 0 || Math.abs(hits[pick].point.z - z) > within) return null;
  const below = pick > 0 ? hits[pick - 1].point.z : null;
  return { x: q[0], y: q[1], top: hits[pick].point.z, bottom: below ?? 0, onPart: below !== null, area: -1, u: NaN, v: NaN, gi: NaN, gj: NaN, manual: index };
}

/**
 * DMLS: a block added by hand, a 3 × 3 patch of grid points round q (in the
 * grid's directions) made into walls like the generated ones; only its
 * centre has a touch point.
 */
function manualBlock(mesh: MeshData, bvh: MeshBVH, q: Vec3, index: number, g: Grid): Column[] {
  const centre = manualColumn(mesh, bvh, q, index);
  if (!centre) return [];
  const out: Column[] = [];
  const area = -2 - index;
  // q in the grid's own frame: the walls are laid out (and turned into place) from absolute grid coordinates
  const qu = q[0] * g.cos + q[1] * g.sin, qv = -q[0] * g.sin + q[1] * g.cos;
  for (let a = -1; a <= 1; a++)
    for (let b = -1; b <= 1; b++) {
      const u = qu + a * g.su, v = qv + b * g.sv;
      const x = u * g.cos - v * g.sin, y = u * g.sin + v * g.cos;
      const c = a === 0 && b === 0 ? { ...centre } : manualColumn(mesh, bvh, [x, y, centre.top], index, centre.top, Math.max(g.su, g.sv) * 2);
      if (!c) continue;
      out.push({ ...c, area, u, v, gi: a, gj: b, noContact: a !== 0 || b !== 0 });
    }
  return out;
}

/**
 * A lifted part has to stand on something even where nothing overhangs at the
 * critical angle (e.g. turned 45°): the lowest down-facing triangles (within
 * half a support spacing of the bottom) are added as an area of their own.
 */
function withLowest(part: MeshData, areas: OverhangArea[], lift: number, spacing: number): OverhangArea[] {
  if (!(lift > 0)) return areas;
  const p = part.positions, idx = part.indices, nt = triangleCount(part);
  const used = new Set<number>();
  for (const a of areas) for (const t of a.tris) used.add(t);
  const band = lift + Math.max(0.3, spacing / 2);
  const tris: number[] = [];
  let area = 0;
  for (let t = 0; t < nt; t++) {
    if (used.has(t)) continue;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    if (Math.min(p[a + 2], p[b + 2], p[c + 2]) > band) continue;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12 || nz / l > -0.05) continue;
    tris.push(t);
    area += l / 2;
  }
  return tris.length ? [...areas, { tris, area }] : areas;
}

/** Areas the user clicked off: the one under each point (given in the part's position before lifting). */
function skippedAreas(part: MeshData, all: OverhangArea[], skip: Vec3[], dz: number): Set<number> {
  const skipped = new Set<number>();
  if (!skip.length) return skipped;
  const bvh = makeBVH(part);
  const target = { point: new Vector3(), distance: 0, faceIndex: 0 };
  const triArea = new Map<number, number>();
  all.forEach((a, i) => a.tris.forEach((t) => triArea.set(t, i)));
  for (const q of skip) {
    const r = bvh.closestPointToPoint(new Vector3(q[0], q[1], q[2] + dz), target as never);
    const ai = r ? triArea.get(r.faceIndex) : undefined;
    if (ai !== undefined && r!.distance < 2) skipped.add(ai);
  }
  return skipped;
}

/** A rod of radius r from a to b. */
function rodBetween(M: typeof Manifold, a: Vec3, b: Vec3, r: number): Manifold {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  const tilt = (Math.acos(Math.max(-1, Math.min(1, dz / (len || 1)))) * 180) / Math.PI;
  const turn = (Math.atan2(dy, dx) * 180) / Math.PI;
  return M.cylinder(len, r, r, 8).rotate([0, tilt, turn]).translate(a);
}

/**
 * Supports that would have to stand on the part (not allowed): each gets its
 * tip and a short drop straight down, then a rod sloping down at the branch
 * angle to the nearest free-standing support it can reach without passing
 * through the part. Where there is none, a new support is put up beside the
 * part (on the platform, clear of the part above it) to hang it from.
 */
function branchSupports(
  M: typeof Manifold,
  bvh: MeshBVH,
  blocked: Column[],
  free: Column[],
  p: SupportParams,
  g: Grid,
  solids: Manifold[],
  made: Column[],
  feet: [number, number][],
) {
  const pen = p.penetration;
  const tip = p.style === 'tip';
  const rt = Math.max(0.05, p.tipDiameter / 2), rb = Math.max(rt, p.bodyDiameter / 2), rf = Math.max(rb, p.baseDiameter / 2);
  const r = tip ? rb : p.style === 'bar' ? Math.max(0.1, p.wall / 2) : Math.max(0.3, p.wall);
  const floor = tip && raftOn(p) ? Math.max(0, p.raftThickness) : 0;
  const footL = tip ? footOf(p) : 0;
  const slope = Math.tan((Math.max(20, Math.min(80, p.branchAngle ?? 45)) * Math.PI) / 180);
  const lowest = floor + footL + 0.5;
  // targets: free-standing supports (the rod between its foot and its tip), and the new ones put up here
  type Target = { x: number; y: number; lo: number; hi: number };
  const targets: Target[] = free
    .filter((c) => !c.onPart)
    .map((c) => ({ x: c.x, y: c.y, lo: lowest, hi: c.top + pen - (tip ? p.tipLength : 0) - 0.3 }));
  const ray = new Ray();
  const clear = (a: Vec3, b: Vec3) => {
    const d = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = d.length();
    ray.origin.set(a[0], a[1], a[2]);
    ray.direction.copy(d.divideScalar(len || 1));
    const hit = bvh.raycastFirst(ray, DoubleSide);
    return !hit || hit.distance > len - 0.05;
  };
  const step = Math.min(g.su, g.sv);
  for (const c of blocked) {
    const top = c.top + pen;
    const room = c.top - c.bottom;
    if (room < 0.6) continue;
    // the tip, then straight down a little (never as far as the part below)
    // (bars: a taper onto the touch point)
    const touch = tip ? null : touchOf(p, r, room);
    let tipL = tip ? Math.min(p.tipLength, room * 0.35) : 0;
    const drop = Math.min(tipL + Math.max(0.5, step * 0.5), room * 0.5);
    // a bar's taper fits in the drop (the joint stays where it is)
    if (!tip) tipL = Math.min(touch!.l, drop * 0.8);
    const zc = top - drop;
    let to: [number, number, number] | null = null;
    // the nearest support it can reach at the branch angle
    const order = targets.map((t) => ({ t, d: Math.hypot(t.x - c.x, t.y - c.y) })).sort((a, b) => a.d - b.d);
    for (const { t, d } of order.slice(0, 12)) {
      if (d < 1e-6) continue;
      const tz = zc - d * slope;
      if (tz < t.lo || tz > t.hi) continue;
      if (clear([c.x, c.y, zc], [t.x, t.y, tz])) {
        to = [t.x, t.y, tz];
        break;
      }
    }
    if (!to) {
      // a new support beside the part: the nearest spot around it with nothing of the part below the joint
      search: for (let k = 1; k <= 8; k++)
        for (let a = 0; a < 16; a++) {
          const d = k * step;
          const x = c.x + d * Math.cos((a * Math.PI) / 8), y = c.y + d * Math.sin((a * Math.PI) / 8);
          const tz = zc - d * slope;
          if (tz < lowest) break search;
          const below = hitsAt(bvh, x, y).filter((h) => h.point.z < tz + r + 0.3);
          if (below.length) continue;
          if (!clear([c.x, c.y, zc], [x, y, tz])) continue;
          to = [x, y, tz];
          // the new support itself: foot (and raft) on the platform, rod up to the joint
          if (tip) {
            solids.push(M.cylinder(footL, rf, rb, 16).translate([x, y, floor]));
            solids.push(M.cylinder(tz - floor - footL + r, rb, rb, 16).translate([x, y, floor + footL - 0.01]));
            feet.push([x, y]);
          } else solids.push(M.cylinder(tz + r, r, r, 12).translate([x, y, 0]));
          targets.push({ x, y, lo: lowest, hi: tz });
          break search;
        }
    }
    if (!to) continue;
    // tip, drop and branch
    if (tip) solids.push(M.cylinder(tipL, rb, rt, 16).translate([c.x, c.y, top - tipL]));
    else if (tipL > 0) solids.push(M.cylinder(tipL, r, touch!.rt, 12).translate([c.x, c.y, top - tipL]));
    solids.push(M.cylinder(top - tipL - zc + 0.02, r, r, 12).translate([c.x, c.y, zc - 0.01]));
    solids.push(M.sphere(r, 12).translate([c.x, c.y, zc]));
    solids.push(rodBetween(M, [c.x, c.y, zc], to, r));
    solids.push(M.sphere(r, 12).translate(to));
    made.push({ ...c, onPart: false, gi: NaN, gj: NaN });
  }
}

/** Area of zero-thickness support walls (triangles, 9 numbers each), mm². */
function sheetArea(t: number[]): number {
  let a = 0;
  for (let i = 0; i < t.length; i += 9) {
    const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2], vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
    a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return a;
}
/** Two meshes as one (no boolean: open surfaces stay as they are). */
function mergeSheets(a: MeshData, b: MeshData): MeshData {
  const nv = a.positions.length / 3;
  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions);
  positions.set(b.positions, a.positions.length);
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices);
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i] + nv;
  return { positions, indices };
}

/** A raft is made (on, and a shape other than none). */
const raftOn = (p: SupportParams) => p.raft && (p.raftType ?? 'solid') !== 'none' && p.raftThickness > 0;

/** Height of a support's foot on the platform / raft. */
const footOf = (p: SupportParams) => {
  const rt = Math.max(0.05, p.tipDiameter / 2), rb = Math.max(rt, p.bodyDiameter / 2), rf = Math.max(rb, p.baseDiameter / 2);
  return p.footHeight > 0 ? p.footHeight : Math.max(0.6, rf - rb);
};
/** Radius where a support stands on the part below. */
const bottomOf = (p: SupportParams) => (p.bottomDiameter > 0 ? p.bottomDiameter / 2 : Math.max(0.05, p.tipDiameter / 2));

/**
 * The raft under the supports' feet (z = 0 up to the raft thickness), in the
 * chosen shape: rails along the grid rows (skate), bars to the neighbours in
 * both directions (cross grid), a plate with hexagonal holes, a solid plate
 * (bottom connected), or a solid plate with a wall round it (protection case).
 */
function raftSolids(w: Awaited<ReturnType<typeof getManifold>>, feet: [number, number][], p: SupportParams, g: Grid, rf: number): Manifold[] {
  const CS = w.CrossSection;
  const t = Math.max(0.05, p.raftThickness) + 0.02;
  const type = p.raftType ?? 'solid';
  const margin = Math.max(0, p.raftMargin ?? 1);
  const circle = (x: number, y: number, r: number, n = 24) => Array.from({ length: n }, (_, k) => [x + r * Math.cos((2 * Math.PI * k) / n), y + r * Math.sin((2 * Math.PI * k) / n)] as [number, number]);
  const parts: InstanceType<typeof CS>[] = [];
  const out: Manifold[] = [];
  try {
    if (type === 'skate' || type === 'cross') {
      // a pad under every foot, joined to the next foot along the grid rows (and columns: cross grid)
      const bw = p.raftBar > 0 ? p.raftBar : Math.max(0.6, rf * 0.8);
      const pad = p.raftPad > 0 ? p.raftPad / 2 : rf + 0.2;
      const uv = feet.map(([x, y]) => [x * g.cos + y * g.sin, -x * g.sin + y * g.cos]);
      for (const [x, y] of feet) parts.push(CS.hull([circle(x, y, pad, 16)]));
      const dirs: [number, number, number][] = type === 'cross' ? [[0, g.su, g.sv], [1, g.sv, g.su]] : [[0, g.su, g.sv]];
      for (const [axis, along, across] of dirs)
        feet.forEach((f, i) => {
          let best = -1, bd = Infinity;
          uv.forEach((q, j) => {
            const da = axis === 0 ? q[0] - uv[i][0] : q[1] - uv[i][1];
            const dc = axis === 0 ? q[1] - uv[i][1] : q[0] - uv[i][0];
            if (da > 1e-6 && da < along * 1.8 && Math.abs(dc) < across * 0.5 && da < bd) (bd = da), (best = j);
          });
          if (best >= 0) parts.push(CS.hull([[...circle(f[0], f[1], bw / 2, 12), ...circle(feet[best][0], feet[best][1], bw / 2, 12)]]));
        });
      const all = CS.union(parts);
      out.push(all.extrude(t));
      all.delete();
      return out;
    }
    // plate: the outline round all feet, the foot's radius plus the margin wider
    const ring: [number, number][] = [];
    for (const [x, y] of feet) ring.push(...circle(x, y, rf + margin));
    let plate = CS.hull([ring]);
    if (type === 'hex') {
      // hexagonal holes all over, a rim left round the edge and a solid pad under every foot
      const hr = p.raftHole > 0 ? p.raftHole / 2 : Math.max(1, Math.min(3, Math.min(g.su, g.sv) * 0.6));
      const wall = p.raftRib > 0 ? p.raftRib : Math.max(0.6, rf * 0.5);
      const pitch = hr * Math.sqrt(3) + wall;
      const inner = plate.offset(-wall, 'Miter');
      const b = inner.bounds();
      const holes: InstanceType<typeof CS>[] = [];
      for (let j = 0, y = b.min[1]; y <= b.max[1] + pitch; j++, y += (pitch * Math.sqrt(3)) / 2)
        for (let x = b.min[0] + (j % 2 ? pitch / 2 : 0); x <= b.max[0] + pitch; x += pitch) holes.push(CS.hull([circle(x, y, hr, 6)]));
      const pads = CS.union(feet.map(([x, y]) => CS.hull([circle(x, y, rf + 0.3, 16)])));
      if (holes.length) {
        const all = CS.union(holes);
        const inside = all.intersect(inner);
        const cut = inside.subtract(pads);
        const next = plate.subtract(cut);
        [all, inside, cut, plate].forEach((x) => x.delete());
        plate = next;
        holes.forEach((h) => h.delete());
      }
      [inner, pads].forEach((x) => x.delete());
    }
    out.push(plate.extrude(t));
    if (type === 'case') {
      // a wall round the plate, up to the part's bottom (or the height given)
      const wall = p.raftRib > 0 ? p.raftRib : Math.max(0.6, rf);
      const outer = plate.offset(wall, 'Round', 2, 24);
      const band = outer.subtract(plate);
      out.push(band.extrude(p.caseHeight > 0 ? p.caseHeight : Math.max(t, p.lift)));
      [outer, band].forEach((x) => x.delete());
    }
    plate.delete();
    return out;
  } finally {
    parts.forEach((x) => x.delete());
  }
}

/**
 * Block supports: walls of zero thickness (surfaces: the printer's software
 * traces each one as a single laser path) along the hatching (two directions
 * of the support grid, turned by the grid angle) under each overhang area,
 * plus a wall along each area's outline. On top the walls end in teeth (small
 * contacts that break off easily), and where they stand on the part below in
 * the same teeth upside down; walls can be cut into pieces (fragmentation),
 * and their inside is a cross grid (diagonal bars between diamond openings)
 * to save material.
 */
function blockSupports(
  w: Awaited<ReturnType<typeof getManifold>>,
  mesh: MeshData,
  bvh: MeshBVH,
  areas: OverhangArea[],
  cols: Column[],
  p: SupportParams,
  g: Grid,
  made: Column[],
  surf: number[],
): number {
  // zero-thickness walls: only lengths smaller than this are dropped
  const t = 0.05;
  let walls = 0;
  void w;
  const pen = p.penetration;
  const areaOf = new Int32Array(triangleCount(mesh)).fill(-1);
  areas.forEach((a, i) => a.tris.forEach((tr) => (areaOf[tr] = i)));
  // the hatching stays the XY offset inside each area's outline: grid points too close to it are dropped
  const inset = Math.max(0, p.blockInset);
  const inside = (c: Column) => {
    if (inset <= 0 || c.area < 0) return true;
    for (const [dx, dy] of [[inset, 0], [-inset, 0], [0, inset], [0, -inset]]) {
      const hit = hitsAt(bvh, c.x + dx, c.y + dy).find((h) => (h.faceIndex ?? -1) >= 0 && areaOf[h.faceIndex!] === c.area && Math.abs(h.point.z - c.top) < 3 * inset + 1);
      if (!hit) return false;
    }
    return true;
  };
  const grid = cols.filter((c) => Number.isFinite(c.gi) && inside(c));
  // anything off the grid (a single support for a small area, hand-made ones) still gets a short cross of walls
  const loose = cols.filter((c) => !Number.isFinite(c.gi));

  /** A wall piece in (s, z) from s0 to s1 along a line: bottom and top heights by interpolation; teeth and holes. */
  const piece = (s0: number, s1: number, bot: (s: number) => number, top: (s: number) => number, onPart: (s: number) => boolean, samples: number[]): [number, number][][] | null => {
    if (s1 - s0 < Math.max(t, 0.15)) return null;
    const inner = samples.filter((s) => s > s0 + 1e-6 && s < s1 - 1e-6);
    const at = [s0, ...inner, s1];
    // the wall must be taller than its teeth to carry them
    const tall = (h: number) => at.every((s) => top(s) - bot(s) > h + 0.3);
    const upper = p.teeth && p.teethHeight > 0 && tall(p.teethHeight * (p.lowerTeeth ? 2 : 1));
    const lower = upper && p.lowerTeeth && at.some((s) => onPart(s));
    const th = p.teethHeight, base = Math.max(t, p.teethBase), tip = Math.min(base, Math.max(t, p.teethTop)), gap = Math.max(0, p.teethGap);
    const teethAlong = (): number[] => {
      const pitch = base + gap, len = s1 - s0;
      const n = Math.max(1, Math.floor((len + gap) / pitch));
      const off = (len - (n * pitch - gap)) / 2;
      return Array.from({ length: n }, (_, k) => s0 + off + k * pitch);
    };
    const pts: [number, number][] = [];
    // bottom, left to right
    if (lower) {
      const bodyBot = (s: number) => bot(s) + (onPart(s) ? th : 0);
      pts.push([s0, bodyBot(s0)]);
      for (const a of teethAlong()) {
        const m = a + base / 2;
        if (!onPart(m)) continue;
        pts.push([a, bodyBot(a)], [a + (base - tip) / 2, bot(m)], [a + (base + tip) / 2, bot(m)], [a + base, bodyBot(a + base)]);
      }
      pts.push([s1, bodyBot(s1)]);
    } else for (const s of at) pts.push([s, bot(s)]);
    // top, right to left
    if (upper) {
      const bodyTop = (s: number) => top(s) - th;
      pts.push([s1, bodyTop(s1)]);
      for (const a of teethAlong().reverse()) {
        const m = a + base / 2;
        pts.push([a + base, bodyTop(a + base)], [a + (base + tip) / 2, top(m)], [a + (base - tip) / 2, top(m)], [a, bodyTop(a)]);
      }
      pts.push([s0, bodyTop(s0)]);
    } else for (const s of [...at].reverse()) pts.push([s, top(s)]);
    const contours: [number, number][][] = [pts];
    if (p.perforate && p.perfHeight > 0) {
      // diamond holes in staggered rows, a solid band above and below and a solid zone at the ends
      const hh = p.perfHeight / 2;
      const hw = hh / Math.tan((Math.max(15, Math.min(80, p.perfAngle)) * Math.PI) / 180);
      const beam = Math.max(t, p.perfBeam);
      const ps = 2 * hw + beam, pz = hh + beam / 2;
      const lo = s0 + Math.max(0, p.perfZone) + hw, hi = s1 - Math.max(0, p.perfZone) - hw;
      const solid = Math.max(0, p.perfSolid);
      const bodyTop = (s: number) => top(s) - (upper ? th : 0);
      const bodyBot = (s: number) => bot(s) + (lower && onPart(s) ? th : 0);
      let zMin = Infinity, zMax = -Infinity;
      for (const s of at) (zMin = Math.min(zMin, bodyBot(s))), (zMax = Math.max(zMax, bodyTop(s)));
      let holes = 0;
      for (let row = 0, z = zMin + solid + hh; z <= zMax - solid - hh && holes < 4000; row++, z += pz)
        for (let s = lo + (row % 2 ? ps / 2 : 0); s <= hi && holes < 4000; s += ps) {
          // the whole diamond inside the solid bands at its place
          if (z - hh < Math.max(bodyBot(s - hw), bodyBot(s), bodyBot(s + hw)) + solid) continue;
          if (z + hh > Math.min(bodyTop(s - hw), bodyTop(s), bodyTop(s + hw)) - solid) continue;
          // clockwise (holes run the other way round)
          contours.push([[s, z + hh], [s + hw, z], [s, z - hh], [s - hw, z]]);
          holes++;
        }
    }
    return contours;
  };
  /** Lay a wall outline (in s along the wall, z up) into place as a surface: `at(s, z)` gives the 3D point. */
  /**
   * Lay a wall outline (in s along the wall, z up) into place as a surface: `at(s, z)` gives the 3D point.
   * `cuts` (sorted s values) are where a wall that follows a polyline bends: triangles are split there,
   * so every piece lies flat on its own straight stretch.
   */
  const addSurface = (contours: [number, number][][], at: (s: number, z: number, hint?: number) => [number, number, number], cuts: number[] = []) => {
    const clean = contours.map((c) => {
      const out: [number, number][] = [];
      for (const q of c) {
        const last = out[out.length - 1];
        if (!last || Math.abs(last[0] - q[0]) > 1e-7 || Math.abs(last[1] - q[1]) > 1e-7) out.push(q);
      }
      if (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-7 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-7) out.pop();
      return out;
    });
    if (clean[0].length < 3) return;
    walls++;
    const outer = clean[0].map(([x, y]) => new Vector2(x, y));
    const holes = clean.slice(1).filter((h) => h.length >= 3).map((h) => h.map(([x, y]) => new Vector2(x, y)));
    const all = [outer, ...holes].flat();
    for (const [a, b, c] of ShapeUtils.triangulateShape(outer, holes)) {
      const tri = [all[a], all[b], all[c]];
      const lo = Math.min(tri[0].x, tri[1].x, tri[2].x), hi = Math.max(tri[0].x, tri[1].x, tri[2].x);
      // the bends strictly inside the triangle's span
      let i0 = 0, i1 = cuts.length;
      while (i0 < i1) {
        const m = (i0 + i1) >> 1;
        if (cuts[m] <= lo + 1e-9) i0 = m + 1;
        else i1 = m;
      }
      const inner: number[] = [];
      for (let i = i0; i < cuts.length && cuts[i] < hi - 1e-9; i++) inner.push(cuts[i]);
      if (!inner.length) {
        for (const v of tri) surf.push(...at(v.x, v.y));
        continue;
      }
      // one slab per straight stretch: clip the triangle to it and fan the (convex) piece
      const edges = [-Infinity, ...inner, Infinity];
      for (let k = 0; k + 1 < edges.length; k++) {
        let poly: [number, number][] = tri.map((v) => [v.x, v.y]);
        for (const [x0, keepAbove] of [[edges[k], true], [edges[k + 1], false]] as [number, boolean][]) {
          if (!Number.isFinite(x0)) continue;
          const inside = (q: [number, number]) => (keepAbove ? q[0] >= x0 : q[0] <= x0);
          const out: [number, number][] = [];
          for (let j = 0; j < poly.length; j++) {
            const P0 = poly[j], P1 = poly[(j + 1) % poly.length];
            const in0 = inside(P0), in1 = inside(P1);
            if (in0) out.push(P0);
            if (in0 !== in1) {
              const f = (x0 - P0[0]) / (P1[0] - P0[0]);
              out.push([x0, P0[1] + (P1[1] - P0[1]) * f]);
            }
          }
          poly = out;
          if (poly.length < 3) break;
        }
        if (poly.length < 3) continue;
        // the stretch's own bend for points on a cut, so neighbours meet exactly
        const mid = (Math.max(edges[k], lo) + Math.min(edges[k + 1], hi)) / 2;
        for (let j = 1; j + 1 < poly.length; j++)
          for (const q of [poly[0], poly[j], poly[j + 1]]) surf.push(...at(q[0], q[1], mid));
      }
    }
  };
  /** A hatching wall: s along the line, at the other grid coordinate `at`, turned by the grid angle. */
  const place = (contours: [number, number][][], dir: 0 | 1, atc: number) =>
    addSurface(contours, (sv, z) => {
      const u = dir === 0 ? sv : atc, v = dir === 0 ? atc : sv;
      return [u * g.cos - v * g.sin, u * g.sin + v * g.cos, z];
    });
  const lerp = (xs: number[], ys: number[]) => (s: number) => {
    if (s <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) if (s <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (s - xs[i - 1])) / (xs[i] - xs[i - 1] || 1);
    return ys[ys.length - 1];
  };

  // ---- hatching walls, in both directions
  for (const dir of [0, 1] as const) {
    const lines = new Map<string, Column[]>();
    for (const c of grid) {
      const k = `${c.area}:${dir === 0 ? c.gj : c.gi}`;
      const l = lines.get(k);
      if (l) l.push(c);
      else lines.set(k, [c]);
    }
    const along = (c: Column) => (dir === 0 ? c.u : c.v);
    const index = (c: Column) => (dir === 0 ? c.gi : c.gj);
    const step = dir === 0 ? g.su : g.sv;
    const interval = dir === 0 ? p.fragX : p.fragY;
    for (const line of lines.values()) {
      line.sort((a, b) => index(a) - index(b));
      const runs: Column[][] = [];
      for (const c of line) {
        const r = runs[runs.length - 1];
        const last = r?.[r.length - 1];
        if (last && index(c) - index(last) === 1 && Math.abs(c.top - last.top) < step * 3 && last.onPart === c.onPart) r.push(c);
        else runs.push([c]);
      }
      for (const run of runs) {
        if (run.length < 2) continue;
        const xs = run.map(along);
        const top = lerp(xs, run.map((c) => c.top + pen));
        const bot = lerp(xs, run.map((c) => (c.onPart ? c.bottom - pen : 0)));
        const onPart = () => run[0].onPart;
        // fragmentation: gaps across the line at every interval (on the same grid in every wall, so the pieces line up)
        let pieces: [number, number][] = [[xs[0], xs[xs.length - 1]]];
        if (p.fragment && interval > 0 && p.fragWidth > 0) {
          const cut: [number, number][] = [];
          for (const [a, b] of pieces) {
            let s = a;
            for (let k = Math.ceil((a + p.fragWidth / 2) / interval); k * interval - p.fragWidth / 2 < b; k++) {
              const g0 = k * interval - p.fragWidth / 2, g1 = k * interval + p.fragWidth / 2;
              if (g0 > s) cut.push([s, g0]);
              s = Math.max(s, g1);
            }
            if (s < b) cut.push([s, b]);
          }
          pieces = cut;
        }
        const at = dir === 0 ? run[0].v : run[0].u;
        for (const [s0, s1] of pieces) {
          const c = piece(s0, s1, bot, top, onPart, xs);
          if (c) place(c, dir, at);
        }
        made.push(...run);
      }
    }
  }

  // ---- border: a wall along the outline of each area (the XY offset inside it), straight between samples
  if (p.blockBorder) {
    const step = Math.max(0.3, Math.min(g.su, g.sv) * 0.6);
    const P = mesh.positions, I = mesh.indices;
    areas.forEach((ar, ai) => {
      const inArea = new Set(ar.tris);
      const next = new Map<number, [number, number]>();
      for (const tr of ar.tris)
        for (let e = 0; e < 3; e++) {
          const o = otherSide(mesh, tr, e);
          if (o >= 0 && inArea.has(o)) continue;
          next.set(I[tr * 3 + e], [I[tr * 3 + ((e + 1) % 3)], tr]);
        }
      const done = new Set<number>();
      for (const start of next.keys()) {
        if (done.has(start)) continue;
        // the loop's points, every `step`, moved the offset towards the inside
        const loop: { x: number; y: number; top: number; bottom: number; onPart: boolean }[] = [];
        let carry = 0, a = start;
        while (!done.has(a) && next.has(a)) {
          done.add(a);
          const [b, tr] = next.get(a)!;
          const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
          const len = Math.hypot(bx - ax, by - ay);
          const c0 = I[tr * 3] * 3, c1 = I[tr * 3 + 1] * 3, c2 = I[tr * 3 + 2] * 3;
          const mx = (P[c0] + P[c1] + P[c2]) / 3, my = (P[c0 + 1] + P[c1 + 1] + P[c2 + 1]) / 3;
          while (carry <= len) {
            const f = len > 0 ? carry / len : 0;
            let x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
            const z = az + (bz - az) * f;
            const ix = mx - x, iy = my - y, il = Math.hypot(ix, iy);
            if (il > 1e-9 && inset > 0) {
              // across the edge, towards the inside
              let nx = -(by - ay), ny = bx - ax;
              const nl = Math.hypot(nx, ny) || 1;
              (nx /= nl), (ny /= nl);
              if (nx * ix + ny * iy < 0) (nx = -nx), (ny = -ny);
              x += nx * inset;
              y += ny * inset;
            }
            const hits = hitsAt(bvh, x, y);
            let best = -1;
            for (let h = 0; h < hits.length; h++) {
              const fi = hits[h].faceIndex ?? -1;
              if (fi < 0 || areaOf[fi] !== ai) continue;
              if (best < 0 || Math.abs(hits[h].point.z - z) < Math.abs(hits[best].point.z - z)) best = h;
            }
            if (best >= 0) {
              const below = best > 0 ? hits[best - 1].point.z : null;
              if (p.onPart || below === null) loop.push({ x, y, top: hits[best].point.z, bottom: below ?? 0, onPart: below !== null });
            }
            carry += step;
          }
          carry -= len;
          a = b;
        }
        if (loop.length > 2) loop.push(loop[0]);
        // runs of samples close together on the same footing: each one continuous wall along the outline,
        // so the cross grid (and the teeth) run on unbroken round the bends
        const runs: (typeof loop)[] = [];
        let run: typeof loop = [];
        for (const q of loop) {
          const last = run[run.length - 1];
          if (last) {
            const d = Math.hypot(q.x - last.x, q.y - last.y);
            if (d < 1e-3) continue;
            if (d > step * 2.5 || q.onPart !== last.onPart) {
              if (run.length > 1) runs.push(run);
              run = [];
            }
          }
          run.push(q);
        }
        if (run.length > 1) runs.push(run);
        for (const r of runs) {
          const S = [0];
          for (let i = 1; i < r.length; i++) S.push(S[i - 1] + Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y));
          const L = S[S.length - 1];
          const top = lerp(S, r.map((q) => q.top + pen));
          const bot = lerp(S, r.map((q) => (q.onPart ? q.bottom - pen : 0)));
          const c = piece(0, L, bot, top, () => r[0].onPart, S);
          if (!c) continue;
          const bends = S.slice(1, -1);
          // a point at s along the outline (on a bend, the stretch `hint` lies in decides which side)
          const at = (sv: number, z: number, hint = sv): [number, number, number] => {
            let i = 1, j = S.length - 1;
            while (i < j) {
              const m = (i + j) >> 1;
              if (S[m] < hint) i = m + 1;
              else j = m;
            }
            const f = (sv - S[i - 1]) / (S[i] - S[i - 1] || 1);
            return [r[i - 1].x + (r[i].x - r[i - 1].x) * f, r[i - 1].y + (r[i].y - r[i - 1].y) * f, z];
          };
          addSurface(c, at, bends);
        }
      }
    });
  }

  // ---- single supports off the grid: a small cross of walls
  for (const c of loose) {
    const top = () => c.top + pen, bot = () => (c.onPart ? c.bottom - pen : 0);
    const half = Math.max(0.3, Math.min(g.su, g.sv) / 2);
    for (const dir of [0, 1] as const) {
      const contour = piece(-half, half, bot, top, () => c.onPart, []);
      if (!contour) continue;
      // along the grid's first or second direction
      const ex = dir === 0 ? g.cos : -g.sin, ey = dir === 0 ? g.sin : g.cos;
      addSurface(contour, (sv, z) => [c.x + ex * sv, c.y + ey * sv, z]);
    }
    made.push(c);
  }
  return walls;
}

/** Support solids below the areas of the lifted part (and under the points added by hand, minus the ones removed). */
async function buildSupports(
  mesh: MeshData,
  areas: OverhangArea[],
  p: SupportParams,
  edits: { add: Vec3[]; remove: [number, number, number, number][] } = { add: [], remove: [] },
): Promise<{ mesh: MeshData; raft: MeshData; count: number; volume: number; contacts: Float32Array; manual: Int32Array; area: number }> {
  const w = await getManifold();
  const M = w.Manifold;
  const pen = p.penetration;
  const g = gridOf(p);
  const bvh = makeBVH(mesh);
  const resin = p.style !== 'volume' && p.style !== 'block';
  let cols = columnsUnder(mesh, bvh, areas, g, resin ? p.perimeter : 0);
  // supports removed by hand: every one whose contact point is within the radius
  if (edits.remove.length)
    // (radius 0: the one support nearest the point, within half a grid step, so it stays removed when the grid moves with a turn)
    cols = cols.filter((c) => !edits.remove.some(([x, y, z, r]) => Math.hypot(c.x - x, c.y - y, c.top - z) <= (r > 0 ? r : 0.45 * Math.min(g.su, g.sv))));
  edits.add.forEach((q, i) => {
    if (p.style === 'volume' || p.style === 'block') cols.push(...manualBlock(mesh, bvh, q, i, g));
    else {
      const c = manualColumn(mesh, bvh, q, i);
      if (c) cols.push(c);
    }
  });
  // supports that would stand on the part, when that is not allowed: they branch sideways to a support beside them instead
  const blocked = p.onPart ? [] : cols.filter((c) => c.onPart && !c.noContact);
  if (!p.onPart) cols = cols.filter((c) => !c.onPart);
  const solids: Manifold[] = [];
  /** the raft, kept apart from the supports (shown / hidden on its own) */
  const raftParts: Manifold[] = [];
  /** zero-thickness support walls (block supports): triangles, 9 numbers each, and how many wall pieces */
  const surfaces: number[] = [];
  let blockWalls = 0;
  const made: Column[] = [];
  const feet: [number, number][] = [];
  try {
    const pin = (c: Column, r: number) => {
      const top = c.top + pen, base = c.onPart ? c.bottom - pen : 0;
      if (top - base < 0.2) return;
      solids.push(M.cylinder(top - base, r, r, 12).translate([c.x, c.y, base]));
      made.push(c);
    };
    if (p.style === 'tip') {
      const rt = Math.max(0.05, p.tipDiameter / 2), rb = Math.max(rt, p.bodyDiameter / 2), rf = Math.max(rb, p.baseDiameter / 2);
      const floor = raftOn(p) ? Math.max(0, p.raftThickness) : 0;
      for (const c of cols) {
        const top = c.top + pen;
        const base = c.onPart ? c.bottom - pen : floor;
        const len = top - base;
        if (len < 0.3) continue;
        // tip cone (contact Ø → rod Ø), its length cut down on short supports
        const tipL = Math.min(p.tipLength, len * (c.onPart ? 0.45 : 0.6));
        // a cone onto the part below, or a foot on the platform / raft
        const footL = c.onPart ? Math.min(p.tipLength, len * 0.45) : Math.min(footOf(p), len - tipL);
        const rodL = len - tipL - footL;
        solids.push(M.cylinder(tipL, rb, rt, 16).translate([c.x, c.y, top - tipL]));
        if (rodL > 1e-3) solids.push(M.cylinder(rodL + 0.02, rb, rb, 16).translate([c.x, c.y, base + footL - 0.01]));
        solids.push(M.cylinder(footL, c.onPart ? bottomOf(p) : rf, rb, 16).translate([c.x, c.y, base]));
        if (!c.onPart) feet.push([c.x, c.y]);
        made.push(c);
      }
    } else if (p.style === 'bar') {
      const r = Math.max(0.1, p.wall / 2);
      for (const c of cols) {
        const top = c.top + pen, base = c.onPart ? c.bottom - pen : 0;
        const len = top - base;
        if (len < 0.2) continue;
        // a taper onto the part at the top (and onto the part below, where it stands on it)
        const { rt, l } = touchOf(p, r, len);
        const lb = c.onPart ? l : 0;
        if (l > 0) solids.push(M.cylinder(l, r, rt, 12).translate([c.x, c.y, top - l]));
        if (lb > 0) solids.push(M.cylinder(lb, rt, r, 12).translate([c.x, c.y, base]));
        solids.push(M.cylinder(len - l - lb + (l > 0 ? 0.02 : 0) + (lb > 0 ? 0.02 : 0), r, r, 12).translate([c.x, c.y, base + lb - (lb > 0 ? 0.01 : 0)]));
        made.push(c);
        if (!c.onPart) feet.push([c.x, c.y]);
      }
    } else if (p.style === 'block') {
      // block: walls one laser spot thick along the hatching, with teeth, fragmentation, perforations and a border
      blockWalls = blockSupports(w, mesh, bvh, areas, cols, p, g, made, surfaces);
    } else {
      // volume: thin walls along the grid lines in both directions, following the surface above and below
      const t = Math.max(0.05, p.wall);
      const grid = cols.filter((c) => Number.isFinite(c.gi));
      // supports off the grid (a small area's single support, the ones added by hand) are pins
      for (const c of cols) if (!grid.includes(c)) pin(c, Math.max(0.3, Math.min(g.su, g.sv) / 4, t));
      for (const dir of [0, 1] as const) {
        // lines: columns with the same gj (lines along u) or gi (lines along v), per area
        const lines = new Map<string, Column[]>();
        for (const c of grid) {
          const k = `${c.area}:${dir === 0 ? c.gj : c.gi}`;
          const l = lines.get(k);
          if (l) l.push(c);
          else lines.set(k, [c]);
        }
        const along = (c: Column) => (dir === 0 ? c.u : c.v);
        const index = (c: Column) => (dir === 0 ? c.gi : c.gj);
        const s = dir === 0 ? g.su : g.sv;
        for (const line of lines.values()) {
          line.sort((a, b) => index(a) - index(b));
          // runs of neighbouring columns whose tops are close (one surface)
          const runs: Column[][] = [];
          for (const c of line) {
            const r = runs[runs.length - 1];
            const last = r?.[r.length - 1];
            if (last && index(c) - index(last) === 1 && Math.abs(c.top - last.top) < s * 3 && last.onPart === c.onPart) r.push(c);
            else runs.push([c]);
          }
          for (const run of runs) {
            const half = Math.min(s / 2, 0.5);
            // wall outline in (along, z): bottoms left to right, tops right to left
            const pts: [number, number][] = [];
            const first = run[0], last = run[run.length - 1];
            const ends = run.length === 1 ? [{ ...first, a: along(first) - half }, { ...first, a: along(first) + half }] : run.map((c) => ({ ...c, a: along(c) }));
            if (run.length > 1) {
              ends[0] = { ...ends[0], a: along(first) - half / 2 };
              ends[ends.length - 1] = { ...ends[ends.length - 1], a: along(last) + half / 2 };
            }
            for (const c of ends) pts.push([c.a, c.onPart ? c.bottom - pen : 0]);
            for (let i = ends.length - 1; i >= 0; i--) pts.push([ends[i].a, Math.max(ends[i].top + pen, pts[i][1] + 0.2)]);
            const cs = new w.CrossSection([pts], 'Positive');
            if (cs.isEmpty()) {
              cs.delete();
              continue;
            }
            // extruded along local z, then turned so local y is world Z and the thickness lies across the line, then into the grid's direction
            let sol = cs.extrude(t).translate([0, 0, -t / 2]).rotate([90, 0, 0]);
            if (dir === 0) sol = sol.translate([0, first.v, 0]);
            else sol = sol.rotate([0, 0, 90]).translate([first.u, 0, 0]);
            if (g.sin !== 0) sol = sol.rotate([0, 0, (Math.atan2(g.sin, g.cos) * 180) / Math.PI]);
            cs.delete();
            solids.push(sol);
            made.push(...run);
          }
        }
      }
    }
    // branches: supports that may not stand on the part hang from a neighbouring support (or a new one beside the part)
    if (blocked.length) branchSupports(M, bvh, blocked, made, p, g, solids, made, feet);
    // the raft under the feet
    if (resin && raftOn(p) && feet.length) {
      const rt = Math.max(0.05, p.tipDiameter / 2), rb = Math.max(rt, p.bodyDiameter / 2);
      const rf = p.style === 'tip' ? Math.max(rb, p.baseDiameter / 2) : Math.max(0.1, p.wall / 2);
      raftParts.push(...raftSolids(w, feet, p, g, rf));
    }
    // braces: zigzag rods between neighbouring free-standing supports, on tall ones
    if (resin && p.braces) {
      const rt = Math.max(0.05, p.tipDiameter / 2), rb = Math.max(rt, p.bodyDiameter / 2), rf = Math.max(rb, p.baseDiameter / 2);
      const r = p.style === 'tip' ? Math.max(0.2, rb * 0.6) : Math.max(0.15, (p.wall / 2) * 0.8);
      const floor = p.style === 'tip' && raftOn(p) ? Math.max(0, p.raftThickness) : 0;
      const low = floor + (p.style === 'tip' ? Math.max(0.6, rf - rb) + 0.3 : 0.5);
      const at = new Map<string, Column>();
      for (const c of made) if (!c.onPart && Number.isFinite(c.gi)) at.set(`${c.area}:${c.gi}:${c.gj}`, c);
      for (const a of at.values()) {
        if (a.top - floor < p.braceHeight) continue;
        for (const [di, dj] of [[1, 0], [0, 1]]) {
          const b = at.get(`${a.area}:${a.gi + di}:${a.gj + dj}`);
          if (!b || b.top - floor < p.braceHeight) continue;
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          const hi = Math.min(a.top, b.top) + pen - (p.style === 'tip' ? p.tipLength : 0) - 0.5;
          let z = low, from = a, to = b;
          while (z + dist <= hi) {
            solids.push(rodBetween(M, [from.x, from.y, z], [to.x, to.y, z + dist], r));
            z += dist;
            [from, to] = [to, from];
          }
        }
      }
    }
    // touch points: one per support (walls list their columns twice, blocks only their centre)
    const touch = [...new Set(made)].filter((c) => !c.noContact);
    const contacts = new Float32Array(touch.length * 3);
    const manual = new Int32Array(touch.length);
    touch.forEach((c, i) => {
      contacts.set([c.x, c.y, c.top], i * 3);
      manual[i] = c.manual ?? -1;
    });
    const empty = (): MeshData => ({ positions: new Float32Array(0), indices: new Uint32Array(0) });
    let raft = empty(), raftVolume = 0;
    if (raftParts.length) {
      const r = M.union(raftParts);
      raftVolume = r.volume();
      raft = fromManifold(r);
      r.delete();
    }
    // block supports: surfaces (no volume), joined with any solid parts (branches) as they are
    const sheet: MeshData | null = surfaces.length
      ? { positions: Float32Array.from(surfaces), indices: Uint32Array.from({ length: surfaces.length / 3 }, (_, i) => i) }
      : null;
    if (!solids.length) return { mesh: sheet ?? empty(), raft, count: blockWalls, volume: raftVolume, contacts, manual, area: sheet ? sheetArea(surfaces) : 0 };
    const all = M.union(solids);
    const volume = all.volume() + raftVolume;
    let mesh2 = fromManifold(all);
    if (sheet) mesh2 = mergeSheets(mesh2, sheet);
    all.delete();
    const walls = p.style === 'block' ? blockWalls : p.style === 'volume' ? solids.length : new Set(made).size;
    return { mesh: mesh2, raft, count: walls, volume, contacts, manual, area: sheet ? sheetArea(surfaces) : 0 };
  } finally {
    solids.forEach((s) => s.delete());
    raftParts.forEach((s) => s.delete());
  }
}

/**
 * Lift the part, find its overhang areas and build supports under them.
 * `skip`: points (in the part's current position) on areas the user left out.
 * `edits`: supports added / removed by hand (in the part's current position).
 */
export async function generateSupports(input: MeshData, p: SupportParams, skip: Vec3[] = [], edits?: SupportEdits): Promise<SupportResult> {
  const b = computeBounds(input.positions);
  const lift = Math.max(0, p.lift);
  const dz = lift - b.min[2];
  const part = { positions: input.positions.map((v, i) => (i % 3 === 2 ? v + dz : v)), indices: input.indices };
  const found = p.auto === false ? [] : overhangAreas(part, p.criticalAngle, p.minArea, lift > 0 ? -Infinity : 0);
  const all = p.auto === false || p.lowest === false ? found : withLowest(part, found, lift, p.spacing);
  const skipped = skippedAreas(part, all, skip, dz);
  const areas = all.filter((_, i) => !skipped.has(i));
  const up = (q: Vec3): Vec3 => [q[0], q[1], q[2] + dz];
  const s = await buildSupports(part, areas, p, {
    add: (edits?.add ?? []).map(up),
    remove: (edits?.remove ?? []).map(([x, y, z, r]) => [x, y, z + dz, r] as [number, number, number, number]),
  });
  return {
    part,
    dz,
    overhangs: subMesh(part, areas.flatMap((a) => a.tris)),
    areas: areas.length,
    skipped: skipped.size,
    supports: s.mesh,
    raft: s.raft,
    count: s.count,
    supportVolume: s.volume,
    supportArea: s.area,
    contacts: s.contacts,
    manual: s.manual,
  };
}

/** Only the analysis: the part lifted and its overhang areas (for showing before generating). */
export function analyseOverhangs(
  input: MeshData,
  p: Pick<SupportParams, 'criticalAngle' | 'minArea' | 'lift' | 'spacing'>,
  skip: Vec3[] = [],
): { overhangs: MeshData; areas: number; area: number; dz: number; skipped: number } {
  const b = computeBounds(input.positions);
  const lift = Math.max(0, p.lift);
  const dz = lift - b.min[2];
  const part = { positions: input.positions.map((v, i) => (i % 3 === 2 ? v + dz : v)), indices: input.indices };
  const all = withLowest(part, overhangAreas(part, p.criticalAngle, p.minArea, lift > 0 ? -Infinity : 0), lift, p.spacing);
  const skipped = skippedAreas(part, all, skip, dz);
  const areas = all.filter((_, i) => !skipped.has(i));
  const om = subMesh(part, areas.flatMap((a) => a.tris));
  // back to the part's current position
  for (let i = 2; i < om.positions.length; i += 3) om.positions[i] -= dz;
  return { overhangs: om, areas: areas.length, area: areas.reduce((s, a) => s + a.area, 0), dz, skipped: skipped.size };
}
