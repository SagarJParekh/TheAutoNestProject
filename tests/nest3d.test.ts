import { describe, expect, it } from 'vitest';
import { boxMesh, mergeMeshes, nest3d, nestPlan, pickNest, interlockTest, turnPositions, turnVoxels, voxelizePart, type MeshData, type NestResult } from '../src/geometry';

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

describe('turned voxels', () => {
  it('cover the turned part exactly like voxelizing it turned', () => {
    const m = move(lPart(), [0.37, -2.21, 0.13]);
    const h = 0.7;
    let v = voxelizePart(m, h);
    for (let k = 1; k < 4; k++) {
      v = turnVoxels(v, h);
      const turned = { positions: turnPositions(m.positions, k), indices: m.indices };
      const direct = voxelizePart(turned, h);
      expect(Math.abs(v.count - direct.count) / direct.count).toBeLessThan(0.15);
      // every vertex and triangle centre of the turned part lies in an occupied voxel
      const p = turned.positions, idx = turned.indices;
      const inCell = (x: number, y: number, z: number) => {
        const i = Math.floor((x - v.min[0]) / h + 1e-6), j = Math.floor((y - v.min[1]) / h + 1e-6), kk = Math.floor((z - v.min[2]) / h + 1e-6);
        const ok = (a: number, b: number, c: number) => a >= 0 && b >= 0 && c >= 0 && a < v.nx && b < v.ny && c < v.nz && v.solid[a + v.nx * (b + v.ny * c)] === 1;
        // on a cell boundary either side counts
        for (const di of [0, -1]) for (const dj of [0, -1]) for (const dk of [0, -1]) {
          const fx = (x - v.min[0]) / h, fy = (y - v.min[1]) / h, fz = (z - v.min[2]) / h;
          if ((di && Math.abs(fx - Math.round(fx)) > 1e-4) || (dj && Math.abs(fy - Math.round(fy)) > 1e-4) || (dk && Math.abs(fz - Math.round(fz)) > 1e-4)) continue;
          if (ok(i + di, j + dj, kk + dk)) return true;
        }
        return false;
      };
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        expect(inCell(p[a], p[a + 1], p[a + 2])).toBe(true);
        expect(inCell((p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3)).toBe(true);
      }
    }
  });
});

describe('nesting variants', () => {
  const params = { margin: 5, clearance: 1, zOffset: 0, maxHeight: 0, rotations: true, volume: [120, 100, 100] as [number, number, number] };
  it('Fine runs all of Normal first (never less dense), then refines the best', () => {
    for (const sym of [true, false]) {
      const normal = nestPlan('normal', sym);
      const fine = nestPlan('fine', sym);
      expect(fine[0]).toEqual(normal[0]);
      expect(fine[1].refine).toBeGreaterThan(normal[1].refine ?? 0);
      expect(fine[1].budget).toBeGreaterThan(normal[0].budget);
    }
  });

  it('keeps the densest variant', () => {
    const parts = [
      { id: 'L', mesh: lPart(), count: 10 },
      { id: 'b', mesh: boxMesh([0, 0, 0], [30, 10, 25]), count: 6 },
    ];
    const one = (order: 'volume' | 'height' | 'box' | 'footprint') => nest3d(parts, { ...params, variants: [{ order, pattern: false }] });
    const singles = (['volume', 'height', 'box', 'footprint'] as const).map(one);
    const all = nest3d(parts, { ...params, variants: (['volume', 'height', 'box', 'footprint'] as const).map((order) => ({ order, pattern: false })) });
    const best = Math.min(...singles.map((r) => r.builds[r.builds.length - 1].height + 1000 * r.builds.length));
    expect(all.builds[all.builds.length - 1].height + 1000 * all.builds.length).toBeCloseTo(best, 6);
  });

  it('pickNest prefers fewer builds, then a lower last build, and a pattern on a tie', () => {
    const r = (heights: number[], pattern = false): NestResult => ({ builds: heights.map((height) => ({ placements: [], height, utilization: 0 })), unplaced: [], voxel: 1, variant: { order: 'volume', pattern } });
    expect(pickNest(r([300, 100]), r([300]))!.builds.length).toBe(1);
    expect(pickNest(r([120]), r([110]))!.builds[0].height).toBe(110);
    expect(pickNest(r([110]), r([110], true))!.variant!.pattern).toBe(true);
    expect(pickNest(r([110], true), r([109]))!.variant!.pattern).toBe(false);
  });
});

describe('locked copies', () => {
  const params = { margin: 5, clearance: 1, zOffset: 0, maxHeight: 0, rotations: true, volume: [120, 100, 80] as [number, number, number] };
  const cube = boxMesh([-10, -10, -10], [10, 10, 10]);
  it('a fully locked copy stays exactly where it is and the others keep clear of it', () => {
    const at: [number, number, number] = [7.3, -4.6, 22.15];
    const r = nest3d(
      [
        { id: 'c', mesh: cube, count: 1, copies: [3], lock: { build: 0, at } },
        { id: 'c', mesh: cube, count: 12, copies: [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
      ],
      params,
    );
    const pl = r.builds[0].placements;
    const lk = pl.find((p) => p.key === 'c#3')!;
    expect(lk.locked).toBe(true);
    expect(lk.t).toEqual(at);
    expect(new Set(pl.map((p) => p.key)).size).toBe(pl.length);
    // no other cube within the clearance of the locked one (boxes: gap along some axis >= 1)
    for (const p of pl) {
      if (p === lk) continue;
      const gap = Math.max(...[0, 1, 2].map((c) => Math.abs(p.t[c] - lk.t[c]) - 20));
      expect(gap).toBeGreaterThanOrEqual(1 - 1e-6);
    }
  });

  it('a copy locked only in Z keeps its height and is placed along X and Y', () => {
    const r = nest3d([{ id: 'c', mesh: cube, count: 1, copies: [0], lock: { build: 0, at: [null, null, 41.7] } }], params);
    const p = r.builds[0].placements[0];
    expect(p.t[2]).toBe(41.7);
    expect(p.locked).toBe(true);
  });

  it('a locked copy outside the volume is reported, not placed', () => {
    const r = nest3d([{ id: 'c', mesh: cube, count: 1, lock: { build: 0, at: [500, 0, 20] } }], params);
    expect(r.unplaced[0].key).toBe('c#0');
  });
});

describe('tilted cups', () => {
  it('parts go into tilted cups, and the result passes the interlocking test', () => {
    const tilt = (m: MeshData, deg: number): MeshData => {
      const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
      const p = m.positions.slice();
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i], z = p[i + 2];
        p[i] = c * x + s * z;
        p[i + 2] = -s * x + c * z;
      }
      return { positions: p, indices: m.indices };
    };
    // 60 × 60 × 70 cup, 3 mm walls, open on top, leaning 30°
    const cup = tilt(mergeMeshes([boxMesh([0, 0, 0], [60, 60, 3]), boxMesh([0, 0, 3], [3, 60, 70]), boxMesh([57, 0, 3], [60, 60, 70]), boxMesh([3, 0, 3], [57, 3, 70]), boxMesh([3, 57, 3], [57, 60, 70])]), 30);
    const small = boxMesh([0, 0, 0], [14, 14, 12]);
    const volume: [number, number, number] = [170, 170, 160];
    const r = nest3d([{ id: 'cup', mesh: cup, count: 4 }, { id: 's', mesh: small, count: 140 }], { volume, margin: 5, clearance: 1, zOffset: 0, maxHeight: 0, rotations: false, budget: 6e6, variants: [{ order: 'open', pattern: false }] });
    const b = r.builds[0];
    const mesh = (id: string) => (id === 'cup' ? cup : small);
    const items = b.placements.map((p) => ({ key: p.key, mesh: move(mesh(p.partId), p.t) }));
    // some small parts sit inside a cup: their box lies within the cup's box
    const cb = bounds(cup);
    const inside = b.placements.filter((p) => p.partId === 's' && b.placements.some((c) => c.partId === 'cup' && [0, 1].every((k) => p.t[k] > cb.lo[k] + c.t[k] + 3 && p.t[k] + 14 < cb.hi[k] + c.t[k] - 3) && p.t[2] > cb.lo[2] + c.t[2] && p.t[2] + 12 < cb.hi[2] + c.t[2])).length;
    expect(inside).toBeGreaterThan(10);
    expect(interlockTest(items, volume, r.voxel).stuck).toEqual([]);
  });
});

describe('cups with breakaway props', () => {
  it('parts are nested inside only when the props may be broken off', () => {
    // 90 × 90 × 50 cup, open on top, with a cross of props over the opening (four openings about 40 mm wide)
    const cup = mergeMeshes([
      boxMesh([0, 0, 0], [90, 90, 3]), boxMesh([0, 0, 3], [3, 90, 50]), boxMesh([87, 0, 3], [90, 90, 50]), boxMesh([3, 0, 3], [87, 3, 50]), boxMesh([3, 87, 3], [87, 90, 50]),
      boxMesh([3, 43.5, 47], [87, 46.5, 50]), boxMesh([43.5, 3, 47], [46.5, 87, 50]),
    ]);
    // 44 mm long: does not fit between the props
    const small = boxMesh([0, 0, 0], [44, 12, 8]);
    const volume: [number, number, number] = [160, 110, 120];
    const run = (breakaway: boolean) =>
      nest3d([{ id: 'cup', mesh: cup, count: 1, breakaway }, { id: 's', mesh: small, count: 30 }], { volume, margin: 5, clearance: 1, zOffset: 0, maxHeight: 0, rotations: false, budget: 4e6, variants: [{ order: 'volume', pattern: false }] });
    const inside = (r: NestResult) => {
      const c = r.builds[0].placements.find((p) => p.partId === 'cup')!;
      return r.builds[0].placements.filter((p) => p.partId === 's' && p.t[0] > c.t[0] + 2 && p.t[0] + 44 < c.t[0] + 88 && p.t[1] > c.t[1] + 2 && p.t[1] + 12 < c.t[1] + 88 && p.t[2] < c.t[2] + 47).length;
    };
    const normal = run(false), props = run(true);
    expect(inside(normal)).toBe(0);
    expect(inside(props)).toBeGreaterThan(4);
    const items = props.builds[0].placements.map((p) => ({ key: p.key, mesh: move(p.partId === 'cup' ? cup : small, p.t), breakaway: p.partId === 'cup' }));
    // without the breakaway rule the same build would count as interlocked
    expect(interlockTest(items.map((x) => ({ ...x, breakaway: false })), volume, props.voxel).stuck.length).toBeGreaterThan(0);
    expect(interlockTest(items, volume, props.voxel).stuck).toEqual([]);
  });
});
