import { MeshData, Vec3, computeBounds, flipMesh, mergeMeshes, ProgressFn, noProgress } from './mesh';
import { Vector3 } from 'three';
import { makeBVH, signedDistanceGrid } from './sdf';
import { marchingTetrahedra } from './marching';
import { dualContour } from './dualcontour';
import { meshVolume } from './measure';
import { holeCutter } from './perforate';
import { planeBasis } from './triangulate';

export interface HollowOptions {
  /** wall thickness in mm */
  thickness: number;
  /** voxel budget for the distance field (default 6 million) */
  maxVoxels?: number;
  /** explicit voxel size in mm (overrides the automatic choice) */
  voxelSize?: number;
  /** voxels across the wall the automatic choice aims for (default 3) */
  perWall?: number;
}

export interface HollowResult {
  /** outer surface + inward-facing inner shell */
  mesh: MeshData;
  inner: MeshData;
  voxelSize: number;
  /** how the inner wall was made: dual contouring (sharp edges) or the marching-tetrahedra fallback */
  method: 'dual' | 'tetra';
}

export function chooseVoxelSize(mesh: MeshData, thickness: number, maxVoxels = 6e6, perWall = 3): number {
  const b = computeBounds(mesh.positions);
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  const ideal = thickness / perWall;
  // keep the padded grid within budget
  let h = ideal;
  for (let i = 0; i < 60; i++) {
    const n = (sx / h + 6) * (sy / h + 6) * (sz / h + 6);
    if (n <= maxVoxels) break;
    h *= 1.1;
  }
  return h;
}

/**
 * Hollow a closed mesh: builds a signed distance field on a voxel grid, then
 * extracts the iso-surface at depth `thickness` as the inner wall. The inner
 * shell is a true offset (no self-intersections, unlike vertex-normal offset).
 */
export function hollowMesh(mesh: MeshData, opts: HollowOptions, onProgress: ProgressFn = noProgress): HollowResult {
  const t = opts.thickness;
  if (!(t > 0)) throw new Error('Wall thickness must be positive');
  const h = opts.voxelSize ?? chooseVoxelSize(mesh, t, opts.maxVoxels, opts.perWall);
  const grid = signedDistanceGrid(mesh, h, {
    pad: 2,
    bandCenter: t,
    bandWidth: 2.5 * h,
    onProgress: (f, m) => onProgress(f * 0.85, m),
  });
  const d = grid.data;
  // the tiny extra offset keeps grid nodes off the iso-surface (avoids degenerate triangles)
  const iso = t + h * 1.234e-3;
  for (let i = 0; i < d.length; i++) d[i] = d[i] - iso;
  // dual contouring with the exact offset planes: flat walls flat, edges and corners sharp
  const bvh = makeBVH(mesh);
  const q = new Vector3();
  const target = { point: new Vector3(), distance: 0, faceIndex: 0 };
  // the offset plane of the closest surface point: normal from it towards the crossing, `t` in from it
  const planeAt = (x: number, y: number, z: number): [number, number, number, number] | null => {
    q.set(x, y, z);
    const r = bvh.closestPointToPoint(q, target as never);
    if (!r || r.distance < 1e-9) return null;
    const c = r.point, nx = (x - c.x) / r.distance, ny = (y - c.y) / r.distance, nz = (z - c.z) / r.distance;
    return [nx, ny, nz, nx * c.x + ny * c.y + nz * c.z + t];
  };
  let inner = dualContour(grid, planeAt, (f, m) => onProgress(0.85 + f * 0.13, m));
  if (inner.indices.length === 0) {
    throw new Error(`Wall thickness ${t} mm leaves no interior cavity; use a smaller value.`);
  }
  let method: HollowResult['method'] = 'dual';
  if (!closedManifold(inner)) {
    method = 'tetra';
    // thin or tangled places can give the dual surface stray edges: fall back on marching tetrahedra
    onProgress(0.9, 'Placing the inner wall');
    inner = snapToOffset(marchingTetrahedra(grid), mesh, t);
  }
  // inner wall must face into the cavity (negative signed volume)
  if (meshVolume(inner) > 0) inner = flipMesh(inner);
  onProgress(1);
  return { mesh: mergeMeshes([mesh, inner]), inner, voxelSize: h, method };
}

/**
 * Move the vertices of an offset surface onto the exact offset: `distance`
 * from the original surface. The voxel grid only places the inner wall to
 * within a voxel and bevels its sharp edges. Here each vertex takes the offset
 * plane of its closest surface point; where its neighbours' planes disagree
 * (along an edge or corner of the offset) it goes to the point that fits them
 * all, which puts it on the sharp edge. Any of those moves that would turn a
 * triangle over is undone, leaving a small straight bevel there instead.
 */
export function snapToOffset(offset: MeshData, surface: MeshData, distance: number): MeshData {
  const bvh = makeBVH(surface);
  const src = offset.positions;
  const nv = src.length / 3, idx = offset.indices, nt = idx.length / 3;
  // vertex neighbours (compressed rows)
  const deg = new Int32Array(nv + 1);
  for (let t = 0; t < idx.length; t++) deg[idx[t] + 1] += 2;
  for (let i = 0; i < nv; i++) deg[i + 1] += deg[i];
  const fill = deg.slice(0, nv);
  const nb = new Int32Array(deg[nv]);
  for (let t = 0; t < idx.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e];
      nb[fill[a]++] = idx[t + ((e + 1) % 3)];
      nb[fill[a]++] = idx[t + ((e + 2) % 3)];
    }
  // 1. each vertex's offset plane: normal from its closest surface point towards it, `distance` in from that point
  const pn = new Float64Array(nv * 3), pd = new Float64Array(nv), ok = new Uint8Array(nv);
  const v = new Vector3();
  const target = { point: new Vector3(), distance: 0, faceIndex: 0 };
  for (let i = 0; i < nv; i++) {
    v.set(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
    const r = bvh.closestPointToPoint(v, target as never);
    // a vertex far off its distance is near a feature the offset cannot follow: left alone
    if (!r || r.distance < 1e-9 || Math.abs(r.distance - distance) > 0.75 * distance) continue;
    const c = r.point;
    pn[i * 3] = (v.x - c.x) / r.distance;
    pn[i * 3 + 1] = (v.y - c.y) / r.distance;
    pn[i * 3 + 2] = (v.z - c.z) / r.distance;
    pd[i] = pn[i * 3] * c.x + pn[i * 3 + 1] * c.y + pn[i * 3 + 2] * c.z + distance;
    ok[i] = 1;
  }
  // 2. flat places: onto the vertex's own plane; along edges: the point fitting its and its neighbours' planes
  const bevel = src.slice(); // fallback: crease vertices stay where the grid put them
  const sharp = src.slice();
  const crease = new Uint8Array(nv);
  let edgeLen = 0;
  const ne = Math.min(nt, 2000);
  for (let t = 0; t < ne; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3;
    edgeLen += Math.hypot(src[a] - src[b], src[a + 1] - src[b + 1], src[a + 2] - src[b + 2]);
  }
  const reach = 1.5 * (edgeLen / Math.max(1, ne));
  for (let i = 0; i < nv; i++) {
    if (!ok[i]) continue;
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
    const n0 = pn[i * 3], n1 = pn[i * 3 + 1], n2 = pn[i * 3 + 2];
    let creased = false;
    for (let k = deg[i]; k < deg[i + 1]; k++) {
      const j = nb[k];
      if (ok[j] && pn[j * 3] * n0 + pn[j * 3 + 1] * n1 + pn[j * 3 + 2] * n2 < 0.95) creased = true;
    }
    const e0 = n0 * x + n1 * y + n2 * z - pd[i];
    const qx = x - n0 * e0, qy = y - n1 * e0, qz = z - n2 * e0;
    if (!creased) {
      bevel[i * 3] = sharp[i * 3] = qx;
      bevel[i * 3 + 1] = sharp[i * 3 + 1] = qy;
      bevel[i * 3 + 2] = sharp[i * 3 + 2] = qz;
      continue;
    }
    // least squares over the planes, held lightly to the grid position
    const lam = 0.05;
    let a00 = lam, a01 = 0, a02 = 0, a11 = lam, a12 = 0, a22 = lam, b0 = lam * x, b1 = lam * y, b2 = lam * z;
    const add = (j: number, w: number) => {
      const m0 = pn[j * 3], m1 = pn[j * 3 + 1], m2 = pn[j * 3 + 2], d = pd[j];
      a00 += w * m0 * m0; a01 += w * m0 * m1; a02 += w * m0 * m2;
      a11 += w * m1 * m1; a12 += w * m1 * m2; a22 += w * m2 * m2;
      b0 += w * m0 * d; b1 += w * m1 * d; b2 += w * m2 * d;
    };
    add(i, 1);
    for (let k = deg[i]; k < deg[i + 1]; k++) if (ok[nb[k]]) add(nb[k], 0.5);
    const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    if (Math.abs(det) < 1e-12) continue;
    const c11 = a00 * a22 - a02 * a02, c12 = a01 * a02 - a00 * a12, c22 = a00 * a11 - a01 * a01;
    const sx = (c00 * b0 + c01 * b1 + c02 * b2) / det, sy = (c01 * b0 + c11 * b1 + c12 * b2) / det, sz = (c02 * b0 + c12 * b1 + c22 * b2) / det;
    if (Math.hypot(sx - x, sy - y, sz - z) > reach) continue;
    sharp[i * 3] = sx;
    sharp[i * 3 + 1] = sy;
    sharp[i * 3 + 2] = sz;
    crease[i] = 1;
  }
  // 3. undo sharpening where triangles would turn over: compared with the grid's own triangles,
  // and between neighbouring triangles
  const unit = (q: Float32Array, t: number): [number, number, number] => {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = q[b] - q[a], uy = q[b + 1] - q[a + 1], uz = q[b + 2] - q[a + 2];
    const vx = q[c] - q[a], vy = q[c + 1] - q[a + 1], vz = q[c + 2] - q[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    return l > 1e-20 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
  };
  const orig = new Float32Array(idx.length);
  for (let t = 0; t < idx.length; t += 3) orig.set(unit(src, t), t);
  const opposite = new Int32Array(idx.length).fill(-1);
  {
    const half = new Map<number, number>();
    for (let t = 0; t < idx.length; t += 3)
      for (let e = 0; e < 3; e++) half.set(idx[t + e] * 4294967296 + idx[t + ((e + 1) % 3)], t);
    for (let t = 0; t < idx.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const o = half.get(idx[t + ((e + 1) % 3)] * 4294967296 + idx[t + e]);
        if (o !== undefined) opposite[t + e] = o;
      }
  }
  const out = sharp;
  const target3 = sharp.slice();
  const tryCrease = crease.slice();
  // first all the way onto the edges; where that folds a triangle, a second try half way
  for (const f of [1, 0.5]) {
    if (f < 1)
      for (let i = 0; i < nv; i++) {
        if (!tryCrease[i] || crease[i]) continue;
        crease[i] = 1;
        for (let k = 0; k < 3; k++) out[i * 3 + k] = bevel[i * 3 + k] + (target3[i * 3 + k] - bevel[i * 3 + k]) * f;
      }
    for (let round = 0; round < 12; round++) {
      let undone = 0;
      const cur = new Float32Array(idx.length);
      for (let t = 0; t < idx.length; t += 3) cur.set(unit(out, t), t);
      const revert = (t: number) => {
        for (let e = 0; e < 3; e++) {
          const j = idx[t + e];
          if (!crease[j]) continue;
          crease[j] = 0;
          out[j * 3] = bevel[j * 3];
          out[j * 3 + 1] = bevel[j * 3 + 1];
          out[j * 3 + 2] = bevel[j * 3 + 2];
          undone++;
        }
      };
      for (let t = 0; t < idx.length; t += 3) {
        const n = [cur[t], cur[t + 1], cur[t + 2]];
        // turned more than 100° from the grid's triangle, or folded back against a neighbour
        let bad = n[0] * orig[t] + n[1] * orig[t + 1] + n[2] * orig[t + 2] < -0.17;
        for (let e = 0; e < 3 && !bad; e++) {
          const o = opposite[t + e];
          if (o >= 0 && n[0] * cur[o] + n[1] * cur[o + 1] + n[2] * cur[o + 2] < -0.5) {
            bad = true;
            revert(o);
          }
        }
        if (bad) revert(t);
      }
      if (!undone) break;
    }
  }
  return { positions: out, indices: idx };
}

/** Every edge shared by exactly two triangles, once each way round. */
function closedManifold(m: MeshData): boolean {
  const idx = m.indices;
  const seen = new Map<number, number>();
  for (let t = 0; t < idx.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e], b = idx[t + ((e + 1) % 3)];
      if (a === b) return false;
      const k = a * 4294967296 + b;
      if (seen.has(k)) return false;
      seen.set(k, 1);
    }
  for (const k of seen.keys()) {
    const a = Math.floor(k / 4294967296), b = k - a * 4294967296;
    if (!seen.has(b * 4294967296 + a)) return false;
  }
  return true;
}

export interface DrainHole {
  /** point on the outer surface */
  point: Vec3;
  /** outward surface normal at that point */
  normal: Vec3;
}

/** Cylinders that cut from just outside the surface through the wall into the cavity. */
export function drainHoleCutters(holes: DrainHole[], diameter: number, thickness: number, voxelSize = 0, exitDiameter = diameter): MeshData[] {
  // the hole tapers from `diameter` at the surface to `exitDiameter` where it reaches the cavity
  const ratio = diameter > 0 ? Math.max(0.05, exitDiameter / diameter) : 1;
  const beyond = 2 * voxelSize + Math.max(1, Math.max(diameter, exitDiameter) * 0.5);
  return holes.map((hole) => {
    const l = Math.hypot(hole.normal[0], hole.normal[1], hole.normal[2]) || 1;
    const n: Vec3 = [hole.normal[0] / l, hole.normal[1] / l, hole.normal[2] / l];
    const { u, v } = planeBasis(n);
    return holeCutter(hole.point, n, u, v, diameter / 2, ratio, 32, 0, thickness, beyond);
  });
}
