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
import { DoubleSide, Ray, Vector3 } from 'three';

import type { Manifold } from 'manifold-3d';
import { MeshData, Vec3, computeBounds, triangleCount } from './mesh';
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { buildTopology } from './topology';
import { fromManifold, getManifold } from './manifold';

export type SupportTech = 'sla' | 'dlp' | 'dmls';
export type SupportStyle = 'volume' | 'bar' | 'tip';

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
}

/** Supports changed by hand, in the frame the supports are made in (the turned part, before lifting). */
export interface SupportEdits {
  /** points on the part (surface facing down) that get a support */
  add: Vec3[];
  /** contact points whose supports are removed, with a radius (0: just that one) */
  remove: [number, number, number, number][];
}

/** The standard support scripts. */
export const SUPPORT_PRESETS: Record<SupportTech, SupportParams> = {
  sla: {
    tech: 'sla', style: 'tip', criticalAngle: 40, minArea: 0.5, lift: 5, spacing: 2.5, wall: 0.4, tipDiameter: 0.4, tipLength: 1.5,
    bodyDiameter: 1.0, baseDiameter: 2.5, penetration: 0.2, onPart: true, raft: true, raftThickness: 1,
    spacingY: 2.5, gridAngle: 0, perimeter: 0, auto: true, lowest: true, raftMargin: 1, braces: true, braceHeight: 10,
  },
  dlp: {
    tech: 'dlp', style: 'tip', criticalAngle: 40, minArea: 0.3, lift: 5, spacing: 2, wall: 0.4, tipDiameter: 0.35, tipLength: 1.2,
    bodyDiameter: 0.8, baseDiameter: 2, penetration: 0.15, onPart: true, raft: true, raftThickness: 0.8,
    spacingY: 2, gridAngle: 0, perimeter: 0, auto: true, lowest: true, raftMargin: 1, braces: true, braceHeight: 10,
  },
  dmls: {
    tech: 'dmls', style: 'volume', criticalAngle: 45, minArea: 0.1, lift: 3, spacing: 1, wall: 0.3, tipDiameter: 0.4, tipLength: 1,
    bodyDiameter: 1, baseDiameter: 1, penetration: 0.1, onPart: true, raft: false, raftThickness: 0,
    spacingY: 1, gridAngle: 0, perimeter: 0, auto: true, lowest: true, raftMargin: 0, braces: false, braceHeight: 10,
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
  /** bars / tips / walls made */
  count: number;
  supportVolume: number;
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
  for (let a = -1; a <= 1; a++)
    for (let b = -1; b <= 1; b++) {
      const u = a * g.su, v = b * g.sv;
      const x = q[0] + u * g.cos - v * g.sin, y = q[1] + u * g.sin + v * g.cos;
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

/** Support solids below the areas of the lifted part (and under the points added by hand, minus the ones removed). */
async function buildSupports(
  mesh: MeshData,
  areas: OverhangArea[],
  p: SupportParams,
  edits: { add: Vec3[]; remove: [number, number, number, number][] } = { add: [], remove: [] },
): Promise<{ mesh: MeshData; count: number; volume: number; contacts: Float32Array; manual: Int32Array }> {
  const w = await getManifold();
  const M = w.Manifold;
  const pen = p.penetration;
  const g = gridOf(p);
  const bvh = makeBVH(mesh);
  const resin = p.style !== 'volume';
  let cols = columnsUnder(mesh, bvh, areas, g, resin ? p.perimeter : 0).filter((c) => p.onPart || !c.onPart);
  // supports removed by hand: every one whose contact point is within the radius
  if (edits.remove.length)
    // (radius 0: the one support nearest the point, within half a grid step, so it stays removed when the grid moves with a turn)
    cols = cols.filter((c) => !edits.remove.some(([x, y, z, r]) => Math.hypot(c.x - x, c.y - y, c.top - z) <= (r > 0 ? r : 0.45 * Math.min(g.su, g.sv))));
  edits.add.forEach((q, i) => {
    if (p.style === 'volume') cols.push(...manualBlock(mesh, bvh, q, i, g));
    else {
      const c = manualColumn(mesh, bvh, q, i);
      if (c) cols.push(c);
    }
  });
  const solids: Manifold[] = [];
  const made: Column[] = [];
  try {
    const pin = (c: Column, r: number) => {
      const top = c.top + pen, base = c.onPart ? c.bottom - pen : 0;
      if (top - base < 0.2) return;
      solids.push(M.cylinder(top - base, r, r, 12).translate([c.x, c.y, base]));
      made.push(c);
    };
    if (p.style === 'tip') {
      const rt = Math.max(0.05, p.tipDiameter / 2), rb = Math.max(rt, p.bodyDiameter / 2), rf = Math.max(rb, p.baseDiameter / 2);
      const floor = p.raft ? Math.max(0, p.raftThickness) : 0;
      const feet: [number, number][] = [];
      for (const c of cols) {
        const top = c.top + pen;
        const base = c.onPart ? c.bottom - pen : floor;
        const len = top - base;
        if (len < 0.3) continue;
        // tip cone (contact Ø → rod Ø), its length cut down on short supports
        const tipL = Math.min(p.tipLength, len * (c.onPart ? 0.45 : 0.6));
        // a cone onto the part below, or a foot on the platform / raft
        const footL = c.onPart ? Math.min(p.tipLength, len * 0.45) : Math.min(Math.max(0.6, rf - rb), len - tipL);
        const rodL = len - tipL - footL;
        solids.push(M.cylinder(tipL, rb, rt, 16).translate([c.x, c.y, top - tipL]));
        if (rodL > 1e-3) solids.push(M.cylinder(rodL + 0.02, rb, rb, 16).translate([c.x, c.y, base + footL - 0.01]));
        solids.push(M.cylinder(footL, c.onPart ? rt : rf, rb, 16).translate([c.x, c.y, base]));
        if (!c.onPart) feet.push([c.x, c.y]);
        made.push(c);
      }
      if (p.raft && feet.length && floor > 0) {
        // raft: the outline round all feet, the foot's radius plus the margin wider
        // (circles round the feet, so one or two feet in a row still give a plate)
        const R = rf + Math.max(0, p.raftMargin ?? 1);
        const ring: [number, number][] = [];
        for (const [x, y] of feet) for (let k = 0; k < 24; k++) ring.push([x + R * Math.cos((k * Math.PI) / 12), y + R * Math.sin((k * Math.PI) / 12)]);
        const plate = w.CrossSection.hull([ring]);
        solids.push(plate.extrude(floor + 0.02));
        plate.delete();
      }
    } else if (p.style === 'bar') {
      const r = Math.max(0.1, p.wall / 2);
      for (const c of cols) pin(c, r);
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
    // braces: zigzag rods between neighbouring free-standing supports, on tall ones
    if (resin && p.braces) {
      const rt = Math.max(0.05, p.tipDiameter / 2), rb = Math.max(rt, p.bodyDiameter / 2), rf = Math.max(rb, p.baseDiameter / 2);
      const r = p.style === 'tip' ? Math.max(0.2, rb * 0.6) : Math.max(0.15, (p.wall / 2) * 0.8);
      const floor = p.style === 'tip' && p.raft ? Math.max(0, p.raftThickness) : 0;
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
    if (!solids.length) return { mesh: { positions: new Float32Array(0), indices: new Uint32Array(0) }, count: 0, volume: 0, contacts, manual };
    const all = M.union(solids);
    const volume = all.volume();
    const mesh2 = fromManifold(all);
    all.delete();
    const walls = p.style === 'volume' ? solids.length : new Set(made).size;
    return { mesh: mesh2, count: walls, volume, contacts, manual };
  } finally {
    solids.forEach((s) => s.delete());
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
    count: s.count,
    supportVolume: s.volume,
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
