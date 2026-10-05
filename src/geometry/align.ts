import { Vec3 } from './mesh';
import { quaternionFromUnitVectors, matrixFromQuaternion } from './transform';

export interface FaceRef {
  /** world-space point on the face (e.g. centroid) */
  point: Vec3;
  /** world-space outward normal */
  normal: Vec3;
}

export interface AlignOptions {
  /** mate: faces touch, facing each other; flush: faces coplanar, same direction */
  mode: 'mate' | 'flush';
  /** gap along the target normal, mm */
  offset: number;
  /** also slide so the face centres line up */
  center: boolean;
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * World-space delta transform (column-major 4x4) that moves the source face
 * onto the target face's plane. Apply it on top of the moving part's
 * current world matrix: newWorld = delta × oldWorld.
 */
export function alignMatrix(src: FaceRef, tgt: FaceRef, opts: AlignOptions): number[] {
  const ns = norm(src.normal);
  const nt = norm(tgt.normal);
  const want: Vec3 = opts.mode === 'mate' ? [-nt[0], -nt[1], -nt[2]] : nt;
  const R = matrixFromQuaternion(quaternionFromUnitVectors(ns, want));
  const sp = src.point;
  // after rotating about sp, sp stays fixed; now translate
  const d: Vec3 = [tgt.point[0] - sp[0], tgt.point[1] - sp[1], tgt.point[2] - sp[2]];
  let t: Vec3;
  if (opts.center) {
    t = [d[0] + nt[0] * opts.offset, d[1] + nt[1] * opts.offset, d[2] + nt[2] * opts.offset];
  } else {
    const s = d[0] * nt[0] + d[1] * nt[1] + d[2] * nt[2] + opts.offset;
    t = [nt[0] * s, nt[1] * s, nt[2] * s];
  }
  // M = T(sp + t) · R · T(-sp)
  const out = R.slice();
  for (let r = 0; r < 3; r++) {
    const rotSp = R[r] * sp[0] + R[4 + r] * sp[1] + R[8 + r] * sp[2];
    out[12 + r] = sp[r] + t[r] - rotSp;
  }
  return out;
}
