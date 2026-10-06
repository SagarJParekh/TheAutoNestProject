/**
 * Isotropic remeshing (Botsch & Kobbelt): repeated passes of long-edge
 * splits, short-edge collapses, valence-improving edge flips and tangential
 * smoothing with projection back onto the original surface.
 *
 * Sharp feature edges, open borders and the border of a marked region are
 * kept: they are only ever split at their midpoint, never collapsed, flipped
 * or moved, so the remeshed area stays connected to the rest of the part.
 */
import { Vector3 } from 'three';
import { MeshData, ProgressFn, noProgress, triangleCount } from './mesh';
import { buildTopology, Topology } from './topology';
import { makeBVH } from './sdf';

export interface RemeshParams {
  /** target edge length, mm */
  edgeLength: number;
  /** split / collapse / flip / smooth rounds (default 5) */
  iterations?: number;
  /** edges with a dihedral angle above this are kept as features (degrees, default 35) */
  featureAngle?: number;
  /** remesh only these triangles (the rest stays untouched); null = whole mesh */
  region?: ArrayLike<number> | null;
  /** refuse when the result would exceed this many triangles (default 6M) */
  maxTriangles?: number;
}

export interface RemeshResult {
  mesh: MeshData;
  trianglesBefore: number;
  trianglesAfter: number;
}

/** Mean edge length of a mesh, or of a set of its triangles. */
export function meanEdgeLength(mesh: MeshData, region?: ArrayLike<number> | null): number {
  const p = mesh.positions, idx = mesh.indices;
  let sum = 0, n = 0;
  const count = region ? region.length : idx.length / 3;
  for (let i = 0; i < count; i++) {
    const t = region ? region[i] : i;
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k] * 3, b = idx[t * 3 + ((k + 1) % 3)] * 3;
      sum += Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** Expected triangle count for a target edge length over the given area. */
export function estimateRemeshTriangles(area: number, edgeLength: number): number {
  return Math.round(area / ((Math.sqrt(3) / 4) * edgeLength * edgeLength));
}

const KEY_STRIDE = 67108864; // 2^26
const ekey = (a: number, b: number) => (a < b ? a * KEY_STRIDE + b : b * KEY_STRIDE + a);

export function remeshMesh(mesh: MeshData, params: RemeshParams, onProgress: ProgressFn = noProgress): RemeshResult {
  const L = params.edgeLength;
  const ntIn = triangleCount(mesh);
  if (!(L > 0) || ntIn === 0) return { mesh, trianglesBefore: ntIn, trianglesAfter: ntIn };
  const iterations = params.iterations ?? 5;
  const cosFeature = Math.cos(((params.featureAngle ?? 35) * Math.PI) / 180);
  const maxTris = params.maxTriangles ?? 6_000_000;
  const hi2 = ((4 / 3) * L) ** 2, lo2 = ((4 / 5) * L) ** 2;

  // ---- working state (growable)
  let P = Float64Array.from(mesh.positions);
  let nv = P.length / 3;
  let T = Int32Array.from(mesh.indices);
  let nt = ntIn;
  let frozen = new Uint8Array(nt);
  if (params.region) {
    frozen.fill(1);
    for (let i = 0; i < params.region.length; i++) frozen[params.region[i]] = 0;
  }
  const ensureV = (n: number) => {
    if (n * 3 <= P.length) return;
    const g = new Float64Array(Math.max(n * 3, P.length * 2));
    g.set(P);
    P = g;
  };
  const ensureT = (n: number) => {
    if (n * 3 <= T.length) return;
    const cap = Math.max(n, (T.length / 3) * 2);
    const g = new Int32Array(cap * 3);
    g.set(T);
    T = g;
    const f = new Uint8Array(cap);
    f.set(frozen);
    frozen = f;
  };

  const bvh = makeBVH(mesh);
  const gi = bvh.geometry.index!.array as ArrayLike<number>;
  const gp = bvh.geometry.attributes.position.array as ArrayLike<number>;
  const tmpV = new Vector3();
  const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };

  // ---- feature edges (tracked across splits by vertex pair)
  const features = new Set<number>();
  {
    const topo = buildTopology(mesh);
    const n0: number[] = [0, 0, 0], n1: number[] = [0, 0, 0];
    for (let e = 0; e < topo.edgeCount; e++) {
      if (topo.edgeFaceCount[e] !== 2) continue;
      const t0 = (topo.edgeHE0[e] / 3) | 0, t1 = (topo.edgeHE1[e] / 3) | 0;
      if (frozen[t0] && frozen[t1]) continue;
      const l0 = faceN(P, T, t0, n0), l1 = faceN(P, T, t1, n1);
      if (!l0 || !l1) continue;
      if ((n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1) < cosFeature) features.add(ekey(topo.edgeV0[e], topo.edgeV1[e]));
    }
  }

  // ---- per-pass connectivity
  let topo: Topology;
  let vtStart = new Int32Array(0), vtList = new Int32Array(0);
  const alive = () => new Uint8Array(nt).fill(1);
  let live: Uint8Array = alive();
  const rebuild = () => {
    // drop dead triangles
    let o = 0;
    for (let t = 0; t < nt; t++) {
      if (!live[t]) continue;
      if (o !== t) {
        T[o * 3] = T[t * 3]; T[o * 3 + 1] = T[t * 3 + 1]; T[o * 3 + 2] = T[t * 3 + 2];
        frozen[o] = frozen[t];
      }
      o++;
    }
    nt = o;
    live = alive();
    topo = buildTopology({ positions: { length: nv * 3 } as Float32Array, indices: T.subarray(0, nt * 3) as never });
    vtStart = new Int32Array(nv + 1);
    for (let i = 0; i < nt * 3; i++) vtStart[T[i] + 1]++;
    for (let v = 0; v < nv; v++) vtStart[v + 1] += vtStart[v];
    vtList = new Int32Array(nt * 3);
    const fill = vtStart.slice(0, nv);
    for (let i = 0; i < nt * 3; i++) vtList[fill[T[i]]++] = (i / 3) | 0;
  };
  /** an edge that must keep its place: border, non-manifold, region border or feature */
  const edgeLocked = (e: number) => {
    if (topo.edgeFaceCount[e] !== 2) return true;
    if (frozen[(topo.edgeHE0[e] / 3) | 0] || frozen[(topo.edgeHE1[e] / 3) | 0]) return true;
    return features.has(ekey(topo.edgeV0[e], topo.edgeV1[e]));
  };
  let vLocked = new Uint8Array(0);
  let vBorder = new Uint8Array(0);
  const classify = () => {
    vLocked = new Uint8Array(nv);
    vBorder = new Uint8Array(nv);
    for (let e = 0; e < topo.edgeCount; e++) {
      if (!edgeLocked(e)) continue;
      vLocked[topo.edgeV0[e]] = 1;
      vLocked[topo.edgeV1[e]] = 1;
      if (topo.edgeFaceCount[e] === 1) {
        vBorder[topo.edgeV0[e]] = 1;
        vBorder[topo.edgeV1[e]] = 1;
      }
    }
    for (let t = 0; t < nt; t++) if (frozen[t]) for (let k = 0; k < 3; k++) vLocked[T[t * 3 + k]] = 1;
  };
  const len2 = (a: number, b: number) => {
    const dx = P[a * 3] - P[b * 3], dy = P[a * 3 + 1] - P[b * 3 + 1], dz = P[a * 3 + 2] - P[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  /** the vertex of triangle t that is not a or b */
  const third = (t: number, a: number, b: number) => {
    for (let k = 0; k < 3; k++) {
      const w = T[t * 3 + k];
      if (w !== a && w !== b) return w;
    }
    return -1;
  };

  // ---------------------------------------------------------------- split
  const splitPass = (): number => {
    rebuild();
    const used = new Uint8Array(nt);
    let count = 0;
    // longest edges first: bisecting each triangle along its longest edge keeps triangles well shaped
    const cand: number[] = [];
    const clen: number[] = [];
    for (let e = 0; e < topo.edgeCount; e++) {
      const fc = topo.edgeFaceCount[e];
      if (fc < 1 || fc > 2) continue;
      const l = len2(topo.edgeV0[e], topo.edgeV1[e]);
      if (l <= hi2) continue;
      cand.push(e);
      clen[e] = l;
    }
    cand.sort((x, y) => clen[y] - clen[x]);
    for (const e of cand) {
      const fc = topo.edgeFaceCount[e];
      const a = topo.edgeV0[e], b = topo.edgeV1[e];
      const t0 = (topo.edgeHE0[e] / 3) | 0, t1 = fc === 2 ? (topo.edgeHE1[e] / 3) | 0 : -1;
      if (frozen[t0] || used[t0] || (t1 >= 0 && (frozen[t1] || used[t1]))) continue;
      if (nt + 2 > maxTris) throw new Error(`Remeshing would create more than ${maxTris.toLocaleString()} triangles; use a larger edge length`);
      ensureV(nv + 1);
      const m = nv++;
      P[m * 3] = (P[a * 3] + P[b * 3]) / 2;
      P[m * 3 + 1] = (P[a * 3 + 1] + P[b * 3 + 1]) / 2;
      P[m * 3 + 2] = (P[a * 3 + 2] + P[b * 3 + 2]) / 2;
      for (const t of t1 >= 0 ? [t0, t1] : [t0]) {
        used[t] = 1;
        // rotate so the split edge is T[t] = (x, y, z) with x->y the edge
        let k = 0;
        for (; k < 3; k++) {
          const x = T[t * 3 + k], y = T[t * 3 + ((k + 1) % 3)];
          if ((x === a && y === b) || (x === b && y === a)) break;
        }
        const x = T[t * 3 + k], y = T[t * 3 + ((k + 1) % 3)], z = T[t * 3 + ((k + 2) % 3)];
        ensureT(nt + 1);
        T[t * 3] = x; T[t * 3 + 1] = m; T[t * 3 + 2] = z;
        const n = nt++;
        T[n * 3] = m; T[n * 3 + 1] = y; T[n * 3 + 2] = z;
        frozen[n] = 0;
        live = growLive(live, nt);
      }
      const key = ekey(a, b);
      if (features.has(key)) {
        features.delete(key);
        features.add(ekey(a, m));
        features.add(ekey(m, b));
      }
      count++;
    }
    return count;
  };

  // ---------------------------------------------------------------- collapse
  const collapsePass = (): number => {
    rebuild();
    classify();
    const touched = new Uint8Array(nv);
    const nA: number[] = [0, 0, 0], nB: number[] = [0, 0, 0];
    let count = 0;
    for (let e = 0; e < topo.edgeCount; e++) {
      if (edgeLocked(e)) continue;
      let a = topo.edgeV0[e], b = topo.edgeV1[e];
      if (touched[a] || touched[b]) continue;
      if (len2(a, b) >= lo2) continue;
      if (vLocked[a] && vLocked[b]) continue;
      // keep the locked vertex in place; otherwise collapse to the midpoint
      if (vLocked[b]) [a, b] = [b, a];
      const tx = vLocked[a] ? P[a * 3] : (P[a * 3] + P[b * 3]) / 2;
      const ty = vLocked[a] ? P[a * 3 + 1] : (P[a * 3 + 1] + P[b * 3 + 1]) / 2;
      const tz = vLocked[a] ? P[a * 3 + 2] : (P[a * 3 + 2] + P[b * 3 + 2]) / 2;
      const t0 = (topo.edgeHE0[e] / 3) | 0, t1 = (topo.edgeHE1[e] / 3) | 0;
      const c = third(t0, a, b), d = third(t1, a, b);
      if (c < 0 || d < 0 || c === d) continue;
      if (touched[c] || touched[d]) continue;
      if (vtStart[c + 1] - vtStart[c] <= 3 || vtStart[d + 1] - vtStart[d] <= 3) continue;
      // link condition and lock check over both one-rings
      let ok = true;
      const ringA = new Set<number>();
      for (let i = vtStart[a]; i < vtStart[a + 1]; i++) for (let k = 0; k < 3; k++) ringA.add(T[vtList[i] * 3 + k]);
      let common = 0;
      const ringB = new Set<number>();
      for (let i = vtStart[b]; i < vtStart[b + 1]; i++) for (let k = 0; k < 3; k++) ringB.add(T[vtList[i] * 3 + k]);
      for (const w of ringB) {
        if (touched[w]) ok = false;
        if (w !== a && w !== b && ringA.has(w)) common++;
      }
      for (const w of ringA) if (touched[w]) ok = false;
      if (!ok || common !== 2) continue;
      // no long edges and no folded triangles around the new vertex
      for (const w of ringB) {
        if (w === a || w === b) continue;
        const dx = P[w * 3] - tx, dy = P[w * 3 + 1] - ty, dz = P[w * 3 + 2] - tz;
        if (dx * dx + dy * dy + dz * dz > hi2) ok = false;
      }
      if (!ok) continue;
      for (const v of [a, b]) {
        for (let i = vtStart[v]; i < vtStart[v + 1] && ok; i++) {
          const t = vtList[i];
          if (t === t0 || t === t1) continue;
          const l0 = faceN(P, T, t, nA);
          const save: number[] = [];
          for (let k = 0; k < 3; k++) {
            const w = T[t * 3 + k];
            if (w === a || w === b) {
              save.push(k, P[w * 3], P[w * 3 + 1], P[w * 3 + 2]);
              P[w * 3] = tx; P[w * 3 + 1] = ty; P[w * 3 + 2] = tz;
            }
          }
          const l1 = faceN(P, T, t, nB);
          for (let s = 0; s < save.length; s += 4) {
            const w = T[t * 3 + save[s]];
            P[w * 3] = save[s + 1]; P[w * 3 + 1] = save[s + 2]; P[w * 3 + 2] = save[s + 3];
          }
          if (!l0) continue;
          if (!l1 || (nA[0] * nB[0] + nA[1] * nB[1] + nA[2] * nB[2]) / (l0 * l1) < 0.3) ok = false;
        }
      }
      if (!ok) continue;
      P[a * 3] = tx; P[a * 3 + 1] = ty; P[a * 3 + 2] = tz;
      for (let i = vtStart[b]; i < vtStart[b + 1]; i++) {
        const t = vtList[i];
        for (let k = 0; k < 3; k++) if (T[t * 3 + k] === b) T[t * 3 + k] = a;
      }
      live[t0] = 0;
      live[t1] = 0;
      for (const w of ringA) touched[w] = 1;
      for (const w of ringB) touched[w] = 1;
      count++;
    }
    return count;
  };

  // ---------------------------------------------------------------- flip
  const flipPass = (): number => {
    rebuild();
    classify();
    const val = new Int32Array(nv);
    for (let v = 0; v < nv; v++) val[v] = vtStart[v + 1] - vtStart[v] + (vBorder[v] ? 1 : 0);
    const target = (v: number) => (vBorder[v] ? 4 : 6);
    const touched = new Uint8Array(nv);
    const n0: number[] = [0, 0, 0], n1: number[] = [0, 0, 0], m0: number[] = [0, 0, 0], m1: number[] = [0, 0, 0];
    let count = 0;
    for (let e = 0; e < topo.edgeCount; e++) {
      if (edgeLocked(e)) continue;
      const h0 = topo.edgeHE0[e], h1 = topo.edgeHE1[e];
      const t0 = (h0 / 3) | 0, t1 = (h1 / 3) | 0;
      // orient: t0 holds a->b
      const a = T[h0], b = T[t0 * 3 + ((h0 - t0 * 3 + 1) % 3)];
      const c = third(t0, a, b), d = third(t1, a, b);
      if (c < 0 || d < 0 || c === d) continue;
      if (touched[a] || touched[b] || touched[c] || touched[d]) continue;
      const before = Math.abs(val[a] - target(a)) + Math.abs(val[b] - target(b)) + Math.abs(val[c] - target(c)) + Math.abs(val[d] - target(d));
      const after = Math.abs(val[a] - 1 - target(a)) + Math.abs(val[b] - 1 - target(b)) + Math.abs(val[c] + 1 - target(c)) + Math.abs(val[d] + 1 - target(d));
      if (after >= before) continue;
      if (val[a] <= 3 || val[b] <= 3) continue;
      // c-d must not already be an edge
      let exists = false;
      for (let i = vtStart[c]; i < vtStart[c + 1] && !exists; i++) {
        const t = vtList[i];
        for (let k = 0; k < 3; k++) if (T[t * 3 + k] === d) exists = true;
      }
      if (exists) continue;
      const l0 = faceN(P, T, t0, n0), l1 = faceN(P, T, t1, n1);
      if (!l0 || !l1) continue;
      // new triangles (a, d, c) and (d, b, c); both must face the same way as the old pair
      const save0 = [T[t0 * 3], T[t0 * 3 + 1], T[t0 * 3 + 2]], save1 = [T[t1 * 3], T[t1 * 3 + 1], T[t1 * 3 + 2]];
      T[t0 * 3] = a; T[t0 * 3 + 1] = d; T[t0 * 3 + 2] = c;
      T[t1 * 3] = d; T[t1 * 3 + 1] = b; T[t1 * 3 + 2] = c;
      const k0 = faceN(P, T, t0, m0), k1 = faceN(P, T, t1, m1);
      const sx = n0[0] / l0 + n1[0] / l1, sy = n0[1] / l0 + n1[1] / l1, sz = n0[2] / l0 + n1[2] / l1;
      const good =
        k0 > 0 && k1 > 0 &&
        (m0[0] * sx + m0[1] * sy + m0[2] * sz) / k0 > 0.5 &&
        (m1[0] * sx + m1[1] * sy + m1[2] * sz) / k1 > 0.5 &&
        (m0[0] * m1[0] + m0[1] * m1[1] + m0[2] * m1[2]) / (k0 * k1) > cosFeature;
      if (!good) {
        T[t0 * 3] = save0[0]; T[t0 * 3 + 1] = save0[1]; T[t0 * 3 + 2] = save0[2];
        T[t1 * 3] = save1[0]; T[t1 * 3 + 1] = save1[1]; T[t1 * 3 + 2] = save1[2];
        continue;
      }
      val[a]--; val[b]--; val[c]++; val[d]++;
      touched[a] = touched[b] = touched[c] = touched[d] = 1;
      count++;
    }
    return count;
  };

  // ---------------------------------------------------------------- smooth + project
  const relaxPass = () => {
    rebuild();
    classify();
    const next = new Float64Array(nv * 3);
    const moved = new Uint8Array(nv);
    const fn: number[] = [0, 0, 0];
    for (let v = 0; v < nv; v++) {
      if (vLocked[v] || vtStart[v + 1] === vtStart[v]) continue;
      let cx = 0, cy = 0, cz = 0, wsum = 0, nx = 0, ny = 0, nz = 0;
      for (let i = vtStart[v]; i < vtStart[v + 1]; i++) {
        const t = vtList[i];
        const l = faceN(P, T, t, fn);
        nx += fn[0]; ny += fn[1]; nz += fn[2];
        // area-weighted triangle centroids give an even distribution
        const w = l / 2 || 1e-12;
        for (let k = 0; k < 3; k++) {
          const u = T[t * 3 + k];
          cx += (P[u * 3] * w) / 3; cy += (P[u * 3 + 1] * w) / 3; cz += (P[u * 3 + 2] * w) / 3;
        }
        wsum += w;
      }
      const nl = Math.hypot(nx, ny, nz);
      if (!nl || !wsum) continue;
      nx /= nl; ny /= nl; nz /= nl;
      let dx = cx / wsum - P[v * 3], dy = cy / wsum - P[v * 3 + 1], dz = cz / wsum - P[v * 3 + 2];
      const dn = dx * nx + dy * ny + dz * nz;
      dx -= dn * nx; dy -= dn * ny; dz -= dn * nz;
      tmpV.set(P[v * 3] + dx, P[v * 3 + 1] + dy, P[v * 3 + 2] + dz);
      const r = bvh.closestPointToPoint(tmpV, hit);
      let q = tmpV;
      if (r) {
        // only accept a projection onto a surface facing the same way (not across a sharp edge)
        const f = r.faceIndex * 3;
        const a = gi[f] * 3, b = gi[f + 1] * 3, c = gi[f + 2] * 3;
        const ux = gp[b] - gp[a], uy = gp[b + 1] - gp[a + 1], uz = gp[b + 2] - gp[a + 2];
        const wx = gp[c] - gp[a], wy = gp[c + 1] - gp[a + 1], wz = gp[c + 2] - gp[a + 2];
        const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
        const fl = Math.hypot(fx, fy, fz);
        if (fl && (fx * nx + fy * ny + fz * nz) / fl > cosFeature) q = r.point;
      }
      next[v * 3] = q.x; next[v * 3 + 1] = q.y; next[v * 3 + 2] = q.z;
      moved[v] = 1;
    }
    // apply, undoing moves that would fold an incident triangle
    const before: number[] = [0, 0, 0], after: number[] = [0, 0, 0];
    for (let v = 0; v < nv; v++) {
      if (!moved[v]) continue;
      const ox = P[v * 3], oy = P[v * 3 + 1], oz = P[v * 3 + 2];
      const normals: number[] = [];
      for (let i = vtStart[v]; i < vtStart[v + 1]; i++) {
        const l = faceN(P, T, vtList[i], before);
        normals.push(before[0], before[1], before[2], l);
      }
      P[v * 3] = next[v * 3]; P[v * 3 + 1] = next[v * 3 + 1]; P[v * 3 + 2] = next[v * 3 + 2];
      let j = 0;
      for (let i = vtStart[v]; i < vtStart[v + 1]; i++, j += 4) {
        const l1 = faceN(P, T, vtList[i], after);
        const l0 = normals[j + 3];
        if (!l0) continue;
        if (l1 < l0 * 0.1 || (normals[j] * after[0] + normals[j + 1] * after[1] + normals[j + 2] * after[2]) / (l0 * l1) < 0.2) {
          P[v * 3] = ox; P[v * 3 + 1] = oy; P[v * 3 + 2] = oz;
          break;
        }
      }
    }
  };

  for (let it = 0; it < iterations; it++) {
    const f = it / iterations;
    onProgress(f, `Remeshing (${it + 1}/${iterations}): splitting`);
    for (let s = 0; s < 12 && splitPass() > 0; s++);
    onProgress(f + 0.3 / iterations, `Remeshing (${it + 1}/${iterations}): collapsing`);
    for (let s = 0; s < 30 && collapsePass() > 0; s++);
    onProgress(f + 0.6 / iterations, `Remeshing (${it + 1}/${iterations}): flipping`);
    for (let s = 0; s < 3 && flipPass() > 0; s++);
    onProgress(f + 0.8 / iterations, `Remeshing (${it + 1}/${iterations}): smoothing`);
    relaxPass();
  }
  rebuild();

  // ---- compact output
  const used = new Int32Array(nv).fill(-1);
  let outV = 0;
  for (let i = 0; i < nt * 3; i++) if (used[T[i]] < 0) used[T[i]] = outV++;
  const positions = new Float32Array(outV * 3);
  for (let v = 0; v < nv; v++) {
    const o = used[v];
    if (o < 0) continue;
    positions[o * 3] = P[v * 3]; positions[o * 3 + 1] = P[v * 3 + 1]; positions[o * 3 + 2] = P[v * 3 + 2];
  }
  const indices = new Uint32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) indices[i] = used[T[i]];
  onProgress(1);
  return { mesh: { positions, indices }, trianglesBefore: ntIn, trianglesAfter: nt };
}

function growLive(live: Uint8Array, n: number): Uint8Array {
  if (n <= live.length) {
    live[n - 1] = 1;
    return live;
  }
  const g = new Uint8Array(Math.max(n, live.length * 2));
  g.set(live);
  g.fill(1, live.length);
  return g;
}

/** Unnormalised normal of triangle t into out; returns its length (2 × area). */
function faceN(P: Float64Array, T: Int32Array, t: number, out: number[]): number {
  const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
  const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
  const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
  out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
  return Math.hypot(out[0], out[1], out[2]);
}
