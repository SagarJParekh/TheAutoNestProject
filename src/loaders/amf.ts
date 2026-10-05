import { unzipSync } from 'fflate';
import type { ImportedBody, LoaderModule } from './types';
import { ImportError } from './types';
import { decodeText, parseAttributes, UNIT_TO_MM } from './text';

export function parseAMF(buffer: ArrayBuffer, fallbackName: string): ImportedBody[] {
  let bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes);
    const first = Object.keys(files).find((k) => !k.endsWith('/'));
    if (!first) throw new ImportError('Compressed AMF archive is empty');
    bytes = files[first];
  }
  const xml = decodeText(bytes);
  const root = /<amf\b([^>]*)>/i.exec(xml);
  if (!root) throw new ImportError('Not an AMF file (missing <amf> root)');
  const unit = (parseAttributes(root[1]).unit ?? 'millimeter').toLowerCase();
  const s = UNIT_TO_MM[unit] ?? 1;
  const bodies: ImportedBody[] = [];
  const oRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = oRe.exec(xml))) {
    n++;
    const body = m[2];
    const nameM = /<metadata\s+type\s*=\s*"name"\s*>([^<]*)<\/metadata>/i.exec(body);
    const coords: number[] = [];
    const vRe = /<coordinates>([\s\S]*?)<\/coordinates>/gi;
    let v: RegExpExecArray | null;
    while ((v = vRe.exec(body))) {
      const x = /<x>\s*([^<]+)<\/x>/i.exec(v[1]), y = /<y>\s*([^<]+)<\/y>/i.exec(v[1]), z = /<z>\s*([^<]+)<\/z>/i.exec(v[1]);
      coords.push(+(x?.[1] ?? 0) * s, +(y?.[1] ?? 0) * s, +(z?.[1] ?? 0) * s);
    }
    const idx: number[] = [];
    const tRe = /<triangle>([\s\S]*?)<\/triangle>/gi;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(body))) {
      const a = /<v1>\s*(\d+)/i.exec(t[1]), b = /<v2>\s*(\d+)/i.exec(t[1]), c = /<v3>\s*(\d+)/i.exec(t[1]);
      if (a && b && c) idx.push(+a[1], +b[1], +c[1]);
    }
    if (!idx.length) continue;
    const nv = coords.length / 3;
    if (idx.some((i) => i >= nv)) throw new ImportError('AMF triangle references a missing vertex');
    bodies.push({ name: nameM?.[1].trim() || `${fallbackName} ${n}`, positions: Float32Array.from(coords), indices: Uint32Array.from(idx) });
  }
  if (!bodies.length) throw new ImportError('AMF contains no meshes');
  return bodies;
}

export const amfLoader: LoaderModule = {
  id: 'amf',
  label: 'Additive Manufacturing File',
  extensions: ['amf'],
  async load(buffer, ctx) {
    return parseAMF(buffer, ctx.fileName.replace(/\.[^.]+$/, ''));
  },
};
