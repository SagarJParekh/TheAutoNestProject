/**
 * 2D layout helpers on part footprints (bounding rectangles in XY). Plain
 * functions, reusable by a future nesting module.
 */

export interface Footprint {
  id: string;
  /** size along X and Y, mm */
  w: number;
  d: number;
}

export interface Placement {
  id: string;
  /** minimum corner of the footprint, mm */
  x: number;
  y: number;
}

/**
 * Shelf packing: parts sorted by depth are placed left to right in rows of
 * at most `bedWidth`, with `gap` between them. The layout is centred on the
 * origin. Parts wider than the bed get their own row.
 */
export function arrangeShelves(parts: Footprint[], bedWidth: number, gap: number): { placements: Placement[]; width: number; depth: number } {
  const sorted = [...parts].sort((a, b) => b.d - a.d || b.w - a.w);
  const placements: Placement[] = [];
  let x = 0, y = 0, rowDepth = 0, maxW = 0;
  for (const p of sorted) {
    if (x > 0 && x + p.w > bedWidth) {
      y += rowDepth + gap;
      x = 0;
      rowDepth = 0;
    }
    placements.push({ id: p.id, x, y });
    x += p.w + gap;
    maxW = Math.max(maxW, x - gap);
    rowDepth = Math.max(rowDepth, p.d);
  }
  const depth = y + rowDepth;
  for (const pl of placements) {
    pl.x -= maxW / 2;
    pl.y -= depth / 2;
  }
  return { placements, width: maxW, depth };
}

/** Offsets (from the original position) for a rows × columns grid array. */
export function gridArrayOffsets(cols: number, rows: number, stepX: number, stepY: number): [number, number][] {
  const out: [number, number][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (r || c) out.push([c * stepX, r * stepY]);
  return out;
}

export type ArrangeAxis = 'x' | 'y' | 'z';

export interface Box3Item {
  id: string;
  /** size along X, Y and Z, mm */
  size: [number, number, number];
}

export interface Placement3 {
  id: string;
  /** minimum corner of the part's bounding box, mm */
  min: [number, number, number];
}

/**
 * Arrange bounding boxes along any combination of axes.
 *
 * - One axis: a single line of parts along it.
 * - Two axes: the parts spread over both axes together — a compact grid in
 *   the bed's proportions within the bed size, or, with an infinite bed (no
 *   size), the most square-ish layout.
 * - Three axes: rows along X within the bed width, rows step along Y within
 *   the bed depth, and full layers stack along Z.
 *
 * Parts are centred on the origin across unused X/Y axes; Z always starts
 * at 0 (the bed). The layout is centred on the origin in X and Y.
 * `overflow` is true when the layout exceeds the bed on a used axis.
 */
export function arrangeBoxes(
  items: Box3Item[],
  axes: ArrangeAxis[],
  bed: [number, number, number],
  gap: number,
): { placements: Placement3[]; size: [number, number, number]; overflow: boolean } {
  const order = (['x', 'y', 'z'] as ArrangeAxis[]).filter((a) => axes.includes(a)).map((a) => ({ x: 0, y: 1, z: 2 })[a]);
  if (!order.length) order.push(0);
  const [a0, a1, a2] = order as [number, number | undefined, number | undefined];
  // sort so that parts of similar height end up in the same row / layer
  const sorted = [...items].sort((p, q) => {
    for (const ax of [a2, a1, a0].filter((v) => v !== undefined) as number[]) {
      const d = q.size[ax] - p.size[ax];
      if (Math.abs(d) > 1e-9) return d;
    }
    return 0;
  });
  // Lay the parts out with rows that wrap at `wrap` along a0 (and layers that wrap at the bed along a1).
  const layout = (wrap: number) => {
    const placements: Placement3[] = [];
    const c = [0, 0, 0];
    let row = 0, layer = 0;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const it of sorted) {
      const s = it.size;
      if (a1 !== undefined && c[a0] > 0 && c[a0] + s[a0] > wrap + 1e-9) {
        c[a0] = 0;
        c[a1] += row + gap;
        row = 0;
        if (a2 !== undefined && c[a1] > 0 && c[a1] + s[a1] > bed[a1] + 1e-9) {
          c[a1] = 0;
          c[a2] += layer + gap;
          layer = 0;
        }
      }
      const min: [number, number, number] = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        if (order.includes(k)) min[k] = c[k];
        else min[k] = k === 2 ? 0 : -s[k] / 2;
        lo[k] = Math.min(lo[k], min[k]);
        hi[k] = Math.max(hi[k], min[k] + s[k]);
      }
      placements.push({ id: it.id, min });
      c[a0] += s[a0] + gap;
      if (a1 !== undefined) row = Math.max(row, s[a1]);
      if (a2 !== undefined) layer = Math.max(layer, s[a2]);
    }
    return { placements, lo, hi };
  };
  let best = layout(bed[a0]);
  if (a1 !== undefined && sorted.length > 1) {
    // Two directions: don't just fill one long row along a0 — try row widths from the widest part up to
    // the bed and keep the layout that uses the least of the bed in its tightest direction (so the parts
    // spread over X and Y in the bed's proportions), then the smaller footprint.
    const widest = Math.max(...sorted.map((it) => it.size[a0]));
    const total = sorted.reduce((sum, it) => sum + it.size[a0] + gap, 0);
    const maxW = Math.max(widest, Math.min(bed[a0], total));
    // no bed size (infinite): aim for the most compact, square-ish layout instead
    const bounded = Number.isFinite(bed[a0]) && Number.isFinite(bed[a1]);
    const score = (l: ReturnType<typeof layout>) => {
      const w = l.hi[a0] - l.lo[a0], d = l.hi[a1] - l.lo[a1];
      return [bounded ? Math.max(w / bed[a0], d / bed[a1]) : Math.max(w, d), w * d] as const;
    };
    let bs = score(best);
    // candidate row widths: evenly spread ones, plus the exact widths of the first k parts in a row
    const wraps: number[] = [];
    const steps = 48;
    for (let i = 0; i <= steps; i++) wraps.push(widest + ((maxW - widest) * i) / steps);
    if (sorted.length <= 400) {
      let run = 0;
      for (let k = 0; k < sorted.length; k++) {
        run += (k ? gap : 0) + sorted[k].size[a0];
        if (run >= widest && run <= maxW + 1e-9) wraps.push(run);
      }
    }
    for (const wrap of wraps) {
      const l = layout(wrap + 1e-6);
      const sc = score(l);
      if (sc[0] < bs[0] - 1e-9 || (Math.abs(sc[0] - bs[0]) <= 1e-9 && sc[1] < bs[1])) {
        best = l;
        bs = sc;
      }
    }
  }
  const { placements, lo, hi } = best;
  if (!placements.length) return { placements, size: [0, 0, 0], overflow: false };
  const size: [number, number, number] = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  for (const k of [0, 1]) {
    if (!order.includes(k)) continue;
    const shift = -(lo[k] + hi[k]) / 2;
    for (const p of placements) p.min[k] += shift;
  }
  const overflow = order.some((k) => size[k] > bed[k] + 1e-6);
  return { placements, size, overflow };
}
