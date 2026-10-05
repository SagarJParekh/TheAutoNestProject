import { describe, expect, it } from 'vitest';
import {
  addTriangle, analyzeMesh, boxMesh, fixOpenEdges, isWatertight, keepShells, lassoCutter, lassoSplit, mergeMeshes, mergeShells, meshVolume,
  removeDanglingTriangles, shellInfo, subsetTriangles, findShells, computeBounds,
} from '../src/geometry';
import { planeNormal } from '../src/state/math';
import { cube, cubeWithHole, twoOverlappingShells } from './fixtures/meshes';

describe('shells', () => {
  it('lists shells largest first with closed flags', () => {
    const small = boxMesh([30, 0, 0], [32, 2, 2]);
    const open = subsetTriangles(boxMesh([40, 0, 0], [45, 5, 5]), (t) => t !== 0);
    const m = mergeMeshes([small, cube(), open]);
    const { shells, shellOfTri } = shellInfo(m);
    expect(shells.length).toBe(3);
    expect(shells[0].volume).toBeCloseTo(1000, 3);
    expect(shells[0].closed).toBe(true);
    expect(shells.find((s) => s.triangles === 11)!.closed).toBe(false);
    // keep only the largest
    const kept = keepShells(m, shellOfTri, new Set([0]));
    expect(meshVolume(kept)).toBeCloseTo(1000, 3);
  });
  it('merges selected shells with a union and keeps the rest', async () => {
    const m = mergeMeshes([twoOverlappingShells(), boxMesh([50, 0, 0], [52, 2, 2])]);
    const { shells, shellOfTri } = shellInfo(m);
    const big = shells.filter((s) => s.volume > 500).map((s) => s.id);
    const out = await mergeShells(m, shellOfTri, new Set(big));
    expect(findShells(out).shellCount).toBe(2);
    expect(meshVolume(out)).toBeCloseTo(1875 + 8, 1);
  });
});

describe('open edges and manual triangles', () => {
  it('stitch & fill closes the hole', () => {
    const r = fixOpenEdges(cubeWithHole(), 'stitchFill');
    expect(r.openBefore).toBe(4);
    expect(r.openAfter).toBe(0);
    expect(isWatertight(r.mesh)).toBe(true);
  });
  it('fills only holes below the size limit', () => {
    expect(fixOpenEdges(cubeWithHole(), 'fillSmall', { maxPerimeter: 30 }).filled).toBe(0); // perimeter is 40
    expect(fixOpenEdges(cubeWithHole(), 'fillSmall', { maxPerimeter: 50 }).filled).toBe(1);
  });
  it('removes dangling triangles', () => {
    const c = cube();
    const pos = Float32Array.from([...c.positions, 20, 20, 20]);
    const m = { positions: pos, indices: Uint32Array.from([...c.indices, 6, 8, 7]) }; // sliver hanging off a corner edge
    const r = removeDanglingTriangles(m);
    expect(r.removed).toBe(1);
    expect(isWatertight(r.mesh)).toBe(true);
  });
  it('creates triangles wound to match their neighbours', () => {
    // cube without its two top triangles: re-add them by picking corner vertices in any order
    let m = cubeWithHole();
    // find the top vertices (z = 10)
    const top: number[] = [];
    for (let v = 0; v < m.positions.length / 3; v++) if (m.positions[v * 3 + 2] === 10) top.push(v);
    const at = (x: number, y: number) => top.find((v) => m.positions[v * 3] === x && m.positions[v * 3 + 1] === y)!;
    m = addTriangle(m, at(0, 0), at(10, 10), at(10, 0)); // deliberately "wrong" order
    m = addTriangle(m, at(0, 0), at(0, 10), at(10, 10));
    expect(analyzeMesh(m).flippedTriangles).toBe(0);
    expect(isWatertight(m)).toBe(true);
    expect(meshVolume(m)).toBeCloseTo(1000, 3);
  });
});

describe('lasso cut', () => {
  it('cuts the part inside a square outline (orthographic, looking down)', async () => {
    const plate = boxMesh([-20, -20, 0], [20, 20, 4]);
    // camera above at z=100 looking down -Z (identity rotation), outline square 10x10 around origin
    const cam = { matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 100, 1], orthographic: true, near: 50, far: 150 };
    const cutter = await lassoCutter([[-5, -5], [5, -5], [5, 5], [-5, 5]], cam);
    expect(isWatertight(cutter)).toBe(true);
    const { inside, outside } = await lassoSplit(plate, cutter);
    expect(meshVolume(inside)).toBeCloseTo(10 * 10 * 4, 2);
    expect(meshVolume(outside)).toBeCloseTo(40 * 40 * 4 - 400, 1);
  });
  it('perspective lasso widens with depth (frustum)', async () => {
    const cam = { matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 100, 1], orthographic: false, near: 50, far: 150 };
    const cutter = await lassoCutter([[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]], cam);
    const b = computeBounds(cutter.positions);
    // at depth 150 (z = -50) the half-width is 0.1 * 150 = 15
    expect(b.max[0]).toBeCloseTo(15, 3);
    expect(b.min[2]).toBeCloseTo(-50, 3);
    expect(b.max[2]).toBeCloseTo(50, 3);
  });
});

describe('cut plane tilt', () => {
  it('tilts a Z plane about X and Y', () => {
    const n = planeNormal({ axis: 'z', azimuth: 0, elevation: 0, flip: false, tiltA: 90 });
    expect(n[1]).toBeCloseTo(-1);
    const m = planeNormal({ axis: 'z', azimuth: 0, elevation: 0, flip: false, tiltB: 30 });
    expect(m[0]).toBeCloseTo(0.5);
    expect(m[2]).toBeCloseTo(Math.sqrt(3) / 2);
  });
});
