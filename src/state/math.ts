import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { applyMatrix, computeBounds, MeshData, Vec3 } from '../geometry';
import type { Part, Transform } from './types';

const D2R = Math.PI / 180;

export function quaternionOf(t: Transform): Quaternion {
  return new Quaternion().setFromEuler(new Euler(t.rotation[0] * D2R, t.rotation[1] * D2R, t.rotation[2] * D2R, 'XYZ'));
}

export function matrixOf(t: Transform): Matrix4 {
  return new Matrix4().compose(new Vector3(...t.position), quaternionOf(t), new Vector3(...t.scale));
}

export function eulerDegFromQuaternion(q: Quaternion): Vec3 {
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  const r = (v: number) => {
    const d = v / D2R;
    const rounded = Math.round(d * 1e6) / 1e6;
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  return [r(e.x), r(e.y), r(e.z)];
}

/** Mesh with the part transform baked in (world space). */
export function worldMesh(p: Part): MeshData {
  return applyMatrix(p.mesh, matrixOf(p.transform).elements);
}

/** World-space bounding box of a part (exact, from vertices). */
export function worldBounds(p: Part): Box3 {
  const m = matrixOf(p.transform).elements;
  const pos = p.mesh.positions;
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const [m0, m1, m2, , m4, m5, m6, , m8, m9, m10, , m12, m13, m14] = m;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    const wx = m0 * x + m4 * y + m8 * z + m12;
    const wy = m1 * x + m5 * y + m9 * z + m13;
    const wz = m2 * x + m6 * y + m10 * z + m14;
    if (wx < min.x) min.x = wx;
    if (wy < min.y) min.y = wy;
    if (wz < min.z) min.z = wz;
    if (wx > max.x) max.x = wx;
    if (wy > max.y) max.y = wy;
    if (wz > max.z) max.z = wz;
  }
  return new Box3(min, max);
}

export function sceneBounds(parts: Part[]): Box3 {
  const b = new Box3();
  for (const p of parts) if (p.visible) b.union(worldBounds(p));
  return b;
}

/** Recentre a world-space mesh so the bbox centre is the local origin. */
export function recenter(mesh: MeshData): { mesh: MeshData; center: Vec3 } {
  const b = computeBounds(mesh.positions);
  const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const p = new Float32Array(mesh.positions.length);
  for (let i = 0; i < p.length; i += 3) {
    p[i] = mesh.positions[i] - c[0];
    p[i + 1] = mesh.positions[i + 1] - c[1];
    p[i + 2] = mesh.positions[i + 2] - c[2];
  }
  return { mesh: { positions: p, indices: mesh.indices }, center: c };
}

export const IDENTITY_TRANSFORM = (position: Vec3 = [0, 0, 0]): Transform => ({
  position,
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

/** World normal from the plane settings. */
/** The two world axes an axis-aligned plane can be tilted about. */
export const TILT_AXES: Record<string, [string, string]> = { x: ['Y', 'Z'], y: ['X', 'Z'], z: ['X', 'Y'] };

function rotateAbout(v: Vec3, axis: string, deg: number): Vec3 {
  if (!deg) return v;
  const a = deg * D2R, c = Math.cos(a), s = Math.sin(a);
  const [x, y, z] = v;
  if (axis === 'X') return [x, y * c - z * s, y * s + z * c];
  if (axis === 'Y') return [x * c + z * s, y, -x * s + z * c];
  return [x * c - y * s, x * s + y * c, z];
}

export function planeNormal(s: { axis: string; azimuth: number; elevation: number; flip: boolean; tiltA?: number; tiltB?: number }): Vec3 {
  let n: Vec3;
  switch (s.axis) {
    case 'x': n = [1, 0, 0]; break;
    case 'y': n = [0, 1, 0]; break;
    case 'z': n = [0, 0, 1]; break;
    default: {
      const az = s.azimuth * D2R, el = s.elevation * D2R;
      n = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
    }
  }
  const tilt = TILT_AXES[s.axis];
  if (tilt) n = rotateAbout(rotateAbout(n, tilt[0], s.tiltA ?? 0), tilt[1], s.tiltB ?? 0);
  return s.flip ? [-n[0], -n[1], -n[2]] : n;
}

/** Plane from settings. `offset` is measured along the un-flipped normal so flipping keeps the plane in place. */
export function planeFromSettings(s: { axis: string; azimuth: number; elevation: number; flip: boolean; offset: number; tiltA?: number; tiltB?: number }) {
  const n = planeNormal({ ...s, flip: false });
  return s.flip
    ? { normal: [-n[0], -n[1], -n[2]] as Vec3, constant: -s.offset }
    : { normal: n, constant: s.offset };
}

const localBoundsCache = new WeakMap<MeshData, Box3>();

export function localBounds(mesh: MeshData): Box3 {
  let b = localBoundsCache.get(mesh);
  if (!b) {
    const r = computeBounds(mesh.positions);
    b = new Box3(new Vector3(...r.min), new Vector3(...r.max));
    localBoundsCache.set(mesh, b);
  }
  return b;
}

/** Cheap world bounds: transformed local box corners (may be slightly larger than exact under rotation). */
export function approxWorldBounds(p: Part): Box3 {
  return localBounds(p.mesh).clone().applyMatrix4(matrixOf(p.transform));
}

export function approxSceneBounds(parts: Part[]): Box3 {
  const b = new Box3();
  for (const p of parts) if (p.visible) b.union(approxWorldBounds(p));
  return b;
}

/** Plane settings moved so the plane passes through the centre of the given parts. */
export function centeredPlane<T extends { axis: string; azimuth: number; elevation: number; flip: boolean; offset: number; tiltA?: number; tiltB?: number }>(s: T, parts: Part[]): T {
  const b = approxSceneBounds(parts);
  if (b.isEmpty()) return s;
  const c = b.getCenter(new Vector3());
  const n = planeNormal({ ...s, flip: false });
  return { ...s, offset: Math.round((c.x * n[0] + c.y * n[1] + c.z * n[2]) * 100) / 100 };
}
