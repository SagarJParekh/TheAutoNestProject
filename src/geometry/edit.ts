/**
 * Small manual mesh edits: open-edge fixes, deleting triangles and adding a
 * triangle between existing vertices.
 */
import { MeshData, removeTriangles, compactMesh } from './mesh';
import { buildTopology, heFrom, heTo } from './topology';
import { findBoundaryLoops, fillHoles } from './holes';
import { stitchBoundaries } from './stitch';
import { fixWinding } from './repair';

/**
 * Repeatedly remove triangles that have two or three open edges (dangling
 * slivers and ragged borders).
 */
export function removeDanglingTriangles(mesh: MeshData, maxPasses = 50): { mesh: MeshData; removed: number } {
  let cur = mesh;
  let removed = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const topo = buildTopology(cur);
    const nt = cur.indices.length / 3;
    const drop: number[] = [];
    for (let t = 0; t < nt; t++) {
      let open = 0;
      for (let k = 0; k < 3; k++) if (topo.edgeFaceCount[topo.halfEdgeEdge[t * 3 + k]] === 1) open++;
      if (open >= 2) drop.push(t);
    }
    if (!drop.length) break;
    removed += drop.length;
    cur = removeTriangles(cur, Uint32Array.from(drop));
  }
  return { mesh: cur, removed };
}

export type OpenEdgeMethod = 'stitchFill' | 'fillSmall' | 'trim';

export interface OpenEdgeResult {
  mesh: MeshData;
  stitched: number;
  filled: number;
  removed: number;
  openBefore: number;
  openAfter: number;
}

function countOpen(mesh: MeshData): number {
  const t = buildTopology(mesh);
  let n = 0;
  for (let e = 0; e < t.edgeCount; e++) if (t.edgeFaceCount[e] === 1) n++;
  return n;
}

/**
 * Fix open edges:
 * - stitchFill: close cracks, then fill every remaining hole
 * - fillSmall: fill only holes whose perimeter is at most `maxPerimeter` mm
 * - trim: remove dangling triangles along open borders
 */
export function fixOpenEdges(mesh: MeshData, method: OpenEdgeMethod, opts: { maxPerimeter?: number; tolerance?: number } = {}): OpenEdgeResult {
  const openBefore = countOpen(mesh);
  let cur = mesh, stitched = 0, filled = 0, removed = 0;
  if (method === 'stitchFill') {
    const s = stitchBoundaries(cur, opts.tolerance);
    cur = s.mesh;
    stitched = s.mergedVertices + s.splitEdges;
    const f = fillHoles(cur);
    cur = f.mesh;
    filled = f.filled;
  } else if (method === 'fillSmall') {
    const loops = findBoundaryLoops(cur);
    const which = loops.map((l, i) => (l.perimeter <= (opts.maxPerimeter ?? 10) ? i : -1)).filter((i) => i >= 0);
    const f = fillHoles(cur, which, loops);
    cur = f.mesh;
    filled = f.filled;
  } else {
    const r = removeDanglingTriangles(cur);
    cur = r.mesh;
    removed = r.removed;
  }
  if (filled) cur = fixWinding(cur).mesh;
  cur = compactMesh(cur);
  return { mesh: cur, stitched, filled, removed, openBefore, openAfter: countOpen(cur) };
}

/**
 * Add a triangle between three existing vertices, wound to match any
 * neighbouring open edges it closes (so the surface stays consistently oriented).
 */
export function addTriangle(mesh: MeshData, a: number, b: number, c: number): MeshData {
  if (a === b || b === c || a === c) throw new Error('Pick three different vertices');
  const nv = mesh.positions.length / 3;
  if ([a, b, c].some((v) => v < 0 || v >= nv)) throw new Error('Vertex out of range');
  const topo = buildTopology(mesh);
  let votesFlip = 0, votesKeep = 0;
  const edges: [number, number][] = [[a, b], [b, c], [c, a]];
  for (let e = 0; e < topo.edgeCount; e++) {
    if (topo.edgeFaceCount[e] !== 1) continue;
    const h = topo.edgeHE0[e];
    const f = heFrom(mesh, h), t = heTo(mesh, h);
    for (const [x, y] of edges) {
      if (f === x && t === y) votesFlip++; // same direction as an existing face -> must be reversed
      else if (f === y && t === x) votesKeep++;
    }
  }
  const tri = votesFlip > votesKeep ? [a, c, b] : [a, b, c];
  const idx = new Uint32Array(mesh.indices.length + 3);
  idx.set(mesh.indices);
  idx.set(tri, mesh.indices.length);
  return { positions: mesh.positions, indices: idx };
}

export function deleteTriangles(mesh: MeshData, tris: ArrayLike<number>): MeshData {
  return removeTriangles(mesh, Uint32Array.from(tris));
}
