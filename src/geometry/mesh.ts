/**
 * Core mesh representation used by every geometry operation.
 *
 * A mesh is an indexed triangle list stored in flat typed arrays so it can be
 * transferred to/from Web Workers cheaply. Units are millimetres, Z is up.
 * Triangles are counter-clockwise when viewed from outside (right-hand rule
 * gives the outward normal).
 */
export interface MeshData {
  /** xyz triples */
  positions: Float32Array;
  /** vertex index triples */
  indices: Uint32Array;
}

export type Vec3 = [number, number, number];

/** Column-major 4x4 matrix (same layout as THREE.Matrix4.elements). */
export type Mat4 = ArrayLike<number>;

export interface Plane {
  /** unit normal */
  normal: Vec3;
  /** signed offset: points p on the plane satisfy dot(normal, p) = constant */
  constant: number;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export function createMesh(positions: ArrayLike<number>, indices?: ArrayLike<number>): MeshData {
  const pos = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  let idx: Uint32Array;
  if (indices) {
    idx = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
  } else {
    idx = new Uint32Array(pos.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
  }
  return { positions: pos, indices: idx };
}

export function triangleCount(mesh: MeshData): number {
  return mesh.indices.length / 3;
}

export function vertexCount(mesh: MeshData): number {
  return mesh.positions.length / 3;
}

export function cloneMesh(mesh: MeshData): MeshData {
  return { positions: mesh.positions.slice(), indices: mesh.indices.slice() };
}

export function emptyMesh(): MeshData {
  return { positions: new Float32Array(0), indices: new Uint32Array(0) };
}

/** Concatenate meshes into one (vertices are not welded). */
export function mergeMeshes(meshes: MeshData[]): MeshData {
  let nv = 0;
  let ni = 0;
  for (const m of meshes) {
    nv += m.positions.length;
    ni += m.indices.length;
  }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

/** Keep only the listed triangles. */
export function subsetTriangles(mesh: MeshData, keep: (tri: number) => boolean): MeshData {
  const t = triangleCount(mesh);
  const idx = mesh.indices;
  const tmp = new Uint32Array(idx.length);
  let n = 0;
  for (let i = 0; i < t; i++) {
    if (!keep(i)) continue;
    tmp[n++] = idx[i * 3];
    tmp[n++] = idx[i * 3 + 1];
    tmp[n++] = idx[i * 3 + 2];
  }
  return compactMesh({ positions: mesh.positions, indices: tmp.slice(0, n) });
}

/** Remove vertices not referenced by any triangle. */
export function compactMesh(mesh: MeshData): MeshData {
  const nv = vertexCount(mesh);
  const remap = new Int32Array(nv).fill(-1);
  let count = 0;
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    if (remap[v] === -1) remap[v] = count++;
  }
  if (count === nv) {
    // still renumber to keep first-use ordering? Not needed; return as-is.
    return { positions: mesh.positions, indices: mesh.indices };
  }
  const positions = new Float32Array(count * 3);
  const p = mesh.positions;
  for (let v = 0; v < nv; v++) {
    const r = remap[v];
    if (r < 0) continue;
    positions[r * 3] = p[v * 3];
    positions[r * 3 + 1] = p[v * 3 + 1];
    positions[r * 3 + 2] = p[v * 3 + 2];
  }
  const indices = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) indices[i] = remap[idx[i]];
  return { positions, indices };
}

/** Reverse the winding of every triangle. */
export function flipMesh(mesh: MeshData): MeshData {
  const idx = mesh.indices.slice();
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  return { positions: mesh.positions, indices: idx };
}

export function computeBounds(positions: Float32Array): Bounds {
  if (positions.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export function boundsDiagonal(b: Bounds): number {
  const dx = b.max[0] - b.min[0], dy = b.max[1] - b.min[1], dz = b.max[2] - b.min[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function triangleNormal(mesh: MeshData, tri: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const p = mesh.positions, idx = mesh.indices;
  const a = idx[tri * 3] * 3, b = idx[tri * 3 + 1] * 3, c = idx[tri * 3 + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (l > 0) {
    nx /= l; ny /= l; nz /= l;
  }
  out[0] = nx; out[1] = ny; out[2] = nz;
  return out;
}

/** Twice the triangle area vector (unnormalised normal). */
export function triangleCross(mesh: MeshData, tri: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const p = mesh.positions, idx = mesh.indices;
  const a = idx[tri * 3] * 3, b = idx[tri * 3 + 1] * 3, c = idx[tri * 3 + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  out[0] = uy * vz - uz * vy;
  out[1] = uz * vx - ux * vz;
  out[2] = ux * vy - uy * vx;
  return out;
}

/** Growable typed arrays used by the builders below. */
export class FloatBuffer {
  data: Float32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Float32Array(Math.max(16, capacity));
  }
  push3(x: number, y: number, z: number): number {
    if (this.length + 3 > this.data.length) this.grow(this.length + 3);
    const i = this.length;
    this.data[i] = x;
    this.data[i + 1] = y;
    this.data[i + 2] = z;
    this.length += 3;
    return i / 3;
  }
  private grow(min: number) {
    const n = new Float32Array(Math.max(min, this.data.length * 2));
    n.set(this.data.subarray(0, this.length));
    this.data = n;
  }
  toArray(): Float32Array {
    return this.data.slice(0, this.length);
  }
}

export class IndexBuffer {
  data: Uint32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Uint32Array(Math.max(16, capacity));
  }
  push3(a: number, b: number, c: number) {
    if (this.length + 3 > this.data.length) this.grow(this.length + 3);
    const i = this.length;
    this.data[i] = a;
    this.data[i + 1] = b;
    this.data[i + 2] = c;
    this.length += 3;
  }
  push(a: number) {
    if (this.length + 1 > this.data.length) this.grow(this.length + 1);
    this.data[this.length++] = a;
  }
  private grow(min: number) {
    const n = new Uint32Array(Math.max(min, this.data.length * 2));
    n.set(this.data.subarray(0, this.length));
    this.data = n;
  }
  toArray(): Uint32Array {
    return this.data.slice(0, this.length);
  }
}

/** Progress callback: fraction in [0,1], optional message. */
export type ProgressFn = (fraction: number, message?: string) => void;

export const noProgress: ProgressFn = () => {};
