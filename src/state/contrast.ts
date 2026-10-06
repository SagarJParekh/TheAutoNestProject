/**
 * Highlight colours that stand out from a part's colour and from each other:
 * open edges (holes / open surfaces), stitchable cracks and non-manifold edges.
 */
import { Color } from 'three';

const CANDIDATES = ['#ff1744', '#ffea00', '#00e5ff', '#76ff03', '#ff9100', '#d500f9', '#ffffff', '#2979ff'];

/** Perceptual-ish distance (redmean approximation). */
function distance(a: Color, b: Color): number {
  const r = ((a.r + b.r) / 2) * 255;
  const dr = (a.r - b.r) * 255, dg = (a.g - b.g) * 255, db = (a.b - b.b) * 255;
  return Math.sqrt((2 + r / 256) * dr * dr + 4 * dg * dg + (2 + (255 - r) / 256) * db * db);
}

const cache = new Map<string, { open: string; crack: string; nonManifold: string }>();

export function highlightColors(partColor: string): { open: string; crack: string; nonManifold: string } {
  let c = cache.get(partColor);
  if (c) return c;
  const base = new Color(partColor);
  const picked: Color[] = [base];
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    let best = CANDIDATES[0], bd = -1;
    for (const cand of CANDIDATES) {
      if (out.includes(cand)) continue;
      const cc = new Color(cand);
      // maximise the distance to the closest colour already in use
      const d = Math.min(...picked.map((p) => distance(p, cc)));
      if (d > bd) {
        bd = d;
        best = cand;
      }
    }
    out.push(best);
    picked.push(new Color(best));
  }
  c = { open: out[0], crack: out[1], nonManifold: out[2] };
  cache.set(partColor, c);
  return c;
}
