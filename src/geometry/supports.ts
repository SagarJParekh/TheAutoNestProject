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
}

/** The standard support scripts. */
export const SUPPORT_PRESETS: Record<SupportTech, SupportParams> = {
  sla: {
    tech: 'sla', style: 'tip', criticalAngle: 40, minArea: 0.5, lift: 5, spacing: 2.5, wall: 0.4, tipDiameter: 0.4, tipLength: 1.5,
    bodyDiameter: 1.0, baseDiameter: 2.5, penetration: 0.2, onPart: true, raft: true, raftThickness: 1,
  },
  dlp: {
    tech: 'dlp', style: 'tip', criticalAngle: 40, minArea: 0.3, lift: 5, spacing: 2, wall: 0.4, tipDiameter: 0.35, tipLength: 1.2,
    bodyDiameter: 0.8, baseDiameter: 2, penetration: 0.15, onPart: true, raft: true, raftThickness: 0.8,
  },
  dmls: {
    tech: 'dmls', style: 'volume', criticalAngle: 45, minArea: 0.1, lift: 3, spacing: 1, wall: 0.3, tipDiameter: 0.4, tipLength: 1,
    bodyDiameter: 1, baseDiameter: 1, penetration: 0.1, onPart: true, raft: false, raftThickness: 0,
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
  area: number;
}

/**
 * Columns under the areas on a grid: a vertical ray at each grid point; where
 * it meets an overhang triangle from below, the column runs from the surface
 * below it (or the platform) up to that triangle.
 */
function columnsUnder(mesh: MeshData, areas: OverhangArea[], spacing: number, offset: number): Column[] {
  const p = mesh.positions, idx = mesh.indices;
  const areaOf = new Int32Array(triangleCount(mesh)).fill(-1);
  areas.forEach((a, i) => a.tris.forEach((t) => (areaOf[t] = i)));
  const bvh = makeBVH(mesh);
  const out: Column[] = [];
  const s = Math.max(0.2, spacing);
  areas.forEach((ar, ai) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of ar.tris)
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k] * 3;
        x0 = Math.min(x0, p[v]);
        x1 = Math.max(x1, p[v]);
        y0 = Math.min(y0, p[v + 1]);
        y1 = Math.max(y1, p[v + 1]);
      }
    const found: Column[] = [];
    const tryAt = (x: number, y: number) => {
      const ray = new Ray(new Vector3(x, y, -1e4), new Vector3(0, 0, 1));
      const hits = bvh.raycast(ray, DoubleSide).sort((a, b) => a.distance - b.distance);
      for (let h = 0; h < hits.length; h++) {
        const f = hits[h].faceIndex ?? -1;
        if (f < 0 || areaOf[f] !== ai) continue;
        const below = h > 0 ? hits[h - 1].point.z : null;
        found.push({ x, y, top: hits[h].point.z, bottom: below ?? 0, onPart: below !== null, area: ai });
        break;
      }
    };
    // grid points over the area (offset so neighbouring areas line up)
    for (let x = Math.ceil((x0 - offset) / s) * s + offset; x <= x1; x += s) for (let y = Math.ceil((y0 - offset) / s) * s + offset; y <= y1; y += s) tryAt(x, y);
    if (!found.length) {
      // a small area between grid points: one support at its middle
      let cx = 0, cy = 0;
      for (const t of ar.tris)
        for (let k = 0; k < 3; k++) {
          const v = idx[t * 3 + k] * 3;
          cx += p[v];
          cy += p[v + 1];
        }
      tryAt(cx / (ar.tris.length * 3), cy / (ar.tris.length * 3));
    }
    out.push(...found);
  });
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

/** Support solids below the areas of the lifted part. */
async function buildSupports(mesh: MeshData, areas: OverhangArea[], p: SupportParams): Promise<{ mesh: MeshData; count: number; volume: number }> {
  const w = await getManifold();
  const M = w.Manifold;
  const pen = p.penetration;
  const cols = columnsUnder(mesh, areas, p.spacing, p.spacing / 2).filter((c) => p.onPart || !c.onPart);
  const solids: Manifold[] = [];
  try {
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
      }
      if (p.raft && feet.length && floor > 0) {
        // raft: the outline round all feet, a foot's width wider
        const hull = w.CrossSection.hull([feet.map(([x, y]) => [x, y] as [number, number])]);
        const plate = hull.offset(rf + 1, 'Round', 2, 24);
        solids.push(plate.extrude(floor + 0.02));
        hull.delete();
        plate.delete();
      }
    } else if (p.style === 'bar') {
      const r = Math.max(0.1, p.wall / 2);
      for (const c of cols) {
        const top = c.top + pen, base = c.onPart ? c.bottom - pen : 0;
        if (top - base < 0.2) continue;
        solids.push(M.cylinder(top - base, r, r, 12).translate([c.x, c.y, base]));
      }
    } else {
      // volume: thin walls along the grid lines in X and in Y, following the surface above and below
      const t = Math.max(0.05, p.wall);
      const key = (v: number) => Math.round(v * 1000);
      for (const dir of [0, 1] as const) {
        // lines: columns grouped by their y (for X lines) or x (for Y lines), per area
        const lines = new Map<string, Column[]>();
        for (const c of cols) {
          const k = `${c.area}:${key(dir === 0 ? c.y : c.x)}`;
          const l = lines.get(k);
          if (l) l.push(c);
          else lines.set(k, [c]);
        }
        for (const line of lines.values()) {
          line.sort((a, b) => (dir === 0 ? a.x - b.x : a.y - b.y));
          // runs of neighbouring columns whose tops are close (one surface)
          const runs: Column[][] = [];
          for (const c of line) {
            const r = runs[runs.length - 1];
            const last = r?.[r.length - 1];
            const step = last ? (dir === 0 ? c.x - last.x : c.y - last.y) : Infinity;
            if (last && step < p.spacing * 1.5 && Math.abs(c.top - last.top) < p.spacing * 3 && last.onPart === c.onPart) r.push(c);
            else runs.push([c]);
          }
          for (const run of runs) {
            const u = (c: Column) => (dir === 0 ? c.x : c.y);
            const half = Math.min(p.spacing / 2, 0.5);
            // wall outline in (along, z): bottoms left to right, tops right to left
            const pts: [number, number][] = [];
            const first = run[0], last = run[run.length - 1];
            const ends = run.length === 1 ? [{ ...first, u: u(first) - half }, { ...first, u: u(first) + half }] : run.map((c) => ({ ...c, u: u(c) }));
            if (run.length > 1) {
              ends[0] = { ...ends[0], u: u(first) - half / 2 };
              ends[ends.length - 1] = { ...ends[ends.length - 1], u: u(last) + half / 2 };
            }
            for (const c of ends) pts.push([c.u, c.onPart ? c.bottom - pen : 0]);
            for (let i = ends.length - 1; i >= 0; i--) pts.push([ends[i].u, Math.max(ends[i].top + pen, pts[i][1] + 0.2)]);
            const cs = new w.CrossSection([pts], 'Positive');
            if (cs.isEmpty()) {
              cs.delete();
              continue;
            }
            // extruded along local z, then turned so local y is world Z and the thickness lies across the line
            let s = cs.extrude(t).translate([0, 0, -t / 2]).rotate([90, 0, 0]);
            if (dir === 0) s = s.translate([0, first.y, 0]);
            else s = s.rotate([0, 0, 90]).translate([first.x, 0, 0]);
            cs.delete();
            solids.push(s);
          }
        }
      }
    }
    if (!solids.length) return { mesh: { positions: new Float32Array(0), indices: new Uint32Array(0) }, count: 0, volume: 0 };
    const all = M.union(solids);
    const volume = all.volume();
    const mesh2 = fromManifold(all);
    all.delete();
    return { mesh: mesh2, count: p.style === 'volume' ? solids.length : cols.length, volume };
  } finally {
    solids.forEach((s) => s.delete());
  }
}

/**
 * Lift the part, find its overhang areas and build supports under them.
 * `skip`: points (in the part's current position) on areas the user left out.
 */
export async function generateSupports(input: MeshData, p: SupportParams, skip: Vec3[] = []): Promise<SupportResult> {
  const b = computeBounds(input.positions);
  const lift = Math.max(0, p.lift);
  const dz = lift - b.min[2];
  const part = { positions: input.positions.map((v, i) => (i % 3 === 2 ? v + dz : v)), indices: input.indices };
  const all = withLowest(part, overhangAreas(part, p.criticalAngle, p.minArea, lift > 0 ? -Infinity : 0), lift, p.spacing);
  const skipped = skippedAreas(part, all, skip, dz);
  const areas = all.filter((_, i) => !skipped.has(i));
  const s = await buildSupports(part, areas, p);
  return {
    part,
    dz,
    overhangs: subMesh(part, areas.flatMap((a) => a.tris)),
    areas: areas.length,
    skipped: skipped.size,
    supports: s.mesh,
    count: s.count,
    supportVolume: s.volume,
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
