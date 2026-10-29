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
