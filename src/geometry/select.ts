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
