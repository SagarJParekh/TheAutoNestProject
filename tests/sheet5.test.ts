import { describe, expect, it } from 'vitest';
import { strFromU8 } from 'fflate';
import { arrangeBoxes, analyzeMesh, cylinderMesh, isWatertight, meshVolume, simplifyMesh, weldVertices, type MeshData } from '../src/geometry';
import { exportMeshes, exportOBJ } from '../src/exporters';
import { importFile } from '../src/loaders/pipeline';
import { cube } from './fixtures/meshes';

/** Closed UV sphere with `seg` segments and `seg/2` rings. */
function sphere(r: number, seg: number): MeshData {
  const rings = seg / 2;
  const pos: number[] = [];
  const idx: number[] = [];
  pos.push(0, 0, r);
  for (let i = 1; i < rings; i++) {
    const th = (Math.PI * i) / rings;
    for (let j = 0; j < seg; j++) {
      const ph = (2 * Math.PI * j) / seg;
      pos.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
    }
  }
  pos.push(0, 0, -r);
  const v = (i: number, j: number) => 1 + (i - 1) * seg + (j % seg);
  const south = pos.length / 3 - 1;
  for (let j = 0; j < seg; j++) idx.push(0, v(1, j), v(1, j + 1));
  for (let i = 1; i < rings - 1; i++)
    for (let j = 0; j < seg; j++) idx.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i, j + 1));
  for (let j = 0; j < seg; j++) idx.push(v(rings - 1, j), south, v(rings - 1, j + 1));
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

describe('simplifyMesh', () => {
  it('halves a sphere and keeps it closed and the right shape', () => {
    const s = sphere(10, 96);
    expect(isWatertight(s)).toBe(true);
    const v0 = meshVolume(s);
    expect(v0).toBeGreaterThan(0);
    const r = simplifyMesh(s, 0.5);
    expect(r.trianglesAfter).toBeLessThanOrEqual(Math.ceil(r.trianglesBefore * 0.5) + 2);
    expect(r.trianglesAfter).toBeGreaterThan(r.trianglesBefore * 0.4);
    expect(isWatertight(r.mesh)).toBe(true);
    const a = analyzeMesh(r.mesh);
    expect(a.nonManifoldEdges).toBe(0);
    expect(a.flippedTriangles).toBe(0);
    expect(Math.abs(meshVolume(r.mesh) - v0) / v0).toBeLessThan(0.01);
  });

  it('reduces strongly (10%) without breaking the surface', () => {
    const r = simplifyMesh(sphere(10, 96), 0.1);
    expect(r.trianglesAfter).toBeLessThan(r.trianglesBefore * 0.12);
    expect(isWatertight(r.mesh)).toBe(true);
    expect(Math.abs(meshVolume(r.mesh) - (4 / 3) * Math.PI * 1000) / ((4 / 3) * Math.PI * 1000)).toBeLessThan(0.05);
  });

  it('keeps flat-sided shapes exact: a dense cylinder keeps its volume', () => {
    const cy = cylinderMesh([0, 0, 0], [0, 0, 1], 5, 20, 256);
    const c = weldVertices(cy.positions, cy.indices, 1e-6).mesh;
    const v0 = meshVolume(c);
    const r = simplifyMesh(c, 0.25);
    expect(r.trianglesAfter).toBeLessThan(r.trianglesBefore * 0.3);
    expect(isWatertight(r.mesh)).toBe(true);
    expect(Math.abs(meshVolume(r.mesh) - v0) / v0).toBeLessThan(0.01);
  });

  it('returns the original mesh at ratio 1 and never destroys a cube', () => {
    const s = sphere(5, 32);
    expect(simplifyMesh(s, 1).mesh).toBe(s);
    const c = cube();
    const r = simplifyMesh(c, 0.1);
    expect(isWatertight(r.mesh)).toBe(true);
    expect(meshVolume(r.mesh)).toBeCloseTo(1000, 3);
  });
});

describe('export options', () => {
  it('writes ASCII STL that re-imports with the same triangles', async () => {
    const m = cube();
    const bytes = exportMeshes('stl', [{ name: 'my cube', mesh: m }], { stlAscii: true, decimals: 3 });
    const text = strFromU8(bytes);
    expect(text.startsWith('solid my_cube')).toBe(true);
    expect(text.trim().endsWith('endsolid my_cube')).toBe(true);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const bodies = await importFile(ab, { fileName: 'c.stl', onProgress: () => {}, warn: () => {} } as never);
    expect(bodies[0].mesh.indices.length).toBe(m.indices.length);
    expect(meshVolume(bodies[0].mesh)).toBeCloseTo(1000, 3);
  });

  it('rounds coordinates to the chosen decimals', () => {
    const m: MeshData = { positions: Float32Array.from([0.123456, 1.5, -0.0001, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) };
    const obj = strFromU8(exportOBJ([{ name: 't', mesh: m }], 2));
    expect(obj).toContain('v 0.12 1.5 0\n');
    const full = strFromU8(exportOBJ([{ name: 't', mesh: m }]));
    expect(full).toContain('v 0.123456');
  });
});

describe('arrangeBoxes', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, size: [20 + i, 30, 10 + (i % 3) * 5] as [number, number, number] }));
  const overlaps = (pl: { min: number[] }[], sizes: Map<string, number[]>, ids: string[]) => {
    for (let i = 0; i < pl.length; i++)
      for (let j = i + 1; j < pl.length; j++) {
        const a = pl[i], b = pl[j], sa = sizes.get(ids[i])!, sb = sizes.get(ids[j])!;
        let sep = false;
        for (let k = 0; k < 3; k++) if (a.min[k] + sa[k] <= b.min[k] + 1e-9 || b.min[k] + sb[k] <= a.min[k] + 1e-9) sep = true;
        if (!sep) return true;
      }
    return false;
  };
  const sizes = new Map(items.map((it) => [it.id, it.size]));
  const check = (axes: ('x' | 'y' | 'z')[], bed: [number, number, number] = [100, 100, 100]) => {
    const r = arrangeBoxes(items, axes, bed, 2);
    expect(r.placements.length).toBe(items.length);
    expect(overlaps(r.placements, sizes, r.placements.map((p) => p.id))).toBe(false);
    for (const p of r.placements) expect(p.min[2]).toBeGreaterThanOrEqual(0);
    return r;
  };

  it('one axis puts every part in a single line', () => {
    const rx = check(['x']);
    expect(new Set(rx.placements.map((p) => p.min[1] + sizes.get(p.id)![1] / 2)).size).toBe(1);
    expect(rx.size[0]).toBeCloseTo(items.reduce((s, it) => s + it.size[0], 0) + 2 * 9, 6);
    const rz = check(['z']);
    expect(rz.size[2]).toBeCloseTo(items.reduce((s, it) => s + it.size[2], 0) + 2 * 9, 6);
    expect(rz.placements.every((p) => Math.abs(p.min[0] + sizes.get(p.id)![0] / 2) < 1e-9)).toBe(true);
  });

  it('two axes wrap rows at the bed size and stay on the bed in Z', () => {
    const r = check(['x', 'y']);
    expect(r.size[0]).toBeLessThanOrEqual(100);
    expect(r.placements.every((p) => p.min[2] === 0)).toBe(true);
    const rows = new Set(r.placements.map((p) => p.min[1].toFixed(3)));
    expect(rows.size).toBeGreaterThan(1);
    const xz = check(['x', 'z']);
    expect(xz.size[0]).toBeLessThanOrEqual(100);
    expect(new Set(xz.placements.map((p) => p.min[2].toFixed(3))).size).toBeGreaterThan(1);
  });

  it('three axes fill X, then Y, then stack layers in Z', () => {
    const r = check(['x', 'y', 'z'], [60, 70, 200]);
    expect(r.size[0]).toBeLessThanOrEqual(60);
    expect(r.size[1]).toBeLessThanOrEqual(70);
    expect(new Set(r.placements.map((p) => p.min[2].toFixed(3))).size).toBeGreaterThan(1);
    expect(r.overflow).toBe(false);
    expect(check(['x', 'y', 'z'], [60, 70, 20]).overflow).toBe(true);
  });
});
