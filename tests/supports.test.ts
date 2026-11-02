import { describe, expect, it } from 'vitest';
import { boxMesh, booleanMeshes, generateSupports, analyseOverhangs, overhangAreas, SUPPORT_PRESETS, computeBounds, isWatertight } from '../src/geometry';

// a T: a 10 × 10 pillar 20 high under a 40 × 40 × 4 plate (the plate's underside overhangs all round)
const tShape = () => booleanMeshes('union', boxMesh([15, 15, 0], [25, 25, 21]), [boxMesh([0, 0, 20], [40, 40, 24])]);

describe('support generation', () => {
  it('finds the overhang under the plate (and the bottom once lifted)', async () => {
    const t = await tShape();
    const flat = overhangAreas(t, 45, 0.1, 0);
    // on the platform: only the plate's underside ring, 40² − 10²
    expect(flat.length).toBe(1);
    expect(flat[0].area).toBeCloseTo(1600 - 100, 0);
    const a = analyseOverhangs(t, { criticalAngle: 45, minArea: 0.1, lift: 3, spacing: 1 });
    expect(a.areas).toBe(2);
    expect(a.area).toBeCloseTo(1600, 0);
  });

  for (const tech of ['sla', 'dlp', 'dmls'] as const) {
    it(`${tech}: supports from the platform up to the overhangs, part lifted`, async () => {
      const p = SUPPORT_PRESETS[tech];
      const r = await generateSupports(await tShape(), p);
      expect(computeBounds(r.part.positions).min[2]).toBeCloseTo(p.lift, 5);
      expect(r.count).toBeGreaterThan(20);
      expect(isWatertight(r.supports)).toBe(true);
      const b = computeBounds(r.supports.positions);
      expect(b.min[2]).toBeCloseTo(0, 3);
      // reaching the plate's underside (lifted) plus the penetration
      expect(b.max[2]).toBeGreaterThan(p.lift + 20 - 0.01);
      expect(b.max[2]).toBeLessThan(p.lift + 20 + p.penetration + 0.01);
      // nothing under the pillar's middle sticks up into it (pillar bottom is supported, but only to its bottom)
      expect(r.supportVolume).toBeGreaterThan(0);
    });
  }

  it('volume walls and bars for DMLS; areas clicked off get none', async () => {
    const t = await tShape();
    const bars = await generateSupports(t, { ...SUPPORT_PRESETS.dmls, style: 'bar', spacing: 2 });
    expect(isWatertight(bars.supports)).toBe(true);
    // skip the plate's underside (a point on it, part not yet lifted): only the pillar bottom keeps supports
    const r = await generateSupports(t, SUPPORT_PRESETS.dmls, [[2, 2, 20]]);
    expect(r.skipped).toBe(1);
    const b = computeBounds(r.supports.positions);
    expect(b.max[0] - b.min[0]).toBeLessThan(11);
  });
});

describe('a lifted part always stands on supports', () => {
  it('a box turned 45° (nothing flatter than the critical angle) still gets supports under its lowest edge', async () => {
    const { boxMesh, applyMatrix, generateSupports, SUPPORT_PRESETS, computeBounds } = await import('../src/geometry');
    const { Matrix4 } = await import('three');
    const box = applyMatrix(boxMesh([-10, -10, -10], [10, 10, 10]), new Matrix4().makeRotationX(Math.PI / 4).elements);
    const r = await generateSupports(box, SUPPORT_PRESETS.sla);
    expect(r.count).toBeGreaterThan(0);
    const b = computeBounds(r.supports.positions);
    expect(b.min[2]).toBeCloseTo(0, 3);
    expect(b.max[2]).toBeGreaterThan(SUPPORT_PRESETS.sla.lift);
  });
});
