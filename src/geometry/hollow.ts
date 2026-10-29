import { MeshData, Vec3, computeBounds, flipMesh, mergeMeshes, ProgressFn, noProgress } from './mesh';
import { Vector3 } from 'three';
import { makeBVH, signedDistanceGrid } from './sdf';
import { marchingTetrahedra } from './marching';
import { meshVolume } from './measure';
import { holeCutter } from './perforate';
import { planeBasis } from './triangulate';

export interface HollowOptions {
  /** wall thickness in mm */
  thickness: number;
  /** voxel budget for the distance field (default 6 million) */
  maxVoxels?: number;
  /** explicit voxel size in mm (overrides the automatic choice) */
  voxelSize?: number;
  /** voxels across the wall the automatic choice aims for (default 3) */
  perWall?: number;
}

export interface HollowResult {
  /** outer surface + inward-facing inner shell */
  mesh: MeshData;
  inner: MeshData;
  voxelSize: number;
}

export function chooseVoxelSize(mesh: MeshData, thickness: number, maxVoxels = 6e6, perWall = 3): number {
  const b = computeBounds(mesh.positions);
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  const ideal = thickness / perWall;
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
  const h = opts.voxelSize ?? chooseVoxelSize(mesh, t, opts.maxVoxels, opts.perWall);
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
  onProgress(0.98, 'Placing the inner wall exactly');
  inner = snapToOffset(inner, mesh, t);
  onProgress(1);
  return { mesh: mergeMeshes([mesh, inner]), inner, voxelSize: h };
}

/**
 * Move every vertex of an offset surface to exactly `distance` from the
 * original surface, along the line to its closest point there. The voxel
 * grid only places the inner wall to within a voxel; this takes that error
 * out, so the wall is as thick as asked everywhere and follows the detail.
 */
export function snapToOffset(offset: MeshData, surface: MeshData, distance: number): MeshData {
  const bvh = makeBVH(surface);
  const p = offset.positions.slice();
  const v = new Vector3();
  const target = { point: new Vector3(), distance: 0, faceIndex: 0 };
  for (let i = 0; i < p.length; i += 3) {
    v.set(p[i], p[i + 1], p[i + 2]);
    const r = bvh.closestPointToPoint(v, target as never);
    if (!r || r.distance < 1e-9) continue;
    // only small corrections: a vertex that is far off is near a feature the offset cannot follow
    if (Math.abs(r.distance - distance) > 0.75 * distance) continue;
    const f = distance / r.distance, c = r.point;
    p[i] = c.x + (v.x - c.x) * f;
    p[i + 1] = c.y + (v.y - c.y) * f;
    p[i + 2] = c.z + (v.z - c.z) * f;
  }
  return { positions: p, indices: offset.indices };
}

export interface DrainHole {
  /** point on the outer surface */
  point: Vec3;
  /** outward surface normal at that point */
  normal: Vec3;
}

/** Cylinders that cut from just outside the surface through the wall into the cavity. */
export function drainHoleCutters(holes: DrainHole[], diameter: number, thickness: number, voxelSize = 0, exitDiameter = diameter): MeshData[] {
  // the hole tapers from `diameter` at the surface to `exitDiameter` where it reaches the cavity
  const ratio = diameter > 0 ? Math.max(0.05, exitDiameter / diameter) : 1;
  const beyond = 2 * voxelSize + Math.max(1, Math.max(diameter, exitDiameter) * 0.5);
  return holes.map((hole) => {
    const l = Math.hypot(hole.normal[0], hole.normal[1], hole.normal[2]) || 1;
    const n: Vec3 = [hole.normal[0] / l, hole.normal[1] / l, hole.normal[2] / l];
    const { u, v } = planeBasis(n);
    return holeCutter(hole.point, n, u, v, diameter / 2, ratio, 32, 0, thickness, beyond);
  });
}
