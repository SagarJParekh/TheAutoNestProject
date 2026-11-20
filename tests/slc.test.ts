import { describe, expect, it } from 'vitest';
import { boxMesh, flipMesh, subtractMeshes } from '../src/geometry';
import { exportSLC, readSLC, sliceMesh } from '../src/exporters';

const area = (c: Float32Array) => {
  let a = 0;
  for (let i = 0; i + 3 < c.length; i += 2) a += c[i] * c[i + 3] - c[i + 2] * c[i + 1];
  return a / 2;
};

describe('SLC export', () => {
  it('slices a box into one counter-clockwise square per layer', () => {
    const layers = sliceMesh(boxMesh([0, 0, 0], [20, 10, 5]), [1, 2.5, 4]);
    expect(layers.map((l) => l.length)).toEqual([1, 1, 1]);
    for (const [c] of layers) {
      expect(area(c)).toBeCloseTo(200, 3);
      expect(c[0]).toBe(c[c.length - 2]); // closed
    }
  });

  it('a tube gives an outer loop counter-clockwise and the hole clockwise', async () => {
    const tube = await subtractMeshes(boxMesh([0, 0, 0], [40, 40, 10]), [boxMesh([4, 4, -1], [36, 36, 11])]);
    const [loops] = sliceMesh(tube, [5]);
    expect(loops.length).toBe(2);
    const areas = loops.map(area).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(-32 * 32, 2);
    expect(areas[1]).toBeCloseTo(40 * 40, 2);
  });

  it('writes header, sampling table, layers and the end marker, and reads back', () => {
    const bytes = exportSLC([boxMesh([0, 0, 0], [10, 10, 1]), boxMesh([20, 0, 0], [30, 10, 1])], { layer: 0.1 });
    const r = readSLC(bytes);
    expect(r.header).toMatch(/^-SLCVER 2\.0 -UNIT MM -TYPE PART/);
    expect(r.header).toContain('-EXTENTS 0,30 0,10 0,1');
    expect(r.layer).toBeCloseTo(0.1, 6);
    expect(r.layers.length).toBe(10);
    expect(r.layers[0].z).toBeCloseTo(0.05, 5);
    expect(r.layers.every((l) => l.contours.length === 2)).toBe(true);
  });

  it('an inside-out part slices as a hole (clockwise)', () => {
    const [[c]] = sliceMesh(flipMesh(boxMesh([0, 0, 0], [10, 10, 10])), [5]);
    expect(area(c)).toBeCloseTo(-100, 3);
  });

  it('writes an inside-out part with its outline counter-clockwise all the same', () => {
    const r = readSLC(exportSLC([flipMesh(boxMesh([0, 0, 0], [10, 10, 1]))], { layer: 0.5 }));
    expect(area(r.layers[0].contours[0])).toBeCloseTo(100, 3);
  });

  it('a zero-thickness wall (block support) becomes a single line path in each layer', () => {
    // a vertical sheet from (0,0) to (10,0), 0..5 high, split in a few triangles
    const pos: number[] = [];
    for (let i = 0; i < 4; i++) {
      const x0 = i * 2.5, x1 = x0 + 2.5;
      pos.push(x0, 0, 0, x1, 0, 0, x1, 0, 5, x0, 0, 0, x1, 0, 5, x0, 0, 5);
    }
    const sheet = { positions: Float32Array.from(pos), indices: Uint32Array.from({ length: pos.length / 3 }, (_, i) => i) };
    const [loops] = sliceMesh(sheet, [2.5]);
    expect(loops.length).toBe(1);
    const c = loops[0];
    // from one end of the wall to the other and back: no area, spans the whole wall
    const xs = Array.from(c).filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeCloseTo(0, 4);
    expect(Math.max(...xs)).toBeCloseTo(10, 4);
    expect(c[0]).toBeCloseTo(c[c.length - 2], 6);
    let area = 0;
    for (let i = 0; i + 3 < c.length; i += 2) area += c[i] * c[i + 3] - c[i + 2] * c[i + 1];
    expect(Math.abs(area)).toBeLessThan(1e-6);
  });
});

