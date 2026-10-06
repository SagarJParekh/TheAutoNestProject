/**
 * Fillet and chamfer of straight sharp edges.
 *
 * For an edge between two flat faces the rounded (or bevelled) corner is
 * exact: a 2D profile (corner region minus a tangent circle, or a corner
 * triangle) is extruded along the edge and removed from convex edges or
 * added to concave (inside) edges with a manifold-3d boolean.
 */
import { MeshData, Vec3 } from './mesh';
import { buildTopology } from './topology';
import { booleanMeshes, fromManifold, getManifold } from './manifold';

export interface SharpEdge {
  /** edge end points (the whole straight run of collinear mesh edges), mm */
  p0: Vec3;
  p1: Vec3;
  /** outward unit normals of the two faces */
  n1: Vec3;
  n2: Vec3;
  /** unit directions from the edge into each face (perpendicular to the edge) */
  t1: Vec3;
  t2: Vec3;
  /** true when the solid angle at the edge is below 180° (an outside corner) */
  convex: boolean;
  /** angle between the faces measured through the solid, degrees */
  angle: number;
}

const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/**
 * The straight sharp edge of `mesh` through the mesh edge closest to the
 * segment a-b (e.g. a snapped edge), extended along collinear mesh edges
 * that border the same two faces.
 */
export function findSharpEdge(mesh: MeshData, a: Vec3, b: Vec3): SharpEdge {
  const p = mesh.positions, idx = mesh.indices;
  const topo = buildTopology(mesh);
  const pt = (v: number): Vec3 => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
  // best matching mesh edge (both end points close to a and b)
  let best = -1, bestD = Infinity;
  for (let e = 0; e < topo.edgeCount; e++) {
    if (topo.edgeFaceCount[e] !== 2) continue;
    const u = pt(topo.edgeV0[e]), v = pt(topo.edgeV1[e]);
    const d1 = Math.hypot(...sub(u, a)) + Math.hypot(...sub(v, b));
    const d2 = Math.hypot(...sub(u, b)) + Math.hypot(...sub(v, a));
    const d = Math.min(d1, d2);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (best < 0) throw new Error('No edge found there');
  const faceInfo = (h: number) => {
    const t = (h / 3) | 0;
    const A = pt(idx[t * 3]), B = pt(idx[t * 3 + 1]), C = pt(idx[t * 3 + 2]);
    const n = norm(cross(sub(B, A), sub(C, A)));
    // the vertex of the triangle not on the edge
    const k = h - t * 3;
    const third = pt(idx[t * 3 + ((k + 2) % 3)]);
    return { n, third };
  };
  const f1 = faceInfo(topo.edgeHE0[best]), f2 = faceInfo(topo.edgeHE1[best]);
  if (dot(f1.n, f2.n) > Math.cos((5 * Math.PI) / 180)) throw new Error('That edge is not sharp (the faces are almost flat there)');
  const v0 = topo.edgeV0[best], v1 = topo.edgeV1[best];
  const dir = norm(sub(pt(v1), pt(v0)));
  // vertex -> edges for walking along the run
  const nv = p.length / 3;
  const start = new Uint32Array(nv + 1);
  for (let e = 0; e < topo.edgeCount; e++) {
    start[topo.edgeV0[e] + 1]++;
    start[topo.edgeV1[e] + 1]++;
  }
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const list = new Uint32Array(topo.edgeCount * 2);
  for (let e = 0; e < topo.edgeCount; e++) {
    list[fill[topo.edgeV0[e]]++] = e;
    list[fill[topo.edgeV1[e]]++] = e;
  }
  const sameFaces = (e: number) => {
    if (topo.edgeFaceCount[e] !== 2) return false;
    const g1 = faceInfo(topo.edgeHE0[e]).n, g2 = faceInfo(topo.edgeHE1[e]).n;
    const c = 0.9995;
    return (dot(g1, f1.n) > c && dot(g2, f2.n) > c) || (dot(g1, f2.n) > c && dot(g2, f1.n) > c);
  };
  const walk = (from: number, sign: number): number => {
    let v = from;
    for (let guard = 0; guard < 100000; guard++) {
      let next = -1;
      for (let i = start[v]; i < start[v + 1]; i++) {
        const e = list[i];
        const w = topo.edgeV0[e] === v ? topo.edgeV1[e] : topo.edgeV0[e];
        const d = norm(sub(pt(w), pt(v)));
        if (dot(d, dir) * sign > 0.99995 && sameFaces(e)) {
          next = w;
          break;
        }
      }
      if (next < 0) return v;
      v = next;
    }
    return v;
  };
  const e0 = walk(v0, -1), e1 = walk(v1, 1);
  const p0 = pt(e0), p1 = pt(e1);
  const perp = (q: Vec3) => {
    const d = sub(q, p0);
    return norm(add(d, dir, -dot(d, dir)));
  };
  const t1 = perp(f1.third), t2 = perp(f2.third);
  const convex = dot(f1.n, sub(f2.third, p0)) < 0;
  const between = (Math.acos(Math.max(-1, Math.min(1, dot(t1, t2)))) * 180) / Math.PI;
  return { p0, p1, n1: f1.n, n2: f2.n, t1, t2, convex, angle: convex ? between : 360 - between };
}

/**
 * Solid that rounds (fillet) or bevels (chamfer) an edge: remove it from
 * the part for a convex edge, add it for a concave one.
 */
export async function edgeBlendSolid(edge: SharpEdge, kind: 'fillet' | 'chamfer', size: number): Promise<MeshData> {
  if (!(size > 0)) throw new Error('The size must be positive');
  const wasm = await getManifold();
  const e = norm(sub(edge.p1, edge.p0));
  const len = Math.hypot(...sub(edge.p1, edge.p0));
  // 2D frame perpendicular to the edge: X = t1, Y = e × X (so X × Y = e)
  const X = edge.t1;
  const Y = cross(e, X);
  const to2 = (v: Vec3): [number, number] => [dot(v, X), dot(v, Y)];
  const t1 = to2(edge.t1), t2 = to2(edge.t2);
  // wedge angle on the side where the tangent circle sits (solid for convex, air for concave)
  const phi = Math.acos(Math.max(-1, Math.min(1, t1[0] * t2[0] + t1[1] * t2[1])));
  if (phi < 1e-3 || phi > Math.PI - 1e-3) throw new Error('The faces at that edge are almost flat');
  const ext = edge.convex ? 1 : -1; // extend the profile into air (cutter) or into the solid (filler)
  const n1 = to2(edge.n1), n2 = to2(edge.n2);
  const s = kind === 'fillet' ? size / Math.tan(phi / 2) : size;
  const T1: [number, number] = [t1[0] * s, t1[1] * s], T2: [number, number] = [t2[0] * s, t2[1] * s];
  // only a small margin past the faces: enough to avoid coplanar faces in the boolean, never
  // deep enough to reach other walls of the part
  const H = Math.max(0.01, Math.min(0.2, size * 0.05));
  // air side of a convex corner (or solid side of a concave one), bounded by the two faces
  const outer: [number, number][] = [
    [0, 0],
    T1,
    [T1[0] + n1[0] * H * ext, T1[1] + n1[1] * H * ext],
    [(n1[0] + n2[0]) * H * ext, (n1[1] + n2[1]) * H * ext],
    [T2[0] + n2[0] * H * ext, T2[1] + n2[1] * H * ext],
    T2,
  ];
  let cs = new wasm.CrossSection([outer], 'NonZero');
  if (kind === 'fillet') {
    const ux = t1[0] + t2[0], uy = t1[1] + t2[1];
    const ul = Math.hypot(ux, uy) || 1;
    const dc = size / Math.sin(phi / 2);
    const C: [number, number] = [(ux / ul) * dc, (uy / ul) * dc];
    const kite = new wasm.CrossSection([[[0, 0], T1, C, T2]], 'NonZero');
    const segs = Math.max(24, Math.min(128, Math.round((size * 2 * Math.PI) / 0.25)));
    const circle = wasm.CrossSection.circle(size, segs).translate(C);
    const blend = kite.subtract(circle);
    const merged = cs.add(blend);
    cs.delete();
    kite.delete();
    circle.delete();
    blend.delete();
    cs = merged;
  } else {
    const tri = new wasm.CrossSection([[[0, 0], T1, T2]], 'NonZero');
    const merged = cs.add(tri);
    cs.delete();
    tri.delete();
    cs = merged;
  }
  const margin = Math.max(1e-3, len * 1e-4);
  const solid = cs.extrude(len + 2 * margin);
  cs.delete();
  const local = fromManifold(solid);
  solid.delete();
  // local (x, y, z) -> world p0 - e*margin + x X + y Y + z e
  const o = add(edge.p0, e, -margin);
  const m = [X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, e[0], e[1], e[2], 0, o[0], o[1], o[2], 1];
  const pos = local.positions;
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return { positions: out, indices: local.indices };
}

/** Fillet or chamfer several edges of a closed part at once. */
export async function blendEdges(mesh: MeshData, edges: SharpEdge[], kind: 'fillet' | 'chamfer', size: number): Promise<MeshData> {
  if (!edges.length) return mesh;
  const cut: MeshData[] = [], fill: MeshData[] = [];
  for (const e of edges) (e.convex ? cut : fill).push(await edgeBlendSolid(e, kind, size));
  let out = mesh;
  if (cut.length) out = await booleanMeshes('subtract', out, cut);
  if (fill.length) out = await booleanMeshes('union', out, fill);
  return out;
}
