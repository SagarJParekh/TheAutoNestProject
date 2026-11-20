import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { boxMesh, flipMesh, mergeMeshes } from '../src/geometry';
import { exportCLS, readCLS } from '../src/exporters';

// written by Concept Laser's own software: a 20 mm cube at x 203.048…223.048, y 113.917…133.917 on the M2's 245 mm platform, 0.05 mm layers
const reference = new Uint8Array(readFileSync(new URL('./fixtures/concept-laser-box-20mm.cls', import.meta.url)));
const M2 = { layer: 0.05, plate: [245, 245] as [number, number], shift: [122.5, 122.5] as [number, number] };
// the same cube in the app's coordinates (platform centre at 0, 0)
const cube = boxMesh([203.0481 - 122.5, 113.9173 - 122.5, 0], [223.0481 - 122.5, 133.9173 - 122.5, 20]);

/** a contour as a set of points, starting anywhere (the direction must match) */
const cyclic = (c: Float64Array) => {
  const pts = Array.from({ length: c.length / 2 }, (_, i) => `${c[i * 2].toFixed(4)},${c[i * 2 + 1].toFixed(4)}`);
  const k = pts.indexOf([...pts].sort()[0]);
  return [...pts.slice(k), ...pts.slice(0, k)].join(' ');
};

describe('CLS (Concept Laser) export', () => {
  it('writes a 20 mm cube the way Concept Laser does', () => {
    const ours = exportCLS([cube], [], M2);
    // byte for byte the same file
    expect(Buffer.from(ours).equals(Buffer.from(reference))).toBe(true);
    const a = readCLS(ours), b = readCLS(reference);
    expect(a.header).toBe(b.header);
    expect(ours.length).toBe(reference.length);
    expect(a.layers.length).toBe(400);
    a.layers.forEach((l, i) => {
      const r = b.layers[i];
      expect(l.z).toBeCloseTo(r.z, 6);
      expect(l.raw).toEqual(r.raw);
      expect(l.parts.map(cyclic)).toEqual(r.parts.map(cyclic));
      expect(l.supports.length).toBe(0);
    });
  });

  it('outer contours clockwise, holes counter-clockwise, supports in the support section, layers on the platform grid', () => {
    // a 20 mm square tube (a hole through it), raised 3 mm, and a support pillar under it
    const tube = mergeMeshes([boxMesh([0, 0, 3], [20, 20, 13]), flipMesh(boxMesh([5, 5, 3], [15, 15, 13]))]);
    const pillar = boxMesh([8, -2, 0], [10, 0, 3]);
    const f = readCLS(exportCLS([tube], [pillar], M2));
    expect(f.layers[0].z).toBe(0);
    expect(f.layers.length).toBe(260);
    const area = (c: Float64Array) => {
      let s = 0;
      for (let i = 0; i < c.length; i += 2) {
        const j = (i + 2) % c.length;
        s += c[i] * c[j + 1] - c[j] * c[i + 1];
      }
      return s / 2;
    };
    const low = f.layers[10], high = f.layers[100];
    expect(low.parts.length).toBe(0);
    expect(low.supports.length).toBe(1);
    expect(area(low.supports[0])).toBeCloseTo(-4, 3);
    expect(high.supports.length).toBe(0);
    const areas = high.parts.map(area).sort((x, y) => x - y);
    expect(areas[0]).toBeCloseTo(-400, 2); // outer, clockwise
    expect(areas[1]).toBeCloseTo(100, 2); // hole, counter-clockwise
    // platform coordinates: the tube's corner at 122.5, 122.5
    expect(Math.min(...Array.from(high.parts[0]).filter((_, i) => i % 2 === 0))).toBeCloseTo(122.5, 4);
  });
});
