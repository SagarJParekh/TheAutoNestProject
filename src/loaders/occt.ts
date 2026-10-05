import type { ImportedBody, LoaderContext, LoaderModule } from './types';
import { ImportError } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
let occtPromise: Promise<any> | null = null;

async function getOcct(ctx: LoaderContext): Promise<any> {
  if (!occtPromise) {
    occtPromise = (async () => {
      const mod: any = await import('occt-import-js');
      const factory = mod.default ?? mod;
      const url = ctx.wasmUrls?.occt;
      return factory(url ? { locateFile: () => url } : undefined);
    })();
    occtPromise.catch(() => (occtPromise = null));
  }
  return occtPromise;
}

async function readCad(kind: 'step' | 'iges' | 'brep', buffer: ArrayBuffer, ctx: LoaderContext): Promise<ImportedBody[]> {
  ctx.onProgress(0.05, 'Loading OpenCascade');
  const occt = await getOcct(ctx);
  ctx.onProgress(0.2, 'Tessellating');
  const params = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.0005,
    angularDeflection: 0.35,
  };
  const data = new Uint8Array(buffer);
  const res =
    kind === 'step' ? occt.ReadStepFile(data, params) : kind === 'iges' ? occt.ReadIgesFile(data, params) : occt.ReadBrepFile(data, params);
  if (!res || !res.success) throw new ImportError(`OpenCascade could not read this ${kind.toUpperCase()} file`);
  const base = ctx.fileName.replace(/\.[^.]+$/, '');
  const bodies: ImportedBody[] = [];
  (res.meshes ?? []).forEach((m: any, i: number) => {
    const pos = m.attributes?.position?.array;
    const idx = m.index?.array;
    if (!pos || !idx || idx.length === 0) return;
    bodies.push({ name: m.name || `${base} ${i + 1}`, positions: Float32Array.from(pos), indices: Uint32Array.from(idx) });
  });
  if (!bodies.length) throw new ImportError(`${kind.toUpperCase()} file contains no solid or surface geometry`);
  return bodies;
}

export const stepLoader: LoaderModule = {
  id: 'step',
  label: 'STEP',
  extensions: ['step', 'stp'],
  load: (b, c) => readCad('step', b, c),
};

export const igesLoader: LoaderModule = {
  id: 'iges',
  label: 'IGES',
  extensions: ['iges', 'igs'],
  load: (b, c) => readCad('iges', b, c),
};

export const brepLoader: LoaderModule = {
  id: 'brep',
  label: 'OpenCascade BREP',
  extensions: ['brep', 'brp'],
  load: (b, c) => readCad('brep', b, c),
};
