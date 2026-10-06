import { describe, expect, it } from 'vitest';
import {
  analyzeMesh, blendEdges, boxMesh, bridgeEdges, buildTopology, chainEdges, findCrackEdges, findSharpEdge, growCoplanarRegion, isWatertight,
  meshVolume, offsetMesh, offsetRegion, openEdgeOfTriangle, subsetTriangles, unionMeshes, type MeshData,
} from '../src/geometry';
import { highlightColors } from '../src/state/contrast';

/** Open edges of a mesh in their triangle's direction. */
function openEdges(m: MeshData): [number, number][] {
  const topo = buildTopology(m);
  const out: [number, number][] = [];
  for (let e = 0; e < topo.edgeCount; e++) {
    if (topo.edgeFaceCount[e] !== 1) continue;
    const h = topo.edgeHE0[e], t = (h / 3) | 0;
    out.push([m.indices[h], m.indices[t * 3 + ((h - t * 3 + 1) % 3)]]);
  }
  return out;
}

describe('offset', () => {
  const box = boxMesh([0, 0, 0], [10, 10, 10]);
  it('grows a box like a true offset (rounded edges and corners)', () => {
    const r = offsetMesh(box, 1);
    expect(isWatertight(r.mesh)).toBe(true);
    const exact = 1000 + 6 * 100 + 12 * 10 * (Math.PI / 4) + (4 / 3) * Math.PI;
    expect(Math.abs(meshVolume(r.mesh) - exact) / exact).toBeLessThan(0.01);
  });
  it('shrinks a box', () => {
    const r = offsetMesh(box, -1);
    expect(isWatertight(r.mesh)).toBe(true);
    expect(Math.abs(meshVolume(r.mesh) - 512) / 512).toBeLessThan(0.01);
  });
  it('offsets one face along its normal and keeps the part closed', () => {
    const top = growCoplanarRegion(box, 2);
    const up = offsetRegion(box, top, 2);
    expect(isWatertight(up)).toBe(true);
    expect(meshVolume(up)).toBeCloseTo(1200, 6);
    const down = offsetRegion(box, top, -3);
    expect(meshVolume(down)).toBeCloseTo(700, 6);
  });
});

describe('fillet and chamfer', () => {
  const box = boxMesh([0, 0, 0], [10, 10, 10]);
  it('finds a straight sharp edge with its faces', () => {
    const e = findSharpEdge(box, [0, 0, 10], [10, 0, 10]);
    expect(e.convex).toBe(true);
    expect(e.angle).toBeCloseTo(90, 6);
    expect(Math.hypot(e.p1[0] - e.p0[0], e.p1[1] - e.p0[1], e.p1[2] - e.p0[2])).toBeCloseTo(10, 6);
  });
  it('rounds and bevels an outside edge by the exact amount', async () => {
    const e = findSharpEdge(box, [0, 0, 10], [10, 0, 10]);
    const f = await blendEdges(box, [e], 'fillet', 2);
    expect(isWatertight(f)).toBe(true);
    // corner square minus quarter circle, along 10 mm (polygonal circle: within 2 %)
    const exactFillet = (4 - Math.PI) * 10;
    expect(Math.abs(1000 - meshVolume(f) - exactFillet) / exactFillet).toBeLessThan(0.02);
    const c = await blendEdges(box, [e], 'chamfer', 2);
    expect(isWatertight(c)).toBe(true);
    expect(1000 - meshVolume(c)).toBeCloseTo(20, 4);
  });
  it('adds material in an inside corner', async () => {
    const L = await unionMeshes([boxMesh([0, 0, 0], [20, 10, 5]), boxMesh([0, 0, 0], [5, 10, 20])]);
    const e = findSharpEdge(L, [5, 0, 5], [5, 10, 5]);
    expect(e.convex).toBe(false);
    expect(e.angle).toBeCloseTo(270, 6);
    const r = await blendEdges(L, [e], 'fillet', 3);
    expect(isWatertight(r)).toBe(true);
    const exact = (9 - (Math.PI * 9) / 4) * 10;
    expect(Math.abs(meshVolume(r) - meshVolume(L) - exact) / exact).toBeLessThan(0.02);
  });
  it('fillets several edges at once', async () => {
    const edges = [
      findSharpEdge(box, [0, 0, 10], [10, 0, 10]),
      findSharpEdge(box, [10, 0, 10], [10, 10, 10]),
    ];
    const r = await blendEdges(box, edges, 'fillet', 1.5);
    expect(isWatertight(r)).toBe(true);
    expect(meshVolume(r)).toBeLessThan(1000);
  });
});

describe('bridge', () => {
  it('bridges the two sides of a gap with correctly wound triangles', () => {
    const box = boxMesh([0, 0, 0], [10, 10, 10]);
    const top = growCoplanarRegion(box, 2);
    const open = subsetTriangles(box, (t) => !top.includes(t));
    const p = open.positions;
    const edges = openEdges(open);
    const atY = (y: number) => edges.filter(([a, b]) => p[a * 3 + 1] === y && p[b * 3 + 1] === y);
    const r = bridgeEdges(open, atY(0), atY(10));
    expect(r.added).toBe(2);
    expect(isWatertight(r.mesh)).toBe(true);
    expect(analyzeMesh(r.mesh).flippedTriangles).toBe(0);
    expect(meshVolume(r.mesh)).toBeCloseTo(1000, 6);
  });
  it('orders edges into a chain and rejects gaps', () => {
    expect(chainEdges([[2, 3], [1, 2], [3, 4]])).toEqual([1, 2, 3, 4]);
    expect(() => chainEdges([[1, 2], [5, 6]])).toThrow();
  });
  it('finds the open edge of a clicked triangle', () => {
    const box = boxMesh([0, 0, 0], [10, 10, 10]);
    const open = subsetTriangles(box, (t) => t !== 0);
    const topo = buildTopology(open);
    let found = 0;
    for (let t = 0; t < open.indices.length / 3; t++) if (openEdgeOfTriangle(open, t, [5, 5, 5], topo)) found++;
    expect(found).toBeGreaterThan(0);
  });
});

describe('open edges and cracks', () => {
  it('tells stitchable cracks apart from real holes', () => {
    // two boxes side by side, one face of each removed, with a hairline gap between the openings: cracks
    const a = boxMesh([0, 0, 0], [10, 10, 10]);
    const b = boxMesh([10.001, 0, 0], [20, 10, 10]);
    const cutA = subsetTriangles(a, (t) => {
      const xs = [0, 1, 2].map((k) => a.positions[a.indices[t * 3 + k] * 3]);
      return !xs.every((x) => x === 10);
    });
    const cutB = subsetTriangles(b, (t) => {
      const xs = [0, 1, 2].map((k) => b.positions[b.indices[t * 3 + k] * 3]);
      return !xs.every((x) => Math.abs(x - 10.001) < 1e-6);
    });
    const merged = { positions: Float32Array.from([...cutA.positions, ...cutB.positions]), indices: Uint32Array.from([...cutA.indices, ...Array.from(cutB.indices, (i) => i + cutA.positions.length / 3)]) };
    const report = analyzeMesh(merged);
    expect(report.openEdges).toBe(8);
    expect(report.crackEdges).toBe(8);
    // a single box with a missing face: a hole, no cracks
    const hole = analyzeMesh(cutA);
    expect(hole.openEdges).toBe(4);
    expect(hole.crackEdges).toBe(0);
    const flags = findCrackEdges(cutA);
    expect(Array.from(flags).some((f) => f === 1)).toBe(false);
  });
  it('picks highlight colours that differ from the part and from each other', () => {
    for (const part of ['#ff1744', '#ffea00', '#00e5ff', '#3fa7ff', '#22aa44']) {
      const c = highlightColors(part);
      const set = new Set([part.toLowerCase(), c.open, c.crack, c.nonManifold]);
      expect(set.size).toBe(4);
    }
  });
});
