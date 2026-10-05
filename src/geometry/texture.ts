/**
 * Surface texturing by displacement. The textured region is refined with
 * conforming longest-edge bisection (neighbouring triangles are split on
 * shared edges, so the mesh stays watertight), then vertices are pushed
 * along their normals by a height pattern.
 */
import { MeshData, Vec3, FloatBuffer, IndexBuffer, triangleCount, ProgressFn, noProgress } from './mesh';
import { buildTopology } from './topology';
import { planeBasis } from './triangulate';
import { regionNormal } from './select';
import { smallestEigenvector, fitCircle2D } from './measure3d';

export type TexturePattern = 'knurl' | 'ribs' | 'waffle' | 'dots' | 'hex' | 'noise' | 'image';

export interface Heightmap {
  width: number;
  height: number;
  /** grey values 0..1, row-major, top row first */
  data: Float32Array;
}

export interface TextureParams {
  pattern: TexturePattern;
  /** pattern period (feature size), mm */
  period: number;
  /** displacement depth in mm (positive raises the pattern, negative carves it in) */
  depth: number;
  /** pattern rotation, degrees */
  angle: number;
  /** target edge length after refinement; default period / 6 */
  resolution?: number;
  /**
   * planar: along the region normal; cylindrical: wrapped around the axis of a
   * round region (seamless); triplanar: per-face axis projection (whole parts)
   */
  projection: 'planar' | 'cylindrical' | 'triplanar';
  heightmap?: Heightmap;
  /** invert the height pattern */
  invert?: boolean;
  /** abort if refinement would exceed this many triangles */
  maxTriangles?: number;
}

// ------------------------------------------------------------------ patterns (0..1)

const fract = (x: number) => x - Math.floor(x);
const tri = (x: number) => 1 - Math.abs(2 * fract(x) - 1); // triangle wave 0..1..0

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Height (0..1) of a pattern at plane coordinates (s, t) in mm. */
export function patternHeight(p: TextureParams, s: number, t: number): number {
  const P = Math.max(1e-3, p.period);
  const x = s / P, y = t / P;
  let h: number;
  switch (p.pattern) {
    case 'ribs':
      h = 0.5 + 0.5 * Math.cos(2 * Math.PI * x);
      break;
    case 'knurl': {
      // crossed triangular grooves at ±45° -> raised diamonds
      h = Math.min(tri(x + y), tri(x - y));
      break;
    }
    case 'waffle': {
      const sq = (z: number) => {
        const d = Math.abs(fract(z) - 0.5) * 2; // 0 centre .. 1 edge
        return d < 0.6 ? 1 : d > 0.85 ? 0 : 1 - (d - 0.6) / 0.25;
      };
      h = sq(x) * sq(y);
      break;
    }
    case 'dots': {
      // hex-packed domes
      const row = Math.round(y / 0.8660254);
      const off = row & 1 ? 0.5 : 0;
      let best = Infinity;
      for (let r = row - 1; r <= row + 1; r++) {
        const o = r & 1 ? 0.5 : 0;
        const cx = Math.round(x - o) + o;
        for (let k = -1; k <= 1; k++) best = Math.min(best, Math.hypot(x - (cx + k), y - r * 0.8660254));
      }
      void off;
      const rr = 0.36;
      h = best < rr ? Math.sqrt(1 - (best / rr) ** 2) : 0;
      break;
    }
    case 'hex': {
      // raised hexagonal tiles separated by grooves
      const q = (2 / 3) * x * 1.1547, r = (-1 / 3) * x * 1.1547 + (Math.sqrt(3) / 3) * y * 1.1547;
      let rx = Math.round(q), ry = Math.round(r), rz = Math.round(-q - r);
      const dx = Math.abs(rx - q), dy = Math.abs(ry - r), dz = Math.abs(rz + q + r);
      if (dx > dy && dx > dz) rx = -ry - rz;
      else if (dy > dz) ry = -rx - rz;
      else rz = -rx - ry;
      void rz;
      const fq = q - rx, fr = r - ry;
      const dist = Math.max(Math.abs(fq), Math.abs(fr), Math.abs(fq + fr)); // 0 centre .. 0.5 edge
      h = dist < 0.38 ? 1 : dist > 0.48 ? 0 : 1 - (dist - 0.38) / 0.1;
      break;
    }
    case 'noise': {
      let amp = 0.5, f = 1, sum = 0, norm = 0;
      for (let o = 0; o < 4; o++) {
        sum += valueNoise(x * f, y * f) * amp;
        norm += amp;
        amp *= 0.5;
        f *= 2;
      }
      h = sum / norm;
      break;
    }
    case 'image': {
      const hm = p.heightmap;
      if (!hm) return 0;
      const aspect = hm.height / hm.width;
      const u = fract(x) * (hm.width - 1);
      const v = (1 - fract(y / aspect)) * (hm.height - 1);
      const x0 = Math.floor(u), y0 = Math.floor(v);
      const x1 = Math.min(hm.width - 1, x0 + 1), y1 = Math.min(hm.height - 1, y0 + 1);
      const fu = u - x0, fv = v - y0;
      const g = (xx: number, yy: number) => hm.data[yy * hm.width + xx];
      h = (g(x0, y0) * (1 - fu) + g(x1, y0) * fu) * (1 - fv) + (g(x0, y1) * (1 - fu) + g(x1, y1) * fu) * fv;
      break;
    }
  }
  return p.invert ? 1 - h : h;
}

// ------------------------------------------------------------------ refinement

/**
 * Split edges of region triangles until no region edge is longer than
 * `maxEdge`. Triangles outside the region are split only where they share a
 * split edge, keeping the mesh conforming. Returns the region flag per
 * output triangle.
 */
export function refineRegion(
  mesh: MeshData,
  region: Uint8Array,
  maxEdge: number,
  maxTriangles = 4_000_000,
  onProgress: ProgressFn = noProgress,
): { mesh: MeshData; region: Uint8Array } {
  let cur = mesh;
  let flags = region;
  const max2 = maxEdge * maxEdge;
  for (let pass = 0; pass < 40; pass++) {
    const topo = buildTopology(cur);
    const p = cur.positions, idx = cur.indices;
    const nt = triangleCount(cur);
    const marked = new Uint8Array(topo.edgeCount);
    let any = 0;
    const el2 = (a: number, b: number) => {
      const dx = p[a * 3] - p[b * 3], dy = p[a * 3 + 1] - p[b * 3 + 1], dz = p[a * 3 + 2] - p[b * 3 + 2];
      return dx * dx + dy * dy + dz * dz;
    };
    for (let t = 0; t < nt; t++) {
      if (!flags[t]) continue;
      let best = -1, bl = max2;
      for (let k = 0; k < 3; k++) {
        const l = el2(idx[t * 3 + k], idx[t * 3 + ((k + 1) % 3)]);
        if (l > bl) {
          bl = l;
          best = k;
        }
      }
      if (best >= 0) {
        const e = topo.halfEdgeEdge[t * 3 + best];
        if (!marked[e]) {
          marked[e] = 1;
          any++;
        }
      }
    }
    if (!any) break;
    if (nt + any * 3 > maxTriangles) throw new Error(`Texture would need more than ${maxTriangles.toLocaleString()} triangles; increase the resolution value or texture a smaller area.`);
    const pos = new FloatBuffer(p.length + any * 3);
    pos.data.set(p);
    pos.length = p.length;
    const mid = new Int32Array(topo.edgeCount).fill(-1);
    for (let e = 0; e < topo.edgeCount; e++) {
      if (!marked[e]) continue;
      const a = topo.edgeV0[e], b = topo.edgeV1[e];
      mid[e] = pos.push3((p[a * 3] + p[b * 3]) / 2, (p[a * 3 + 1] + p[b * 3 + 1]) / 2, (p[a * 3 + 2] + p[b * 3 + 2]) / 2);
    }
    const out = new IndexBuffer(idx.length + any * 9);
    const fl: number[] = [];
    const emit = (a: number, b: number, c: number, f: number) => {
      out.push3(a, b, c);
      fl.push(f);
    };
    for (let t = 0; t < nt; t++) {
      const v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
      const m = [0, 1, 2].map((k) => mid[topo.halfEdgeEdge[t * 3 + k]]); // m[k] on edge v[k]->v[k+1]
      const cnt = (m[0] >= 0 ? 1 : 0) + (m[1] >= 0 ? 1 : 0) + (m[2] >= 0 ? 1 : 0);
      const f = flags[t];
      if (cnt === 0) emit(v[0], v[1], v[2], f);
      else if (cnt === 3) {
        emit(v[0], m[0], m[2], f);
        emit(m[0], v[1], m[1], f);
        emit(m[2], m[1], v[2], f);
        emit(m[0], m[1], m[2], f);
      } else if (cnt === 1) {
        const k = m.findIndex((x) => x >= 0);
        const a = v[k], b = v[(k + 1) % 3], c = v[(k + 2) % 3];
        emit(a, m[k], c, f);
        emit(m[k], b, c, f);
      } else {
        // two split edges: rotate so the unsplit edge is v[k+2] -> v[k]
        const k = [0, 1, 2].find((i) => m[i] >= 0 && m[(i + 1) % 3] >= 0)!;
        const a = v[k], b = v[(k + 1) % 3], c = v[(k + 2) % 3];
        const mab = m[k], mbc = m[(k + 1) % 3];
        emit(mab, b, mbc, f);
        emit(a, mab, mbc, f);
        emit(a, mbc, c, f);
      }
    }
    cur = { positions: pos.toArray(), indices: out.toArray() };
    flags = Uint8Array.from(fl);
    onProgress(Math.min(0.9, (pass + 1) / 12), `Refining (${(cur.indices.length / 3).toLocaleString()} triangles)`);
  }
  return { mesh: cur, region: flags };
}

// ------------------------------------------------------------------ displacement

/**
 * Apply a displacement texture to the given triangles (all triangles when
 * `regionTris` is null). Vertices on the region border stay fixed so the
 * texture blends into the untouched surface.
 */
export function textureMesh(mesh: MeshData, regionTris: ArrayLike<number> | null, params: TextureParams, onProgress: ProgressFn = noProgress): MeshData {
  const nt0 = triangleCount(mesh);
  const region0 = new Uint8Array(nt0);
  if (regionTris) for (let i = 0; i < regionTris.length; i++) region0[regionTris[i]] = 1;
  else region0.fill(1);
  const res = params.resolution && params.resolution > 0 ? params.resolution : params.period / 6;
  const { mesh: m, region } = refineRegion(mesh, region0, res, params.maxTriangles ?? 4_000_000, onProgress);
  onProgress(0.92, 'Displacing');
  const p = m.positions.slice(), idx = m.indices;
  const nv = p.length / 3, nt = idx.length / 3;
  // vertex normals (area weighted over all faces) and region membership
  const vn = new Float64Array(nv * 3);
  const inR = new Uint8Array(nv), outR = new Uint8Array(nv);
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      vn[v * 3] += nx;
      vn[v * 3 + 1] += ny;
      vn[v * 3 + 2] += nz;
      if (region[t]) inR[v] = 1;
      else outR[v] = 1;
    }
  }
  // projection frame
  const regionIds: number[] = [];
  for (let t = 0; t < nt; t++) if (region[t]) regionIds.push(t);
  const { normal, centroid } = regionNormal(m, regionIds);
  const basis = planeBasis(normal);
  const ang = (params.angle * Math.PI) / 180, ca = Math.cos(ang), sa = Math.sin(ang);
  const U: Vec3 = [basis.u[0] * ca + basis.v[0] * sa, basis.u[1] * ca + basis.v[1] * sa, basis.u[2] * ca + basis.v[2] * sa];
  const V: Vec3 = [-basis.u[0] * sa + basis.v[0] * ca, -basis.u[1] * sa + basis.v[1] * ca, -basis.u[2] * sa + basis.v[2] * ca];
  const rot = (s: number, t: number): [number, number] => [s * ca - t * sa, s * sa + t * ca];
  // cylindrical frame: axis from the region normals, radius from a circle fit
  let cyl: { axis: Vec3; u: Vec3; v: Vec3; cx: number; cy: number; turns: number } | null = null;
  if (params.projection === 'cylindrical') {
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const used = new Set<number>();
    for (const t of regionIds) {
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
      const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const w = Math.hypot(n[0], n[1], n[2]);
      if (!w) continue;
      for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) cov[r][q] += (n[r] * n[q]) / w;
      used.add(a).add(b).add(c);
    }
    const axis = smallestEigenvector(cov);
    const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let u: Vec3 = [axis[1] * helper[2] - axis[2] * helper[1], axis[2] * helper[0] - axis[0] * helper[2], axis[0] * helper[1] - axis[1] * helper[0]];
    const ul = Math.hypot(u[0], u[1], u[2]);
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    const v: Vec3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
    const pts: number[] = [];
    for (const i of used) pts.push(p[i * 3] * u[0] + p[i * 3 + 1] * u[1] + p[i * 3 + 2] * u[2], p[i * 3] * v[0] + p[i * 3 + 1] * v[1] + p[i * 3 + 2] * v[2]);
    const f = fitCircle2D(pts);
    // a whole number of periods around the circumference makes the wrap seamless
    const turns = Math.max(1, Math.round((2 * Math.PI * f.r) / Math.max(1e-3, params.period)));
    cyl = { axis, u, v, cx: f.x, cy: f.y, turns };
  }
  const out = new Float32Array(p);
  for (let v = 0; v < nv; v++) {
    if (!inR[v] || outR[v]) continue; // border vertices stay put
    let nx = vn[v * 3], ny = vn[v * 3 + 1], nz = vn[v * 3 + 2];
    const l = Math.hypot(nx, ny, nz);
    if (!l) continue;
    nx /= l; ny /= l; nz /= l;
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
    let s: number, t: number;
    if (cyl) {
      const pu = x * cyl.u[0] + y * cyl.u[1] + z * cyl.u[2] - cyl.cx;
      const pv = x * cyl.v[0] + y * cyl.v[1] + z * cyl.v[2] - cyl.cy;
      const theta = Math.atan2(pv, pu);
      // arc coordinate scaled so one turn = `turns` periods
      [s, t] = rot((theta / (2 * Math.PI)) * cyl.turns * params.period, x * cyl.axis[0] + y * cyl.axis[1] + z * cyl.axis[2]);
    } else if (params.projection === 'planar') {
      const dx = x - centroid[0], dy = y - centroid[1], dz = z - centroid[2];
      s = dx * U[0] + dy * U[1] + dz * U[2];
      t = dx * V[0] + dy * V[1] + dz * V[2];
    } else {
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      [s, t] = rot(...((az >= ax && az >= ay ? [x, y] : ax >= ay ? [y, z] : [x, z]) as [number, number]));
    }
    const h = patternHeight(params, s, t) * params.depth;
    out[v * 3] = x + nx * h;
    out[v * 3 + 1] = y + ny * h;
    out[v * 3 + 2] = z + nz * h;
  }
  onProgress(1);
  return { positions: out, indices: idx };
}
