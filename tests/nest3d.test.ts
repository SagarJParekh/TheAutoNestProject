import { describe, expect, it } from 'vitest';
import { boxMesh, mergeMeshes, nest3d, interlockTest, turnPositions, voxelizePart, type MeshData } from '../src/geometry';

const move = (m: MeshData, t: [number, number, number]): MeshData => ({ positions: m.positions.map((v, i) => v + t[i % 3]), indices: m.indices });
const place = (m: MeshData, turns: number, t: [number, number, number]) => move({ positions: turnPositions(m.positions, turns), indices: m.indices }, t);
const bounds = (m: MeshData) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], m.positions[i]);
    hi[i % 3] = Math.max(hi[i % 3], m.positions[i]);
  }
  return { lo, hi };
};

/** An L-shaped part (in XY): a long bar plus a short leg, 5 mm thick. */
function lPart(): MeshData {
  // bar 40 × 8, leg 8 × 24 at the left end, both 5 mm tall, as one closed mesh would be complicated: two touching boxes are enough for voxels
  return mergeMeshes([boxMesh([0, 0, 0], [40, 8, 5]), boxMesh([0, 8, 0], [8, 32, 5])]);
}

describe('3D nesting by part shape', () => {
  it('voxelizes a box into a full block', () => {
    const v = voxelizePart(boxMesh([0, 0, 0], [10, 10, 10]), 1);
    expect(v.nx).toBe(11);
    expect(v.count).toBe(11 * 11 * 11);
  });

  it('fills closed cavities', () => {
    const outer = boxMesh([0, 0, 0], [20, 20, 20]);
    const inner = boxMesh([5, 5, 5], [15, 15, 15]);
    const flipped = { positions: inner.positions, indices: Uint32Array.from(inner.indices, (_v, i) => inner.indices[i - (i % 3) + [0, 2, 1][i % 3]]) };
    const v = voxelizePart(mergeMeshes([outer, flipped]), 1);
    expect(v.count).toBe(v.nx * v.ny * v.nz);
  });

  it('nests L shapes into each other closer than their bounding boxes allow', () => {
    const L = lPart();
    const r = nest3d([{ id: 'L', mesh: L, count: 2 }], { volume: [60, 60, 10], margin: 2, clearance: 1, zOffset: 0, maxHeight: 0, voxel: 1, rotations: true });
    expect(r.unplaced).toEqual([]);
    expect(r.builds.length).toBe(1);
    // two 40 × 32 bounding boxes cannot both lie flat in a 56 × 56 area (or stack in 10 mm), but the shapes interlace
    const [a, b] = r.builds[0].placements;
    const A = bounds(place(L, a.turns, a.t)), B = bounds(place(L, b.turns, b.t));
    const overlapX = Math.min(A.hi[0], B.hi[0]) - Math.max(A.lo[0], B.lo[0]);
    const overlapY = Math.min(A.hi[1], B.hi[1]) - Math.max(A.lo[1], B.lo[1]);
    const overlapZ = Math.min(A.hi[2], B.hi[2]) - Math.max(A.lo[2], B.lo[2]);
    expect(overlapX > 0 && overlapY > 0 && overlapZ > 0).toBe(true);
  });

  it('stacks in Z when the platform is full', () => {
    const cube = boxMesh([0, 0, 0], [20, 20, 20]);
    const r = nest3d([{ id: 'c', mesh: cube, count: 2 }], { volume: [30, 30, 60], margin: 1, clearance: 1, zOffset: 0, maxHeight: 0, voxel: 1, rotations: true });
    expect(r.builds.length).toBe(1);
    const zs = r.builds[0].placements.map((pl) => bounds(place(cube, pl.turns, pl.t)).lo[2]).sort((x, y) => x - y);
    expect(zs[1] - zs[0]).toBeGreaterThanOrEqual(20 + 1 - 1e-6);
  });

  it('keeps at least the clearance between parts', () => {
    const cube = boxMesh([0, 0, 0], [10, 10, 10]);
    for (const clearance of [0.5, 1, 2]) {
      const r = nest3d([{ id: 'c', mesh: cube, count: 4 }], { volume: [80, 80, 20], margin: 1, clearance, zOffset: 0, maxHeight: 0, voxel: 0.5, rotations: false });
      const bs = r.builds[0].placements.map((pl) => bounds(place(cube, pl.turns, pl.t)));
      for (let i = 0; i < bs.length; i++)
        for (let j = i + 1; j < bs.length; j++) {
          const gap = Math.max(bs[j].lo[0] - bs[i].hi[0], bs[i].lo[0] - bs[j].hi[0], bs[j].lo[1] - bs[i].hi[1], bs[i].lo[1] - bs[j].hi[1], bs[j].lo[2] - bs[i].hi[2], bs[i].lo[2] - bs[j].hi[2]);
          expect(gap).toBeGreaterThanOrEqual(clearance - 1e-6);
        }
    }
  });

  it('respects the max build height', () => {
    const cube = boxMesh([0, 0, 0], [20, 20, 20]);
    const r = nest3d([{ id: 'c', mesh: cube, count: 2 }], { volume: [30, 30, 100], margin: 1, clearance: 1, zOffset: 0, maxHeight: 30, voxel: 1, rotations: true });
    expect(r.builds.length).toBe(2);
    for (const b of r.builds) expect(b.height).toBeLessThanOrEqual(30 + 1e-6);
  });

  it('interlock test finds a pin through a closed ring and passes parts that can slide apart', () => {
    // ring: a square frame 30 × 30 with a 10 × 10 hole, 6 mm tall
    const ring = mergeMeshes([boxMesh([0, 0, 0], [30, 10, 6]), boxMesh([0, 20, 0], [30, 30, 6]), boxMesh([0, 10, 0], [10, 20, 6]), boxMesh([20, 10, 0], [30, 20, 6])]);
    // dumbbell through the hole: bar through it with plates above and below larger than the hole
    const bar = mergeMeshes([boxMesh([13, 13, -10], [17, 17, 16]), boxMesh([8, 8, -16], [22, 22, -10]), boxMesh([8, 8, 16], [22, 22, 22])]);
    const vol: [number, number, number] = [100, 100, 100];
    expect(interlockTest([{ key: 'ring', mesh: move(ring, [0, 0, 30]) }, { key: 'bar', mesh: move(bar, [0, 0, 30]) }], vol, 1).stuck.sort()).toEqual(['bar', 'ring']);
    // a plain pin (no plates) can slide out of the ring
    const pin = boxMesh([13, 13, -10], [17, 17, 16]);
    expect(interlockTest([{ key: 'ring', mesh: move(ring, [0, 0, 30]) }, { key: 'pin', mesh: move(pin, [0, 0, 30]) }], vol, 1).stuck).toEqual([]);
  });

  it('nested results never interlock', () => {
    const ring = mergeMeshes([boxMesh([0, 0, 0], [30, 10, 6]), boxMesh([0, 20, 0], [30, 30, 6]), boxMesh([0, 10, 0], [10, 20, 6]), boxMesh([20, 10, 0], [30, 20, 6])]);
    const dumb = mergeMeshes([boxMesh([4, 4, 0], [6, 6, 20]), boxMesh([0, 0, 0], [10, 10, 2]), boxMesh([0, 0, 18], [10, 10, 20])]);
    const r = nest3d([{ id: 'ring', mesh: ring, count: 3 }, { id: 'dumb', mesh: dumb, count: 6 }], { volume: [60, 60, 40], margin: 1, clearance: 1, zOffset: 0, maxHeight: 0, voxel: 1, rotations: true });
    for (const b of r.builds) {
      const items = b.placements.map((pl) => ({ key: pl.key, mesh: place(pl.partId === 'ring' ? ring : dumb, pl.turns, pl.t) }));
      expect(interlockTest(items, [60, 60, 40], 1).stuck).toEqual([]);
    }
  });
});

import { findCollisions } from '../src/geometry';

describe('collision check', () => {
  it('finds crossing parts, a part inside another, parts too close, and passes clean layouts', () => {
    const a = boxMesh([0, 0, 0], [10, 10, 10]);
    const crossing = boxMesh([5, 5, 5], [15, 15, 15]);
    const insideBox = boxMesh([3, 3, 3], [6, 6, 6]);
    const near = boxMesh([10.4, 0, 0], [20, 10, 10]);
    const far = boxMesh([30, 0, 0], [40, 10, 10]);
    const r1 = findCollisions([{ key: 'a', mesh: a }, { key: 'x', mesh: crossing }]);
    expect(r1.length).toBe(1);
    expect(r1[0].kind).toBe('intersect');
    expect(r1[0].points.length).toBeGreaterThan(0);
    expect(findCollisions([{ key: 'a', mesh: a }, { key: 'i', mesh: insideBox }])[0].kind).toBe('inside');
    const r3 = findCollisions([{ key: 'a', mesh: a }, { key: 'n', mesh: near }], 1);
    expect(r3[0].kind).toBe('too-close');
    expect(r3[0].distance!).toBeCloseTo(0.4, 3);
    expect(findCollisions([{ key: 'a', mesh: a }, { key: 'f', mesh: far }], 1)).toEqual([]);
  });
});

describe('nest3d: cavities and patterns', () => {
  const params = { margin: 5, clearance: 1, zOffset: 0, maxHeight: 0, rotations: true };
  it('fills an open tray instead of stacking beside or above it', () => {
    // 120 × 80 × 40 tray, 4 mm walls, open on top
    const tray = mergeMeshes([boxMesh([0, 0, 0], [120, 80, 4]), boxMesh([0, 0, 4], [4, 80, 40]), boxMesh([116, 0, 4], [120, 80, 40]), boxMesh([4, 0, 4], [116, 4, 40]), boxMesh([4, 76, 4], [116, 80, 40])]);
    const cube = boxMesh([0, 0, 0], [20, 20, 20]);
    const r = nest3d([{ id: 'tray', mesh: tray, count: 1 }, { id: 'cube', mesh: cube, count: 12 }], { ...params, volume: [140, 100, 60] });
    expect(r.builds.length).toBe(1);
    expect(r.unplaced.length).toBe(0);
    // every cube sits on the tray floor, so the build is no taller than the tray
    expect(r.builds[0].height).toBeLessThanOrEqual(40.5);
  });

  it('puts copies in a regular pattern when that costs nothing', () => {
    const cube = boxMesh([0, 0, 0], [20, 20, 20]);
    const r = nest3d([{ id: 'c', mesh: cube, count: 30 }], { ...params, volume: [200, 200, 100], symmetric: true });
    const pl = r.builds[0].placements;
    expect(pl.filter((p) => p.pattern).length).toBeGreaterThanOrEqual(28);
    // equal spacing along X in the first row
    const row = pl.filter((p) => Math.abs(p.t[1] - pl[0].t[1]) < 1e-6 && Math.abs(p.t[2] - pl[0].t[2]) < 1e-6).map((p) => p.t[0]).sort((a, b) => a - b);
    const steps = row.slice(1).map((x, i) => x - row[i]);
    for (const s of steps) expect(s).toBeCloseTo(steps[0], 6);
  });

  it('never packs worse with the symmetric option', () => {
    const L = lPart();
    const free = nest3d([{ id: 'L', mesh: L, count: 40 }], { ...params, volume: [120, 100, 100], symmetric: false });
    const sym = nest3d([{ id: 'L', mesh: L, count: 40 }], { ...params, volume: [120, 100, 100], symmetric: true });
    expect(sym.builds.length).toBeLessThanOrEqual(free.builds.length);
    expect(sym.builds[sym.builds.length - 1].height).toBeLessThanOrEqual(free.builds[free.builds.length - 1].height + 1e-9);
  });
});
