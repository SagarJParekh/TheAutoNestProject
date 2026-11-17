/**
 * Surface to solid: turn a zero-thickness surface (an open mesh, or a region
 * of triangles taken off a part) into a closed solid.
 *
 * - thicken: the surface is offset along its normals into two layers (a gap
 *   off the surface, then the thickness), joined by side walls along every
 *   edge of the surface (outer edge and holes);
 * - base: the surface (offset by the gap) is filled straight down (or up) to
 *   a flat base: a fixture / cradle whose top is the shape of the part.
 *
 * The layers are built directly (sharp edges, exact). Where the offset folds
 * over itself (thickness larger than a tight curve), the solid is made again
 * as the union of one prism per triangle, which never self-intersects.
 */
import type { Manifold } from 'manifold-3d';
import { MeshData, computeBounds, boundsDiagonal, triangleCount, compactMesh, subsetTriangles } from './mesh';
import { weldVertices } from './weld';
import { buildTopology, propagateOrientation } from './topology';
import { findIntersections } from './intersect';
import { fromManifold, getManifold } from './manifold';
import { simplifyMesh } from './simplify';

export interface SolidifyParams {
  mode: 'thicken' | 'base';
  /** wall thickness (thicken), mm */
  thickness: number;
  /** thicken: which side of the surface the solid grows on (out = along the normals, away from the part) */
  side: 'out' | 'in' | 'both';
  /** clearance between the surface and the solid, mm (e.g. so the part fits in a fixture) */
  gap: number;
  /** base: fill towards a flat base below (−Z) or above (+Z) */
  baseDir: 'down' | 'up';
  /** base: how far the base reaches beyond the surface's lowest (highest) point, mm */
  baseThickness: number;
  /** base: use only the part of the surface that faces the base (so the fixture never reaches over the part) */
  facingOnly: boolean;
}

export const DEFAULT_SOLIDIFY: SolidifyParams = { mode: 'thicken', thickness: 2, side: 'out', gap: 0, baseDir: 'down', baseThickness: 3, facingOnly: true };

export interface SolidifyResult {
  mesh: MeshData;
  /** triangles of the surface used */
  surfaceTris: number;
  /** base: triangles left out because they face away from the base */
  leftOut: number;
  /** edge loops of the surface (outer edge and holes) closed with walls */
  loops: number;
  /** the direct offset folded over itself: made from per-triangle prisms instead */
  prisms: boolean;
  volume: number;
}

function signedVolume(m: MeshData): number {
  const p = m.positions, idx = m.indices;
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/** The surface: the chosen triangles (or all), welded into one connected, consistently facing sheet. */
export function extractSurface(mesh: MeshData, tris?: ArrayLike<number> | null): MeshData {
  let m = mesh;
  if (tris && tris.length) {
    const keep = new Uint8Array(triangleCount(mesh));
    for (let i = 0; i < tris.length; i++) keep[tris[i]] = 1;
    m = subsetTriangles(mesh, (t) => keep[t] === 1);
  }
  const tol = boundsDiagonal(computeBounds(m.positions)) * 1e-6;
  m = compactMesh(weldVertices(m.positions, m.indices, tol).mesh);
  // drop degenerate triangles (welded corners)
  const idx = m.indices;
  m = subsetTriangles(m, (t) => idx[t * 3] !== idx[t * 3 + 1] && idx[t * 3 + 1] !== idx[t * 3 + 2] && idx[t * 3] !== idx[t * 3 + 2]);
  // faces of a sheet all facing the same way
  const topo = buildTopology(m);
  const { flip } = propagateOrientation(m, topo);
  if (flip.some((f) => f)) {
    const out = m.indices.slice();
    for (let t = 0; t < flip.length; t++) if (flip[t]) [out[t * 3 + 1], out[t * 3 + 2]] = [out[t * 3 + 2], out[t * 3 + 1]];
    m = { positions: m.positions, indices: out };
  }
  return compactMesh(m);
}

/**
 * Vertex normals (angle weighted) and how much to stretch an offset along
 * them so the layer keeps the thickness from every face around (1 / cos).
 */
function vertexOffsets(m: MeshData): { n: Float32Array; k: Float32Array } {
  const p = m.positions, idx = m.indices, nv = p.length / 3, nt = idx.length / 3;
  const n = new Float32Array(nv * 3);
  const fn = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const ia = idx[t * 3], ib = idx[t * 3 + 1], ic = idx[t * 3 + 2];
    const v = [ia, ib, ic].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
    const ux = v[1][0] - v[0][0], uy = v[1][1] - v[0][1], uz = v[1][2] - v[0][2];
    const wx = v[2][0] - v[0][0], wy = v[2][1] - v[0][1], wz = v[2][2] - v[0][2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-20) continue;
    nx /= l;
    ny /= l;
    nz /= l;
    fn.set([nx, ny, nz], t * 3);
    // angle at each corner as its weight
    for (let c = 0; c < 3; c++) {
      const o = v[c], a = v[(c + 1) % 3], b = v[(c + 2) % 3];
      const ax = a[0] - o[0], ay = a[1] - o[1], az = a[2] - o[2], bx = b[0] - o[0], by = b[1] - o[1], bz = b[2] - o[2];
      const cos = (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz) || 1);
      const w = Math.acos(Math.max(-1, Math.min(1, cos)));
      const i = [ia, ib, ic][c] * 3;
      n[i] += nx * w;
      n[i + 1] += ny * w;
      n[i + 2] += nz * w;
    }
  }
  for (let i = 0; i < nv; i++) {
    const l = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]) || 1;
    n[i * 3] /= l;
    n[i * 3 + 1] /= l;
    n[i * 3 + 2] /= l;
  }
  // stretch: the smallest cos between the vertex normal and its faces (kept within reason so sharp creases do not shoot off)
  const minCos = new Float32Array(nv).fill(1);
  for (let t = 0; t < nt; t++)
    for (let c = 0; c < 3; c++) {
      const i = idx[t * 3 + c];
      const d = n[i * 3] * fn[t * 3] + n[i * 3 + 1] * fn[t * 3 + 1] + n[i * 3 + 2] * fn[t * 3 + 2];
      if (d < minCos[i]) minCos[i] = d;
    }
  const k = new Float32Array(nv);
  for (let i = 0; i < nv; i++) k[i] = 1 / Math.max(0.5, minCos[i]);
  return { n, k };
}

/** Boundary half-edges of a sheet as (from, to) vertex pairs, in the sheet's own direction. */
function boundaryEdges(m: MeshData): [number, number][] {
  const idx = m.indices;
  const count = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let t = 0; t < idx.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const k = key(idx[t + e], idx[t + ((e + 1) % 3)]);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  const out: [number, number][] = [];
  for (let t = 0; t < idx.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e], b = idx[t + ((e + 1) % 3)];
      if (count.get(key(a, b)) === 1) out.push([a, b]);
    }
  return out;
}

const countLoops = (edges: [number, number][]) => {
  const next = new Map(edges.map(([a, b]) => [a, b]));
  const seen = new Set<number>();
  let loops = 0;
  for (const [a] of edges) {
    if (seen.has(a)) continue;
    loops++;
    let v: number | undefined = a;
    while (v !== undefined && !seen.has(v)) {
      seen.add(v);
      v = next.get(v);
    }
  }
  return loops;
};

/** The two layers of every surface vertex: [top layer positions, bottom layer positions]. */
function layers(s: MeshData, p: SolidifyParams): [Float32Array, Float32Array] {
  const P = s.positions, nv = P.length / 3;
  const A = new Float32Array(P.length), B = new Float32Array(P.length);
  if (p.mode === 'base') {
    // top: the surface off by the gap (away from the base), bottom: the base plane straight below / above
    const { n, k } = vertexOffsets(s);
    const sign = p.baseDir === 'down' ? 1 : -1;
    let lim = sign > 0 ? Infinity : -Infinity;
    for (let i = 0; i < nv; i++) {
      // the gap is taken along the normal, towards the base (the cradle stands off the part)
      const g = n[i * 3 + 2] * sign <= 0 ? p.gap * k[i] : -p.gap * k[i];
      for (let c = 0; c < 3; c++) A[i * 3 + c] = P[i * 3 + c] + n[i * 3 + c] * g;
      lim = sign > 0 ? Math.min(lim, A[i * 3 + 2]) : Math.max(lim, A[i * 3 + 2]);
    }
    const zBase = lim - sign * Math.max(0.01, p.baseThickness);
    for (let i = 0; i < nv; i++) {
      B[i * 3] = A[i * 3];
      B[i * 3 + 1] = A[i * 3 + 1];
      B[i * 3 + 2] = zBase;
    }
    return [A, B];
  }
  const { n, k } = vertexOffsets(s);
  const t = Math.max(0.01, p.thickness);
  const [o1, o2] = p.side === 'both' ? [-t / 2, t / 2] : p.side === 'out' ? [p.gap, p.gap + t] : [-p.gap, -p.gap - t];
  for (let i = 0; i < nv; i++)
    for (let c = 0; c < 3; c++) {
      A[i * 3 + c] = P[i * 3 + c] + n[i * 3 + c] * o1 * k[i];
      B[i * 3 + c] = P[i * 3 + c] + n[i * 3 + c] * o2 * k[i];
    }
  return [A, B];
}

/** Both layers joined by walls along the sheet's edges: a closed mesh (outward facing). */
function shell(s: MeshData, A: Float32Array, B: Float32Array, edges: [number, number][]): MeshData {
  const nv = s.positions.length / 3, idx = s.indices, nt = idx.length / 3;
  const pos = new Float32Array(nv * 6);
  pos.set(A, 0);
  pos.set(B, nv * 3);
  const out = new Uint32Array(nt * 6 + edges.length * 6);
  let o = 0;
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    out[o++] = a;
    out[o++] = b;
    out[o++] = c;
    // the other layer faces the other way
    out[o++] = c + nv;
    out[o++] = b + nv;
    out[o++] = a + nv;
  }
  for (const [a, b] of edges) {
    out[o++] = b;
    out[o++] = a;
    out[o++] = a + nv;
    out[o++] = b;
    out[o++] = a + nv;
    out[o++] = b + nv;
  }
  let m: MeshData = { positions: pos, indices: out };
  if (signedVolume(m) < 0) {
    const f = out.slice();
    for (let i = 0; i < f.length; i += 3) [f[i + 1], f[i + 2]] = [f[i + 2], f[i + 1]];
    m = { positions: pos, indices: f };
  }
  return m;
}

/** The same solid as the union of one prism per surface triangle (never folds over itself). */
async function prismUnion(s: MeshData, A: Float32Array, B: Float32Array): Promise<MeshData> {
  const w = await getManifold();
  const M = w.Manifold;
  const idx = s.indices;
  const pieces: Manifold[] = [];
  try {
    for (let t = 0; t < idx.length; t += 3) {
      const pts: [number, number, number][] = [];
      for (let c = 0; c < 3; c++) {
        const i = idx[t + c] * 3;
        pts.push([A[i], A[i + 1], A[i + 2]], [B[i], B[i + 1], B[i + 2]]);
      }
      const h = M.hull(pts);
      if (h.isEmpty() || h.volume() < 1e-9) {
        h.delete();
        continue;
      }
      pieces.push(h);
    }
    if (!pieces.length) return { positions: new Float32Array(0), indices: new Uint32Array(0) };
    const all = M.union(pieces);
    const mesh = fromManifold(all);
    all.delete();
    return mesh;
  } finally {
    pieces.forEach((x) => x.delete());
  }
}

/**
 * Make a solid from a surface: `mesh` with the triangles `tris` (or all of it)
 * as the surface, in world space.
 */
export async function surfaceToSolid(
  mesh: MeshData,
  tris: ArrayLike<number> | null,
  p: SolidifyParams,
  opts: { sheet?: boolean } = {},
): Promise<SolidifyResult> {
  let s = extractSurface(mesh, tris);
  if (!s.indices.length) throw new Error('The surface has no triangles');
  let leftOut = 0;
  if (p.mode === 'base' && p.facingOnly !== false) {
    // only what faces the base can be filled straight to it without passing through the part
    const sign = p.baseDir === 'down' ? 1 : -1;
    const nt = triangleCount(s);
    const nz = new Float32Array(nt), area = new Float32Array(nt);
    const P = s.positions, I = s.indices;
    for (let t = 0; t < nt; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const z = ux * vy - uy * vx, l = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, z);
      nz[t] = l > 0 ? (z / l) * sign : 0;
      area[t] = l;
    }
    // a loose sheet (whole open part) has no inside: turn it to face the base if most of it faces away
    if (opts.sheet && boundaryEdges(s).length) {
      let toward = 0, away = 0;
      for (let t = 0; t < nt; t++) (nz[t] < 0 ? (toward += area[t]) : (away += area[t]));
      if (away > toward) {
        const f = s.indices.slice();
        for (let i = 0; i < f.length; i += 3) [f[i + 1], f[i + 2]] = [f[i + 2], f[i + 1]];
        s = { positions: s.positions, indices: f };
        for (let t = 0; t < nt; t++) nz[t] = -nz[t];
      }
    }
    const kept = compactMesh(subsetTriangles(s, (t) => nz[t] < -0.02));
    leftOut = nt - triangleCount(kept);
    if (!kept.indices.length) throw new Error(`No part of the surface faces ${p.baseDir === 'down' ? 'down' : 'up'} towards the base: pick the ${p.baseDir === 'down' ? 'underside' : 'top'} of the part, or change "Fill towards"`);
    s = kept;
  }
  const edges = boundaryEdges(s);
  const [A, B] = layers(s, p);
  let out = shell(s, A, B, edges);
  let prisms = false;
  // folded over itself (tight curves, thick walls): rebuild from prisms, on a lighter surface when it is very fine
  const rep = findIntersections(out, 200000);
  if (rep.intersecting.length + rep.overlapping.length > 0) {
    prisms = true;
    let src = s;
    if (triangleCount(s) > 60000) src = extractSurface(simplifyMesh(s, 60000 / triangleCount(s)).mesh);
    const [A2, B2] = src === s ? [A, B] : layers(src, p);
    out = await prismUnion(src, A2, B2);
  }
  return { mesh: out, surfaceTris: triangleCount(s), leftOut, loops: countLoops(edges), prisms, volume: Math.abs(signedVolume(out)) };
}
