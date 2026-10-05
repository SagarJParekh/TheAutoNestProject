import { MeshData, Vec3 } from './mesh';
import { planeBasis } from './triangulate';

/** Axis-aligned box from min to max, outward-oriented, 12 triangles. */
export function boxMesh(min: Vec3 = [0, 0, 0], max: Vec3 = [1, 1, 1]): MeshData {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom (-Z)
    4, 5, 6, 4, 6, 7, // top (+Z)
    0, 1, 5, 0, 5, 4, // front (-Y)
    2, 3, 7, 2, 7, 6, // back (+Y)
    1, 2, 6, 1, 6, 5, // right (+X)
    3, 0, 4, 3, 4, 7, // left (-X)
  ]);
  return { positions, indices };
}

/**
 * Closed prism: a regular polygon with `sides` corners and circumradius
 * `radius`, centred at `base`, extruded along `axis` by `length`.
 * `rotation` (radians) spins the polygon around the axis.
 */
export function prismMesh(base: Vec3, axis: Vec3, radius: number, length: number, sides: number, rotation = 0): MeshData {
  const al = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const n: Vec3 = [axis[0] / al, axis[1] / al, axis[2] / al];
  const { u, v } = planeBasis(n);
  const positions = new Float32Array((sides * 2 + 2) * 3);
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    const cx = Math.cos(a) * radius, cy = Math.sin(a) * radius;
    for (let k = 0; k < 2; k++) {
      const o = (i * 2 + k) * 3;
      const h = k * length;
      positions[o] = base[0] + u[0] * cx + v[0] * cy + n[0] * h;
      positions[o + 1] = base[1] + u[1] * cx + v[1] * cy + n[1] * h;
      positions[o + 2] = base[2] + u[2] * cx + v[2] * cy + n[2] * h;
    }
  }
  const cb = sides * 2, ct = sides * 2 + 1;
  positions.set(base, cb * 3);
  positions.set([base[0] + n[0] * length, base[1] + n[1] * length, base[2] + n[2] * length], ct * 3);
  const idx: number[] = [];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const b0 = i * 2, t0 = i * 2 + 1, b1 = j * 2, t1 = j * 2 + 1;
    // u × v = n so increasing angle is CCW seen from +n
    idx.push(b0, b1, t1, b0, t1, t0); // side
    idx.push(cb, b1, b0); // bottom faces -n
    idx.push(ct, t0, t1); // top faces +n
  }
  return { positions, indices: Uint32Array.from(idx) };
}

export function cylinderMesh(base: Vec3, axis: Vec3, radius: number, length: number, segments = 32): MeshData {
  return prismMesh(base, axis, radius, length, segments);
}

/**
 * Extrude a convex/star-shaped 2D polygon (CCW in the u/v frame, flat
 * [x0,y0,...]) placed at `base` along `axis` by `length`. The result is a
 * closed, outward-oriented solid regardless of frame handedness.
 */
export function extrudePolygon(base: Vec3, u: Vec3, v: Vec3, axis: Vec3, pts: ArrayLike<number>, length: number): MeshData {
  const n = pts.length / 2;
  const al = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const ax: Vec3 = [(axis[0] / al) * length, (axis[1] / al) * length, (axis[2] / al) * length];
  const positions = new Float32Array((n * 2 + 2) * 3);
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    cx += x / n; cy += y / n;
    for (let k = 0; k < 2; k++) {
      const o = (i * 2 + k) * 3;
      positions[o] = base[0] + u[0] * x + v[0] * y + ax[0] * k;
      positions[o + 1] = base[1] + u[1] * x + v[1] * y + ax[1] * k;
      positions[o + 2] = base[2] + u[2] * x + v[2] * y + ax[2] * k;
    }
  }
  const cb = n * 2, ct = n * 2 + 1;
  for (let k = 0; k < 2; k++) {
    const o = (cb + k) * 3;
    positions[o] = base[0] + u[0] * cx + v[0] * cy + ax[0] * k;
    positions[o + 1] = base[1] + u[1] * cx + v[1] * cy + ax[1] * k;
    positions[o + 2] = base[2] + u[2] * cx + v[2] * cy + ax[2] * k;
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = i * 2, t0 = i * 2 + 1, b1 = j * 2, t1 = j * 2 + 1;
    idx.push(b0, b1, t1, b0, t1, t0, cb, b1, b0, ct, t0, t1);
  }
  const indices = Uint32Array.from(idx);
  // fix orientation using the signed volume
  let vol = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    vol +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  if (vol < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const s = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = s;
    }
  }
  return { positions, indices };
}

/** Regular polygon points (flat 2D) with circumradius r, centred at (x, y). */
export function regularPolygon(x: number, y: number, r: number, sides: number, rotation = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    out.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  return out;
}
