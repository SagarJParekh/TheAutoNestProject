import { describe, expect, it } from 'vitest';
import { bendAlongArc } from '../src/geometry';

describe('label on an arc', () => {
  // a 40 × 4 mm bar of "text", its middle on y = 0
  const bar = () => [[[-20, -2], [20, -2], [20, 2], [-20, 2]] as [number, number][]];

  it('bending up puts the middle of the text on a circle centred below it', () => {
    const p = bar();
    bendAlongArc(p, 30, false, 1);
    for (const [x, y] of p[0]) {
      const r = Math.hypot(x, y + 30);
      expect(r).toBeGreaterThan(28 - 1e-6);
      expect(r).toBeLessThan(32 + 1e-6);
    }
    // the ends drop below the middle: an arch
    expect(Math.min(...p[0].map(([, y]) => y))).toBeLessThan(-2.5);
    expect(Math.max(...p[0].map(([, y]) => y))).toBeCloseTo(2, 3);
  });

  it('bending down curves the other way (a smile), centred above', () => {
    const p = bar();
    bendAlongArc(p, 30, true, 1);
    for (const [x, y] of p[0]) {
      const r = Math.hypot(x, y - 30);
      expect(r).toBeGreaterThan(28 - 1e-6);
      expect(r).toBeLessThan(32 + 1e-6);
    }
    expect(Math.max(...p[0].map(([, y]) => y))).toBeGreaterThan(2.5);
  });
});

describe('circle from a curved edge', () => {
  it('fits the circle of a facetted rim and of an arc', async () => {
    const { circleFromEdgePoints } = await import('../src/geometry/measure3d');
    const ring = Array.from({ length: 48 }, (_, k) => [5 + 12 * Math.cos((k / 48) * 2 * Math.PI), -3 + 12 * Math.sin((k / 48) * 2 * Math.PI), 7] as [number, number, number]);
    const c = circleFromEdgePoints(ring);
    expect(c.r).toBeCloseTo(12, 3);
    expect(c.c[0]).toBeCloseTo(5, 3);
    expect(c.c[1]).toBeCloseTo(-3, 3);
    expect(Math.abs(c.n[2])).toBeCloseTo(1, 5);
    // a 60° arc standing in the XZ plane
    const arc = Array.from({ length: 9 }, (_, k) => [8 * Math.cos((k / 8) * (Math.PI / 3)), 0, 8 * Math.sin((k / 8) * (Math.PI / 3))] as [number, number, number]);
    const a = circleFromEdgePoints(arc);
    expect(a.r).toBeCloseTo(8, 3);
    expect(Math.abs(a.n[1])).toBeCloseTo(1, 5);
  });
});
