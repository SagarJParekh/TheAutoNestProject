import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { boxMesh, cylinderMesh, powderOrient, type MeshData } from '../src/geometry';

/** Angle in degrees between a face normal (after the rotation) and the build direction Z. */
const tiltOf = (q: [number, number, number, number], n: [number, number, number]) => {
  const v = new Vector3(...n).applyQuaternion(new Quaternion(...q));
  return (Math.acos(Math.min(1, Math.abs(v.z))) * 180) / Math.PI;
};

describe('powder-bed orientation (SLS / MJF rules)', () => {
  it('a flat plate does not lie flat (its large faces end up at least 30° from horizontal)', () => {
    const r = powderOrient(boxMesh([0, 0, 0], [120, 80, 4]));
    expect(tiltOf(r.quaternion, [0, 0, 1])).toBeGreaterThanOrEqual(29.9);
    expect(r.flatBefore).toBeGreaterThan(0.9);
    expect(r.flatAfter).toBeLessThan(0.05);
  });

  it('a cube has none of its faces parallel to the platform', () => {
    const r = powderOrient(boxMesh([0, 0, 0], [30, 30, 30]));
    for (const n of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [number, number, number][]) expect(tiltOf(r.quaternion, n)).toBeGreaterThan(29.9);
    expect(r.flatAfter).toBeLessThan(0.05);
  });

  it('a long round bar: its flat end caps are not parallel to the platform', () => {
    const r = powderOrient(cylinderMesh([0, 0, 0], [1, 0, 0], 6, 120, 64));
    expect(tiltOf(r.quaternion, [1, 0, 0])).toBeGreaterThan(29.9);
  });

  it('copes with very large meshes quickly (works on a sample)', () => {
    // 1 000 × 1 000 × 2 grid of triangles: about 4 million
    const n = 1000;
    const pos = new Float32Array((n + 1) * (n + 1) * 3);
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.set([i * 0.1, j * 0.1, Math.sin(i * 0.05) * 2], (j * (n + 1) + i) * 3);
    const idx = new Uint32Array(n * n * 6);
    let k = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; idx.set([a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1], k); k += 6; }
    const mesh: MeshData = { positions: pos, indices: idx };
    const t = performance.now();
    powderOrient(mesh);
    expect(performance.now() - t).toBeLessThan(10000);
  });
});
