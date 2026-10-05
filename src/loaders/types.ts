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
