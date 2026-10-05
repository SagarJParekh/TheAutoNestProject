import { MeshData, compactMesh, triangleCount, subsetTriangles, ProgressFn, noProgress, removeTriangles, flipTriangles } from './mesh';
import { weldVertices, defaultWeldTolerance } from './weld';
import { findDegenerateTriangles, findDuplicateTriangles, findFlippedTriangles, analyzeMesh } from './analysis';
import { fillHoles, findBoundaryLoops } from './holes';
import { buildTopology, findShells } from './topology';
import { stitchBoundaries } from './stitch';

export interface RepairOptions {
  /** weld distance in mm; undefined = automatic (tiny, relative to size) */
  weldTolerance?: number;
  removeDegenerate?: boolean;
  removeDuplicates?: boolean;
  fixWinding?: boolean;
  fillHoles?: boolean;
  /** close cracks by merging nearby boundary vertices and fixing T-junctions */
  stitch?: boolean;
  stitchTolerance?: number;
  /** remove floating shells smaller than `smallShellRatio` of the largest shell's volume */
  removeSmallShells?: boolean;
  smallShellRatio?: number;
  /** counts from an analysis already run on this mesh (skips re-analysis) */
  before?: RepairCounts;
}

export interface RepairCounts {
  triangles: number;
  vertices: number;
  openEdges: number;
  nonManifoldEdges: number;
  holes: number;
  flippedTriangles: number;
  degenerateTriangles: number;
  duplicateTriangles: number;
  shells: number;
  watertight: boolean;
}

export interface RepairSummary {
  weldedVertices: number;
  degenerateRemoved: number;
  duplicatesRemoved: number;
  trianglesFlipped: number;
  holesFilled: number;
  shellsRemoved: number;
  stitchedVertices: number;
  stitchedEdges: number;
  before: RepairCounts;
  after: RepairCounts;
}

export function repairCounts(mesh: MeshData): RepairCounts {
  const r = analyzeMesh(mesh);
  return {
    triangles: r.triangles,
    vertices: r.vertices,
    openEdges: r.openEdges,
    nonManifoldEdges: r.nonManifoldEdges,
    holes: r.holes,
    flippedTriangles: r.flippedTriangles,
    degenerateTriangles: r.degenerateTriangles,
    duplicateTriangles: r.duplicateTriangles,
    shells: r.shells,
    watertight: r.watertight,
  };
}

/** Make winding consistent and outward-facing. Returns number of triangles flipped. */
export function fixWinding(mesh: MeshData): { mesh: MeshData; flipped: number } {
  const flipped = findFlippedTriangles(mesh, buildTopology(mesh));
  return { mesh: flipTriangles(mesh, flipped), flipped: flipped.length };
}

/** Remove shells whose |volume| is below ratio × the largest shell's |volume|. */
export function removeSmallShells(mesh: MeshData, ratio = 0.01): { mesh: MeshData; removed: number } {
  const { shellOfTri, shellCount } = findShells(mesh);
  if (shellCount < 2) return { mesh, removed: 0 };
  const vol = new Float64Array(shellCount);
  const p = mesh.positions, idx = mesh.indices;
  const nt = triangleCount(mesh);
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    vol[shellOfTri[t]] +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  let max = 0;
  for (let i = 0; i < shellCount; i++) max = Math.max(max, Math.abs(vol[i]));
  const keepShell = new Uint8Array(shellCount);
  let removed = 0;
  for (let i = 0; i < shellCount; i++) {
    keepShell[i] = Math.abs(vol[i]) >= ratio * max ? 1 : 0;
    if (!keepShell[i]) removed++;
  }
  if (removed === 0) return { mesh, removed: 0 };
  return { mesh: subsetTriangles(mesh, (t) => keepShell[shellOfTri[t]] === 1), removed };
}

/** One-click repair pipeline with a before/after summary. */
export function autoRepair(
  input: MeshData,
  options: RepairOptions = {},
  onProgress: ProgressFn = noProgress,
): { mesh: MeshData; summary: RepairSummary } {
  const opts = {
    removeDegenerate: true,
    removeDuplicates: true,
    fixWinding: true,
    fillHoles: true,
    stitch: true,
    removeSmallShells: false,
    smallShellRatio: 0.01,
    ...options,
  };
  onProgress(0, 'Analysing');
  const before = opts.before ?? repairCounts(input);
  let mesh = input;

  onProgress(0.15, 'Welding vertices');
  const tol = opts.weldTolerance ?? defaultWeldTolerance(mesh.positions);
  const w = weldVertices(mesh.positions, mesh.indices, tol);
  mesh = compactMesh(w.mesh);
  const weldedVertices = input.positions.length / 3 - mesh.positions.length / 3;

  let degenerateRemoved = 0;
  if (opts.removeDegenerate) {
    onProgress(0.3, 'Removing degenerate triangles');
    const d = findDegenerateTriangles(mesh);
    degenerateRemoved = d.length;
    mesh = removeTriangles(mesh, d);
  }
  let duplicatesRemoved = 0;
  if (opts.removeDuplicates) {
    onProgress(0.4, 'Removing duplicate triangles');
    const d = findDuplicateTriangles(mesh);
    duplicatesRemoved = d.length;
    mesh = removeTriangles(mesh, d);
  }
  let stitchedVertices = 0, stitchedEdges = 0;
  if (opts.stitch) {
    onProgress(0.45, 'Stitching cracks');
    const r = stitchBoundaries(mesh, opts.stitchTolerance);
    mesh = r.mesh;
    stitchedVertices = r.mergedVertices;
    stitchedEdges = r.splitEdges;
  }
  let trianglesFlipped = 0;
  if (opts.fixWinding) {
    onProgress(0.5, 'Fixing winding');
    const r = fixWinding(mesh);
    mesh = r.mesh;
    trianglesFlipped += r.flipped;
  }
  let holesFilled = 0;
  if (opts.fillHoles) {
    onProgress(0.65, 'Filling holes');
    const loops = findBoundaryLoops(mesh);
    if (loops.length) {
      const r = fillHoles(mesh, undefined, loops);
      mesh = r.mesh;
      holesFilled = r.filled;
      if (opts.fixWinding) {
        const f = fixWinding(mesh);
        mesh = f.mesh;
        trianglesFlipped += f.flipped;
      }
    }
  }
  let shellsRemoved = 0;
  if (opts.removeSmallShells) {
    onProgress(0.8, 'Removing small shells');
    const r = removeSmallShells(mesh, opts.smallShellRatio);
    mesh = r.mesh;
    shellsRemoved = r.removed;
  }
  mesh = compactMesh(mesh);
  onProgress(0.9, 'Verifying');
  const after = repairCounts(mesh);
  onProgress(1);
  return {
    mesh,
    summary: {
      weldedVertices: Math.max(0, weldedVertices),
      degenerateRemoved,
      duplicatesRemoved,
      trianglesFlipped,
      holesFilled,
      shellsRemoved,
      stitchedVertices,
      stitchedEdges,
      before,
      after,
    },
  };
}

/**
 * Make every edge used by at most two triangles. At each non-manifold edge
 * the best consistently-oriented pair of triangles (largest area) is kept and
 * the other triangles on that edge are removed, which typically deletes fins,
 * internal walls and doubled faces. Holes left behind can then be filled.
 */
export function fixNonManifoldEdges(mesh: MeshData): { mesh: MeshData; removed: number; edges: number } {
  let cur = mesh;
  let removed = 0;
  let edges = 0;
  for (let pass = 0; pass < 4; pass++) {
    const topo = buildTopology(cur);
    const bad = new Map<number, number[]>();
    for (let e = 0; e < topo.edgeCount; e++) if (topo.edgeFaceCount[e] > 2) bad.set(e, []);
    if (!bad.size) break;
    if (pass === 0) edges = bad.size;
    for (let h = 0; h < topo.halfEdgeEdge.length; h++) {
      const list = bad.get(topo.halfEdgeEdge[h]);
      if (list) list.push(h);
    }
    const p = cur.positions, idx = cur.indices;
    const area = (t: number) => {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    };
    const drop = new Set<number>();
    for (const hs of bad.values()) {
      const live = hs.filter((h) => !drop.has((h / 3) | 0));
      if (live.length <= 2) continue;
      let best: [number, number] | null = null, bestScore = -1;
      for (let i = 0; i < live.length; i++)
        for (let j = i + 1; j < live.length; j++) {
          const ti = (live[i] / 3) | 0, tj = (live[j] / 3) | 0;
          // opposite traversal directions = consistent orientation
          const consistent = idx[live[i]] !== idx[live[j]];
          const score = (consistent ? 1e12 : 0) + area(ti) + area(tj);
          if (score > bestScore) {
            bestScore = score;
            best = [ti, tj];
          }
        }
      for (const h of live) {
        const t = (h / 3) | 0;
        if (best && t !== best[0] && t !== best[1]) drop.add(t);
      }
    }
    if (!drop.size) break;
    removed += drop.size;
    cur = removeTriangles(cur, Uint32Array.from(drop));
  }
  return { mesh: cur, removed, edges };
}

/** Remove triangles that repeat an earlier triangle's three vertices. */
export function removeDuplicateTriangles(mesh: MeshData): { mesh: MeshData; removed: number } {
  const d = findDuplicateTriangles(mesh);
  return { mesh: removeTriangles(mesh, d), removed: d.length };
}

/** Remove zero-area / collapsed triangles. */
export function removeDegenerateTriangles(mesh: MeshData): { mesh: MeshData; removed: number } {
  const d = findDegenerateTriangles(mesh);
  return { mesh: removeTriangles(mesh, d), removed: d.length };
}
