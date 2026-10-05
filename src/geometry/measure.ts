import { Bounds, Mat4, MeshData, computeBounds, triangleCount } from './mesh';
import { transformPositions } from './transform';

export interface MeshMeasurements {
  bounds: Bounds;
  size: [number, number, number];
  triangles: number;
  vertices: number;
  /** mm³, signed sum (positive for outward-oriented closed meshes) */
  volume: number;
  /** mm² */
  area: number;
}

export function meshVolume(mesh: MeshData): number {
  const p = mesh.positions, idx = mesh.indices;
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function meshArea(mesh: MeshData): number {
  const p = mesh.positions, idx = mesh.indices;
  let s = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    s += Math.sqrt(nx * nx + ny * ny + nz * nz);
  }
  return s / 2;
}

/** Bounding box, size, triangle count, volume and area (optionally after applying a matrix). */
export function measureMesh(mesh: MeshData, matrix?: Mat4): MeshMeasurements {
  const m = matrix ? { positions: transformPositions(mesh.positions, matrix), indices: mesh.indices } : mesh;
  const bounds = computeBounds(m.positions);
  let volume = meshVolume(m);
  if (matrix && determinant3(matrix) < 0) volume = -volume;
  return {
    bounds,
    size: [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]],
    triangles: triangleCount(mesh),
    vertices: mesh.positions.length / 3,
    volume,
    area: meshArea(m),
  };
}

export function determinant3(m: Mat4): number {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}
