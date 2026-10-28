/**
 * Lattice lightweighting: keep a solid skin of the part and fill the inside
 * with a lattice (gyroid, diamond or Schwarz-P walls, or cubic struts).
 *
 * The part's own outer surface is kept exactly: the empty space between the
 * lattice walls (inside the skin) is built as a closed mesh from a distance
 * field and subtracted with an exact boolean.
 */
import { MeshData, computeBounds, flipMesh, ProgressFn, noProgress } from './mesh';
import { signedDistanceGrid } from './sdf';
import { marchingTetrahedra } from './marching';
import { meshVolume } from './measure';
import { subtractMeshes } from './manifold';

export type LatticeType = 'gyroid' | 'diamond' | 'schwarzP' | 'cubic';

export const LATTICES: { value: LatticeType; label: string }[] = [
  { value: 'gyroid', label: 'Gyroid' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'schwarzP', label: 'Schwarz P' },
  { value: 'cubic', label: 'Cubic struts' },
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
}

export const DEFAULT_LATTICE: LatticeParams = { type: 'gyroid', cell: 10, thickness: 1.2, skin: 1.5, quality: 'normal' };

const BUDGET = { draft: 2e6, normal: 6e6, fine: 16e6 };

/** Voxel size: fine enough for the walls, within the voxel budget of the quality setting. */
export function latticeVoxel(mesh: MeshData, p: LatticeParams): number {
  const b = computeBounds(mesh.positions);
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  let h = Math.min(p.thickness / 2.5, p.cell / 10, p.skin > 0 ? p.skin / 2 : Infinity);
  for (let i = 0; i < 80 && (sx / h + 6) * (sy / h + 6) * (sz / h + 6) > BUDGET[p.quality]; i++) h *= 1.08;
  return h;
}

/**
 * Lattice field at a point: positive inside the lattice material, roughly the
 * distance to its surface in mm. TPMS walls use the level |f| < c, scaled by the
 * typical gradient so the wall comes out about `thickness` thick.
 */
export function latticeField(type: LatticeType, cell: number, thickness: number): (x: number, y: number, z: number) => number {
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
  }
}

export interface LatticeResult {
  mesh: MeshData;
  voxelSize: number;
  /** volume before and after, mm³ */
  before: number;
  after: number;
}

/** Closed mesh of the empty space between the lattice walls, inside the skin. */
export function latticeVoids(mesh: MeshData, p: LatticeParams, onProgress: ProgressFn = noProgress): { voids: MeshData; voxelSize: number } {
  if (!(p.cell > 0) || !(p.thickness > 0)) throw new Error('Cell size and wall thickness must be positive');
  if (p.thickness >= p.cell * 0.8) throw new Error('The walls are too thick for the cell size: nothing would be removed');
  const h = latticeVoxel(mesh, p);
  const skin = Math.max(0, p.skin);
  const grid = signedDistanceGrid(mesh, h, { pad: 2, bandCenter: skin, bandWidth: 2.5 * h, onProgress: (f, m) => onProgress(f * 0.6, m) });
  const { nx, ny, nz, origin, data } = grid;
  const L = latticeField(p.type, p.cell, p.thickness);
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

export async function latticeMesh(input: MeshData, p: LatticeParams, onProgress: ProgressFn = noProgress): Promise<LatticeResult> {
  // an inside-out part (all triangles facing in) is turned right way out first
  const mesh = meshVolume(input) < 0 ? flipMesh(input) : input;
  const { voids, voxelSize } = latticeVoids(mesh, p, onProgress);
  onProgress(0.82, 'Cutting the lattice out of the part');
  const out = await subtractMeshes(mesh, [voids]);
  onProgress(1);
  return { mesh: out, voxelSize, before: Math.abs(meshVolume(mesh)), after: Math.abs(meshVolume(out)) };
}
