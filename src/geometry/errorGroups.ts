/**
 * Group the problems found by the analysis (open / non-manifold edges,
 * flipped / degenerate / intersecting triangles) into connected clusters,
 * so each one can be listed, zoomed to and fixed on its own.
 */
import type { AnalysisReport } from './analysis';
import type { MeshData, Vec3 } from './mesh';

export type ErrorKind = 'open' | 'crack' | 'nonManifold' | 'flipped' | 'degenerate' | 'intersecting' | 'overlapping';

export interface ErrorGroup {
  kind: ErrorKind;
  /** edge problems: line segments (xyz xyz, part-local) */
  segs?: Float32Array;
  /** triangle problems: triangle ids */
  tris?: Uint32Array;
  /** number of edges / triangles */
  count: number;
  /** part-local bounding box */
  min: Vec3;
  max: Vec3;
}

export const ERROR_LABEL: Record<ErrorKind, [string, string]> = {
  open: ['Open edges', 'edge'],
  crack: ['Crack', 'edge'],
  nonManifold: ['Non-manifold edges', 'edge'],
  flipped: ['Flipped triangles', 'triangle'],
  degenerate: ['Degenerate triangles', 'triangle'],
  intersecting: ['Self-intersection', 'triangle'],
  overlapping: ['Overlapping triangles', 'triangle'],
};

class UnionFind {
  parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(a: number): number {
    const p = this.parent;
    while (p[a] !== a) {
      p[a] = p[p[a]];
      a = p[a];
    }
    return a;
  }
  union(a: number, b: number) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function keyOf(x: number, y: number, z: number, q: number) {
  return `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
}

function bboxOf(pts: ArrayLike<number>, count: number, at: (i: number) => number): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const o = at(i);
    for (let c = 0; c < 3; c++) {
      const v = pts[o + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

/** Connected chains of segments (segments touching at an end point belong together). */
export function segmentGroups(seg: Float32Array, kind: ErrorKind, quant = 1e-5): ErrorGroup[] {
  const ns = seg.length / 6;
  if (!ns) return [];
  const uf = new UnionFind(ns);
  const first = new Map<string, number>();
  for (let s = 0; s < ns; s++) {
    for (let e = 0; e < 2; e++) {
      const o = s * 6 + e * 3;
      const k = keyOf(seg[o], seg[o + 1], seg[o + 2], quant);
      const f = first.get(k);
      if (f === undefined) first.set(k, s);
      else uf.union(s, f);
    }
  }
  const members = new Map<number, number[]>();
  for (let s = 0; s < ns; s++) {
    const r = uf.find(s);
    let m = members.get(r);
    if (!m) members.set(r, (m = []));
    m.push(s);
  }
  const out: ErrorGroup[] = [];
  for (const m of members.values()) {
    const segs = new Float32Array(m.length * 6);
    m.forEach((s, i) => segs.set(seg.subarray(s * 6, s * 6 + 6), i * 6));
    const b = bboxOf(segs, m.length * 2, (i) => i * 3);
    out.push({ kind, segs, count: m.length, ...b });
  }
  return out;
}

/** Clusters of triangles that share a vertex (by index or by position). */
export function triangleGroups(mesh: MeshData, tris: ArrayLike<number>, kind: ErrorKind, quant = 1e-5): ErrorGroup[] {
  const n = tris.length;
  if (!n) return [];
  const p = mesh.positions, idx = mesh.indices;
  const uf = new UnionFind(n);
  const first = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const t = tris[i];
    for (let c = 0; c < 3; c++) {
      const v = idx[t * 3 + c] * 3;
      const k = keyOf(p[v], p[v + 1], p[v + 2], quant);
      const f = first.get(k);
      if (f === undefined) first.set(k, i);
      else uf.union(i, f);
    }
  }
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    let m = members.get(r);
    if (!m) members.set(r, (m = []));
    m.push(tris[i]);
  }
  const out: ErrorGroup[] = [];
  for (const m of members.values()) {
    const b = bboxOf(p, m.length * 3, (i) => idx[m[(i / 3) | 0] * 3 + (i % 3)] * 3);
    out.push({ kind, tris: Uint32Array.from(m), count: m.length, ...b });
  }
  return out;
}

const ORDER: ErrorKind[] = ['open', 'crack', 'nonManifold', 'flipped', 'intersecting', 'overlapping', 'degenerate'];

/** All problem clusters of a part, worst kinds first, larger clusters first within a kind. */
export function errorGroups(
  mesh: MeshData,
  report: AnalysisReport,
  intersections?: { intersecting: ArrayLike<number>; overlapping: ArrayLike<number> } | null,
  maxPerKind = 500,
): ErrorGroup[] {
  const h = report.highlights;
  const groups: ErrorGroup[] = [
    ...segmentGroups(h.openEdges, 'open'),
    ...segmentGroups(h.crackEdges ?? new Float32Array(0), 'crack'),
    ...segmentGroups(h.nonManifoldEdges, 'nonManifold'),
    ...triangleGroups(mesh, h.flippedTriangles, 'flipped'),
    ...triangleGroups(mesh, h.degenerateTriangles, 'degenerate'),
  ];
  if (intersections) {
    groups.push(...triangleGroups(mesh, intersections.intersecting, 'intersecting'));
    groups.push(...triangleGroups(mesh, intersections.overlapping, 'overlapping'));
  }
  const out: ErrorGroup[] = [];
  for (const k of ORDER) out.push(...groups.filter((g) => g.kind === k).sort((a, b) => b.count - a.count).slice(0, maxPerKind));
  return out;
}

/**
 * Triangles touching a group: the group's own triangles, or for edge
 * problems the triangles that use any of the edge end points.
 */
export function trianglesOfGroup(mesh: MeshData, g: ErrorGroup, quant = 1e-5): number[] {
  if (g.tris) return Array.from(g.tris);
  const seg = g.segs!;
  const keys = new Set<string>();
  for (let i = 0; i < seg.length; i += 3) keys.add(keyOf(seg[i], seg[i + 1], seg[i + 2], quant));
  const p = mesh.positions, idx = mesh.indices;
  const nv = p.length / 3;
  const hit = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) if (keys.has(keyOf(p[v * 3], p[v * 3 + 1], p[v * 3 + 2], quant))) hit[v] = 1;
  const out: number[] = [];
  const nt = idx.length / 3;
  for (let t = 0; t < nt; t++) if (hit[idx[t * 3]] || hit[idx[t * 3 + 1]] || hit[idx[t * 3 + 2]]) out.push(t);
  return out;
}
