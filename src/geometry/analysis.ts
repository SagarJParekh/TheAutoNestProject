import { MeshData, computeBounds, triangleCount, Bounds } from './mesh';
import { buildTopology, findShells, heFrom, propagateOrientation, Topology } from './topology';
import { meshArea, meshVolume } from './measure';
import { findBoundaryLoops, BoundaryLoop } from './holes';

export interface AnalysisReport {
  triangles: number;
  vertices: number;
  bounds: Bounds;
  volume: number;
  area: number;
  openEdges: number;
  /** open edges that run along another open edge within a small gap (closable by stitching) */
  crackEdges: number;
  nonManifoldEdges: number;
  holes: number;
  /** triangles whose winding disagrees with their shell's outward orientation */
  flippedTriangles: number;
  degenerateTriangles: number;
  duplicateTriangles: number;
  shells: number;
  watertight: boolean;
  /** boundary loops (holes) in fill order */
  loops: BoundaryLoop[];
  /** viewport highlight data */
  highlights: AnalysisHighlights;
}

export interface AnalysisHighlights {
  /** line segments (xyz xyz) for open edges that border real holes / open surfaces */
  openEdges: Float32Array;
  /** line segments for open edges that are cracks (stitchable) */
  crackEdges: Float32Array;
  /** line segments for non-manifold edges */
  nonManifoldEdges: Float32Array;
  flippedTriangles: Uint32Array;
  degenerateTriangles: Uint32Array;
  duplicateTriangles: Uint32Array;
}

/** Triangles with repeated vertex indices or (near) zero area. */
export function findDegenerateTriangles(mesh: MeshData, relEps = 1e-10): Uint32Array {
  const p = mesh.positions, idx = mesh.indices;
  const out: number[] = [];
  const nt = triangleCount(mesh);
  for (let t = 0; t < nt; t++) {
    const ia = idx[t * 3], ib = idx[t * 3 + 1], ic = idx[t * 3 + 2];
    if (ia === ib || ib === ic || ia === ic) {
      out.push(t);
      continue;
    }
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const wx = p[c] - p[b], wy = p[c + 1] - p[b + 1], wz = p[c + 2] - p[b + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const cross2 = nx * nx + ny * ny + nz * nz;
    const maxEdge2 = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz);
    // |cross| <= eps * maxEdge²  (collinear / needle triangles)
    if (cross2 <= relEps * relEps * maxEdge2 * maxEdge2) out.push(t);
  }
  return Uint32Array.from(out);
}

/** Triangles that reuse the same three vertices as an earlier triangle (any order). */
export function findDuplicateTriangles(mesh: MeshData): Uint32Array {
  const idx = mesh.indices;
  const nt = triangleCount(mesh);
  let cap = 1;
  while (cap < nt * 2) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const out: number[] = [];
  const sorted = (t: number): [number, number, number] => {
    let a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2], s: number;
    if (a > b) { s = a; a = b; b = s; }
    if (b > c) { s = b; b = c; c = s; }
    if (a > b) { s = a; a = b; b = s; }
    return [a, b, c];
  };
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = sorted(t);
    if (a === b || b === c) continue;
    let slot = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & mask;
    let dup = false;
    for (;;) {
      const s = table[slot];
      if (s === -1) break;
      const [x, y, z] = sorted(s);
      if (x === a && y === b && z === c) {
        dup = true;
        break;
      }
      slot = (slot + 1) & mask;
    }
    if (dup) out.push(t);
    else table[slot] = t;
  }
  return Uint32Array.from(out);
}

/**
 * Determine which triangles are wound opposite to the rest of their
 * edge-connected patch. For closed patches the patch whose signed volume is
 * negative is considered inside-out as a whole.
 */
export function findFlippedTriangles(mesh: MeshData, topo: Topology = buildTopology(mesh)): Uint32Array {
  const { flip, patchOfTri, patchCount } = propagateOrientation(mesh, topo);
  const nt = triangleCount(mesh);
  // signed volume of each patch after applying the flip bits, and size stats
  const vol = new Float64Array(patchCount);
  const flippedCount = new Uint32Array(patchCount);
  const total = new Uint32Array(patchCount);
  const open = new Uint8Array(patchCount);
  const p = mesh.positions, idx = mesh.indices;
  for (let t = 0; t < nt; t++) {
    const pid = patchOfTri[t];
    total[pid]++;
    if (flip[t]) flippedCount[pid]++;
    let a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    if (flip[t]) { const s = a; a = b; b = s; }
    vol[pid] +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    for (let k = 0; k < 3; k++) if (topo.edgeFaceCount[topo.halfEdgeEdge[t * 3 + k]] !== 2) open[pid] = 1;
  }
  // decide for each patch whether the "flip" set or the "keep" set is wrong
  const invert = new Uint8Array(patchCount);
  for (let i = 0; i < patchCount; i++) {
    if (!open[i] && Math.abs(vol[i]) > 0) invert[i] = vol[i] < 0 ? 1 : 0;
    else invert[i] = flippedCount[i] * 2 > total[i] ? 1 : 0;
  }
  const out: number[] = [];
  for (let t = 0; t < nt; t++) if ((flip[t] ^ invert[patchOfTri[t]]) === 1) out.push(t);
  return Uint32Array.from(out);
}

function edgeSegments(mesh: MeshData, topo: Topology, pred: (count: number, edge: number) => boolean): Float32Array {
  const p = mesh.positions;
  let n = 0;
  for (let e = 0; e < topo.edgeCount; e++) if (pred(topo.edgeFaceCount[e], e)) n++;
  const out = new Float32Array(n * 6);
  let o = 0;
  for (let e = 0; e < topo.edgeCount; e++) {
    if (!pred(topo.edgeFaceCount[e], e)) continue;
    const a = topo.edgeV0[e] * 3, b = topo.edgeV1[e] * 3;
    out[o++] = p[a]; out[o++] = p[a + 1]; out[o++] = p[a + 2];
    out[o++] = p[b]; out[o++] = p[b + 1]; out[o++] = p[b + 2];
  }
  return out;
}

/** Full mesh health report. */
export function analyzeMesh(mesh: MeshData): AnalysisReport {
  const topo = buildTopology(mesh);
  let open = 0, nonManifold = 0;
  for (let e = 0; e < topo.edgeCount; e++) {
    const c = topo.edgeFaceCount[e];
    if (c === 1) open++;
    else if (c > 2) nonManifold++;
  }
  const degenerate = findDegenerateTriangles(mesh);
  const duplicate = findDuplicateTriangles(mesh);
  const flipped = findFlippedTriangles(mesh, topo);
  const { shellCount } = findShells(mesh);
  const loops = open > 0 ? findBoundaryLoops(mesh, topo) : [];
  const cracks = open > 0 ? findCrackEdges(mesh, topo) : new Uint8Array(0);
  let crackCount = 0;
  for (let i = 0; i < cracks.length; i++) crackCount += cracks[i];
  const bounds = computeBounds(mesh.positions);
  return {
    triangles: triangleCount(mesh),
    vertices: mesh.positions.length / 3,
    bounds,
    volume: meshVolume(mesh),
    area: meshArea(mesh),
    openEdges: open,
    crackEdges: crackCount,
    nonManifoldEdges: nonManifold,
    holes: loops.length,
    flippedTriangles: flipped.length,
    degenerateTriangles: degenerate.length,
    duplicateTriangles: duplicate.length,
    shells: shellCount,
    watertight: open === 0 && nonManifold === 0 && flipped.length === 0 && triangleCount(mesh) > 0,
    loops,
    highlights: {
      openEdges: edgeSegments(mesh, topo, (c, e) => c === 1 && !cracks[e]),
      crackEdges: edgeSegments(mesh, topo, (c, e) => c === 1 && cracks[e] === 1),
      nonManifoldEdges: edgeSegments(mesh, topo, (c) => c > 2),
      flippedTriangles: flipped,
      degenerateTriangles: degenerate,
      duplicateTriangles: duplicate,
    },
  };
}

/** Quick watertight test (closed, manifold, consistently oriented). */
export function isWatertight(mesh: MeshData): boolean {
  if (mesh.indices.length === 0) return false;
  const topo = buildTopology(mesh);
  for (let e = 0; e < topo.edgeCount; e++) {
    if (topo.edgeFaceCount[e] !== 2) return false;
    const h0 = topo.edgeHE0[e], h1 = topo.edgeHE1[e];
    if (heFrom(mesh, h0) === heFrom(mesh, h1)) return false;
  }
  return true;
}

/**
 * Mark open edges that are cracks: their ends and middle all lie within
 * `tolerance` of other (not adjacent) open edges, i.e. two borders running
 * side by side that stitching can close. Returns a flag per edge id.
 */
export function findCrackEdges(mesh: MeshData, topo: Topology = buildTopology(mesh), tolerance?: number): Uint8Array {
  const flags = new Uint8Array(topo.edgeCount);
  const p = mesh.positions;
  const open: number[] = [];
  for (let e = 0; e < topo.edgeCount; e++) if (topo.edgeFaceCount[e] === 1) open.push(e);
  if (open.length < 2 || open.length > 2_000_000) return flags;
  const b = computeBounds(p);
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const tol = tolerance ?? Math.max(1e-4, diag * 5e-4);
  // uniform grid over open-edge boxes
  let avg = 0;
  for (const e of open) {
    const a = topo.edgeV0[e] * 3, c = topo.edgeV1[e] * 3;
    avg += Math.hypot(p[a] - p[c], p[a + 1] - p[c + 1], p[a + 2] - p[c + 2]);
  }
  avg /= open.length;
  const cell = Math.max(tol * 2, avg);
  const key = (i: number, j: number, k: number) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  const grid = new Map<number, number[]>();
  for (const e of open) {
    const a = topo.edgeV0[e] * 3, c = topo.edgeV1[e] * 3;
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(p[a + k], p[c + k]) - tol) / cell));
    const hi = [0, 1, 2].map((k) => Math.floor((Math.max(p[a + k], p[c + k]) + tol) / cell));
    if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 512) continue; // very long edge: skip indexing
    for (let i = lo[0]; i <= hi[0]; i++)
      for (let j = lo[1]; j <= hi[1]; j++)
        for (let k = lo[2]; k <= hi[2]; k++) {
          const kk = key(i, j, k);
          let l = grid.get(kk);
          if (!l) grid.set(kk, (l = []));
          l.push(e);
        }
  }
  const segDist = (x: number, y: number, z: number, f: number) => {
    const a = topo.edgeV0[f] * 3, c = topo.edgeV1[f] * 3;
    const ux = p[c] - p[a], uy = p[c + 1] - p[a + 1], uz = p[c + 2] - p[a + 2];
    const t = Math.max(0, Math.min(1, ((x - p[a]) * ux + (y - p[a + 1]) * uy + (z - p[a + 2]) * uz) / (ux * ux + uy * uy + uz * uz || 1)));
    return Math.hypot(p[a] + ux * t - x, p[a + 1] + uy * t - y, p[a + 2] + uz * t - z);
  };
  for (const e of open) {
    const v0 = topo.edgeV0[e], v1 = topo.edgeV1[e];
    const a = v0 * 3, c = v1 * 3;
    const samples = [
      [p[a], p[a + 1], p[a + 2]],
      [(p[a] + p[c]) / 2, (p[a + 1] + p[c + 1]) / 2, (p[a + 2] + p[c + 2]) / 2],
      [p[c], p[c + 1], p[c + 2]],
    ];
    let all = true;
    for (const [x, y, z] of samples) {
      const l = grid.get(key(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell)));
      let ok = false;
      if (l)
        for (const f of l) {
          if (f === e) continue;
          const w0 = topo.edgeV0[f], w1 = topo.edgeV1[f];
          if (w0 === v0 || w0 === v1 || w1 === v0 || w1 === v1) continue; // neighbours on the same border
          if (segDist(x, y, z, f) <= tol) {
            ok = true;
            break;
          }
        }
      if (!ok) {
        all = false;
        break;
      }
    }
    if (all) flags[e] = 1;
  }
  return flags;
}
