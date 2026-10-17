import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { autoOrient, boxMesh, findFlattestFace, mergeMeshes, minAreaRectAngle, subtractMeshes, type MeshData } from '../src/geometry';

/** World bounding box of a mesh under rotation q. */
const boundsUnder = (m: MeshData, q: [number, number, number, number]) => {
  const qq = new Quaternion(...q);
  const v = new Vector3();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    v.set(m.positions[i], m.positions[i + 1], m.positions[i + 2]).applyQuaternion(qq);
    const a = [v.x, v.y, v.z];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], a[k]);
      hi[k] = Math.max(hi[k], a[k]);
    }
  }
  return hi.map((h, k) => h - lo[k]);
};

describe('auto arrange: flattest face', () => {
  it('picks the largest face of a plate', () => {
    const f = findFlattestFace(boxMesh([0, 0, 0], [40, 20, 3]))!;
    expect(f.supporting).toBe(true);
    expect(f.area).toBeCloseTo(800, 3);
    expect(Math.abs(f.normal[2])).toBeCloseTo(1, 6);
  });

  it('counts coplanar but separate faces together (feet)', () => {
    // a small slab on four tall thin legs: the four foot pads (4 × 4 mm²) are coplanar
    const legs = [0, 1, 2, 3].map((i) => boxMesh([(i % 2) * 18, Math.floor(i / 2) * 18, 0], [(i % 2) * 18 + 2, Math.floor(i / 2) * 18 + 2, 30]));
    const top = boxMesh([0, 0, 30], [20, 20, 31]);
    const f = findFlattestFace(mergeMeshes([...legs, top]))!;
    expect(f.supporting).toBe(true);
    // the slab top (400 mm²) wins over the slab underside, which is not a supporting plane
    expect(f.area).toBeCloseTo(400, 3);
  });

  it('prefers a face the part can stand on over a bigger face inside a cavity', async () => {
    // an open-top tray: the inside floor faces up but cannot be put on the bed
    const tray = await subtractMeshes(boxMesh([0, 0, 0], [40, 40, 10]), [boxMesh([2, 2, 2], [38, 38, 20])]);
    const f = findFlattestFace(tray)!;
    expect(f.supporting).toBe(true);
    expect(f.normal[2]).toBeCloseTo(-1, 6);
  });

  it('turns the footprint so it lines up with X and Y, long side along X', () => {
    const a = (25 * Math.PI) / 180;
    const pts: number[] = [];
    for (const [x, y] of [[0, 0], [30, 0], [30, 10], [0, 10]]) pts.push(x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a));
    expect(minAreaRectAngle(pts)).toBeCloseTo(-a, 6);
  });

  it('lays a tilted plate flat on its big face and aligns it with the axes', () => {
    const plate = boxMesh([-20, -10, -1.5], [20, 10, 1.5]);
    const tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0.4, 0.2).normalize(), 1.1);
    const r = autoOrient(plate, [tilt.x, tilt.y, tilt.z, tilt.w]);
    expect(r.face?.supporting).toBe(true);
    const size = boundsUnder(plate, r.quaternion);
    expect(size[0]).toBeCloseTo(40, 3);
    expect(size[1]).toBeCloseTo(20, 3);
    expect(size[2]).toBeCloseTo(3, 3);
  });

});

import { arrangeBoxes as arrange2 } from '../src/geometry';

describe('arrange in X and Y together', () => {
  it('spreads parts over both directions instead of one long row', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ id: String(i), size: [20, 20, 10] as [number, number, number] }));
    const r = arrange2(items, ['x', 'y'], [250, 210, 200], 5);
    // a 3 × 3 grid: 3·20 + 2·5 = 70 mm each way
    expect(r.size[0]).toBeCloseTo(70, 5);
    expect(r.size[1]).toBeCloseTo(70, 5);
    expect(r.overflow).toBe(false);
    // no overlaps
    for (let i = 0; i < 9; i++)
      for (let j = i + 1; j < 9; j++) {
        const a = r.placements[i].min, b = r.placements[j].min;
        expect(Math.abs(a[0] - b[0]) >= 20 - 1e-6 || Math.abs(a[1] - b[1]) >= 20 - 1e-6).toBe(true);
      }
  });
  it('follows the bed proportions for a long bed', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: String(i), size: [20, 20, 10] as [number, number, number] }));
    const r = arrange2(items, ['x', 'y'], [400, 100, 200], 5);
    expect(r.size[0]).toBeGreaterThan(r.size[1]);
    expect(r.size[1]).toBeGreaterThan(20);
  });
  it('X only still makes one row', () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ id: String(i), size: [20, 20, 10] as [number, number, number] }));
    const r = arrange2(items, ['x'], [250, 210, 200], 5);
    expect(r.size[0]).toBeCloseTo(95, 5);
    expect(r.size[1]).toBeCloseTo(20, 5);
  });
});
