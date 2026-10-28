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
});
