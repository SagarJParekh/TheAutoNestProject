import { boxMesh, mergeMeshes, MeshData, subsetTriangles } from '../../src/geometry';

/** 10 mm cube, watertight, outward-facing. */
export function cube(size = 10, offset: [number, number, number] = [0, 0, 0]): MeshData {
  return boxMesh(offset, [offset[0] + size, offset[1] + size, offset[2] + size]);
}

/** Cube with the two top (+Z) triangles removed: one 4-edge hole. */
export function cubeWithHole(): MeshData {
  const c = cube();
  return subsetTriangles(c, (t) => t !== 2 && t !== 3);
}

/** Cube with two triangles (on different faces) wound the wrong way. */
export function cubeWithFlippedFaces(): MeshData {
  const c = cube();
  const idx = c.indices.slice();
  for (const t of [4, 9]) {
    const s = idx[t * 3 + 1];
    idx[t * 3 + 1] = idx[t * 3 + 2];
    idx[t * 3 + 2] = s;
  }
  return { positions: c.positions, indices: idx };
}

/** Two 10 mm cubes overlapping by 5 mm, stored as two separate shells. */
export function twoOverlappingShells(): MeshData {
  return mergeMeshes([cube(10, [0, 0, 0]), cube(10, [5, 5, 5])]);
}

/** Unindexed triangle soup of a cube (like a raw STL). */
export function cubeSoup(): Float32Array {
  const c = cube();
  const out = new Float32Array(c.indices.length * 3);
  for (let i = 0; i < c.indices.length; i++) out.set(c.positions.subarray(c.indices[i] * 3, c.indices[i] * 3 + 3), i * 3);
  return out;
}

/** A cube whose faces are subdivided into an n×n grid (watertight, welded). */
export function gridCube(size = 10, n = 4): MeshData {
  const pos: number[] = [];
  const idx: number[] = [];
  const map = new Map<string, number>();
  const vid = (x: number, y: number, z: number) => {
    const k = `${x},${y},${z}`;
    let i = map.get(k);
    if (i === undefined) {
      i = pos.length / 3;
      pos.push(x, y, z);
      map.set(k, i);
    }
    return i;
  };
  const s = size / n;
  // each face: origin, u, v (u x v = outward normal)
  const faces: [number[], number[], number[]][] = [
    [[0, 0, 0], [0, 1, 0], [1, 0, 0]], // -Z
    [[0, 0, size], [1, 0, 0], [0, 1, 0]], // +Z
    [[0, 0, 0], [1, 0, 0], [0, 0, 1]], // -Y
    [[0, size, 0], [0, 0, 1], [1, 0, 0]], // +Y
    [[0, 0, 0], [0, 0, 1], [0, 1, 0]], // -X
    [[size, 0, 0], [0, 1, 0], [0, 0, 1]], // +X
  ];
  for (const [o, u, v] of faces) {
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const p = (a: number, b: number) =>
          vid(o[0] + (u[0] * a + v[0] * b) * s, o[1] + (u[1] * a + v[1] * b) * s, o[2] + (u[2] * a + v[2] * b) * s);
        const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
        idx.push(a, b, c, a, c, d);
      }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}
