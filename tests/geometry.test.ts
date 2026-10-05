import { describe, expect, it } from 'vitest';
import {
  analyzeMesh,
  autoRepair,
  cutMesh,
  extrudeRegion,
  fillHoles,
  findBoundaryLoops,
  findFlippedTriangles,
  findShells,
  fixWinding,
  growCoplanarRegion,
  isWatertight,
  meshVolume,
  meshArea,
  measureMesh,
  mirrorMesh,
  weldVertices,
  removeSmallShells,
  featureEdges,
  mergeMeshes,
  boxMesh,
  layFlatQuaternion,
  matrixFromQuaternion,
  applyMatrix,
  computeBounds,
  dropToBed,
} from '../src/geometry';
import { cube, cubeSoup, cubeWithFlippedFaces, cubeWithHole, gridCube, twoOverlappingShells } from './fixtures/meshes';

describe('measure', () => {
  it('computes volume, area and bounds of a cube', () => {
    const m = measureMesh(cube());
    expect(m.volume).toBeCloseTo(1000, 6);
    expect(m.area).toBeCloseTo(600, 6);
    expect(m.size).toEqual([10, 10, 10]);
    expect(m.triangles).toBe(12);
  });
  it('applies a matrix when measuring', () => {
    const s = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
    const m = measureMesh(cube(), s);
    expect(m.volume).toBeCloseTo(2000, 6);
    expect(m.bounds.min[0]).toBeCloseTo(5);
    expect(m.bounds.max[0]).toBeCloseTo(25);
  });
});

describe('weld', () => {
  it('welds a triangle soup into an indexed watertight mesh', () => {
    const { mesh, merged } = weldVertices(cubeSoup());
    expect(mesh.positions.length / 3).toBe(8);
    expect(merged).toBe(36 - 8);
    expect(isWatertight(mesh)).toBe(true);
  });
  it('merges vertices within tolerance', () => {
    const soup = cubeSoup();
    soup[0] += 1e-5;
    expect(weldVertices(soup, undefined, 0).mesh.positions.length / 3).toBe(9);
    expect(weldVertices(soup, undefined, 1e-3).mesh.positions.length / 3).toBe(8);
  });
});

describe('analysis', () => {
  it('reports a clean cube as watertight', () => {
    const r = analyzeMesh(cube());
    expect(r.watertight).toBe(true);
    expect(r.openEdges).toBe(0);
    expect(r.nonManifoldEdges).toBe(0);
    expect(r.flippedTriangles).toBe(0);
    expect(r.shells).toBe(1);
    expect(r.holes).toBe(0);
  });

  it('detects the hole in a cube with a hole', () => {
    const r = analyzeMesh(cubeWithHole());
    expect(r.watertight).toBe(false);
    expect(r.openEdges).toBe(4);
    expect(r.holes).toBe(1);
    expect(r.highlights.openEdges.length).toBe(4 * 6);
    expect(r.flippedTriangles).toBe(0);
  });

  it('detects flipped faces', () => {
    const m = cubeWithFlippedFaces();
    const r = analyzeMesh(m);
    expect(r.flippedTriangles).toBe(2);
    expect(Array.from(findFlippedTriangles(m)).sort()).toEqual([4, 9]);
    expect(r.watertight).toBe(false);
  });

  it('detects an entirely inside-out mesh', () => {
    const c = cube();
    const idx = c.indices.slice();
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    expect(analyzeMesh({ positions: c.positions, indices: idx }).flippedTriangles).toBe(12);
  });

  it('counts disconnected shells', () => {
    const r = analyzeMesh(twoOverlappingShells());
    expect(r.shells).toBe(2);
    expect(r.watertight).toBe(true);
    expect(findShells(twoOverlappingShells()).shellCount).toBe(2);
  });

  it('finds degenerate and duplicate triangles', () => {
    const c = cube();
    const idx = Array.from(c.indices);
    idx.push(0, 0, 1); // degenerate
    idx.push(c.indices[0], c.indices[2], c.indices[1]); // duplicate (reverse) of tri 0
    const r = analyzeMesh({ positions: c.positions, indices: Uint32Array.from(idx) });
    expect(r.degenerateTriangles).toBe(1);
    expect(r.duplicateTriangles).toBe(1);
  });

  it('finds non-manifold edges', () => {
    const c = cube();
    // add a fin triangle sharing edge 0-1 of the bottom face
    const pos = Float32Array.from([...c.positions, 5, -5, -5]);
    const idx = Uint32Array.from([...c.indices, 0, 1, 8]);
    const r = analyzeMesh({ positions: pos, indices: idx });
    expect(r.nonManifoldEdges).toBe(1);
  });
});

describe('holes', () => {
  it('finds and fills a boundary loop', () => {
    const m = cubeWithHole();
    const loops = findBoundaryLoops(m);
    expect(loops.length).toBe(1);
    expect(loops[0].vertices.length).toBe(4);
    expect(loops[0].perimeter).toBeCloseTo(40);
    const { mesh, filled } = fillHoles(m);
    expect(filled).toBe(1);
    expect(isWatertight(mesh)).toBe(true);
    expect(meshVolume(mesh)).toBeCloseTo(1000, 4);
  });

  it('fills a non-planar hole with a fan', () => {
    const g = gridCube(10, 3);
    // remove a band of triangles that wraps around a corner
    const r = growCoplanarRegion(g, 0, 1);
    const drop = new Set<number>(Array.from(r).slice(0, 4));
    const holed = { positions: g.positions, indices: Uint32Array.from(Array.from(g.indices).filter((_, i) => !drop.has(Math.floor(i / 3)))) };
    const { mesh } = fillHoles(holed);
    expect(analyzeMesh(mesh).openEdges).toBe(0);
  });
});

describe('repair', () => {
  it('fixes flipped faces', () => {
    const { mesh, flipped } = fixWinding(cubeWithFlippedFaces());
    expect(flipped).toBe(2);
    expect(isWatertight(mesh)).toBe(true);
    expect(meshVolume(mesh)).toBeCloseTo(1000, 4);
  });

  it('auto-repairs a soup with a hole, flips, duplicates and degenerates', () => {
    const base = cubeWithFlippedFaces();
    // remove top face, add duplicate + degenerate
    const idx = Array.from(base.indices).filter((_, i) => Math.floor(i / 3) !== 2 && Math.floor(i / 3) !== 3);
    idx.push(idx[0], idx[1], idx[2]);
    idx.push(1, 1, 2);
    // explode into a soup so welding is required
    const soup = new Float32Array(idx.length * 3);
    idx.forEach((v, i) => soup.set(base.positions.subarray(v * 3, v * 3 + 3), i * 3));
    const { mesh, summary } = autoRepair({ positions: soup, indices: Uint32Array.from(idx.map((_, i) => i)) });
    expect(summary.after.watertight).toBe(true);
    expect(summary.before.watertight).toBe(false);
    expect(summary.holesFilled).toBe(1);
    expect(summary.duplicatesRemoved).toBe(1);
    expect(summary.degenerateRemoved).toBe(1);
    expect(summary.trianglesFlipped).toBeGreaterThanOrEqual(2);
    expect(summary.weldedVertices).toBeGreaterThan(0);
    expect(meshVolume(mesh)).toBeCloseTo(1000, 3);
  });

  it('removes small floating shells', () => {
    const m = mergeMeshes([cube(10), boxMesh([20, 20, 20], [20.5, 20.5, 20.5])]);
    const r = removeSmallShells(m, 0.01);
    expect(r.removed).toBe(1);
    expect(meshVolume(r.mesh)).toBeCloseTo(1000, 4);
  });

  it('keeps both overlapping shells (they are not small)', () => {
    const r = autoRepair(twoOverlappingShells(), { removeSmallShells: true });
    expect(r.summary.shellsRemoved).toBe(0);
    expect(r.summary.after.shells).toBe(2);
  });
});

describe('cut', () => {
  it('splits a cube into two closed halves', () => {
    const { above, below } = cutMesh(cube(), { normal: [0, 0, 1], constant: 3 });
    expect(isWatertight(above)).toBe(true);
    expect(isWatertight(below)).toBe(true);
    expect(meshVolume(below)).toBeCloseTo(300, 3);
    expect(meshVolume(above)).toBeCloseTo(700, 3);
    expect(computeBounds(above.positions).min[2]).toBeCloseTo(3);
  });

  it('splits along an oblique plane', () => {
    const n: [number, number, number] = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    const { above, below } = cutMesh(gridCube(10, 3), { normal: n, constant: (15 * 3) / Math.sqrt(3) / 3 * 1 });
    expect(isWatertight(above)).toBe(true);
    expect(isWatertight(below)).toBe(true);
    expect(meshVolume(above) + meshVolume(below)).toBeCloseTo(1000, 2);
  });

  it('cuts two overlapping shells into closed pieces', () => {
    const { above, below } = cutMesh(twoOverlappingShells(), { normal: [1, 0, 0], constant: 7 });
    expect(analyzeMesh(above).openEdges).toBe(0);
    expect(analyzeMesh(below).openEdges).toBe(0);
    expect(meshVolume(above) + meshVolume(below)).toBeCloseTo(2000, 2);
  });
});

describe('transform', () => {
  it('mirrors and keeps outward orientation', () => {
    const m = mirrorMesh(cube(), 0);
    expect(meshVolume(m)).toBeCloseTo(1000, 4);
    expect(isWatertight(m)).toBe(true);
  });
  it('lays a face flat', () => {
    // the +X face should end up facing -Z
    const q = layFlatQuaternion([1, 0, 0]);
    const m = applyMatrix(cube(), matrixFromQuaternion(q));
    const b = computeBounds(dropToBed(m).positions);
    expect(b.min[2]).toBeCloseTo(0);
    // the +X face (x = 10) maps to the lowest Z
    const p = matrixFromQuaternion(q);
    const z = p[2] * 10 + p[6] * 5 + p[10] * 5;
    expect(z).toBeCloseTo(computeBounds(m.positions).min[2]);
  });
});

describe('selection and extrude', () => {
  it('grows a coplanar region on a subdivided face', () => {
    const g = gridCube(10, 4);
    const r = growCoplanarRegion(g, 0, 5);
    expect(r.length).toBe(32); // one face = 4x4 quads = 32 triangles
  });

  it('extrudes a face outward and inward keeping it watertight', () => {
    const g = gridCube(10, 4);
    const topSeed = 32; // first triangle of the +Z face
    const region = growCoplanarRegion(g, topSeed, 5);
    const up = extrudeRegion(g, region, 5);
    expect(isWatertight(up)).toBe(true);
    expect(meshVolume(up)).toBeCloseTo(1500, 2);
    const down = extrudeRegion(g, region, -4);
    expect(isWatertight(down)).toBe(true);
    expect(meshVolume(down)).toBeCloseTo(600, 2);
  });

  it('extrudes part of a face', () => {
    const g = gridCube(10, 4);
    const sub = [32, 33]; // one quad of the top face
    const up = extrudeRegion(g, sub, 2);
    expect(isWatertight(up)).toBe(true);
    expect(meshVolume(up)).toBeCloseTo(1000 + 2.5 * 2.5 * 2, 3);
  });
});

describe('feature edges', () => {
  it('returns the 12 cube edges for a subdivided cube', () => {
    const seg = featureEdges(gridCube(10, 2), 30);
    expect(seg.length / 6).toBe(12 * 2);
  });
});

describe('area', () => {
  it('area of overlapping shells is the sum', () => {
    expect(meshArea(twoOverlappingShells())).toBeCloseTo(1200, 4);
  });
});
