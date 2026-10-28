import { describe, expect, it } from 'vitest';
import { boxMesh, minimumBox, applyMatrix, makeShape, DEFAULT_SHAPE } from '../src/geometry';
import { Matrix4, Euler } from 'three';

const turned = (m: ReturnType<typeof boxMesh>, x: number, y: number, z: number) =>
  applyMatrix(m, new Matrix4().makeRotationFromEuler(new Euler(x, y, z)).setPosition(5, -3, 12).elements);

describe('minimum box', () => {
  it('finds the sides of a box turned at an odd angle, longest first', async () => {
    const r = await minimumBox(turned(boxMesh([0, 0, 0], [50, 10, 25]), 0.4, -0.7, 1.1));
    expect(r.size[0]).toBeCloseTo(50, 2);
    expect(r.size[1]).toBeCloseTo(25, 2);
    expect(r.size[2]).toBeCloseTo(10, 2);
    expect(r.volume).toBeCloseTo(12500, 0);
    expect(r.aabbVolume).toBeGreaterThan(r.volume * 1.5);
    // right-handed unit axes
    const [a, b, c] = r.axes;
    const cr = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    cr.forEach((v, k) => expect(v).toBeCloseTo(c[k], 6));
  });

  it('a cylinder lying at an angle gets a box of its diameter and length', async () => {
    const cyl = await makeShape({ ...DEFAULT_SHAPE, kind: 'cylinder', d: 20, h: 60, segments: 64 });
    const r = await minimumBox(turned(cyl, 0.9, 0.3, 0));
    expect(r.size[0]).toBeCloseTo(60, 1);
    expect(r.size[1]).toBeLessThan(20.2);
    expect(r.size[2]).toBeLessThan(20.2);
  });
});
