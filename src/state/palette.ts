/**
 * High-contrast palette that reads well on a dark background. No blues:
 * supports are drawn blue, and a part must never share its supports' colour.
 */
export const PALETTE = [
  '#d6dbe2', '#ff8c42', '#5ad15a', '#ff5d7a', '#b48cff', '#f5d547',
  '#3dd6c4', '#ff6fd8', '#a3e048', '#ff6b3d', '#e8a0ff', '#d9b26b',
];

let next = 0;
export function nextColor(): string {
  return PALETTE[next++ % PALETTE.length];
}
export function resetPalette(n = 0) {
  next = n;
}
