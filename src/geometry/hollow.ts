import { MeshData, Vec3, computeBounds, flipMesh, mergeMeshes, ProgressFn, noProgress } from './mesh';
import { signedDistanceGrid } from './sdf';
import { marchingTetrahedra } from './marching';
import { meshVolume } from './measure';
import { cylinderMesh } from './primitives';

export interface HollowOptions {
  /** wall thickness in mm */
  thickness: number;
  /** voxel budget for the distance field (default 6 million) */
  maxVoxels?: number;
  /** explicit voxel size in mm (overrides the automatic choice) */
  voxelSize?: number;
}

export interface HollowResult {
  /** outer surface + inward-facing inner shell */
  mesh: MeshData;
  inner: MeshData;
  voxelSize: number;
}

export function chooseVoxelSize(mesh: MeshData, thickness: number, maxVoxels = 6e6): number {
  const b = computeBounds(mesh.positions);
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  const ideal = thickness / 3;
  // keep the padded grid within budget
  let h = ideal;
  for (let i = 0; i < 60; i++) {
    const n = (sx / h + 6) * (sy / h + 6) * (sz / h + 6);
    if (n <= maxVoxels) break;
    h *= 1.1;
  }
  return h;
}

/**
 * Hollow a closed mesh: builds a signed distance field on a voxel grid, then
 * extracts the iso-surface at depth `thickness` as the inner wall. The inner
 * shell is a true offset (no self-intersections, unlike vertex-normal offset).
 */
export function hollowMesh(mesh: MeshData, opts: HollowOptions, onProgress: ProgressFn = noProgress): HollowResult {
  const t = opts.thickness;
  if (!(t > 0)) throw new Error('Wall thickness must be positive');
  const h = opts.voxelSize ?? chooseVoxelSize(mesh, t, opts.maxVoxels);
  const grid = signedDistanceGrid(mesh, h, {
    pad: 2,
    bandCenter: t,
    bandWidth: 2.5 * h,
    onProgress: (f, m) => onProgress(f * 0.85, m),
  });
  const d = grid.data;
  // the tiny extra offset keeps grid nodes off the iso-surface (avoids degenerate triangles)
  const iso = t + h * 1.234e-3;
  for (let i = 0; i < d.length; i++) d[i] = d[i] - iso;
  let inner = marchingTetrahedra(grid, (f, m) => onProgress(0.85 + f * 0.13, m));
  if (inner.indices.length === 0) {
    throw new Error(`Wall thickness ${t} mm leaves no interior cavity; use a smaller value.`);
  }
  // inner wall must face into the cavity (negative signed volume)
  if (meshVolume(inner) > 0) inner = flipMesh(inner);
  onProgress(1);
  return { mesh: mergeMeshes([mesh, inner]), inner, voxelSize: h };
}

export interface DrainHole {
  /** point on the outer surface */
  point: Vec3;
  /** outward surface normal at that point */
  normal: Vec3;
}

/** Cylinders that cut from just outside the surface through the wall into the cavity. */
export function drainHoleCutters(holes: DrainHole[], diameter: number, thickness: number, voxelSize = 0): MeshData[] {
  return holes.map((hole) => {
    const l = Math.hypot(hole.normal[0], hole.normal[1], hole.normal[2]) || 1;
    const n: Vec3 = [hole.normal[0] / l, hole.normal[1] / l, hole.normal[2] / l];
    const out = 1;
    const base: Vec3 = [hole.point[0] + n[0] * out, hole.point[1] + n[1] * out, hole.point[2] + n[2] * out];
    const length = out + thickness + 2 * voxelSize + Math.max(1, diameter * 0.5);
    return cylinderMesh(base, [-n[0], -n[1], -n[2]], diameter / 2, length, 32);
  });
}
