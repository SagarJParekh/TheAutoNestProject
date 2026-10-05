import { describe, expect, it } from 'vitest';
import {
  alignMatrix, analyzeMesh, applyMatrix, booleanMeshes, boxMesh, computeBounds, faceNormalSegments, findIntersections,
  findShells, growCoplanarRegion, isWatertight, makeSolid, mergeMeshes, meshVolume, planProps, removeOverlappingTriangles,
  splitShells, stitchBoundaries, unifyShells, regionNormal,
} from '../src/geometry';
import { cube, gridCube, twoOverlappingShells } from './fixtures/meshes';

/** Cube whose top face uses its own (slightly displaced) copies of the 4 top vertices: a crack. */
function crackedCube(gap = 1e-3) {
  const c = cube();
  const pos = Array.from(c.positions);
  const idx = Array.from(c.indices);
  const copy: Record<number, number> = {};
  for (const v of [4, 5, 6, 7]) {
    copy[v] = pos.length / 3;
    pos.push(pos[v * 3] + gap, pos[v * 3 + 1], pos[v * 3 + 2]);
  }
  for (const t of [2, 3]) for (let k = 0; k < 3; k++) idx[t * 3 + k] = copy[idx[t * 3 + k]];
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

describe('stitching', () => {
  it('merges nearby boundary vertices to close a crack', () => {
    const m = crackedCube();
    expect(analyzeMesh(m).openEdges).toBe(8);
    const r = stitchBoundaries(m, 0.01);
    expect(r.mergedVertices).toBe(4);
    expect(r.openEdgesAfter).toBe(0);
    expect(isWatertight(r.mesh)).toBe(true);
  });

  it('fixes T-junctions', () => {
    // a 2x1 strip of quads next to a single long quad edge: z=0 square split into
    // left (one quad) and right (two quads with a midpoint) -> midpoint is a T-junction
    const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0, 1, 0.5, 0];
    const idx = [0, 1, 2, 0, 2, 3, 1, 4, 6, 4, 5, 6, 6, 5, 2];
    const m = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
    const r = stitchBoundaries(m, 1e-3);
    expect(r.splitEdges).toBe(1);
    // only the outer rectangle remains open: 6 boundary edges (bottom split at x=1, top split at x=1)
    expect(r.openEdgesAfter).toBe(6);
  });

  it('auto repair stitches the crack', async () => {
    const { autoRepair } = await import('../src/geometry');
    const r = autoRepair(crackedCube(), { stitchTolerance: 0.01 });
    expect(r.summary.stitchedVertices).toBe(4);
    expect(r.summary.after.watertight).toBe(true);
    expect(meshVolume(r.mesh)).toBeCloseTo(1000, 1);
  });
});

describe('intersections and overlaps', () => {
  it('finds no intersections on a clean cube', () => {
    const r = findIntersections(gridCube(10, 3));
    expect(r.intersecting.length).toBe(0);
    expect(r.overlapping.length).toBe(0);
  });

  it('finds crossing triangles between two overlapping shells', () => {
    const r = findIntersections(twoOverlappingShells());
    expect(r.intersecting.length).toBeGreaterThan(0);
  });

  it('finds and removes a duplicated coplanar face', () => {
    const c = cube();
    // duplicate the top face with its own vertices (not index-identical)
    const pos = Array.from(c.positions);
    const base = pos.length / 3;
    for (const v of [4, 5, 6, 7]) pos.push(c.positions[v * 3], c.positions[v * 3 + 1], c.positions[v * 3 + 2]);
    const idx = [...c.indices, base, base + 1, base + 2, base, base + 2, base + 3];
    const m = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
    const rep = findIntersections(m);
    expect(rep.overlapping.length).toBeGreaterThanOrEqual(2);
    const { mesh, removed } = removeOverlappingTriangles(m, rep);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(findIntersections(mesh).overlapping.length).toBe(0);
  });
});

describe('shells and booleans', () => {
  it('splits shells', () => {
    const s = splitShells(twoOverlappingShells());
    expect(s.length).toBe(2);
    expect(meshVolume(s[0])).toBeCloseTo(1000, 3);
  });

  it('unifies overlapping shells with an exact union', async () => {
    const { mesh, shells } = await unifyShells(twoOverlappingShells());
    expect(shells).toBe(2);
    expect(findShells(mesh).shellCount).toBe(1);
    expect(meshVolume(mesh)).toBeCloseTo(2000 - 125, 2);
  });

  it('makes a solid from overlapping shells by voxel remesh', () => {
    const out = makeSolid(twoOverlappingShells(), 0.25);
    expect(isWatertight(out)).toBe(true);
    expect(findShells(out).shellCount).toBe(1);
    expect(meshVolume(out)).toBeGreaterThan(1875 * 0.95);
    expect(meshVolume(out)).toBeLessThan(1875 * 1.03);
  });

  it('runs union, subtract and intersect', async () => {
    const a = cube(10), b = cube(10, [5, 5, 5]);
    expect(meshVolume(await booleanMeshes('union', a, [b]))).toBeCloseTo(1875, 2);
    expect(meshVolume(await booleanMeshes('subtract', a, [b]))).toBeCloseTo(875, 2);
    expect(meshVolume(await booleanMeshes('intersect', a, [b]))).toBeCloseTo(125, 2);
  });
});

describe('alignment', () => {
  it('mates the bottom of one cube onto the top of another (centred)', () => {
    const moving = cube(10, [30, 7, -4]);
    // source: bottom face of the moving cube; target: top face of a cube at the origin
    const m = alignMatrix(
      { point: [35, 12, -4], normal: [0, 0, -1] },
      { point: [5, 5, 10], normal: [0, 0, 1] },
      { mode: 'mate', offset: 0, center: true },
    );
    const b = computeBounds(applyMatrix(moving, m).positions);
    expect(b.min[2]).toBeCloseTo(10);
    expect(b.min[0]).toBeCloseTo(0);
    expect(b.min[1]).toBeCloseTo(0);
  });

  it('rotates a side face onto a target and keeps a gap', () => {
    const moving = cube(10, [20, 0, 0]);
    // the +X side of the moving cube should land facing down on top of z=10 with a 2 mm gap
    const m = alignMatrix(
      { point: [30, 5, 5], normal: [1, 0, 0] },
      { point: [5, 5, 10], normal: [0, 0, 1] },
      { mode: 'mate', offset: 2, center: false },
    );
    const out = applyMatrix(moving, m);
    expect(computeBounds(out.positions).min[2]).toBeCloseTo(12);
    expect(meshVolume(out)).toBeCloseTo(1000, 3);
  });

  it('flush mode keeps the same direction', () => {
    const m = alignMatrix(
      { point: [0, 0, 10], normal: [0, 0, 1] },
      { point: [0, 0, 25], normal: [0, 0, 1] },
      { mode: 'flush', offset: 0, center: false },
    );
    expect(computeBounds(applyMatrix(cube(), m).positions).max[2]).toBeCloseTo(25);
  });
});

describe('props', () => {
  it('generates props between two parallel plates', async () => {
    const lower = boxMesh([0, 0, 0], [40, 40, 3]);
    const upper = boxMesh([0, 0, 13], [40, 40, 16]);
    const top = growCoplanarRegion(lower, 2, 1); // +Z face of the lower plate
    expect(regionNormal(lower, top).normal[2]).toBeCloseTo(1);
    const plan = planProps(lower, top, upper, { diameter: 2, spacing: 10, margin: 3, maxLength: 50, embed: 0.5 });
    expect(plan.props.length).toBeGreaterThanOrEqual(9);
    for (const p of plan.props) {
      expect(p.start[2]).toBeCloseTo(2.5, 3);
      expect(p.end[2]).toBeCloseTo(13.5, 3);
    }
    // every prop is closed; the union with both plates is one solid
    const solid = await booleanMeshes('union', lower, [upper, plan.mesh]);
    expect(findShells(solid).shellCount).toBe(1);
    expect(isWatertight(solid)).toBe(true);
  });

  it('generates props between two shells of the same mesh and respects max length', () => {
    const both = mergeMeshes([boxMesh([0, 0, 0], [20, 20, 2]), boxMesh([0, 0, 8], [20, 20, 10])]);
    const top = growCoplanarRegion(both, 2, 1);
    const ok = planProps(both, top, both, { diameter: 1.5, spacing: 6, margin: 2, maxLength: 10, embed: 0.3 });
    expect(ok.props.length).toBeGreaterThan(0);
    const none = planProps(both, top, both, { diameter: 1.5, spacing: 6, margin: 2, maxLength: 3, embed: 0.3 });
    expect(none.props.length).toBe(0);
    expect(none.skipped).toBe(ok.props.length);
  });

  it('draws one normal hair per face', () => {
    const s = faceNormalSegments(cube(), 1);
    expect(s.length).toBe(12 * 6);
  });
});
