import { describe, expect, it } from 'vitest';
import { packBuilds, type PackItem, type PackParams } from '../src/geometry';

const base: PackParams = { volume: [100, 100, 100], margin: 5, gap: 2, zOffset: 3, allowRotate: true, stack: false };

/** Footprint rectangles of a build including their size (rotation applied). */
function rects(items: PackItem[], placed: { key: string; x: number; y: number; z: number; rotated: boolean }[]) {
  const by = new Map(items.map((i) => [i.key, i]));
  return placed.map((p) => {
    const it = by.get(p.key)!;
    return { x0: p.x, y0: p.y, z0: p.z, x1: p.x + (p.rotated ? it.d : it.w), y1: p.y + (p.rotated ? it.w : it.d), z1: p.z + it.h };
  });
}

function checkBuild(items: PackItem[], placed: Parameters<typeof rects>[1], p: PackParams) {
  const r = rects(items, placed);
  const [VX, VY, VZ] = p.volume;
  for (const a of r) {
    expect(a.x0).toBeGreaterThanOrEqual(-VX / 2 + p.margin - 1e-9);
    expect(a.y0).toBeGreaterThanOrEqual(-VY / 2 + p.margin - 1e-9);
    expect(a.x1).toBeLessThanOrEqual(VX / 2 - p.margin + 1e-9);
    expect(a.y1).toBeLessThanOrEqual(VY / 2 - p.margin + 1e-9);
    expect(a.z0).toBeGreaterThanOrEqual(p.zOffset - 1e-9);
    expect(a.z1).toBeLessThanOrEqual(VZ + 1e-9);
  }
  // no two parts closer than the clearance (boxes grown by gap/2 must not overlap)
  for (let i = 0; i < r.length; i++)
    for (let j = i + 1; j < r.length; j++) {
      const a = r[i], b = r[j];
      const sepX = a.x1 + p.gap <= b.x0 + 1e-9 || b.x1 + p.gap <= a.x0 + 1e-9;
      const sepY = a.y1 + p.gap <= b.y0 + 1e-9 || b.y1 + p.gap <= a.y0 + 1e-9;
      const sepZ = a.z1 <= b.z0 + 1e-9 || b.z1 <= a.z0 + 1e-9;
      expect(sepX || sepY || sepZ).toBe(true);
    }
}

describe('build packing', () => {
  it('packs parts on one platform with margins and clearance', () => {
    const items: PackItem[] = Array.from({ length: 9 }, (_, i) => ({ key: `p${i}`, w: 25, d: 25, h: 10 }));
    const r = packBuilds(items, base);
    expect(r.builds.length).toBe(1);
    expect(r.builds[0].items.length).toBe(9);
    checkBuild(items, r.builds[0].items, base);
  });

  it('starts a new build when the platform is full', () => {
    const items: PackItem[] = Array.from({ length: 20 }, (_, i) => ({ key: `p${i}`, w: 25, d: 25, h: 10 }));
    const r = packBuilds(items, base);
    // 9 parts of 25 + 2 mm fit in 90 + 2 mm; 20 parts need 3 builds
    expect(r.builds.map((b) => b.items.length)).toEqual([9, 9, 2]);
    for (const b of r.builds) checkBuild(items, b.items, base);
  });

  it('keeps parts of different heights together while one build has room', () => {
    const items: PackItem[] = [
      { key: 'tall1', w: 10, d: 10, h: 80 },
      { key: 'short1', w: 10, d: 10, h: 10 },
      { key: 'tall2', w: 10, d: 10, h: 75 },
      { key: 'short2', w: 10, d: 10, h: 12 },
    ];
    const r = packBuilds(items, base);
    expect(r.builds.length).toBe(1);
    expect(r.builds[0].items.length).toBe(4);
  });

  it('fills each build completely before the next, tallest parts first', () => {
    // 9 slots per build; 6 tall + 6 short parts -> build 1 gets the 6 tall and 3 short (full), build 2 the rest
    const items: PackItem[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ key: `t${i}`, w: 25, d: 25, h: 80 })),
      ...Array.from({ length: 6 }, (_, i) => ({ key: `s${i}`, w: 25, d: 25, h: 10 })),
    ];
    const r = packBuilds(items, base);
    expect(r.builds.map((b) => b.items.length)).toEqual([9, 3]);
    expect(r.builds[0].items.filter((i) => i.key.startsWith('t')).length).toBe(6);
    expect(r.builds[1].items.every((i) => i.key.startsWith('s'))).toBe(true);
    // a small part that still fits goes into the first build instead of opening a new one
    const r2 = packBuilds([...items.slice(0, 8), { key: 'tiny', w: 5, d: 5, h: 2 }], base);
    expect(r2.builds.length).toBe(1);
  });

  it('turns a long part by 90° to fit and reports parts that never fit', () => {
    const items: PackItem[] = [
      { key: 'long', w: 20, d: 88, h: 5 },
      { key: 'huge', w: 120, d: 10, h: 5 },
      { key: 'tall', w: 10, d: 10, h: 99 },
    ];
    const r = packBuilds(items, base);
    expect(r.builds.length).toBe(1);
    expect(r.builds[0].items.map((i) => i.key)).toEqual(['long']);
    expect(r.unplaced.map((u) => u.key).sort()).toEqual(['huge', 'tall']);
    const rot = packBuilds([{ key: 'wide', w: 88, d: 20, h: 5 }], { ...base, volume: [40, 100, 100] });
    expect(rot.builds[0].items[0].rotated).toBe(true);
  });

  it('never stacks for resin / metal, stacks layers for powder bed when allowed', () => {
    const items: PackItem[] = Array.from({ length: 12 }, (_, i) => ({ key: `p${i}`, w: 40, d: 40, h: 20 }));
    const flat = packBuilds(items, base);
    expect(flat.builds.every((b) => b.items.every((i) => i.z === base.zOffset))).toBe(true);
    expect(flat.builds.length).toBe(3);
    const stacked = packBuilds(items, { ...base, stack: true });
    expect(stacked.builds.length).toBe(1);
    expect(new Set(stacked.builds[0].items.map((i) => i.z)).size).toBeGreaterThan(1);
    checkBuild(items, stacked.builds[0].items, { ...base, stack: true });
  });
});

import { Vector3 } from 'three';
import { Quaternion } from 'three';
import { findFittingTilt, tiltQuaternion } from '../src/state/buildActions';
import { boxMesh, fitsPlatform } from '../src/geometry';
import { PRINTERS } from '../src/state/printers';

describe('build generation setup', () => {
  it('tilts the top of a part towards the chosen direction', () => {
    const up = (az: number) => new Vector3(0, 0, 1).applyQuaternion(tiltQuaternion({ angle: 30, azimuth: az }));
    expect(up(0).x).toBeCloseTo(0.5, 6);
    expect(up(0).z).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    expect(up(90).y).toBeCloseTo(0.5, 6);
    expect(up(180).x).toBeCloseTo(-0.5, 6);
    expect(new Vector3(0, 0, 1).applyQuaternion(tiltQuaternion({ angle: 0, azimuth: 45 })).z).toBe(1);
  });

  it('has every printer from the sheet with its build volume', () => {
    const v = (name: string, tech: string) => PRINTERS.find((p) => p.name === name && p.tech === tech)?.volume;
    expect(v('Eplus', 'sla')).toEqual([800, 800, 320]);
    expect(v('Form 4L', 'sla')).toEqual([353, 196, 353]);
    expect(v('YouSu', 'sla')).toEqual([211, 118, 240]);
    expect(v('M2', 'dmls')).toEqual([245, 245, 300]);
    expect(v('MLab 200R', 'dmls')).toEqual([100, 100, 100]);
    for (const tech of ['sla', 'dmls', 'powder']) expect(PRINTERS.some((p) => p.tech === tech && p.custom)).toBe(true);
  });
});

describe('auto tilt', () => {
  const fit = { volume: [100, 100, 60] as [number, number, number], margin: 5, gap: 2, zOffset: 3, allowRotate: true };
  it('tilts a part that is too tall until it fits, using the smallest angle', () => {
    const tall = boxMesh([-5, -5, -35], [5, 5, 35]); // 70 mm tall, printer allows 57 mm
    expect(fitsPlatform(10, 10, 70, fit)).toBe(false);
    const r = findFittingTilt(tall, new Quaternion(), fit)!;
    expect(r).not.toBeNull();
    expect(r.tilt.angle).toBe(45);
    const h = r.bounds.max.z - r.bounds.min.z;
    expect(h).toBeLessThanOrEqual(57);
    // 30° is not enough: cos30 * 70 + sin30 * 10 > 57
    expect(Math.cos(Math.PI / 6) * 70 + 0.5 * 10).toBeGreaterThan(57);
  });
  it('turns a long flat part corner to corner before tilting it', () => {
    const long = boxMesh([-60, -3, -2], [60, 3, 2]); // 120 mm long on a 90 mm platform (diagonal ~127)
    const r = findFittingTilt(long, new Quaternion(), fit)!;
    expect(r).not.toBeNull();
    expect(r.tilt.angle).toBe(0);
    expect(r.tilt.turn).toBe(45);
    const b = r.bounds;
    expect(fitsPlatform(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, fit)).toBe(true);
    expect(b.max.z - b.min.z).toBeCloseTo(4, 6);
  });
  it('tilts a part that is too long even corner to corner', () => {
    const tallPrinter = { ...fit, volume: [100, 100, 150] as [number, number, number] };
    const long = boxMesh([-75, -3, -2], [75, 3, 2]); // 150 mm: longer than the 127 mm diagonal
    const r = findFittingTilt(long, new Quaternion(), tallPrinter)!;
    expect(r).not.toBeNull();
    expect(r.tilt.angle).toBeGreaterThan(0);
    const b = r.bounds;
    expect(fitsPlatform(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, tallPrinter)).toBe(true);
  });
  it('gives up when no tilt helps', () => {
    expect(findFittingTilt(boxMesh([-200, -200, -200], [200, 200, 200]), new Quaternion(), fit)).toBeNull();
  });
});
