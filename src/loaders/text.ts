const decoder = new TextDecoder();

export function decodeText(buffer: ArrayBuffer | Uint8Array): string {
  return decoder.decode(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
}

/** Parse XML-ish attributes: key="value" pairs. */
export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = m[3] ?? m[4] ?? '';
  return out;
}

export function localName(attr: Record<string, string>, name: string): string | undefined {
  if (attr[name] !== undefined) return attr[name];
  for (const k of Object.keys(attr)) if (k.endsWith(':' + name)) return attr[k];
  return undefined;
}

export const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  millimetre: 1,
  centimeter: 10,
  centimetre: 10,
  meter: 1000,
  metre: 1000,
  inch: 25.4,
  foot: 304.8,
  feet: 304.8,
};

export function scalePositions(p: Float32Array, s: number): Float32Array {
  if (s === 1) return p;
  for (let i = 0; i < p.length; i++) p[i] *= s;
  return p;
}
