import { describe, expect, it } from 'vitest';
import { boxMesh, hollowMesh, computeBounds, meshVolume, snapToOffset } from '../src/geometry';

describe('hollow keeps the wall exact', () => {
  it('the inner wall of a 40 mm cube lies exactly 2 mm in, even on a coarse grid (sharp edges and corners)', () => {
    const cube = boxMesh([0, 0, 0], [40, 40, 40]);
    // a deliberately coarse voxel (0.9 mm): before snapping the cavity was off by up to a voxel
    const r = hollowMesh(cube, { thickness: 2, voxelSize: 0.9 });
    const b = computeBounds(r.inner.positions);
    for (let k = 0; k < 3; k++) {
      expect(b.min[k]).toBeCloseTo(2, 2);
      expect(b.max[k]).toBeCloseTo(38, 2);
    }
    // the cavity is the exact 36 mm cube: corners and edges sharp
    expect(Math.abs(meshVolume(r.inner))).toBeCloseTo(36 ** 3, 0);
  });

  it('the cavity of a cylinder keeps sharp rims (no bevel or waviness at its ends), without folded triangles', async () => {
    const { getManifold, fromManifold } = await import('../src/geometry');
    const wasm = await getManifold();
    const m = wasm.Manifold.cylinder(60, 15, 15, 128);
    const cyl = fromManifold(m);
    m.delete();
    const r = hollowMesh(cyl, { thickness: 2, voxelSize: 0.5 });
    const p = r.inner.positions, ix = r.inner.indices;
    const R = 13, z0 = 2, z1 = 58;
    const dev = (x: number, y: number, z: number) => {
      const dr = Math.hypot(x, y) - R, dz = Math.max(z0 - z, z - z1);
      return Math.abs(dr > 0 || dz > 0 ? Math.hypot(Math.max(dr, 0), Math.max(dz, 0)) : Math.max(dr, dz));
    };
    // how many triangle edges cut a corner (their middle off the exact cavity), and folds between neighbours
    let off = 0, folds = 0;
    const tn: number[][] = [];
    for (let k = 0; k < ix.length; k += 3) {
      const [a, b, c] = [ix[k] * 3, ix[k + 1] * 3, ix[k + 2] * 3];
      const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], w = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], l = Math.hypot(n[0], n[1], n[2]) || 1;
      tn.push(n.map((x) => x / l));
      for (const [i, j] of [[a, b], [b, c], [c, a]]) if (dev((p[i] + p[j]) / 2, (p[i + 1] + p[j + 1]) / 2, (p[i + 2] + p[j + 2]) / 2) > 0.05) off++;
    }
    const seen = new Map<string, number>();
    for (let k = 0; k < ix.length; k += 3)
      for (let e = 0; e < 3; e++) {
        const a = ix[k + e], b = ix[k + ((e + 1) % 3)], key = a < b ? `${a},${b}` : `${b},${a}`;
        const o = seen.get(key);
        if (o === undefined) seen.set(key, k / 3);
        else if (tn[k / 3][0] * tn[o][0] + tn[k / 3][1] * tn[o][1] + tn[k / 3][2] * tn[o][2] < -0.5) folds++;
      }
    expect(folds).toBe(0);
    // dual contouring puts the rims exactly on the edge: no triangle edge cuts the corner (only facet error is left)
    expect(r.method).toBe('dual');
    expect(off).toBe(0);
  });

  it('snapping moves vertices onto the exact offset', () => {
    const cube = boxMesh([0, 0, 0], [10, 10, 10]);
    const off = { positions: Float32Array.from([5, 5, 2.3, 2.6, 5, 5]), indices: new Uint32Array(0) };
    const s = snapToOffset(off, cube, 2).positions;
    expect(s[2]).toBeCloseTo(2, 5);
    expect(s[3]).toBeCloseTo(2, 5);
  });
});
