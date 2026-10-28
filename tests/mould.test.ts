import { describe, expect, it } from 'vitest';
import { boxMesh, makeMould, mouldClearance, meshVolume, isWatertight, computeBounds } from '../src/geometry';

describe('VC moulds', () => {
  it('clearance by the largest side: 20 / 30 / 50 mm', () => {
    expect(mouldClearance([100, 50, 299])).toBe(20);
    expect(mouldClearance([300, 50, 20])).toBe(30);
    expect(mouldClearance([120, 900, 40])).toBe(30);
    expect(mouldClearance([901, 100, 100])).toBe(50);
  });

  it('a block with the clearance on all six sides and the part as the cavity', async () => {
    const part = boxMesh([0, 0, 0], [100, 60, 40]);
    const r = await makeMould(part);
    expect(r.clearance).toBe(20);
    expect(r.mouldSize).toEqual([140, 100, 80]);
    expect(r.pieces.length).toBe(1);
    expect(isWatertight(r.pieces[0])).toBe(true);
    expect(meshVolume(r.pieces[0])).toBeCloseTo(140 * 100 * 80 - 100 * 60 * 40, 0);
    const b = computeBounds(r.pieces[0].positions);
    expect(b.min).toEqual([-20, -20, -20]);
  });

  it('a large part gets 30 mm, and the mould can be split in two halves at mid-height', async () => {
    const r = await makeMould(boxMesh([0, 0, 0], [400, 100, 50]), { split: true });
    expect(r.clearance).toBe(30);
    expect(r.pieces.length).toBe(2);
    const [bottom, top] = r.pieces.map((m) => computeBounds(m.positions));
    expect(bottom.max[2]).toBeCloseTo(25, 4);
    expect(top.min[2]).toBeCloseTo(25, 4);
    expect(meshVolume(r.pieces[0]) + meshVolume(r.pieces[1])).toBeCloseTo(460 * 160 * 110 - 400 * 100 * 50, -1);
  });
});
