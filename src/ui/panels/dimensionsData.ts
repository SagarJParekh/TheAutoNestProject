import { partStats, shellCount } from '../../state/report';
import type { Part } from '../../state/types';

/** Stats are cached per part revision, so this is cheap to call on every render. */
export const usePartStats = (p: Part) => partStats(p);

export function partShellsLabel(p: Part): string {
  if (p.mesh.indices.length / 3 > 3_000_000) return '—';
  const n = shellCount(p);
  return n.toLocaleString();
}
