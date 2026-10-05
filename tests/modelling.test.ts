import { describe, expect, it } from 'vitest';
import {
  analyzeMesh,
  boxMesh,
  cutMesh,
  cylinderMesh,
  drainHoleCutters,
  growCoplanarRegion,
  hollowMesh,
  isManifold,
  isWatertight,
  meshVolume,
  perforationCutters,
  planPerforation,
  splitByPlaneManifold,
  subtractMeshes,
  findShells,
  unionMeshes,
} from '../src/geometry';
import { cube, cubeWithHole, gridCube, twoOverlappingShells } from './fixtures/meshes';

describe('manifold-3d integration', () => {
  it('recognises manifold and non-manifold inputs', async () => {
    expect(await isManifold(cube())).toBe(true);
    expect(await isManifold(cubeWithHole())).toBe(false);
  });

  it('subtracts a cylinder and the result can be cut with closed caps (annulus)', async () => {
    const ring = await subtractMeshes(boxMesh([0, 0, 0], [20, 20, 10]), [cylinderMesh([10, 10, -1], [0, 0, 1], 4, 12, 48)]);
    expect(isWatertight(ring)).toBe(true);
    const { above, below } = cutMesh(ring, { normal: [0, 0, 1], constant: 5 });
    expect(isWatertight(above)).toBe(true);
    expect(isWatertight(below)).toBe(true);
    expect(meshVolume(above) + meshVolume(below)).toBeCloseTo(meshVolume(ring), 1);
  });

  it('splits by plane exactly', async () => {
    const r = await splitByPlaneManifold(cube(), { normal: [0, 0, 1], constant: 4 });
    expect(r).not.toBeNull();
    expect(meshVolume(r!.above)).toBeCloseTo(600, 3);
    expect(meshVolume(r!.below)).toBeCloseTo(400, 3);
  });

  it('unions two overlapping shells into one solid', async () => {
    const u = await unionMeshes([cube(10, [0, 0, 0]), cube(10, [5, 5, 5])]);
    expect(meshVolume(u)).toBeCloseTo(2000 - 125, 2);
    expect(findShells(u).shellCount).toBe(1);
    void twoOverlappingShells;
  });
});

describe('hollow', () => {
  it('creates an inner offset shell at the requested wall thickness', () => {
    const solid = boxMesh([0, 0, 0], [20, 20, 20]);
    const { mesh, inner, voxelSize } = hollowMesh(solid, { thickness: 2, voxelSize: 0.5 });
    expect(voxelSize).toBe(0.5);
    // inner shell is closed and faces inward (negative volume)
    expect(analyzeMesh(inner).openEdges).toBe(0);
    expect(meshVolume(inner)).toBeLessThan(0);
    // ideal cavity is 16³ = 4096; marching tets chamfers the corners slightly
    expect(-meshVolume(inner)).toBeGreaterThan(4096 * 0.93);
    expect(-meshVolume(inner)).toBeLessThan(4096 * 1.02);
    // whole hollow part is watertight and has two shells
    expect(isWatertight(mesh)).toBe(true);
    expect(findShells(mesh).shellCount).toBe(2);
  });

  it('rejects too-thick walls', () => {
    expect(() => hollowMesh(boxMesh([0, 0, 0], [4, 4, 4]), { thickness: 3, voxelSize: 0.5 })).toThrow();
  });

  it('drain holes open the cavity', async () => {
    const solid = boxMesh([0, 0, 0], [20, 20, 20]);
    const { mesh, voxelSize } = hollowMesh(solid, { thickness: 2, voxelSize: 0.5 });
    expect(await isManifold(mesh)).toBe(true);
    const cutters = drainHoleCutters([{ point: [10, 10, 0], normal: [0, 0, -1] }], 3, 2, voxelSize);
    const drained = await subtractMeshes(mesh, cutters);
    // drained part is one connected shell now
    expect(findShells(drained).shellCount).toBe(1);
    expect(isWatertight(drained)).toBe(true);
  });
});

describe('perforation', () => {
  it('plans a square pattern with margins on a face', () => {
    const g = gridCube(20, 2);
    const region = growCoplanarRegion(g, 8, 1); // +Z face (2x2 quads = 8 tris)
    const plan = planPerforation(g, region, { pattern: 'square', size: 2, spacing: 2, margin: 1 });
    // pitch 4mm on a 20mm face with 1mm margin + half-diagonal clearance
    // centres at 6, 10, 14 on each axis (2 and 18 violate the 1 mm margin)
    expect(plan.centers.length).toBe(9);
    for (const c of plan.centers) {
      expect(c[2]).toBeCloseTo(20);
      expect(c[0]).toBeGreaterThan(1 + 1.41);
      expect(c[0]).toBeLessThan(20 - 1 - 1.41);
    }
    expect(plan.normal[2]).toBeCloseTo(1);
  });

  it('applies round holes through a plate', async () => {
    const plate = boxMesh([0, 0, 0], [30, 30, 3]);
    const top = growCoplanarRegion(plate, 2, 1);
    const plan = planPerforation(plate, top, { pattern: 'round', size: 3, spacing: 2, margin: 2 });
    expect(plan.centers.length).toBeGreaterThan(10);
    const cutters = perforationCutters(plate, plan);
    const out = await subtractMeshes(plate, cutters);
    expect(isWatertight(out)).toBe(true);
    const r = 1.5;
    const holeArea = plan.centers.length * 0.5 * 32 * r * r * Math.sin((2 * Math.PI) / 32);
    expect(meshVolume(out)).toBeCloseTo(30 * 30 * 3 - holeArea * 3, 0);
  });

  it('applies a hex pattern', async () => {
    const plate = boxMesh([0, 0, 0], [30, 30, 3]);
    const top = growCoplanarRegion(plate, 2, 1);
    const plan = planPerforation(plate, top, { pattern: 'hex', size: 4, spacing: 1.5, margin: 1.5 });
    const out = await subtractMeshes(plate, perforationCutters(plate, plan));
    const hexArea = (Math.sqrt(3) / 2) * 4 * 4;
    expect(meshVolume(out)).toBeCloseTo(2700 - plan.centers.length * hexArea * 3, 0);
  });
});
