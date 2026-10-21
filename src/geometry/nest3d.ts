/**
 * 3D nesting for powder-bed printers (HP MJF / SLS): parts are packed by
 * their actual shape, not their bounding box, anywhere in the build volume
 * (X, Y and Z), including into the open space of other parts (trays, U
 * shapes, corners).
 *
 * Each part is voxelized exactly (every voxel its surface touches, the
 * inside, and cavities closed off from the outside). The voxel size is
 * chosen so the clearance is a whole number of voxels; placed parts are
 * grown by that many voxels ("keep-out"), so the gap between real surfaces
 * is always at least the clearance, without extra slack.
 *
 * Placement is lowest-first (Z, then Y, then X) over four 90° turns. Copies
 * of the same part first try a regular pattern (rows / columns / layers)
 * next to the earlier copies, but a pattern spot is only taken when it packs
 * at least as well as the free search (packing density comes first).
 *
 * No interlocking: a spot is only accepted if the part can slide straight
 * out of the build (±X, ±Y or ±Z) past every part placed before it; then all
 * parts can be taken out in reverse order.
 *
 * Speed: grids are bit sets (1 bit per voxel) scanned 32 voxels at a time;
 * copies of a part continue their search where the previous copy stopped
 * (spots that failed once can never become free again).
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
  /** also nest with the copies of each part in regular patterns, and keep that when it needs no more builds and is no taller (default true) */
  symmetric?: boolean;
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
export function voxelizePart(mesh: MeshData, h: number, closed = isWatertight(mesh)): PartVoxels {
  const p = mesh.positions,
    idx = mesh.indices;
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let c = 0; c < 3; c++) {
      if (p[i + c] < min[c]) min[c] = p[i + c];
      if (p[i + c] > max[c]) max[c] = p[i + c];
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
  for (let t = 0; t < idx.length; t += 3) {
    for (let q = 0; q < 3; q++) {
      v0[q] = p[idx[t] * 3 + q] - min[q];
      v1[q] = p[idx[t + 1] * 3 + q] - min[q];
      v2[q] = p[idx[t + 2] * 3 + q] - min[q];
    }
    const lo = [0, 1, 2].map((q) => Math.max(0, Math.floor(Math.min(v0[q], v1[q], v2[q]) / h - 1e-6)));
    const hi = [0, 1, 2].map((q, qi) => Math.min([nx, ny, nz][qi] - 1, Math.floor(Math.max(v0[q], v1[q], v2[q]) / h + 1e-6)));
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

/** Fill empty voxels that cannot be reached from outside the part's box. */
function fillEnclosed(solid: Uint8Array, nx: number, ny: number, nz: number) {
  const seen = new Uint8Array(solid.length);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!solid[i] && !seen[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push(i + nx * (j + ny * k));
  while (stack.length) {
    const c = stack.pop()!;
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

/** Grow a voxel set by d voxels in every direction (cube). Returns a grid padded by d on each side. */
export function dilate(v: PartVoxels, d: number): { nx: number; ny: number; nz: number; cells: Uint8Array } {
  const nx = v.nx + 2 * d,
    ny = v.ny + 2 * d,
    nz = v.nz + 2 * d;
  let a = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < v.nz; k++) for (let j = 0; j < v.ny; j++) for (let i = 0; i < v.nx; i++) if (v.solid[i + v.nx * (j + v.ny * k)]) a[i + d + nx * (j + d + ny * (k + d))] = 1;
  if (d <= 0) return { nx, ny, nz, cells: a };
  const pass = (stride: number, n: number, lines: (cb: (start: number) => void) => void) => {
    const b = new Uint8Array(a.length);
    lines((start) => {
      // running count of set cells in the window [i - d, i + d]
      let count = 0;
      for (let q = 0; q < Math.min(n, d); q++) count += a[start + q * stride];
      for (let i = 0; i < n; i++) {
        if (i + d < n) count += a[start + (i + d) * stride];
        if (i - d - 1 >= 0) count -= a[start + (i - d - 1) * stride];
        b[start + i * stride] = count > 0 ? 1 : 0;
      }
    });
    a = b;
  };
  pass(1, nx, (cb) => {
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) cb(nx * (j + ny * k));
  });
  pass(nx, ny, (cb) => {
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) cb(i + nx * ny * k);
  });
  pass(nx * ny, nz, (cb) => {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) cb(i + nx * j);
  });
  return { nx, ny, nz, cells: a };
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
}

function makeShape(v: PartVoxels, d: number): Shape {
  const keep = dilate(v, d);
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
  return { v, keepRuns: kr, colLo, colHi, rowLo, rowHi, depLo, depHi };
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
  constructor(
    readonly gx: number,
    readonly gy: number,
    readonly gz: number,
  ) {
    this.keep = new BitGrid(gx, gy, gz);
    this.raw = new BitGrid(gx, gy, gz);
  }

  /** -1 when the shape fits at X,Y,Z; otherwise how far X can skip. `hint` = index of the run that failed last time. */
  fits(s: Shape, X: number, Y: number, Z: number, hint: { r: number }): number {
    const r = s.v.runs;
    const n = r.length;
    for (let t = 0; t < n; t += 4) {
      // try the run that failed last time first
      const q = (hint.r + t) % n;
      const x0 = X + r[q + 2];
      const occ = this.keep.nextSet(Y + r[q], Z + r[q + 1], x0);
      if (occ < x0 + r[q + 3]) {
        hint.r = q;
        return occ - x0 + 1;
      }
    }
    return -1;
  }

  /** Can the shape, placed at X,Y,Z, slide straight out of the build past the parts already placed? */
  escapes(s: Shape, X: number, Y: number, Z: number): boolean {
    const { gx, gy, gz, raw } = this;
    const { nx, ny, nz } = s.v;
    // ±X along rows (whole row from the first solid voxel on, including the part's own holes)
    let px = true,
      mx = true;
    for (let k = 0; k < nz && (px || mx); k++)
      for (let j = 0; j < ny && (px || mx); j++) {
        const lo = s.rowLo[j + ny * k];
        if (lo < 0) continue;
        const hi = s.rowHi[j + ny * k];
        if (px && raw.nextSet(Y + j, Z + k, X + lo + 1) < gx) px = false;
        if (mx) {
          const first = raw.nextSet(Y + j, Z + k, 0);
          if (first <= X + hi - 1) mx = false;
        }
      }
    if (px || mx) return true;
    // ±Z along columns
    let up = true,
      down = true;
    for (let j = 0; j < ny && (up || down); j++)
      for (let i = 0; i < nx && (up || down); i++) {
        const lo = s.colLo[i + nx * j];
        if (lo < 0) continue;
        const hi = s.colHi[i + nx * j];
        if (up) for (let k = Z + lo + 1; k < gz && up; k++) if (raw.get(X + i, Y + j, k)) up = false;
        if (down) for (let k = Z + hi - 1; k >= 0 && down; k--) if (raw.get(X + i, Y + j, k)) down = false;
      }
    if (up || down) return true;
    // ±Y
    let py = true,
      my = true;
    for (let k = 0; k < nz && (py || my); k++)
      for (let i = 0; i < nx && (py || my); i++) {
        const lo = s.depLo[i + nx * k];
        if (lo < 0) continue;
        const hi = s.depHi[i + nx * k];
        if (py) for (let j = Y + lo + 1; j < gy && py; j++) if (raw.get(X + i, j, Z + k)) py = false;
        if (my) for (let j = Y + hi - 1; j >= 0 && my; j--) if (raw.get(X + i, j, Z + k)) my = false;
      }
    return py || my;
  }

  /** Lowest spot (Z, then Y, then X) from lex index `from` on where the shape fits (and can slide out). */
  find(s: Shape, interlockFree: boolean, from = 0): { pos: [number, number, number]; lex: number } | null {
    const { gx, gy, gz } = this;
    const { nx, ny, nz } = s.v;
    if (nx > gx || ny > gy || nz > gz) return null;
    const hint = { r: 0 };
    let Z = Math.floor(from / (gx * gy)),
      Y = Math.floor(from / gx) % gy,
      X = from % gx;
    for (; Z + nz <= gz; Z++, Y = 0)
      for (; Y + ny <= gy; Y++, X = 0) {
        while (X + nx <= gx) {
          const skip = this.fits(s, X, Y, Z, hint);
          if (skip > 0) {
            X += skip;
            continue;
          }
          if (!interlockFree || this.escapes(s, X, Y, Z)) return { pos: [X, Y, Z], lex: X + gx * (Y + gy * Z) };
          X++;
        }
      }
    return null;
  }

  stamp(s: Shape, X: number, Y: number, Z: number) {
    const { gy, gz } = this;
    const r = s.v.runs;
    for (let q = 0; q < r.length; q += 4) this.raw.setRange(Y + r[q], Z + r[q + 1], X + r[q + 2], r[q + 3]);
    const kr = s.keepRuns;
    for (let q = 0; q < kr.length; q += 4) {
      const j = Y + kr[q],
        k = Z + kr[q + 1];
      if (j < 0 || j >= gy || k < 0 || k >= gz) continue;
      this.keep.setRange(j, k, X + kr[q + 2], kr[q + 3]);
    }
    this.top = Math.max(this.top, Z + s.v.nz);
  }
}

/** Smallest step along an axis at which a copy of the shape clears the first one (by the clearance). */
function patternStep(s: Shape, axis: 0 | 1 | 2): number {
  const { nx, ny, nz } = s.v;
  const n = [nx, ny, nz][axis];
  // keep-out of the first copy as a set
  const key = (i: number, j: number, k: number) => `${i},${j},${k}`;
  const keepSet = new Set<string>();
  const kr = s.keepRuns;
  for (let q = 0; q < kr.length; q += 4) for (let x = kr[q + 2]; x < kr[q + 2] + kr[q + 3]; x++) keepSet.add(key(x, kr[q], kr[q + 1]));
  const r = s.v.runs;
  for (let step = 1; step <= n + 64; step++) {
    let clash = false;
    for (let q = 0; q < r.length && !clash; q += 4) {
      const j = r[q] + (axis === 1 ? step : 0),
        k = r[q + 1] + (axis === 2 ? step : 0);
      for (let x = r[q + 2]; x < r[q + 2] + r[q + 3] && !clash; x++) if (keepSet.has(key(x + (axis === 0 ? step : 0), j, k))) clash = true;
    }
    if (!clash) return step;
  }
  return n + 64;
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

export function nest3d(parts: NestPart[], p: NestParams, onProgress: (f: number, msg: string) => void = () => {}): NestResult {
  const h = p.voxel ?? chooseNestVoxel(p);
  const [VX, VY, VZ] = p.volume;
  const H = (p.maxHeight > 0 ? Math.min(p.maxHeight, VZ) : VZ) - p.zOffset;
  const gx = Math.floor((VX - 2 * p.margin) / h + 1e-9),
    gy = Math.floor((VY - 2 * p.margin) / h + 1e-9),
    gz = Math.floor(H / h + 1e-9);
  const origin: Vec3 = [-VX / 2 + p.margin, -VY / 2 + p.margin, p.zOffset];
  // grow placed parts by the clearance (exact surface voxels: gap >= d·h >= clearance)
  const d = Math.max(1, Math.ceil(p.clearance / h - 1e-6));
  const interlockFree = p.interlockFree !== false;
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
    const closed = isWatertight(part.mesh);
    const turns = part.fixed || !p.rotations ? [0] : [0, 1, 2, 3];
    const vox = turns.map((k) => {
      const mesh = k
        ? {
            positions: turnPositions(part.mesh.positions, k),
            indices: part.mesh.indices,
          }
        : part.mesh;
      return { k, s: makeShape(voxelizePart(mesh, h, closed), d) };
    });
    onProgress(0.2 * ((pi + 1) / parts.length), 'Voxelizing parts');
    return { part, vox, volume: vox[0].s.v.count, height: vox[0].s.v.nz };
  });
  // largest parts first, then the tallest; copies of a part one after the other
  const queue: { sh: (typeof shapes)[number]; copy: number }[] = [];
  for (const sh of [...shapes].sort((a, b) => b.volume - a.volume || b.height - a.height)) for (let c = 0; c < sh.part.count; c++) queue.push({ sh, copy: c });
  // the free nest gives the best density; a run with the copies in regular patterns is kept only when it
  // needs no more builds and is no taller (it stops as soon as it is worse)
  const free = pack(false, 0.2, symmetric ? 0.6 : 1)!;
  const sym = symmetric && queue.some((q) => q.sh.part.count > 1) ? pack(true, 0.6, 1, free.builds) : null;
  const win = sym && sym.builds.length <= free.builds.length && sym.builds[sym.builds.length - 1].top <= free.builds[free.builds.length - 1].top ? sym : free;
  result.unplaced.push(...win.unplaced);
  for (const b of win.builds) {
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

  function pack(symmetric: boolean, p0: number, p1: number, limit?: Build[]): { builds: Build[]; unplaced: NestResult['unplaced'] } | null {
    const builds: Build[] = [];
    const unplaced: NestResult['unplaced'] = [];
    const full = new Map<Build, Set<string>>();
    let done = 0;
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
            if (b.fits(s, X, Y, Z, { r: 0 }) < 0 && (!interlockFree || b.escapes(s, X, Y, Z))) {
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
        const b = new Build(gx, gy, gz);
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
      if (limit && (builds.length > limit.length || (builds.length === limit.length && builds[builds.length - 1].top > limit[limit.length - 1].top))) return null;
      done++;
      if ((done & 3) === 0 || done === queue.length)
        onProgress(p0 + (p1 - p0) * (done / queue.length), `${symmetric ? 'Arranging in patterns' : 'Nesting'} ${done} / ${queue.length} parts`);
    }
    return { builds, unplaced };
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
