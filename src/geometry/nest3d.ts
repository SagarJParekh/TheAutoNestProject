/**
 * 3D nesting for powder-bed printers (HP MJF / SLS): parts are packed by
 * their actual shape, not their bounding box, anywhere in the build volume
 * (X, Y and Z).
 *
 * Each part is voxelized (surface + inside, enclosed cavities filled). The
 * build keeps two grids: the parts themselves ("raw") and the parts grown by
 * the clearance ("keep-out"). A new part is placed at the lowest free spot
 * (Z, then Y, then X) where none of its voxels touch the keep-out grid, so
 * the clearance between real surfaces is always at least the requested one.
 *
 * No interlocking: a spot is only accepted if the part can slide straight
 * out of the build (along ±X, ±Y or ±Z) past every part placed before it.
 * Then all parts can be taken apart in reverse order, so no two parts are
 * ever hooked into each other.
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
  /** voxel size in mm; default chosen from `budget` */
  voxel?: number;
  /** maximum number of voxels per build grid (default 6 million) */
  budget?: number;
  /** try 90° turns about Z */
  rotations: boolean;
  /** only accept spots from which the part can slide straight out (default true) */
  interlockFree?: boolean;
}

export interface NestPlacement {
  key: string;
  partId: string;
  copy: number;
  /** quarter turns about Z applied to the part's mesh (0..3) */
  turns: number;
  /** translation applied after the turn: world vertex = Rz(turns) · v + t */
  t: Vec3;
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
  /** runs along x: [j, k, x0, len] per row segment, bottom layers first */
  runs: Int32Array;
  /** solid voxel count */
  count: number;
}

/** Turn a mesh by k quarter turns about Z: (x, y) → (−y, x) per turn. */
export function turnPositions(p: Float32Array, k: number): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    let x = p[i], y = p[i + 1];
    for (let t = 0; t < (k & 3); t++) [x, y] = [-y, x];
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = p[i + 2];
  }
  return out;
}

/**
 * Voxels a part occupies: every voxel its surface passes through (dense
 * samples on the triangles), everything inside, and cavities that are closed
 * off from the outside (a part can never be put in there).
 */
export function voxelizePart(mesh: MeshData, h: number, closed = isWatertight(mesh)): PartVoxels {
  const p = mesh.positions, idx = mesh.indices;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let c = 0; c < 3; c++) {
      if (p[i + c] < min[c]) min[c] = p[i + c];
      if (p[i + c] > max[c]) max[c] = p[i + c];
    }
  const nx = Math.max(1, Math.floor((max[0] - min[0]) / h) + 1);
  const ny = Math.max(1, Math.floor((max[1] - min[1]) / h) + 1);
  const nz = Math.max(1, Math.floor((max[2] - min[2]) / h) + 1);
  const solid = new Uint8Array(nx * ny * nz);
  const mark = (x: number, y: number, z: number) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor((x - min[0]) / h)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor((y - min[1]) / h)));
    const k = Math.min(nz - 1, Math.max(0, Math.floor((z - min[2]) / h)));
    solid[i + nx * (j + ny * k)] = 1;
  };
  // surface: samples at most h/3 apart on every triangle
  const step = h / 3;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const lab = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
    const lbc = Math.hypot(p[c] - p[b], p[c + 1] - p[b + 1], p[c + 2] - p[b + 2]);
    const lca = Math.hypot(p[a] - p[c], p[a + 1] - p[c + 1], p[a + 2] - p[c + 2]);
    const n = Math.max(1, Math.ceil(Math.max(lab, lbc, lca) / step));
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        mark(w * p[a] + u * p[b] + v * p[c], w * p[a + 1] + u * p[b + 1] + v * p[c + 1], w * p[a + 2] + u * p[b + 2] + v * p[c + 2]);
      }
  }
  // inside (sampled at voxel centres)
  const inside = voxelizeInsideRobust(mesh, [min[0] + h / 2, min[1] + h / 2, min[2] + h / 2], nx, ny, nz, h, closed);
  for (let i = 0; i < solid.length; i++) if (inside[i]) solid[i] = 1;
  fillEnclosed(solid, nx, ny, nz);
  return { nx, ny, nz, min, solid, runs: rowRuns(solid, nx, ny, nz), count: solid.reduce((s, v) => s + v, 0) };
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
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push(i + nx * (j + ny * k));
  while (stack.length) {
    const c = stack.pop()!;
    const i = c % nx, j = ((c / nx) | 0) % ny, k = (c / (nx * ny)) | 0;
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
  const nx = v.nx + 2 * d, ny = v.ny + 2 * d, nz = v.nz + 2 * d;
  let a = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < v.nz; k++)
    for (let j = 0; j < v.ny; j++)
      for (let i = 0; i < v.nx; i++) if (v.solid[i + v.nx * (j + v.ny * k)]) a[i + d + nx * (j + d + ny * (k + d))] = 1;
  if (d <= 0) return { nx, ny, nz, cells: a };
  const pass = (stride: number, n: number, lines: (cb: (start: number) => void) => void) => {
    const b = new Uint8Array(a.length);
    lines((start) => {
      // max over the 2d+1 cells around each cell along the line (d is small)
      for (let i = 0; i < n; i++) {
        let on = 0;
        for (let q = Math.max(0, i - d); q <= Math.min(n - 1, i + d) && !on; q++) on = a[start + q * stride];
        b[start + i * stride] = on;
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

// ---------------------------------------------------------------- build grid

class BuildGrid {
  readonly keep: Uint8Array;
  readonly raw: Int32Array;
  readonly free: Uint16Array;
  readonly placements: NestPlacement[] = [];
  top = 0;
  constructor(
    readonly gx: number,
    readonly gy: number,
    readonly gz: number,
  ) {
    const n = gx * gy * gz;
    this.keep = new Uint8Array(n);
    this.raw = new Int32Array(n); // 0 = empty, otherwise placement index + 1
    this.free = new Uint16Array(n);
    for (let k = 0; k < gz; k++) for (let j = 0; j < gy; j++) this.recomputeRow(j, k);
  }

  idx(i: number, j: number, k: number) {
    return i + this.gx * (j + this.gy * k);
  }

  recomputeRow(j: number, k: number) {
    const base = this.gx * (j + this.gy * k);
    let run = 0;
    for (let i = this.gx - 1; i >= 0; i--) {
      run = this.keep[base + i] ? 0 : Math.min(65535, run + 1);
      this.free[base + i] = run;
    }
  }

  fits(v: PartVoxels, X: number, Y: number, Z: number): number {
    // returns -1 when it fits, otherwise how far X can skip
    const r = v.runs;
    for (let q = 0; q < r.length; q += 4) {
      const f = this.free[this.idx(X + r[q + 2], Y + r[q], Z + r[q + 1])];
      if (f < r[q + 3]) return f + 1;
    }
    return -1;
  }

  /** Can the part, placed at X,Y,Z, slide straight out of the build past the parts already placed? */
  escapes(v: PartVoxels, X: number, Y: number, Z: number): boolean {
    const { gx, gy, gz, raw } = this;
    const { nx, ny, nz, solid } = v;
    const at = (i: number, j: number, k: number) => solid[i + nx * (j + ny * k)];
    // ±Z
    let up = true, down = true;
    for (let j = 0; j < ny && (up || down); j++)
      for (let i = 0; i < nx && (up || down); i++) {
        let k0 = -1, k1 = -1;
        for (let k = 0; k < nz; k++) if (at(i, j, k)) (k0 < 0 && (k0 = k), (k1 = k));
        if (k0 < 0) continue;
        // everything the part sweeps through, including its own holes (another part may sit in one)
        if (up) for (let k = Z + k0 + 1; k < gz && up; k++) if (raw[this.idx(X + i, Y + j, k)]) up = false;
        if (down) for (let k = Z + k1 - 1; k >= 0 && down; k--) if (raw[this.idx(X + i, Y + j, k)]) down = false;
      }
    if (up || down) return true;
    // ±X
    let px = true, mx = true;
    for (let k = 0; k < nz && (px || mx); k++)
      for (let j = 0; j < ny && (px || mx); j++) {
        let i0 = -1, i1 = -1;
        for (let i = 0; i < nx; i++) if (at(i, j, k)) (i0 < 0 && (i0 = i), (i1 = i));
        if (i0 < 0) continue;
        if (px) for (let i = X + i0 + 1; i < gx && px; i++) if (raw[this.idx(i, Y + j, Z + k)]) px = false;
        if (mx) for (let i = X + i1 - 1; i >= 0 && mx; i--) if (raw[this.idx(i, Y + j, Z + k)]) mx = false;
      }
    if (px || mx) return true;
    // ±Y
    let py = true, my = true;
    for (let k = 0; k < nz && (py || my); k++)
      for (let i = 0; i < nx && (py || my); i++) {
        let j0 = -1, j1 = -1;
        for (let j = 0; j < ny; j++) if (at(i, j, k)) (j0 < 0 && (j0 = j), (j1 = j));
        if (j0 < 0) continue;
        if (py) for (let j = Y + j0 + 1; j < gy && py; j++) if (raw[this.idx(X + i, j, Z + k)]) py = false;
        if (my) for (let j = Y + j1 - 1; j >= 0 && my; j--) if (raw[this.idx(X + i, j, Z + k)]) my = false;
      }
    return py || my;
  }

  /** Lowest spot (Z, then Y, then X) where the part fits (and can slide out). */
  find(v: PartVoxels, interlockFree: boolean): [number, number, number] | null {
    const { gx, gy, gz } = this;
    if (v.nx > gx || v.ny > gy || v.nz > gz) return null;
    for (let Z = 0; Z + v.nz <= gz; Z++)
      for (let Y = 0; Y + v.ny <= gy; Y++) {
        let X = 0;
        while (X + v.nx <= gx) {
          const skip = this.fits(v, X, Y, Z);
          if (skip > 0) {
            X += skip;
            continue;
          }
          if (!interlockFree || this.escapes(v, X, Y, Z)) return [X, Y, Z];
          X++;
        }
      }
    return null;
  }

  stamp(v: PartVoxels, keep: ReturnType<typeof dilate>, d: number, X: number, Y: number, Z: number, label: number) {
    const { gx, gy, gz } = this;
    for (let k = 0; k < v.nz; k++)
      for (let j = 0; j < v.ny; j++)
        for (let i = 0; i < v.nx; i++) if (v.solid[i + v.nx * (j + v.ny * k)]) this.raw[this.idx(X + i, Y + j, Z + k)] = label;
    const rows = new Set<number>();
    for (let k = 0; k < keep.nz; k++) {
      const gk = Z + k - d;
      if (gk < 0 || gk >= gz) continue;
      for (let j = 0; j < keep.ny; j++) {
        const gj = Y + j - d;
        if (gj < 0 || gj >= gy) continue;
        let touched = false;
        for (let i = 0; i < keep.nx; i++) {
          const gi = X + i - d;
          if (gi < 0 || gi >= gx) continue;
          if (keep.cells[i + keep.nx * (j + keep.ny * k)]) {
            this.keep[this.idx(gi, gj, gk)] = 1;
            touched = true;
          }
        }
        if (touched) rows.add(gj + gy * gk);
      }
    }
    for (const r of rows) this.recomputeRow(r % gy, (r / gy) | 0);
  }
}

// ---------------------------------------------------------------- nesting

export function chooseNestVoxel(p: Pick<NestParams, 'volume' | 'margin' | 'zOffset' | 'maxHeight' | 'budget'>): number {
  const [X, Y, Z] = p.volume;
  const H = (p.maxHeight > 0 ? Math.min(p.maxHeight, Z) : Z) - p.zOffset;
  const vol = Math.max(1, (X - 2 * p.margin) * (Y - 2 * p.margin) * Math.max(1, H));
  return Math.max(0.25, Math.cbrt(vol / (p.budget ?? 6e6)));
}

export function nest3d(parts: NestPart[], p: NestParams, onProgress: (f: number, msg: string) => void = () => {}): NestResult {
  const h = p.voxel ?? chooseNestVoxel(p);
  const [VX, VY, VZ] = p.volume;
  const H = (p.maxHeight > 0 ? Math.min(p.maxHeight, VZ) : VZ) - p.zOffset;
  const gx = Math.floor((VX - 2 * p.margin) / h), gy = Math.floor((VY - 2 * p.margin) / h), gz = Math.floor(H / h);
  const origin: Vec3 = [-VX / 2 + p.margin, -VY / 2 + p.margin, p.zOffset];
  // grow placed parts so real surfaces stay at least `clearance` apart (allowing for the surface sampling)
  const d = Math.max(1, Math.ceil((p.clearance + 0.35 * h) / h));
  const interlockFree = p.interlockFree !== false;
  const result: NestResult = { builds: [], unplaced: [], voxel: h };
  if (gx < 1 || gy < 1 || gz < 1) {
    for (const part of parts) for (let c = 0; c < part.count; c++) result.unplaced.push({ key: `${part.id}#${c}`, reason: 'The margins, platform gap and height leave no room' });
    return result;
  }
  // voxelize every part in every allowed turn
  onProgress(0, 'Voxelizing parts');
  const shapes = parts.map((part, pi) => {
    const closed = isWatertight(part.mesh);
    const turns = part.fixed || !p.rotations ? [0] : [0, 1, 2, 3];
    const vox = turns.map((k) => {
      const mesh = k ? { positions: turnPositions(part.mesh.positions, k), indices: part.mesh.indices } : part.mesh;
      const v = voxelizePart(mesh, h, closed);
      return { k, v, keep: dilate(v, d) };
    });
    onProgress(0.25 * ((pi + 1) / parts.length), 'Voxelizing parts');
    return { part, vox, volume: vox[0].v.count, height: vox[0].v.nz };
  });
  // largest parts first, then the tallest
  const queue: { s: (typeof shapes)[number]; copy: number }[] = [];
  for (const s of [...shapes].sort((a, b) => b.volume - a.volume || b.height - a.height))
    for (let c = 0; c < s.part.count; c++) queue.push({ s, copy: c });
  const grids: BuildGrid[] = [];
  const MAX_OPEN = 12;
  let done = 0;
  for (const { s, copy } of queue) {
    const key = `${s.part.id}#${copy}`;
    if (!s.vox.some(({ v }) => v.nx <= gx && v.ny <= gy && v.nz <= gz)) {
      const v = s.vox[0].v;
      result.unplaced.push({
        key,
        reason:
          v.nz > gz
            ? `Too tall: ${(v.nz * h).toFixed(1)} mm, the build allows ${H.toFixed(1)} mm`
            : `Larger than the platform minus margins (${(v.nx * h).toFixed(0)} × ${(v.ny * h).toFixed(0)} mm)`,
      });
      continue;
    }
    let placed = false;
    const tryGrid = (g: BuildGrid, gi: number) => {
      let best: { k: number; pos: [number, number, number]; vox: (typeof s.vox)[number]; score: number } | null = null;
      for (const vx of s.vox) {
        const pos = g.find(vx.v, interlockFree);
        if (!pos) continue;
        // lowest top first, then lowest bottom, then towards the back-left corner
        const score = (pos[2] + vx.v.nz) * 1e9 + pos[2] * 1e6 + pos[1] * 1e3 + pos[0];
        if (!best || score < best.score) best = { k: vx.k, pos, vox: vx, score };
      }
      if (!best) return false;
      const [X, Y, Z] = best.pos;
      g.stamp(best.vox.v, best.vox.keep, d, X, Y, Z, g.placements.length + 1);
      const v = best.vox.v;
      g.placements.push({
        key,
        partId: s.part.id,
        copy,
        turns: best.k,
        t: [origin[0] + X * h - v.min[0], origin[1] + Y * h - v.min[1], origin[2] + Z * h - v.min[2]],
      });
      g.top = Math.max(g.top, Z + v.nz);
      void gi;
      return true;
    };
    for (let gi = Math.max(0, grids.length - MAX_OPEN); gi < grids.length && !placed; gi++) placed = tryGrid(grids[gi], gi);
    if (!placed) {
      const g = new BuildGrid(gx, gy, gz);
      grids.push(g);
      placed = tryGrid(g, grids.length - 1);
      if (!placed) {
        grids.pop();
        result.unplaced.push({ key, reason: 'Does not fit the build volume in any allowed orientation' });
      }
    }
    done++;
    onProgress(0.25 + 0.75 * (done / queue.length), `Nesting ${done} / ${queue.length} parts`);
  }
  for (const g of grids) {
    // platform share under parts (projection onto XY)
    let covered = 0;
    for (let j = 0; j < gy; j++)
      for (let i = 0; i < gx; i++) {
        for (let k = 0; k < g.top; k++)
          if (g.raw[g.idx(i, j, k)]) {
            covered++;
            break;
          }
      }
    result.builds.push({ placements: g.placements, height: p.zOffset + g.top * h, utilization: covered / (gx * gy) });
  }
  return result;
}

// ---------------------------------------------------------------- interlock test

/**
 * Can the parts be taken out of the build one after the other, each sliding
 * straight out (±X, ±Y or ±Z) without hitting the parts still in? Returns the
 * keys of parts that stay stuck (interlocked); empty = no interlocking.
 */
export function interlockTest(
  items: { key: string; mesh: MeshData }[],
  volume: [number, number, number],
  voxel?: number,
): { stuck: string[]; voxel: number } {
  const [VX, VY, VZ] = volume;
  const h = voxel ?? Math.max(0.25, Math.cbrt((VX * VY * VZ) / 8e6));
  const gx = Math.ceil(VX / h) + 2, gy = Math.ceil(VY / h) + 2, gz = Math.ceil(VZ / h) + 2;
  const origin: Vec3 = [-VX / 2 - h, -VY / 2 - h, -h];
  const g = new BuildGrid(gx, gy, gz);
  const vox = items.map((it, n) => {
    const v = voxelizePart(it.mesh, h);
    const X = Math.round((v.min[0] - origin[0]) / h), Y = Math.round((v.min[1] - origin[1]) / h), Z = Math.round((v.min[2] - origin[2]) / h);
    for (let k = 0; k < v.nz; k++)
      for (let j = 0; j < v.ny; j++)
        for (let i = 0; i < v.nx; i++) {
          if (!v.solid[i + v.nx * (j + v.ny * k)]) continue;
          const gi = X + i, gj = Y + j, gk = Z + k;
          if (gi < 0 || gj < 0 || gk < 0 || gi >= gx || gj >= gy || gk >= gz) continue;
          // where two parts share a voxel the later one wins; that contact is reported by the collision check
          g.raw[g.idx(gi, gj, gk)] = n + 1;
        }
    return { v, X, Y, Z };
  });
  const remaining = new Set(items.map((_, n) => n));
  // a part's own voxels must not block it: escape checks look at other labels only
  const blocked = (n: number) => {
    const { v, X, Y, Z } = vox[n];
    const own = n + 1;
    const raw = g.raw;
    const saved: number[] = [];
    // temporarily clear the part itself
    for (let k = 0; k < v.nz; k++)
      for (let j = 0; j < v.ny; j++)
        for (let i = 0; i < v.nx; i++) {
          const gi = X + i, gj = Y + j, gk = Z + k;
          if (gi < 0 || gj < 0 || gk < 0 || gi >= gx || gj >= gy || gk >= gz) continue;
          const c = g.idx(gi, gj, gk);
          if (raw[c] === own) {
            raw[c] = 0;
            saved.push(c);
          }
        }
    const free = g.escapes(v, X, Y, Z);
    for (const c of saved) raw[c] = own;
    return !free;
  };
  let progress = true;
  while (progress && remaining.size) {
    progress = false;
    for (const n of [...remaining]) {
      if (blocked(n)) continue;
      // take it out
      const { v, X, Y, Z } = vox[n];
      for (let k = 0; k < v.nz; k++)
        for (let j = 0; j < v.ny; j++)
          for (let i = 0; i < v.nx; i++) {
            const gi = X + i, gj = Y + j, gk = Z + k;
            if (gi < 0 || gj < 0 || gk < 0 || gi >= gx || gj >= gy || gk >= gz) continue;
            const c = g.idx(gi, gj, gk);
            if (g.raw[c] === n + 1) g.raw[c] = 0;
          }
      remaining.delete(n);
      progress = true;
    }
  }
  return { stuck: [...remaining].map((n) => items[n].key), voxel: h };
}
