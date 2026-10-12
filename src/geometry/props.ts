import { DoubleSide, Ray } from 'three';
import { MeshData, Vec3, mergeMeshes } from './mesh';
import { planPerforation } from './perforate';
import { planeBasis } from './triangulate';
import { makeBVH } from './sdf';

export interface PropParams {
  /** prop diameter, mm */
  diameter: number;
  /** centre-to-centre distance, mm */
  spacing: number;
  /** keep props this far from the face border, mm */
  margin: number;
  /** ignore gaps longer than this, mm */
  maxLength: number;
  /** how far each end sinks into the faces, mm */
  embed: number;
  segments?: number;
  maxProps?: number;
  /** cross-section; the diameter is the width across flats (the polygon fits around a circle of that diameter) */
  shape?: PropShape;
  /** neck the prop down at both ends where it meets the part */
  thinEnds?: boolean;
  /** width of the thin ends, mm */
  tipDiameter?: number;
  /** length of each thin end outside the surface, mm (the embedded part is thin too) */
  tipLength?: number;
}

export type PropShape = 'circle' | 'square' | 'hexagon' | 'triangle';

const SIDES: Record<PropShape, number> = { circle: 24, square: 4, hexagon: 6, triangle: 3 };

/**
 * One closed prop from `start` along `dir` over `length` mm, with the
 * chosen cross-section and (optionally) thinner ends: the first and last
 * `embed + tipLength` mm use the tip width, the middle the full width.
 */
export function propMesh(start: Vec3, dir: Vec3, length: number, params: PropParams): MeshData {
  const shape = params.shape ?? 'circle';
  const sides = shape === 'circle' ? params.segments ?? SIDES.circle : SIDES[shape];
  // circumradius of a polygon whose inscribed circle has the given diameter
  const circ = (d: number) => (shape === 'circle' ? d / 2 : d / 2 / Math.cos(Math.PI / sides));
  const R = circ(params.diameter);
  const rings: [number, number][] = [];
  const tipD = Math.min(params.tipDiameter ?? params.diameter / 2, params.diameter);
  let tip = (params.tipLength ?? 0) + params.embed;
  if (params.thinEnds && tipD > 0 && tipD < params.diameter && tip > 0) {
    // keep at least a third of the prop at full width
    tip = Math.min(tip, length / 3);
    const r = circ(tipD);
    rings.push([0, r], [tip, r], [tip, R], [length - tip, R], [length - tip, r], [length, r]);
  } else rings.push([0, R], [length, R]);
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const n: Vec3 = [dir[0] / l, dir[1] / l, dir[2] / l];
  const { u, v } = planeBasis(n);
  const rot = shape === 'circle' ? 0 : Math.PI / sides;
  const nr = rings.length;
  const positions = new Float32Array((nr * sides + 2) * 3);
  for (let k = 0; k < nr; k++) {
    const [h, r] = rings[k];
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * Math.PI * 2;
      const cx = Math.cos(a) * r, cy = Math.sin(a) * r;
      const o = (k * sides + i) * 3;
      for (let c = 0; c < 3; c++) positions[o + c] = start[c] + u[c] * cx + v[c] * cy + n[c] * h;
    }
  }
  const cb = nr * sides, ct = cb + 1;
  for (let c = 0; c < 3; c++) {
    positions[cb * 3 + c] = start[c];
    positions[ct * 3 + c] = start[c] + n[c] * length;
  }
  const idx: number[] = [];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    for (let k = 0; k + 1 < nr; k++) {
      const b0 = k * sides + i, b1 = k * sides + j, t0 = (k + 1) * sides + i, t1 = (k + 1) * sides + j;
      idx.push(b0, b1, t1, b0, t1, t0);
    }
    idx.push(cb, j, i);
    idx.push(ct, (nr - 1) * sides + i, (nr - 1) * sides + j);
  }
  return { positions, indices: Uint32Array.from(idx) };
}

export interface PropPlan {
  props: { start: Vec3; end: Vec3 }[];
  /** all props as one mesh (separate closed cylinders) */
  mesh: MeshData;
  direction: Vec3;
  skipped: number;
}

/**
 * Generate cylindrical props from a face region on `source` towards
 * `target` (another part, or the same mesh for props between shells).
 * Props are laid out on a grid over the face and cast along the face normal
 * (flipped if needed to point at `towards`); each prop spans the gap to the
 * first surface hit, sunk `embed` mm into both ends.
 */
export function planProps(
  source: MeshData,
  regionTris: ArrayLike<number>,
  target: MeshData,
  params: PropParams,
  towards?: Vec3,
): PropPlan {
  const layout = planPerforation(source, regionTris, {
    pattern: 'square',
    size: params.diameter,
    spacing: Math.max(0, params.spacing - params.diameter),
    margin: params.margin,
    maxHoles: params.maxProps ?? 5000,
  });
  let d = layout.normal;
  if (towards) {
    const o = layout.origin;
    const v = [towards[0] - o[0], towards[1] - o[1], towards[2] - o[2]];
    if (v[0] * d[0] + v[1] * d[1] + v[2] * d[2] < 0) d = [-d[0], -d[1], -d[2]];
  }
  const bvh = makeBVH(target);
  const ray = new Ray();
  const props: { start: Vec3; end: Vec3 }[] = [];
  const parts: MeshData[] = [];
  let skipped = 0;
  const eps = 0.02;
  for (const c of layout.centers) {
    ray.origin.set(c[0] + d[0] * eps, c[1] + d[1] * eps, c[2] + d[2] * eps);
    ray.direction.set(d[0], d[1], d[2]);
    const hit = bvh.raycastFirst(ray, DoubleSide);
    if (!hit || hit.distance + eps > params.maxLength) {
      skipped++;
      continue;
    }
    const len = hit.distance + eps;
    const start: Vec3 = [c[0] - d[0] * params.embed, c[1] - d[1] * params.embed, c[2] - d[2] * params.embed];
    const end: Vec3 = [c[0] + d[0] * (len + params.embed), c[1] + d[1] * (len + params.embed), c[2] + d[2] * (len + params.embed)];
    props.push({ start, end });
    parts.push(propMesh(start, d, len + 2 * params.embed, params));
  }
  return { props, mesh: mergeMeshes(parts), direction: d, skipped };
}

/**
 * Normal hairs split in two sets: triangles marked in `inward` (e.g. the
 * flipped triangles from analysis) and all the others.
 */
export function faceNormalSegmentsSplit(
  mesh: MeshData,
  length: number,
  inward: ArrayLike<number> | null,
  maxCount = 60000,
): { outward: Float32Array; inward: Float32Array } {
  const all = faceNormalSegments(mesh, length, maxCount);
  if (!inward || !inward.length) return { outward: all, inward: new Float32Array(0) };
  const nt = mesh.indices.length / 3;
  const stride = Math.max(1, Math.ceil(nt / maxCount));
  const mark = new Uint8Array(nt);
  for (let i = 0; i < inward.length; i++) mark[inward[i]] = 1;
  const outA: number[] = [], inA: number[] = [];
  let k = 0;
  for (let t = 0; t < nt; t += stride, k++) {
    const dst = mark[t] ? inA : outA;
    for (let j = 0; j < 6; j++) dst.push(all[k * 6 + j]);
  }
  // flipped triangles may fall between the samples: add them all (up to the budget)
  if (stride > 1) {
    for (let i = 0; i < inward.length && inA.length < maxCount * 6; i++) {
      const t = inward[i];
      if (t % stride === 0) continue;
      const seg = faceNormalSegments({ positions: mesh.positions, indices: mesh.indices.subarray(t * 3, t * 3 + 3) }, length, 1);
      for (let j = 0; j < 6; j++) inA.push(seg[j]);
    }
  }
  return { outward: Float32Array.from(outA), inward: Float32Array.from(inA) };
}

export function faceNormalSegments(mesh: MeshData, length: number, maxCount = 60000): Float32Array {
  const nt = mesh.indices.length / 3;
  const stride = Math.max(1, Math.ceil(nt / maxCount));
  const n = Math.ceil(nt / stride);
  const out = new Float32Array(n * 6);
  const p = mesh.positions, idx = mesh.indices;
  let o = 0;
  for (let t = 0; t < nt; t += stride) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const cx = (p[a] + p[b] + p[c]) / 3, cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3, cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx = (nx / l) * length; ny = (ny / l) * length; nz = (nz / l) * length;
    out[o++] = cx; out[o++] = cy; out[o++] = cz;
    out[o++] = cx + nx; out[o++] = cy + ny; out[o++] = cz + nz;
  }
  return out.subarray(0, o);
}
