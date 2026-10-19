/**
 * Wall thickness: for every triangle, the distance from its centre straight
 * into the part (against the outward normal) to the opposite wall.
 */
import { DoubleSide, Ray } from 'three';
import { MeshData, computeBounds, boundsDiagonal } from './mesh';
import { makeBVH } from './sdf';

export interface ThicknessResult {
  /** triangles the values belong to: xyz × 3 per triangle, part-local (large triangles are split for detail) */
  display: Float32Array;
  /** thickness per triangle in mm; NaN where the ray found no opposite wall (open part, flipped triangle) */
  values: Float32Array;
  min: number;
  max: number;
  /** area-weighted mean */
  mean: number;
  /** 95th percentile by area: the automatic top of the colour scale (ignores the few very long through-lengths) */
  p95: number;
  /** area of each triangle, mm² (for "how much is thinner than…") */
  areas: Float32Array;
}

/**
 * Split triangles longer than `maxEdge` into four (repeatedly) for a finer
 * heat map. Display only: the result has T-junctions and is not a mesh to
 * keep. Stops growing at `maxTris`.
 */
export function subdivideForDisplay(mesh: MeshData, maxEdge: number, maxTris = 600_000): Float32Array {
  const p = mesh.positions, idx = mesh.indices;
  let tris: number[] = [];
  for (let k = 0; k < idx.length; k++) tris.push(p[idx[k] * 3], p[idx[k] * 3 + 1], p[idx[k] * 3 + 2]);
  const m2 = maxEdge * maxEdge;
  for (let pass = 0; pass < 8; pass++) {
    const out: number[] = [];
    let split = false;
    const n = tris.length / 9;
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      const A = tris.slice(o, o + 3), B = tris.slice(o + 3, o + 6), C = tris.slice(o + 6, o + 9);
      const d2 = (u: number[], v: number[]) => (u[0] - v[0]) ** 2 + (u[1] - v[1]) ** 2 + (u[2] - v[2]) ** 2;
      const remaining = n - t - 1;
      if (Math.max(d2(A, B), d2(B, C), d2(C, A)) > m2 && out.length / 9 + 4 + remaining <= maxTris) {
        const mid = (u: number[], v: number[]) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2, (u[2] + v[2]) / 2];
        const ab = mid(A, B), bc = mid(B, C), ca = mid(C, A);
        out.push(...A, ...ab, ...ca, ...ab, ...B, ...bc, ...ca, ...bc, ...C, ...ab, ...bc, ...ca);
        split = true;
      } else out.push(...A, ...B, ...C);
    }
    tris = out;
    if (!split) break;
  }
  return Float32Array.from(tris);
}

export function triangleThickness(mesh: MeshData, onProgress?: (f: number) => void, detail = true): ThicknessResult {
  const bvh = makeBVH(mesh);
  const ray = new Ray();
  const diag = boundsDiagonal(computeBounds(mesh.positions));
  const eps = Math.max(1e-6, diag * 1e-6);
  // sample triangles: the part's own, or finer pieces of them for detail
  const display = detail ? subdivideForDisplay(mesh, diag / 120) : (() => {
    const out = new Float32Array(mesh.indices.length * 3);
    for (let k = 0; k < mesh.indices.length; k++) out.set(mesh.positions.subarray(mesh.indices[k] * 3, mesh.indices[k] * 3 + 3), k * 3);
    return out;
  })();
  const p = display;
  const nt = p.length / 9;
  const values = new Float32Array(nt);
  const areas = new Float32Array(nt);
  let min = Infinity, max = -Infinity, sum = 0, wsum = 0;
  for (let t = 0; t < nt; t++) {
    const a = t * 9, b = a + 3, c = a + 6;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    areas[t] = l / 2;
    if (!l) {
      values[t] = NaN;
      continue;
    }
    nx /= l; ny /= l; nz /= l;
    const cx = (p[a] + p[b] + p[c]) / 3, cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3, cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    // start just inside the surface and look straight in
    ray.origin.set(cx - nx * eps, cy - ny * eps, cz - nz * eps);
    ray.direction.set(-nx, -ny, -nz);
    const hit = bvh.raycastFirst(ray, DoubleSide);
    if (!hit) {
      values[t] = NaN;
      continue;
    }
    const d = hit.distance + eps;
    values[t] = d;
    if (d < min) min = d;
    if (d > max) max = d;
    sum += d * areas[t];
    wsum += areas[t];
    if (onProgress && (t & 0x3fff) === 0) onProgress(t / nt);
  }
  if (!Number.isFinite(min)) min = max = 0;
  // area-weighted 95th percentile
  const order: number[] = [];
  for (let t = 0; t < nt; t++) if (Number.isFinite(values[t])) order.push(t);
  order.sort((x, y) => values[x] - values[y]);
  let acc = 0, p95 = max;
  for (const t of order) {
    acc += areas[t];
    if (acc >= wsum * 0.95) {
      p95 = values[t];
      break;
    }
  }
  return { display, values, min, max, mean: wsum > 0 ? sum / wsum : 0, p95: Math.max(p95, min), areas };
}

/** Heat-map colour for a thickness: red (thin) → yellow → green → cyan → blue (thick); grey for no value. */
export function thicknessColor(v: number, lo: number, hi: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (!Number.isFinite(v)) {
    out[0] = out[1] = out[2] = 0.45;
    return out;
  }
  const t = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0.5;
  // piecewise stops
  const stops: [number, number, number, number][] = [
    [0, 0.9, 0.1, 0.1],
    [0.25, 1.0, 0.85, 0.1],
    [0.5, 0.2, 0.8, 0.25],
    [0.75, 0.1, 0.75, 0.85],
    [1, 0.2, 0.3, 0.95],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, r0, g0, b0] = stops[i - 1], [t1, r1, g1, b1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      out[0] = r0 + (r1 - r0) * k;
      out[1] = g0 + (g1 - g0) * k;
      out[2] = b0 + (b1 - b0) * k;
      return out;
    }
  }
  return out;
}
