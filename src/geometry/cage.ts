/**
 * Cage (sinter box) around small parts, so they are not lost in the powder:
 * a closed box made of a lattice of flat bars on all six faces, around a
 * given inner box. The bars are `thickness` thick (through the wall),
 * `barWidth` wide, with `gap` between them; the faces' borders are full
 * bars, so the edges are solid. One watertight shell (the bars are united).
 */
import type { MeshData, Vec3 } from './mesh';
import { fromManifold, getManifold } from './manifold';

export interface CageOptions {
  /** wall (bar) thickness, mm */
  thickness: number;
  /** bar width, mm */
  barWidth: number;
  /** gap between bars, mm */
  gap: number;
}

/** Positions (low edges) of bars of width w filling [lo, hi] with gaps of at most `gap` between them; the first and last bars sit at the ends. */
function barPositions(lo: number, hi: number, w: number, gap: number): number[] {
  const span = hi - lo;
  if (span <= w) return [lo];
  // number of gaps so none is wider than `gap`
  const n = Math.max(1, Math.ceil((span - w) / (w + gap)));
  const step = (span - w) / n;
  return Array.from({ length: n + 1 }, (_, i) => lo + i * step);
}

/** The bars of the cage as boxes [min, max]. */
export function cageBars(innerMin: Vec3, innerMax: Vec3, o: CageOptions): [Vec3, Vec3][] {
  const t = Math.max(0.2, o.thickness),
    w = Math.max(0.2, o.barWidth),
    g = Math.max(0.2, o.gap);
  const oMin: Vec3 = [innerMin[0] - t, innerMin[1] - t, innerMin[2] - t];
  const oMax: Vec3 = [innerMax[0] + t, innerMax[1] + t, innerMax[2] + t];
  const boxes: [Vec3, Vec3][] = [];
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3,
      v = (a + 2) % 3;
    for (const side of [0, 1]) {
      const lo = side ? innerMax[a] : oMin[a],
        hi = side ? oMax[a] : innerMin[a];
      // bars along u (spread over v) and along v (spread over u)
      for (const [along, across] of [
        [u, v],
        [v, u],
      ])
        for (const p of barPositions(oMin[across], oMax[across], w, g)) {
          const mn: Vec3 = [0, 0, 0],
            mx: Vec3 = [0, 0, 0];
          mn[a] = lo;
          mx[a] = hi;
          mn[along] = oMin[along];
          mx[along] = oMax[along];
          mn[across] = p;
          mx[across] = p + w;
          boxes.push([mn, mx]);
        }
    }
  }
  return boxes;
}

/** The cage as one watertight mesh. */
export async function buildCage(innerMin: Vec3, innerMax: Vec3, o: CageOptions): Promise<MeshData> {
  const wasm = await getManifold();
  const parts = cageBars(innerMin, innerMax, o).map(([mn, mx]) =>
    wasm.Manifold.cube([mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]], false).translate([mn[0], mn[1], mn[2]]),
  );
  const all = wasm.Manifold.union(parts);
  try {
    return fromManifold(all);
  } finally {
    all.delete();
    parts.forEach((p) => p.delete());
  }
}
