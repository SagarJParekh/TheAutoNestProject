import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { boxMesh, booleanMeshes, generateSupports, analyseOverhangs, overhangAreas, SUPPORT_PRESETS, computeBounds, isWatertight, applyMatrix } from '../src/geometry';

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

  it('variables: Y spacing, grid angle, perimeter, braces, lowest', async () => {
    const t = await tShape();
    const base = { ...SUPPORT_PRESETS.sla, braces: false, raft: false };
    const a = await generateSupports(t, base);
    // twice the spacing across: about half the supports
    const b = await generateSupports(t, { ...base, spacingY: base.spacing * 2 });
    expect(b.count).toBeLessThan(a.count * 0.65);
    // a turned grid still covers the plate and stays closed
    const turned = await generateSupports(t, { ...base, gridAngle: 30 });
    expect(Math.abs(turned.count - a.count)).toBeLessThan(a.count * 0.25);
    expect(isWatertight(turned.supports)).toBe(true);
    // the plate's outline gets supports of its own
    const per = await generateSupports(t, { ...base, perimeter: 2 });
    expect(per.count).toBeGreaterThan(a.count + 20);
    expect(per.contacts.length / 3).toBe(per.count);
    // braces between the tall supports add volume, not supports
    const br = await generateSupports(t, { ...base, braces: true, braceHeight: 5 });
    expect(br.count).toBe(a.count);
    expect(br.supportVolume).toBeGreaterThan(a.supportVolume * 1.1);
    expect(isWatertight(br.supports)).toBe(true);
    // DMLS volume walls on a turned grid
    const vol = await generateSupports(t, { ...SUPPORT_PRESETS.dmls, gridAngle: 45, spacing: 2, spacingY: 3 });
    expect(vol.count).toBeGreaterThan(10);
    expect(isWatertight(vol.supports)).toBe(true);
    // a cube standing on an edge (45°) has nothing at the critical angle: only "lowest" holds it up
    const tilted = applyMatrix(boxMesh([-5, -5, -5], [5, 5, 5]), new Matrix4().makeRotationX(Math.PI / 4).elements);
    expect((await generateSupports(tilted, { ...base, lowest: false })).count).toBe(0);
    expect((await generateSupports(tilted, base)).count).toBeGreaterThan(0);
  });

  it('supports added and removed by hand; hand-made only', async () => {
    const t = await tShape();
    const base = { ...SUPPORT_PRESETS.sla, braces: false };
    const a = await generateSupports(t, base);
    // remove one support at its contact point (given before lifting), then all within 5 mm of a corner
    const c = Array.from(a.contacts.slice(0, 3));
    const one = await generateSupports(t, base, [], { add: [], remove: [[c[0], c[1], c[2] - a.dz, 0]] });
    expect(one.count).toBe(a.count - 1);
    const many = await generateSupports(t, base, [], { add: [], remove: [[2, 2, 20, 5]] });
    expect(many.count).toBeLessThan(a.count - 3);
    // only hand-made supports: two under the plate, and a click on the plate's top puts one under the plate there
    const manual = await generateSupports(t, { ...base, auto: false }, [], { add: [[5, 5, 20], [35, 30, 20], [10, 36, 24]], remove: [] });
    expect(manual.count).toBe(3);
    expect(Array.from(manual.manual).sort()).toEqual([0, 1, 2]);
    expect(manual.contacts[8]).toBeCloseTo(20 + manual.dz, 3);
    const b = computeBounds(manual.supports.positions);
    expect(b.max[2]).toBeCloseTo(manual.dz + 20 + base.penetration, 2);
    expect(isWatertight(manual.supports)).toBe(true);
  });

  it('DMLS: a block added by hand is a patch of walls with one touch point', async () => {
    const t = await tShape();
    const p = { ...SUPPORT_PRESETS.dmls, auto: false, spacing: 1.5, spacingY: 1.5 };
    const r = await generateSupports(t, p, [], { add: [[6, 6, 20]], remove: [] });
    expect(r.contacts.length).toBe(3);
    expect(r.manual[0]).toBe(0);
    expect(r.count).toBe(6);
    expect(isWatertight(r.supports)).toBe(true);
    const b = computeBounds(r.supports.positions);
    expect(b.max[0] - b.min[0]).toBeGreaterThan(2.5);
  });
});
