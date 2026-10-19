/**
 * Collision check between placed parts (world-space meshes): surfaces that
 * cross each other, a part sitting inside another, and (optionally) parts
 * closer than a clearance.
 */
import { BufferAttribute, BufferGeometry, DoubleSide, Line3, Matrix4, Ray, Vector3 } from 'three';
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh';
import type { MeshData, Vec3 } from './mesh';

export interface Collision {
  a: string;
  b: string;
  kind: 'intersect' | 'inside' | 'too-close';
  /** where it happens (world, a few sample points) */
  points: Vec3[];
  /** closest distance between the surfaces for 'too-close', mm */
  distance?: number;
}

function bvhOf(mesh: MeshData): MeshBVH {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  g.setIndex(new BufferAttribute(mesh.indices.slice(), 1));
  return new MeshBVH(g);
}

function boundsOf(mesh: MeshData) {
  const p = mesh.positions;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let c = 0; c < 3; c++) {
      if (p[i + c] < lo[c]) lo[c] = p[i + c];
      if (p[i + c] > hi[c]) hi[c] = p[i + c];
    }
  return { lo, hi };
}

/** Is point inside a closed mesh (ray parity)? */
function inside(bvh: MeshBVH, pt: Vector3): boolean {
  const ray = new Ray(pt.clone(), new Vector3(0.5773, 0.5774, 0.5775).normalize());
  return bvh.raycast(ray, DoubleSide).length % 2 === 1;
}

export function findCollisions(items: { key: string; mesh: MeshData }[], clearance = 0, maxPoints = 12, onProgress?: (f: number) => void): Collision[] {
  const bvhs = items.map((it) => bvhOf(it.mesh));
  const boxes = items.map((it) => boundsOf(it.mesh));
  const out: Collision[] = [];
  const identity = new Matrix4();
  const line = new Line3();
  const pairs: [number, number][] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const A = boxes[i], B = boxes[j];
      let apart = false;
      for (let c = 0; c < 3; c++) if (A.lo[c] > B.hi[c] + clearance || B.lo[c] > A.hi[c] + clearance) apart = true;
      if (!apart) pairs.push([i, j]);
    }
  pairs.forEach(([i, j], n) => {
    const points: Vec3[] = [];
    bvhs[i].bvhcast(bvhs[j], identity, {
      intersectsTriangles(t1: ExtendedTriangle, t2: ExtendedTriangle) {
        if (t1.intersectsTriangle(t2, line)) {
          const m = line.getCenter(new Vector3());
          points.push([m.x, m.y, m.z]);
          if (points.length >= maxPoints) return true;
        }
        return false;
      },
    });
    if (points.length) out.push({ a: items[i].key, b: items[j].key, kind: 'intersect', points });
    else {
      // no crossing surfaces: one part may be fully inside the other
      const pa = items[i].mesh.positions, pb = items[j].mesh.positions;
      const va = new Vector3(pa[0], pa[1], pa[2]), vb = new Vector3(pb[0], pb[1], pb[2]);
      if (inside(bvhs[j], va)) out.push({ a: items[i].key, b: items[j].key, kind: 'inside', points: [[va.x, va.y, va.z]] });
      else if (inside(bvhs[i], vb)) out.push({ a: items[i].key, b: items[j].key, kind: 'inside', points: [[vb.x, vb.y, vb.z]] });
      else if (clearance > 0) {
        // closer than the clearance?
        const target1 = { point: new Vector3(), distance: 0, faceIndex: 0 };
        const target2 = { point: new Vector3(), distance: 0, faceIndex: 0 };
        const g = (bvhs[j] as unknown as { geometry: BufferGeometry }).geometry;
        const r = bvhs[i].closestPointToGeometry(g, identity, target1, target2, 0, clearance);
        if (r && r.distance < clearance - 1e-6) {
          const m = target1.point.clone().add(target2.point).multiplyScalar(0.5);
          out.push({ a: items[i].key, b: items[j].key, kind: 'too-close', points: [[m.x, m.y, m.z]], distance: r.distance });
        }
      }
    }
    onProgress?.((n + 1) / pairs.length);
  });
  return out;
}
