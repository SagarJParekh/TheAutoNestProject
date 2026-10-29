import { describe, expect, it } from 'vitest';
import { boxMesh, isWatertight, meshVolume, computeBounds, polyCutSplit, toothProfile, filletCorners, shapePolyline, DEFAULT_POLYCUT, type LassoCamera } from '../src/geometry';

// a 100 × 30 × 12 bar seen from above by an orthographic camera at z = 100 (camera units = mm)
const bar = boxMesh([0, 0, 0], [100, 30, 12]);
const camera: LassoCamera = { matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 100, 1], orthographic: true, near: 1, far: 200 };
const line: [number, number][] = [[50, -10], [50, 40]];
const total = 100 * 30 * 12;
const cut = (params: Partial<typeof DEFAULT_POLYCUT>, points = line, closed = false) => polyCutSplit({ mesh: bar, points, closed, camera, unit: 1, params: { ...DEFAULT_POLYCUT, ...params } });

describe('polyline cut', () => {
  it('a straight line splits the part through along the view', async () => {
    const r = await cut({});
    expect(isWatertight(r.inside) && isWatertight(r.outside)).toBe(true);
    expect(meshVolume(r.inside)).toBeCloseTo(total / 2, 0);
    expect(meshVolume(r.inside) + meshVolume(r.outside)).toBeCloseTo(total, 0);
    expect(r.teeth).toBe(0);
  });

  it('teeth on the indicated segment key the pieces together', async () => {
    for (const type of ['square', 'triangle', 'dovetail'] as const) {
      const r = await cut({ segment: 1, type, size: 10, offset: 50 });
      expect(isWatertight(r.inside) && isWatertight(r.outside)).toBe(true);
      expect(meshVolume(r.inside) + meshVolume(r.outside)).toBeCloseTo(total, 0);
      // the teeth reach past the line on both sides
      expect(computeBounds(r.inside.positions).max[0]).toBeGreaterThan(50.5);
      expect(computeBounds(r.outside.positions).min[0]).toBeLessThan(49.5);
      expect(r.teeth).toBe(10);
    }
  });

  it('offset 0 % puts the teeth all on one side', () => {
    const { pts } = toothProfile(100, { type: 'square', size: 10, offset: 0 });
    expect(Math.min(...pts.map(([, y]) => y))).toBeCloseTo(0);
    expect(Math.max(...pts.map(([, y]) => y))).toBeCloseTo(5);
    const c = toothProfile(100, { type: 'square', size: 10, offset: 50 }).pts;
    expect(Math.min(...c.map(([, y]) => y))).toBeCloseTo(-2.5);
  });

  it('a clearance leaves a gap; a cutting depth stops below the front', async () => {
    const r = await cut({ clearanceOn: true, clearance: 0.4 });
    expect(total - meshVolume(r.inside) - meshVolume(r.outside)).toBeCloseTo(0.4 * 30 * 12, 0);
    const d = await cut({ depthOn: true, depth: 5 });
    expect(meshVolume(d.inside)).toBeCloseTo(50 * 30 * 5, 0);
    expect(computeBounds(d.inside.positions).min[2]).toBeCloseTo(7, 3);
  });

  it('rounded corners replace a corner with an arc of the radius', () => {
    const pts = filletCorners([[0, 0], [10, 0], [10, 10]], [0, 2, 0], false);
    expect(pts.length).toBeGreaterThan(4);
    // the arc stays 2 mm off both segments' corner, through (10 - 2 + 2·cos45, 2 - 2·sin45)
    const mid = pts[Math.floor(pts.length / 2)];
    expect(Math.hypot(mid[0] - 8, mid[1] - 2)).toBeCloseTo(2, 3);
    const s = shapePolyline(line, false, { ...DEFAULT_POLYCUT, segment: 1, roundTeeth: true, teethRadius: 0.5 }, 1);
    expect(s.pts.length).toBeGreaterThan(40);
  });

  it('a closed shape cuts out the enclosed area', async () => {
    const r = await cut({}, [[20, 5], [40, 5], [40, 25], [20, 25]], true);
    expect(meshVolume(r.inside)).toBeCloseTo(20 * 20 * 12, 0);
  });
});
