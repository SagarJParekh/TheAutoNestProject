/**
 * Part names after an edit: each function adds its suffix, so a part's name
 * tells what was done to it (name_hollow_ltc…). Cut pieces are numbered
 * name_cut1, name_cut2… (letters could be part of a name).
 */
export const SUFFIX = {
  hollow: 'hollow',
  lattice: 'ltc',
  boolean: 'bool',
  texture: 'txtr',
  label: 'lbl',
  repaired: 'repaired',
} as const;

/** Add `_suffix` unless the name already ends with it (the same edit twice in a row). */
export function withSuffix(name: string, suffix: string): string {
  return name.endsWith(`_${suffix}`) ? name : `${name}_${suffix}`;
}

/** Name of the n-th piece (from 1) of a cut. */
export function cutName(name: string, n: number): string {
  return `${name}_cut${n}`;
}

/** Name a part is saved (exported) under: repaired parts get _repaired. */
export function savedName(p: { name: string; repaired?: boolean }): string {
  return p.repaired ? withSuffix(p.name, SUFFIX.repaired) : p.name;
}
