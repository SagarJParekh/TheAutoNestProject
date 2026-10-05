import { computeBounds, compactMesh, MeshData, weldVertices } from '../geometry';
import { getLoader } from './registry';
import { ImportError, LoaderContext } from './types';
import './index';

/** Soft limit: larger models still load, with a warning. */
export const MAX_TRIANGLES = 12_000_000;

export interface PreparedBody {
  name: string;
  /** welded, indexed mesh, recentred so its bounding-box centre is the origin */
  mesh: MeshData;
  /** where the centre was in file coordinates (becomes the part position) */
  center: [number, number, number];
}

/**
 * Parse a file with the registered loader and turn every body into a clean
 * indexed mesh (exact-duplicate vertices merged so topology works).
 */
export async function importFile(buffer: ArrayBuffer, ctx: LoaderContext): Promise<PreparedBody[]> {
  const loader = getLoader(ctx.fileName);
  if (!loader) throw new ImportError(`Unsupported file type: ${ctx.fileName}`);
  if (!loader.load) throw new ImportError(loader.unsupportedMessage ?? `${loader.label} files cannot be imported`);
  const bodies = await loader.load(buffer, ctx);
  ctx.onProgress(0.85, 'Building topology');
  const out: PreparedBody[] = [];
  for (const b of bodies) {
    for (let i = 0; i < b.positions.length; i++) {
      if (!Number.isFinite(b.positions[i])) throw new ImportError(`${b.name}: file contains invalid (NaN/infinite) coordinates`);
    }
    const nv = b.positions.length / 3;
    if (b.indices) {
      for (let i = 0; i < b.indices.length; i++) if (b.indices[i] >= nv) throw new ImportError(`${b.name}: triangle index out of range`);
    }
    const { mesh: welded } = weldVertices(b.positions, b.indices, 0);
    const mesh = compactMesh(welded);
    if (mesh.indices.length === 0) continue;
    const bb = computeBounds(mesh.positions);
    const c: [number, number, number] = [
      (bb.min[0] + bb.max[0]) / 2,
      (bb.min[1] + bb.max[1]) / 2,
      (bb.min[2] + bb.max[2]) / 2,
    ];
    const p = mesh.positions === b.positions ? mesh.positions.slice() : mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      p[i] -= c[0];
      p[i + 1] -= c[1];
      p[i + 2] -= c[2];
    }
    out.push({ name: b.name, mesh: { positions: p, indices: mesh.indices }, center: c });
  }
  if (!out.length) throw new ImportError('File contains no triangles');
  const tris = out.reduce((a, b) => a + b.mesh.indices.length / 3, 0);
  if (tris > MAX_TRIANGLES) ctx.warn(`${ctx.fileName} has ${(tris / 1e6).toFixed(1)} million triangles (above ${MAX_TRIANGLES / 1e6} million); editing may be slow.`);
  return out;
}
