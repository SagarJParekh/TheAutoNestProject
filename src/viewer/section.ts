import { Plane, Vector3 } from 'three';
import { INTERSECTED, NOT_INTERSECTED, MeshBVH } from 'three-mesh-bvh';

const a = new Vector3(), b = new Vector3(), c = new Vector3();

/**
 * Intersection segments of a plane with a mesh (local space), using the BVH
 * to only visit triangles whose bounds straddle the plane.
 */
export function sectionSegments(bvh: MeshBVH, plane: Plane): Float32Array {
  const out: number[] = [];
  const pts: Vector3[] = [new Vector3(), new Vector3()];
  bvh.shapecast({
    intersectsBounds: (box) => (plane.intersectsBox(box) ? INTERSECTED : NOT_INTERSECTED),
    intersectsTriangle: (tri) => {
      a.copy(tri.a); b.copy(tri.b); c.copy(tri.c);
      const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b), dc = plane.distanceToPoint(c);
      let n = 0;
      const edge = (p: Vector3, q: Vector3, dp: number, dq: number) => {
        if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
          const t = dp / (dp - dq);
          if (n < 2) pts[n++].lerpVectors(p, q, t);
        }
      };
      edge(a, b, da, db);
      edge(b, c, db, dc);
      edge(c, a, dc, da);
      if (n === 2) out.push(pts[0].x, pts[0].y, pts[0].z, pts[1].x, pts[1].y, pts[1].z);
      return false;
    },
  });
  return Float32Array.from(out);
}
