/**
 * Lasso cut: a freehand outline drawn on screen is extruded along the view
 * (a frustum for perspective cameras) and used to split a part into the
 * piece inside the outline and the piece outside it.
 */
import { MeshData } from './mesh';
import { applyMatrix } from './transform';
import { fromManifold, getManifold, toManifold, NotManifoldError } from './manifold';

export interface LassoCamera {
  /** camera world matrix (column-major); the camera looks down its local -Z */
  matrixWorld: number[];
  orthographic: boolean;
  /** depth range in front of the camera that the cutter spans */
  near: number;
  far: number;
}

/**
 * Closed cutter solid for an outline given in camera space. For perspective
 * cameras `outline` holds x/y at depth 1 (tangent-space coordinates); for
 * orthographic cameras it holds x/y in camera units.
 */
export async function lassoCutter(outline: [number, number][], cam: LassoCamera): Promise<MeshData> {
  if (outline.length < 3) throw new Error('Draw a closed outline around the area');
  const wasm = await getManifold();
  const s0 = cam.orthographic ? 1 : cam.near;
  const pts = outline.map(([x, y]) => [x * s0, y * s0] as [number, number]);
  const cs = new wasm.CrossSection(pts, 'NonZero');
  if (cs.isEmpty()) {
    cs.delete();
    throw new Error('The outline encloses no area');
  }
  const h = cam.far - cam.near;
  // scaleTop must be passed as [sx, sy]: a bare number is not applied to both axes
  const k = cam.orthographic ? 1 : cam.far / cam.near;
  const solid = cs.extrude(h, 0, 0, [k, k]);
  cs.delete();
  const local = fromManifold(solid);
  solid.delete();
  // local z in [0, h] -> camera z = -(near + z); then to world (mirroring is handled by applyMatrix)
  const toCam = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, -cam.near, 1];
  return applyMatrix(applyMatrix(local, toCam), cam.matrixWorld);
}

/** Split a closed part with a lasso cutter into the inside and outside pieces. */
export async function lassoSplit(mesh: MeshData, cutter: MeshData): Promise<{ inside: MeshData; outside: MeshData }> {
  const a = await toManifold(mesh);
  if (!a) throw new NotManifoldError('Part');
  const c = await toManifold(cutter);
  if (!c) {
    a.delete();
    throw new Error('The lasso outline could not be turned into a solid; draw a simpler shape');
  }
  try {
    const i = a.intersect(c), o = a.subtract(c);
    const inside = fromManifold(i), outside = fromManifold(o);
    i.delete();
    o.delete();
    return { inside, outside };
  } finally {
    a.delete();
    c.delete();
  }
}

/**
 * Turn an open polyline (screen coordinates) into a closed outline that
 * covers everything on one side of it: both ends are extended far beyond
 * the view and joined around that side.
 */
export function polylineToOutline(points: [number, number][], reach: number): [number, number][] {
  const n = points.length;
  const ext = (p: [number, number], q: [number, number]): [number, number] => {
    const dx = p[0] - q[0], dy = p[1] - q[1];
    const l = Math.hypot(dx, dy) || 1;
    return [p[0] + (dx / l) * reach, p[1] + (dy / l) * reach];
  };
  const a = ext(points[0], points[1]);
  const b = ext(points[n - 1], points[n - 2]);
  // side: perpendicular to the chord between the extended ends
  const cx = b[0] - a[0], cy = b[1] - a[1];
  const cl = Math.hypot(cx, cy) || 1;
  const px = (-cy / cl) * reach * 2, py = (cx / cl) * reach * 2;
  return [a, ...points, b, [b[0] + px, b[1] + py], [a[0] + px, a[1] + py]];
}
