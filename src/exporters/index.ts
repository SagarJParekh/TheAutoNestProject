import { zipSync, strToU8 } from 'fflate';
import type { MeshData } from '../geometry';

export interface ExportItem {
  name: string;
  /** world-space mesh (transforms already baked) */
  mesh: MeshData;
}

/** Binary STL containing all items. */
export function exportSTL(items: ExportItem[]): Uint8Array {
  let nt = 0;
  for (const it of items) nt += it.mesh.indices.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  const header = 'Binary STL exported by AutoNest Mesh Prep (mm)';
  for (let i = 0; i < header.length && i < 80; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nt, true);
  let o = 84;
  for (const { mesh } of items) {
    const p = mesh.positions, idx = mesh.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
      o += 12;
      for (const v of [a, b, c]) {
        dv.setFloat32(o, p[v], true);
        dv.setFloat32(o + 4, p[v + 1], true);
        dv.setFloat32(o + 8, p[v + 2], true);
        o += 12;
      }
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

/** Wavefront OBJ, one `o` block per item. */
export function exportOBJ(items: ExportItem[]): Uint8Array {
  const parts: string[] = ['# Exported by AutoNest Mesh Prep (units: mm)\n'];
  let base = 1;
  for (const { name, mesh } of items) {
    const lines: string[] = [`o ${name.replace(/\s+/g, '_')}`];
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) lines.push(`v ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}`);
    const idx = mesh.indices;
    for (let i = 0; i < idx.length; i += 3) lines.push(`f ${idx[i] + base} ${idx[i + 1] + base} ${idx[i + 2] + base}`);
    base += p.length / 3;
    parts.push(lines.join('\n') + '\n');
  }
  return strToU8(parts.join(''));
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toPrecision(9).replace(/\.?0+$/, '');
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** 3MF package with one object + build item per part. */
export function export3MF(items: ExportItem[]): Uint8Array {
  const objs: string[] = [];
  const build: string[] = [];
  items.forEach(({ name, mesh }, i) => {
    const id = i + 1;
    const v: string[] = [];
    const p = mesh.positions;
    for (let k = 0; k < p.length; k += 3) v.push(`<vertex x="${fmt(p[k])}" y="${fmt(p[k + 1])}" z="${fmt(p[k + 2])}"/>`);
    const t: string[] = [];
    const idx = mesh.indices;
    for (let k = 0; k < idx.length; k += 3) t.push(`<triangle v1="${idx[k]}" v2="${idx[k + 1]}" v3="${idx[k + 2]}"/>`);
    objs.push(
      `<object id="${id}" name="${xmlEscape(name)}" type="model"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`,
    );
    build.push(`<item objectid="${id}"/>`);
  });
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Application">AutoNest Mesh Prep</metadata>` +
    `<resources>${objs.join('')}</resources><build>${build.join('')}</build></model>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return zipSync(
    {
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rels),
      '3D/3dmodel.model': strToU8(model),
    },
    { level: 6 },
  );
}

export type ExportFormat = 'stl' | '3mf' | 'obj';

export function exportMeshes(format: ExportFormat, items: ExportItem[]): Uint8Array {
  switch (format) {
    case 'stl':
      return exportSTL(items);
    case 'obj':
      return exportOBJ(items);
    case '3mf':
      return export3MF(items);
  }
}

/** Separate files, one per item, zipped together. */
export function exportZip(format: ExportFormat, items: ExportItem[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const it of items) {
    let base = it.name.replace(/[^\w.-]+/g, '_') || 'part';
    let n = 1;
    while (used.has(base)) base = `${it.name.replace(/[^\w.-]+/g, '_')}_${++n}`;
    used.add(base);
    files[`${base}.${format}`] = exportMeshes(format, [it]);
  }
  return zipSync(files, { level: 0 });
}
