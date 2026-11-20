import { describe, expect, it } from 'vitest';
import { supportColors } from '../src/state/buildActions';
import { PALETTE } from '../src/state/palette';

describe('support colours', () => {
  it('draws supports blue, and never in a colour like the part', () => {
    expect(supportColors('#d6dbe2').supports).toBe('#86c3ea');
    for (const c of PALETTE) expect(supportColors(c).supports).toBe('#86c3ea');
    for (const blue of ['#3fa7ff', '#86c3ea', '#6c8cff', '#00e5ff', '#1b4f99']) expect(supportColors(blue).supports).toBe('#f0b429');
  });
});

describe('support file names', () => {
  it('s_ before the part name, or _s after it', async () => {
    const { supportName } = await import('../src/state/buildActions');
    expect(supportName('Bracket')).toBe('s_Bracket');
    expect(supportName('Bracket_2', 'prefix')).toBe('s_Bracket_2');
    expect(supportName('Bracket_2', 'suffix')).toBe('Bracket_2_s');
  });
});
