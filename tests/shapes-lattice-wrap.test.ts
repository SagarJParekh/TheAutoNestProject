import { describe, expect, it } from 'vitest';
import {
  boxMesh, computeBounds, isWatertight, makeShape, meshVolume, mergeMeshes, latticeMesh, shrinkwrapMesh, SHAPES, DEFAULT_SHAPE, DEFAULT_LATTICE, DEFAULT_WRAP,
  type ShapeKind,
} from '../src/geometry';

const near = (a: number, b: number, rel: number) => Math.abs(a - b) <= Math.abs(b) * rel;

describe('basic shapes', () => {
  for (const kind of SHAPES.map((s) => s.value as ShapeKind)) {
    it(`${kind}: closed solid standing on Z = 0`, async () => {
      const m = await makeShape({ ...DEFAULT_SHAPE, kind });
      expect(isWatertight(m)).toBe(true);
      expect(meshVolume(m)).toBeGreaterThan(0);
      expect(computeBounds(m.positions).min[2]).toBeCloseTo(0, 4);
    });
  }

  it('sizes come out as asked', async () => {
    const box = await makeShape({ ...DEFAULT_SHAPE, kind: 'box', x: 10, y: 20, z: 30 });
    expect(meshVolume(box)).toBeCloseTo(6000, 3);
    const cyl = await makeShape({ ...DEFAULT_SHAPE, kind: 'cylinder', d: 20, h: 10, segments: 256 });
    expect(near(meshVolume(cyl), Math.PI * 100 * 10, 0.002)).toBe(true);
    const cone = await makeShape({ ...DEFAULT_SHAPE, kind: 'cone', d: 20, d2: 0, h: 30, segments: 256 });
    expect(near(meshVolume(cone), (Math.PI * 100 * 30) / 3, 0.003)).toBe(true);
    const torus = await makeShape({ ...DEFAULT_SHAPE, kind: 'torus', d: 40, d2: 10, segments: 256 });
    expect(near(meshVolume(torus), 2 * Math.PI ** 2 * 20 * 25, 0.01)).toBe(true);
    const pyr = await makeShape({ ...DEFAULT_SHAPE, kind: 'pyramid', x: 30, h: 30, sides: 4 });
    expect(meshVolume(pyr)).toBeCloseTo((30 * 30 * 30) / 3, 2);
    const b = computeBounds(pyr.positions);
    expect(b.max[0] - b.min[0]).toBeCloseTo(30, 3);
  });

  it('rejects impossible sizes', async () => {
    await expect(makeShape({ ...DEFAULT_SHAPE, kind: 'tube', d: 10, d2: 12 })).rejects.toThrow(/inside diameter/);
    await expect(makeShape({ ...DEFAULT_SHAPE, kind: 'box', x: 0 })).rejects.toThrow(/greater than 0/);
  });
});

describe('lattice lightweighting', () => {
  for (const type of ['gyroid', 'cubic'] as const) {
    it(`${type}: keeps the outer surface and a solid skin, removes material inside`, async () => {
      const cube = boxMesh([0, 0, 0], [30, 30, 30]);
      const r = await latticeMesh(cube, { ...DEFAULT_LATTICE, type, cell: 10, thickness: 1.5, skin: 2, quality: 'draft' });
      expect(isWatertight(r.mesh)).toBe(true);
      expect(r.after).toBeLessThan(r.before * 0.85);
      expect(r.after).toBeGreaterThan(r.before * 0.2);
      const b = computeBounds(r.mesh.positions);
      expect(b.min[0]).toBeCloseTo(0, 4);
      expect(b.max[2]).toBeCloseTo(30, 4);
    }, 30000);
  }
});

describe('shrinkwrap', () => {
  it('closes a slot narrower than the gap and fills the inside of an open box', async () => {
    // an open-topped box (five plates, not joined) with a 1 mm slot in one wall
    const plates = mergeMeshes([
      boxMesh([0, 0, 0], [30, 30, 1]),
      boxMesh([0, 0, 0], [1, 30, 30]),
      boxMesh([29, 0, 0], [30, 30, 30]),
      boxMesh([0, 0, 0], [14.5, 1, 30]),
      boxMesh([15.5, 0, 0], [30, 1, 30]),
      boxMesh([0, 29, 0], [30, 30, 30]),
    ]);
    const r = shrinkwrapMesh(plates, { ...DEFAULT_WRAP, gap: 40, offset: 0, quality: 'draft' });
    expect(isWatertight(r.mesh)).toBe(true);
    // one solid block about the size of the box (within about half a voxel on each face)
    expect(near(meshVolume(r.mesh), 30 * 30 * 30, 0.12)).toBe(true);
  });

  it('with a small gap it follows the part, a little off the surface', () => {
    const cube = boxMesh([0, 0, 0], [20, 20, 20]);
    const r = shrinkwrapMesh(cube, { ...DEFAULT_WRAP, gap: 2, offset: 1, quality: 'draft' });
    expect(isWatertight(r.mesh)).toBe(true);
    const b = computeBounds(r.mesh.positions);
    expect(b.min[0]).toBeCloseTo(-1, 0);
    expect(b.max[2]).toBeCloseTo(21, 0);
  });
});
