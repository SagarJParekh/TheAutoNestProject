import { describe, expect, it } from 'vitest';
import {
  boxMesh, computeBounds, latticeField, isWatertight, makeShape, meshVolume, mergeMeshes, latticeMesh, shrinkwrapMesh, SHAPES, DEFAULT_SHAPE, DEFAULT_LATTICE, DEFAULT_WRAP,
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
  it('honeycomb: walls on the hexagon borders, about 2·t/s of the volume, running along the chosen axis', () => {
    const f = latticeField('honeycomb', 10, 1, 'z');
    // centre of a cell: 5 mm from every wall; midway to the next centre: on the wall
    expect(f(0, 0, 0)).toBeCloseTo(0.5 - 5, 6);
    expect(f(5, 0, 3)).toBeCloseTo(0.5, 6);
    expect(f(2.5, (10 * Math.sqrt(3)) / 4, 7)).toBeCloseTo(0.5, 6);
    // the pattern repeats from cell to cell and does not change along Z
    expect(f(1.3 + 10, 2.1, 0)).toBeCloseTo(f(1.3, 2.1, 50), 6);
    expect(f(1.3 + 5, 2.1 + 5 * Math.sqrt(3), 0)).toBeCloseTo(f(1.3, 2.1, 0), 6);
    let solid = 0, n = 0;
    for (let x = 0; x < 100; x += 0.37) for (let y = 0; y < 100; y += 0.41) (n++, f(x, y, 0) > 0 && solid++);
    expect(solid / n).toBeGreaterThan(0.17);
    expect(solid / n).toBeLessThan(0.23);
    // along X the hexagons lie in the YZ plane
    expect(latticeField('honeycomb', 10, 1, 'x')(42, 5, 0)).toBeCloseTo(0.5, 6);
  });

  for (const type of ['gyroid', 'cubic', 'honeycomb'] as const) {
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

describe('hollow shapes', () => {
  it('a hollow box, cylinder and sphere have exact walls', async () => {
    const { makeShape, DEFAULT_SHAPE, meshVolume, isWatertight } = await import('../src/geometry');
    const box = await makeShape({ ...DEFAULT_SHAPE, kind: 'box', x: 20, y: 30, z: 40, hollow: true, wall: 2 });
    expect(isWatertight(box)).toBe(true);
    expect(meshVolume(box)).toBeCloseTo(20 * 30 * 40 - 16 * 26 * 36, 0);
    const cyl = await makeShape({ ...DEFAULT_SHAPE, kind: 'cylinder', d: 20, h: 30, hollow: true, wall: 2, segments: 256 });
    expect(meshVolume(cyl) / (Math.PI * (100 * 30 - 64 * 26))).toBeCloseTo(1, 2);
    const sph = await makeShape({ ...DEFAULT_SHAPE, kind: 'sphere', d: 30, hollow: true, wall: 3, segments: 128 });
    expect(meshVolume(sph) / ((4 / 3) * Math.PI * (15 ** 3 - 12 ** 3))).toBeCloseTo(1, 1);
  });

  it('other shapes are hollowed like the Hollow tool; walls too thick are reported', async () => {
    const { makeShape, DEFAULT_SHAPE, meshVolume } = await import('../src/geometry');
    const solid = await makeShape({ ...DEFAULT_SHAPE, kind: 'cone', d: 30, d2: 10, h: 30 });
    const shell = await makeShape({ ...DEFAULT_SHAPE, kind: 'cone', d: 30, d2: 10, h: 30, hollow: true, wall: 2 });
    expect(meshVolume(shell)).toBeLessThan(meshVolume(solid) * 0.6);
    expect(meshVolume(shell)).toBeGreaterThan(0);
    await expect(makeShape({ ...DEFAULT_SHAPE, kind: 'box', x: 3, y: 20, z: 20, hollow: true, wall: 2 })).rejects.toThrow(/too thick/);
  });
});
