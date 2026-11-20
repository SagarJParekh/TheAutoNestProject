/**
 * Lattice lightweighting: keep a solid skin of the part and fill the inside
 * with a lattice (gyroid, diamond or Schwarz-P walls, or cubic struts).
 *
 * The part's own outer surface is kept exactly: the empty space between the
 * lattice walls (inside the skin) is built as a closed mesh from a distance
 * field and subtracted with an exact boolean.
 */
import { MeshData, computeBounds, flipMesh, ProgressFn, noProgress, subsetTriangles } from './mesh';
import { findShells } from './topology';
import { signedDistanceGrid, Grid } from './sdf';
import { marchingTetrahedra } from './marching';
import { meshArea, meshVolume } from './measure';
import { subtractMeshes } from './manifold';

export type LatticeType = 'gyroid' | 'diamond' | 'schwarzP' | 'cubic' | 'honeycomb';

export const LATTICES: { value: LatticeType; label: string }[] = [
  { value: 'gyroid', label: 'Gyroid' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'schwarzP', label: 'Schwarz P' },
  { value: 'cubic', label: 'Cubic struts' },
  { value: 'honeycomb', label: 'Honeycomb' },
];

export interface LatticeParams {
  type: LatticeType;
  /** size of one lattice cell, mm */
  cell: number;
  /** wall (or strut) thickness, mm */
  thickness: number;
  /** solid skin kept under the outer surface, mm (0 = lattice right out to the surface) */
  skin: number;
  quality: 'draft' | 'normal' | 'fine';
  /** honeycomb: direction the hexagonal cells run along */
  axis: 'x' | 'y' | 'z';
  /**
   * projected: one straight lattice across the whole part (cut off wherever the surface happens to be);
   * contour: the cells are laid out in layers measured from the skin inward, so they follow the outer shape
   */
  layout?: LatticeLayout;
}

export type LatticeLayout = 'projected' | 'contour';

export const DEFAULT_LATTICE: LatticeParams = { type: 'gyroid', cell: 10, thickness: 1.2, skin: 1.5, quality: 'normal', axis: 'z', layout: 'projected' };

const BUDGET = { draft: 2e6, normal: 6e6, fine: 16e6 };
/**
 * Triangles the lattice surface may have: the boolean that cuts it out of the
 * part runs out of memory (WebAssembly is limited to 4 GB) on much more.
 */
const TRIANGLES = { draft: 2.5e6, normal: 5e6, fine: 8e6 };

/** Lattice wall area per mm³ of filled volume, roughly (both faces of the walls). */
function areaDensity(p: Pick<LatticeParams, 'type' | 'cell' | 'thickness'>): number {
  const L = p.cell;
  switch (p.type) {
    case 'gyroid':
      return (2 * 3.1) / L;
    case 'diamond':
      return (2 * 3.84) / L;
    case 'schwarzP':
      return (2 * 2.35) / L;
    case 'cubic':
      return (3 * Math.PI * p.thickness) / (L * L);
    case 'honeycomb':
      return 4 / L;
  }
}

/**
 * Voxel size: fine enough for the walls, within the voxel budget of the quality
 * setting and coarse enough that the surface stays within its triangle budget.
 */
export function latticeVoxel(mesh: MeshData, p: LatticeParams): number {
  const b = computeBounds(mesh.positions);
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  let h = Math.min(p.thickness / 2.5, p.cell / 10, p.skin > 0 ? p.skin / 2 : Infinity);
  for (let i = 0; i < 80 && (sx / h + 6) * (sy / h + 6) * (sz / h + 6) > BUDGET[p.quality]; i++) h *= 1.08;
  // marching tetrahedra makes about 7 triangles per voxel face of surface (measured on gyroids)
  const area = areaDensity(p) * Math.abs(meshVolume(mesh)) + meshArea(mesh);
  return Math.max(h, Math.sqrt((7 * area) / TRIANGLES[p.quality]));
}

/**
 * Lattice field at a point: positive inside the lattice material, roughly the
 * distance to its surface in mm. TPMS walls use the level |f| < c, scaled by the
 * typical gradient so the wall comes out about `thickness` thick.
 */
export function latticeField(type: LatticeType, cell: number, thickness: number, axis: 'x' | 'y' | 'z' = 'z'): (x: number, y: number, z: number) => number {
  const k = (2 * Math.PI) / cell, half = thickness / 2;
  const { sin, cos, abs, hypot, round } = Math;
  switch (type) {
    case 'gyroid':
      return (x, y, z) => {
        const a = k * x, b = k * y, c = k * z;
        return half - abs(sin(a) * cos(b) + sin(b) * cos(c) + sin(c) * cos(a)) / (k * 1.25);
      };
    case 'diamond':
      return (x, y, z) => {
        const a = k * x, b = k * y, c = k * z;
        const sa = sin(a), ca = cos(a), sb = sin(b), cb = cos(b), sc = sin(c), cc = cos(c);
        return half - abs(sa * sb * sc + sa * cb * cc + ca * sb * cc + ca * cb * sc) / (k * 1.2);
      };
    case 'schwarzP':
      return (x, y, z) => half - abs(cos(k * x) + cos(k * y) + cos(k * z)) / (k * 1.4);
    case 'cubic': {
      const m = (v: number) => abs(v - cell * round(v / cell));
      return (x, y, z) => {
        const dx = m(x), dy = m(y), dz = m(z);
        return half - Math.min(hypot(dx, dy), hypot(dy, dz), hypot(dz, dx));
      };
    }
    case 'honeycomb': {
      // hexagonal cells `cell` across the flats, walls on the cell borders, running along `axis`;
      // centres on the lattice a1 = (cell, 0), a2 = (cell/2, cell·√3/2): a point lies in the cell
      // of the nearest centre in the hexagon norm, and its distance to the wall is cell/2 minus that norm
      const r3 = Math.sqrt(3), apo = cell / 2;
      const norm = (u: number, v: number) => Math.max(abs(u), abs(0.5 * u + (r3 / 2) * v), abs(0.5 * u - (r3 / 2) * v));
      const wall = (u: number, v: number) => {
        const j0 = Math.floor((2 * v) / (r3 * cell));
        const i0 = Math.floor(u / cell - j0 / 2);
        let best = Infinity;
        for (let dj = -1; dj <= 2; dj++)
          for (let di = -1; di <= 2; di++) {
            const j = j0 + dj, i = i0 + di;
            const n = norm(u - cell * (i + j / 2), v - (cell * r3 * j) / 2);
            if (n < best) best = n;
          }
        return half - (apo - best);
      };
      return axis === 'x' ? (_x, y, z) => wall(y, z) : axis === 'y' ? (x, _y, z) => wall(z, x) : (x, y) => wall(x, y);
    }
  }
}

/**
 * Contour layout: the lattice is laid out from the surface inward instead of on
 * one straight grid. Each point takes its depth below the skin as the lattice
 * coordinate along the axis closest to the surface normal (the other two stay as
 * they are), so every face of the part meets the lattice at the same place in
 * the cell, and the layers of cells bend round with the outer shape. Where the
 * normal turns from one axis to another the two layouts are blended smoothly.
 * The pattern is anchored to the middle of the part, so moving the part does
 * not change it.
 */
function contourField(grid: Grid, mesh: MeshData, p: LatticeParams, skin: number) {
  const { nx, ny, nz, origin, h } = grid;
  const D = grid.data.slice();
  const L = latticeField(p.type, p.cell, p.thickness, p.axis ?? 'z');
  const b = computeBounds(mesh.positions);
  const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
  const cl = (v: number, n: number) => (v < 0 ? 0 : v > n - 1 ? n - 1 : v);
  // depth (trilinear, so the layers come out smooth, not in voxel steps)
  const S = (x: number, y: number, z: number) => {
    const fx = cl((x - origin[0]) / h, nx), fy = cl((y - origin[1]) / h, ny), fz = cl((z - origin[2]) / h, nz);
    const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy)), k = Math.min(nz - 2, Math.floor(fz));
    const u = fx - i, v = fy - j, w = fz - k;
    const n = i + nx * (j + ny * k), sy = nx, sz = nx * ny;
    const l = (a: number, b2: number, t: number) => a + (b2 - a) * t;
    return l(
      l(l(D[n], D[n + 1], u), l(D[n + sy], D[n + sy + 1], u), v),
      l(l(D[n + sz], D[n + sz + 1], u), l(D[n + sz + sy], D[n + sz + sy + 1], u), v),
      w,
    );
  };
  const e = 1.5 * h;
  const q = [0, 0, 0];
  return (x: number, y: number, z: number) => {
    const d = S(x, y, z);
    const t = d - skin;
    const gx = Math.abs(S(x + e, y, z) - S(x - e, y, z));
    const gy = Math.abs(S(x, y + e, z) - S(x, y - e, z));
    const gz = Math.abs(S(x, y, z + e) - S(x, y, z - e));
    const X = x - c[0], Y = y - c[1], Z = z - c[2];
    let wx = gx ** 4, wy = gy ** 4, wz = gz ** 4;
    const sum = wx + wy + wz;
    if (sum > 1e-12) (wx /= sum), (wy /= sum), (wz /= sum);
    else wx = wy = wz = 1 / 3;
    let f = 0, wsum = 0;
    const w = [wx, wy, wz];
    for (let a2 = 0; a2 < 3; a2++) {
      if (w[a2] < 0.02) continue;
      q[0] = X; q[1] = Y; q[2] = Z;
      q[a2] = t;
      f += w[a2] * L(q[0], q[1], q[2]);
      wsum += w[a2];
    }
    return f / wsum;
  };
}

export interface LatticeResult {
  mesh: MeshData;
  voxelSize: number;
  /** volume before and after, mm³ */
  before: number;
  after: number;
  /** the voxels had to be coarser than the walls need (the walls come out lumpy or may break up) */
  coarse: boolean;
}

/** Closed mesh of the empty space between the lattice walls, inside the skin. */
export function latticeVoids(mesh: MeshData, p: LatticeParams, onProgress: ProgressFn = noProgress): { voids: MeshData; voxelSize: number } {
  if (!(p.cell > 0) || !(p.thickness > 0)) throw new Error('Cell size and wall thickness must be positive');
  if (p.thickness >= p.cell * 0.8) throw new Error('The walls are too thick for the cell size: nothing would be removed');
  const h = latticeVoxel(mesh, p);
  const skin = Math.max(0, p.skin);
  const grid = signedDistanceGrid(mesh, h, { pad: 2, bandCenter: skin, bandWidth: 2.5 * h, onProgress: (f, m) => onProgress(f * 0.6, m) });
  const { nx, ny, nz, origin, data } = grid;
  const L = p.layout === 'contour' ? contourField(grid, mesh, p, skin) : latticeField(p.type, p.cell, p.thickness, p.axis ?? 'z');
  onProgress(0.62, 'Building the lattice');
  // void = inside the skin and outside the lattice walls; with no skin the voids run out past the surface
  // (the boolean trims them) and are closed at the edge of the grid
  const tiny = h * 1.234e-3;
  for (let k = 0; k < nz; k++) {
    const z = origin[2] + k * h;
    for (let j = 0; j < ny; j++) {
      const y = origin[1] + j * h;
      for (let i = 0; i < nx; i++) {
        const n = i + nx * (j + ny * k);
        const border = i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1;
        const inside = skin > 0 ? data[n] - skin : data[n] + 2 * h;
        data[n] = border ? -h : Math.min(inside, -L(origin[0] + i * h, y, z)) - tiny;
      }
    }
  }
  let voids = marchingTetrahedra(grid, (f, m) => onProgress(0.65 + f * 0.15, m));
  if (!voids.indices.length) throw new Error('No room for a lattice: use a thinner skin, thinner walls or a larger part');
  if (meshVolume(voids) < 0) voids = flipMesh(voids);
  return { voids, voxelSize: h };
}

/**
 * Small loose pieces of lattice left floating inside the part (where the walls
 * of two layers of cells only just miss each other) cannot be printed and would
 * rattle around inside: drop every closed body (positive volume) under 0.5 % of
 * the largest one that sits inside that body's bounds. Cavities are kept.
 */
export function dropLooseBits(mesh: MeshData): MeshData {
  const { shellOfTri, shellCount } = findShells(mesh);
  if (shellCount < 2) return mesh;
  const p = mesh.positions, idx = mesh.indices;
  const vol = new Float64Array(shellCount);
  const lo = new Float64Array(shellCount * 3).fill(Infinity), hi = new Float64Array(shellCount * 3).fill(-Infinity);
  for (let t = 0; t < idx.length / 3; t++) {
    const s = shellOfTri[t];
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    vol[s] += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    for (const v of [a, b, c])
      for (let k = 0; k < 3; k++) {
        lo[s * 3 + k] = Math.min(lo[s * 3 + k], p[v + k]);
        hi[s * 3 + k] = Math.max(hi[s * 3 + k], p[v + k]);
      }
  }
  let big = 0;
  for (let s = 1; s < shellCount; s++) if (vol[s] > vol[big]) big = s;
  const drop = new Uint8Array(shellCount);
  let any = false;
  for (let s = 0; s < shellCount; s++) {
    if (s === big || !(vol[s] > 0) || vol[s] >= 0.005 * vol[big]) continue;
    let inside = true;
    for (let k = 0; k < 3; k++) if (lo[s * 3 + k] < lo[big * 3 + k] || hi[s * 3 + k] > hi[big * 3 + k]) inside = false;
    if (inside) (drop[s] = 1), (any = true);
  }
  return any ? subsetTriangles(mesh, (t) => !drop[shellOfTri[t]]) : mesh;
}

export async function latticeMesh(input: MeshData, p: LatticeParams, onProgress: ProgressFn = noProgress): Promise<LatticeResult> {
  // an inside-out part (all triangles facing in) is turned right way out first
  const mesh = meshVolume(input) < 0 ? flipMesh(input) : input;
  const { voids, voxelSize } = latticeVoids(mesh, p, onProgress);
  onProgress(0.82, 'Cutting the lattice out of the part');
  const out = dropLooseBits(await subtractMeshes(mesh, [voids]));
  onProgress(1);
  return { mesh: out, voxelSize, before: Math.abs(meshVolume(mesh)), after: Math.abs(meshVolume(out)), coarse: voxelSize > p.thickness / 1.5 };
}
