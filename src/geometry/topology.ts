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
  // Bucket half-edges by their lower vertex (CSR layout), then group equal
  // upper vertices inside each small bucket. Much faster than hashing.
  const idx = mesh.indices;
  const nHE = idx.length;
  const nv = vertexCount(mesh);
  const start = new Uint32Array(nv + 1);
  for (let h = 0; h < nHE; h++) {
    const t = (h / 3) | 0;
    const a = idx[h];
    const b = idx[h - t * 3 === 2 ? t * 3 : h + 1];
    start[(a < b ? a : b) + 1]++;
  }
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const bucketHi = new Uint32Array(nHE);
  const bucketHE = new Uint32Array(nHE);
  for (let h = 0; h < nHE; h++) {
    const t = (h / 3) | 0;
    const a = idx[h];
    const b = idx[h - t * 3 === 2 ? t * 3 : h + 1];
    const lo = a < b ? a : b;
    const k = fill[lo]++;
    bucketHi[k] = a < b ? b : a;
    bucketHE[k] = h;
  }
  const edgeV0 = new Uint32Array(nHE);
  const edgeV1 = new Uint32Array(nHE);
  const edgeFaceCount = new Uint32Array(nHE);
  const edgeHE0 = new Int32Array(nHE).fill(-1);
  const edgeHE1 = new Int32Array(nHE).fill(-1);
  const halfEdgeEdge = new Uint32Array(nHE);
  const done = new Uint8Array(nHE);
  let edgeCount = 0;
  for (let v = 0; v < nv; v++) {
    const s0 = start[v], s1 = start[v + 1];
    for (let i = s0; i < s1; i++) {
      if (done[i]) continue;
      const hi = bucketHi[i];
      const e = edgeCount++;
      edgeV0[e] = v;
      edgeV1[e] = hi;
      let c = 0;
      for (let j = i; j < s1; j++) {
        if (done[j] || bucketHi[j] !== hi) continue;
        done[j] = 1;
        const h = bucketHE[j];
        if (c === 0) edgeHE0[e] = h;
        else if (c === 1) edgeHE1[e] = h;
        c++;
        halfEdgeEdge[h] = e;
      }
      edgeFaceCount[e] = c;
    }
  }
  return {
    edgeCount,
    // subarrays avoid doubling peak memory on very large meshes
    edgeV0: edgeV0.subarray(0, edgeCount),
    edgeV1: edgeV1.subarray(0, edgeCount),
    edgeFaceCount: edgeFaceCount.subarray(0, edgeCount),
    edgeHE0: edgeHE0.subarray(0, edgeCount),
    edgeHE1: edgeHE1.subarray(0, edgeCount),
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
