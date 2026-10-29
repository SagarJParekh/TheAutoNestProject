/**
 * Dual contouring of a grid's zero level, for surfaces with sharp edges.
 *
 * Every cell the surface passes through gets one vertex, placed where the
 * tangent planes found on the cell's crossed edges meet best (a least-squares
 * fit with small directions dropped, so flat places stay flat and edges and
 * corners come out sharp). Each crossed grid edge becomes a quad joining the
 * vertices of the four cells around it, split into two triangles. Triangles
 * face towards increasing values.
 *
 * `planeAt(x, y, z)` gives the surface's tangent plane near a crossing: unit
 * normal (towards increasing values) and offset d, the plane being n·p = d.
 * Taking the plane from the exact surface (not from the interpolated
 * crossing, which is off wherever the field has a kink) keeps edges exact.
 */
import { FloatBuffer, IndexBuffer, MeshData, ProgressFn, noProgress } from './mesh';
import type { Grid } from './sdf';

export function dualContour(grid: Grid, planeAt: (x: number, y: number, z: number) => [number, number, number, number] | null, onProgress: ProgressFn = noProgress): MeshData {
  const { nx, ny, nz, origin, h, data } = grid;
  const sxy = nx * ny;
  // values exactly zero would put crossings on nodes: nudge them to the negative side
  const tiny = h * 1e-6;
  const val = (n: number) => {
    const v = data[n];
    return v > -tiny && v <= 0 ? -tiny : v > 0 && v < tiny ? tiny : v;
  };
  // crossings on grid edges (point and normal), cached per node layer: edge id = node * 3 + axis
  type Hermite = { x: number; y: number; z: number; nx: number; ny: number; nz: number; d: number } | null;
  const layers = new Map<number, Map<number, Hermite>>();
  const STEP = [1, nx, sxy];
  const hermite = (node: number, axis: number): Hermite => {
    const layer = (node / sxy) | 0;
    let m = layers.get(layer);
    if (!m) layers.set(layer, (m = new Map()));
    const id = node * 3 + axis;
    const got = m.get(id);
    if (got !== undefined) return got;
    const a = val(node), b = val(node + STEP[axis]);
    let out: Hermite = null;
    if (a > 0 !== b > 0) {
      const t = a / (a - b);
      const i = node % nx, j = ((node / nx) | 0) % ny, k = layer;
      const x = origin[0] + (i + (axis === 0 ? t : 0)) * h, y = origin[1] + (j + (axis === 1 ? t : 0)) * h, z = origin[2] + (k + (axis === 2 ? t : 0)) * h;
      let pl = planeAt(x, y, z);
      if (!pl) {
        // fall back on the grid's own gradient along the edge, through the crossing
        const n: [number, number, number] = [0, 0, 0];
        n[axis] = b > a ? 1 : -1;
        pl = [n[0], n[1], n[2], n[0] * x + n[1] * y + n[2] * z];
      }
      out = { x, y, z, nx: pl[0], ny: pl[1], nz: pl[2], d: pl[3] };
    }
    m.set(id, out);
    return out;
  };
  // the 12 edges of a cell as (corner offset, axis)
  const CELL_EDGES: [number, number, number, number][] = [];
  for (let axis = 0; axis < 3; axis++)
    for (let u = 0; u < 2; u++)
      for (let v = 0; v < 2; v++) {
        const off = [0, 0, 0];
        off[(axis + 1) % 3] = u;
        off[(axis + 2) % 3] = v;
        CELL_EDGES.push([off[0], off[1], off[2], axis]);
      }
  const pos = new FloatBuffer(1 << 16);
  const out = new IndexBuffer(1 << 16);
  // vertex of each cell, for two cell layers at a time
  const cellsXY = (nx - 1) * (ny - 1);
  let below = new Int32Array(cellsXY).fill(-1), here = new Int32Array(cellsXY).fill(-1);
  const pts: number[] = [], nrm: number[] = [], off: number[] = [];
  const cellVertex = (i: number, j: number, k: number): number => {
    pts.length = 0;
    nrm.length = 0;
    off.length = 0;
    const n0 = i + nx * (j + ny * k);
    for (const [di, dj, dk, axis] of CELL_EDGES) {
      const e = hermite(n0 + di + dj * nx + dk * sxy, axis);
      if (!e) continue;
      pts.push(e.x, e.y, e.z);
      nrm.push(e.nx, e.ny, e.nz);
      off.push(e.d);
    }
    if (!pts.length) return -1;
    const m = pts.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (let q = 0; q < m; q++) (cx += pts[q * 3]), (cy += pts[q * 3 + 1]), (cz += pts[q * 3 + 2]);
    cx /= m;
    cy /= m;
    cz /= m;
    // least squares Σ (n·p − d)², solved about the centre c in the directions the planes pin down
    const A = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
    const B = [0, 0, 0];
    for (let q = 0; q < m; q++) {
      const a = nrm[q * 3], b = nrm[q * 3 + 1], c = nrm[q * 3 + 2];
      const d = off[q] - (a * cx + b * cy + c * cz);
      A[0] += a * a; A[1] += a * b; A[2] += a * c; A[3] += b * b; A[4] += b * c; A[5] += c * c;
      B[0] += a * d; B[1] += b * d; B[2] += c * d;
    }
    const [dx, dy, dz] = solveTruncated(A, B, 0.1);
    let x = cx + dx, y = cy + dy, z = cz + dz;
    // keep the vertex in (or right next to) its cell
    const lo = [origin[0] + i * h, origin[1] + j * h, origin[2] + k * h];
    const pad = 0.25 * h;
    const clamp = (v: number, l: number) => Math.min(l + h + pad, Math.max(l - pad, v));
    if (x < lo[0] - pad || x > lo[0] + h + pad || y < lo[1] - pad || y > lo[1] + h + pad || z < lo[2] - pad || z > lo[2] + h + pad) {
      x = clamp(x, lo[0]);
      y = clamp(y, lo[1]);
      z = clamp(z, lo[2]);
    }
    return pos.push3(x, y, z);
  };
  const cellAt = (i: number, j: number, layer: Int32Array) => layer[i + (nx - 1) * j];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) [b, d] = [d, b];
    // split along the shorter diagonal
    const P = pos.data;
    const dac = (P[a * 3] - P[c * 3]) ** 2 + (P[a * 3 + 1] - P[c * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[c * 3 + 2]) ** 2;
    const dbd = (P[b * 3] - P[d * 3]) ** 2 + (P[b * 3 + 1] - P[d * 3 + 1]) ** 2 + (P[b * 3 + 2] - P[d * 3 + 2]) ** 2;
    if (dac <= dbd) {
      out.push3(a, b, c);
      out.push3(a, c, d);
    } else {
      out.push3(a, b, d);
      out.push3(b, c, d);
    }
  };
  for (let k = 0; k < nz - 1; k++) {
    // vertices of cell layer k
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const n0 = i + nx * (j + ny * k);
        let pos0 = 0, neg = 0;
        for (let c = 0; c < 8; c++) {
          const v = val(n0 + (c & 1) + ((c >> 1) & 1) * nx + ((c >> 2) & 1) * sxy);
          if (v > 0) pos0++;
          else neg++;
        }
        here[i + (nx - 1) * j] = pos0 && neg ? cellVertex(i, j, k) : -1;
      }
    // quads: x and y edges of node layer k (between cell layers k − 1 and k), z edges from node layer k (cell layer k)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const n = i + nx * (j + ny * k);
        // z edge: cells (i−1..i, j−1..j) of layer k, around +z
        if (i > 0 && j > 0 && i < nx - 1 && j < ny - 1) {
          const a = val(n), b = val(n + sxy);
          if (a > 0 !== b > 0) quad(cellAt(i - 1, j - 1, here), cellAt(i, j - 1, here), cellAt(i, j, here), cellAt(i - 1, j, here), !(b > a));
        }
        if (k === 0 || k >= nz - 1) continue;
        // x edge (i → i+1): cells in y (j−1..j) and z (layers k−1..k), around +x: (y, z) order
        if (i < nx - 1 && j > 0 && j < ny - 1) {
          const a = val(n), b = val(n + 1);
          if (a > 0 !== b > 0) quad(cellAt(i, j - 1, below), cellAt(i, j, below), cellAt(i, j, here), cellAt(i, j - 1, here), !(b > a));
        }
        // y edge (j → j+1): cells in z (layers k−1..k) and x (i−1..i), around +y: (z, x) order
        if (j < ny - 1 && i > 0 && i < nx - 1) {
          const a = val(n), b = val(n + nx);
          if (a > 0 !== b > 0) quad(cellAt(i - 1, j, below), cellAt(i - 1, j, here), cellAt(i, j, here), cellAt(i, j, below), !(b > a));
        }
      }
    // node layers below k are no longer needed
    layers.delete(k - 1);
    [below, here] = [here, below];
    here.fill(-1);
    if ((k & 7) === 0) onProgress(k / nz, 'Extracting surface');
  }
  return { positions: pos.toArray(), indices: out.toArray() };
}

/**
 * Solve the symmetric 3 × 3 system A x = b (A as xx xy xz yy yz zz) in the
 * directions whose eigenvalue is at least `rel` of the largest; the others
 * are left at 0 (the point stays at the centre along them).
 */
function solveTruncated(A: number[], b: number[], rel: number): [number, number, number] {
  // Jacobi eigen decomposition
  const a = [
    [A[0], A[1], A[2]],
    [A[1], A[3], A[4]],
    [A[2], A[4], A[5]],
  ];
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 12; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-20) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq;
        V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const ev = [a[0][0], a[1][1], a[2][2]];
  const max = Math.max(...ev.map(Math.abs));
  const x: [number, number, number] = [0, 0, 0];
  if (!(max > 0)) return x;
  for (let e = 0; e < 3; e++) {
    if (Math.abs(ev[e]) < rel * max) continue;
    // component of b along eigenvector e, divided by its eigenvalue
    const d = (V[0][e] * b[0] + V[1][e] * b[1] + V[2][e] * b[2]) / ev[e];
    for (let k = 0; k < 3; k++) x[k] += V[k][e] * d;
  }
  return x;
}
