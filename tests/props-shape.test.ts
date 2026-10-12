import { describe, expect, it } from 'vitest';
import { isWatertight, meshVolume, propMesh } from '../src/geometry';
import type { PropParams } from '../src/geometry';

const base: PropParams = { diameter: 2, spacing: 8, margin: 2, maxLength: 50, embed: 0.5 };

describe('propMesh', () => {
  it('builds closed, outward props for every shape', () => {
    for (const shape of ['circle', 'square', 'hexagon', 'triangle'] as const) {
      for (const thinEnds of [false, true]) {
        const m = propMesh([0, 0, 0], [0, 0, 1], 10, { ...base, shape, thinEnds, tipDiameter: 1, tipLength: 1 });
        expect(isWatertight(m)).toBe(true);
        expect(meshVolume(m)).toBeGreaterThan(0);
      }
    }
  });

  it('square prop has the given width across flats', () => {
    const m = propMesh([0, 0, 0], [0, 0, 1], 10, { ...base, shape: 'square' });
    expect(meshVolume(m)).toBeCloseTo(2 * 2 * 10, 3);
  });

  it('thin ends remove material at both ends', () => {
    const full = meshVolume(propMesh([0, 0, 0], [0, 0, 1], 10, { ...base, shape: 'square' }));
    const thin = meshVolume(propMesh([0, 0, 0], [0, 0, 1], 10, { ...base, shape: 'square', thinEnds: true, tipDiameter: 1, tipLength: 1 }));
    // ends: 2 × 1.5 mm at 1×1 instead of 2×2
    expect(thin).toBeCloseTo(full - 2 * 1.5 * (4 - 1), 3);
  });
});

import { analyzeMesh, errorGroups, trianglesOfGroup } from '../src/geometry';
import { gridCube } from './fixtures/meshes';

describe('errorGroups', () => {
  it('splits separate holes into separate problems', () => {
    const m = gridCube(10, 4);
    const nt = m.indices.length / 3;
    // drop two triangles far apart: two separate holes
    const drop = new Set([0, nt - 1]);
    const idx: number[] = [];
    for (let t = 0; t < nt; t++) if (!drop.has(t)) idx.push(m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2]);
    const holed = { positions: m.positions, indices: Uint32Array.from(idx) };
    const groups = errorGroups(holed, analyzeMesh(holed));
    const open = groups.filter((g) => g.kind === 'open' || g.kind === 'crack');
    expect(open.length).toBe(2);
    for (const g of open) {
      expect(g.count).toBe(3);
      expect(trianglesOfGroup(holed, g).length).toBeGreaterThan(0);
    }
  });
});
