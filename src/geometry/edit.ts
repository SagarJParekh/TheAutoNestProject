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

/** An open (border) edge as it runs in its triangle: from -> to. */
export type DirectedEdge = [number, number];

/**
 * Order directed edges into one chain v0 -> v1 -> ... -> vn.
 * Throws if they do not form a single connected run.
 */
export function chainEdges(edges: DirectedEdge[]): number[] {
  if (!edges.length) throw new Error('Pick at least one edge on each side');
  const next = new Map<number, number>();
  const incoming = new Set<number>();
  for (const [a, b] of edges) {
    if (next.has(a)) throw new Error('The picked edges branch; pick a single run of edges per side');
    next.set(a, b);
    incoming.add(b);
  }
  const starts = [...next.keys()].filter((v) => !incoming.has(v));
  // a closed loop has no start: begin anywhere
  const start = starts.length ? starts[0] : edges[0][0];
  if (starts.length > 1) throw new Error('The picked edges on one side are not connected; pick neighbouring edges');
  const chain = [start];
  let v = start;
  for (let i = 0; i < edges.length; i++) {
    const w = next.get(v);
    if (w === undefined) break;
    chain.push(w);
    v = w;
    if (v === start) break;
  }
  if (chain.length !== edges.length + 1) throw new Error('The picked edges on one side are not connected; pick neighbouring edges');
  return chain;
}

/**
 * Bridge two runs of open edges with a strip of triangles. Each side is a
 * list of open edges in their triangle's direction; the new triangles run
 * against them, so the surface stays consistently oriented. The strip is
 * triangulated by always taking the shorter diagonal.
 */
export function bridgeEdges(mesh: MeshData, sideA: DirectedEdge[], sideB: DirectedEdge[]): { mesh: MeshData; added: number } {
  const A = chainEdges(sideA), B = chainEdges(sideB);
  if (A.some((v) => B.includes(v)) && A.length + B.length > 4 && A.filter((v) => B.includes(v)).length > 1)
    throw new Error('The two sides share edges; pick two separate runs of edges');
  const p = mesh.positions;
  const d2 = (a: number, b: number) => (p[a * 3] - p[b * 3]) ** 2 + (p[a * 3 + 1] - p[b * 3 + 1]) ** 2 + (p[a * 3 + 2] - p[b * 3 + 2]) ** 2;
  const P = A.slice().reverse(); // new triangles use a(i+1) -> a(i)
  const Q = B; // and b(j+1) -> b(j)
  const tris: number[] = [];
  let i = 0, j = 0;
  while (i < P.length - 1 || j < Q.length - 1) {
    const canP = i < P.length - 1, canQ = j < Q.length - 1;
    const useP = canP && (!canQ || d2(P[i + 1], Q[j]) <= d2(P[i], Q[j + 1]));
    if (useP) {
      if (P[i] !== Q[j] && P[i + 1] !== Q[j]) tris.push(P[i], P[i + 1], Q[j]);
      i++;
    } else {
      if (P[i] !== Q[j + 1] && P[i] !== Q[j]) tris.push(P[i], Q[j + 1], Q[j]);
      j++;
    }
  }
  if (!tris.length) throw new Error('Nothing to bridge');
  const idx = new Uint32Array(mesh.indices.length + tris.length);
  idx.set(mesh.indices);
  idx.set(tris, mesh.indices.length);
  return { mesh: { positions: mesh.positions, indices: idx }, added: tris.length / 3 };
}

/**
 * The open edge of triangle `tri` (as a directed edge) closest to a point,
 * or null when the triangle has no open edge.
 */
export function openEdgeOfTriangle(mesh: MeshData, tri: number, point: [number, number, number], topo = buildTopology(mesh)): DirectedEdge | null {
  const p = mesh.positions, idx = mesh.indices;
  let best: DirectedEdge | null = null, bd = Infinity;
  for (let k = 0; k < 3; k++) {
    const h = tri * 3 + k;
    if (topo.edgeFaceCount[topo.halfEdgeEdge[h]] !== 1) continue;
    const a = idx[h], b = idx[tri * 3 + ((k + 1) % 3)];
    // distance from point to segment a-b
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
    const t = Math.max(0, Math.min(1, ((point[0] - ax) * ux + (point[1] - ay) * uy + (point[2] - az) * uz) / (ux * ux + uy * uy + uz * uz || 1)));
    const d = Math.hypot(ax + ux * t - point[0], ay + uy * t - point[1], az + uz * t - point[2]);
    if (d < bd) {
      bd = d;
      best = [a, b];
    }
  }
  return best;
}
