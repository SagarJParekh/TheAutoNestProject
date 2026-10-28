/**
 * Shrinkwrap: wrap a closed surface around a part and make a solid of it.
 *
 * Works on any triangles (open, broken, self-intersecting, many shells): the
 * part is grown by `gap + offset` on a voxel grid, everything the outside
 * cannot reach is filled (holes, slots and cavities narrower than the gap are
 * closed), then the result is shrunk back by `gap` with a true distance
 * transform. Where nothing was bridged the wrap lies `offset` off the surface.
 */
import { Vector3 } from 'three';
import { MeshData, computeBounds, boundsDiagonal, flipMesh, triangleCount, ProgressFn, noProgress } from './mesh';
import { gridFor, makeBVH, squaredEDT, type Grid } from './sdf';
import { marchingTetrahedra } from './marching';
import { meshVolume } from './measure';

export interface WrapParams {
  /** openings, gaps and holes up to this size are closed over, mm */
  gap: number;
  /** extra distance of the wrap off the surface, mm */
  offset: number;
  /** voxel size in mm (0 = automatic from the quality) */
  voxel: number;
  quality: 'draft' | 'normal' | 'fine';
}

export const DEFAULT_WRAP: WrapParams = { gap: 2, offset: 0.2, voxel: 0, quality: 'normal' };

const DIVISIONS = { draft: 120, normal: 220, fine: 400 };
const BUDGET = { draft: 3e6, normal: 8e6, fine: 20e6 };

export function wrapVoxel(mesh: MeshData, p: WrapParams): number {
  if (p.voxel > 0) return p.voxel;
  const b = computeBounds(mesh.positions);
  const diag = boundsDiagonal(b);
  let h = diag / DIVISIONS[p.quality];
  if (p.gap > 0) h = Math.min(h, p.gap / 2);
  const reach = p.gap + p.offset;
  const size = [0, 1, 2].map((i) => b.max[i] - b.min[i]);
  for (let i = 0; i < 80 && size.reduce((n, s) => n * ((s + 2 * reach) / h + 8), 1) > BUDGET[p.quality]; i++) h *= 1.08;
  return h;
}

export function shrinkwrapMesh(mesh: MeshData, p: WrapParams, onProgress: ProgressFn = noProgress): { mesh: MeshData; voxelSize: number } {
  if (!(triangleCount(mesh) > 0)) throw new Error('The part has no triangles');
  const h = wrapVoxel(mesh, p);
  const gap = Math.max(0, p.gap), offset = Math.max(0, p.offset);
  // the part must grow by at least a voxel and a half or there is nothing to fill
  const reach = Math.max(gap + offset, 1.5 * h);
  const bounds = computeBounds(mesh.positions);
  const pad = Math.ceil(reach / h) + 3;
  const { origin, nx, ny, nz } = gridFor(bounds, h, pad);
  const N = nx * ny * nz;
  if (N > 60e6) throw new Error('The wrap would need too many voxels: use a larger voxel size or a lower quality');

  // 1. nodes next to the surface: sample every triangle finer than the grid
  onProgress(0.05, 'Rasterizing the surface');
  const seed = new Uint8Array(N);
  const pos = mesh.positions, idx = mesh.indices, nt = triangleCount(mesh);
  const mark = (x: number, y: number, z: number) => {
    const i = Math.round((x - origin[0]) / h), j = Math.round((y - origin[1]) / h), k = Math.round((z - origin[2]) / h);
    if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) seed[i + nx * (j + ny * k)] = 1;
  };
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const ux = pos[b] - ax, uy = pos[b + 1] - ay, uz = pos[b + 2] - az;
    const vx = pos[c] - ax, vy = pos[c + 1] - ay, vz = pos[c + 2] - az;
    const len = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(ux - vx, uy - vy, uz - vz));
    const n = Math.max(1, Math.ceil(len / (0.5 * h)));
    for (let i = 0; i <= n; i++)
      for (let j = 0; i + j <= n; j++) {
        const s = i / n, r = j / n;
        mark(ax + ux * s + vx * r, ay + uy * s + vy * r, az + uz * s + vz * r);
      }
  }

  // 2. distance to the surface (voxel estimate), exact close to it
  onProgress(0.25, 'Distance to the surface');
  const dU = squaredEDT(seed, nx, ny, nz);
  for (let n = 0; n < N; n++) dU[n] = Math.sqrt(dU[n]) * h;
  const near = offset + 2 * h;
  const bvh = makeBVH(mesh);
  const pt = new Vector3();
  const target = { point: new Vector3(), distance: 0, faceIndex: 0 };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const n = i + nx * (j + ny * k);
        if (dU[n] > near) continue;
        pt.set(origin[0] + i * h, origin[1] + j * h, origin[2] + k * h);
        const hit = bvh.closestPointToPoint(pt, target as never);
        if (hit) dU[n] = hit.distance;
      }

  // 3. grow, then flood the outside from the edge of the grid: what it cannot reach is solid
  onProgress(0.45, 'Closing gaps');
  const outside = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  const visit = (n: number) => {
    if (outside[n] || dU[n] < reach) return;
    outside[n] = 1;
    queue[qt++] = n;
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) visit(i + nx * (j + ny * k));
  const sxy = nx * ny;
  while (qh < qt) {
    const n = queue[qh++];
    const i = n % nx, j = ((n / nx) | 0) % ny, k = (n / sxy) | 0;
    if (i > 0) visit(n - 1);
    if (i < nx - 1) visit(n + 1);
    if (j > 0) visit(n - nx);
    if (j < ny - 1) visit(n + nx);
    if (k > 0) visit(n - sxy);
    if (k < nz - 1) visit(n + sxy);
  }

  // 4. shrink back by the gap: distance from the outside
  onProgress(0.6, 'Shrinking onto the part');
  const dE = squaredEDT(outside, nx, ny, nz);
  const data = new Float32Array(N);
  const tiny = h * 1.234e-3;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const n = i + nx * (j + ny * k);
        const border = i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1;
        // closed result, joined with the exact offset surface where nothing was bridged
        const v = Math.max(Math.sqrt(dE[n]) * h - (reach - offset), offset - dU[n]);
        data[n] = border ? -h : v - tiny;
      }
  const grid: Grid = { nx, ny, nz, origin, h, data };
  let out = marchingTetrahedra(grid, (f, m) => onProgress(0.7 + f * 0.28, m));
  if (!out.indices.length) throw new Error('Nothing to wrap: increase the gap or the offset');
  if (meshVolume(out) < 0) out = flipMesh(out);
  onProgress(1);
  return { mesh: out, voxelSize: h };
}
