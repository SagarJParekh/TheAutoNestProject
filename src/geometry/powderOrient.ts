/**
 * Orientation for powder-bed printing (SLS, HP MJF), following the usual
 * build-preparation rules instead of "largest flat face down":
 *
 * - no large flat surfaces parallel to the platform (they warp, sink and
 *   show layer steps); surfaces flatter than about 30° to the layers count,
 *   the flatter the more;
 * - no sudden jumps in cross-section from one layer to the next (heat
 *   builds up, parts warp): horizontal area should not pile up at one height;
 * - not needlessly tall (a small weight, the nesting packs in Z anyway).
 *
 * Every up-direction of a hemisphere is scored on a sample of the triangles
 * (any mesh size), the best is refined, and the part is then turned about Z
 * so its footprint lines up with X and Y.
 */
import { Quaternion, Vector3 } from 'three';
import type { MeshData } from './mesh';
import { minAreaRectAngle } from './orient';

export interface PowderOrientResult {
  /** rotation [x, y, z, w] to apply to the mesh (in its own coordinates) */
  quaternion: [number, number, number, number];
  /** share of the surface flatter than 30° to the layers, before → after */
  flatBefore: number;
  flatAfter: number;
  /** largest horizontal area in one 1 mm band, as a share of the surface, before → after */
  bandBefore: number;
  bandAfter: number;
}

const COS30 = Math.cos(Math.PI / 6);

interface Sample {
  n: Float64Array;
  c: Float64Array;
  a: Float64Array;
  total: number;
  diag: number;
  pts: Float64Array;
}

function sampleMesh(mesh: MeshData, maxTris = 30000, maxPts = 20000): Sample {
  const p = mesh.positions,
    idx = mesh.indices;
  const nt = idx.length / 3;
  const step = Math.max(1, Math.ceil(nt / maxTris));
  const m = Math.ceil(nt / step);
  const n = new Float64Array(m * 3),
    c = new Float64Array(m * 3),
    a = new Float64Array(m);
  let total = 0,
    k = 0;
  for (let t = 0; t < nt; t += step, k++) {
    const i0 = idx[t * 3] * 3,
      i1 = idx[t * 3 + 1] * 3,
      i2 = idx[t * 3 + 2] * 3;
    const ux = p[i1] - p[i0], uy = p[i1 + 1] - p[i0 + 1], uz = p[i1 + 2] - p[i0 + 2];
    const vx = p[i2] - p[i0], vy = p[i2 + 1] - p[i0 + 1], vz = p[i2 + 2] - p[i0 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    const area = l / 2;
    if (l > 0) {
      nx /= l;
      ny /= l;
      nz /= l;
    }
    n[k * 3] = nx;
    n[k * 3 + 1] = ny;
    n[k * 3 + 2] = nz;
    c[k * 3] = (p[i0] + p[i1] + p[i2]) / 3;
    c[k * 3 + 1] = (p[i0 + 1] + p[i1 + 1] + p[i2 + 1]) / 3;
    c[k * 3 + 2] = (p[i0 + 2] + p[i1 + 2] + p[i2 + 2]) / 3;
    a[k] = area;
    total += area;
  }
  const nv = p.length / 3;
  const vs = Math.max(1, Math.ceil(nv / maxPts));
  const pts = new Float64Array(Math.ceil(nv / vs) * 3);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0, j = 0; v < nv; v += vs, j++)
    for (let q = 0; q < 3; q++) {
      const x = p[v * 3 + q];
      pts[j * 3 + q] = x;
      if (x < lo[q]) lo[q] = x;
      if (x > hi[q]) hi[q] = x;
    }
  return { n, c, a, total: total || 1, diag: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1, pts };
}

/** Scores of an up-direction (lower is better). */
function score(s: Sample, ux: number, uy: number, uz: number, band = 1) {
  let flat = 0,
    flatShare = 0;
  const bins = new Map<number, number>();
  const { n, c, a } = s;
  for (let i = 0; i < a.length; i++) {
    const cos = Math.abs(n[i * 3] * ux + n[i * 3 + 1] * uy + n[i * 3 + 2] * uz);
    if (cos > COS30) {
      const w = (cos - COS30) / (1 - COS30);
      flat += a[i] * w * w;
      flatShare += a[i];
    }
    // horizontal (projected) area per height band
    const b = Math.floor((c[i * 3] * ux + c[i * 3 + 1] * uy + c[i * 3 + 2] * uz) / band);
    bins.set(b, (bins.get(b) ?? 0) + a[i] * cos);
  }
  let peak = 0;
  for (const v of bins.values()) if (v > peak) peak = v;
  let lo = Infinity,
    hi = -Infinity;
  const pts = s.pts;
  for (let i = 0; i < pts.length; i += 3) {
    const h = pts[i] * ux + pts[i + 1] * uy + pts[i + 2] * uz;
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  const flatCost = flat / s.total,
    bandCost = peak / s.total,
    heightCost = (hi - lo) / s.diag;
  return { cost: flatCost + 0.7 * bandCost + 0.15 * heightCost, flat: flatShare / s.total, band: bandCost };
}

/** Orientation of a part for SLS / HP MJF (see the file comment). */
export function powderOrient(mesh: MeshData): PowderOrientResult {
  const s = sampleMesh(mesh);
  const before = score(s, 0, 0, 1);
  // hemisphere of up-directions (u and −u score the same)
  const N = 400;
  let best = { u: [0, 0, 1], ...before };
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const z = 1 - (i + 0.5) / N; // 1 … 0
    const r = Math.sqrt(1 - z * z);
    const t = golden * i;
    const u = [Math.cos(t) * r, Math.sin(t) * r, z];
    const sc = score(s, u[0], u[1], u[2]);
    if (sc.cost < best.cost - 1e-12) best = { u, ...sc };
  }
  // refine around the best direction
  const tmp = new Vector3();
  for (const step of [6, 3, 1.5, 0.75].map((d) => (d * Math.PI) / 180)) {
    let improved = true;
    while (improved) {
      improved = false;
      const u0 = new Vector3(...best.u);
      const ax1 = new Vector3().crossVectors(u0, Math.abs(u0.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0)).normalize();
      const ax2 = new Vector3().crossVectors(u0, ax1).normalize();
      for (const ax of [ax1, ax2])
        for (const sg of [1, -1]) {
          tmp.copy(u0).applyAxisAngle(ax, sg * step);
          const sc = score(s, tmp.x, tmp.y, tmp.z);
          if (sc.cost < best.cost - 1e-12) {
            best = { u: [tmp.x, tmp.y, tmp.z], ...sc };
            improved = true;
          }
        }
    }
  }
  // turn the chosen up-direction to +Z, then line the footprint up with X / Y
  const rot = new Quaternion().setFromUnitVectors(new Vector3(...best.u).normalize(), new Vector3(0, 0, 1));
  const xy: number[] = [];
  const v = new Vector3();
  for (let i = 0; i < s.pts.length; i += 3) {
    v.set(s.pts[i], s.pts[i + 1], s.pts[i + 2]).applyQuaternion(rot);
    xy.push(v.x, v.y);
  }
  const turn = minAreaRectAngle(xy);
  if (Math.abs(turn) > 1e-9) rot.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), turn));
  return { quaternion: [rot.x, rot.y, rot.z, rot.w], flatBefore: before.flat, flatAfter: best.flat, bandBefore: before.band, bandAfter: best.band };
}
