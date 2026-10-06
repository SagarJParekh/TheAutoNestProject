/**
 * Offsets.
 *
 * - Global: the whole part grows (positive distance) or shrinks (negative)
 *   by a distance. Built from a signed distance field and marching
 *   tetrahedra, so the result never self-intersects; outward offsets round
 *   convex edges with the offset radius, as a true offset does.
 * - Local: a region of triangles moves along its vertex normals, with side
 *   walls stitched to the rest of the part (like extrude, but following
 *   curved surfaces).
 */
import { Vector3 } from 'three';
import { MeshData, FloatBuffer, IndexBuffer, compactMesh, computeBounds, flipMesh, triangleCount, ProgressFn, noProgress } from './mesh';
import { gridFor, makeBVH, squaredEDT, voxelizeInside } from './sdf';
import { marchingTetrahedra } from './marching';
import { meshVolume } from './measure';
import { simplifyMesh } from './simplify';
import { buildTopology, heFrom, heTo, Topology } from './topology';
import { regionBoundaryHalfEdges } from './select';

export interface OffsetOptions {
  /** voxel size in mm (default: chosen from the voxel budget) */
  voxelSize?: number;
  /** voxel budget (default 8 million) */
  maxVoxels?: number;
  /** reduce the triangle count of the voxel surface (default true) */
  simplify?: boolean;
}

export function chooseOffsetVoxel(mesh: MeshData, distance: number, maxVoxels = 8e6): number {
  const b = computeBounds(mesh.positions);
  const d = Math.abs(distance);
  const sx = b.max[0] - b.min[0] + 2 * d, sy = b.max[1] - b.min[1] + 2 * d, sz = b.max[2] - b.min[2] + 2 * d;
  // aim for a few voxels across the offset and at least ~200 across the part
  let h = Math.min(Math.max(d / 3, 1e-3), Math.max(sx, sy, sz) / 160);
  for (let i = 0; i < 80; i++) {
    if ((sx / h + 8) * (sy / h + 8) * (sz / h + 8) <= maxVoxels) break;
    h *= 1.1;
  }
  return h;
}

/** Grow (distance > 0) or shrink (distance < 0) a closed part. */
export function offsetMesh(mesh: MeshData, distance: number, opts: OffsetOptions = {}, onProgress: ProgressFn = noProgress): { mesh: MeshData; voxelSize: number } {
  if (!distance) return { mesh, voxelSize: 0 };
  const h = opts.voxelSize ?? chooseOffsetVoxel(mesh, distance, opts.maxVoxels);
  const pad = Math.ceil(Math.max(0, distance) / h) + 3;
  const bounds = computeBounds(mesh.positions);
  const { origin, nx, ny, nz } = gridFor(bounds, h, pad);
  onProgress(0.05, 'Voxelizing');
  const inside = voxelizeInside(mesh, origin, nx, ny, nz, h);
  const N = nx * ny * nz;
  onProgress(0.25, 'Distance transform');
  // estimated signed distance (positive inside) from distance transforms on both sides
  const seedOut = new Uint8Array(N), seedIn = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    seedOut[i] = inside[i] ? 0 : 1;
    seedIn[i] = inside[i] ? 1 : 0;
  }
  const dIn = squaredEDT(seedOut, nx, ny, nz);
  const dOut = squaredEDT(seedIn, nx, ny, nz);
  const data = new Float32Array(N);
  for (let i = 0; i < N; i++) data[i] = inside[i] ? Math.max(0, Math.sqrt(dIn[i]) - 0.5) * h : -Math.max(0, Math.sqrt(dOut[i]) - 0.5) * h;
  // exact distances in a band around the offset surface (sdf = -distance)
  onProgress(0.45, 'Exact distances');
  const bvh = makeBVH(mesh);
  const pt = new Vector3();
  const target = { point: new Vector3(), distance: 0, faceIndex: 0 };
  const iso = -distance;
  const band = 2.5 * h;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const n = i + nx * (j + ny * k);
        if (Math.abs(data[n] - iso) > band) continue;
        pt.set(origin[0] + i * h, origin[1] + j * h, origin[2] + k * h);
        const r = bvh.closestPointToPoint(pt, target);
        if (r) data[n] = inside[n] ? r.distance : -r.distance;
      }
    if ((k & 7) === 0) onProgress(0.45 + 0.4 * (k / nz), 'Exact distances');
  }
  // surface at sdf = iso; the small extra keeps nodes off the surface
  const shift = iso - h * 1.234e-3;
  for (let i = 0; i < N; i++) data[i] -= shift;
  let out = marchingTetrahedra({ nx, ny, nz, origin, h, data }, (f, m) => onProgress(0.85 + f * 0.05, m));
  if (!out.indices.length) throw new Error(`Offsetting by ${distance} mm leaves nothing; use a smaller inward offset`);
  if (meshVolume(out) < 0) out = flipMesh(out);
  // the voxel surface is very dense; flat and gently curved areas need far fewer triangles
  if (opts.simplify !== false) out = simplifyMesh(out, 0.01, (f) => onProgress(0.9 + f * 0.09, 'Reducing triangles'), { maxDeviation: h * 0.25 }).mesh;
  onProgress(1);
  return { mesh: out, voxelSize: h };
}

/**
 * Move a region of triangles along its vertex normals by `distance`, keeping
 * the faces parallel to where they were (offset of the region), and stitch
 * side walls along its border.
 */
export function offsetRegion(mesh: MeshData, regionTris: ArrayLike<number>, distance: number, topo: Topology = buildTopology(mesh)): MeshData {
  if (!regionTris.length || !distance) return mesh;
  const nt = triangleCount(mesh);
  const inRegion = new Uint8Array(nt);
  for (let i = 0; i < regionTris.length; i++) inRegion[regionTris[i]] = 1;
  const p = mesh.positions, idx = mesh.indices;
  const nv = p.length / 3;
  // area-weighted vertex normals of the region, and unit face normals
  const vn = new Float64Array(nv * 3);
  const fn = new Float64Array(regionTris.length * 3);
  for (let i = 0; i < regionTris.length; i++) {
    const t = regionTris[i];
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    fn[i * 3] = nx / l; fn[i * 3 + 1] = ny / l; fn[i * 3 + 2] = nz / l;
    for (const o of [a, b, c]) {
      vn[o] += nx; vn[o + 1] += ny; vn[o + 2] += nz;
    }
  }
  // scale so each face moves by `distance` (1 / cos of the largest deviation, capped)
  const minDot = new Float64Array(nv).fill(1);
  for (let v = 0; v < nv; v++) {
    const l = Math.hypot(vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2]);
    if (l) {
      vn[v * 3] /= l; vn[v * 3 + 1] /= l; vn[v * 3 + 2] /= l;
    }
  }
  for (let i = 0; i < regionTris.length; i++) {
    const t = regionTris[i];
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      const d = vn[v * 3] * fn[i * 3] + vn[v * 3 + 1] * fn[i * 3 + 1] + vn[v * 3 + 2] * fn[i * 3 + 2];
      if (d < minDot[v]) minDot[v] = d;
    }
  }
  const pos = new FloatBuffer(p.length + regionTris.length * 9);
  pos.data.set(p);
  pos.length = p.length;
  const moved = new Map<number, number>();
  const mv = (v: number): number => {
    let id = moved.get(v);
    if (id === undefined) {
      const s = distance / Math.max(0.5, minDot[v]);
      id = pos.push3(p[v * 3] + vn[v * 3] * s, p[v * 3 + 1] + vn[v * 3 + 1] * s, p[v * 3 + 2] + vn[v * 3 + 2] * s);
      moved.set(v, id);
    }
    return id;
  };
  const out = new IndexBuffer(idx.length + regionTris.length * 6);
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (inRegion[t]) out.push3(mv(a), mv(b), mv(c));
    else out.push3(a, b, c);
  }
  for (const h of regionBoundaryHalfEdges(mesh, regionTris, topo)) {
    const a = heFrom(mesh, h), b = heTo(mesh, h);
    const a2 = mv(a), b2 = mv(b);
    out.push3(a, b, b2);
    out.push3(a, b2, a2);
  }
  return compactMesh({ positions: pos.toArray(), indices: out.toArray() });
}
