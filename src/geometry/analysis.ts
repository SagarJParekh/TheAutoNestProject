import { MeshData, computeBounds, triangleCount, Bounds } from './mesh';
import { buildTopology, findShells, heFrom, propagateOrientation, Topology } from './topology';
import { meshArea, meshVolume } from './measure';
import { findBoundaryLoops } from './holes';

export interface AnalysisReport {
  triangles: number;
  vertices: number;
  bounds: Bounds;
  volume: number;
  area: number;
  openEdges: number;
  nonManifoldEdges: number;
  holes: number;
  /** triangles whose winding disagrees with their shell's outward orientation */
  flippedTriangles: number;
  degenerateTriangles: number;
  duplicateTriangles: number;
  shells: number;
  watertight: boolean;
  /** viewport highlight data */
  highlights: AnalysisHighlights;
}

export interface AnalysisHighlights {
  /** line segments (xyz xyz) for open edges */
  openEdges: Float32Array;
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

function edgeSegments(mesh: MeshData, topo: Topology, pred: (count: number) => boolean): Float32Array {
  const p = mesh.positions;
  let n = 0;
  for (let e = 0; e < topo.edgeCount; e++) if (pred(topo.edgeFaceCount[e])) n++;
  const out = new Float32Array(n * 6);
  let o = 0;
  for (let e = 0; e < topo.edgeCount; e++) {
    if (!pred(topo.edgeFaceCount[e])) continue;
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
  const bounds = computeBounds(mesh.positions);
  return {
    triangles: triangleCount(mesh),
    vertices: mesh.positions.length / 3,
    bounds,
    volume: meshVolume(mesh),
    area: meshArea(mesh),
    openEdges: open,
    nonManifoldEdges: nonManifold,
    holes: loops.length,
    flippedTriangles: flipped.length,
    degenerateTriangles: degenerate.length,
    duplicateTriangles: duplicate.length,
    shells: shellCount,
    watertight: open === 0 && nonManifold === 0 && flipped.length === 0 && triangleCount(mesh) > 0,
    highlights: {
      openEdges: edgeSegments(mesh, topo, (c) => c === 1),
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
