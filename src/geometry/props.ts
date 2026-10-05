import { DoubleSide, Ray } from 'three';
import { MeshData, Vec3, mergeMeshes } from './mesh';
import { planPerforation } from './perforate';
import { cylinderMesh } from './primitives';
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
    parts.push(cylinderMesh(start, d, params.diameter / 2, len + 2 * params.embed, params.segments ?? 16));
  }
  return { props, mesh: mergeMeshes(parts), direction: d, skipped };
}

/** Short line segments along face normals (xyz xyz), sampling at most maxCount faces. */
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
