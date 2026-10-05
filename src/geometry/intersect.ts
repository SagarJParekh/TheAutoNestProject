import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import { MeshBVH, ExtendedTriangle } from 'three-mesh-bvh';
import { MeshData, triangleCount, computeBounds, boundsDiagonal, ProgressFn, noProgress } from './mesh';
import { removeTriangles } from './mesh';

export interface IntersectionReport {
  /** triangles that cross another triangle of the mesh */
  intersecting: Uint32Array;
  /** triangles overlapping another coplanar triangle (z-fighting double surfaces) */
  overlapping: Uint32Array;
  pairs: number;
  /** true if the pair limit was reached */
  truncated: boolean;
  /** overlapping pairs [a, b, a, b, ...] */
  overlapPairs: Uint32Array;
}

/**
 * Find self-intersecting and coplanar-overlapping triangles with a BVH
 * self-test. Triangles sharing a vertex index are not compared, and each
 * triangle is shrunk very slightly so mere touching is not reported.
 */
export function findIntersections(mesh: MeshData, maxPairs = 500000, onProgress: ProgressFn = noProgress): IntersectionReport {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  g.setIndex(new BufferAttribute(mesh.indices, 1));
  const bvh = new MeshBVH(g, { indirect: true } as never);
  const nt = triangleCount(mesh);
  const idx = mesh.indices;
  const eps = boundsDiagonal(computeBounds(mesh.positions)) * 1e-6;
  const crossing = new Uint8Array(nt);
  const coplanar = new Uint8Array(nt);
  const overlapPairs: number[] = [];
  let pairs = 0;
  let truncated = false;
  const t1 = new ExtendedTriangle(), t2 = new ExtendedTriangle();
  const n1 = new Vector3(), n2 = new Vector3(), c = new Vector3();
  const shrink = (src: ExtendedTriangle, dst: ExtendedTriangle) => {
    c.copy(src.a).add(src.b).add(src.c).multiplyScalar(1 / 3);
    dst.a.copy(src.a).lerp(c, 1e-4);
    dst.b.copy(src.b).lerp(c, 1e-4);
    dst.c.copy(src.c).lerp(c, 1e-4);
    dst.needsUpdate = true;
  };
  let visited = 0;
  bvh.bvhcast(bvh, new Matrix4(), {
    intersectsTriangles: (a: ExtendedTriangle, b: ExtendedTriangle, i1: number, i2: number) => {
      const ta = bvh.resolveTriangleIndex(i1), tb = bvh.resolveTriangleIndex(i2);
      if (ta >= tb) return false;
      if ((++visited & 0xffff) === 0) onProgress(Math.min(0.95, visited / (nt * 8)), 'Testing triangle pairs');
      const a0 = idx[ta * 3], a1 = idx[ta * 3 + 1], a2 = idx[ta * 3 + 2];
      const b0 = idx[tb * 3], b1 = idx[tb * 3 + 1], b2 = idx[tb * 3 + 2];
      if (a0 === b0 || a0 === b1 || a0 === b2 || a1 === b0 || a1 === b1 || a1 === b2 || a2 === b0 || a2 === b1 || a2 === b2) return false;
      shrink(a, t1);
      shrink(b, t2);
      if (!t1.intersectsTriangle(t2)) return false;
      a.getNormal(n1);
      b.getNormal(n2);
      const isCoplanar = Math.abs(n1.dot(n2)) > 0.99999 && Math.abs(n1.dot(c.copy(b.a).sub(a.a))) < eps;
      if (isCoplanar) {
        coplanar[ta] = coplanar[tb] = 1;
        overlapPairs.push(ta, tb);
      } else {
        crossing[ta] = crossing[tb] = 1;
      }
      if (++pairs >= maxPairs) {
        truncated = true;
        return true;
      }
      return false;
    },
  } as never);
  const list = (f: Uint8Array) => {
    const out: number[] = [];
    for (let i = 0; i < f.length; i++) if (f[i]) out.push(i);
    return Uint32Array.from(out);
  };
  return { intersecting: list(crossing), overlapping: list(coplanar), pairs, truncated, overlapPairs: Uint32Array.from(overlapPairs) };
}

/** Remove the smaller triangle of every coplanar overlapping pair. */
export function removeOverlappingTriangles(mesh: MeshData, report = findIntersections(mesh)): { mesh: MeshData; removed: number } {
  const p = mesh.positions, idx = mesh.indices;
  const area = (t: number) => {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  const drop = new Set<number>();
  const pp = report.overlapPairs;
  for (let i = 0; i < pp.length; i += 2) {
    const a = pp[i], b = pp[i + 1];
    if (drop.has(a) || drop.has(b)) continue;
    drop.add(area(a) < area(b) ? a : b);
  }
  if (!drop.size) return { mesh, removed: 0 };
  return { mesh: removeTriangles(mesh, Uint32Array.from(drop)), removed: drop.size };
}
