import { DoubleSide, Ray } from 'three';
import { MeshData, Vec3 } from './mesh';
import { buildTopology, heFrom, heTo, Topology } from './topology';
import { regionBoundaryHalfEdges, regionNormal } from './select';
import { planeBasis } from './triangulate';
import { extrudePolygon, regularPolygon } from './primitives';
import { makeBVH } from './sdf';

export type PerforationPattern = 'round' | 'hex' | 'square';

export interface PerforationParams {
  pattern: PerforationPattern;
  /** hole size: diameter (round), across-flats (hex) or side length (square), mm */
  size: number;
  /** web width between neighbouring holes, mm */
  spacing: number;
  /** minimum distance from holes to the region border, mm */
  margin: number;
  /** cut depth in mm; 0 = automatic (through the wall, found by ray casting) */
  depth?: number;
  /** pattern rotation in degrees */
  angle?: number;
  /** safety cap on the number of holes */
  maxHoles?: number;
  /**
   * hole size at the exit end for tapered (conical) holes; 0/undefined = straight.
   * Same unit as `size` (diameter, across flats or side).
   */
  exitSize?: number;
}

export interface PerforationPlan {
  normal: Vec3;
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  /** hole centres on the region plane */
  centers: Vec3[];
  /** circumradius of each hole polygon */
  radius: number;
  sides: number;
  /** polygon rotation in radians within the (already rotated) u/v frame */
  rotation: number;
  /** preview outline segments (xyz xyz) */
  outlines: Float32Array;
  truncated: boolean;
}

function shape(params: PerforationParams): { radius: number; sides: number; rotation: number } {
  switch (params.pattern) {
    case 'hex':
      return { radius: params.size / Math.sqrt(3), sides: 6, rotation: Math.PI / 6 };
    case 'square':
      return { radius: params.size / Math.SQRT2, sides: 4, rotation: Math.PI / 4 };
    default:
      return { radius: params.size / 2, sides: 32, rotation: 0 };
  }
}

/** Lay out a hole pattern on a (near-)planar triangle region. */
export function planPerforation(
  mesh: MeshData,
  regionTris: ArrayLike<number>,
  params: PerforationParams,
  topo: Topology = buildTopology(mesh),
): PerforationPlan {
  const { normal, centroid } = regionNormal(mesh, regionTris);
  const basis = planeBasis(normal);
  const ang = ((params.angle ?? 0) * Math.PI) / 180;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const u: Vec3 = [
    basis.u[0] * ca + basis.v[0] * sa, basis.u[1] * ca + basis.v[1] * sa, basis.u[2] * ca + basis.v[2] * sa,
  ];
  const v: Vec3 = [
    -basis.u[0] * sa + basis.v[0] * ca, -basis.u[1] * sa + basis.v[1] * ca, -basis.u[2] * sa + basis.v[2] * ca,
  ];
  const p = mesh.positions, idx = mesh.indices;
  const proj = (vi: number): [number, number] => {
    const x = p[vi * 3] - centroid[0], y = p[vi * 3 + 1] - centroid[1], z = p[vi * 3 + 2] - centroid[2];
    return [x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]];
  };
  // 2D triangles of the region
  const tri2 = new Float64Array(regionTris.length * 6);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < regionTris.length; i++) {
    const t = regionTris[i];
    for (let k = 0; k < 3; k++) {
      const [x, y] = proj(idx[t * 3 + k]);
      tri2[i * 6 + k * 2] = x;
      tri2[i * 6 + k * 2 + 1] = y;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const border: number[] = [];
  for (const h of regionBoundaryHalfEdges(mesh, regionTris, topo)) {
    const a = proj(heFrom(mesh, h)), b = proj(heTo(mesh, h));
    border.push(a[0], a[1], b[0], b[1]);
  }
  const inRegion = (x: number, y: number) => {
    for (let i = 0; i < regionTris.length; i++) {
      const o = i * 6;
      const ax = tri2[o], ay = tri2[o + 1], bx = tri2[o + 2], by = tri2[o + 3], cx = tri2[o + 4], cy = tri2[o + 5];
      if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) continue;
      const d1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      const d2 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
      const d3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
      const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) return true;
    }
    return false;
  };
  const distToBorder = (x: number, y: number) => {
    let best = Infinity;
    for (let i = 0; i < border.length; i += 4) {
      const ax = border[i], ay = border[i + 1], bx = border[i + 2], by = border[i + 3];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + dx * t - x, ey = ay + dy * t - y;
      best = Math.min(best, ex * ex + ey * ey);
    }
    return Math.sqrt(best);
  };

  const { radius, sides, rotation } = shape(params);
  const big = Math.max(1, (params.exitSize ?? 0) / params.size);
  const clearance = (params.pattern === 'round' ? params.size / 2 : radius) * big + Math.max(0, params.margin);
  const pitch = Math.max(1e-3, params.size * big + Math.max(0, params.spacing));
  const staggered = params.pattern !== 'square';
  const rowStep = staggered ? (pitch * Math.sqrt(3)) / 2 : pitch;
  const maxHoles = params.maxHoles ?? 20000;
  const centers2: [number, number][] = [];
  const cxm = (minX + maxX) / 2, cym = (minY + maxY) / 2;
  const nCols = Math.ceil((maxX - minX) / pitch / 2) + 2;
  const nRows = Math.ceil((maxY - minY) / rowStep / 2) + 2;
  let truncated = false;
  outer: for (let r = -nRows; r <= nRows; r++) {
    const off = staggered && r & 1 ? pitch / 2 : 0;
    for (let c = -nCols; c <= nCols; c++) {
      const x = cxm + c * pitch + off, y = cym + r * rowStep;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (!inRegion(x, y)) continue;
      if (distToBorder(x, y) < clearance) continue;
      centers2.push([x, y]);
      if (centers2.length >= maxHoles) {
        truncated = true;
        break outer;
      }
    }
  }
  const centers: Vec3[] = centers2.map(([x, y]) => [
    centroid[0] + u[0] * x + v[0] * y,
    centroid[1] + u[1] * x + v[1] * y,
    centroid[2] + u[2] * x + v[2] * y,
  ]);
  // preview outlines, lifted slightly off the surface
  const lift = 0.02 + params.size * 0.01;
  const outlines = new Float32Array(centers.length * sides * 6);
  let o = 0;
  for (const [x, y] of centers2) {
    for (let s = 0; s < sides; s++) {
      for (const k of [s, (s + 1) % sides]) {
        const a = rotation + (k / sides) * Math.PI * 2;
        const px = x + Math.cos(a) * radius, py = y + Math.sin(a) * radius;
        outlines[o++] = centroid[0] + u[0] * px + v[0] * py + normal[0] * lift;
        outlines[o++] = centroid[1] + u[1] * px + v[1] * py + normal[1] * lift;
        outlines[o++] = centroid[2] + u[2] * px + v[2] * py + normal[2] * lift;
      }
    }
  }
  return { normal, origin: centroid, u, v, centers, radius, sides, rotation, outlines, truncated };
}

/** Circumradius ratio exit/entry for a tapered hole (1 = straight). */
export function exitRatioOf(params: PerforationParams): number {
  return params.exitSize && params.exitSize > 0 ? params.exitSize / params.size : 1;
}

/**
 * One cutter: polygon of circumradius r0 at the surface point, axis into the
 * part along -n, depth d; tapering linearly to r0*ratio at depth d. The cutter
 * starts 1 mm outside the surface and ends 1 mm past the exit.
 */
function holeCutter(c: Vec3, n: Vec3, u: Vec3, v: Vec3, r0: number, ratio: number, sides: number, rotation: number, d: number): MeshData {
  const above = 1;
  const r1 = r0 * ratio;
  const slope = (r1 - r0) / Math.max(d, 1e-6);
  const rStart = Math.max(r0 * 0.05, r0 - slope * above);
  const rEnd = Math.max(r0 * 0.05, r0 + slope * (d + 1));
  const base: Vec3 = [c[0] + n[0] * above, c[1] + n[1] * above, c[2] + n[2] * above];
  const poly = regularPolygon(0, 0, rStart, sides, rotation);
  return extrudePolygon(base, u, v, [-n[0], -n[1], -n[2]], poly, above + d + 1, rEnd / rStart);
}

function measureDepth(bvh: ReturnType<typeof makeBVH> | null, c: Vec3, n: Vec3, fixed: number, ray: Ray): number {
  if (!bvh) return fixed;
  const eps = 0.01;
  ray.origin.set(c[0] - n[0] * eps, c[1] - n[1] * eps, c[2] - n[2] * eps);
  ray.direction.set(-n[0], -n[1], -n[2]);
  const hit = bvh.raycastFirst(ray, DoubleSide);
  return hit ? hit.distance + eps : 10;
}

/** A single hole location picked on the surface. */
export interface HolePoint {
  point: Vec3;
  /** outward surface normal */
  normal: Vec3;
}

function holeFrame(normal: Vec3, angleDeg: number) {
  const l = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const n: Vec3 = [normal[0] / l, normal[1] / l, normal[2] / l];
  const b = planeBasis(n);
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const u: Vec3 = [b.u[0] * ca + b.v[0] * sa, b.u[1] * ca + b.v[1] * sa, b.u[2] * ca + b.v[2] * sa];
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return { n, u, v };
}

/** Cutters for individually placed holes (each along its own surface normal). */
export function pointHoleCutters(mesh: MeshData, points: HolePoint[], params: PerforationParams): MeshData[] {
  const { radius, sides, rotation } = shape(params);
  const ratio = exitRatioOf(params);
  const depth = params.depth ?? 0;
  const bvh = depth > 0 ? null : makeBVH(mesh);
  const ray = new Ray();
  return points.map(({ point, normal }) => {
    const { n, u, v } = holeFrame(normal, params.angle ?? 0);
    return holeCutter(point, n, u, v, radius, ratio, sides, rotation, measureDepth(bvh, point, n, depth, ray));
  });
}

/** Preview outlines (entry polygons) for point holes. */
export function pointHoleOutlines(points: HolePoint[], params: PerforationParams): Float32Array {
  const { radius, sides, rotation } = shape(params);
  const out: number[] = [];
  const lift = 0.02 + params.size * 0.01;
  for (const { point, normal } of points) {
    const { n, u, v } = holeFrame(normal, params.angle ?? 0);
    const pt = (k: number) => {
      const t = rotation + (k / sides) * Math.PI * 2;
      const x = Math.cos(t) * radius, y = Math.sin(t) * radius;
      return [0, 1, 2].map((i) => point[i] + u[i] * x + v[i] * y + n[i] * lift);
    };
    for (let k = 0; k < sides; k++) out.push(...pt(k), ...pt(k + 1));
  }
  return Float32Array.from(out);
}

/**
 * Build the cutting prisms (or frustums, for tapered holes) for a plan.
 * Depth is either fixed or measured per hole by casting a ray inward.
 */
export function perforationCutters(mesh: MeshData, plan: PerforationPlan, depth = 0, exitRatio = 1): MeshData[] {
  const n = plan.normal;
  const bvh = depth > 0 ? null : makeBVH(mesh);
  const ray = new Ray();
  return plan.centers.map((c) => holeCutter(c, n, plan.u, plan.v, plan.radius, exitRatio, plan.sides, plan.rotation, measureDepth(bvh, c, n, depth, ray)));
}
