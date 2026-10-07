/**
 * Build packing for 3D printers: parts (as oriented bounding boxes) are laid
 * out on build platforms with MaxRects 2D bin packing.
 *
 * Builds are filled completely first: parts are taken tallest first and each
 * build keeps taking every remaining part that still fits before the next
 * build is started. Because of the height order, similar heights end up in
 * the same build, but a build is never split only because heights differ.
 * Powder-bed builds can optionally stack layers in Z.
 */

export interface PackItem {
  key: string;
  /** size along X, Y and Z after orientation, mm */
  w: number;
  d: number;
  h: number;
}

export interface PackParams {
  /** printer build volume X, Y, Z (mm) */
  volume: [number, number, number];
  /** empty border kept along the platform edges */
  margin: number;
  /** clearance between neighbouring parts */
  gap: number;
  /** distance between the platform and the bottom of the parts */
  zOffset: number;
  /** allow turning a footprint by 90° about Z to fit */
  allowRotate: boolean;
  /** powder bed: stack layers of parts in Z */
  stack: boolean;
}

export interface PackedItem {
  key: string;
  /** minimum corner of the part's box in platform coordinates (platform centred on the origin, top surface at z = 0) */
  x: number;
  y: number;
  z: number;
  /** footprint turned by 90° about Z */
  rotated: boolean;
}

export interface PackedBuild {
  items: PackedItem[];
  /** tallest point above the platform, mm */
  height: number;
  /** share of the usable platform area covered by part footprints (first layer), 0..1 */
  utilization: number;
}

export interface PackResult {
  builds: PackedBuild[];
  unplaced: { key: string; reason: string }[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** MaxRects bin (best short side fit), sizes include the clearance. */
export class MaxRectsBin {
  free: Rect[];
  used: Rect[] = [];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.free = [{ x: 0, y: 0, w: width, h: height }];
  }

  /** Best position for a w × h rectangle, or null. */
  find(w: number, h: number, allowRotate: boolean): { x: number; y: number; rotated: boolean; score: number } | null {
    let best: { x: number; y: number; rotated: boolean; score: number; score2: number } | null = null;
    const eps = 1e-9;
    for (const f of this.free) {
      for (const [rw, rh, rot] of allowRotate && Math.abs(w - h) > eps ? ([[w, h, false], [h, w, true]] as const) : ([[w, h, false]] as const)) {
        if (rw <= f.w + eps && rh <= f.h + eps) {
          const short = Math.min(f.w - rw, f.h - rh), long = Math.max(f.w - rw, f.h - rh);
          if (!best || short < best.score - eps || (Math.abs(short - best.score) <= eps && long < best.score2)) best = { x: f.x, y: f.y, rotated: rot, score: short, score2: long };
        }
      }
    }
    return best ? { x: best.x, y: best.y, rotated: best.rotated, score: best.score } : null;
  }

  place(r: Rect) {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) {
        next.push(f);
        continue;
      }
      // split the free rectangle around r
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - (r.x + r.w), h: f.h });
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - (r.y + r.h) });
    }
    // drop free rectangles contained in another
    this.free = next.filter(
      (a, i) => a.w > 1e-9 && a.h > 1e-9 && !next.some((b, j) => j !== i && b.x <= a.x && b.y <= a.y && b.x + b.w >= a.x + a.w && b.y + b.h >= a.y + a.h && (j < i || b.w * b.h > a.w * a.h)),
    );
    this.used.push(r);
  }
}

interface Layer {
  z: number;
  bin: MaxRectsBin;
  maxH: number;
}

interface OpenBuild {
  layers: Layer[];
  items: PackedItem[];
  /** tallest part (sets the height group) */
  groupH: number;
}

export function packBuilds(items: PackItem[], p: PackParams): PackResult {
  const [VX, VY, VZ] = p.volume;
  const gap = Math.max(0, p.gap);
  // usable area grows by one gap so the last part in a row needs no clearance after it
  const binW = VX - 2 * p.margin + gap, binD = VY - 2 * p.margin + gap;
  const usableH = VZ - p.zOffset;
  const result: PackResult = { builds: [], unplaced: [] };
  if (binW <= gap || binD <= gap || usableH <= 0) {
    for (const it of items) result.unplaced.push({ key: it.key, reason: 'The margins and platform gap leave no room on this printer' });
    return result;
  }
  // tallest first, then larger footprints first
  const order = [...items].sort((a, b) => b.h - a.h || b.w * b.d - a.w * a.d || a.key.localeCompare(b.key));
  const open: OpenBuild[] = [];
  const fitsEmpty = (it: PackItem) => {
    const ok = (w: number, d: number) => w + gap <= binW + 1e-9 && d + gap <= binD + 1e-9;
    return it.h <= usableH + 1e-9 && (ok(it.w, it.d) || (p.allowRotate && ok(it.d, it.w)));
  };
  const tryPlace = (b: OpenBuild, it: PackItem): boolean => {
    for (const layer of b.layers) {
      if (layer.z + it.h > usableH + 1e-9) continue;
      const pos = layer.bin.find(it.w + gap, it.d + gap, p.allowRotate);
      if (!pos) continue;
      const w = pos.rotated ? it.d : it.w, d = pos.rotated ? it.w : it.d;
      layer.bin.place({ x: pos.x, y: pos.y, w: w + gap, h: d + gap });
      layer.maxH = Math.max(layer.maxH, it.h);
      b.items.push({ key: it.key, x: -VX / 2 + p.margin + pos.x, y: -VY / 2 + p.margin + pos.y, z: p.zOffset + layer.z, rotated: pos.rotated });
      return true;
    }
    if (!p.stack) return false;
    // powder bed: start a new layer on top of the last one
    const last = b.layers[b.layers.length - 1];
    const z = last.z + last.maxH + gap;
    if (z + it.h > usableH + 1e-9) return false;
    b.layers.push({ z, bin: new MaxRectsBin(binW, binD), maxH: 0 });
    return tryPlace(b, it);
  };
  const remaining: PackItem[] = [];
  for (const it of order) {
    if (fitsEmpty(it)) {
      remaining.push(it);
      continue;
    }
    result.unplaced.push({
      key: it.key,
      reason:
        it.h > usableH + 1e-9
          ? `Too tall: ${it.h.toFixed(1)} mm, the printer allows ${usableH.toFixed(1)} mm`
          : `Footprint ${it.w.toFixed(1)} × ${it.d.toFixed(1)} mm is larger than the platform minus margins`,
    });
  }
  // fill one build completely (tallest first, then whatever still fits), then start the next
  while (remaining.length) {
    const b: OpenBuild = { layers: [{ z: 0, bin: new MaxRectsBin(binW, binD), maxH: 0 }], items: [], groupH: remaining[0].h };
    for (let i = 0; i < remaining.length; ) {
      if (tryPlace(b, remaining[i])) remaining.splice(i, 1);
      else i++;
    }
    if (!b.items.length) break; // cannot happen: the first remaining part always fits an empty build
    open.push(b);
  }
  const area = (VX - 2 * p.margin) * (VY - 2 * p.margin);
  const sizeOf = new Map(items.map((it) => [it.key, it]));
  for (const b of open) {
    let footprint = 0, height = 0;
    for (const pi of b.items) {
      const it = sizeOf.get(pi.key)!;
      if (pi.z <= p.zOffset + 1e-9) footprint += it.w * it.d;
      height = Math.max(height, pi.z + it.h);
    }
    result.builds.push({ items: b.items, height, utilization: area > 0 ? footprint / area : 0 });
  }
  return result;
}

/** Does a part box fit an empty platform of this printer (optionally turned 90°)? */
export function fitsPlatform(w: number, d: number, h: number, p: Omit<PackParams, 'stack'>): boolean {
  const [VX, VY, VZ] = p.volume;
  const gap = Math.max(0, p.gap);
  const binW = VX - 2 * p.margin + gap, binD = VY - 2 * p.margin + gap;
  if (h > VZ - p.zOffset + 1e-9) return false;
  const ok = (a: number, b: number) => a + gap <= binW + 1e-9 && b + gap <= binD + 1e-9;
  return ok(w, d) || (p.allowRotate && ok(d, w));
}
