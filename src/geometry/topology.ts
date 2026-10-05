import { MeshData, triangleCount, vertexCount } from './mesh';

/**
 * Edge topology of an indexed triangle mesh.
 *
 * Half-edge h = 3*tri + k runs from indices[3*tri+k] to indices[3*tri+(k+1)%3].
 * Every half-edge belongs to exactly one undirected edge.
 */
export interface Topology {
  edgeCount: number;
  /** undirected edge endpoints, v0 < v1 */
  edgeV0: Uint32Array;
  edgeV1: Uint32Array;
  /** number of triangles using the edge (1 = open/boundary, 2 = manifold, >2 = non-manifold) */
  edgeFaceCount: Uint32Array;
  /** first two half-edges using the edge (-1 if none) */
  edgeHE0: Int32Array;
  edgeHE1: Int32Array;
  /** edge id per half-edge */
  halfEdgeEdge: Uint32Array;
}

export function buildTopology(mesh: MeshData): Topology {
  const idx = mesh.indices;
  const nHE = idx.length;
  let cap = 1;
  while (cap < nHE * 1.5) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const maxEdges = nHE;
  const edgeV0 = new Uint32Array(maxEdges);
  const edgeV1 = new Uint32Array(maxEdges);
  const edgeFaceCount = new Uint32Array(maxEdges);
  const edgeHE0 = new Int32Array(maxEdges).fill(-1);
  const edgeHE1 = new Int32Array(maxEdges).fill(-1);
  const halfEdgeEdge = new Uint32Array(nHE);
  let edgeCount = 0;

  for (let h = 0; h < nHE; h++) {
    const t = (h / 3) | 0;
    const k = h - t * 3;
    const a = idx[h];
    const b = idx[t * 3 + ((k + 1) % 3)];
    const v0 = a < b ? a : b;
    const v1 = a < b ? b : a;
    let slot = (Math.imul(v0, 0x9e3779b1) ^ Math.imul(v1, 0x85ebca77)) & mask;
    let e = -1;
    for (;;) {
      const s = table[slot];
      if (s === -1) break;
      if (edgeV0[s] === v0 && edgeV1[s] === v1) {
        e = s;
        break;
      }
      slot = (slot + 1) & mask;
    }
    if (e === -1) {
      e = edgeCount++;
      edgeV0[e] = v0;
      edgeV1[e] = v1;
      table[slot] = e;
    }
    const c = edgeFaceCount[e]++;
    if (c === 0) edgeHE0[e] = h;
    else if (c === 1) edgeHE1[e] = h;
    halfEdgeEdge[h] = e;
  }
  return {
    edgeCount,
    edgeV0: edgeV0.slice(0, edgeCount),
    edgeV1: edgeV1.slice(0, edgeCount),
    edgeFaceCount: edgeFaceCount.slice(0, edgeCount),
    edgeHE0: edgeHE0.slice(0, edgeCount),
    edgeHE1: edgeHE1.slice(0, edgeCount),
    halfEdgeEdge,
  };
}

/** Start vertex of half-edge h. */
export function heFrom(mesh: MeshData, h: number): number {
  return mesh.indices[h];
}

/** End vertex of half-edge h. */
export function heTo(mesh: MeshData, h: number): number {
  const t = (h / 3) | 0;
  return mesh.indices[t * 3 + ((h - t * 3 + 1) % 3)];
}

/**
 * Neighbour triangle across half-edge h through a manifold edge, or -1.
 */
export function neighbourAcross(topo: Topology, h: number): number {
  const e = topo.halfEdgeEdge[h];
  if (topo.edgeFaceCount[e] !== 2) return -1;
  const o = topo.edgeHE0[e] === h ? topo.edgeHE1[e] : topo.edgeHE0[e];
  return (o / 3) | 0;
}

/** The other half-edge of a manifold edge, or -1. */
export function oppositeHalfEdge(topo: Topology, h: number): number {
  const e = topo.halfEdgeEdge[h];
  if (topo.edgeFaceCount[e] !== 2) return -1;
  return topo.edgeHE0[e] === h ? topo.edgeHE1[e] : topo.edgeHE0[e];
}

/**
 * Connected components of triangles (triangles sharing a vertex are connected).
 * Returns the shell id per triangle and the number of shells.
 */
export function findShells(mesh: MeshData): { shellOfTri: Uint32Array; shellCount: number } {
  const nv = vertexCount(mesh);
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const idx = mesh.indices;
  const nt = triangleCount(mesh);
  for (let t = 0; t < nt; t++) {
    union(idx[t * 3], idx[t * 3 + 1]);
    union(idx[t * 3], idx[t * 3 + 2]);
  }
  const label = new Int32Array(nv).fill(-1);
  const shellOfTri = new Uint32Array(nt);
  let shellCount = 0;
  for (let t = 0; t < nt; t++) {
    const r = find(idx[t * 3]);
    if (label[r] === -1) label[r] = shellCount++;
    shellOfTri[t] = label[r];
  }
  return { shellOfTri, shellCount };
}

/**
 * Orientation propagation: assigns each triangle a flip bit so that, after
 * flipping marked triangles, every manifold edge is traversed in opposite
 * directions by its two faces. Each edge-connected patch is oriented
 * independently starting from its first triangle.
 */
export function propagateOrientation(
  mesh: MeshData,
  topo: Topology,
): { flip: Uint8Array; patchOfTri: Int32Array; patchCount: number; conflicts: number } {
  const nt = triangleCount(mesh);
  const flip = new Uint8Array(nt);
  const patchOfTri = new Int32Array(nt).fill(-1);
  const stack = new Int32Array(nt);
  let patchCount = 0;
  let conflicts = 0;
  for (let seed = 0; seed < nt; seed++) {
    if (patchOfTri[seed] !== -1) continue;
    const pid = patchCount++;
    patchOfTri[seed] = pid;
    let sp = 0;
    stack[sp++] = seed;
    while (sp > 0) {
      const t = stack[--sp];
      for (let k = 0; k < 3; k++) {
        const h = t * 3 + k;
        const o = oppositeHalfEdge(topo, h);
        if (o < 0) continue;
        const n = (o / 3) | 0;
        if (n === t) continue;
        // same direction traversal means inconsistent winding
        const sameDir = heFrom(mesh, h) === heFrom(mesh, o);
        const wantFlip = (flip[t] ^ (sameDir ? 1 : 0)) as 0 | 1;
        if (patchOfTri[n] === -1) {
          patchOfTri[n] = pid;
          flip[n] = wantFlip;
          stack[sp++] = n;
        } else if (flip[n] !== wantFlip) {
          conflicts++;
        }
      }
    }
  }
  return { flip, patchOfTri, patchCount, conflicts: conflicts >> 1 };
}
