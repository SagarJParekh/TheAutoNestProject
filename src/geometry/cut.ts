import { MeshData, Plane, FloatBuffer, IndexBuffer, compactMesh, computeBounds, boundsDiagonal, triangleCount } from './mesh';
import { buildTopology } from './topology';
import { findBoundaryLoops } from './holes';
import { planeBasis, triangulateNestedLoops } from './triangulate';

export interface CutResult {
  /** part on the positive side of the plane (dot(n,p) > constant) */
  above: MeshData;
  /** part on the negative side */
  below: MeshData;
  /** number of cap loops added to each side */
  capLoops: number;
}

/**
 * Split a mesh by a plane into two parts and close the cut with planar caps.
 * Works on any indexed mesh; caps are only complete where the input is closed.
 */
export function cutMesh(mesh: MeshData, plane: Plane, cap = true): CutResult {
  const n = plane.normal;
  const c = plane.constant;
  const p = mesh.positions;
  const nv = p.length / 3;
  const eps = Math.max(1e-9, boundsDiagonal(computeBounds(p)) * 1e-7);
  const s = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    const d = n[0] * p[v * 3] + n[1] * p[v * 3 + 1] + n[2] * p[v * 3 + 2] - c;
    s[v] = Math.abs(d) < eps ? 0 : d;
  }
  const pos = new FloatBuffer(p.length + 1024);
  pos.data.set(p);
  pos.length = p.length;
  const onPlane: number[] = [];
  for (let v = 0; v < nv; v++) if (s[v] === 0) onPlane.push(v);
  const edgeCache = new Map<number, number>();
  const split = (a: number, b: number): number => {
    const key = a < b ? a * nv + b : b * nv + a;
    let id = edgeCache.get(key);
    if (id !== undefined) return id;
    const t = s[a] / (s[a] - s[b]);
    id = pos.push3(
      p[a * 3] + (p[b * 3] - p[a * 3]) * t,
      p[a * 3 + 1] + (p[b * 3 + 1] - p[a * 3 + 1]) * t,
      p[a * 3 + 2] + (p[b * 3 + 2] - p[a * 3 + 2]) * t,
    );
    edgeCache.set(key, id);
    onPlane.push(id);
    return id;
  };

  const above = new IndexBuffer(mesh.indices.length);
  const below = new IndexBuffer(mesh.indices.length);
  const idx = mesh.indices;
  const nt = triangleCount(mesh);
  const pa: number[] = [];
  const pb: number[] = [];
  for (let t = 0; t < nt; t++) {
    const v0 = idx[t * 3], v1 = idx[t * 3 + 1], v2 = idx[t * 3 + 2];
    const s0 = s[v0], s1 = s[v1], s2 = s[v2];
    if (s0 >= 0 && s1 >= 0 && s2 >= 0 && (s0 > 0 || s1 > 0 || s2 > 0)) {
      above.push3(v0, v1, v2);
      continue;
    }
    if (s0 <= 0 && s1 <= 0 && s2 <= 0 && (s0 < 0 || s1 < 0 || s2 < 0)) {
      below.push3(v0, v1, v2);
      continue;
    }
    if (s0 === 0 && s1 === 0 && s2 === 0) {
      // coplanar with the cut: a face whose outward normal is +n belongs to the lower part
      const ax = p[v1 * 3] - p[v0 * 3], ay = p[v1 * 3 + 1] - p[v0 * 3 + 1], az = p[v1 * 3 + 2] - p[v0 * 3 + 2];
      const bx = p[v2 * 3] - p[v0 * 3], by = p[v2 * 3 + 1] - p[v0 * 3 + 1], bz = p[v2 * 3 + 2] - p[v0 * 3 + 2];
      const dn = (ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2];
      (dn > 0 ? below : above).push3(v0, v1, v2);
      continue;
    }
    pa.length = 0;
    pb.length = 0;
    const vs = [v0, v1, v2];
    for (let i = 0; i < 3; i++) {
      const a = vs[i], b = vs[(i + 1) % 3];
      const sa = s[a], sb = s[b];
      if (sa >= 0) pa.push(a);
      if (sa <= 0) pb.push(a);
      if ((sa > 0 && sb < 0) || (sa < 0 && sb > 0)) {
        const m = split(a, b);
        pa.push(m);
        pb.push(m);
      }
    }
    for (let i = 1; i + 1 < pa.length; i++) above.push3(pa[0], pa[i], pa[i + 1]);
    for (let i = 1; i + 1 < pb.length; i++) below.push3(pb[0], pb[i], pb[i + 1]);
  }

  const positions = pos.toArray();
  const planeFlag = new Uint8Array(positions.length / 3);
  for (const v of onPlane) planeFlag[v] = 1;

  let capLoops = 0;
  const closeSide = (buf: IndexBuffer, capNormal: [number, number, number]): MeshData => {
    let m: MeshData = { positions, indices: buf.toArray() };
    if (!cap || m.indices.length === 0) return compactMesh(m);
    const loops = findBoundaryLoops(m, buildTopology(m)).filter((l) => l.vertices.every((v) => planeFlag[v] === 1));
    if (loops.length === 0) return compactMesh(m);
    capLoops = Math.max(capLoops, loops.length);
    const { u, v } = planeBasis(capNormal);
    const flat: Float64Array[] = loops.map((l) => {
      const a = new Float64Array(l.vertices.length * 2);
      for (let i = 0; i < l.vertices.length; i++) {
        const o = l.vertices[i] * 3;
        const x = positions[o], y = positions[o + 1], z = positions[o + 2];
        a[i * 2] = x * u[0] + y * u[1] + z * u[2];
        a[i * 2 + 1] = x * v[0] + y * v[1] + z * v[2];
      }
      return a;
    });
    const allVerts: number[] = [];
    for (const l of loops) for (const vtx of l.vertices) allVerts.push(vtx);
    const tris = triangulateNestedLoops(flat);
    const extra = new IndexBuffer(m.indices.length + tris.length);
    extra.data.set(m.indices);
    extra.length = m.indices.length;
    for (let i = 0; i < tris.length; i += 3) extra.push3(allVerts[tris[i]], allVerts[tris[i + 1]], allVerts[tris[i + 2]]);
    m = { positions, indices: extra.toArray() };
    return compactMesh(m);
  };

  return {
    above: closeSide(above, [-n[0], -n[1], -n[2]]),
    below: closeSide(below, [n[0], n[1], n[2]]),
    capLoops,
  };
}
