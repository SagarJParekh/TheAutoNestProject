import { describe, expect, it } from 'vitest';
import { boxMesh, mergeMeshes, triangleThickness } from '../src/geometry';

describe('wall thickness', () => {
  it('a 40 × 30 × 2 plate is 2 mm thick through its big faces', () => {
    const plate = boxMesh([0, 0, 0], [40, 30, 2]);
    const r = triangleThickness(plate, undefined, false);
    const p = plate.positions, idx = plate.indices;
    for (let t = 0; t < idx.length / 3; t++) {
      const zs = [0, 1, 2].map((k) => p[idx[t * 3 + k] * 3 + 2]);
      if (zs.every((z) => z === 0) || zs.every((z) => z === 2)) expect(r.values[t]).toBeCloseTo(2, 4);
    }
    expect(r.min).toBeCloseTo(2, 4);
    expect(r.max).toBeCloseTo(40, 4);
  });
  it('an open sheet has no thickness (NaN) and a shelled box sees its wall', () => {
    const sheet = { positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]), indices: Uint32Array.from([0, 1, 2]) };
    expect(Number.isNaN(triangleThickness(sheet, undefined, false).values[0])).toBe(true);
    // outer 20 mm box with an inside-out 16 mm box inside: 2 mm walls
    const outer = boxMesh([0, 0, 0], [20, 20, 20]);
    const inner = boxMesh([2, 2, 2], [18, 18, 18]);
    const flipped = { positions: inner.positions, indices: Uint32Array.from(inner.indices, (_v, i) => inner.indices[i - (i % 3) + [0, 2, 1][i % 3]]) };
    const r = triangleThickness(mergeMeshes([outer, flipped]), undefined, false);
    expect(r.min).toBeCloseTo(2, 4);
    expect(r.max).toBeCloseTo(2, 4);
  });
});

describe('thickness detail', () => {
  it('splits large triangles for the heat map and still finds the 2 mm wall', () => {
    const plate = boxMesh([0, 0, 0], [40, 30, 2]);
    const r = triangleThickness(plate);
    expect(r.display.length / 9).toBeGreaterThan(12);
    expect(r.values.length).toBe(r.display.length / 9);
    expect(r.min).toBeCloseTo(2, 3);
  });
});
