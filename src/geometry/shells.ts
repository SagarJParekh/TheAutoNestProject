import { Vector3 } from 'three';
import { MeshData, compactMesh, subsetTriangles, flipMesh, computeBounds, ProgressFn, noProgress } from './mesh';
import { findShells } from './topology';
import { gridFor, makeBVH, squaredEDT } from './sdf';
import { marchingTetrahedra } from './marching';
import { meshVolume } from './measure';
import { getManifold, toManifold, fromManifold, NotManifoldError } from './manifold';
import type { Manifold } from 'manifold-3d';

/** One mesh per connected shell, largest (by triangle count) first. */
export function splitShells(mesh: MeshData): MeshData[] {
  const { shellOfTri, shellCount } = findShells(mesh);
  if (shellCount <= 1) return [mesh];
  const out: MeshData[] = [];
  for (let s = 0; s < shellCount; s++) out.push(subsetTriangles(mesh, (t) => shellOfTri[t] === s));
  return out.sort((a, b) => b.indices.length - a.indices.length);
}

/**
 * Boolean-union all shells of a mesh into one solid (removes internal faces
 * where shells overlap). Every shell must be a closed manifold.
 */
export async function unifyShells(mesh: MeshData): Promise<{ mesh: MeshData; shells: number }> {
  const shells = splitShells(mesh);
  const wasm = await getManifold();
  const ms: Manifold[] = [];
  try {
    for (const s of shells) {
      const m = await toManifold(s);
      if (!m) throw new NotManifoldError('A shell');
      ms.push(m);
    }
    const u = wasm.Manifold.union(ms);
    const out = fromManifold(u);
    u.delete();
    return { mesh: out, shells: shells.length };
  } finally {
    ms.forEach((m) => m.delete());
  }
}

/**
 * Inside test by winding number along +Z rays: robust for overlapping or
 * self-intersecting shells (inside if covered by any shell). Expects
 * outward-oriented triangles.
 */
export function voxelizeWinding(
  mesh: MeshData,
  origin: [number, number, number],
  nx: number,
  ny: number,
  nz: number,
  h: number,
): Uint8Array {
  const p = mesh.positions, idx = mesh.indices;
  const nt = idx.length / 3;
  const cols = nx * ny;
  const jx = h * 1.2345e-4, jy = h * 2.7182e-4;
  const counts = new Uint32Array(cols + 1);
  const each = (cb: (col: number, z: number, dir: number) => void) => {
    for (let t = 0; t < nt; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const ax = p[a], ay = p[a + 1], bx = p[b], by = p[b + 1], cx = p[c], cy = p[c + 1];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (area === 0) continue;
      // ray along +Z enters through faces whose normal points down (area < 0)
      const dir = area < 0 ? 1 : -1;
      const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - origin[0] - jx) / h));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - origin[0] - jx) / h));
      const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - origin[1] - jy) / h));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - origin[1] - jy) / h));
      const inv = 1 / area;
      for (let j = j0; j <= j1; j++) {
        const y = origin[1] + j * h + jy;
        for (let i = i0; i <= i1; i++) {
          const x = origin[0] + i * h + jx;
          const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) * inv;
          const w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) * inv;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          cb(i + j * nx, w0 * p[a + 2] + w1 * p[b + 2] + w2 * p[c + 2], dir);
        }
      }
    }
  };
  each((col) => counts[col + 1]++);
  for (let i = 0; i < cols; i++) counts[i + 1] += counts[i];
  const zs = new Float64Array(counts[cols]);
  const dirs = new Int8Array(counts[cols]);
  const fill = counts.slice(0, cols);
  each((col, z, dir) => {
    const k = fill[col]++;
    zs[k] = z;
    dirs[k] = dir;
  });
  const inside = new Uint8Array(cols * nz);
  const order: number[] = [];
  for (let col = 0; col < cols; col++) {
    const s = counts[col], e = counts[col + 1];
    if (e - s < 2) continue;
    order.length = 0;
    for (let k = s; k < e; k++) order.push(k);
    order.sort((u, w) => zs[u] - zs[w]);
    let ptr = 0, wind = 0;
    for (let k = 0; k < nz; k++) {
      const z = origin[2] + k * h;
      while (ptr < order.length && zs[order[ptr]] < z) wind += dirs[order[ptr++]];
      if (wind > 0) inside[col + k * cols] = 1;
    }
  }
  return inside;
}

/** Default voxel size: ~1/150 of the largest dimension, within a 2.5M voxel budget. */
export function chooseSolidVoxel(mesh: MeshData, maxVoxels = 2.5e6): number {
  const b = computeBounds(mesh.positions);
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  return Math.max(Math.cbrt((sx * sy * sz) / maxVoxels), Math.max(sx, sy, sz) / 150, 1e-3);
}

/**
 * Rebuild a clean, watertight solid from a messy mesh (overlapping shells,
 * self-intersections, internal faces) by voxel winding classification plus
 * exact distances near the surface, then marching tetrahedra. Fine detail
 * below the voxel size is lost.
 */
export function makeSolid(mesh: MeshData, voxelSize = chooseSolidVoxel(mesh), onProgress: ProgressFn = noProgress): MeshData {
  const h = voxelSize;
  const bounds = computeBounds(mesh.positions);
  const { origin, nx, ny, nz } = gridFor(bounds, h, 2);
  const N = nx * ny * nz;
  if (N > 6e7) throw new Error('Voxel size too small for this part; increase it.');
  onProgress(0.05, 'Classifying voxels');
  const inside = voxelizeWinding(mesh, origin, nx, ny, nz, h);
  onProgress(0.3, 'Distance transform');
  const outSeed = new Uint8Array(N);
  for (let i = 0; i < N; i++) outSeed[i] = inside[i] ? 0 : 1;
  const dIn = squaredEDT(outSeed, nx, ny, nz);
  const dOut = squaredEDT(inside, nx, ny, nz);
  const data = new Float32Array(N);
  for (let i = 0; i < N; i++) data[i] = inside[i] ? (Math.sqrt(dIn[i]) - 0.5) * h : -(Math.sqrt(dOut[i]) - 0.5) * h;
  onProgress(0.5, 'Exact distances');
  const bvh = makeBVH(mesh);
  const pt = new Vector3();
  const target = { point: new Vector3(), distance: 0, faceIndex: 0 };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const n = i + nx * (j + ny * k);
        if (Math.abs(data[n]) > 2 * h) continue;
        pt.set(origin[0] + i * h, origin[1] + j * h, origin[2] + k * h);
        const r = bvh.closestPointToPoint(pt, target as never);
        if (!r) continue;
        // internal faces can be close to inside nodes; never let them flip the sign
        const d = Math.max(r.distance, 1e-6 * h);
        data[n] = inside[n] ? Math.min(d, Math.abs(data[n]) + h) : -d;
      }
    if ((k & 7) === 0) onProgress(0.5 + 0.35 * (k / nz), 'Exact distances');
  }
  const grid = { nx, ny, nz, origin, h, data };
  let out = marchingTetrahedra(grid, (f, m) => onProgress(0.85 + f * 0.13, m));
  if (meshVolume(out) < 0) out = flipMesh(out);
  onProgress(1);
  return compactMesh(out);
}
