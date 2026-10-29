import { describe, expect, it } from 'vitest';
import { boxMesh, hollowMesh, computeBounds, meshVolume, snapToOffset } from '../src/geometry';

describe('hollow keeps the wall exact', () => {
  it('the inner wall of a 40 mm cube lies exactly 2 mm in, even on a coarse grid', () => {
    const cube = boxMesh([0, 0, 0], [40, 40, 40]);
    // a deliberately coarse voxel (0.9 mm): before snapping the cavity was off by up to a voxel
    const r = hollowMesh(cube, { thickness: 2, voxelSize: 0.9 });
    const b = computeBounds(r.inner.positions);
    for (let k = 0; k < 3; k++) {
      expect(b.min[k]).toBeCloseTo(2, 2);
      expect(b.max[k]).toBeCloseTo(38, 2);
    }
    // cavity close to 36³ (its edges are slightly chamfered by the grid)
    expect(Math.abs(meshVolume(r.inner)) / 36 ** 3).toBeGreaterThan(0.985);
  });

  it('snapping moves vertices onto the exact offset', () => {
    const cube = boxMesh([0, 0, 0], [10, 10, 10]);
    const off = { positions: Float32Array.from([5, 5, 2.3, 2.6, 5, 5]), indices: new Uint32Array(0) };
    const s = snapToOffset(off, cube, 2).positions;
    expect(s[2]).toBeCloseTo(2, 5);
    expect(s[3]).toBeCloseTo(2, 5);
  });
});
