import { describe, expect, it } from 'vitest';
import { analyzeMesh, boxMesh, findDuplicates, isWatertight, mergeMeshes, removeDuplicateTriangles } from '../src/geometry';
import type { MeshData } from '../src/geometry';

const weldExact = (m: MeshData): MeshData => {
  const first = new Map<string, number>();
  return {
    positions: m.positions,
    indices: Uint32Array.from(m.indices, (v) => {
      const k = `${m.positions[v * 3]},${m.positions[v * 3 + 1]},${m.positions[v * 3 + 2]}`;
      if (!first.has(k)) first.set(k, v);
      return first.get(k)!;
    }),
  };
};
const flip = (m: MeshData): MeshData => {
  const idx = Uint32Array.from(m.indices);
  for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
  return { positions: m.positions, indices: idx };
};

describe('duplicate triangles', () => {
  const box = boxMesh([0, 0, 0], [10, 10, 10]);

  it('finds a shell exported twice with its own vertices', () => {
    const twice = mergeMeshes([box, box]);
    expect(analyzeMesh(twice).duplicateTriangles).toBe(12);
    const r = removeDuplicateTriangles(twice);
    expect(r.removed).toBe(12);
    expect(isWatertight(r.mesh)).toBe(true);
    expect(r.mesh.indices.length / 3).toBe(12);
  });

  it('finds copies that differ by float noise', () => {
    const noisy = mergeMeshes([box, { positions: box.positions.map((v) => v + 1e-6), indices: box.indices }]);
    expect(findDuplicates(noisy).copies.length).toBe(12);
    expect(isWatertight(removeDuplicateTriangles(noisy).mesh)).toBe(true);
  });

  it('removes a doubled face on a welded mesh and stays watertight', () => {
    const m = { positions: box.positions, indices: Uint32Array.from([...box.indices, box.indices[0], box.indices[1], box.indices[2]]) };
    const r = removeDuplicateTriangles(m);
    expect(r.removed).toBe(1);
    expect(isWatertight(r.mesh)).toBe(true);
  });

  it('finds a stray inside-out copy of a face and removes only the copy', () => {
    const face = { positions: box.positions, indices: box.indices.slice(0, 6) };
    const m = weldExact(mergeMeshes([box, flip(face)]));
    const d = findDuplicates(m);
    expect(d.walls.length).toBe(0);
    expect(Array.from(d.copies)).toEqual([12, 13]);
    expect(analyzeMesh(m).duplicateTriangles).toBe(2);
    const r = removeDuplicateTriangles(m);
    expect(r.removed).toBe(2);
    expect(isWatertight(r.mesh)).toBe(true);
  });

  it('two touching boxes sharing identical face triangles join into one solid', () => {
    // mirror the box about x = 10: its x = 10 face is the first box's face, facing the other way
    const b = flip({ positions: box.positions.map((v, i) => (i % 3 === 0 ? 20 - v : v)), indices: box.indices });
    const m = weldExact(mergeMeshes([box, b]));
    const d = findDuplicates(m);
    expect(d.walls.length).toBe(4);
    expect(removeDuplicateTriangles(m).removed).toBe(0);
    const r = removeDuplicateTriangles(m, { walls: 'remove' });
    expect(isWatertight(r.mesh)).toBe(true);
    expect(analyzeMesh(r.mesh).shells).toBe(1);
    expect(r.mesh.indices.length / 3).toBe(20);
  });
});
