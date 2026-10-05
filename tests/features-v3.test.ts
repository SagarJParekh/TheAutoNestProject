import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  angle3, angleBetween, applyLabel, arrangeShelves, boxMesh, circleFrom3Points, computeBounds, cylinderMesh, exitRatioOf,
  findShells, fitCylinder, fitSphereRegion, gridArrayOffsets, growCoplanarRegion, growSmoothRegion, isWatertight, labelSolid,
  measureDistance, meshVolume, perforationCutters, planPerforation, pointHoleCutters, subtractMeshes, textOutlines, textureMesh,
  patternHeight, weldVertices,
} from '../src/geometry';
import type { MEntity } from '../src/geometry';
import { gridCube } from './fixtures/meshes';

const FONT = (() => {
  const b = readFileSync(new URL('../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf', import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
})();

/** UV sphere (welded, watertight). */
function sphere(r = 10, n = 24, m = 48, c: [number, number, number] = [0, 0, 0]) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j < m; j++) {
      const t = (Math.PI * i) / n, p = (2 * Math.PI * j) / m;
      pos.push(c[0] + r * Math.sin(t) * Math.cos(p), c[1] + r * Math.sin(t) * Math.sin(p), c[2] + r * Math.cos(t));
    }
  const v = (i: number, j: number) => i * m + (j % m);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      if (i > 0) idx.push(v(i, j), v(i + 1, j), v(i, j + 1));
      if (i < n - 1) idx.push(v(i, j + 1), v(i + 1, j), v(i + 1, j + 1));
    }
  return weldVertices(Float32Array.from(pos), Uint32Array.from(idx), 1e-6).mesh;
}

describe('measurement math', () => {
  const P = (p: [number, number, number]): MEntity => ({ kind: 'point', p });
  it('point to point / line / plane', () => {
    expect(measureDistance(P([0, 0, 0]), P([3, 4, 0])).distance).toBeCloseTo(5);
    const line: MEntity = { kind: 'line', a: [0, 0, 0], b: [10, 0, 0] };
    const r = measureDistance(P([5, 3, 4]), line);
    expect(r.distance).toBeCloseTo(5);
    expect(r.to).toEqual([5, 0, 0]);
    const plane: MEntity = { kind: 'plane', p: [0, 0, 2], n: [0, 0, 1] };
    expect(measureDistance(P([7, 7, 9]), plane).distance).toBeCloseTo(7);
  });
  it('skew and parallel lines', () => {
    const a: MEntity = { kind: 'line', a: [0, 0, 0], b: [1, 0, 0] };
    const b: MEntity = { kind: 'line', a: [0, 0, 5], b: [0, 1, 5] };
    const r = measureDistance(a, b);
    expect(r.distance).toBeCloseTo(5);
    expect(r.angle).toBeCloseTo(90);
    const c: MEntity = { kind: 'line', a: [0, 3, 0], b: [4, 3, 0] };
    expect(measureDistance(a, c).distance).toBeCloseTo(3);
  });
  it('parallel and angled planes', () => {
    const a: MEntity = { kind: 'plane', p: [0, 0, 0], n: [0, 0, 1] };
    const b: MEntity = { kind: 'plane', p: [3, 3, 12], n: [0, 0, -1] };
    expect(measureDistance(a, b).distance).toBeCloseTo(12);
    const c: MEntity = { kind: 'plane', p: [0, 0, 0], n: [0, 1, 1] };
    expect(angleBetween(a, c)).toBeCloseTo(45);
    const line: MEntity = { kind: 'line', a: [0, 0, 0], b: [1, 0, 1] };
    expect(angleBetween(line, a)).toBeCloseTo(45);
  });
  it('circle to circle gives centre and edge distances', () => {
    const a: MEntity = { kind: 'circle', c: [0, 0, 0], n: [0, 0, 1], r: 2 };
    const b: MEntity = { kind: 'circle', c: [10, 0, 0], n: [0, 0, 1], r: 3 };
    const r = measureDistance(a, b);
    expect(r.distance).toBeCloseTo(10);
    expect(r.extra.find((e) => e.label === 'Edge to edge')!.value).toBeCloseTo(5);
  });
  it('3-point angle and circle', () => {
    expect(angle3([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(90);
    const c = circleFrom3Points([5, 0, 1], [0, 5, 1], [-5, 0, 1]) as Extract<MEntity, { kind: 'circle' }>;
    expect(c.r).toBeCloseTo(5);
    expect(c.c[2]).toBeCloseTo(1);
    expect(Math.hypot(c.c[0], c.c[1])).toBeCloseTo(0);
  });
  it('fits a cylinder to a clicked round surface', () => {
    const cyl = cylinderMesh([3, 4, 0], [0, 0, 1], 6, 20, 64);
    // pick a side triangle (side triangles come first in groups of 4 per segment)
    const region = growSmoothRegion(cyl, 0, 20);
    const f = fitCylinder(cyl, region);
    expect(Math.abs(f.axis[2])).toBeCloseTo(1, 4);
    expect(f.r).toBeGreaterThan(5.95);
    expect(f.r).toBeLessThan(6.01);
    expect(f.c[0]).toBeCloseTo(3, 3);
    expect(f.c[1]).toBeCloseTo(4, 3);
  });
  it('fits a sphere', () => {
    const s = sphere(10, 24, 48, [1, 2, 3]);
    const f = fitSphereRegion(s, growSmoothRegion(s, 30, 30));
    expect(f.r).toBeCloseTo(10, 1);
    expect(f.c[0]).toBeCloseTo(1, 1);
  });
});

describe('perforation: point holes and taper', () => {
  it('cuts single holes at picked points', async () => {
    const plate = boxMesh([0, 0, 0], [30, 30, 4]);
    const params = { pattern: 'round' as const, size: 4, spacing: 2, margin: 1 };
    const cutters = pointHoleCutters(plate, [{ point: [10, 10, 4], normal: [0, 0, 1] }, { point: [20, 20, 4], normal: [0, 0, 1] }], params);
    const out = await subtractMeshes(plate, cutters);
    expect(isWatertight(out)).toBe(true);
    const holeArea = 0.5 * 32 * 4 * Math.sin((2 * Math.PI) / 32);
    expect(meshVolume(out)).toBeCloseTo(30 * 30 * 4 - 2 * holeArea * 4, 0);
  });
  it('makes tapered holes (frustum volume)', async () => {
    const plate = boxMesh([0, 0, 0], [30, 30, 6]);
    const params = { pattern: 'square' as const, size: 4, exitSize: 2, spacing: 2, margin: 1, depth: 0 };
    const out = await subtractMeshes(plate, pointHoleCutters(plate, [{ point: [15, 15, 6], normal: [0, 0, 1] }], params));
    // square frustum 4x4 -> 2x2 over 6 mm: V = h/3 (A1 + A2 + sqrt(A1 A2)) = 2*(16+4+8) = 56
    expect(meshVolume(out)).toBeCloseTo(30 * 30 * 6 - 56, 0);
    expect(exitRatioOf(params)).toBe(0.5);
  });
  it('tapered array keeps holes apart using the larger end', async () => {
    const plate = boxMesh([0, 0, 0], [30, 30, 3]);
    const top = growCoplanarRegion(plate, 2, 1);
    const params = { pattern: 'round' as const, size: 2, exitSize: 4, spacing: 1, margin: 1 };
    const plan = planPerforation(plate, top, params);
    const out = await subtractMeshes(plate, perforationCutters(plate, plan, 0, exitRatioOf(params)));
    expect(isWatertight(out)).toBe(true);
  });
});

describe('labels', () => {
  it('builds text outlines', () => {
    const o = textOutlines(FONT, 'AB8', 10);
    expect(o.polys.length).toBeGreaterThanOrEqual(5); // A(2) B(3) 8(3)
    expect(o.width).toBeGreaterThan(15);
    expect(o.height).toBeGreaterThan(6);
  });
  it('embosses text on a face (one solid, more volume)', async () => {
    const block = boxMesh([0, 0, 0], [60, 30, 10]);
    const { mesh, label } = await applyLabel(block, FONT, { text: 'HELLO', size: 8, depth: 1, mode: 'emboss', rotation: 0, sink: 0.5 }, [30, 15, 10], [0, 0, 1]);
    expect(isWatertight(label)).toBe(true);
    expect(isWatertight(mesh)).toBe(true);
    expect(meshVolume(mesh)).toBeGreaterThan(18000 + 20);
    expect(findShells(mesh).shellCount).toBe(1);
    expect(computeBounds(mesh.positions).max[2]).toBeCloseTo(11, 3);
  });
  it('engraves text (less volume) and handles letters with holes', async () => {
    const block = boxMesh([0, 0, 0], [60, 30, 10]);
    const { mesh } = await applyLabel(block, FONT, { text: 'OBA', size: 8, depth: 0.8, mode: 'engrave', rotation: 0, sink: 0 }, [0, 15, 5], [-1, 0, 0]);
    expect(isWatertight(mesh)).toBe(true);
    expect(meshVolume(mesh)).toBeLessThan(18000 - 10);
    // engraved on the -X side: the text plane lies between x = 0 and x = 0.8
    expect(computeBounds(mesh.positions).min[0]).toBeCloseTo(0, 5);
  });
  it('rotates text around the normal', async () => {
    const a = await labelSolid(FONT, { text: 'WIDE', size: 10, depth: 1, mode: 'emboss', rotation: 0, sink: 0 }, [0, 0, 0], [0, 0, 1]);
    const b = await labelSolid(FONT, { text: 'WIDE', size: 10, depth: 1, mode: 'emboss', rotation: 90, sink: 0 }, [0, 0, 0], [0, 0, 1]);
    const ba = computeBounds(a.positions), bb = computeBounds(b.positions);
    expect(ba.max[0] - ba.min[0]).toBeGreaterThan(ba.max[1] - ba.min[1]);
    expect(bb.max[1] - bb.min[1]).toBeGreaterThan(bb.max[0] - bb.min[0]);
  });
});

describe('texturing', () => {
  it('patterns stay within 0..1', () => {
    for (const pattern of ['knurl', 'ribs', 'waffle', 'dots', 'hex', 'noise'] as const)
      for (let i = 0; i < 200; i++) {
        const h = patternHeight({ pattern, period: 2, depth: 1, angle: 0, projection: 'planar' }, i * 0.137, i * 0.291);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(1.000001);
      }
  });
  it('textures one face, refines it and stays watertight', () => {
    const g = gridCube(20, 2);
    const top = growCoplanarRegion(g, 8, 1);
    const out = textureMesh(g, top, { pattern: 'knurl', period: 2, depth: 0.4, angle: 0, projection: 'planar' });
    expect(out.indices.length / 3).toBeGreaterThan(2000);
    expect(isWatertight(out)).toBe(true);
    const b = computeBounds(out.positions);
    expect(b.max[2]).toBeGreaterThan(20.2);
    expect(b.max[2]).toBeLessThanOrEqual(20.4001);
    // untouched faces stay where they were
    expect(b.min[2]).toBeCloseTo(0);
  });
  it('textures a whole part with triplanar projection (inward)', () => {
    const out = textureMesh(gridCube(10, 1), null, { pattern: 'dots', period: 2, depth: -0.3, angle: 0, projection: 'triplanar' });
    expect(isWatertight(out)).toBe(true);
    expect(meshVolume(out)).toBeLessThan(1000);
  });
  it('wraps a pattern seamlessly around a cylinder', () => {
    const cyl = cylinderMesh([0, 0, 0], [0, 0, 1], 10, 20, 64);
    const welded = weldVertices(cyl.positions, cyl.indices, 1e-5).mesh;
    const side = growSmoothRegion(welded, 0, 25);
    const out = textureMesh(welded, side, { pattern: 'ribs', period: 2, depth: 0.3, angle: 90, projection: 'cylindrical' });
    expect(isWatertight(out)).toBe(true);
    // ribs along the axis: radii vary between ~10 and ~10.3, top/bottom rims stay at 10
    let maxR = 0;
    for (let i = 0; i < out.positions.length; i += 3) maxR = Math.max(maxR, Math.hypot(out.positions[i], out.positions[i + 1]));
    expect(maxR).toBeGreaterThan(10.2);
    expect(maxR).toBeLessThan(10.35);
  });
  it('uses an image heightmap', () => {
    const data = new Float32Array(16).map((_, i) => (i % 2 ? 1 : 0));
    const out = textureMesh(gridCube(10, 1), null, {
      pattern: 'image', period: 5, depth: 0.5, angle: 0, projection: 'triplanar', heightmap: { width: 4, height: 4, data },
    });
    expect(isWatertight(out)).toBe(true);
  });
});

describe('2D arrangement', () => {
  it('packs footprints in rows within the bed width', () => {
    const r = arrangeShelves(
      [{ id: 'a', w: 50, d: 30 }, { id: 'b', w: 50, d: 20 }, { id: 'c', w: 50, d: 20 }, { id: 'd', w: 120, d: 10 }],
      120,
      5,
    );
    expect(r.placements.length).toBe(4);
    expect(r.width).toBeLessThanOrEqual(120);
    // no overlaps
    const sizes: Record<string, [number, number]> = { a: [50, 30], b: [50, 20], c: [50, 20], d: [120, 10] };
    for (const p of r.placements)
      for (const q of r.placements) {
        if (p === q) continue;
        const [pw, pd] = sizes[p.id], [qw, qd] = sizes[q.id];
        const overlap = p.x < q.x + qw && q.x < p.x + pw && p.y < q.y + qd && q.y < p.y + pd;
        expect(overlap).toBe(false);
      }
  });
  it('grid array offsets', () => {
    expect(gridArrayOffsets(3, 2, 10, 20)).toEqual([[10, 0], [20, 0], [0, 20], [10, 20], [20, 20]]);
  });
});
