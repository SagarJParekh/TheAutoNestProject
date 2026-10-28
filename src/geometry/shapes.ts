/**
 * Basic solid shapes (cube, cylinder, cone, sphere, donut…) as closed,
 * watertight meshes, built with manifold-3d. Every shape stands on Z = 0,
 * centred on the origin in X and Y.
 */
import type { Manifold } from 'manifold-3d';
import { MeshData } from './mesh';
import { fromManifold, getManifold } from './manifold';

export type ShapeKind =
  | 'box' | 'cylinder' | 'cone' | 'sphere' | 'hemisphere' | 'torus' | 'tube' | 'pyramid' | 'prism' | 'wedge' | 'capsule' | 'ellipsoid';

export interface ShapeParams {
  kind: ShapeKind;
  /** box / wedge / ellipsoid: size along X, Y, Z (mm); pyramid: base width = x */
  x: number;
  y: number;
  z: number;
  /** main diameter: cylinder, cone base, sphere, tube outside, prism across corners, capsule; torus: ring (centre line) diameter */
  d: number;
  /** second diameter: cone top (0 = point), tube inside, torus tube */
  d2: number;
  /** height (cylinder, cone, tube, pyramid, prism, capsule total) */
  h: number;
  /** sides of a pyramid / prism */
  sides: number;
  /** smoothness: segments round a full circle */
  segments: number;
}

export const DEFAULT_SHAPE: ShapeParams = { kind: 'box', x: 20, y: 20, z: 20, d: 20, d2: 10, h: 20, sides: 6, segments: 64 };

export const SHAPES: { value: ShapeKind; label: string }[] = [
  { value: 'box', label: 'Cube / box' },
  { value: 'cylinder', label: 'Cylinder' },
  { value: 'cone', label: 'Cone' },
  { value: 'sphere', label: 'Sphere' },
  { value: 'hemisphere', label: 'Hemisphere' },
  { value: 'torus', label: 'Donut (torus)' },
  { value: 'tube', label: 'Tube / pipe' },
  { value: 'pyramid', label: 'Pyramid' },
  { value: 'prism', label: 'Prism' },
  { value: 'wedge', label: 'Wedge' },
  { value: 'capsule', label: 'Capsule' },
  { value: 'ellipsoid', label: 'Ellipsoid' },
];

/** Which fields a shape uses (for the panel). */
export function shapeFields(kind: ShapeKind): (keyof ShapeParams)[] {
  switch (kind) {
    case 'box':
    case 'wedge':
    case 'ellipsoid':
      return ['x', 'y', 'z'];
    case 'cylinder':
    case 'capsule':
      return ['d', 'h'];
    case 'cone':
    case 'tube':
      return ['d', 'd2', 'h'];
    case 'sphere':
    case 'hemisphere':
      return ['d'];
    case 'torus':
      return ['d', 'd2'];
    case 'pyramid':
      return ['x', 'h', 'sides'];
    case 'prism':
      return ['d', 'h', 'sides'];
  }
}

const pos = (v: number, what: string) => {
  if (!(v > 0)) throw new Error(`${what} must be greater than 0`);
  return v;
};

export async function makeShape(p: ShapeParams): Promise<MeshData> {
  const w = await getManifold();
  const M = w.Manifold, C = w.CrossSection;
  const seg = Math.max(8, Math.min(512, Math.round(p.segments) || 64));
  const sides = Math.max(3, Math.min(64, Math.round(p.sides) || 3));
  const tmp: Manifold[] = [];
  const keep = (m: Manifold) => (tmp.push(m), m);
  let m: Manifold;
  try {
    switch (p.kind) {
      case 'box':
        m = M.cube([pos(p.x, 'Width'), pos(p.y, 'Depth'), pos(p.z, 'Height')]).translate([-p.x / 2, -p.y / 2, 0]);
        break;
      case 'cylinder':
        m = M.cylinder(pos(p.h, 'Height'), pos(p.d, 'Diameter') / 2, p.d / 2, seg);
        break;
      case 'cone':
        m = M.cylinder(pos(p.h, 'Height'), pos(p.d, 'Base diameter') / 2, Math.max(0, p.d2) / 2, seg);
        break;
      case 'sphere':
        m = M.sphere(pos(p.d, 'Diameter') / 2, seg).translate([0, 0, p.d / 2]);
        break;
      case 'ellipsoid':
        m = keep(M.sphere(1, seg)).scale([pos(p.x, 'Width') / 2, pos(p.y, 'Depth') / 2, pos(p.z, 'Height') / 2]).translate([0, 0, p.z / 2]);
        break;
      case 'hemisphere': {
        const s = keep(M.sphere(pos(p.d, 'Diameter') / 2, seg));
        m = s.trimByPlane([0, 0, 1], 0);
        break;
      }
      case 'torus': {
        const R = pos(p.d, 'Ring diameter') / 2, r = pos(p.d2, 'Tube diameter') / 2;
        if (r >= R) throw new Error('The tube diameter must be smaller than the ring diameter');
        const c = C.circle(r, Math.max(12, Math.round(seg / 2))).translate([R, 0]);
        m = keep(c.revolve(seg)).translate([0, 0, r]);
        c.delete();
        break;
      }
      case 'tube': {
        const ro = pos(p.d, 'Outside diameter') / 2, ri = Math.max(0, p.d2) / 2;
        if (ri >= ro) throw new Error('The inside diameter must be smaller than the outside diameter');
        const outer = keep(M.cylinder(pos(p.h, 'Height'), ro, ro, seg));
        m = ri > 0 ? outer.subtract(keep(M.cylinder(p.h + 2, ri, ri, seg).translate([0, 0, -1]))) : M.union([outer]);
        break;
      }
      case 'pyramid': {
        // base width measured across flats for a square base, across corners otherwise
        const r = sides === 4 ? (pos(p.x, 'Base width') / 2) * Math.SQRT2 : pos(p.x, 'Base width') / 2;
        m = keep(M.cylinder(pos(p.h, 'Height'), r, 0, sides)).rotate([0, 0, sides === 4 ? 45 : 90]);
        break;
      }
      case 'prism':
        m = keep(M.cylinder(pos(p.h, 'Height'), pos(p.d, 'Diameter') / 2, p.d / 2, sides)).rotate([0, 0, 90]);
        break;
      case 'wedge': {
        // a ramp: full height at -X, down to nothing at +X
        const x = pos(p.x, 'Length'), y = pos(p.y, 'Width'), z = pos(p.z, 'Height');
        const tri = new C([[[0, 0], [x, 0], [0, z]]]);
        m = keep(tri.extrude(y)).rotate([90, 0, 0]).translate([-x / 2, y / 2, 0]);
        tri.delete();
        break;
      }
      case 'capsule': {
        const r = pos(p.d, 'Diameter') / 2, H = pos(p.h, 'Length');
        if (H < 2 * r) throw new Error('The length of a capsule must be at least its diameter');
        const a = keep(M.sphere(r, seg).translate([0, 0, r])), b = keep(M.sphere(r, seg).translate([0, 0, H - r]));
        m = M.hull([a, b]);
        break;
      }
    }
    const out = fromManifold(m!);
    m!.delete();
    return out;
  } finally {
    tmp.forEach((t) => t.delete());
  }
}
