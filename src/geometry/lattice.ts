/**
 * Lattice lightweighting: keep a solid skin of the part and fill the inside
 * with a lattice (gyroid, diamond or Schwarz-P walls, or cubic struts).
 *
 * The empty space between the lattice walls (inside the skin) is built as a
 * closed mesh from a distance field. With a skin it lies clear of the surface
 * and is simply added to the part as cavities, so the outer surface stays
 * exact and no boolean (the memory hog) is needed. An open lattice (no skin)
 * is cut out with an exact boolean while that fits in memory, and otherwise
 * built in one piece from the distance field.
 */
import { MeshData, computeBounds, flipMesh, mergeMeshes, ProgressFn, noProgress, subsetTriangles, FloatBuffer, IndexBuffer } from './mesh';
import { simplifyMesh } from './simplify';
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

/** grid nodes the distance field may have (about 8 bytes each, twice: the field and a copy) */
const BUDGET = { draft: 4e6, normal: 12e6, fine: 27e6 };
/** voxels across one wall: enough samples that the curved walls are traced, not aliased into blocks */
const PER_WALL = { draft: 2.2, normal: 2.8, fine: 3.5 };
/** how far the simplified surface may stray from the exact lattice surface, mm */
const DEVIATION = { draft: 0.08, normal: 0.04, fine: 0.02 };
/**
 * Triangles the lattice surface may have: the finished part is shown, kept for
 * undo and saved in the browser, and much more than this makes the page run
 * out of memory.
 */
const TRIANGLES = { draft: 1.5e6, normal: 3e6, fine: 5e6 };

/** voxels per cell when the void is traced side by side: enough to follow the curves */
const PER_CELL = { draft: 10, normal: 14, fine: 20 };

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
 * Voxel size for tracing a lattice: fine enough for the walls (folded fields:
 * cubic struts, or the whole part in one piece) or for the curves (lattices
 * traced side by side), within the voxel budget of the quality setting, and
 * not so fine that the traced surface has more than a few times the triangles
 * the result may keep (they are simplified down to it, which is the slow part).
 */
const OVERSAMPLE = { draft: 1.5, normal: 2, fine: 2 };

export function latticeVoxel(mesh: MeshData, p: LatticeParams, sided = latticeSides(p.type, p.cell, p.thickness) !== null, triangles = TRIANGLES[p.quality]): number {
  const b = computeBounds(mesh.positions);
  const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
  const skinCap = p.skin > 0 ? p.skin / (sided ? 1.25 : 2) : Infinity;
  const want = Math.min(sided ? p.cell / PER_CELL[p.quality] : Math.min(p.thickness / PER_WALL[p.quality], p.cell / 12), skinCap);
  // the finest the voxel budget allows
  let floor = want;
  for (let i = 0; i < 200 && (sx / floor + 6) * (sy / floor + 6) * (sz / floor + 6) > BUDGET[p.quality]; i++) floor *= 1.05;
  // marching tetrahedra makes about 7 triangles per voxel face of surface; more than a few times the result's budget is slow to simplify
  const area = areaDensity(p) * Math.abs(meshVolume(mesh)) + meshArea(mesh);
  let h = Math.max(want, Math.sqrt((7 * area) / (OVERSAMPLE[p.quality] * triangles)));
  // one folded field (cubic struts, or the whole part in one piece) loses walls between samples: not coarser than half a wall
  if (!sided) h = Math.min(h, Math.max(want, p.thickness / 2));
  return Math.max(h, floor);
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

type Field = (x: number, y: number, z: number) => number;

/**
 * The empty space of a lattice split into pieces that never touch, each with a
 * smooth field (positive in the void, about the distance to the wall in mm):
 * the two sides of a TPMS wall (f > c and f < -c), or the honeycomb cells in
 * three colours (cells of one colour never share a wall). A single field for all
 * of the void folds over at every wall, and a wall thinner than a voxel then
 * drops out between two samples (blocky, broken walls); each side alone is
 * smooth, so the walls come out exactly as thick as asked at any voxel size and
 * the voxels only have to follow the curves. Cubic struts have no sides (null).
 */
export function latticeSides(type: LatticeType, cell: number, thickness: number, axis: 'x' | 'y' | 'z' = 'z'): Field[] | null {
  const k = (2 * Math.PI) / cell, half = thickness / 2;
  const { sin, cos, abs } = Math;
  const two = (g: Field): Field[] => [(x, y, z) => g(x, y, z) - half, (x, y, z) => -g(x, y, z) - half];
  switch (type) {
    case 'gyroid':
      return two((x, y, z) => {
        const a = k * x, b = k * y, c = k * z;
        return (sin(a) * cos(b) + sin(b) * cos(c) + sin(c) * cos(a)) / (k * 1.25);
      });
    case 'diamond':
      return two((x, y, z) => {
        const a = k * x, b = k * y, c = k * z;
        const sa = sin(a), ca = cos(a), sb = sin(b), cb = cos(b), sc = sin(c), cc = cos(c);
        return (sa * sb * sc + sa * cb * cc + ca * sb * cc + ca * cb * sc) / (k * 1.2);
      });
    case 'schwarzP':
      return two((x, y, z) => (cos(k * x) + cos(k * y) + cos(k * z)) / (k * 1.4));
    case 'honeycomb': {
      // centres i·a1 + j·a2 (a1 = (cell, 0), a2 = (cell/2, cell·√3/2)), coloured (i + 2j) mod 3: neighbours differ
      const r3 = Math.sqrt(3), apo = cell / 2;
      const norm = (u: number, v: number) => Math.max(abs(u), abs(0.5 * u + (r3 / 2) * v), abs(0.5 * u - (r3 / 2) * v));
      const side = (colour: number) => (u: number, v: number) => {
        const j0 = Math.floor((2 * v) / (r3 * cell));
        const i0 = Math.floor(u / cell - j0 / 2);
        let best = Infinity;
        for (let dj = -2; dj <= 3; dj++)
          for (let di = -2; di <= 3; di++) {
            const j = j0 + dj, i = i0 + di;
            if ((((i + 2 * j) % 3) + 3) % 3 !== colour) continue;
            const n = norm(u - cell * (i + j / 2), v - (cell * r3 * j) / 2);
            if (n < best) best = n;
          }
        return apo - best - half;
      };
      return [0, 1, 2].map((c) => {
        const f = side(c);
        return axis === 'x' ? (_x: number, y: number, z: number) => f(y, z) : axis === 'y' ? (x: number, _y: number, z: number) => f(z, x) : (x: number, y: number) => f(x, y);
      });
    }
    case 'cubic':
      return null;
  }
}

/** Trilinear sampler of a grid's values (clamped at the grid edges). */
function trilinear(grid: Grid, D: Float32Array) {
  const { nx, ny, nz, origin, h } = grid;
  const cl = (v: number, n: number) => (v < 0 ? 0 : v > n - 1 ? n - 1 : v);
  return (x: number, y: number, z: number) => {
    const fx = cl((x - origin[0]) / h, nx), fy = cl((y - origin[1]) / h, ny), fz = cl((z - origin[2]) / h, nz);
    const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy)), k = Math.min(nz - 2, Math.floor(fz));
    const u = fx - i, v = fy - j, w = fz - k;
    const n = i + nx * (j + ny * k), sy = nx, sz = nx * ny;
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(D[n], D[n + 1], u), l(D[n + sy], D[n + sy + 1], u), v),
      l(l(D[n + sz], D[n + sz + 1], u), l(D[n + sz + sy], D[n + sz + sy + 1], u), v),
      w,
    );
  };
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
function contourWrap(grid: Grid, mesh: MeshData, skin: number, S: Field, L: Field): Field {
  const { h } = grid;
  const b = computeBounds(mesh.positions);
  const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
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
  /**
   * exact: the lattice added inside the untouched outer surface; boolean: an open lattice cut out exactly;
   * voxel: an open lattice too big to cut exactly, the whole part rebuilt from the distance field (edges slightly rounded)
   */
  method: 'exact' | 'boolean' | 'voxel';
}

function checkParams(p: LatticeParams) {
  if (!(p.cell > 0) || !(p.thickness > 0)) throw new Error('Cell size and wall thickness must be positive');
  if (p.thickness >= p.cell * 0.8) throw new Error('The walls are too thick for the cell size: nothing would be removed');
}

/**
 * Surface from the distance field on a grid of voxel size h:
 * - 'voids': closed mesh of the empty space between the lattice walls, inside the skin
 *   (with no skin the voids run out past the surface, for a boolean to trim, closed at the grid edge);
 *   traced one side (piece) at a time where the lattice has sides, see latticeSides;
 * - 'solid': the whole lightened part (skin and lattice) in one piece, its outer surface
 *   rebuilt from the distance field too (no boolean needed, but edges come out slightly rounded).
 */
function latticeSurface(mesh: MeshData, p: LatticeParams, h: number, what: 'voids' | 'solid', onProgress: ProgressFn, triangles = TRIANGLES[p.quality], maxDev = DEVIATION[p.quality]): MeshData {
  const skin = Math.max(0, p.skin);
  const grid = signedDistanceGrid(mesh, h, {
    pad: 2,
    bandCenter: what === 'solid' ? skin / 2 : skin,
    bandWidth: what === 'solid' ? skin / 2 + 2.5 * h : 2.5 * h,
    // the solid's outer surface comes from the field too: exact on both sides of it
    outside: what === 'solid',
    offset: 0.37,
    onProgress: (f, m) => onProgress(f * 0.5, m),
  });
  const { nx, ny, nz, origin, data } = grid;
  const D = data.slice();
  const d = trilinear(grid, D);
  const wrap = (L: Field) => (p.layout === 'contour' ? contourWrap(grid, mesh, skin, d, L) : L);
  // the surfaces are where a field is 0: positive in the void (for 'solid': in the material)
  // each field comes with the smooth branches it is made of (for putting vertices onto its creases)
  const fields: { F: Field; branches: Field[] }[] = [];
  const sides = what === 'voids' ? latticeSides(p.type, p.cell, p.thickness, p.axis ?? 'z') : null;
  const inside: Field = skin > 0 ? (x, y, z) => d(x, y, z) - skin : (x, y, z) => d(x, y, z) + 2 * h;
  if (sides) for (const side of sides.map(wrap)) fields.push({ F: (x, y, z) => Math.min(inside(x, y, z), side(x, y, z)), branches: [inside, side] });
  else {
    const L = wrap(latticeField(p.type, p.cell, p.thickness, p.axis ?? 'z'));
    if (what === 'solid')
      fields.push({
        F: (x, y, z) => { const v = d(x, y, z); return Math.min(v, Math.max(skin - v, L(x, y, z))); },
        branches: skin > 0 ? [d, (x, y, z) => skin - d(x, y, z), L] : [d, L],
      });
    else {
      const notL: Field = (x, y, z) => -L(x, y, z);
      fields.push({ F: (x, y, z) => Math.min(inside(x, y, z), notL(x, y, z)), branches: [inside, notL] });
    }
  }
  const parts: MeshData[] = [];
  const tiny = h * 1.234e-3;
  fields.forEach(({ F, branches }, fi) => {
    const share = 0.5 / fields.length, at = 0.5 + fi * share;
    onProgress(at, 'Building the lattice');
    for (let k = 0; k < nz; k++) {
      const z = origin[2] + k * h;
      for (let j = 0; j < ny; j++) {
        const y = origin[1] + j * h;
        for (let i = 0; i < nx; i++) {
          const n = i + nx * (j + ny * k);
          const border = i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1;
          data[n] = border ? -h : F(origin[0] + i * h, y, z) - tiny;
        }
      }
    }
    const m = smoothSurface(grid, F, branches, triangles / fields.length, maxDev, (f, msg) => onProgress(at + share * (0.1 + 0.9 * f), msg));
    if (m.indices.length) parts.push(m);
  });
  let out = parts.length === 1 ? parts[0] : mergeMeshes(parts);
  if (!out.indices.length) throw new Error('No room for a lattice: use a thinner skin, thinner walls or a larger part');
  if (meshVolume(out) < 0) out = flipMesh(out);
  return out;
}

/**
 * Move the traced vertices onto the exact surface F = 0 (the grid only
 * interpolates it linearly). F is made of a few smooth branches (the lattice
 * wall, the skin, the part's surface) meeting at sharp creases: each vertex goes
 * onto its own branch with one Newton step, and a vertex whose neighbours lie on
 * another branch goes onto the crease where the two meet, so the edges come out
 * sharp instead of sawn. Moves that would turn a triangle over are undone.
 * Locked vertices (on the slab planes, shared with the next slab) stay put.
 */
function placeOnSurface(m: MeshData, locked: Uint8Array, F: Field, branches: Field[], h: number, z0: number, z1: number) {
  const P = m.positions, I = m.indices, nv = P.length / 3;
  const orig = P.slice();
  const e = h * 0.2, maxStep = h * 0.75;
  const nb = branches.length;
  // which branch each vertex lies on: the one closest to zero there
  const label = new Uint8Array(nv);
  if (nb > 1)
    for (let v = 0; v < nv; v++) {
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      let best = Infinity;
      for (let b = 0; b < nb; b++) {
        const a = Math.abs(branches[b](x, y, z));
        if (a < best) (best = a), (label[v] = b);
      }
    }
  // a neighbour on another branch: the crease runs past this vertex
  const other = new Int16Array(nv).fill(-1);
  if (nb > 1)
    for (let t = 0; t < I.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const a = I[t + k], b = I[t + ((k + 1) % 3)];
        if (label[a] !== label[b]) (other[a] = label[b]), (other[b] = label[a]);
      }
  const g1 = [0, 0, 0], g2 = [0, 0, 0];
  const grad = (B: Field, x: number, y: number, z: number, g: number[]) => {
    g[0] = (B(x + e, y, z) - B(x - e, y, z)) / (2 * e);
    g[1] = (B(x, y + e, z) - B(x, y - e, z)) / (2 * e);
    g[2] = (B(x, y, z + e) - B(x, y, z - e)) / (2 * e);
    return g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
  };
  for (let v = 0; v < nv; v++) {
    if (locked[v]) continue;
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    let sx = 0, sy = 0, sz = 0, ok = false;
    if (other[v] >= 0) {
      // onto the crease: the smallest move that zeroes both branches (to first order)
      const A = branches[label[v]], B = branches[other[v]];
      const a = A(x, y, z), b = B(x, y, z);
      grad(A, x, y, z, g1);
      grad(B, x, y, z, g2);
      const p = g1[0] * g1[0] + g1[1] * g1[1] + g1[2] * g1[2], q = g1[0] * g2[0] + g1[1] * g2[1] + g1[2] * g2[2], r = g2[0] * g2[0] + g2[1] * g2[1] + g2[2] * g2[2];
      const det = p * r - q * q;
      if (det > 1e-6 * p * r) {
        // Δ = Gᵀ (G Gᵀ)⁻¹ (−[a, b])
        const l1 = (-a * r + b * q) / det, l2 = (-b * p + a * q) / det;
        sx = l1 * g1[0] + l2 * g2[0]; sy = l1 * g1[1] + l2 * g2[1]; sz = l1 * g1[2] + l2 * g2[2];
        ok = Math.hypot(sx, sy, sz) <= maxStep && Math.abs(F(x + sx, y + sy, z + sz)) < 0.05 * h;
      }
    }
    if (!ok) {
      // onto its own branch (or onto F where there is only one)
      const B = nb > 1 ? branches[label[v]] : F;
      const f = B(x, y, z), gg = grad(B, x, y, z, g1);
      if (!(gg > 1e-12)) continue;
      sx = (-f * g1[0]) / gg; sy = (-f * g1[1]) / gg; sz = (-f * g1[2]) / gg;
      const sl = Math.hypot(sx, sy, sz);
      if (sl > maxStep) (sx *= maxStep / sl), (sy *= maxStep / sl), (sz *= maxStep / sl);
    }
    P[v * 3] = x + sx; P[v * 3 + 1] = y + sy;
    // never onto a slab plane (those vertices are the shared ones)
    const nz2 = Math.fround(z + sz);
    P[v * 3 + 2] = nz2 === z0 || nz2 === z1 ? z : nz2;
  }
  // undo moves that turn triangles over (or flatten them to nothing)
  for (let pass = 0; pass < 3; pass++) {
    let undone = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const n0 = cross3(orig, a, b, c), n1 = cross3(P, a, b, c);
      if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] > 0) continue;
      for (const w of [a, b, c])
        if (P[w] !== orig[w] || P[w + 1] !== orig[w + 1] || P[w + 2] !== orig[w + 2]) {
          P[w] = orig[w]; P[w + 1] = orig[w + 1]; P[w + 2] = orig[w + 2];
          undone++;
        }
    }
    if (!undone) break;
  }
}

function cross3(P: Float32Array, a: number, b: number, c: number): [number, number, number] {
  const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
  const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/**
 * Surface of a grid traced finely and then simplified, slab by slab so it fits
 * in memory: every vertex is moved onto the exact surface F = 0 (the grid only
 * interpolates it linearly), then each slab is simplified towards the triangle
 * budget, never moving its vertices on the planes it shares with the slabs
 * above and below, and the slabs are joined on those planes.
 */
function smoothSurface(grid: Grid, F: Field, branches: Field[], target: number, maxDev: number, onProgress: ProgressFn): MeshData {
  const { nx, ny, nz, origin, h, data } = grid;
  // sign changes along grid edges, per layer: about how much surface each layer holds
  const cross = new Float64Array(nz);
  let total = 0;
  for (let k = 0; k < nz; k++) {
    let c = 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const n = i + nx * (j + ny * k), v = data[n] > 0;
        if (i + 1 < nx && v !== data[n + 1] > 0) c++;
        if (j + 1 < ny && v !== data[n + nx] > 0) c++;
        if (k + 1 < nz && v !== data[n + nx * ny] > 0) c++;
      }
    cross[k] = c;
    total += c;
  }
  if (!total) return { positions: new Float32Array(0), indices: new Uint32Array(0) };
  // slabs of about 250 000 crossings (about a million triangles before simplifying)
  const slabs: [number, number][] = [];
  for (let k = 0, acc = 0, start = 0; k < nz - 1; k++) {
    acc += cross[k];
    if (acc > 250000 || k === nz - 2) {
      slabs.push([start, k + 1]);
      start = k + 1;
      acc = 0;
    }
  }
  const posOut = new FloatBuffer(1 << 16), idxOut = new IndexBuffer(1 << 16);
  let below = new Map<string, number>();
  let ratio = 1, done = 0, extracted = 0;
  for (const [k0, k1] of slabs) {
    const z0 = Math.fround(origin[2] + k0 * h), z1 = Math.fround(origin[2] + k1 * h);
    const m = marchingTetrahedra(grid, noProgress, { from: k0, to: k1 });
    const P = m.positions, nv = P.length / 3;
    if (!nv) continue;
    // the ratio from the first slabs: triangles per crossing, then what the budget allows
    extracted += m.indices.length / 3;
    done += cross.slice(k0, k1).reduce((a, b) => a + b, 0);
    ratio = Math.min(1, target / ((extracted / Math.max(1, done)) * total));
    const locked = new Uint8Array(nv);
    for (let v = 0; v < nv; v++) {
      const z = P[v * 3 + 2];
      if (z === z0 || z === z1) locked[v] = 1;
    }
    placeOnSurface(m, locked, F, branches, h, z0, z1);
    const s = ratio < 0.98 ? simplifyMesh(m, ratio, noProgress, { maxDeviation: maxDev, locked }).mesh : m;
    // join: vertices on the bottom plane are the ones the slab below left on its top plane
    const above = new Map<string, number>();
    const SP = s.positions, map = new Uint32Array(SP.length / 3);
    for (let v = 0; v < map.length; v++) {
      const x = SP[v * 3], y = SP[v * 3 + 1], z = SP[v * 3 + 2];
      const key = z === z0 || z === z1 ? `${x},${y}` : '';
      const old = z === z0 ? below.get(key) : undefined;
      map[v] = old ?? posOut.push3(x, y, z);
      if (z === z1) above.set(key, map[v]);
    }
    for (let i = 0; i < s.indices.length; i += 3) idxOut.push3(map[s.indices[i]], map[s.indices[i + 1]], map[s.indices[i + 2]]);
    below = above;
    onProgress(k1 / nz, ratio < 0.98 ? 'Smoothing and simplifying' : 'Smoothing');
  }
  return { positions: posOut.toArray(), indices: idxOut.toArray() };
}

/** Closed mesh of the empty space between the lattice walls, inside the skin. */
export function latticeVoids(mesh: MeshData, p: LatticeParams, onProgress: ProgressFn = noProgress): { voids: MeshData; voxelSize: number } {
  checkParams(p);
  const h = latticeVoxel(mesh, p);
  return { voids: latticeSurface(mesh, p, h, 'voids', onProgress), voxelSize: h };
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

/**
 * Lattice triangles the exact boolean may cut out of the part with no skin: it
 * needs roughly 600 bytes per triangle (1.7 GB for 2.7 million), and a browser
 * worker runs out of memory well before WebAssembly's 4 GB. Bigger open
 * lattices are built in one piece from the distance field instead.
 */
const BOOLEAN_TRIANGLES = { draft: 0.6e6, normal: 1e6, fine: 1.5e6 };

export async function latticeMesh(input: MeshData, p: LatticeParams, onProgress: ProgressFn = noProgress): Promise<LatticeResult> {
  checkParams(p);
  // an inside-out part (all triangles facing in) is turned right way out first
  const mesh = meshVolume(input) < 0 ? flipMesh(input) : input;
  const sided = latticeSides(p.type, p.cell, p.thickness) !== null;
  let h = latticeVoxel(mesh, p, sided);
  const skin = Math.max(0, p.skin);
  let out: MeshData | null = null;
  let method: LatticeResult['method'];
  if (skin >= 1.2 * h) {
    // the voids lie inside the skin, clear of the surface: they are simply added to the part as
    // cavities (exact outer surface, no boolean, little memory)
    const voids = latticeSurface(mesh, p, h, 'voids', (f, m) => onProgress(f * 0.85, m));
    onProgress(0.85, 'Adding the lattice to the part');
    out = mergeMeshes([mesh, flipMesh(voids)]);
    method = 'exact';
  } else {
    // open lattice (no skin): the voids, simplified down to what the exact boolean handles in memory,
    // cut out of the part (exact outer surface, sharp edges where the walls meet it)
    const cap = BOOLEAN_TRIANGLES[p.quality];
    // traced no finer than needed for that: the simplifying is the slow part
    h = latticeVoxel(mesh, p, sided, 1.5 * cap);
    const voids = latticeSurface(mesh, p, h, 'voids', (f, m) => onProgress(f * 0.8, m), cap, Math.max(DEVIATION[p.quality], 0.25 * h));
    if (voids.indices.length / 3 <= cap * 1.3) {
      onProgress(0.82, 'Cutting the lattice out of the part');
      try {
        out = await subtractMeshes(mesh, [voids]);
      } catch {
        out = null; // out of memory, or a part that is not a closed solid: build it from the distance field
      }
    }
    method = out ? 'boolean' : 'voxel';
    if (!out) {
      // the whole part in one piece from one (folded) field: needs voxels fine enough for the walls
      h = latticeVoxel(mesh, p, false);
      out = latticeSurface(mesh, p, h, 'solid', (f, m) => onProgress(f * 0.97, m));
    }
  }
  onProgress(0.97, 'Removing loose pieces');
  out = dropLooseBits(out);
  onProgress(1);
  return { mesh: out, voxelSize: h, before: Math.abs(meshVolume(mesh)), after: Math.abs(meshVolume(out)), coarse: sided && method !== 'voxel' ? h > p.cell / 6 : h > p.thickness / 1.5, method };
}
