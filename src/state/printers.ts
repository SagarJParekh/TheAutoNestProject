/**
 * Printer catalogue for Build Generation: technology -> printer -> build volume (mm).
 */
export type Technology = 'sla' | 'dlp' | 'dmls' | 'powder';

export interface Printer {
  id: string;
  name: string;
  tech: Technology;
  /** X, Y, Z build volume in mm (custom printers use the size the user enters) */
  volume: [number, number, number];
  custom?: boolean;
  /** volume still to be confirmed */
  provisional?: boolean;
}

export const TECHNOLOGIES: { id: Technology; label: string; note: string }[] = [
  { id: 'sla', label: 'SLA', note: 'Resin, laser: parts are never stacked in Z; arranged in X and Y only.' },
  { id: 'dlp', label: 'DLP', note: 'Resin, projector / screen: parts are never stacked in Z; arranged in X and Y only.' },
  { id: 'dmls', label: 'DMLS', note: 'Metal: same rules as SLA / DLP (no stacking in Z).' },
  { id: 'powder', label: 'HP MJF / SLS', note: 'Powder bed: detailed rules to follow; stacking in Z can be switched on.' },
];

export const PRINTERS: Printer[] = [
  // SLA
  { id: 'eplus', name: 'Eplus', tech: 'sla', volume: [800, 800, 320] },
  { id: 'magform', name: 'Magform', tech: 'sla', volume: [600, 600, 400] },
  { id: 'sla-custom', name: 'Custom', tech: 'sla', volume: [200, 200, 200], custom: true },
  // DLP
  { id: 'form3', name: 'Form 3', tech: 'dlp', volume: [145, 145, 185] },
  { id: 'form3l', name: 'Form 3L', tech: 'dlp', volume: [335, 200, 300] },
  { id: 'form4', name: 'Form 4', tech: 'dlp', volume: [200, 125, 210] },
  { id: 'form4l', name: 'Form 4L', tech: 'dlp', volume: [353, 196, 353] },
  { id: 'vayu-core', name: 'Vayu Core', tech: 'dlp', volume: [211, 118, 300] },
  { id: 'vayu-rise', name: 'Vayu Rise', tech: 'dlp', volume: [302, 161, 380] },
  { id: 'yousu', name: 'YouSu', tech: 'dlp', volume: [211, 118, 240] },
  { id: 'figure4', name: 'Figure 4 (3D Systems)', tech: 'dlp', volume: [124.8, 70.2, 196] },
  { id: 'dlp-custom', name: 'Custom', tech: 'dlp', volume: [150, 100, 200], custom: true },
  // DMLS
  { id: 'm2', name: 'M2', tech: 'dmls', volume: [245, 245, 300] },
  { id: 'mlab100r', name: 'MLab 100R', tech: 'dmls', volume: [90, 90, 80] },
  { id: 'mlab200r', name: 'MLab 200R', tech: 'dmls', volume: [100, 100, 100] },
  { id: 'dmls-custom', name: 'Custom', tech: 'dmls', volume: [250, 250, 300], custom: true },
  // HP MJF / SLS
  { id: 'mjf5200', name: 'HP MJF 5200', tech: 'powder', volume: [380, 284, 380], provisional: true },
  { id: 'fuse1', name: 'Fuse 1+', tech: 'powder', volume: [165, 165, 300], provisional: true },
  { id: 'powder-custom', name: 'Custom', tech: 'powder', volume: [300, 300, 300], custom: true },
];

/** Resin printers (SLA or DLP): SLC export, no stacking in Z. */
export const isResin = (t: Technology) => t === 'sla' || t === 'dlp';

export const printerById = (id: string) => PRINTERS.find((p) => p.id === id) ?? PRINTERS[0];
