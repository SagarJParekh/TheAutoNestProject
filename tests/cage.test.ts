import { describe, expect, it } from 'vitest';
import { buildCage, cageBars, isWatertight, computeBounds } from '../src/geometry';

describe('cage', () => {
  const o = { thickness: 1, barWidth: 3, gap: 5 };
  it('bars leave no gap wider than asked, and the borders are full bars', () => {
    const bars = cageBars([0, 0, 0], [40, 30, 20], o);
    // the bottom face (z from −1 to 0): bars along X, spread over Y
    const alongX = bars.filter(([mn, mx]) => mn[2] === -1 && mx[2] === 0 && mx[0] - mn[0] > 40).map(([mn, mx]) => [mn[1], mx[1]]).sort((a, b) => a[0] - b[0]);
    expect(alongX[0][0]).toBeCloseTo(-1, 9);
    expect(alongX.at(-1)![1]).toBeCloseTo(31, 9);
    for (let i = 1; i < alongX.length; i++) expect(alongX[i][0] - alongX[i - 1][1]).toBeLessThanOrEqual(5 + 1e-9);
    for (const [a, b] of alongX) expect(b - a).toBeCloseTo(3, 9);
  });

  it('is one watertight mesh around the inner box', async () => {
    const m = await buildCage([0, 0, 0], [40, 30, 20], o);
    expect(isWatertight(m)).toBe(true);
    const b = computeBounds(m.positions);
    expect(b.min).toEqual([-1, -1, -1]);
    expect(b.max).toEqual([41, 31, 21]);
  });
});
