import { describe, expect, it } from 'vitest';
import { boxMesh, computeBounds, isWatertight, surfaceToSolid, DEFAULT_SOLIDIFY, extractSurface, booleanMeshes, meshVolume } from '../src/geometry';

/** A wavy open sheet (height field) of n × n squares over 40 × 40 mm, facing up. */
function sheet(n = 40, amp = 3): { positions: Float32Array; indices: Uint32Array } {
  const pos: number[] = [], idx: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = (i / n) * 40, y = (j / n) * 40;
    pos.push(x, y, amp * Math.sin(x / 6) * Math.cos(y / 7));
  }
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) idx.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i, j + 1));
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

describe('surface to solid', () => {
  it('thickens an open sheet into a closed solid of the right volume', async () => {
    const s = sheet();
    const r = await surfaceToSolid(s, null, { ...DEFAULT_SOLIDIFY, thickness: 2, side: 'out' });
    expect(isWatertight(r.mesh)).toBe(true);
    expect(r.loops).toBe(1);
    expect(r.prisms).toBe(false);
    // about area × thickness (the wavy sheet is a little larger than 40 × 40)
    expect(r.volume).toBeGreaterThan(1600 * 2 * 0.98);
    expect(r.volume).toBeLessThan(1600 * 2 * 1.15);
    // grows on the normal side (up): nothing below the sheet's lowest point
    expect(computeBounds(r.mesh.positions).min[2]).toBeGreaterThan(-3.01);
    const both = await surfaceToSolid(s, null, { ...DEFAULT_SOLIDIFY, thickness: 2, side: 'both' });
    expect(computeBounds(both.mesh.positions).min[2]).toBeLessThan(-3.5);
  });

  it('folds on tight curves are made from prisms instead, still closed', async () => {
    const s = sheet(40, 6);
    const r = await surfaceToSolid(s, null, { ...DEFAULT_SOLIDIFY, thickness: 12, side: 'in' });
    expect(isWatertight(r.mesh)).toBe(true);
    expect(r.prisms).toBe(true);
    expect(r.volume).toBeGreaterThan(1600 * 8);
  }, 60000);

  it('fixture: a region of a part, filled down to a flat base, clear of the part', async () => {
    // a ball-ish part: a box with its bottom picked as the surface
    const part = boxMesh([0, 0, 10], [20, 30, 25]);
    const p = part.positions, idx = part.indices;
    const bottom: number[] = [];
    for (let t = 0; t < idx.length / 3; t++) if ([0, 1, 2].every((c) => p[idx[t * 3 + c] * 3 + 2] < 10.001)) bottom.push(t);
    expect(extractSurface(part, bottom).indices.length / 3).toBe(bottom.length);
    const r = await surfaceToSolid(part, bottom, { ...DEFAULT_SOLIDIFY, mode: 'base', gap: 0.5, baseDir: 'down', baseThickness: 4 });
    expect(isWatertight(r.mesh)).toBe(true);
    const b = computeBounds(r.mesh.positions);
    expect(b.max[2]).toBeCloseTo(9.5, 3);
    expect(b.min[2]).toBeCloseTo(5.5, 3);
    expect(r.volume).toBeCloseTo(20 * 30 * 4, 0);
    // does not reach into the part
    const inter = await booleanMeshes('intersect', part, [r.mesh]);
    expect(meshVolume(inter)).toBeLessThan(1e-3);
  });

  it('fixture from a whole smooth closed part: only the underside is used, nothing reaches over the part', async () => {
    // a UV sphere (smooth everywhere: a curvature-following pick takes all of it)
    const pos: number[] = [], idx: number[] = [];
    const N = 24, M = 48, R = 10;
    pos.push(0, 0, 20 + R);
    for (let i = 1; i < N; i++)
      for (let j = 0; j < M; j++) {
        const th = (Math.PI * i) / N, ph = (2 * Math.PI * j) / M;
        pos.push(R * Math.sin(th) * Math.cos(ph), R * Math.sin(th) * Math.sin(ph), 20 + R * Math.cos(th));
      }
    pos.push(0, 0, 20 - R);
    const ring = (i: number, j: number) => 1 + (i - 1) * M + (j % M);
    const last = 1 + (N - 1) * M;
    for (let j = 0; j < M; j++) idx.push(0, ring(1, j), ring(1, j + 1));
    for (let i = 1; i < N - 1; i++) for (let j = 0; j < M; j++) idx.push(ring(i, j), ring(i + 1, j), ring(i + 1, j + 1), ring(i, j), ring(i + 1, j + 1), ring(i, j + 1));
    for (let j = 0; j < M; j++) idx.push(last, ring(N - 1, j + 1), ring(N - 1, j));
    const ball = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
    expect(isWatertight(ball)).toBe(true);
    const r = await surfaceToSolid(ball, null, { ...DEFAULT_SOLIDIFY, mode: 'base', gap: 0.3, baseThickness: 3 });
    expect(isWatertight(r.mesh)).toBe(true);
    expect(r.leftOut).toBeGreaterThan(idx.length / 3 / 2 - M);
    const b = computeBounds(r.mesh.positions);
    // up to the ball's equator, down to 3 mm under its bottom (minus the gap)
    expect(b.max[2]).toBeLessThan(20.5);
    expect(b.min[2]).toBeCloseTo(20 - R - 0.3 - 3, 1);
    const inter = await booleanMeshes('intersect', ball, [r.mesh]);
    expect(Math.abs(meshVolume(inter))).toBeLessThan(0.5);
  });
});
