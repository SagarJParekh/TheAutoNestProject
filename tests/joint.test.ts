import { describe, expect, it } from 'vitest';
import { boxMesh, isWatertight, jointFrame, jointProfile, jointSplit, meshVolume, computeBounds, LAP_JOINTS, TONGUE_JOINTS, DEFAULT_JOINT, type JointKind } from '../src/geometry';

// a 100 × 30 × 12 bar along X, cut across the middle
const bar = boxMesh([0, 0, 0], [100, 30, 12]);
const plane = { normal: [1, 0, 0] as [number, number, number], constant: 50 };

describe('joint cuts', () => {
  it('runs lap profiles across the thickness and finger joints across the width', () => {
    expect(Math.abs(jointFrame(bar, plane, { kind: 'square', rotate: 0 }).s[2])).toBeCloseTo(1);
    expect(Math.abs(jointFrame(bar, plane, { kind: 'finger', rotate: 0 }).s[1])).toBeCloseTo(1);
    expect(Math.abs(jointFrame(bar, plane, { kind: 'square', rotate: 90 }).s[1])).toBeCloseTo(1);
  });

  it('dovetails flare out and toothed profiles have one peak per tooth', () => {
    const d = jointProfile({ ...DEFAULT_JOINT, kind: 'dovetail', width: 4, depth: 3, angle: 20 }, 0, 12);
    expect(d[2][0] - d[1][0]).toBeGreaterThan(d[3][0] - d[0][0]);
    const t = jointProfile({ ...DEFAULT_JOINT, kind: 'toothed', count: 4, depth: 2 }, 0, 12);
    expect(t.filter(([, n]) => n === 2).length).toBe(4);
  });

  for (const kind of [...LAP_JOINTS, ...TONGUE_JOINTS].map((j) => j.value as JointKind)) {
    it(`${kind}: two watertight pieces that make up the part`, async () => {
      const exact = await jointSplit(bar, plane, { ...DEFAULT_JOINT, kind, clearance: 0 });
      expect(isWatertight(exact.above) && isWatertight(exact.below)).toBe(true);
      expect(meshVolume(exact.above) + meshVolume(exact.below)).toBeCloseTo(100 * 30 * 12, 0);
      // the tongues of the lower piece reach past the plane; with tongue joints the upper piece does as well
      const ba = computeBounds(exact.above.positions), bb = computeBounds(exact.below.positions);
      expect(bb.max[0]).toBeGreaterThan(50 + 1e-3);
      if (kind === 'halfLap' || kind === 'finger' || kind === 'scarf') expect(ba.min[0]).toBeLessThan(50 - 1e-3);
      // a fit clearance takes material off the joint faces only
      const fit = await jointSplit(bar, plane, { ...DEFAULT_JOINT, kind, clearance: 0.4 });
      const lost = 100 * 30 * 12 - meshVolume(fit.above) - meshVolume(fit.below);
      expect(lost).toBeGreaterThan(30 * 12 * 0.4 * 0.9);
      expect(lost).toBeLessThan(30 * 12 * 0.4 * 6);
    });
  }

  it('automatic sizes stay inside the part on both sides of the plane', async () => {
    const flat = { normal: [0, 0, 1] as [number, number, number], constant: 6 };
    for (const kind of ['dovetail', 'halfLap', 'scarf'] as JointKind[]) {
      const r = await jointSplit(bar, flat, { ...DEFAULT_JOINT, kind });
      expect(r.sizes.tooDeep).toBe(false);
      expect(computeBounds(r.below.positions).max[2]).toBeLessThan(12);
    }
    // an explicit depth past the top of the part is reported
    expect((await jointSplit(bar, flat, { ...DEFAULT_JOINT, kind: 'square', depth: 8 })).sizes.tooDeep).toBe(true);
  });
});
