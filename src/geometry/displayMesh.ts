/**
 * Light display copies of heavy meshes (vertex clustering): vertices are
 * snapped to a grid sized for the wanted triangle count and merged;
 * collapsed triangles are dropped. Fast (one pass) and good enough to look
 * at a build with hundreds of copies; never used for nesting or export.
 */
import type { MeshData } from './mesh';

export function clusterDecimate(mesh: MeshData, targetTris: number): MeshData {
  const p = mesh.positions,
    idx = mesh.indices;
  const nt = idx.length / 3;
  if (nt <= targetTris) return mesh;
  // surface area → grid cell size (a cell holds about two triangles of the result)
  let area = 0;
  const lo = [Infinity, Infinity, Infinity];
  for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) if (p[i + c] < lo[c]) lo[c] = p[i + c];
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  const cell = Math.max(1e-6, Math.sqrt((2 * area) / targetTris));
  const cellOf = new Map<number, number>();
  const sums: number[] = [];
  const counts: number[] = [];
  const nv = p.length / 3;
  const remap = new Int32Array(nv);
  const K = 1 << 20;
  for (let v = 0; v < nv; v++) {
    const ix = Math.floor((p[v * 3] - lo[0]) / cell),
      iy = Math.floor((p[v * 3 + 1] - lo[1]) / cell),
      iz = Math.floor((p[v * 3 + 2] - lo[2]) / cell);
    const key = ix + K * (iy + K * iz);
    let id = cellOf.get(key);
    if (id === undefined) {
      id = counts.length;
      cellOf.set(key, id);
      sums.push(0, 0, 0);
      counts.push(0);
    }
    sums[id * 3] += p[v * 3];
    sums[id * 3 + 1] += p[v * 3 + 1];
    sums[id * 3 + 2] += p[v * 3 + 2];
    counts[id]++;
    remap[v] = id;
  }
  const positions = new Float32Array(counts.length * 3);
  for (let i = 0; i < counts.length; i++) for (let c = 0; c < 3; c++) positions[i * 3 + c] = sums[i * 3 + c] / counts[i];
  const out: number[] = [];
  for (let t = 0; t < nt; t++) {
    const a = remap[idx[t * 3]], b = remap[idx[t * 3 + 1]], c = remap[idx[t * 3 + 2]];
    if (a !== b && b !== c && a !== c) out.push(a, b, c);
  }
  return { positions, indices: Uint32Array.from(out) };
}
