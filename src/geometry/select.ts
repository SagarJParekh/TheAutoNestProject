import { MeshData, Vec3, triangleCount, triangleCross } from './mesh';
import { buildTopology, neighbourAcross, Topology } from './topology';

/**
 * Grow a face selection from a seed triangle across edge-connected triangles
 * whose normal is within `angleTolDeg` of the seed normal.
 */
export function growCoplanarRegion(
  mesh: MeshData,
  seed: number,
  angleTolDeg = 5,
  topo: Topology = buildTopology(mesh),
): Uint32Array {
  const nt = triangleCount(mesh);
  if (seed < 0 || seed >= nt) return new Uint32Array(0);
  const cosTol = Math.cos((Math.max(0, angleTolDeg) * Math.PI) / 180) - 1e-9;
  const sn = triangleCross(mesh, seed);
  const sl = Math.hypot(sn[0], sn[1], sn[2]) || 1;
  const nx = sn[0] / sl, ny = sn[1] / sl, nz = sn[2] / sl;
  const visited = new Uint8Array(nt);
  const out: number[] = [seed];
  const stack: number[] = [seed];
  visited[seed] = 1;
  const tmp: Vec3 = [0, 0, 0];
  while (stack.length) {
    const t = stack.pop()!;
    for (let k = 0; k < 3; k++) {
      const nb = neighbourAcross(topo, t * 3 + k);
      if (nb < 0 || visited[nb]) continue;
      visited[nb] = 1;
      triangleCross(mesh, nb, tmp);
      const l = Math.hypot(tmp[0], tmp[1], tmp[2]);
      if (l === 0) continue;
      if ((tmp[0] * nx + tmp[1] * ny + tmp[2] * nz) / l >= cosTol) {
        out.push(nb);
        stack.push(nb);
      }
    }
  }
  return Uint32Array.from(out);
}

/** Area-weighted average normal (normalised) and total area of a set of triangles. */
export function regionNormal(mesh: MeshData, tris: ArrayLike<number>): { normal: Vec3; area: number; centroid: Vec3 } {
  let nx = 0, ny = 0, nz = 0, area = 0, cx = 0, cy = 0, cz = 0;
  const tmp: Vec3 = [0, 0, 0];
  const p = mesh.positions, idx = mesh.indices;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    triangleCross(mesh, t, tmp);
    nx += tmp[0]; ny += tmp[1]; nz += tmp[2];
    const a = Math.hypot(tmp[0], tmp[1], tmp[2]) / 2;
    area += a;
    for (let k = 0; k < 3; k++) {
      const o = idx[t * 3 + k] * 3;
      cx += (p[o] * a) / 3; cy += (p[o + 1] * a) / 3; cz += (p[o + 2] * a) / 3;
    }
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return {
    normal: [nx / l, ny / l, nz / l],
    area,
    centroid: area > 0 ? [cx / area, cy / area, cz / area] : [0, 0, 0],
  };
}

/** Half-edges on the border of a triangle region (neighbour outside region or none). */
export function regionBoundaryHalfEdges(mesh: MeshData, tris: ArrayLike<number>, topo: Topology): number[] {
  const inRegion = new Uint8Array(triangleCount(mesh));
  for (let i = 0; i < tris.length; i++) inRegion[tris[i]] = 1;
  const out: number[] = [];
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    for (let k = 0; k < 3; k++) {
      const nb = neighbourAcross(topo, t * 3 + k);
      if (nb < 0 || !inRegion[nb]) out.push(t * 3 + k);
    }
  }
  return out;
}

// ---------------------------------------------------------------- marking helpers (triangle selections)

/** Vertex -> incident triangles (CSR). */
export interface VertexTriangles {
  start: Uint32Array;
  list: Uint32Array;
}

export function vertexTriangles(mesh: MeshData): VertexTriangles {
  const idx = mesh.indices;
  const nv = mesh.positions.length / 3;
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < idx.length; i++) start[idx[i] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const list = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) list[fill[idx[i]]++] = (i / 3) | 0;
  return { start, list };
}

/** Add `rings` rings of triangles that share a vertex with the selection. */
export function growSelection(mesh: MeshData, tris: ArrayLike<number>, rings = 1, vt: VertexTriangles = vertexTriangles(mesh)): Uint32Array {
  const nt = triangleCount(mesh);
  const sel = new Uint8Array(nt);
  let frontier: number[] = [];
  for (let i = 0; i < tris.length; i++) {
    if (!sel[tris[i]]) frontier.push(tris[i]);
    sel[tris[i]] = 1;
  }
  const idx = mesh.indices;
  for (let r = 0; r < rings; r++) {
    const next: number[] = [];
    for (const t of frontier)
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k];
        for (let i = vt.start[v]; i < vt.start[v + 1]; i++) {
          const u = vt.list[i];
          if (!sel[u]) {
            sel[u] = 1;
            next.push(u);
          }
        }
      }
    frontier = next;
  }
  return selectedIds(sel);
}

/** Remove the outer ring: triangles that share a vertex with an unselected triangle. */
export function shrinkSelection(mesh: MeshData, tris: ArrayLike<number>, vt: VertexTriangles = vertexTriangles(mesh)): Uint32Array {
  const nt = triangleCount(mesh);
  const sel = new Uint8Array(nt);
  for (let i = 0; i < tris.length; i++) sel[tris[i]] = 1;
  const idx = mesh.indices;
  const keep = new Uint8Array(nt);
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    let inner = true;
    for (let k = 0; k < 3 && inner; k++) {
      const v = idx[t * 3 + k];
      for (let j = vt.start[v]; j < vt.start[v + 1]; j++) if (!sel[vt.list[j]]) inner = false;
    }
    if (inner) keep[t] = 1;
  }
  return selectedIds(keep);
}

/** Every triangle not in the selection. */
export function invertSelection(triangleTotal: number, tris: ArrayLike<number>): Uint32Array {
  const sel = new Uint8Array(triangleTotal).fill(1);
  for (let i = 0; i < tris.length; i++) sel[tris[i]] = 0;
  return selectedIds(sel);
}

/** All triangles connected to `seed` through shared vertices (its shell). */
export function shellOfTriangle(mesh: MeshData, seed: number, vt: VertexTriangles = vertexTriangles(mesh)): Uint32Array {
  const nt = triangleCount(mesh);
  if (seed < 0 || seed >= nt) return new Uint32Array(0);
  return growSelection(mesh, [seed], nt, vt);
}

/**
 * Brush: triangles connected to `seed` (through shared vertices) with any
 * corner within `radius` of `center` (local coordinates).
 */
export function brushSelect(mesh: MeshData, seed: number, center: Vec3, radius: number, vt: VertexTriangles = vertexTriangles(mesh)): Uint32Array {
  const nt = triangleCount(mesh);
  if (seed < 0 || seed >= nt) return new Uint32Array(0);
  const p = mesh.positions, idx = mesh.indices;
  const r2 = radius * radius;
  const near = (t: number) => {
    for (let k = 0; k < 3; k++) {
      const o = idx[t * 3 + k] * 3;
      const dx = p[o] - center[0], dy = p[o + 1] - center[1], dz = p[o + 2] - center[2];
      if (dx * dx + dy * dy + dz * dz <= r2) return true;
    }
    return false;
  };
  const seen = new Uint8Array(nt);
  const out: number[] = [seed];
  const stack = [seed];
  seen[seed] = 1;
  while (stack.length) {
    const t = stack.pop()!;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      for (let i = vt.start[v]; i < vt.start[v + 1]; i++) {
        const u = vt.list[i];
        if (seen[u]) continue;
        seen[u] = 1;
        if (near(u)) {
          out.push(u);
          stack.push(u);
        }
      }
    }
  }
  return Uint32Array.from(out);
}

function selectedIds(sel: Uint8Array): Uint32Array {
  let n = 0;
  for (let i = 0; i < sel.length; i++) n += sel[i];
  const out = new Uint32Array(n);
  let o = 0;
  for (let i = 0; i < sel.length; i++) if (sel[i]) out[o++] = i;
  return out;
}
