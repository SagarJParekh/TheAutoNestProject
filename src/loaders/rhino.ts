import type { ImportedBody, LoaderContext, LoaderModule } from './types';
import { ImportError } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
let rhinoPromise: Promise<any> | null = null;

async function getRhino(ctx: LoaderContext): Promise<any> {
  if (!rhinoPromise) {
    rhinoPromise = (async () => {
      const mod: any = await import('rhino3dm');
      const factory = mod.default ?? mod;
      const url = ctx.wasmUrls?.rhino;
      return factory(url ? { locateFile: () => url } : undefined);
    })();
    rhinoPromise.catch(() => (rhinoPromise = null));
  }
  return rhinoPromise;
}

function unitScale(rhino: any, unit: any): number {
  const U = rhino.UnitSystem;
  const v = unit?.value ?? unit;
  const table: [any, number][] = [
    [U.Microns, 0.001], [U.Millimeters, 1], [U.Centimeters, 10], [U.Meters, 1000], [U.Kilometers, 1e6],
    [U.Inches, 25.4], [U.Feet, 304.8], [U.Yards, 914.4], [U.Mils, 0.0254], [U.Microinches, 2.54e-5],
  ];
  for (const [u, s] of table) if (u !== undefined && (u.value ?? u) === v) return s;
  return 1;
}

function meshToArrays(mesh: any): { positions: Float32Array; indices: Uint32Array } | null {
  if (!mesh) return null;
  const json = mesh.toThreejsJSON();
  const attr = json?.data?.attributes?.position?.array;
  const index = json?.data?.index?.array;
  if (!attr || attr.length === 0) return null;
  const positions = Float32Array.from(attr);
  const indices = index ? Uint32Array.from(index) : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  return { positions, indices };
}

/**
 * Rhino 3DM. rhino3dm cannot tessellate NURBS itself, so Breps/Extrusions use
 * the render meshes cached in the file; objects without them are reported.
 */
export const rhinoLoader: LoaderModule = {
  id: '3dm',
  label: 'Rhino 3DM',
  extensions: ['3dm'],
  async load(buffer, ctx) {
    ctx.onProgress(0.05, 'Loading rhino3dm');
    const rhino = await getRhino(ctx);
    const doc = rhino.File3dm.fromByteArray(new Uint8Array(buffer));
    if (!doc) throw new ImportError('rhino3dm could not read this 3DM file');
    const scale = unitScale(rhino, doc.settings().modelUnitSystem);
    const objects = doc.objects();
    const count = objects.count;
    const T = rhino.ObjectType;
    const bodies: ImportedBody[] = [];
    let missing = 0;
    const base = ctx.fileName.replace(/\.[^.]+$/, '');
    for (let i = 0; i < count; i++) {
      const obj = objects.get(i);
      const geom = obj.geometry();
      const attrs = obj.attributes();
      const name = attrs?.name || `${base} ${i + 1}`;
      const type = geom?.objectType;
      const parts: { positions: Float32Array; indices: Uint32Array }[] = [];
      if (type === T.Mesh) {
        const a = meshToArrays(geom);
        if (a) parts.push(a);
      } else if (type === T.Brep) {
        const faces = geom.faces();
        for (let f = 0; f < faces.count; f++) {
          const a = meshToArrays(faces.get(f).getMesh(rhino.MeshType.Any));
          if (a) parts.push(a);
        }
      } else if (type === T.Extrusion) {
        const a = meshToArrays(geom.getMesh(rhino.MeshType.Any));
        if (a) parts.push(a);
      } else if (type === T.SubD) {
        missing++;
        continue;
      } else {
        continue; // curves, points, annotations...
      }
      if (!parts.length) {
        missing++;
        continue;
      }
      let nv = 0, ni = 0;
      for (const p of parts) {
        nv += p.positions.length;
        ni += p.indices.length;
      }
      const positions = new Float32Array(nv);
      const indices = new Uint32Array(ni);
      let vo = 0, io = 0;
      for (const p of parts) {
        positions.set(p.positions, vo);
        for (let k = 0; k < p.indices.length; k++) indices[io + k] = p.indices[k] + vo / 3;
        vo += p.positions.length;
        io += p.indices.length;
      }
      if (scale !== 1) for (let k = 0; k < positions.length; k++) positions[k] *= scale;
      bodies.push({ name, positions, indices });
    }
    if (missing)
      ctx.warn(
        `${missing} object(s) in ${ctx.fileName} have no render mesh and were skipped. Save from Rhino with render meshes, or export as STEP.`,
      );
    if (!bodies.length) throw new ImportError('3DM file contains no meshable objects (save with render meshes or export STEP)');
    return bodies;
  },
};
