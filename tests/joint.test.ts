import { describe, expect, it } from 'vitest';
import { boxMesh, isWatertight, jointFrame, jointProfile, lapProfile, jointSplit, meshVolume, computeBounds, mergeMeshes, LAP_JOINTS, TONGUE_JOINTS, DEFAULT_JOINT, type JointKind } from '../src/geometry';

// a 100 × 30 × 12 bar along X, cut across the middle
const bar = boxMesh([0, 0, 0], [100, 30, 12]);
const plane = { normal: [1, 0, 0] as [number, number, number], constant: 50 };
// a 40 mm cube cut half way up, as in the usual lap joint example
const cube = boxMesh([0, 0, 0], [40, 40, 40]);
const mid = { normal: [0, 0, 1] as [number, number, number], constant: 20 };

describe('lap joints follow the outline of the cross-section', () => {
  it('step: the lower piece gets a plateau inset by the offset, the upper one a skirt with the clearances', async () => {
    const p = { ...DEFAULT_JOINT, kind: 'step' as JointKind, depth: 10, offset: 2, notchClearance: 0.05, frontClearance: 0.01, backClearance: 0.05 };
    const r = await jointSplit(cube, mid, p);
    expect(isWatertight(r.above) && isWatertight(r.below)).toBe(true);
    // lower: 40 × 40 × 20 + plateau 36 × 36 × 10
    expect(meshVolume(r.below)).toBeCloseTo(40 * 40 * 20 + 36 * 36 * 10, 0);
    const bb = computeBounds(r.below.positions);
    expect(bb.max[2]).toBeCloseTo(30, 4);
    // upper: everything above the front clearance minus a pocket 0.05 wider on each side and 0.05 higher
    const pocket = (36 + 0.1) * (36 + 0.1) * (10 + 0.05 - 0.01);
    expect(meshVolume(r.above)).toBeCloseTo(40 * 40 * (20 - 0.01) - pocket, 0);
    expect(computeBounds(r.above.positions).min[2]).toBeCloseTo(20.01, 4);
    expect(r.tooDeep).toBe(false);
  });

  it('works on an inside-out part too', async () => {
    const { flipMesh } = await import('../src/geometry');
    const r = await jointSplit(flipMesh(cube), mid, { ...DEFAULT_JOINT, kind: 'step', depth: 10, offset: 2 });
    expect(meshVolume(r.below)).toBeCloseTo(40 * 40 * 20 + 36 * 36 * 10, 0);
  });

  it('negative direction puts the notch on the other piece', async () => {
    const r = await jointSplit(cube, mid, { ...DEFAULT_JOINT, kind: 'step', depth: 10, offset: 2, negative: true });
    expect(computeBounds(r.above.positions).min[2]).toBeCloseTo(10, 4);
    expect(meshVolume(r.above)).toBeCloseTo(40 * 40 * 20 + 36 * 36 * 10, 0);
  });

  it('square: a tongue running round the wall of a hollow tube', async () => {
    // 40 × 40 tube with 4 mm walls, made of four wall boxes
    const tube = mergeMeshes([boxMesh([0, 0, 0], [40, 4, 40]), boxMesh([0, 36, 0], [40, 40, 40]), boxMesh([0, 4, 0], [4, 36, 40]), boxMesh([36, 4, 0], [40, 36, 40])]);
    const { unionMeshes } = await import('../src/geometry');
    const solid = await unionMeshes([tube]);
    const p = { ...DEFAULT_JOINT, kind: 'square' as JointKind, depth: 5, offset: 1, width: 2, notchClearance: 0, frontClearance: 0, backClearance: 0 };
    const r = await jointSplit(solid, mid, p);
    expect(isWatertight(r.above) && isWatertight(r.below)).toBe(true);
    const wall = 40 * 40 - 32 * 32;
    // a ring of the tongue between 1 and 3 mm in from the outside (its inner corners rounded)
    const ring = 38 * 38 - 34 * 34;
    expect(meshVolume(r.below) - wall * 20).toBeCloseTo(ring * 5, -1);
    expect(meshVolume(r.above) + meshVolume(r.below)).toBeCloseTo(wall * 40, 0);
  });

  // 40 × 40 tube with 4 mm walls, cut half way up (as in the Magics lap joint video)
  const squareTube = async () => {
    const { unionMeshes } = await import('../src/geometry');
    return unionMeshes([mergeMeshes([boxMesh([0, 0, 0], [40, 4, 40]), boxMesh([0, 36, 0], [40, 40, 40]), boxMesh([0, 4, 0], [4, 36, 40]), boxMesh([36, 4, 0], [40, 36, 40])])]);
  };
  const zero = { notchClearance: 0, frontClearance: 0, backClearance: 0 };

  it('step on a tube: the offset counts from the outside only, so the lip runs out to the bore', async () => {
    const r = await jointSplit(await squareTube(), mid, { ...DEFAULT_JOINT, kind: 'step', depth: 3, offset: 1, ...zero });
    expect(isWatertight(r.above) && isWatertight(r.below)).toBe(true);
    // the lip: 1 mm in from the outside (rounded outer corners stay inside 38 × 38) to the 32 × 32 bore
    expect(meshVolume(r.below) - (40 * 40 - 32 * 32) * 20).toBeCloseTo((38 * 38 - 32 * 32) * 3, -1);
    expect(r.contours).toEqual([1, 2]);
    expect(r.lines!.length).toBeGreaterThan(0);
  });

  it('indicated subcontour: picking the bore puts the skirt on the inside', async () => {
    const r = await jointSplit(await squareTube(), mid, { ...DEFAULT_JOINT, kind: 'step', depth: 3, offset: 1, ...zero, basis: 'subcontours', picks: [[20, 4.2, 21]] });
    // the lip now runs from the outside to 1 mm off the bore (34 × 34)
    expect(meshVolume(r.below) - (40 * 40 - 32 * 32) * 20).toBeCloseTo((40 * 40 - 34 * 34) * 3, -1);
  });

  it('indicated section contour: only the picked region gets the joint, the others are cut flat', async () => {
    const two = mergeMeshes([boxMesh([0, 0, 0], [20, 20, 40]), boxMesh([40, 0, 0], [60, 20, 40])]);
    const r = await jointSplit(two, mid, { ...DEFAULT_JOINT, kind: 'step', depth: 5, offset: 2, ...zero, picks: [[60.5, 10, 20]] });
    expect(meshVolume(r.below)).toBeCloseTo(2 * 20 * 20 * 20 + 16 * 16 * 5, 0);
    expect(r.contours).toEqual([1, 2]);
  });

  it('without straight cut the notch follows the slope of the surface', async () => {
    const { getManifold, fromManifold } = await import('../src/geometry');
    const wasm = await getManifold();
    // cone frustum: radius 20 at z = 0 narrowing to 10 at z = 40
    const m = wasm.Manifold.cylinder(40, 20, 10, 128);
    const cone = fromManifold(m);
    m.delete();
    const p = { ...DEFAULT_JOINT, kind: 'step' as JointKind, depth: 8, offset: 2, ...zero };
    const straight = await jointSplit(cone, mid, p);
    const slope = await jointSplit(cone, mid, { ...p, straight: false });
    expect(isWatertight(slope.above) && isWatertight(slope.below)).toBe(true);
    // straight: a cylinder of radius 13 (15 − 2); following the surface: a frustum 2 mm inside it, 13 → 11
    const frustum = (Math.PI * 8 * (13 * 13 + 13 * 11 + 11 * 11)) / 3;
    const base = meshVolume(straight.below) - Math.PI * 13 * 13 * 8;
    expect(meshVolume(slope.below) - base).toBeCloseTo(frustum, -1);
  });

  it('tongue & groove on a tube: the tongue sits b in from the outside and from the bore', async () => {
    const r = await jointSplit(await squareTube(), mid, { ...DEFAULT_JOINT, kind: 'tongue', depth: 5, offset: 1, width: 0, ...zero });
    expect(isWatertight(r.above) && isWatertight(r.below)).toBe(true);
    // tongue between 38 × 38 (rounded corners inside it) and 34 × 34 (square corners)
    expect(meshVolume(r.below) - (40 * 40 - 32 * 32) * 20).toBeCloseTo((38 * 38 - 34 * 34) * 5, -1);
    expect(meshVolume(r.above) + meshVolume(r.below)).toBeCloseTo((40 * 40 - 32 * 32) * 40, 0);
    expect(r.contours).toEqual([2, 2]);
  });

  it('tongue & groove with a width: a ring tongue set in from the outer wall (solid parts)', async () => {
    const r = await jointSplit(cube, mid, { ...DEFAULT_JOINT, kind: 'tongue', depth: 4, offset: 3, width: 4, ...zero });
    expect(isWatertight(r.above) && isWatertight(r.below)).toBe(true);
    expect(meshVolume(r.below) - 40 * 40 * 20).toBeCloseTo((34 * 34 - 26 * 26) * 4, -1);
  });

  for (const kind of LAP_JOINTS.map((j) => j.value)) {
    it(`${kind}: two watertight pieces`, async () => {
      const r = await jointSplit(cube, mid, { ...DEFAULT_JOINT, kind, depth: 6, offset: 3, width: 4, count: 2, spacing: 3 });
      expect(isWatertight(r.above) && isWatertight(r.below)).toBe(true);
      expect(computeBounds(r.below.positions).max[2]).toBeGreaterThan(24);
      const lost = 40 * 40 * 40 - meshVolume(r.above) - meshVolume(r.below);
      expect(lost).toBeGreaterThan(0);
      expect(lost).toBeLessThan(40 * 40 * 1);
    });
  }

  it('a notch deeper than the part, or one that does not fit inside the outline, is reported', async () => {
    expect((await jointSplit(cube, mid, { ...DEFAULT_JOINT, kind: 'step', depth: 25, offset: 2 })).tooDeep).toBe(true);
    await expect(jointSplit(cube, mid, { ...DEFAULT_JOINT, kind: 'square', depth: 5, offset: 21, width: 10 })).rejects.toThrow(/does not fit/);
  });

  it('dovetails flare out but stay inside the outer surface; toothed profiles have one peak per tooth', () => {
    const d = lapProfile({ ...DEFAULT_JOINT, kind: 'dovetail', width: 4, depth: 3, offset: 2, angle: 20 });
    expect(d[2][0] - d[1][0]).toBeGreaterThan(d[3][0] - d[0][0]);
    expect(d[1][0]).toBeGreaterThanOrEqual(0);
    const t = lapProfile({ ...DEFAULT_JOINT, kind: 'toothed', count: 4, depth: 2 });
    expect(t.filter(([, n]) => n === 2).length).toBe(4);
  });
});

describe('tongue joints run across the cross-section', () => {
  it('half laps and scarfs run across the thickness, finger joints across the width', () => {
    expect(Math.abs(jointFrame(bar, plane, { kind: 'halfLap', rotate: 0 }).s[2])).toBeCloseTo(1);
    expect(Math.abs(jointFrame(bar, plane, { kind: 'finger', rotate: 0 }).s[1])).toBeCloseTo(1);
    expect(Math.abs(jointFrame(bar, plane, { kind: 'halfLap', rotate: 90 }).s[1])).toBeCloseTo(1);
    expect(jointProfile({ ...DEFAULT_JOINT, kind: 'finger', depth: 4, count: 3 }, 0, 30).length).toBe(12);
  });

  for (const kind of TONGUE_JOINTS.map((j) => j.value).filter((k) => k !== 'tongue')) {
    it(`${kind}: two watertight pieces that make up the part`, async () => {
      const exact = await jointSplit(bar, plane, { ...DEFAULT_JOINT, kind, depth: 0, clearance: 0 });
      expect(isWatertight(exact.above) && isWatertight(exact.below)).toBe(true);
      expect(meshVolume(exact.above) + meshVolume(exact.below)).toBeCloseTo(100 * 30 * 12, 0);
      expect(computeBounds(exact.below.positions).max[0]).toBeGreaterThan(50 + 1e-3);
      expect(computeBounds(exact.above.positions).min[0]).toBeLessThan(50 - 1e-3);
      const fit = await jointSplit(bar, plane, { ...DEFAULT_JOINT, kind, depth: 0, clearance: 0.4 });
      const lost = 100 * 30 * 12 - meshVolume(fit.above) - meshVolume(fit.below);
      expect(lost).toBeGreaterThan(30 * 12 * 0.4 * 0.9);
      expect(lost).toBeLessThan(30 * 12 * 0.4 * 6);
    });
  }

  it('automatic overlap stays inside the part on both sides of the plane', async () => {
    const flat = { normal: [0, 0, 1] as [number, number, number], constant: 6 };
    for (const kind of ['halfLap', 'scarf'] as JointKind[]) {
      const r = await jointSplit(bar, flat, { ...DEFAULT_JOINT, kind, depth: 0 });
      expect(r.tooDeep).toBe(false);
      expect(computeBounds(r.below.positions).max[2]).toBeLessThan(12);
    }
  });
});
