import { describe, expect, it } from 'vitest';
import { hollowayReverse, hollowayTable } from '../../src/tools/stego/_holloway-table';
import { capacityBits, encodeHolloway, secretToBits } from './encode';

const COVER =
  'Just landed in town and the weather is lovely, so I am heading out for a long walk by the river with friends.';

/** Re-read the emitted values from the output using only the shared table. */
function readBits(original: string, encoded: string): number[] {
  const table = hollowayTable();
  const rev = hollowayReverse(table);
  const bits: number[] = [];
  const o = [...original];
  const e = [...encoded];
  expect(e.length).toBe(o.length);
  o.forEach((ch, i) => {
    const entry = table.get(ch);
    const glyph = e[i] ?? '';
    if (!entry) {
      expect(glyph).toBe(ch);
      return;
    }
    const hit = rev.get(glyph.codePointAt(0) ?? -1);
    expect(hit?.base).toBe(ch);
    const value = hit?.value ?? 0;
    expect(value).toBeLessThan(2 ** entry.bits);
    for (let b = entry.bits - 1; b >= 0; b--) bits.push((value >> b) & 1);
  });
  return bits;
}

describe('encodeHolloway', () => {
  it('changes the cover and keeps its length in code points', () => {
    const out = encodeHolloway(COVER, 'secret message');
    expect(out).not.toBe(COVER);
    expect([...out].length).toBe([...COVER].length);
  });

  it('emits glyphs that map back to the secret bitstream', () => {
    const secret = 'ftf_homoglyph_1';
    const expected = secretToBits(secret);
    const got = readBits(COVER, encodeHolloway(COVER, secret));
    expect(got.slice(0, expected.length)).toEqual(expected);
    expect(got.slice(expected.length).every((b) => b === 0)).toBe(true);
  });

  it('passes non-table characters through and reports capacity', () => {
    const cover = 'hi there\n\u{1f600} ok';
    const out = encodeHolloway(cover, 'a');
    expect(out).toContain('\n');
    expect(out).toContain('\u{1f600}');
    expect(capacityBits(cover)).toBeGreaterThanOrEqual(6);
  });

  it('lowercases the secret, rejects foreign characters and short covers', () => {
    expect(encodeHolloway(COVER, 'ABC')).toBe(encodeHolloway(COVER, 'abc'));
    expect(() => encodeHolloway(COVER, '{x}')).toThrow();
    expect(() => encodeHolloway('hi', 'a long secret')).toThrow(/too short/);
  });
});
