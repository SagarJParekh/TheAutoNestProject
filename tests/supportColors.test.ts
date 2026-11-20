import { describe, expect, it } from 'vitest';
import { supportColors } from '../src/state/buildActions';
import { PALETTE } from '../src/state/palette';

describe('support colours', () => {
  it('draws supports blue, and never in a colour like the part', () => {
    expect(supportColors('#d6dbe2').supports).toBe('#2f80ed');
    for (const c of PALETTE) expect(supportColors(c).supports).toBe('#2f80ed');
    for (const blue of ['#3fa7ff', '#2f80ed', '#6c8cff', '#00e5ff', '#1b4f99']) expect(supportColors(blue).supports).toBe('#f0b429');
  });
});
