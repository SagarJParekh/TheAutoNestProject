/** One solid/body coming out of a file. Positions in millimetres, Z up. */
export interface ImportedBody {
  name: string;
  positions: Float32Array;
  /** omitted for triangle soups (every 3 vertices form a triangle) */
  indices?: Uint32Array;
}

export interface LoaderContext {
  fileName: string;
  onProgress: (fraction: number, message?: string) => void;
  /** other files dropped in the same batch, for formats with external resources (.gltf + .bin) */
  siblings?: Map<string, ArrayBuffer>;
  /** URLs of WASM binaries (set by the worker; undefined in Node where defaults work) */
  wasmUrls?: { occt?: string; rhino?: string };
  /** tessellation quality for CAD formats (STEP/IGES/BREP) */
  cadQuality?: CadQuality;
  /** non-fatal issues to show the user */
  warn: (message: string) => void;
}

export interface LoaderModule {
  id: string;
  label: string;
  /** lower-case extensions without the dot */
  extensions: string[];
  load?: (buffer: ArrayBuffer, ctx: LoaderContext) => Promise<ImportedBody[]>;
  /** set for formats that are recognised but cannot be imported */
  unsupportedMessage?: string;
}

export class ImportError extends Error {}

export type CadQuality = 'draft' | 'normal' | 'fine' | 'ultra';

/** OpenCascade tessellation settings per quality level (deflection relative to the part size). */
export const CAD_QUALITY: Record<CadQuality, { linearDeflection: number; angularDeflection: number; label: string }> = {
  draft: { linearDeflection: 0.002, angularDeflection: 0.5, label: 'Draft' },
  normal: { linearDeflection: 0.0005, angularDeflection: 0.35, label: 'Normal' },
  fine: { linearDeflection: 0.0001, angularDeflection: 0.15, label: 'Fine' },
  ultra: { linearDeflection: 0.00002, angularDeflection: 0.06, label: 'Ultra' },
};
