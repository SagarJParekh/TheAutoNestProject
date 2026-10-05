import type { MeshData } from '../geometry';
import type { PrepareResult } from '../workers/ops';

export interface MeshCacheEntry {
  bvh?: PrepareResult['bvh'];
  watertight?: boolean;
  edges?: Float32Array;
  edgesPending?: boolean;
  preparing?: boolean;
}

const cache = new WeakMap<MeshData, MeshCacheEntry>();
const listeners = new Set<(mesh: MeshData) => void>();

export function meshEntry(mesh: MeshData): MeshCacheEntry {
  let e = cache.get(mesh);
  if (!e) cache.set(mesh, (e = {}));
  return e;
}

export function updateMeshEntry(mesh: MeshData, patch: Partial<MeshCacheEntry>) {
  Object.assign(meshEntry(mesh), patch);
  listeners.forEach((l) => l(mesh));
}

export function onMeshEntryChange(fn: (mesh: MeshData) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
