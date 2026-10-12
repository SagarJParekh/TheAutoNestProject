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

import { boxMesh, fixNonManifoldEdges, mergeMeshes } from '../src/geometry';

describe('fixNonManifoldEdges', () => {
  it('separates two cubes that share an edge without losing triangles', () => {
    const a = boxMesh([0, 0, 0], [10, 10, 10]);
    const b = boxMesh([10, 10, 0], [20, 20, 10]);
    // weld them so the shared edge (x=y=10) is one non-manifold edge
    const m = mergeMeshes([a, b]);
    const key = (i: number) => `${m.positions[i * 3]},${m.positions[i * 3 + 1]},${m.positions[i * 3 + 2]}`;
    const first = new Map<string, number>();
    const idx = Uint32Array.from(m.indices, (v) => {
      const k = key(v);
      if (!first.has(k)) first.set(k, v);
      return first.get(k)!;
    });
    const welded = { positions: m.positions, indices: idx };
    expect(analyzeMesh(welded).nonManifoldEdges).toBeGreaterThan(0);
    const r = fixNonManifoldEdges(welded);
    expect(r.removed).toBe(0);
    expect(r.split).toBeGreaterThan(0);
    const a2 = analyzeMesh(r.mesh);
    expect(a2.nonManifoldEdges).toBe(0);
    expect(a2.openEdges).toBe(0);
    expect(r.mesh.indices.length).toBe(welded.indices.length);
  });

  it('removes an internal wall and keeps the outer skin closed', () => {
    const c = boxMesh([0, 0, 0], [10, 10, 10]);
    // a wall x=5 spanning the full box, welded into the box corners would need box edges there; use a cube split mesh instead
    const pos = Array.from(c.positions);
    const vi = (x: number, y: number, z: number) => {
      for (let i = 0; i < pos.length / 3; i++) if (pos[i * 3] === x && pos[i * 3 + 1] === y && pos[i * 3 + 2] === z) return i;
      pos.push(x, y, z);
      return pos.length / 3 - 1;
    };
    // fin from the box edge (0,0,0)-(10,0,0) inward diagonally: shares that edge
    const a = vi(0, 0, 0), b = vi(10, 0, 0), d = vi(5, 5, 5);
    const fin = { positions: Float32Array.from(pos), indices: Uint32Array.from([...c.indices, a, b, d]) };
    expect(analyzeMesh(fin).nonManifoldEdges).toBe(1);
    const r = fixNonManifoldEdges(fin);
    expect(r.removed).toBe(1);
    expect(isWatertight(r.mesh)).toBe(true);
  });
});

import { autoRepair } from '../src/geometry';

describe('auto repair keeps shells', () => {
  it('two boxes sharing a face stay two closed shells', () => {
    const m = mergeMeshes([boxMesh([0, 0, 0], [5, 10, 10]), boxMesh([5, 0, 0], [10, 10, 10])]);
    const r = autoRepair(m);
    expect(r.summary.after.shells).toBe(2);
    expect(r.summary.after.triangles).toBe(24);
    expect(r.summary.after.watertight).toBe(true);
  });
  it('a box with a far-away small box keeps both', () => {
    const m = mergeMeshes([boxMesh([0, 0, 0], [50, 50, 50]), boxMesh([60, 0, 0], [61, 1, 1])]);
    const r = autoRepair(m);
    expect(r.summary.after.shells).toBe(2);
  });
});
