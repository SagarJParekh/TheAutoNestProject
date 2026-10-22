/**
 * 3D nesting for powder-bed printers (HP MJF / SLS): parts are packed by
 * their actual shape, not their bounding box, anywhere in the build volume
 * (X, Y and Z), including into the open space of other parts (trays, U
 * shapes, corners).
 *
 * Each part is voxelized exactly (every voxel its surface touches, the
 * inside, and cavities closed off from the outside), once: the other three
 * quarter turns are the same voxels turned. The voxel size is chosen so the
 * clearance is a whole number of voxels. Placed parts keep out every voxel
 * whose cube comes closer than the clearance to one of their cubes (true
 * distance, so the keep-out has rounded corners), so the gap between real
 * surfaces is always at least the clearance.
 *
 * Placement is lowest-first (Z, then Y, then X) over four 90° turns. A run
 * can place the copies of a part in a regular pattern (rows / columns /
 * layers) where that costs nothing. Several variants (order of the parts,
 * pattern or not) can be tried; the densest is kept.
 *
 * No interlocking: a spot is only accepted if the part can slide straight
 * out of the build (±X, ±Y or ±Z) past every part placed before it; then all
 * parts can be taken out in reverse order.
 *
 * Speed: grids are bit sets (1 bit per voxel) scanned 32 voxels at a time; a
 * blocked run jumps straight to the next free gap long enough for it; rows
 * without a long enough free run are skipped whole; copies of a part continue
 * their search where the previous copy stopped (spots that failed once can
 * never become free again); the way-out check uses per-column extremes.
 */
import type { MeshData, Vec3 } from './mesh';
import { isWatertight } from './analysis';
import { voxelizeInsideRobust } from './sdf';

export interface NestPart {
  id: string;
  /** mesh already in its final orientation (only 90° turns about Z are added); any origin */
  mesh: MeshData;
  count: number;
  /** orientation locked: no 90° turns */
  fixed?: boolean;
  /** voxels made beforehand (see nestVoxels); used when made with the voxel size this nest uses, else the mesh is voxelized */
  voxels?: NestVoxels;
  /** copy numbers used in the keys (`id#copy`), default 0 … count − 1 */
  copies?: number[];
  /**
   * Copy locked in place by the user (count 1, never turned): world
   * translation `at` on the locked axes (null = free), in build `build`. A
   * copy locked on all three axes stays exactly there; one locked on some
   * axes is placed along the others. Locked copies go in before all others.
   */
  lock?: { build: number; at: [number | null, number | null, number | null] };
}

/** A part's voxels for nesting, made once and shared by several nesting runs. */
export type NestVoxels = PartVoxels & { h: number; align?: (number | null)[] };

/** Voxelize a part for nest3d ahead of time (e.g. once, in its own worker, for several parallel nests). */
export function nestVoxels(mesh: MeshData, h: number, align?: (number | null)[]): NestVoxels {
  return { ...voxelizePart(mesh, h, isWatertight(mesh), align), h, align };
}

/**
 * Grid alignment for a locked copy: per axis the offset (in the part's own
 * coordinates) of the build grid, so the copy's voxels line up with the
 * build's voxels exactly at its locked translation.
 */
export function lockAlign(p: Pick<NestParams, 'volume' | 'margin' | 'zOffset'>, at: (number | null)[]): (number | null)[] {
  const origin = [-p.volume[0] / 2 + p.margin, -p.volume[1] / 2 + p.margin, p.zOffset];
  return at.map((t, c) => (t === null ? null : origin[c] - t));
}

export interface NestParams {
  /** printer build volume X, Y, Z, mm */
  volume: [number, number, number];
  /** empty border along the platform edges, mm */
  margin: number;
  /** minimum distance between parts, mm */
  clearance: number;
  /** distance between the platform and the lowest parts, mm */
  zOffset: number;
  /** build up to this height (mm above the platform); 0 = the printer's full height */
  maxHeight: number;
  /** voxel size in mm; default chosen from `budget` and the clearance */
  voxel?: number;
  /** maximum number of voxels per build grid (default 40 million) */
  budget?: number;
  /** try 90° turns about Z */
  rotations: boolean;
  /** only accept spots from which the part can slide straight out (default true) */
  interlockFree?: boolean;
  /** also accept tilted ways out (out of tilted cups and trays; default true) */
  tilted?: boolean;
  /** also nest with the copies of each part in regular patterns, and keep that when it needs no more builds and is no taller (default true) */
  symmetric?: boolean;
  /**
   * Nest several ways (order of the parts, copies in patterns or not) and keep
   * the densest: fewest builds, then the lowest last build; a pattern run wins
   * a tie. Default: largest first, free, plus the same in patterns when
   * `symmetric`.
   */
  variants?: NestVariant[];
}

/**
 * Order in which parts are placed: largest volume, tallest, largest bounding
 * box, largest footprint, or the most open space first (cups, trays, U
 * shapes: placed early, other parts can go inside them).
 */
export type NestOrder = 'volume' | 'height' | 'box' | 'footprint' | 'open';
export interface NestVariant {
  order: NestOrder;
  /** copies of a part in regular patterns where that costs no density */
  pattern: boolean;
}

export interface NestPlacement {
  key: string;
  partId: string;
  copy: number;
  /** quarter turns about Z applied to the part's mesh (0..3) */
  turns: number;
  /** translation applied after the turn: world vertex = Rz(turns) · v + t */
  t: Vec3;
  /** placed in the regular pattern of its copies */
  pattern?: boolean;
  /** a copy locked by the user */
  locked?: boolean;
}

export interface NestBuild {
  placements: NestPlacement[];
  /** tallest point above the platform, mm */
  height: number;
  /** share of the usable platform area under parts (projection), 0..1 */
  utilization: number;
}

export interface NestResult {
  builds: NestBuild[];
  unplaced: { key: string; reason: string }[];
  voxel: number;
  /** the variant that was kept */
  variant?: NestVariant;
}

// ---------------------------------------------------------------- part voxels

export interface PartVoxels {
  nx: number;
  ny: number;
  nz: number;
  /** world position of the low corner of voxel (0,0,0) for the part as given (before translation) */
  min: Vec3;
  solid: Uint8Array;
  /** runs along x: [j, k, x0, len] per row segment */
  runs: Int32Array;
  /** solid voxel count */
  count: number;
}

/** Turn a mesh by k quarter turns about Z: (x, y) → (−y, x) per turn. */
export function turnPositions(p: Float32Array, k: number): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    let x = p[i],
      y = p[i + 1];
    for (let t = 0; t < (k & 3); t++) [x, y] = [-y, x];
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = p[i + 2];
  }
  return out;
}

/** Triangle / axis-aligned box overlap (separating axis test); box given by centre and half size. */
function triBoxOverlap(c: number[], hs: number, v0: number[], v1: number[], v2: number[]): boolean {
  const a = [v0[0] - c[0], v0[1] - c[1], v0[2] - c[2]];
  const b = [v1[0] - c[0], v1[1] - c[1], v1[2] - c[2]];
  const d = [v2[0] - c[0], v2[1] - c[1], v2[2] - c[2]];
  const e0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e1 = [d[0] - b[0], d[1] - b[1], d[2] - b[2]];
  const e2 = [a[0] - d[0], a[1] - d[1], a[2] - d[2]];
  const eps = hs * 1e-6;
  // 9 edge cross axes
  for (const e of [e0, e1, e2]) {
    for (let ax = 0; ax < 3; ax++) {
      // axis = unit_ax × e
      let n0 = 0,
        n1 = 0,
        n2 = 0;
      if (ax === 0) ((n1 = -e[2]), (n2 = e[1]));
      else if (ax === 1) ((n0 = e[2]), (n2 = -e[0]));
      else ((n0 = -e[1]), (n1 = e[0]));
      const p0 = n0 * a[0] + n1 * a[1] + n2 * a[2];
      const p1 = n0 * b[0] + n1 * b[1] + n2 * b[2];
      const p2 = n0 * d[0] + n1 * d[1] + n2 * d[2];
      const r = hs * (Math.abs(n0) + Math.abs(n1) + Math.abs(n2));
      if (Math.min(p0, p1, p2) > r + eps || Math.max(p0, p1, p2) < -r - eps) return false;
    }
  }
  // box faces
  for (let ax = 0; ax < 3; ax++) if (Math.min(a[ax], b[ax], d[ax]) > hs + eps || Math.max(a[ax], b[ax], d[ax]) < -hs - eps) return false;
  // triangle plane
  const n = [e0[1] * e1[2] - e0[2] * e1[1], e0[2] * e1[0] - e0[0] * e1[2], e0[0] * e1[1] - e0[1] * e1[0]];
  const dist = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
  const r = hs * (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]));
  return Math.abs(dist) <= r + eps;
}

/**
 * Voxels a part occupies: every voxel its surface touches (exact triangle /
 * voxel test), everything inside, and cavities that are closed off from the
 * outside (a part could never be put in there).
 */
export function voxelizePart(mesh: MeshData, h: number, closed = isWatertight(mesh), align?: (number | null)[]): PartVoxels {
  const p = mesh.positions,
    idx = mesh.indices;
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let c = 0; c < 3; c++) {
      if (p[i + c] < min[c]) min[c] = p[i + c];
      if (p[i + c] > max[c]) max[c] = p[i + c];
    }
  // grid lines through `align` on the given axes (the grid starts at or below the part)
  if (align)
    for (let c = 0; c < 3; c++) {
      const a = align[c];
      if (a !== null && a !== undefined) min[c] = a + Math.floor((min[c] - a) / h + 1e-9) * h;
    }
  const nx = Math.max(1, Math.floor((max[0] - min[0]) / h + 1e-9) + 1);
  const ny = Math.max(1, Math.floor((max[1] - min[1]) / h + 1e-9) + 1);
  const nz = Math.max(1, Math.floor((max[2] - min[2]) / h + 1e-9) + 1);
  const solid = new Uint8Array(nx * ny * nz);
  const hs = h / 2;
  const v0 = [0, 0, 0],
    v1 = [0, 0, 0],
    v2 = [0, 0, 0],
    c = [0, 0, 0];
  const n3 = [nx, ny, nz];
  const lo = [0, 0, 0],
    hi = [0, 0, 0];
  for (let t = 0; t < idx.length; t += 3) {
    let single = true;
    for (let q = 0; q < 3; q++) {
      const a = (v0[q] = p[idx[t] * 3 + q] - min[q]),
        b = (v1[q] = p[idx[t + 1] * 3 + q] - min[q]),
        c = (v2[q] = p[idx[t + 2] * 3 + q] - min[q]);
      const mn = a < b ? (a < c ? a : c) : b < c ? b : c,
        mx = a > b ? (a > c ? a : c) : b > c ? b : c;
      lo[q] = Math.max(0, Math.floor(mn / h - 1e-6));
      hi[q] = Math.min(n3[q] - 1, Math.floor(mx / h + 1e-6));
      if (lo[q] !== hi[q]) single = false;
    }
    if (single) {
      // a small triangle inside one voxel (most triangles of a fine mesh): no overlap test needed
      solid[lo[0] + nx * (lo[1] + ny * lo[2])] = 1;
      continue;
    }
    for (let k = lo[2]; k <= hi[2]; k++)
      for (let j = lo[1]; j <= hi[1]; j++)
        for (let i = lo[0]; i <= hi[0]; i++) {
          const o = i + nx * (j + ny * k);
          if (solid[o]) continue;
          c[0] = (i + 0.5) * h;
          c[1] = (j + 0.5) * h;
          c[2] = (k + 0.5) * h;
          if (triBoxOverlap(c, hs, v0, v1, v2)) solid[o] = 1;
        }
  }
  // inside (sampled at voxel centres)
  const inside = voxelizeInsideRobust(mesh, [min[0] + hs, min[1] + hs, min[2] + hs], nx, ny, nz, h, closed);
  for (let i = 0; i < solid.length; i++) if (inside[i]) solid[i] = 1;
  fillEnclosed(solid, nx, ny, nz);
  return {
    nx,
    ny,
    nz,
    min,
    solid,
    runs: rowRuns(solid, nx, ny, nz),
    count: solid.reduce((s, v) => s + v, 0),
  };
}

/**
 * The voxels of the part turned a quarter turn about Z ((x, y) → (−y, x)).
 * A quarter turn maps voxel cubes onto voxel cubes, so this is exactly the
 * voxelization of the turned part (on a grid anchored at its new corner).
 */
export function turnVoxels(v: PartVoxels, h: number): PartVoxels {
  const { nx, ny, nz } = v;
  const tx = ny,
    ty = nx;
  const solid = turnCells(v.solid, nx, ny, nz);
  // the new grid's low x corner is where the old grid's high y corner went
  const min: Vec3 = [-(v.min[1] + ny * h), v.min[0], v.min[2]];
  return { nx: tx, ny: ty, nz, min, solid, runs: rowRuns(solid, tx, ty, nz), count: v.count };
}

/** A cell grid turned a quarter turn about Z: cell (i, j, k) goes to (ny − 1 − j, i, k) of an ny × nx × nz grid. */
function turnCells(cells: Uint8Array, nx: number, ny: number, nz: number): Uint8Array {
  const out = new Uint8Array(cells.length);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const o = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) if (cells[o + i]) out[ny - 1 - j + ny * (i + nx * k)] = 1;
    }
  return out;
}

/** Fill empty voxels that cannot be reached from outside the part's box. */
function fillEnclosed(solid: Uint8Array, nx: number, ny: number, nz: number) {
  const seen = new Uint8Array(solid.length);
  // every cell is pushed at most once
  const stack = new Int32Array(solid.length);
  let top = 0;
  const push = (i: number) => {
    if (!solid[i] && !seen[i]) {
      seen[i] = 1;
      stack[top++] = i;
    }
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push(i + nx * (j + ny * k));
  while (top) {
    const c = stack[--top];
    const i = c % nx,
      j = ((c / nx) | 0) % ny,
      k = (c / (nx * ny)) | 0;
    if (i > 0) push(c - 1);
    if (i < nx - 1) push(c + 1);
    if (j > 0) push(c - nx);
    if (j < ny - 1) push(c + nx);
    if (k > 0) push(c - nx * ny);
    if (k < nz - 1) push(c + nx * ny);
  }
  for (let i = 0; i < solid.length; i++) if (!solid[i] && !seen[i]) solid[i] = 1;
}

function rowRuns(solid: Uint8Array, nx: number, ny: number, nz: number): Int32Array {
  const out: number[] = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      let i = 0;
      while (i < nx) {
        if (!solid[i + nx * (j + ny * k)]) {
          i++;
          continue;
        }
        const x0 = i;
        while (i < nx && solid[i + nx * (j + ny * k)]) i++;
        out.push(j, k, x0, i - x0);
      }
    }
  return Int32Array.from(out);
}

/** 1D squared distance transform (Felzenszwalb & Huttenlocher) of f along a line, in place via scratch arrays. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
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
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (f[v[0]] === Infinity) {
    d.fill(Infinity, 0, n);
    return;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/**
 * Keep-out of a part: every voxel whose cube comes closer than `r` voxels to
 * a cube of the part (true distance between the cubes, so the corners are
 * rounded, not a bigger cube). A part whose voxels stay out of it is at
 * least r·h away from this one. Returns a grid padded by `pad` on each side.
 */
export function dilate(v: PartVoxels, r: number): { nx: number; ny: number; nz: number; pad: number; cells: Uint8Array } {
  // cubes closer than r ⇔ centres within r of the part grown by one voxel (cube)
  const pad = Math.max(1, Math.ceil(r - 1e-9)) + 1;
  const nx = v.nx + 2 * pad,
    ny = v.ny + 2 * pad,
    nz = v.nz + 2 * pad;
  const N = nx * ny * nz;
  const g = new Float64Array(N).fill(Infinity);
  for (let k = 0; k < v.nz; k++)
    for (let j = 0; j < v.ny; j++)
      for (let i = 0; i < v.nx; i++)
        if (v.solid[i + v.nx * (j + v.ny * k)])
          for (let c = -1; c <= 1; c++)
            for (let b = -1; b <= 1; b++)
              for (let a = -1; a <= 1; a++) g[i + pad + a + nx * (j + pad + b + ny * (k + pad + c))] = 0;
  const m = Math.max(nx, ny, nz);
  const f = new Float64Array(m),
    d = new Float64Array(m),
    vv = new Int32Array(m),
    z = new Float64Array(m + 1);
  const pass = (n: number, stride: number, starts: number[]) => {
    for (const s0 of starts) {
      for (let q = 0; q < n; q++) f[q] = g[s0 + q * stride];
      edt1d(f, n, d, vv, z);
      for (let q = 0; q < n; q++) g[s0 + q * stride] = d[q];
    }
  };
  const sx: number[] = [],
    sy: number[] = [],
    sz: number[] = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) sx.push(nx * (j + ny * k));
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) sy.push(i + nx * ny * k);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sz.push(i + nx * j);
  pass(nx, 1, sx);
  pass(ny, nx, sy);
  pass(nz, nx * ny, sz);
  const r2 = r * r - 1e-9;
  const cells = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (g[i] < r2) cells[i] = 1;
  return { nx, ny, nz, pad, cells };
}

/** A part in one turn, ready for placing: solid runs, keep-out runs, escape profiles. */
interface Shape {
  v: PartVoxels;
  /** keep-out runs (dilated by d), relative to the part's voxel (0,0,0): [j, k, x0, len] */
  keepRuns: Int32Array;
  /** per column (i, j): lowest / highest solid k, or -1 */
  colLo: Int16Array;
  colHi: Int16Array;
  /** per row (j, k): lowest / highest solid i */
  rowLo: Int16Array;
  rowHi: Int16Array;
  /** per (i, k): lowest / highest solid j */
  depLo: Int16Array;
  depHi: Int16Array;
  /** the longest solid runs (one per row): [j, k, len, …]; a row of the build without a free run that long rules out a whole row of spots */
  keyRows: Int32Array;
  /** offsets of the runs in a spread-out test order */
  order: Int32Array;
  /** non-empty columns (i + nx·j), rows (j + ny·k) and depth lines (i + nx·k), for the way-out check */
  cols: Int32Array;
  rows: Int32Array;
  deps: Int32Array;
  /** per tilted direction and Z parity (made when first needed): sheared columns [ci, cj, lowest (up) / highest (down) k, …] */
  tilt?: Map<number, Int32Array>;
  /** surface voxels (made when first needed) */
  surface?: Int32Array;
}

/** The shape's sheared columns for a tilted direction, when placed at a Z of parity p. */
function tiltProfile(s: Shape, d: number, p: number): Int32Array {
  const { a, b, up } = TILTED_DIRS[d];
  // whole-voxel slopes do not depend on the parity of Z
  if (Number.isInteger(a) && Number.isInteger(b)) p = 0;
  const key = d * 2 + p;
  let prof = s.tilt?.get(key);
  if (prof) return prof;
  const { nx, ny, nz } = s.v;
  // exact range of the sheared columns (the shift grows steadily with k)
  const sx0 = 0,
    sx1 = shearOf(a, p + nz - 1) - shearOf(a, p),
    sy1 = shearOf(b, p + nz - 1) - shearOf(b, p);
  const ox = Math.max(sx0, sx1),
    oy = Math.max(0, sy1);
  const W = nx + Math.abs(sx1) + 1,
    Hh = ny + Math.abs(sy1) + 1;
  const ext = new Int32Array(W * Hh).fill(up ? 0x7fffffff : -1);
  // the lowest / highest voxel of a sheared column always has an empty neighbour: surface voxels are enough
  const sv = surfaceOf(s);
  for (let q = 0; q < sv.length; q += 3) {
    const k = sv[q + 2];
    const c = sv[q] - (shearOf(a, p + k) - shearOf(a, p)) + ox + W * (sv[q + 1] - (shearOf(b, p + k) - shearOf(b, p)) + oy);
    if (up ? k < ext[c] : k > ext[c]) ext[c] = k;
  }
  const cols: number[] = [];
  for (let c = 0; c < ext.length; c++) if (up ? ext[c] !== 0x7fffffff : ext[c] >= 0) cols.push(c);
  // spread-out order (neighbouring columns are usually blocked or free together): a blocking one is found sooner
  const n = cols.length;
  let stride = Math.max(1, Math.round(n * 0.618));
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
  while (n > 1 && gcd(stride, n) !== 1) stride++;
  prof = new Int32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = cols[(i * stride) % n];
    prof[i * 3] = (c % W) - ox;
    prof[i * 3 + 1] = ((c / W) | 0) - oy;
    prof[i * 3 + 2] = ext[c];
  }
  (s.tilt ??= new Map()).set(key, prof);
  return prof;
}

/** Solid voxels with at least one empty (or outside) neighbour of the 26 around them: [i, j, k, …], made once per shape. */
function surfaceOf(s: Shape): Int32Array {
  if (s.surface) return s.surface;
  const { nx, ny, nz, solid } = s.v;
  // interior = the 3 × 3 × 3 block around the voxel is all solid (three separable passes)
  const pass = (src: Uint8Array, stride: number, n: number, at: (o: number) => number) => {
    const out = new Uint8Array(src.length);
    for (let o = 0; o < src.length; o++) {
      if (!src[o]) continue;
      const i = at(o);
      if (i > 0 && i < n - 1 && src[o - stride] && src[o + stride]) out[o] = 1;
    }
    return out;
  };
  let full = pass(solid, 1, nx, (o) => o % nx);
  full = pass(full, nx, ny, (o) => ((o / nx) | 0) % ny);
  full = pass(full, nx * ny, nz, (o) => (o / (nx * ny)) | 0);
  const out: number[] = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const o = i + nx * (j + ny * k);
        if (solid[o] && !full[o]) out.push(i, j, k);
      }
  return (s.surface = Int32Array.from(out));
}

type Keep = ReturnType<typeof dilate>;

/** The keep-out grid turned with its part (the clearance is the same in every direction). */
function turnKeep(k: Keep): Keep {
  return { nx: k.ny, ny: k.nx, nz: k.nz, pad: k.pad, cells: turnCells(k.cells, k.nx, k.ny, k.nz) };
}

function makeShape(v: PartVoxels, keep: Keep): Shape {
  const d = keep.pad;
  const kr = rowRuns(keep.cells, keep.nx, keep.ny, keep.nz);
  for (let q = 0; q < kr.length; q += 4) {
    kr[q] -= d;
    kr[q + 1] -= d;
    kr[q + 2] -= d;
  }
  const { nx, ny, nz, solid } = v;
  const colLo = new Int16Array(nx * ny).fill(-1),
    colHi = new Int16Array(nx * ny).fill(-1);
  const rowLo = new Int16Array(ny * nz).fill(-1),
    rowHi = new Int16Array(ny * nz).fill(-1);
  const depLo = new Int16Array(nx * nz).fill(-1),
    depHi = new Int16Array(nx * nz).fill(-1);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (!solid[i + nx * (j + ny * k)]) continue;
        const c = i + nx * j,
          r = j + ny * k,
          dp = i + nx * k;
        if (colLo[c] < 0) colLo[c] = k;
        colHi[c] = k;
        if (rowLo[r] < 0) rowLo[r] = i;
        rowHi[r] = i;
        if (depLo[dp] < 0) depLo[dp] = j;
        depHi[dp] = j;
      }
  // longest run per row, the longest rows first
  const r = v.runs;
  const longest = new Map<number, [number, number, number]>();
  for (let q = 0; q < r.length; q += 4) {
    const row = r[q] + ny * r[q + 1];
    const cur = longest.get(row);
    if (!cur || r[q + 3] > cur[2]) longest.set(row, [r[q], r[q + 1], r[q + 3]]);
  }
  const keyRows = Int32Array.from(
    [...longest.values()]
      .sort((a, b) => b[2] - a[2])
      .slice(0, 8)
      .flat(),
  );
  // golden-ratio stride through the runs
  const m = r.length / 4;
  const order = new Int32Array(m);
  let stride = Math.max(1, Math.round(m * 0.618));
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  while (m > 1 && gcd(stride, m) !== 1) stride++;
  for (let i = 0; i < m; i++) order[i] = ((i * stride) % m) * 4;
  const nonEmpty = (a: Int16Array) => {
    const out: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] >= 0) out.push(i);
    return Int32Array.from(out);
  };
  return { v, keepRuns: kr, colLo, colHi, rowLo, rowHi, depLo, depHi, keyRows, order, cols: nonEmpty(colLo), rows: nonEmpty(rowLo), deps: nonEmpty(depLo) };
}

// ---------------------------------------------------------------- tilted ways out

/**
 * Tilted ways out, besides ±X, ±Y, ±Z: straight lines leaning 45° or about
 * 27° from vertical towards ±X or ±Y (parts are tilted about one axis and
 * turned in quarter turns, so their cups open that way), up and down; per
 * step in Z the line moves (a, b) voxels in X, Y. A part in a tilted cup or
 * tray comes out along the cup's axis.
 */
export const TILTED_DIRS: { a: number; b: number; up: boolean }[] = (() => {
  const out: { a: number; b: number; up: boolean }[] = [];
  for (const m of [1, 0.5])
    for (const [a, b] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      for (const up of [true, false]) out.push({ a: a * m, b: b * m, up });
  return out;
})();
/** hint slots for the way-out check: 6 axis directions + the tilted ones */
const ESC_SLOTS = 6 + TILTED_DIRS.length;

/** floor(a · z) for a ∈ {−1, −½, 0, ½, 1} (digital line offsets) */
export function shearOf(a: number, z: number): number {
  return a === 1 ? z : a === -1 ? -z : a === 0.5 ? z >> 1 : a === -0.5 ? -((z + 1) >> 1) : 0;
}

// ---------------------------------------------------------------- bit grid

const ctz = (x: number) => 31 - Math.clz32(x & -x);

class BitGrid {
  readonly words: number;
  readonly bits: Uint32Array;
  constructor(
    readonly gx: number,
    readonly gy: number,
    readonly gz: number,
  ) {
    this.words = (gx + 31) >> 5;
    this.bits = new Uint32Array(this.words * gy * gz);
  }
  base(j: number, k: number) {
    return (j + this.gy * k) * this.words;
  }
  get(i: number, j: number, k: number) {
    return (this.bits[this.base(j, k) + (i >> 5)] >>> (i & 31)) & 1;
  }
  /** first set bit at index >= from in row (j, k), or gx */
  nextSet(j: number, k: number, from: number): number {
    if (from >= this.gx) return this.gx;
    const b = this.base(j, k);
    let w = from >> 5;
    let x = this.bits[b + w] & (~0 << (from & 31));
    while (!x) {
      if (++w >= this.words) return this.gx;
      x = this.bits[b + w];
    }
    return Math.min(this.gx, (w << 5) + ctz(x));
  }
  /** first clear bit at index >= from in row (j, k), or gx */
  nextClear(j: number, k: number, from: number): number {
    if (from >= this.gx) return this.gx;
    const b = this.base(j, k);
    let w = from >> 5;
    let x = ~this.bits[b + w] & (~0 << (from & 31));
    while (!x) {
      if (++w >= this.words) return this.gx;
      x = ~this.bits[b + w];
    }
    return Math.min(this.gx, (w << 5) + ctz(x));
  }
  /** longest run of clear bits in row (j, k) */
  longestClear(j: number, k: number): number {
    let best = 0;
    for (let x = this.nextClear(j, k, 0); x < this.gx; ) {
      const e = this.nextSet(j, k, x);
      if (e - x > best) best = e - x;
      x = this.nextClear(j, k, e);
    }
    return best;
  }
  setRange(j: number, k: number, x0: number, len: number) {
    const b = this.base(j, k);
    let x = Math.max(0, x0);
    const end = Math.min(this.gx, x0 + len);
    while (x < end) {
      const w = x >> 5,
        off = x & 31;
      const n = Math.min(32 - off, end - x);
      const mask = n === 32 ? ~0 : ((1 << n) - 1) << off;
      this.bits[b + w] |= mask;
      x += n;
    }
  }
}

// ---------------------------------------------------------------- build grid

class Build {
  readonly keep: BitGrid;
  readonly raw: BitGrid;
  readonly placements: NestPlacement[] = [];
  top = 0;
  /** per part + turn: lex index where the free search continues */
  readonly resume = new Map<string, number>();
  /** per part: regular pattern of its copies */
  readonly patterns = new Map<
    string,
    {
      turn: number;
      at: [number, number, number];
      step: [number, number, number];
      slot: [number, number, number];
    }
  >();
  /** longest free (not kept-out) run per row (j, k) */
  readonly freeRun: Uint16Array;
  /** extremes of the placed parts' voxels: per column (i, j) in Z, per (i, k) in Y, per row (j, k) in X */
  readonly zHi: Int16Array;
  readonly zLo: Int16Array;
  readonly yHi: Int16Array;
  readonly yLo: Int16Array;
  readonly xHi: Int16Array;
  readonly xLo: Int16Array;
  private readonly touched: Uint32Array;
  private stampNo = 0;
  /** tilted ways out allowed */
  tilted = true;
  /**
   * Per tilted direction (made when first needed): highest (up) / lowest
   * (down) placed voxel z per sheared column (x − ⌊a·z⌋, y − ⌊b·z⌋), so a
   * tilted way out is checked per column like the straight ones.
   */
  private readonly tiltMaps: ({ m: Int16Array; W: number; ox: number; oy: number } | null)[] = TILTED_DIRS.map(() => null);

  private tiltMap(d: number) {
    const have = this.tiltMaps[d];
    if (have) return have;
    const { gx, gy, gz, raw } = this;
    const { a, b, up } = TILTED_DIRS[d];
    const ox = Math.ceil(Math.abs(a) * gz) + 1,
      oy = Math.ceil(Math.abs(b) * gz) + 1;
    const W = gx + 2 * ox;
    const m = new Int16Array(W * (gy + 2 * oy)).fill(up ? -1 : 32767);
    // everything placed so far
    for (let k = 0; k < gz; k++)
      for (let j = 0; j < gy; j++) {
        const base = ox - shearOf(a, k) + W * (j - shearOf(b, k) + oy);
        for (let x = raw.nextSet(j, k, 0); x < gx; x = raw.nextSet(j, k, x + 1)) if (up ? k > m[x + base] : k < m[x + base]) m[x + base] = k;
      }
    return (this.tiltMaps[d] = { m, W, ox, oy });
  }
  constructor(
    readonly gx: number,
    readonly gy: number,
    readonly gz: number,
  ) {
    this.keep = new BitGrid(gx, gy, gz);
    this.raw = new BitGrid(gx, gy, gz);
    this.freeRun = new Uint16Array(gy * gz).fill(gx);
    this.zHi = new Int16Array(gx * gy).fill(-1);
    this.zLo = new Int16Array(gx * gy).fill(gz);
    this.yHi = new Int16Array(gx * gz).fill(-1);
    this.yLo = new Int16Array(gx * gz).fill(gy);
    this.xHi = new Int16Array(gy * gz).fill(-1);
    this.xLo = new Int16Array(gy * gz).fill(gx);
    this.touched = new Uint32Array(gy * gz);
  }

  /**
   * -1 when the shape fits at X,Y,Z; otherwise how far X can skip. Runs are
   * tested in a spread-out order (neighbouring rows usually agree), the ones
   * that failed recently first (`hint`, move to front).
   */
  fits(s: Shape, X: number, Y: number, Z: number, hint: Int32Array, from = 0, to = s.order.length): number {
    const r = s.v.runs;
    const order = s.order;
    const nh = from ? 0 : hint.length;
    for (let t = from - nh; t < to; t++) {
      const q = t < from ? hint[t - from + nh] : order[t];
      if (q < 0) continue;
      const x0 = X + r[q + 2];
      const j = Y + r[q],
        k = Z + r[q + 1],
        len = r[q + 3];
      const occ = this.keep.nextSet(j, k, x0);
      if (occ < x0 + len) {
        if (t >= from || t > from - nh) {
          // move to front
          let p = nh - 1;
          for (let i = 0; i < nh; i++)
            if (hint[i] === q) {
              p = i;
              break;
            }
          for (let i = p; i > 0; i--) hint[i] = hint[i - 1];
          hint[0] = q;
        }
        // jump to the next free gap of the row that is long enough for this run
        let a = occ;
        for (;;) {
          const e = this.keep.nextClear(j, k, a);
          if (e >= this.keep.gx) return this.keep.gx;
          const f = this.keep.nextSet(j, k, e);
          if (f - e >= len) return e - x0;
          a = f;
        }
      }
    }
    return -1;
  }

  /** Is direction d (0 up, 1 +X, 2 −X, 3 +Y, 4 −Y, 5 down) blocked for the q-th column / row of the shape at X,Y,Z? */
  private blockedAt(s: Shape, d: number, q: number, X: number, Y: number, Z: number): boolean {
    const { nx, ny } = s.v;
    if (d === 0 || d === 5) {
      const c = s.cols[q],
        i = c % nx,
        j = (c / nx) | 0;
      const g = X + i + this.gx * (Y + j);
      return d === 0 ? this.zHi[g] > Z + s.colLo[c] : this.zLo[g] < Z + s.colHi[c];
    }
    if (d < 3) {
      const r = s.rows[q],
        j = r % ny,
        k = (r / ny) | 0;
      const g = Y + j + this.gy * (Z + k);
      return d === 1 ? this.xHi[g] > X + s.rowLo[r] : this.xLo[g] < X + s.rowHi[r];
    }
    const e = s.deps[q],
      i = e % nx,
      k = (e / nx) | 0;
    const g = X + i + this.gx * (Z + k);
    return d === 3 ? this.yHi[g] > Y + s.depLo[e] : this.yLo[g] < Y + s.depHi[e];
  }

  /**
   * Can the shape, placed at X,Y,Z, slide straight out of the build past the
   * parts already placed (up first: parts are placed lowest first)? `hint`
   * holds, per direction, the column / row that blocked last time; it is
   * tested first.
   */
  escapes(s: Shape, X: number, Y: number, Z: number, hint: Int32Array = new Int32Array(ESC_SLOTS)): boolean {
    for (let d = 0; d < 6; d++) {
      const n = d === 0 || d === 5 ? s.cols.length : d < 3 ? s.rows.length : s.deps.length;
      const h0 = hint[d] < n ? hint[d] : 0;
      if (n && this.blockedAt(s, d, h0, X, Y, Z)) continue;
      let free = true;
      for (let q = 0; q < n; q++)
        if (q !== h0 && this.blockedAt(s, d, q, X, Y, Z)) {
          hint[d] = q;
          free = false;
          break;
        }
      if (free) return true;
    }
    // tilted lines (cups and trays that lean open along their axis)
    if (!this.tilted) return false;
    for (let d = 0; d < TILTED_DIRS.length; d++) {
      const { a, b, up } = TILTED_DIRS[d];
      const prof = tiltProfile(s, d, Z & 1);
      const n = prof.length / 3;
      const { m, W, ox, oy } = this.tiltMap(d);
      const base = X - shearOf(a, Z) + ox + W * (Y - shearOf(b, Z) + oy);
      // start at the column that blocked last time (move on from there, wrapping round)
      const slot = 6 + d;
      const h0 = hint[slot] < n ? hint[slot] : 0;
      const sgn = up ? 1 : -1;
      let free = true;
      for (let t = 0; t < n; t++) {
        let q = h0 + t;
        if (q >= n) q -= n;
        const o = q * 3;
        if (sgn * (m[base + prof[o] + W * prof[o + 1]] - Z - prof[o + 2]) > 0) {
          hint[slot] = q;
          free = false;
          break;
        }
      }
      if (free) return true;
    }
    return false;
  }

  /** Lowest spot (Z, then Y, then X) from lex index `from` on where the shape fits (and can slide out). */
  find(s: Shape, interlockFree: boolean, from = 0): { pos: [number, number, number]; lex: number } | null {
    const { gx, gy, gz } = this;
    const { nx, ny, nz } = s.v;
    if (nx > gx || ny > gy || nz > gz) return null;
    const hint = new Int32Array(6).fill(-1);
    const escHint = new Int32Array(ESC_SLOTS);
    let Z = Math.floor(from / (gx * gy)),
      Y = Math.floor(from / gx) % gy,
      X = from % gx;
    for (; Z + nz <= gz; Z++, Y = 0)
      for (; Y + ny <= gy; Y++, X = 0) {
        // a row of the build without a free run as long as one of the part's rows cannot take it anywhere
        let hopeless = false;
        const kr = s.keyRows;
        for (let q = 0; q < kr.length; q += 3)
          if (this.freeRun[Y + kr[q] + gy * (Z + kr[q + 1])] < kr[q + 2]) {
            hopeless = true;
            break;
          }
        if (hopeless) continue;
        const split = Math.min(s.order.length, 48);
        while (X + nx <= gx) {
          // a few runs first, then the (cheaper than all runs) way-out check, then the remaining runs
          let skip = this.fits(s, X, Y, Z, hint, 0, split);
          if (skip > 0) {
            X += skip;
            continue;
          }
          if (interlockFree && !this.escapes(s, X, Y, Z, escHint)) {
            X++;
            continue;
          }
          skip = this.fits(s, X, Y, Z, hint, split);
          if (skip > 0) {
            X += skip;
            continue;
          }
          return { pos: [X, Y, Z], lex: X + gx * (Y + gy * Z) };
        }
      }
    return null;
  }

  /** First spot (lowest first) with the given indices on the fixed axes (null = free) where the shape fits and can slide out. */
  findFixed(s: Shape, interlockFree: boolean, fixed: [number | null, number | null, number | null]): [number, number, number] | null {
    const { gx, gy, gz } = this;
    const { nx, ny, nz } = s.v;
    const range = (f: number | null, n: number, g: number): [number, number] => (f === null ? [0, g - n] : [f, f]);
    const [x0, x1] = range(fixed[0], nx, gx),
      [y0, y1] = range(fixed[1], ny, gy),
      [z0, z1] = range(fixed[2], nz, gz);
    if (x0 < 0 || y0 < 0 || z0 < 0 || x1 + nx > gx || y1 + ny > gy || z1 + nz > gz) return null;
    const hint = new Int32Array(6).fill(-1);
    const escHint = new Int32Array(ESC_SLOTS);
    for (let Z = z0; Z <= z1; Z++)
      for (let Y = y0; Y <= y1; Y++)
        for (let X = x0; X <= x1; ) {
          const skip = this.fits(s, X, Y, Z, hint);
          if (skip < 0 && (!interlockFree || this.escapes(s, X, Y, Z, escHint))) return [X, Y, Z];
          X += skip > 0 ? skip : 1;
        }
    return null;
  }

  stamp(s: Shape, X: number, Y: number, Z: number) {
    const { gx, gy, gz } = this;
    const r = s.v.runs;
    for (let q = 0; q < r.length; q += 4) {
      const j = Y + r[q],
        k = Z + r[q + 1],
        x0 = X + r[q + 2],
        x1 = x0 + r[q + 3] - 1;
      this.raw.setRange(j, k, x0, r[q + 3]);
      const row = j + gy * k;
      if (x1 > this.xHi[row]) this.xHi[row] = x1;
      if (x0 < this.xLo[row]) this.xLo[row] = x0;
    }
    // the extremes along any line (columns, depth lines, tilted lines) are surface voxels: no need to visit the inside
    const sv = surfaceOf(s);
    const maps = TILTED_DIRS.map((t, d) => ({ ...t, map: this.tiltMaps[d] })).filter((t) => t.map);
    for (let q = 0; q < sv.length; q += 3) {
      const x = X + sv[q],
        j = Y + sv[q + 1],
        k = Z + sv[q + 2];
      const c = x + gx * j,
        e = x + gx * k;
      if (k > this.zHi[c]) this.zHi[c] = k;
      if (k < this.zLo[c]) this.zLo[c] = k;
      if (j > this.yHi[e]) this.yHi[e] = j;
      if (j < this.yLo[e]) this.yLo[e] = j;
      for (const { a, b, up, map } of maps) {
        const i = x - shearOf(a, k) + map!.ox + map!.W * (j - shearOf(b, k) + map!.oy);
        if (up ? k > map!.m[i] : k < map!.m[i]) map!.m[i] = k;
      }
    }
    const kr = s.keepRuns;
    const no = ++this.stampNo;
    for (let q = 0; q < kr.length; q += 4) {
      const j = Y + kr[q],
        k = Z + kr[q + 1];
      if (j < 0 || j >= gy || k < 0 || k >= gz) continue;
      this.keep.setRange(j, k, X + kr[q + 2], kr[q + 3]);
      this.touched[j + gy * k] = no;
    }
    // longest free runs of the rows that changed
    for (let q = 0; q < kr.length; q += 4) {
      const j = Y + kr[q],
        k = Z + kr[q + 1];
      if (j < 0 || j >= gy || k < 0 || k >= gz || this.touched[j + gy * k] !== no) continue;
      this.touched[j + gy * k] = 0;
      this.freeRun[j + gy * k] = this.keep.longestClear(j, k);
    }
    this.top = Math.max(this.top, Z + s.v.nz);
  }
}

/**
 * Smallest step along an axis at which a copy of the shape clears the first
 * one (by the clearance): every pair of a solid run and a keep-out run rules
 * out the steps at which they would overlap.
 */
function patternStep(s: Shape, axis: 0 | 1 | 2): number {
  const r = s.v.runs,
    kr = s.keepRuns;
  const n = [s.v.nx, s.v.ny, s.v.nz][axis];
  const maxS = n + 2 * (Math.max(...[s.v.nx, s.v.ny, s.v.nz]) + 2);
  const bad = new Uint8Array(maxS + 1);
  const forbid = (lo: number, hi: number) => {
    for (let t = Math.max(1, lo); t <= Math.min(maxS, hi); t++) bad[t] = 1;
  };
  // group runs: along X by row (j, k); along Y by plane k; along Z by plane j
  const group = (runs: Int32Array) => {
    const m = new Map<number, number[]>();
    for (let q = 0; q < runs.length; q += 4) {
      const key = axis === 0 ? runs[q] * 100003 + runs[q + 1] : axis === 1 ? runs[q + 1] : runs[q];
      let l = m.get(key);
      if (!l) m.set(key, (l = []));
      l.push(q);
    }
    return m;
  };
  const gs = group(r),
    gk = group(kr);
  for (const [key, sl] of gs) {
    const kl = gk.get(key);
    if (!kl) continue;
    for (const a of sl)
      for (const b of kl) {
        const a0 = r[a + 2],
          al = r[a + 3],
          b0 = kr[b + 2],
          bl = kr[b + 3];
        if (axis === 0) forbid(b0 - a0 - al + 1, b0 + bl - a0 - 1);
        else if (a0 < b0 + bl && b0 < a0 + al) {
          // overlapping in x: the step that brings the solid row onto the keep-out row
          const t = axis === 1 ? kr[b] - r[a] : kr[b + 1] - r[a + 1];
          if (t >= 1 && t <= maxS) bad[t] = 1;
        }
      }
  }
  for (let t = 1; t <= maxS; t++) if (!bad[t]) return t;
  return maxS + 1;
}

// ---------------------------------------------------------------- nesting

/**
 * Voxel size: as fine as the budget allows, rounded so the clearance is a
 * whole number of voxels (then the clearance is met exactly).
 */
export function chooseNestVoxel(p: Pick<NestParams, 'volume' | 'margin' | 'zOffset' | 'maxHeight' | 'budget' | 'clearance'>): number {
  const [X, Y, Z] = p.volume;
  const H = (p.maxHeight > 0 ? Math.min(p.maxHeight, Z) : Z) - p.zOffset;
  const vol = Math.max(1, (X - 2 * p.margin) * (Y - 2 * p.margin) * Math.max(1, H));
  const hb = Math.max(0.2, Math.cbrt(vol / (p.budget ?? 40e6)));
  const c = Math.max(0.1, p.clearance);
  // a whole number of voxels across the clearance, never finer than the budget allows
  if (hb <= c) return c / Math.max(1, Math.floor(c / hb + 1e-9));
  return hb;
}

/** One phase of a nesting plan: a voxel budget and the variants tried at it. */
export interface NestPhase {
  budget: number;
  variants: NestVariant[];
  /** instead of `variants`: retry the n best variants of the phases before, at this budget */
  refine?: number;
}

/**
 * What to run for a nesting detail level, phase after phase (every variant
 * is its own job). Fine first runs everything Normal does, then retries
 * only the best of those orders on the finer grid, so it is never less
 * dense than Normal and its time stays bounded.
 */
export function nestPlan(detail: 'fast' | 'normal' | 'fine', symmetric: boolean): NestPhase[] {
  const v = (order: NestOrder, pattern = false): NestVariant => ({ order, pattern });
  const pat = (order: NestOrder) => (symmetric ? [v(order, true)] : []);
  // 'open' puts cups, trays and U shapes first so other parts can go inside them
  if (detail === 'fast') return [{ budget: 40e6, variants: [v('volume'), v('open'), ...pat('volume')] }];
  // Normal: a grid as fine as about 100 million voxels allows (lined up with the clearance), several orders
  const normal = { budget: 100e6, variants: [v('volume'), v('open'), ...pat('volume'), ...pat('open'), v('height'), v('box')] };
  if (detail === 'normal') return [normal];
  // Fine: Normal, then the two best orders again on a finer grid (where the clearance divides into smaller voxels)
  return [normal, { budget: 320e6, variants: [], refine: 2 }];
}

/** Compare two nests by density: < 0 when `a` is better (fewer parts left out, fewer builds, lower last build), 0 when equal. */
function compareNests(a: { unplaced: number; tops: number[] }, b: { unplaced: number; tops: number[] }): number {
  if (a.unplaced !== b.unplaced) return a.unplaced - b.unplaced;
  if (a.tops.length !== b.tops.length) return a.tops.length - b.tops.length;
  if (!a.tops.length) return 0;
  return a.tops[a.tops.length - 1] - b.tops[b.tops.length - 1];
}

/** Order nests by density: < 0 when `a` is denser (fewer parts left out, fewer builds, lower last build). */
export function compareNestResults(a: NestResult, b: NestResult): number {
  const key = (r: NestResult) => ({ unplaced: r.unplaced.length, tops: r.builds.map((x) => Math.round(x.height * 1000)) });
  return compareNests(key(a), key(b));
}

/** The densest of several nests of the same parts (a pattern one wins a tie). */
export function pickNest(...results: (NestResult | null | undefined)[]): NestResult | null {
  let best: NestResult | null = null;
  const key = (r: NestResult) => ({ unplaced: r.unplaced.length, tops: r.builds.map((b) => Math.round(b.height * 1000)) });
  for (const r of results) {
    if (!r) continue;
    const c = best ? compareNests(key(r), key(best)) : -1;
    if (c < 0 || (c === 0 && r.variant?.pattern && !best!.variant?.pattern)) best = r;
  }
  return best;
}

export function nest3d(parts: NestPart[], p: NestParams, onProgress: (f: number, msg: string) => void = () => {}): NestResult {
  const h = p.voxel ?? chooseNestVoxel(p);
  const [VX, VY, VZ] = p.volume;
  const H = (p.maxHeight > 0 ? Math.min(p.maxHeight, VZ) : VZ) - p.zOffset;
  const gx = Math.floor((VX - 2 * p.margin) / h + 1e-9),
    gy = Math.floor((VY - 2 * p.margin) / h + 1e-9),
    gz = Math.floor(H / h + 1e-9);
  const origin: Vec3 = [-VX / 2 + p.margin, -VY / 2 + p.margin, p.zOffset];
  // grow placed parts by the clearance, in voxels (true distance between voxel cubes >= clearance)
  const d = p.clearance / h;
  const interlockFree = p.interlockFree !== false;
  const newBuild = () => {
    const b = new Build(gx, gy, gz);
    b.tilted = p.tilted !== false;
    return b;
  };
  const symmetric = p.symmetric !== false;
  const result: NestResult = { builds: [], unplaced: [], voxel: h };
  if (gx < 1 || gy < 1 || gz < 1) {
    for (const part of parts)
      for (let c = 0; c < part.count; c++)
        result.unplaced.push({
          key: `${part.id}#${c}`,
          reason: 'The margins, platform gap and height leave no room',
        });
    return result;
  }
  // voxelize every part in every allowed turn
  onProgress(0, 'Voxelizing parts');
  const shapes = parts.map((part, pi) => {
    const turns = part.fixed || part.lock || !p.rotations ? [0] : [0, 1, 2, 3];
    // locked copies: voxels lined up with the build grid at the locked translation
    const align = part.lock ? lockAlign(p, part.lock.at) : undefined;
    const sameAlign = (a?: (number | null)[]) => (!a && !align) || (!!a && !!align && a.every((x, i) => (x === null ? align[i] === null : align[i] !== null && Math.abs(x - align[i]!) < 1e-9)));
    // voxelize once; the other turns are the same voxels turned
    let v: PartVoxels = part.voxels && Math.abs(part.voxels.h - h) < 1e-9 && sameAlign(part.voxels.align) ? part.voxels : voxelizePart(part.mesh, h, isWatertight(part.mesh), align);
    let keep = dilate(v, d);
    const vox: { k: number; s: Shape }[] = [];
    for (let k = 0; k < 4; k++) {
      if (turns.includes(k)) vox.push({ k, s: makeShape(v, keep) });
      if (k < 3 && turns.length > 1) {
        v = turnVoxels(v, h);
        keep = turnKeep(keep);
      }
    }
    onProgress(0.2 * ((pi + 1) / parts.length), 'Voxelizing parts');
    const v0 = vox[0].s.v;
    return { part, vox, volume: v0.count, height: v0.nz, box: v0.nx * v0.ny * v0.nz, footprint: v0.nx * v0.ny };
  });
  // copies of a part one after the other, parts in the variant's order
  const sorters: Record<NestOrder, (a: (typeof shapes)[number], b: (typeof shapes)[number]) => number> = {
    volume: (a, b) => b.volume - a.volume || b.height - a.height,
    height: (a, b) => b.height - a.height || b.volume - a.volume,
    box: (a, b) => b.box - a.box || b.volume - a.volume,
    footprint: (a, b) => b.footprint - a.footprint || b.height - a.height,
    open: (a, b) => b.box - b.volume - (a.box - a.volume) || b.volume - a.volume,
  };
  const queueOf = (order: NestOrder) => {
    const q: { sh: (typeof shapes)[number]; copy: number }[] = [];
    for (const sh of [...shapes].sort(sorters[order])) if (!sh.part.lock) for (let c = 0; c < sh.part.count; c++) q.push({ sh, copy: sh.part.copies?.[c] ?? c });
    return q;
  };
  const anyCopies = parts.some((x) => x.count > 1);
  let variants = p.variants ?? [{ order: 'volume' as NestOrder, pattern: false }, ...(symmetric ? [{ order: 'volume' as NestOrder, pattern: true }] : [])];
  // patterns only matter when a part has copies
  if (!anyCopies) variants = variants.filter((v, i) => !v.pattern || i === 0).map((v) => ({ ...v, pattern: false }));
  if (!variants.length) variants = [{ order: 'volume', pattern: false }];
  // every variant stops as soon as it is worse than the best so far
  let win: { builds: Build[]; unplaced: NestResult['unplaced'] } | null = null;
  let winVariant = variants[0];
  const scoreOf = (r: { builds: Build[]; unplaced: unknown[] }) => ({ unplaced: r.unplaced.length, tops: r.builds.map((b) => b.top) });
  variants.forEach((v, i) => {
    const span = 0.8 / variants.length;
    const r = pack(queueOf(v.order), v.pattern, 0.2 + i * span, 0.2 + (i + 1) * span, win ?? undefined);
    if (!r) return;
    const c = win ? compareNests(scoreOf(r), scoreOf(win)) : -1;
    if (c < 0 || (c === 0 && v.pattern && !winVariant.pattern)) {
      win = r;
      winVariant = v;
    }
  });
  result.variant = winVariant;
  if (!win) return result;
  const best: { builds: Build[]; unplaced: NestResult['unplaced'] } = win;
  result.unplaced.push(...best.unplaced);
  for (const b of best.builds) {
    // platform share under parts (projection onto XY)
    let covered = 0;
    for (let j = 0; j < gy; j++)
      for (let i = 0; i < gx; i++) {
        for (let k = 0; k < b.top; k++)
          if (b.raw.get(i, j, k)) {
            covered++;
            break;
          }
      }
    result.builds.push({
      placements: b.placements,
      height: p.zOffset + b.top * h,
      utilization: covered / (gx * gy),
    });
  }
  return result;

  function pack(
    queue: { sh: (typeof shapes)[number]; copy: number }[],
    symmetric: boolean,
    p0: number,
    p1: number,
    limit?: { builds: Build[]; unplaced: unknown[] },
  ): { builds: Build[]; unplaced: NestResult['unplaced'] } | null {
    const builds: Build[] = [];
    const unplaced: NestResult['unplaced'] = [];
    const full = new Map<Build, Set<string>>();
    let done = 0;
    // locked copies first: fully locked ones exactly where they are, then the partly locked ones
    const locked = shapes.filter((x) => x.part.lock).sort((a, b) => a.part.lock!.at.filter((t) => t === null).length - b.part.lock!.at.filter((t) => t === null).length);
    for (const sh of locked) {
      const L = sh.part.lock!;
      const key = `${sh.part.id}#${sh.part.copies?.[0] ?? 0}`;
      const s = sh.vox[0].s;
      const fixed = L.at.map((t, c) => (t === null ? null : Math.round((s.v.min[c] + t - origin[c]) / h))) as [number | null, number | null, number | null];
      while (builds.length <= L.build) builds.push(newBuild());
      const b = builds[L.build];
      let pos: [number, number, number] | null = null;
      if (fixed.every((x) => x !== null)) {
        const [X, Y, Z] = fixed as [number, number, number];
        if (X >= 0 && Y >= 0 && Z >= 0 && X + s.v.nx <= gx && Y + s.v.ny <= gy && Z + s.v.nz <= gz) pos = [X, Y, Z];
        else unplaced.push({ key, reason: 'Its locked position is outside the build volume (margins, platform gap, height)' });
      } else {
        pos = b.findFixed(s, interlockFree, fixed);
        if (!pos) unplaced.push({ key, reason: 'No room for it along its free axes at its locked position' });
      }
      if (!pos) continue;
      b.stamp(s, pos[0], pos[1], pos[2]);
      b.placements.push({
        key,
        partId: sh.part.id,
        copy: sh.part.copies?.[0] ?? 0,
        turns: 0,
        t: [0, 1, 2].map((c) => L.at[c] ?? origin[c] + pos![c] * h - s.v.min[c]) as Vec3,
        locked: true,
      });
    }
    for (const { sh, copy } of queue) {
      const key = `${sh.part.id}#${copy}`;
      if (!sh.vox.some(({ s }) => s.v.nx <= gx && s.v.ny <= gy && s.v.nz <= gz)) {
        const v = sh.vox[0].s.v;
        unplaced.push({
          key,
          reason:
            v.nz > gz
              ? `Too tall: ${(v.nz * h).toFixed(1)} mm, the build allows ${H.toFixed(1)} mm`
              : `Larger than the platform minus margins (${(v.nx * h).toFixed(0)} × ${(v.ny * h).toFixed(0)} mm)`,
        });
        continue;
      }
      const tryBuild = (b: Build): boolean => {
        if (full.get(b)?.has(sh.part.id)) return false;
        // free search: lowest top over the turns (each continues where the last copy stopped)
        let best: {
          k: number;
          pos: [number, number, number];
          s: Shape;
          top: number;
          score: number;
        } | null = null;
        for (const { k, s } of sh.vox) {
          const rk = `${sh.part.id}:${k}`;
          const r = b.find(s, interlockFree, b.resume.get(rk) ?? 0);
          b.resume.set(rk, r ? r.lex : Number.MAX_SAFE_INTEGER);
          if (!r) continue;
          const [X, Y, Z] = r.pos;
          const top = Z + s.v.nz;
          const score = top * 1e12 + Z * 1e8 + Y * 1e4 + X;
          if (!best || score < best.score) best = { k, pos: r.pos, s, top, score };
        }
        // regular pattern of the copies, taken when it packs at least as well
        let pattern = false;
        const pat = symmetric ? b.patterns.get(sh.part.id) : undefined;
        if (pat && best) {
          const s = sh.vox.find((x) => x.k === pat.turn)!.s;
          const slot = pat.slot;
          for (let guard = 0; guard < 100000; guard++) {
            const X = pat.at[0] + slot[0] * pat.step[0],
              Y = pat.at[1] + slot[1] * pat.step[1],
              Z = pat.at[2] + slot[2] * pat.step[2];
            if (Z + s.v.nz > gz) break;
            if (Y + s.v.ny > gy) {
              slot[0] = 0;
              slot[1] = 0;
              slot[2]++;
              continue;
            }
            if (X + s.v.nx > gx) {
              slot[0] = 0;
              slot[1]++;
              continue;
            }
            const top = Z + s.v.nz;
            if (top > Math.max(best.top, b.top)) break; // a pattern spot higher than the free one would lower the density
            if (b.fits(s, X, Y, Z, new Int32Array(6).fill(-1)) < 0 && (!interlockFree || b.escapes(s, X, Y, Z))) {
              best = { k: pat.turn, pos: [X, Y, Z], s, top, score: 0 };
              pattern = true;
              slot[0]++;
              break;
            }
            slot[0]++;
          }
        }
        if (!best) {
          let set = full.get(b);
          if (!set) full.set(b, (set = new Set()));
          set.add(sh.part.id);
          return false;
        }
        const [X, Y, Z] = best.pos;
        b.stamp(best.s, X, Y, Z);
        const v = best.s.v;
        b.placements.push({
          key,
          partId: sh.part.id,
          copy,
          turns: best.k,
          t: [origin[0] + X * h - v.min[0], origin[1] + Y * h - v.min[1], origin[2] + Z * h - v.min[2]],
          pattern,
        });
        // the first copy in this build starts the pattern for the others
        if (symmetric && sh.part.count > 1 && !b.patterns.has(sh.part.id)) {
          const s = best.s;
          b.patterns.set(sh.part.id, {
            turn: best.k,
            at: [X, Y, Z],
            step: [patternStep(s, 0), patternStep(s, 1), patternStep(s, 2)],
            slot: [1, 0, 0],
          });
        }
        return true;
      };
      let placed = false;
      for (const b of builds) if ((placed = tryBuild(b))) break;
      if (!placed) {
        const b = newBuild();
        builds.push(b);
        placed = tryBuild(b);
        if (!placed) {
          builds.pop();
          unplaced.push({
            key,
            reason: 'Does not fit the build volume in any allowed orientation',
          });
        }
      }
      // worse than the limit already: more builds, or the last one taller
      if (limit) {
        const L = limit.builds;
        if (unplaced.length > limit.unplaced.length || builds.length > L.length || (builds.length === L.length && builds[builds.length - 1].top > L[L.length - 1].top)) return null;
      }
      done++;
      if ((done & 3) === 0 || done === queue.length)
        onProgress(p0 + (p1 - p0) * (done / queue.length), `${symmetric ? 'Arranging in patterns' : 'Nesting'} ${done} / ${queue.length} parts`);
    }
    // a build that only existed for a locked copy that could not go in
    return { builds: builds.filter((b) => b.placements.length), unplaced };
  }
}

// ---------------------------------------------------------------- interlock test

/**
 * Can the parts be taken out of the build one after the other, each sliding
 * straight out (±X, ±Y or ±Z) without hitting the parts still in? Returns the
 * keys of parts that stay stuck (interlocked); empty = no interlocking.
 */
export function interlockTest(items: { key: string; mesh: MeshData }[], volume: [number, number, number], voxel?: number): { stuck: string[]; voxel: number } {
  const [VX, VY, VZ] = volume;
  const h = voxel ?? Math.max(0.25, Math.cbrt((VX * VY * VZ) / 8e6));
  const gx = Math.ceil(VX / h) + 2,
    gy = Math.ceil(VY / h) + 2,
    gz = Math.ceil(VZ / h) + 2;
  const origin: Vec3 = [-VX / 2 - h, -VY / 2 - h, -h];
  const label = new Uint16Array(gx * gy * gz);
  const at = (i: number, j: number, k: number) => i + gx * (j + gy * k);
  const vox = items.map((it, n) => {
    const v = voxelizePart(it.mesh, h);
    const X = Math.round((v.min[0] - origin[0]) / h),
      Y = Math.round((v.min[1] - origin[1]) / h),
      Z = Math.round((v.min[2] - origin[2]) / h);
    for (let k = 0; k < v.nz; k++)
      for (let j = 0; j < v.ny; j++)
        for (let i = 0; i < v.nx; i++) {
          if (!v.solid[i + v.nx * (j + v.ny * k)]) continue;
          const gi = X + i,
            gj = Y + j,
            gk = Z + k;
          if (gi < 0 || gj < 0 || gk < 0 || gi >= gx || gj >= gy || gk >= gz) continue;
          label[at(gi, gj, gk)] = n + 1;
        }
    return { v, X, Y, Z };
  });
  const removed = new Uint8Array(items.length + 1);
  const blocks = (own: number, i: number, j: number, k: number) => {
    if (i < 0 || j < 0 || k < 0 || i >= gx || j >= gy || k >= gz) return false;
    const l = label[at(i, j, k)];
    return l !== 0 && l !== own && !removed[l];
  };
  const canEscape = (n: number): boolean => {
    const { v, X, Y, Z } = vox[n];
    const own = n + 1;
    const { nx, ny, nz, solid } = v;
    const s = (i: number, j: number, k: number) => solid[i + nx * (j + ny * k)];
    const dirs: [number, number, number][] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [dx, dy, dz] of dirs) {
      let free = true;
      for (let k = 0; k < nz && free; k++)
        for (let j = 0; j < ny && free; j++)
          for (let i = 0; i < nx && free; i++) {
            if (!s(i, j, k)) continue;
            // walk from this voxel to the edge of the build
            let gi = X + i + dx,
              gj = Y + j + dy,
              gk = Z + k + dz;
            while (gi >= 0 && gj >= 0 && gk >= 0 && gi < gx && gj < gy && gk < gz) {
              if (blocks(own, gi, gj, gk)) {
                free = false;
                break;
              }
              gi += dx;
              gj += dy;
              gk += dz;
            }
          }
      if (free) return true;
    }
    // tilted lines, the same digital lines the nesting uses
    for (const { a, b, up } of TILTED_DIRS) {
      const dz = up ? 1 : -1;
      let free = true;
      for (let k = 0; k < nz && free; k++)
        for (let j = 0; j < ny && free; j++)
          for (let i = 0; i < nx && free; i++) {
            if (!s(i, j, k)) continue;
            const z0 = Z + k;
            for (let gk = z0 + dz; gk >= 0 && gk < gz; gk += dz) {
              const gi = X + i + shearOf(a, gk) - shearOf(a, z0),
                gj = Y + j + shearOf(b, gk) - shearOf(b, z0);
              if (gi < 0 || gj < 0 || gi >= gx || gj >= gy) break;
              if (blocks(own, gi, gj, gk)) {
                free = false;
                break;
              }
            }
          }
      if (free) return true;
    }
    return false;
  };
  const remaining = new Set(items.map((_, n) => n));
  let progress = true;
  while (progress && remaining.size) {
    progress = false;
    for (const n of [...remaining]) {
      if (!canEscape(n)) continue;
      removed[n + 1] = 1;
      remaining.delete(n);
      progress = true;
    }
  }
  return { stuck: [...remaining].map((n) => items[n].key), voxel: h };
}
