import { FloatBuffer, IndexBuffer, MeshData, ProgressFn, noProgress } from './mesh';
import type { Grid } from './sdf';

// Kuhn decomposition of a cube into 6 tetrahedra sharing the 0-7 diagonal.
// Corner c has offset (c&1, (c>>1)&1, (c>>2)&1). Consistent across cubes.
const TETS: number[][] = [];
for (const [a, b] of [
  [0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1],
]) {
  TETS.push([0, 1 << a, (1 << a) | (1 << b), 7]);
}

/**
 * Extract the iso-surface value = 0 of a grid with marching tetrahedra.
 * Triangles face towards increasing values. The result is watertight as long
 * as the surface does not touch the grid border.
 */
export function marchingTetrahedra(grid: Grid, onProgress: ProgressFn = noProgress): MeshData {
  const { nx, ny, nz, origin, h, data } = grid;
  const sxy = nx * ny;
  const pos = new FloatBuffer(1 << 16);
  const out = new IndexBuffer(1 << 16);
  const edgeMap = new Map<number, number>();
  // values that are exactly zero would put vertices on grid nodes and create
  // zero-area triangles; nudge them to the negative side instead
  const tiny = h * 1e-6;
  const val = (n: number) => {
    const v = data[n];
    return v > -tiny && v <= 0 ? -tiny : v > 0 && v < tiny ? tiny : v;
  };
  // float64 shadow copy of vertex positions for robust orientation tests
  const exact: number[] = [];
  const cornerNode = new Int32Array(8);
  const cv = new Float64Array(8);

  const vertexOn = (na: number, nb: number, va: number, vb: number): number => {
    const lo = na < nb ? na : nb;
    const hi = na < nb ? nb : na;
    const key = lo * 8 + nodeDir(hi - lo);
    let id = edgeMap.get(key);
    if (id !== undefined) return id;
    const t = va / (va - vb);
    const ax = na % nx, ay = ((na / nx) | 0) % ny, az = (na / sxy) | 0;
    const bx = nb % nx, by = ((nb / nx) | 0) % ny, bz = (nb / sxy) | 0;
    const gx = ax + (bx - ax) * t, gy = ay + (by - ay) * t, gz = az + (bz - az) * t;
    exact.push(gx, gy, gz);
    id = pos.push3(origin[0] + gx * h, origin[1] + gy * h, origin[2] + gz * h);
    edgeMap.set(key, id);
    return id;
  };
  const nodeDir = (d: number) => {
    // map node index delta to 1..7 corner bitmask
    let bits = 0;
    let r = d;
    if (r >= sxy) { bits |= 4; r -= sxy; }
    if (r >= nx) { bits |= 2; r -= nx; }
    if (r >= 1) bits |= 1;
    return bits;
  };
  const emit = (a: number, b: number, c: number, gx: number, gy: number, gz: number) => {
    // orient so the normal points along the gradient (towards positive values)
    const d = exact;
    const ux = d[b * 3] - d[a * 3], uy = d[b * 3 + 1] - d[a * 3 + 1], uz = d[b * 3 + 2] - d[a * 3 + 2];
    const vx = d[c * 3] - d[a * 3], vy = d[c * 3 + 1] - d[a * 3 + 1], vz = d[c * 3 + 2] - d[a * 3 + 2];
    const nxx = uy * vz - uz * vy, nyy = uz * vx - ux * vz, nzz = ux * vy - uy * vx;
    if (nxx * gx + nyy * gy + nzz * gz >= 0) out.push3(a, b, c);
    else out.push3(a, c, b);
  };
  const cornerPos = (c: number): [number, number, number] => [c & 1, (c >> 1) & 1, (c >> 2) & 1];

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const n0 = i + j * nx + k * sxy;
        let pos0 = 0, neg = 0;
        for (let c = 0; c < 8; c++) {
          const n = n0 + (c & 1) + ((c >> 1) & 1) * nx + ((c >> 2) & 1) * sxy;
          cornerNode[c] = n;
          const v = val(n);
          cv[c] = v;
          if (v > 0) pos0++;
          else neg++;
        }
        if (pos0 === 0 || neg === 0) continue;
        for (const tet of TETS) {
          const P: number[] = [], Nn: number[] = [];
          for (const c of tet) (cv[c] > 0 ? P : Nn).push(c);
          if (P.length === 0 || Nn.length === 0) continue;
          const e = (a: number, b: number) => vertexOn(cornerNode[a], cornerNode[b], cv[a], cv[b]);
          // gradient direction ~ from a negative corner to a positive corner
          const gp = cornerPos(P[0]), gn = cornerPos(Nn[0]);
          const gx = gp[0] - gn[0], gy = gp[1] - gn[1], gz = gp[2] - gn[2];
          if (P.length === 1 || Nn.length === 1) {
            const lone = P.length === 1 ? P[0] : Nn[0];
            const others = P.length === 1 ? Nn : P;
            emit(e(lone, others[0]), e(lone, others[1]), e(lone, others[2]), gx, gy, gz);
          } else {
            const [p1, p2] = P;
            const [m1, m2] = Nn;
            const a = e(p1, m1), b = e(p1, m2), c = e(p2, m2), d = e(p2, m1);
            emit(a, b, c, gx, gy, gz);
            emit(a, c, d, gx, gy, gz);
          }
        }
      }
    }
    if ((k & 7) === 0) onProgress(k / nz, 'Extracting surface');
  }
  return { positions: pos.toArray(), indices: out.toArray() };
}
