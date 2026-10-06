import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  analyzeMesh, applyLabel, boxMesh, brushSelect, computeBounds, cylinderMesh, faceNormalSegmentsSplit, flipTriangles, growCoplanarRegion,
  growSelection, invertSelection, isWatertight, lassoCutter, lassoSplit, meanEdgeLength, mergeMeshes, meshVolume, polylineToOutline, remeshMesh,
  shellOfTriangle, shrinkSelection, weldVertices, type MeshData,
} from '../src/geometry';
import { reportCSV, reportTSV, type ReportRow } from '../src/state/report';

const b = readFileSync(new URL('../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf', import.meta.url));
const FONT = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function sphere(r: number, seg: number): MeshData {
  const rings = seg / 2;
  const pos: number[] = [0, 0, r];
  const idx: number[] = [];
  for (let i = 1; i < rings; i++) {
    const th = (Math.PI * i) / rings;
    for (let j = 0; j < seg; j++) {
      const ph = (2 * Math.PI * j) / seg;
      pos.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
    }
  }
  pos.push(0, 0, -r);
  const v = (i: number, j: number) => 1 + (i - 1) * seg + (j % seg);
  const s = pos.length / 3 - 1;
  for (let j = 0; j < seg; j++) idx.push(0, v(1, j), v(1, j + 1));
  for (let i = 1; i < rings - 1; i++) for (let j = 0; j < seg; j++) idx.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i, j + 1));
  for (let j = 0; j < seg; j++) idx.push(v(rings - 1, j), s, v(rings - 1, j + 1));
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

const cylinder = (r: number, h: number, seg: number) => {
  const c = cylinderMesh([0, 0, 0], [0, 0, 1], r, h, seg);
  return weldVertices(c.positions, c.indices, 1e-6).mesh;
};

describe('remesh', () => {
  it('gives a sphere even triangles near the target size and keeps it closed', () => {
    const s = sphere(10, 64);
    const r = remeshMesh(s, { edgeLength: 1 });
    expect(isWatertight(r.mesh)).toBe(true);
    const a = analyzeMesh(r.mesh);
    expect(a.nonManifoldEdges).toBe(0);
    expect(a.flippedTriangles).toBe(0);
    expect(meanEdgeLength(r.mesh)).toBeGreaterThan(0.85);
    expect(meanEdgeLength(r.mesh)).toBeLessThan(1.25);
    expect(Math.abs(meshVolume(r.mesh) - meshVolume(s)) / meshVolume(s)).toBeLessThan(0.01);
  });

  it('keeps sharp edges: a box keeps its exact volume and size', () => {
    const r = remeshMesh(boxMesh([0, 0, 0], [20, 10, 5]), { edgeLength: 1.5 });
    expect(isWatertight(r.mesh)).toBe(true);
    expect(meshVolume(r.mesh)).toBeCloseTo(1000, 6);
    const bb = computeBounds(r.mesh.positions);
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(20, 6);
    expect(r.trianglesAfter).toBeGreaterThan(400);
    expect(r.trianglesAfter).toBeLessThan(1500);
  });

  it('converges on long thin triangles (cylinder side)', () => {
    const c = cylinder(5, 20, 64);
    const r = remeshMesh(c, { edgeLength: 1 });
    expect(isWatertight(r.mesh)).toBe(true);
    expect(r.trianglesAfter).toBeLessThan(3000);
    expect(Math.abs(meshVolume(r.mesh) - meshVolume(c)) / meshVolume(c)).toBeLessThan(0.01);
  });

  it('remeshes only a marked region and leaves the rest untouched', () => {
    const c = cylinder(5, 20, 64);
    let seed = 0;
    for (let t = 0; t < c.indices.length / 3; t++) {
      if ([0, 1, 2].every((k) => c.positions[c.indices[t * 3 + k] * 3 + 2] > 19.9)) {
        seed = t;
        break;
      }
    }
    const top = growCoplanarRegion(c, seed);
    const r = remeshMesh(c, { edgeLength: 0.8, region: top });
    expect(isWatertight(r.mesh)).toBe(true);
    expect(meshVolume(r.mesh)).toBeCloseTo(meshVolume(c), 4);
    // side triangles (z between the caps) keep their count
    const sideCount = (m: MeshData) => {
      let n = 0;
      for (let t = 0; t < m.indices.length / 3; t++) {
        const zs = [0, 1, 2].map((k) => m.positions[m.indices[t * 3 + k] * 3 + 2]);
        if (Math.min(...zs) < 0.01 && Math.max(...zs) > 19.99) n++;
      }
      return n;
    };
    expect(sideCount(r.mesh)).toBe(sideCount(c));
    expect(r.trianglesAfter).toBeGreaterThan(c.indices.length / 3);
  });
});

describe('marking helpers', () => {
  const two = mergeMeshes([boxMesh([0, 0, 0], [10, 10, 10]), boxMesh([20, 0, 0], [30, 10, 10])]);
  it('marks a shell, inverts, grows and shrinks', () => {
    const shell = shellOfTriangle(two, 0);
    expect(shell.length).toBe(12);
    expect(invertSelection(24, shell).length).toBe(12);
    const g = growSelection(two, [0]);
    expect(g.length).toBeGreaterThan(1);
    expect(g.length).toBeLessThanOrEqual(12);
    expect(shrinkSelection(two, shell).length).toBe(12); // a whole shell has no outer ring
    expect(shrinkSelection(two, g).length).toBeLessThan(g.length);
  });

  it('brush marks triangles within the radius only', () => {
    const s = sphere(10, 48);
    // the north pole triangle fan
    const tris = brushSelect(s, 0, [0, 0, 10], 2.5);
    expect(tris.length).toBeGreaterThan(10);
    for (const t of tris) {
      const zs = [0, 1, 2].map((k) => s.positions[s.indices[t * 3 + k] * 3 + 2]);
      expect(Math.max(...zs)).toBeGreaterThan(9);
    }
  });
});

describe('polyline cut', () => {
  it('splits a box along a stepped line into two closed pieces', async () => {
    const box = boxMesh([-10, -5, 0], [10, 5, 5]);
    // looking straight down: camera at z=100, orthographic, camera units = world x/y
    const camera = { matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 100, 1], orthographic: true, near: 50, far: 150 };
    const step: [number, number][] = [[-30, 0], [-4, 0], [-4, 3], [4, 3], [4, 0], [30, 0]];
    const outline = polylineToOutline(step, 500);
    const cutter = await lassoCutter(outline, camera);
    const { inside, outside } = await lassoSplit(box, cutter);
    expect(isWatertight(inside)).toBe(true);
    expect(isWatertight(outside)).toBe(true);
    const vi = meshVolume(inside), vo = meshVolume(outside);
    expect(vi + vo).toBeCloseTo(1000, 3);
    // one side gets the notch: 20×5×5 half plus/minus an 8×3×5 step
    expect([vi, vo].sort((a, c) => a - c).map((v) => Math.round(v))).toEqual([380, 620]);
  });
});

describe('label following the surface', () => {
  it('wraps text around a cylinder keeping the part closed', async () => {
    const cyl = cylinder(10, 30, 128);
    const flat = await applyLabel(cyl, FONT, { text: 'HELLO', size: 6, depth: 1, mode: 'engrave', rotation: 0, sink: 0 }, [10, 0, 15], [1, 0, 0]);
    const wrapped = await applyLabel(cyl, FONT, { text: 'HELLO', size: 6, depth: 1, mode: 'engrave', rotation: 0, sink: 0, conform: true }, [10, 0, 15], [1, 0, 0]);
    expect(isWatertight(wrapped.mesh)).toBe(true);
    // the flat plane only touches the middle of the curve; the wrapped text cuts its full depth everywhere
    const removedFlat = meshVolume(cyl) - meshVolume(flat.mesh);
    const removedWrapped = meshVolume(cyl) - meshVolume(wrapped.mesh);
    expect(removedWrapped).toBeGreaterThan(removedFlat * 2);
    // the text wraps around: about 20 mm of text on a 10 mm radius spans roughly ±1 rad
    const lb = computeBounds(wrapped.label.positions);
    expect(lb.min[0]).toBeLessThan(7.5);
    expect(lb.min[0]).toBeGreaterThan(3);
  });
});

describe('normals and report', () => {
  it('splits normal hairs into outward and inward sets', () => {
    const box = boxMesh();
    const flipped = flipTriangles(box, Uint32Array.from([0, 1]));
    const segs = faceNormalSegmentsSplit(flipped, 1, Uint32Array.from([0, 1]));
    expect(segs.inward.length).toBe(2 * 6);
    expect(segs.outward.length).toBe(10 * 6);
  });

  it('formats the report for Excel with a blank quantity column', () => {
    const rows: ReportRow[] = [
      { name: 'Bracket, left', volume: 12345.678, x: 10, y: 20.5, z: 3.25, inverted: false },
      { name: 'Tab\tname', volume: 1, x: 1, y: 1, z: 1, inverted: false },
    ];
    const tsv = reportTSV(rows).split('\r\n');
    expect(tsv[0]).toBe('Part Name\tQuantity\tVolume (mm³)\tX (mm)\tY (mm)\tZ (mm)');
    expect(tsv[1]).toBe('Bracket, left\t\t12345.68\t10.00\t20.50\t3.25');
    expect(tsv[2].split('\t').length).toBe(6);
    expect(reportCSV(rows)).toContain('"Bracket, left",,12345.68,10.00,20.50,3.25');
  });
});
