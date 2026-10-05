import { Mat4, MeshData, Vec3, computeBounds, flipMesh } from './mesh';

export const IDENTITY: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function transformPositions(positions: Float32Array, m: Mat4): Float32Array {
  const out = new Float32Array(positions.length);
  const m0 = m[0], m1 = m[1], m2 = m[2], m4 = m[4], m5 = m[5], m6 = m[6];
  const m8 = m[8], m9 = m[9], m10 = m[10], m12 = m[12], m13 = m[13], m14 = m[14];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = m0 * x + m4 * y + m8 * z + m12;
    out[i + 1] = m1 * x + m5 * y + m9 * z + m13;
    out[i + 2] = m2 * x + m6 * y + m10 * z + m14;
  }
  return out;
}

export function isIdentity(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(m[i] - IDENTITY[i]) > 1e-12) return false;
  return true;
}

/**
 * Bake a transform into the mesh. A negative determinant (mirroring) flips
 * triangle winding so normals stay outward.
 */
export function applyMatrix(mesh: MeshData, m: Mat4): MeshData {
  if (isIdentity(m)) return mesh;
  const out: MeshData = { positions: transformPositions(mesh.positions, m), indices: mesh.indices };
  const det =
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  return det < 0 ? flipMesh(out) : out;
}

export function translateMesh(mesh: MeshData, d: Vec3): MeshData {
  return applyMatrix(mesh, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, d[0], d[1], d[2], 1]);
}

/** Mirror across the plane through `center` perpendicular to the axis (0=X,1=Y,2=Z). */
export function mirrorMesh(mesh: MeshData, axis: 0 | 1 | 2, center?: Vec3): MeshData {
  const b = computeBounds(mesh.positions);
  const c = center ?? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const m = [...IDENTITY];
  m[axis * 5] = -1;
  m[12 + axis] = 2 * c[axis];
  return applyMatrix(mesh, m);
}

/** Uniform or per-axis scale about a centre point. */
export function scaleMesh(mesh: MeshData, s: Vec3, center: Vec3 = [0, 0, 0]): MeshData {
  return applyMatrix(mesh, [
    s[0], 0, 0, 0,
    0, s[1], 0, 0,
    0, 0, s[2], 0,
    center[0] * (1 - s[0]), center[1] * (1 - s[1]), center[2] * (1 - s[2]), 1,
  ]);
}

/**
 * Quaternion [x,y,z,w] rotating unit vector `from` onto unit vector `to`.
 */
export function quaternionFromUnitVectors(from: Vec3, to: Vec3): [number, number, number, number] {
  let r = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + 1;
  let x: number, y: number, z: number;
  if (r < 1e-8) {
    r = 0;
    if (Math.abs(from[0]) > Math.abs(from[2])) {
      x = -from[1]; y = from[0]; z = 0;
    } else {
      x = 0; y = -from[2]; z = from[1];
    }
  } else {
    x = from[1] * to[2] - from[2] * to[1];
    y = from[2] * to[0] - from[0] * to[2];
    z = from[0] * to[1] - from[1] * to[0];
  }
  const l = Math.hypot(x, y, z, r);
  return [x / l, y / l, z / l, r / l];
}

/** Rotation that turns a face with normal `n` so that it faces straight down (-Z). */
export function layFlatQuaternion(n: Vec3): [number, number, number, number] {
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return quaternionFromUnitVectors([n[0] / l, n[1] / l, n[2] / l], [0, 0, -1]);
}

export function matrixFromQuaternion(q: [number, number, number, number]): number[] {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
}

/** Translate so the lowest point sits on Z = 0. */
export function dropToBed(mesh: MeshData): MeshData {
  const b = computeBounds(mesh.positions);
  return translateMesh(mesh, [0, 0, -b.min[2]]);
}

/** Translate so the bounding box is centred on the origin in X/Y (Z unchanged). */
export function centerOnOrigin(mesh: MeshData): MeshData {
  const b = computeBounds(mesh.positions);
  return translateMesh(mesh, [-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, 0]);
}
