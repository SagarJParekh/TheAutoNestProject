/**
 * Mesh simplification by quadric error metric edge collapse (Garland &
 * Heckbert). Collapses keep the surface manifold (link condition), never
 * flip triangles, and keep open borders in place with boundary quadrics.
 */
import { MeshData, compactMesh, ProgressFn, noProgress } from './mesh';
import { buildTopology } from './topology';

/** Min-heap of (cost, a, b, stamp) entries in parallel typed arrays. */
class EdgeHeap {
  cost: Float64Array;
  a: Int32Array;
  b: Int32Array;
  stamp: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.cost = new Float64Array(cap);
    this.a = new Int32Array(cap);
    this.b = new Int32Array(cap);
    this.stamp = new Int32Array(cap);
  }
  private grow() {
    const n = this.cost.length * 2;
    const c = new Float64Array(n); c.set(this.cost); this.cost = c;
    const a = new Int32Array(n); a.set(this.a); this.a = a;
    const b = new Int32Array(n); b.set(this.b); this.b = b;
    const s = new Int32Array(n); s.set(this.stamp); this.stamp = s;
  }
  private swap(i: number, j: number) {
    const c = this.cost[i]; this.cost[i] = this.cost[j]; this.cost[j] = c;
    const a = this.a[i]; this.a[i] = this.a[j]; this.a[j] = a;
    const b = this.b[i]; this.b[i] = this.b[j]; this.b[j] = b;
    const s = this.stamp[i]; this.stamp[i] = this.stamp[j]; this.stamp[j] = s;
  }
  push(cost: number, a: number, b: number, stamp: number) {
    if (this.size >= this.cost.length) this.grow();
    let i = this.size++;
    this.cost[i] = cost; this.a[i] = a; this.b[i] = b; this.stamp[i] = stamp;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p] <= this.cost[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  /** Removes the minimum; its fields are left at index `size` for reading. */
  pop(): boolean {
    if (!this.size) return false;
    this.size--;
    this.swap(0, this.size);
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < this.size && this.cost[l] < this.cost[m]) m = l;
      if (r < this.size && this.cost[r] < this.cost[m]) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return true;
  }
}

export interface SimplifyResult {
  mesh: MeshData;
  trianglesBefore: number;
  trianglesAfter: number;
}

export interface SimplifyOptions {
  /**
   * Largest allowed RMS distance (mm) of a collapsed vertex from the
   * original surface planes around it. Default: 0.5% of the bounding-box
   * diagonal. Sharp shapes stop reducing before they are distorted, so the
   * result can have more triangles than asked for.
   */
  maxDeviation?: number;
}

/**
 * Reduce a mesh to about `ratio` (0..1] of its triangles.
 * `ratio` >= 1 returns the mesh unchanged.
 */
export function simplifyMesh(mesh: MeshData, ratio: number, onProgress: ProgressFn = noProgress, opts: SimplifyOptions = {}): SimplifyResult {
  const idx0 = mesh.indices;
  const nt = idx0.length / 3;
  if (ratio >= 1 || nt < 8) return { mesh, trianglesBefore: nt, trianglesAfter: nt };
  const target = Math.max(4, Math.floor(nt * Math.max(0.01, ratio)));
  const pos = Float64Array.from(mesh.positions);
  const nv = pos.length / 3;
  const tri = Int32Array.from(idx0);
  const alive = new Uint8Array(nt).fill(1);

  // vertex -> incident triangles: lists in one typed pool; a list that outgrows
  // its slot moves to the end of the pool
  const vStart = new Int32Array(nv), vLen = new Int32Array(nv), vCap = new Int32Array(nv);
  for (let i = 0; i < tri.length; i++) vCap[tri[i]]++;
  let poolEnd = 0;
  for (let v = 0; v < nv; v++) {
    vStart[v] = poolEnd;
    poolEnd += vCap[v];
  }
  let pool = new Int32Array(Math.max(16, Math.ceil(poolEnd * 1.25)));
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const v = tri[t * 3 + k];
      pool[vStart[v] + vLen[v]++] = t;
    }
  const setList = (v: number, list: number[]) => {
    if (list.length > vCap[v]) {
      const cap = list.length * 2;
      if (poolEnd + cap > pool.length) {
        const grown = new Int32Array(Math.max(pool.length * 2, poolEnd + cap));
        grown.set(pool.subarray(0, poolEnd));
        pool = grown;
      }
      vStart[v] = poolEnd;
      vCap[v] = cap;
      poolEnd += cap;
    }
    for (let i = 0; i < list.length; i++) pool[vStart[v] + i] = list[i];
    vLen[v] = list.length;
  };

  // quadrics: 10 coefficients per vertex
  const Q = new Float64Array(nv * 10);
  /** summed face-area weight per vertex, to turn quadric cost into a squared distance */
  const W = new Float64Array(nv);
  const addPlane = (v: number, a: number, b: number, c: number, d: number, w: number) => {
    const o = v * 10;
    Q[o] += w * a * a; Q[o + 1] += w * a * b; Q[o + 2] += w * a * c; Q[o + 3] += w * a * d;
    Q[o + 4] += w * b * b; Q[o + 5] += w * b * c; Q[o + 6] += w * b * d;
    Q[o + 7] += w * c * c; Q[o + 8] += w * c * d; Q[o + 9] += w * d * d;
  };
  const faceNormal = (t: number, out: number[]) => {
    const a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
    return Math.hypot(out[0], out[1], out[2]);
  };
  const n3 = [0, 0, 0];
  for (let t = 0; t < nt; t++) {
    const l = faceNormal(t, n3);
    if (!l) continue;
    const a = n3[0] / l, b = n3[1] / l, c = n3[2] / l;
    const p = tri[t * 3] * 3;
    const d = -(a * pos[p] + b * pos[p + 1] + c * pos[p + 2]);
    for (let k = 0; k < 3; k++) {
      addPlane(tri[t * 3 + k], a, b, c, d, l / 2);
      W[tri[t * 3 + k]] += l / 2;
    }
  }
  // boundary edges: heavy planes perpendicular to the face through the edge keep borders in place
  const topo = buildTopology({ positions: mesh.positions, indices: idx0 });
  for (let e = 0; e < topo.edgeCount; e++) {
    if (topo.edgeFaceCount[e] !== 1) continue;
    const t = (topo.edgeHE0[e] / 3) | 0;
    const va = topo.edgeV0[e], vb = topo.edgeV1[e];
    faceNormal(t, n3);
    const ex = pos[vb * 3] - pos[va * 3], ey = pos[vb * 3 + 1] - pos[va * 3 + 1], ez = pos[vb * 3 + 2] - pos[va * 3 + 2];
    let px = ey * n3[2] - ez * n3[1], py = ez * n3[0] - ex * n3[2], pz = ex * n3[1] - ey * n3[0];
    const pl = Math.hypot(px, py, pz);
    if (!pl) continue;
    px /= pl; py /= pl; pz /= pl;
    const d = -(px * pos[va * 3] + py * pos[va * 3 + 1] + pz * pos[va * 3 + 2]);
    const w = (ex * ex + ey * ey + ez * ez) * 100;
    addPlane(va, px, py, pz, d, w);
    addPlane(vb, px, py, pz, d, w);
  }

  let maxDev = opts.maxDeviation;
  if (maxDev === undefined) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i++) {
      const k = i % 3;
      if (pos[i] < lo[k]) lo[k] = pos[i];
      if (pos[i] > hi[k]) hi[k] = pos[i];
    }
    maxDev = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.005;
  }
  const maxDev2 = maxDev * maxDev;

  const version = new Int32Array(nv);
  const removedV = new Uint8Array(nv);
  const target3 = [0, 0, 0];
  /** Optimal collapse position for edge (a,b) into target3, returns its error. */
  const evaluate = (a: number, b: number): number => {
    const oa = a * 10, ob = b * 10;
    const q0 = Q[oa] + Q[ob], q1 = Q[oa + 1] + Q[ob + 1], q2 = Q[oa + 2] + Q[ob + 2], q3 = Q[oa + 3] + Q[ob + 3];
    const q4 = Q[oa + 4] + Q[ob + 4], q5 = Q[oa + 5] + Q[ob + 5], q6 = Q[oa + 6] + Q[ob + 6];
    const q7 = Q[oa + 7] + Q[ob + 7], q8 = Q[oa + 8] + Q[ob + 8], q9 = Q[oa + 9] + Q[ob + 9];
    const err = (x: number, y: number, z: number) =>
      q0 * x * x + 2 * q1 * x * y + 2 * q2 * x * z + 2 * q3 * x + q4 * y * y + 2 * q5 * y * z + 2 * q6 * y + q7 * z * z + 2 * q8 * z + q9;
    const det = q0 * (q4 * q7 - q5 * q5) - q1 * (q1 * q7 - q5 * q2) + q2 * (q1 * q5 - q4 * q2);
    if (Math.abs(det) > 1e-12) {
      const x = (-q3 * (q4 * q7 - q5 * q5) + q1 * (q6 * q7 - q5 * q8) - q2 * (q6 * q5 - q4 * q8)) / det;
      const y = (q0 * (-q6 * q7 + q5 * q8) + q3 * (q1 * q7 - q5 * q2) - q2 * (q1 * q8 - q6 * q2)) / det;
      const z = (q0 * (-q4 * q8 + q6 * q5) - q1 * (-q1 * q8 + q6 * q2) - q3 * (q1 * q5 - q4 * q2)) / det;
      // reject optima far away from the edge (ill-conditioned)
      const mx = (pos[a * 3] + pos[b * 3]) / 2, my = (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, mz = (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2;
      const el2 = (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 1] - pos[b * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2;
      if ((x - mx) ** 2 + (y - my) ** 2 + (z - mz) ** 2 < el2 * 4) {
        target3[0] = x; target3[1] = y; target3[2] = z;
        return Math.max(0, err(x, y, z));
      }
    }
    // fall back to the best of the endpoints and the midpoint
    let best = Infinity;
    for (const t of [0, 0.5, 1]) {
      const x = pos[a * 3] + (pos[b * 3] - pos[a * 3]) * t;
      const y = pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * t;
      const z = pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * t;
      const e = err(x, y, z);
      if (e < best) {
        best = e;
        target3[0] = x; target3[1] = y; target3[2] = z;
      }
    }
    return Math.max(0, best);
  };

  const heap = new EdgeHeap(topo.edgeCount + 1024);
  // versions only grow, so an unchanged sum means neither endpoint changed since the push
  const edgeStamp = (a: number, b: number) => version[a] + version[b];
  for (let e = 0; e < topo.edgeCount; e++) {
    const a = topo.edgeV0[e], b = topo.edgeV1[e];
    heap.push(evaluate(a, b), a, b, edgeStamp(a, b));
  }

  const liveTris = (v: number, out: number[]) => {
    out.length = 0;
    for (let i = vStart[v], e = i + vLen[v]; i < e; i++) if (alive[pool[i]]) out.push(pool[i]);
    return out;
  };
  const neighbours = (v: number, out: Set<number>) => {
    out.clear();
    for (let i = vStart[v], e = i + vLen[v]; i < e; i++) {
      const t = pool[i];
      if (!alive[t]) continue;
      for (let k = 0; k < 3; k++) {
        const w = tri[t * 3 + k];
        if (w !== v) out.add(w);
      }
    }
    return out;
  };
  const nA = new Set<number>(), nB = new Set<number>();
  const ta: number[] = [], tb: number[] = [], shared: number[] = [], merged: number[] = [];
  const sv = [0, 0, 0, 0, 0, 0];
  const before = [0, 0, 0], after = [0, 0, 0];
  let current = nt;
  let steps = 0;
  const total = nt - target;

  while (current > target && heap.pop()) {
    const i = heap.size;
    const a = heap.a[i], b = heap.b[i];
    if (removedV[a] || removedV[b]) continue;
    if (heap.stamp[i] !== edgeStamp(a, b)) continue; // stale entry
    liveTris(a, ta);
    liveTris(b, tb);
    shared.length = 0;
    for (const t of ta) if (tb.includes(t)) shared.push(t);
    if (!shared.length) continue; // no longer an edge
    // link condition: common neighbours must be exactly the opposite vertices of the shared faces
    neighbours(a, nA);
    neighbours(b, nB);
    let common = 0;
    for (const w of nA) if (nB.has(w)) common++;
    if (common !== shared.length) continue;
    const cost = evaluate(a, b);
    // the heap is ordered by cost, but the deviation also depends on area, so test each edge
    if (cost > maxDev2 * (W[a] + W[b])) continue;
    const nx = target3[0], ny = target3[1], nz = target3[2];
    // reject collapses that flip or squash surrounding triangles
    let ok = true;
    for (let n = 0, all = ta.length + tb.length; n < all; n++) {
      const t = n < ta.length ? ta[n] : tb[n - ta.length];
      if (shared.includes(t)) continue;
      const l0 = faceNormal(t, before);
      if (!l0) continue;
      let m = 0;
      for (let k = 0; k < 3; k++) {
        const w = tri[t * 3 + k];
        if (w === a || w === b) {
          sv[m++] = pos[w * 3]; sv[m++] = pos[w * 3 + 1]; sv[m++] = pos[w * 3 + 2];
          pos[w * 3] = nx; pos[w * 3 + 1] = ny; pos[w * 3 + 2] = nz;
        }
      }
      const l1 = faceNormal(t, after);
      // restore
      let j = 0;
      for (let k = 0; k < 3; k++) {
        const w = tri[t * 3 + k];
        if (w === a || w === b) {
          pos[w * 3] = sv[j++]; pos[w * 3 + 1] = sv[j++]; pos[w * 3 + 2] = sv[j++];
        }
      }
      if (!l1 || (before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / (l0 * l1) < 0.3) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // collapse b into a
    pos[a * 3] = nx; pos[a * 3 + 1] = ny; pos[a * 3 + 2] = nz;
    for (let k = 0; k < 10; k++) Q[a * 10 + k] += Q[b * 10 + k];
    W[a] += W[b];
    for (const t of shared) {
      alive[t] = 0;
      current--;
    }
    merged.length = 0;
    for (const t of ta) if (alive[t]) merged.push(t);
    for (const t of tb) {
      if (!alive[t]) continue;
      for (let k = 0; k < 3; k++) if (tri[t * 3 + k] === b) tri[t * 3 + k] = a;
      merged.push(t);
    }
    removedV[b] = 1;
    vLen[b] = 0;
    setList(a, merged);
    version[a]++;
    for (const w of neighbours(a, nA)) {
      heap.push(evaluate(a, w), a, w, edgeStamp(a, w));
    }
    if ((++steps & 4095) === 0) onProgress(Math.min(0.95, (nt - current) / total), 'Simplifying');
  }

  // write out
  const outIdx = new Uint32Array(current * 3);
  let o = 0;
  for (let t = 0; t < nt; t++)
    if (alive[t]) {
      outIdx[o++] = tri[t * 3]; outIdx[o++] = tri[t * 3 + 1]; outIdx[o++] = tri[t * 3 + 2];
    }
  const out = compactMesh({ positions: Float32Array.from(pos), indices: outIdx });
  onProgress(1);
  return { mesh: out, trianglesBefore: nt, trianglesAfter: out.indices.length / 3 };
}
