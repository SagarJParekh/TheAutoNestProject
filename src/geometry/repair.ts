import { MeshData, compactMesh, triangleCount, subsetTriangles, ProgressFn, noProgress } from './mesh';
import { weldVertices, defaultWeldTolerance } from './weld';
import { findDegenerateTriangles, findDuplicateTriangles, findFlippedTriangles, analyzeMesh } from './analysis';
import { fillHoles, findBoundaryLoops } from './holes';
import { buildTopology, findShells } from './topology';

export interface RepairOptions {
  /** weld distance in mm; undefined = automatic (tiny, relative to size) */
  weldTolerance?: number;
  removeDegenerate?: boolean;
  removeDuplicates?: boolean;
  fixWinding?: boolean;
  fillHoles?: boolean;
  /** remove floating shells smaller than `smallShellRatio` of the largest shell's volume */
  removeSmallShells?: boolean;
  smallShellRatio?: number;
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

export function removeTriangles(mesh: MeshData, tris: Uint32Array): MeshData {
  if (tris.length === 0) return mesh;
  const drop = new Uint8Array(triangleCount(mesh));
  for (let i = 0; i < tris.length; i++) drop[tris[i]] = 1;
  return subsetTriangles(mesh, (t) => !drop[t]);
}

/** Flip the winding of the listed triangles. */
export function flipTriangles(mesh: MeshData, tris: Uint32Array): MeshData {
  if (tris.length === 0) return mesh;
  const idx = mesh.indices.slice();
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i] * 3;
    const s = idx[t + 1];
    idx[t + 1] = idx[t + 2];
    idx[t + 2] = s;
  }
  return { positions: mesh.positions, indices: idx };
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
    removeSmallShells: false,
    smallShellRatio: 0.01,
    ...options,
  };
  onProgress(0, 'Analysing');
  const before = repairCounts(input);
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
      before,
      after,
    },
  };
}
