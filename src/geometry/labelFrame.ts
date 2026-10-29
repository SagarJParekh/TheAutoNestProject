import type { Vec3 } from './mesh';

/** Orthonormal frame on a surface point: x = text right, y = text up, z = surface normal. */
export function labelFrame(point: Vec3, normal: Vec3, rotationDeg = 0, upHint?: Vec3): number[] {
  const l = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const n: Vec3 = [normal[0] / l, normal[1] / l, normal[2] / l];
  let up: Vec3 = upHint ?? (Math.abs(n[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1]);
  const d = up[0] * n[0] + up[1] * n[1] + up[2] * n[2];
  up = [up[0] - n[0] * d, up[1] - n[1] * d, up[2] - n[2] * d];
  const ul = Math.hypot(up[0], up[1], up[2]) || 1;
  up = [up[0] / ul, up[1] / ul, up[2] / ul];
  let r: Vec3 = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
  const a = (rotationDeg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const r2: Vec3 = [r[0] * ca + up[0] * sa, r[1] * ca + up[1] * sa, r[2] * ca + up[2] * sa];
  const u2: Vec3 = [-r[0] * sa + up[0] * ca, -r[1] * sa + up[1] * ca, -r[2] * sa + up[2] * ca];
  r = r2;
  return [r[0], r[1], r[2], 0, u2[0], u2[1], u2[2], 0, n[0], n[1], n[2], 0, point[0], point[1], point[2], 1];
}
