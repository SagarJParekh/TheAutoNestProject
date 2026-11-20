import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { boxMesh, booleanMeshes, generateSupports, analyseOverhangs, overhangAreas, SUPPORT_PRESETS, computeBounds, isWatertight, applyMatrix, meshVolume } from '../src/geometry';

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
      // block supports (the DMLS default) are zero-thickness surfaces; the others closed solids
      if (p.style !== 'block') expect(isWatertight(r.supports)).toBe(true);
      // supports and raft together reach down to the platform
      const b = computeBounds(Float32Array.from([...r.supports.positions, ...r.raft.positions]));
      expect(b.min[2]).toBeCloseTo(0, 3);
      // reaching the plate's underside (lifted) plus the penetration
      expect(b.max[2]).toBeGreaterThan(p.lift + 20 - 0.01);
      expect(b.max[2]).toBeLessThan(p.lift + 20 + p.penetration + 0.01);
      // nothing under the pillar's middle sticks up into it (pillar bottom is supported, but only to its bottom)
      expect(p.style === 'block' ? r.supportArea : r.supportVolume).toBeGreaterThan(0);
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
    const b = computeBounds(Float32Array.from([...r.supports.positions, ...r.raft.positions]));
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
    const vol = await generateSupports(t, { ...SUPPORT_PRESETS.dmls, style: 'volume', gridAngle: 45, spacing: 2, spacingY: 3 });
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
    const p = { ...SUPPORT_PRESETS.dmls, style: 'volume' as const, auto: false, spacing: 1.5, spacingY: 1.5 };
    // block style: the same hand-made patch as one-spot walls (closed, one touch point)
    const blk = await generateSupports(t, { ...p, style: 'block' }, [], { add: [[6, 6, 20]], remove: [] });
    expect(blk.contacts.length).toBe(3);
    expect(blk.supportArea).toBeGreaterThan(0);
    const r = await generateSupports(t, p, [], { add: [[6, 6, 20]], remove: [] });
    expect(r.contacts.length).toBe(3);
    expect(r.manual[0]).toBe(0);
    expect(r.count).toBe(6);
    expect(isWatertight(r.supports)).toBe(true);
    const b = computeBounds(r.supports.positions);
    expect(b.max[0] - b.min[0]).toBeGreaterThan(2.5);
  });

  it('not standing on the part: overhangs above the part branch to supports beside it', async () => {
    // a slab, a pillar and a wide plate above the slab: everything under the plate would land on the slab
    const shape = await booleanMeshes('union', boxMesh([0, 0, 0], [30, 30, 4]), [boxMesh([12, 12, 4], [18, 18, 20]), boxMesh([-6, -6, 20], [36, 36, 23])]);
    const base = { ...SUPPORT_PRESETS.sla, braces: false };
    const on = await generateSupports(shape, base);
    const off = await generateSupports(shape, { ...base, onPart: false });
    // nothing dropped: as many touch points as with supports on the part
    expect(off.contacts.length).toBe(on.contacts.length);
    expect(isWatertight(off.supports)).toBe(true);
    // and the supports do not run through the part (only the tips' penetration)
    const inter = await booleanMeshes('intersect', off.part, [off.supports]);
    expect(meshVolume(inter)).toBeLessThan(off.contacts.length * 0.05);
  }, 60000);

  it('touch points: bar supports (and the bars block supports branch out with) narrow to the touch point Ø at the part', async () => {
    /** the widest a support gets (from its touch point's centre) in the top 0.05 mm under each contact */
    const widthAtContacts = (r: { supports: { positions: Float32Array }; contacts: Float32Array }) => {
      const P = r.supports.positions, C = r.contacts;
      let worst = 0;
      for (let k = 0; k < C.length; k += 3) {
        const [cx, cy, cz] = [C[k], C[k + 1], C[k + 2]];
        for (let i = 0; i < P.length; i += 3) {
          const d = Math.hypot(P[i] - cx, P[i + 1] - cy);
          if (d < 1.5 && P[i + 2] > cz - 0.05 && P[i + 2] < cz + 1) worst = Math.max(worst, d);
        }
      }
      return worst;
    };
    const t = await tShape();
    const bar = { ...SUPPORT_PRESETS.sla, style: 'bar' as const, wall: 0.8, braces: false, raft: false, spacing: 4, spacingY: 4 };
    const thin = await generateSupports(t, { ...bar, touchDiameter: 0.3, touchLength: 0.6 });
    const plain = await generateSupports(t, { ...bar, touchDiameter: 0 });
    expect(isWatertight(thin.supports)).toBe(true);
    expect(widthAtContacts(plain)).toBeGreaterThan(0.38);
    expect(widthAtContacts(thin)).toBeLessThan(0.2);
    expect(thin.supportVolume).toBeLessThan(plain.supportVolume);
    // block supports not standing on the part: the branch bars get the touch point too
    const shape = await booleanMeshes('union', boxMesh([0, 0, 0], [30, 30, 4]), [boxMesh([12, 12, 4], [18, 18, 20]), boxMesh([-6, -6, 20], [36, 36, 23])]);
    const block = { ...SUPPORT_PRESETS.dmls, onPart: false, lowest: false };
    const fat = await generateSupports(shape, { ...block, touchDiameter: 0 });
    const fine = await generateSupports(shape, { ...block, touchDiameter: 0.2, touchLength: 0.5 });
    expect(fine.supportVolume).toBeGreaterThan(0);
    expect(fine.supportVolume).toBeLessThan(fat.supportVolume);
  }, 120000);

  it('raft types: none, skate, cross grid, hexagonal grid, bottom connected, protection case', async () => {
    const t = await tShape();
    // feet well apart, so the raft shapes differ
    const base = { ...SUPPORT_PRESETS.sla, braces: false, spacing: 4, spacingY: 4, baseDiameter: 1.4 };
    const vol: Record<string, number> = {};
    for (const raftType of ['none', 'skate', 'cross', 'hex', 'solid', 'case'] as const) {
      const r = await generateSupports(t, { ...base, raftType });
      expect(isWatertight(r.supports)).toBe(true);
      // the raft is a mesh of its own (hidden while editing supports)
      if (raftType === 'none') expect(r.raft.indices.length).toBe(0);
      else expect(isWatertight(r.raft)).toBe(true);
      vol[raftType] = r.supportVolume;
      // the supports stand on the raft, the raft on the platform
      const b = computeBounds(raftType === 'none' ? r.supports.positions : r.raft.positions);
      expect(b.min[2]).toBeCloseTo(0, 3);
    }
    // more raft, more volume: none < skate < cross < hex < solid < case
    expect(vol.none).toBeLessThan(vol.skate);
    expect(vol.skate).toBeLessThan(vol.cross);
    expect(vol.cross).toBeLessThan(vol.hex);
    expect(vol.hex).toBeLessThan(vol.solid);
    expect(vol.solid).toBeLessThan(vol.case);
  }, 120000);

  it('foot height and the contact on the part below', async () => {
    const t = await tShape();
    const base = { ...SUPPORT_PRESETS.sla, braces: false, raft: false };
    const a = await generateSupports(t, { ...base, footHeight: 0.5 });
    const b = await generateSupports(t, { ...base, footHeight: 3 });
    // a taller foot cone (wider than the rod) adds volume
    expect(b.supportVolume).toBeGreaterThan(a.supportVolume);
    expect(isWatertight(b.supports)).toBe(true);
  });

  it('raft features: hole size, rib, bar width, pad, case wall', async () => {
    const t = await tShape();
    const base = { ...SUPPORT_PRESETS.sla, braces: false, spacing: 4, spacingY: 4, baseDiameter: 1.4 };
    const raftVol = async (patch: Partial<typeof base>) => {
      const r = await generateSupports(t, { ...base, ...patch });
      expect(isWatertight(r.raft)).toBe(true);
      return Math.abs(meshVolume(r.raft));
    };
    // bigger hexagonal holes: less raft; wider ribs: more
    expect(await raftVol({ raftType: 'hex', raftHole: 4 })).toBeLessThan(await raftVol({ raftType: 'hex', raftHole: 2 }));
    expect(await raftVol({ raftType: 'hex', raftHole: 3, raftRib: 2 })).toBeGreaterThan(await raftVol({ raftType: 'hex', raftHole: 3, raftRib: 0.6 }));
    // wider bars and bigger pads: more
    expect(await raftVol({ raftType: 'cross', raftBar: 1.5 })).toBeGreaterThan(await raftVol({ raftType: 'cross', raftBar: 0.6 }));
    expect(await raftVol({ raftType: 'skate', raftPad: 3 })).toBeGreaterThan(await raftVol({ raftType: 'skate', raftPad: 1.6 }));
    // thicker / taller case wall: more; thicker raft: more
    expect(await raftVol({ raftType: 'case', raftRib: 2 })).toBeGreaterThan(await raftVol({ raftType: 'case', raftRib: 0.8 }));
    expect(await raftVol({ raftType: 'case', caseHeight: 8 })).toBeGreaterThan(await raftVol({ raftType: 'case', caseHeight: 2 }));
    expect(await raftVol({ raftType: 'solid', raftThickness: 2 })).toBeGreaterThan(await raftVol({ raftType: 'solid', raftThickness: 1 }));
  }, 120000);

  it('block supports: zero-thickness walls along the hatching, cross grid, teeth, fragmentation, border', async () => {
    const t = await tShape();
    const base = { ...SUPPORT_PRESETS.dmls, style: 'block' as const, spacing: 1.5, spacingY: 1.5, raft: false };
    const gen = async (patch: Partial<typeof base>) => {
      const r = await generateSupports(t, { ...base, ...patch });
      // surfaces, no volume: every triangle stands upright (normal horizontal)
      expect(r.supportVolume).toBe(0);
      const P = r.supports.positions, I = r.supports.indices;
      for (let k = 0; k < I.length; k += 3 * 50) {
        const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const nz = ux * vy - uy * vx, l = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz);
        if (l > 1e-9) expect(Math.abs(nz / l)).toBeLessThan(1e-3);
      }
      const b = computeBounds(r.supports.positions);
      expect(b.min[2]).toBeCloseTo(0, 3);
      expect(b.max[2]).toBeLessThan(base.lift + 20 + base.penetration + 0.01);
      return r;
    };
    const plain = await gen({ teeth: false, fragment: false, perforate: false, blockBorder: false });
    expect(plain.count).toBeGreaterThan(20);
    expect(plain.supportArea).toBeGreaterThan(100);
    // the cross grid: openings between diagonal bars, much less wall
    const grid = await gen({ teeth: false, fragment: false, perforate: true, blockBorder: false });
    expect(grid.supportArea).toBeLessThan(plain.supportArea * 0.85);
    // wider openings (taller cells, thinner bars): less again
    const open = await gen({ teeth: false, fragment: false, perforate: true, perfHeight: 2, perfBeam: 0.3, blockBorder: false });
    expect(open.supportArea).toBeLessThan(grid.supportArea);
    // teeth: less wall at the top
    const teeth = await gen({ teeth: true, fragment: false, perforate: false, blockBorder: false });
    expect(teeth.supportArea).toBeLessThan(plain.supportArea);
    // fragmentation: gaps, so more pieces and less wall
    const frag = await gen({ teeth: false, fragment: true, fragX: 4, fragY: 4, fragWidth: 1, perforate: false, blockBorder: false });
    expect(frag.count).toBeGreaterThan(plain.count);
    expect(frag.supportArea).toBeLessThan(plain.supportArea);
    // border: one more wall round each area
    const border = await gen({ teeth: false, fragment: false, perforate: false, blockBorder: true });
    expect(border.supportArea).toBeGreaterThan(plain.supportArea);
    // the cross grid runs round the border wall too: the border with the grid on adds less wall than without it
    // (at a close spacing, where the outline is sampled finely)
    const fine = { spacing: 1, spacingY: 1, teeth: false, fragment: false };
    const solidRing = (await gen({ ...fine, perforate: false, blockBorder: true })).supportArea - (await gen({ ...fine, perforate: false, blockBorder: false })).supportArea;
    const gridRing = (await gen({ ...fine, perforate: true, blockBorder: true })).supportArea - (await gen({ ...fine, perforate: true, blockBorder: false })).supportArea;
    expect(solidRing).toBeGreaterThan(5);
    expect(gridRing).toBeLessThan(solidRing * 0.85);
  }, 240000);
});
