import { describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { importFile } from '../src/loaders/pipeline';
import { getLoader, importableExtensions } from '../src/loaders';
import { export3MF, exportOBJ, exportSTL, exportZip } from '../src/exporters';
import { isWatertight, meshVolume } from '../src/geometry';
import { cube, twoOverlappingShells } from './fixtures/meshes';

const ctx = (fileName: string, extra: Record<string, unknown> = {}) => {
  const warnings: string[] = [];
  return { fileName, onProgress: () => {}, warn: (m: string) => warnings.push(m), warnings, ...extra };
};
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe('loader registry', () => {
  it('covers all required formats', () => {
    for (const e of ['stl', 'obj', 'ply', '3mf', 'amf', '3dm', 'step', 'stp', 'iges', 'igs', 'brep', 'glb', 'gltf', 'off'])
      expect(importableExtensions()).toContain(e);
  });

  it('refuses f3d with a helpful message', async () => {
    expect(getLoader('part.F3D')?.unsupportedMessage).toMatch(/STEP/);
    await expect(importFile(new ArrayBuffer(10), ctx('part.f3d'))).rejects.toThrow(/export/i);
  });

  it('rejects unknown extensions', async () => {
    await expect(importFile(new ArrayBuffer(10), ctx('thing.xyz'))).rejects.toThrow(/Unsupported/);
  });
});

describe('STL', () => {
  it('round-trips binary STL', async () => {
    const bytes = exportSTL([{ name: 'cube', mesh: cube() }]);
    const [body] = await importFile(ab(bytes), ctx('cube.stl'));
    expect(body.mesh.positions.length / 3).toBe(8);
    expect(isWatertight(body.mesh)).toBe(true);
    expect(meshVolume(body.mesh)).toBeCloseTo(1000, 3);
    expect(body.center).toEqual([5, 5, 5]);
  });

  it('parses ASCII STL with multiple solids', async () => {
    const tri = (z: number) => `facet normal 0 0 1\n outer loop\n vertex 0 0 ${z}\n vertex 1 0 ${z}\n vertex 0 1 ${z}\n endloop\nendfacet\n`;
    const text = `solid a\n${tri(0)}endsolid a\nsolid b\n${tri(5)}${tri(6)}endsolid b\n`;
    const bodies = await importFile(ab(strToU8(text)), ctx('x.stl'));
    expect(bodies.map((b) => b.name)).toEqual(['a', 'b']);
    expect(bodies[1].mesh.indices.length).toBe(6);
  });

  it('reports truncated binary STL', async () => {
    const bytes = exportSTL([{ name: 'cube', mesh: cube() }]).slice(0, 200);
    // header says 12 triangles but data is cut: falls through to ASCII detection and fails clearly
    await expect(importFile(ab(bytes), ctx('bad.stl'))).rejects.toThrow();
  });
});

describe('OBJ', () => {
  it('round-trips and splits objects', async () => {
    const bytes = exportOBJ([
      { name: 'one', mesh: cube() },
      { name: 'two', mesh: cube(5, [20, 0, 0]) },
    ]);
    const bodies = await importFile(ab(bytes), ctx('m.obj'));
    expect(bodies.map((b) => b.name)).toEqual(['one', 'two']);
    expect(meshVolume(bodies[1].mesh)).toBeCloseTo(125, 3);
  });
  it('handles quads, negative indices and v/vt/vn', async () => {
    const text = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nf -4/1/1 -3/1/1 -2/1/1 -1/1/1\n';
    const [b] = await importFile(ab(strToU8(text)), ctx('q.obj'));
    expect(b.mesh.indices.length).toBe(6);
  });
});

describe('OFF / PLY / AMF', () => {
  it('parses OFF', async () => {
    const text = 'OFF\n4 2 0\n0 0 0\n1 0 0\n1 1 0\n0 1 0\n3 0 1 2\n3 0 2 3 255 0 0\n';
    const [b] = await importFile(ab(strToU8(text)), ctx('s.off'));
    expect(b.mesh.indices.length).toBe(6);
  });
  it('parses ASCII PLY', async () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n1 1 0\n0 1 0\n4 0 1 2 3\n';
    const [b] = await importFile(ab(strToU8(text)), ctx('s.ply'));
    expect(b.mesh.indices.length).toBe(6);
  });
  it('parses AMF with units', async () => {
    const v = (x: number, y: number, z: number) => `<vertex><coordinates><x>${x}</x><y>${y}</y><z>${z}</z></coordinates></vertex>`;
    const xml = `<?xml version="1.0"?><amf unit="inch"><object id="0"><metadata type="name">Tri</metadata><mesh><vertices>${v(0, 0, 0)}${v(1, 0, 0)}${v(0, 1, 0)}</vertices><volume><triangle><v1>0</v1><v2>1</v2><v3>2</v3></triangle></volume></mesh></object></amf>`;
    const [b] = await importFile(ab(strToU8(xml)), ctx('t.amf'));
    expect(b.name).toBe('Tri');
    // 1 inch triangle -> 25.4 mm extents
    const xs = Array.from(b.mesh.positions.filter((_, i) => i % 3 === 0));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(25.4, 3);
  });
  it('reports corrupt AMF', async () => {
    await expect(importFile(ab(strToU8('<notamf/>')), ctx('t.amf'))).rejects.toThrow(/AMF/);
  });
});

describe('3MF', () => {
  it('round-trips multiple parts as separate bodies', async () => {
    const shells = [
      { name: 'Left', mesh: cube() },
      { name: 'Right', mesh: cube(10, [30, 0, 0]) },
    ];
    const bodies = await importFile(ab(export3MF(shells)), ctx('a.3mf'));
    expect(bodies.map((b) => b.name)).toEqual(['Left', 'Right']);
    expect(bodies[1].center[0]).toBeCloseTo(35);
    expect(isWatertight(bodies[0].mesh)).toBe(true);
  });
  it('applies build transforms, components and units', async () => {
    const { zipSync } = await import('fflate');
    const model = `<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
      <object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
      <object id="2" name="Assembly"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/><component objectid="1"/></components></object>
      </resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 5"/></build></model>`;
    const zip = zipSync({ '3D/3dmodel.model': strToU8(model) });
    const [b] = await importFile(ab(zip), ctx('asm.3mf'));
    expect(b.name).toBe('Assembly');
    expect(b.mesh.indices.length).toBe(6);
    // z = 5 cm = 50 mm; x spans 0..11 cm = 0..110 mm
    expect(b.center[2]).toBeCloseTo(50);
    expect(b.center[0]).toBeCloseTo(55);
  });
  it('reports a corrupt archive', async () => {
    await expect(importFile(ab(strToU8('garbage')), ctx('bad.3mf'))).rejects.toThrow(/ZIP/);
  });
});

describe('glTF', () => {
  it('reads embedded glTF and converts Y-up metres to Z-up mm', async () => {
    const pos = new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]);
    const idx = new Uint16Array([0, 1, 2, 0]);
    const bin = new Uint8Array(pos.byteLength + idx.byteLength);
    bin.set(new Uint8Array(pos.buffer), 0);
    bin.set(new Uint8Array(idx.buffer), pos.byteLength);
    const gltf = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + Buffer.from(bin).toString('base64') }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
        { buffer: 0, byteOffset: pos.byteLength, byteLength: 6 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      meshes: [{ name: 'tri', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: [{ mesh: 0, name: 'Node', translation: [0, 1, 0] }],
      scenes: [{ nodes: [0] }],
    };
    const [b] = await importFile(ab(strToU8(JSON.stringify(gltf))), ctx('t.gltf'));
    expect(b.name).toBe('Node');
    // translation y=1 m becomes z=1000 mm
    expect(b.center[2]).toBeCloseTo(1000 + 5, 3);
    expect(b.center[0]).toBeCloseTo(5, 3);
  });
  it('asks for missing external buffers', async () => {
    const gltf = { asset: { version: '2.0' }, buffers: [{ uri: 'data.bin', byteLength: 4 }] };
    await expect(importFile(ab(strToU8(JSON.stringify(gltf))), ctx('t.gltf'))).rejects.toThrow(/data\.bin/);
  });
});

describe('WASM CAD loaders', () => {
  it('reads a Rhino 3DM file with a mesh object', async () => {
    const rhino = await (await import('rhino3dm')).default();
    const doc = new rhino.File3dm();
    const mesh = new rhino.Mesh();
    const c = cube();
    for (let i = 0; i < c.positions.length; i += 3) mesh.vertices().add(c.positions[i], c.positions[i + 1], c.positions[i + 2]);
    for (let i = 0; i < c.indices.length; i += 3) mesh.faces().addTriFace(c.indices[i], c.indices[i + 1], c.indices[i + 2]);
    const attrs = new rhino.ObjectAttributes();
    attrs.name = 'RhinoCube';
    doc.objects().add(mesh, attrs);
    const bytes: Uint8Array = doc.toByteArray();
    const [b] = await importFile(ab(bytes), ctx('c.3dm'));
    expect(b.name).toBe('RhinoCube');
    expect(Math.abs(meshVolume(b.mesh))).toBeCloseTo(1000, 2);
  });

  it('reports unreadable STEP files clearly', async () => {
    await expect(importFile(ab(strToU8('ISO-10303-21;\nnot really step')), ctx('x.step'))).rejects.toThrow(/STEP/);
  });

  it('reads a STEP file through OpenCascade', async () => {
    const step = (await import('node:fs')).readFileSync(new URL('./fixtures/cube.step', import.meta.url));
    const bodies = await importFile(ab(new Uint8Array(step)), ctx('cube.step'));
    expect(bodies.length).toBeGreaterThan(0);
    const vol = bodies.reduce((s, b) => s + meshVolume(b.mesh), 0);
    expect(vol).toBeCloseTo(1000, 0);
  });
});

describe('exporters', () => {
  it('zips separate files', async () => {
    const { unzipSync } = await import('fflate');
    const z = unzipSync(exportZip('stl', [
      { name: 'a', mesh: cube() },
      { name: 'a', mesh: twoOverlappingShells() },
    ]));
    expect(Object.keys(z).sort()).toEqual(['a.stl', 'a_2.stl']);
  });
});

describe('CAD import quality', () => {
  it('finer quality gives more triangles on curved STEP faces, with the same volume', async () => {
    const step = (await import('node:fs')).readFileSync(new URL('./fixtures/cylinder.step', import.meta.url));
    const counts: Record<string, number> = {};
    for (const q of ['draft', 'normal', 'fine', 'ultra'] as const) {
      const bodies = await importFile(ab(new Uint8Array(step)), { ...ctx('cylinder.step'), cadQuality: q });
      counts[q] = bodies.reduce((a, b) => a + b.mesh.indices.length / 3, 0);
      const vol = Math.abs(bodies.reduce((a, b) => a + meshVolume(b.mesh), 0));
      // pi * 10^2 * 20 = 6283 mm³; coarse tessellation is slightly smaller
      expect(vol).toBeGreaterThan(6283 * (q === 'draft' ? 0.9 : 0.995));
      expect(vol).toBeLessThan(6283.3);
    }
    expect(counts.draft).toBeLessThan(counts.normal);
    expect(counts.normal).toBeLessThan(counts.fine);
    expect(counts.fine).toBeLessThan(counts.ultra);
    console.log('cylinder triangles by quality', counts);
  });
});
