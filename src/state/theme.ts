/**
 * Appearance: interface theme (dark / light) and the 3D viewport background.
 * Remembered per browser.
 */
export interface Appearance {
  ui: 'dark' | 'light';
  /** id of a background preset, or 'custom' */
  background: string;
  /** colour used when background is 'custom' */
  custom: string;
}

export interface BackgroundPreset {
  id: string;
  label: string;
  /** CSS background for the viewport (behind the transparent WebGL canvas) */
  css: string;
  /** light backgrounds get darker grid lines */
  light: boolean;
}

export const BACKGROUNDS: BackgroundPreset[] = [
  { id: 'studio', label: 'Studio dark', css: '#1b1e24', light: false },
  { id: 'graphite', label: 'Graphite gradient', css: 'linear-gradient(180deg, #3a3f48 0%, #16181c 100%)', light: false },
  { id: 'midnight', label: 'Midnight blue', css: 'linear-gradient(180deg, #1d2b45 0%, #0b0f18 100%)', light: false },
  { id: 'blueprint', label: 'Blueprint', css: '#173a63', light: false },
  { id: 'black', label: 'Black', css: '#000000', light: false },
  { id: 'grey', label: 'Light grey', css: '#d9dce1', light: true },
  { id: 'sky', label: 'Sky gradient', css: 'linear-gradient(180deg, #f4f7fb 0%, #b9c6d8 100%)', light: true },
  { id: 'white', label: 'White', css: '#ffffff', light: true },
];

export const DEFAULT_APPEARANCE: Appearance = { ui: 'dark', background: 'studio', custom: '#2a3140' };

const KEY = 'autonest.appearance';

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) };
  } catch {
    // storage blocked: use defaults
  }
  return DEFAULT_APPEARANCE;
}

export function saveAppearance(a: Appearance) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    // ignore
  }
}

/** Relative luminance of a #rrggbb colour, 0..1. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** The CSS background and whether it is light, for the current appearance. */
export function viewportBackground(a: Appearance): { css: string; light: boolean } {
  if (a.background === 'custom') return { css: a.custom, light: luminance(a.custom) > 0.35 };
  const p = BACKGROUNDS.find((b) => b.id === a.background) ?? BACKGROUNDS[0];
  return { css: p.css, light: p.light };
}

export function applyUiTheme(a: Appearance) {
  document.documentElement.dataset.theme = a.ui;
}
