/**
 * Per-part measurements for the Dimensions and Report tabs, and the
 * spreadsheet-friendly report text.
 */
import { measureMesh, type MeshMeasurements } from '../geometry/measure';
import { findShells } from '../geometry';
import { matrixOf } from './math';
import type { Part } from './types';

const statsCache = new WeakMap<Part, MeshMeasurements>();
const shellCache = new WeakMap<object, number>();

/** World-space measurements of a part (cached per part revision). */
export function partStats(p: Part): MeshMeasurements {
  let m = statsCache.get(p);
  if (!m) statsCache.set(p, (m = measureMesh(p.mesh, matrixOf(p.transform).elements)));
  return m;
}

export function shellCount(p: Part): number {
  let n = shellCache.get(p.mesh);
  if (n === undefined) shellCache.set(p.mesh, (n = findShells(p.mesh).shellCount));
  return n;
}

export interface ReportRow {
  name: string;
  /** mm³ (absolute) */
  volume: number;
  /** bounding box size, mm */
  x: number;
  y: number;
  z: number;
  /** the volume is only meaningful for closed meshes */
  inverted: boolean;
}

export function reportRows(parts: Part[]): ReportRow[] {
  return parts.map((p) => {
    const m = partStats(p);
    return { name: p.name, volume: Math.abs(m.volume), x: m.size[0], y: m.size[1], z: m.size[2], inverted: m.volume < 0 };
  });
}

export const REPORT_HEADER = ['Part Name', 'Quantity', 'Volume (mm³)', 'X (mm)', 'Y (mm)', 'Z (mm)'];

const num = (v: number, d: number) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);

/** Tab-separated rows: pastes straight into Excel / Google Sheets cells. Quantity is left blank. */
export function reportTSV(rows: ReportRow[]): string {
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ');
  const lines = [REPORT_HEADER.join('\t'), ...rows.map((r) => [clean(r.name), '', num(r.volume, 2), num(r.x, 2), num(r.y, 2), num(r.z, 2)].join('\t'))];
  return lines.join('\r\n') + '\r\n';
}

export function reportCSV(rows: ReportRow[]): string {
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [REPORT_HEADER.map(q).join(','), ...rows.map((r) => [q(r.name), '', num(r.volume, 2), num(r.x, 2), num(r.y, 2), num(r.z, 2)].join(','))];
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** HTML table version of the report: keeps columns when pasted into spreadsheets that prefer HTML. */
export function reportHTML(rows: ReportRow[]): string {
  const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
  const head = `<tr>${REPORT_HEADER.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>`;
  const body = rows.map((r) => `<tr><td>${esc(r.name)}</td><td></td><td>${num(r.volume, 2)}</td><td>${num(r.x, 2)}</td><td>${num(r.y, 2)}</td><td>${num(r.z, 2)}</td></tr>`).join('');
  return `<table>${head}${body}</table>`;
}

/** Copy the report to the clipboard as TSV (+ HTML where supported). */
export async function copyReport(rows: ReportRow[]): Promise<boolean> {
  const tsv = reportTSV(rows);
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/plain': new Blob([tsv], { type: 'text/plain' }), 'text/html': new Blob([reportHTML(rows)], { type: 'text/html' }) }),
      ]);
      return true;
    }
    await navigator.clipboard.writeText(tsv);
    return true;
  } catch {
    // fallback for browsers without clipboard permission
    const ta = document.createElement('textarea');
    ta.value = tsv;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
