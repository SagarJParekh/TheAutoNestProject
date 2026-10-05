import { MeshData, FloatBuffer, IndexBuffer } from './mesh';
import { buildTopology, heFrom, heTo, Topology } from './topology';
import { isSimplePolygon2D, newellNormal, planeBasis, triangulate2D } from './triangulate';

export interface BoundaryLoop {
  /** vertex indices in fill order (reverse of the boundary half-edge direction) */
  vertices: Uint32Array;
  perimeter: number;
  /** centroid, for UI labels */
  center: [number, number, number];
}

/**
 * Find closed loops of open (boundary) edges. Each loop is returned in the
 * order a filling patch must traverse it to be consistently oriented with
 * the surrounding triangles.
 */
export function findBoundaryLoops(mesh: MeshData, topo: Topology = buildTopology(mesh)): BoundaryLoop[] {
  // collect boundary half-edges: from -> to as used by the adjacent face
  const outgoing = new Map<number, number[]>(); // fill direction: to -> from
  let n = 0;
  for (let e = 0; e < topo.edgeCount; e++) {
    if (topo.edgeFaceCount[e] !== 1) continue;
    const h = topo.edgeHE0[e];
    const a = heFrom(mesh, h), b = heTo(mesh, h);
    // fill traverses b -> a
    let list = outgoing.get(b);
    if (!list) outgoing.set(b, (list = []));
    list.push(a);
    n++;
  }
  const loops: BoundaryLoop[] = [];
  if (n === 0) return loops;
  const p = mesh.positions;
  for (const start of Array.from(outgoing.keys())) {
    for (;;) {
      const list = outgoing.get(start);
      if (!list || list.length === 0) break;
      const verts: number[] = [start];
      let cur = list.pop()!;
      let guard = 0;
      while (cur !== start && guard++ < n + 1) {
        verts.push(cur);
        const nl = outgoing.get(cur);
        if (!nl || nl.length === 0) break;
        cur = nl.pop()!;
      }
      if (cur !== start || verts.length < 3) continue; // open chain, skip
      let per = 0, cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i] * 3, b = verts[(i + 1) % verts.length] * 3;
        per += Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
        cx += p[a]; cy += p[a + 1]; cz += p[a + 2];
      }
      const k = verts.length;
      loops.push({ vertices: Uint32Array.from(verts), perimeter: per, center: [cx / k, cy / k, cz / k] });
    }
  }
  return loops;
}

/**
 * Triangulate a single loop. Uses ear clipping in the best-fit plane when
 * the projected loop is simple; otherwise falls back to a fan around a new
 * centroid vertex. Appends to the provided buffers.
 */
export function triangulateLoop(
  positions: Float32Array,
  loop: Uint32Array,
  outPositions: FloatBuffer,
  outIndices: IndexBuffer,
): void {
  const n = loop.length;
  if (n < 3) return;
  if (n === 3) {
    outIndices.push3(loop[0], loop[1], loop[2]);
    return;
  }
  const pts = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    pts[i * 3] = positions[loop[i] * 3];
    pts[i * 3 + 1] = positions[loop[i] * 3 + 1];
    pts[i * 3 + 2] = positions[loop[i] * 3 + 2];
  }
  const nn = newellNormal(pts);
  const len = Math.hypot(nn[0], nn[1], nn[2]);
  if (len > 0 && n <= 4000) {
    const normal: [number, number, number] = [nn[0] / len, nn[1] / len, nn[2] / len];
    const { u, v } = planeBasis(normal);
    const p2 = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
      p2[i * 2] = x * u[0] + y * u[1] + z * u[2];
      p2[i * 2 + 1] = x * v[0] + y * v[1] + z * v[2];
    }
    if (isSimplePolygon2D(p2)) {
      const tris = triangulate2D(p2);
      if (tris.length / 3 === n - 2) {
        for (let i = 0; i < tris.length; i += 3) outIndices.push3(loop[tris[i]], loop[tris[i + 1]], loop[tris[i + 2]]);
        return;
      }
    }
  }
  // fallback: centroid fan
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[i * 3]; cy += pts[i * 3 + 1]; cz += pts[i * 3 + 2];
  }
  const c = outPositions.push3(cx / n, cy / n, cz / n);
  for (let i = 0; i < n; i++) outIndices.push3(loop[i], loop[(i + 1) % n], c);
}

/**
 * Fill the given boundary loops (all loops when `which` is omitted).
 * Returns the new mesh and number of holes filled.
 */
export function fillHoles(
  mesh: MeshData,
  which?: number[],
  loops: BoundaryLoop[] = findBoundaryLoops(mesh),
): { mesh: MeshData; filled: number } {
  const sel = which ? which.map((i) => loops[i]).filter(Boolean) : loops;
  if (sel.length === 0) return { mesh, filled: 0 };
  const pos = new FloatBuffer(mesh.positions.length + 64);
  pos.data.set(mesh.positions);
  pos.length = mesh.positions.length;
  const idx = new IndexBuffer(mesh.indices.length + 64);
  idx.data.set(mesh.indices);
  idx.length = mesh.indices.length;
  for (const l of sel) triangulateLoop(mesh.positions, l.vertices, pos, idx);
  return { mesh: { positions: pos.toArray(), indices: idx.toArray() }, filled: sel.length };
}
