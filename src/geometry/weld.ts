import { MeshData, computeBounds, boundsDiagonal } from './mesh';

/**
 * Merge vertices that lie within `tolerance` of each other.
 *
 * Works on raw triangle soups (indices omitted -> every 3 positions form a
 * triangle) as well as indexed meshes. Uses a spatial hash of quantised
 * coordinates; neighbouring cells are checked so points straddling a cell
 * boundary still merge. tolerance = 0 merges only bit-identical positions.
 */
export function weldVertices(
  positions: Float32Array,
  indices?: Uint32Array,
  tolerance = 0,
): { mesh: MeshData; merged: number } {
  const nIn = positions.length / 3;
  const refs = indices ?? identityIndex(nIn);
  const remap = new Int32Array(nIn).fill(-1);
  const out = new Float32Array(positions.length);
  let count = 0;

  // open-addressing hash table on cell coordinates
  let cap = 1;
  while (cap < nIn * 2) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1); // head vertex per bucket
  const next = new Int32Array(nIn).fill(-1); // chain within bucket (output vertex ids)
  const cellKeys = new Int32Array(nIn * 3);

  const exact = tolerance <= 0;
  const inv = exact ? 0 : 1 / tolerance;
  const tol2 = tolerance * tolerance;
  const f32 = new Float32Array(3);
  const u32 = new Uint32Array(f32.buffer);

  const hash = (cx: number, cy: number, cz: number) =>
    (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) & mask;

  const find = (x: number, y: number, z: number, cx: number, cy: number, cz: number): number => {
    let h = table[hash(cx, cy, cz)];
    while (h !== -1) {
      const o = h * 3;
      if (cellKeys[o] === cx && cellKeys[o + 1] === cy && cellKeys[o + 2] === cz) {
        if (exact) {
          if (out[o] === x && out[o + 1] === y && out[o + 2] === z) return h;
        } else {
          const dx = out[o] - x, dy = out[o + 1] - y, dz = out[o + 2] - z;
          if (dx * dx + dy * dy + dz * dz <= tol2) return h;
        }
      }
      h = next[h];
    }
    return -1;
  };

  for (let v = 0; v < nIn; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    let cx: number, cy: number, cz: number;
    if (exact) {
      f32[0] = x; f32[1] = y; f32[2] = z;
      // -0 and +0 should match
      if (x === 0) u32[0] = 0;
      if (y === 0) u32[1] = 0;
      if (z === 0) u32[2] = 0;
      cx = u32[0] | 0; cy = u32[1] | 0; cz = u32[2] | 0;
    } else {
      cx = Math.floor(x * inv); cy = Math.floor(y * inv); cz = Math.floor(z * inv);
    }
    let found = -1;
    if (exact) {
      found = find(x, y, z, cx, cy, cz);
    } else {
      for (let dx = -1; dx <= 1 && found < 0; dx++)
        for (let dy = -1; dy <= 1 && found < 0; dy++)
          for (let dz = -1; dz <= 1 && found < 0; dz++)
            found = find(x, y, z, cx + dx, cy + dy, cz + dz);
    }
    if (found >= 0) {
      remap[v] = found;
      continue;
    }
    const id = count++;
    out[id * 3] = x; out[id * 3 + 1] = y; out[id * 3 + 2] = z;
    cellKeys[id * 3] = cx; cellKeys[id * 3 + 1] = cy; cellKeys[id * 3 + 2] = cz;
    const b = hash(cx, cy, cz);
    next[id] = table[b];
    table[b] = id;
    remap[v] = id;
  }

  const idx = new Uint32Array(refs.length);
  for (let i = 0; i < refs.length; i++) idx[i] = remap[refs[i]];
  // vertices that were never referenced are kept (compactMesh removes them)
  return { mesh: { positions: out.slice(0, count * 3), indices: idx }, merged: nIn - count };
}

function identityIndex(n: number): Uint32Array {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

/** A sensible default weld tolerance: 1e-5 of the bounding diagonal, at most 1 µm. */
export function defaultWeldTolerance(positions: Float32Array): number {
  const d = boundsDiagonal(computeBounds(positions));
  return Math.min(1e-3, Math.max(1e-7, d * 1e-6));
}
