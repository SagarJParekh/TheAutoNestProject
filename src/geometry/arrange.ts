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
