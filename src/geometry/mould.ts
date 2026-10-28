/**
 * Vacuum casting (VC) moulds: a block around the part with the clearance on
 * all six sides, the part taken out of it as the cavity. The clearance follows
 * the part's size: under 300 mm → 20 mm, 300–900 mm → 30 mm, over 900 mm →
 * 50 mm (by the largest side of its bounding box). Optionally the mould is
 * split into two halves at the part's mid-height (the parting plane).
 */
import type { Manifold } from 'manifold-3d';
import { MeshData, Vec3, computeBounds } from './mesh';
import { getManifold, fromManifold, toManifold, NotManifoldError } from './manifold';

/** Clearance (mm) on every side of a mould, from the part's bounding-box size. */
export function mouldClearance(size: Vec3): number {
  const largest = Math.max(size[0], size[1], size[2]);
  return largest < 300 ? 20 : largest <= 900 ? 30 : 50;
}

export interface MouldResult {
  /** one mould block, or the two halves (bottom first) */
  pieces: MeshData[];
  clearance: number;
  /** part bounding box and the mould's outer size, mm */
  partSize: Vec3;
  mouldSize: Vec3;
}

export async function makeMould(mesh: MeshData, opts: { clearance?: number; split?: boolean } = {}): Promise<MouldResult> {
  const b = computeBounds(mesh.positions);
  const partSize: Vec3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const c = opts.clearance && opts.clearance > 0 ? opts.clearance : mouldClearance(partSize);
  const mouldSize: Vec3 = [partSize[0] + 2 * c, partSize[1] + 2 * c, partSize[2] + 2 * c];
  const wasm = await getManifold();
  const part = await toManifold(mesh);
  if (!part) throw new NotManifoldError('Part');
  const made: Manifold[] = [part];
  try {
    const block = wasm.Manifold.cube(mouldSize).translate([b.min[0] - c, b.min[1] - c, b.min[2] - c]);
    made.push(block);
    const mould = block.subtract(part);
    made.push(mould);
    let pieces: Manifold[] = [mould];
    if (opts.split) {
      const mid = (b.min[2] + b.max[2]) / 2;
      const [top, bottom] = mould.splitByPlane([0, 0, 1], mid);
      made.push(top, bottom);
      pieces = [bottom, top];
    }
    return { pieces: pieces.map(fromManifold).filter((m) => m.indices.length), clearance: c, partSize, mouldSize };
  } finally {
    made.forEach((m) => m.delete());
  }
}
