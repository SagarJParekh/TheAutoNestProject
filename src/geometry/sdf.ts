import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { MeshData, Bounds, computeBounds, triangleCount, ProgressFn, noProgress } from './mesh';

/** A regular grid of samples: value at node (i,j,k) = data[i + nx*(j + ny*k)]. */
export interface Grid {
  nx: number;
  ny: number;
  nz: number;
  origin: [number, number, number];
  h: number;
  data: Float32Array;
}

export function makeBVH(mesh: MeshData): MeshBVH {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  g.setIndex(new BufferAttribute(mesh.indices.slice(), 1));
  return new MeshBVH(g);
}

export function gridFor(bounds: Bounds, h: number, pad: number) {
  const origin: [number, number, number] = [bounds.min[0] - pad * h, bounds.min[1] - pad * h, bounds.min[2] - pad * h];
  const nx = Math.ceil((bounds.max[0] - bounds.min[0]) / h) + 2 * pad + 1;
  const ny = Math.ceil((bounds.max[1] - bounds.min[1]) / h) + 2 * pad + 1;
  const nz = Math.ceil((bounds.max[2] - bounds.min[2]) / h) + 2 * pad + 1;
  return { origin, nx, ny, nz };
}

/**
 * Inside/outside classification of grid nodes by ray parity along +Z.
 * Requires a closed mesh. Returns 1 for inside nodes.
 */
export function voxelizeInside(
  mesh: MeshData,
  origin: [number, number, number],
  nx: number,
  ny: number,
  nz: number,
  h: number,
): Uint8Array {
  const p = mesh.positions, idx = mesh.indices;
  const nt = triangleCount(mesh);
  const cols = nx * ny;
  // tiny irrational offsets avoid rays hitting edges/vertices exactly
  const jx = h * 1.2345e-4, jy = h * 2.7182e-4;
  const counts = new Uint32Array(cols + 1);
  const forEachHit = (cb: (col: number, z: number) => void) => {
    for (let t = 0; t < nt; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const ax = p[a], ay = p[a + 1], bx = p[b], by = p[b + 1], cx = p[c], cy = p[c + 1];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (area === 0) continue;
      const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - origin[0] - jx) / h));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - origin[0] - jx) / h));
      const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - origin[1] - jy) / h));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - origin[1] - jy) / h));
      const inv = 1 / area;
      for (let j = j0; j <= j1; j++) {
        const y = origin[1] + j * h + jy;
        for (let i = i0; i <= i1; i++) {
          const x = origin[0] + i * h + jx;
          const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) * inv;
          const w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) * inv;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          cb(i + j * nx, w0 * p[a + 2] + w1 * p[b + 2] + w2 * p[c + 2]);
        }
      }
    }
  };
  forEachHit((col) => counts[col + 1]++);
  for (let i = 0; i < cols; i++) counts[i + 1] += counts[i];
  const zs = new Float32Array(counts[cols]);
  const fill = counts.slice(0, cols);
  forEachHit((col, z) => {
    zs[fill[col]++] = z;
  });
  const inside = new Uint8Array(cols * nz);
  for (let col = 0; col < cols; col++) {
    const s = counts[col], e = counts[col + 1];
    if (e - s < 2) continue;
    const list = zs.subarray(s, e).sort();
    let ptr = 0;
    for (let k = 0; k < nz; k++) {
      const z = origin[2] + k * h;
      while (ptr < list.length && list[ptr] < z) ptr++;
      if (ptr & 1) inside[col + k * cols] = 1;
    }
  }
  return inside;
}

/** 1D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    if (f[q] === Infinity) continue;
    if (f[v[k]] === Infinity) {
      v[k] = q;
      continue;
    }
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      if (k < 0) break;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (f[v[0]] === Infinity) {
    for (let q = 0; q < n; q++) d[q] = Infinity;
    return;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Squared Euclidean distance (in voxels) from every node to the nearest node
 * where `seed` is 1.
 */
export function squaredEDT(seed: Uint8Array, nx: number, ny: number, nz: number): Float32Array {
  const out = new Float32Array(nx * ny * nz);
  for (let i = 0; i < out.length; i++) out[i] = seed[i] ? 0 : Infinity;
  const m = Math.max(nx, ny, nz);
  const f = new Float32Array(m), d = new Float32Array(m), z = new Float32Array(m + 1);
  const v = new Int32Array(m);
  const pass = (n: number, stride: number, starts: number[]) => {
    for (const s of starts) {
      for (let i = 0; i < n; i++) f[i] = out[s + i * stride];
      edt1d(f, n, d, v, z);
      for (let i = 0; i < n; i++) out[s + i * stride] = d[i];
    }
  };
  const sx: number[] = [], sy: number[] = [], sz: number[] = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) sx.push(j * nx + k * nx * ny);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) sy.push(i + k * nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sz.push(i + j * nx);
  pass(nx, 1, sx);
  pass(ny, nx, sy);
  pass(nz, nx * ny, sz);
  return out;
}

/**
 * Signed distance field sampled on a grid: positive inside the mesh, negative
 * outside. Exact (BVH) distances are computed for nodes whose estimated
 * |distance - bandCenter| < bandWidth; elsewhere an EDT estimate is used.
 */
export function signedDistanceGrid(
  mesh: MeshData,
  h: number,
  opts: { pad?: number; bandCenter?: number; bandWidth?: number; onProgress?: ProgressFn } = {},
): Grid {
  const onProgress = opts.onProgress ?? noProgress;
  const pad = opts.pad ?? 2;
  const bounds = computeBounds(mesh.positions);
  const { origin, nx, ny, nz } = gridFor(bounds, h, pad);
  onProgress(0.05, 'Voxelizing');
  const inside = voxelizeInside(mesh, origin, nx, ny, nz, h);
  const N = nx * ny * nz;
  onProgress(0.25, 'Distance transform');
  const outsideSeed = new Uint8Array(N);
  for (let i = 0; i < N; i++) outsideSeed[i] = inside[i] ? 0 : 1;
  const dIn = squaredEDT(outsideSeed, nx, ny, nz);
  const data = new Float32Array(N);
  for (let i = 0; i < N; i++) data[i] = inside[i] ? Math.max(0, Math.sqrt(dIn[i]) - 0.5) * h : -h;
  const bandCenter = opts.bandCenter ?? 0;
  const bandWidth = opts.bandWidth ?? 2 * h;
  onProgress(0.45, 'Exact distances');
  const bvh = makeBVH(mesh);
  const pt = new Vector3();
  const target = { point: new Vector3(), distance: 0, faceIndex: 0 };
  let done = 0;
  const total = N;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const n = i + nx * (j + ny * k);
        if (!inside[n]) continue;
        if (Math.abs(data[n] - bandCenter) > bandWidth) continue;
        pt.set(origin[0] + i * h, origin[1] + j * h, origin[2] + k * h);
        const r = bvh.closestPointToPoint(pt, target as never);
        if (r) data[n] = r.distance;
      }
    }
    done += nx * ny;
    if ((k & 7) === 0) onProgress(0.45 + 0.4 * (done / total), 'Exact distances');
  }
  return { nx, ny, nz, origin, h, data };
}
