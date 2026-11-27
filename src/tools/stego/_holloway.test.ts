import { describe, expect, it } from 'vitest';
import type { Output } from '../../core/types';
import { defaults } from '../audio/_synth';
import { decodeHolloway, hollowayReadable } from './_holloway';
import { ALPHABET6, hollowayTable } from './_holloway-table';
import tool from './unicode-hidden';

/**
 * A by-hand Holloway encoder, written here from the spec and the shared table only (never the bench
 * encoder): for each cover character in the table, take its `bits` bits from the secret bitstream,
 * MSB-first, and emit the glyph that encodes that value (0 = the original character, i = alts[i-1]).
 * Separate from the decoder so a table mistake cannot hide in both.
 */
function encodeHolloway(secret: string, cover: string): string {
  const table = hollowayTable();
  const bits: number[] = [];
  for (const ch of secret) {
    const idx = ALPHABET6.indexOf(ch);
    if (idx < 0) throw new Error(`secret char not in ALPHABET6: ${JSON.stringify(ch)}`);
    for (let b = 5; b >= 0; b--) bits.push((idx >> b) & 1);
  }
  let bi = 0;
  let out = '';
  for (const ch of cover) {
    const entry = table.get(ch);
    if (!entry) {
      out += ch;
      continue;
    }
    let value = 0;
    for (let k = 0; k < entry.bits; k++) value = (value << 1) | (bits[bi++] ?? 0);
    out += value === 0 ? entry.base : String.fromCodePoint(entry.alts[value - 1]!);
  }
  if (bi < bits.length) throw new Error('cover too short to carry the secret');
  return out;
}

const run = async (input: string): Promise<Output[]> =>
  tool.run(input, defaults(tool, {}) as never);

describe('decodeHolloway', () => {
  it('recovers a single letter from glyphs picked by hand', () => {
    // "a" is ALPHABET6 index 1 = 000001. Six one-bit carriers b d f g h k carry 0 0 0 0 0 1, so k
    // becomes its fullwidth form U+FF4B and the rest stay ASCII.
    const stego = 'bdfghｋ';
    const d = decodeHolloway(stego);
    expect(d).not.toBeNull();
    expect(d!.message).toBe('a');
    expect(d!.bits).toBe(6);
    expect(d!.homoglyphs).toBe(1);
    expect(d!.specialSpaces).toBe(0);
  });

  it('recovers a letter across a special space and a Greek homoglyph (by hand)', () => {
    // Target index 0b010011 = 19 = "s". A space carries 4 bits (0100 = variant #4, U+2003) and "a"
    // carries 2 bits (11 = alt #3, Greek α U+03B1).
    const stego = ' α';
    const d = decodeHolloway(stego);
    expect(d).not.toBeNull();
    expect(d!.message).toBe('s');
    expect(d!.bits).toBe(6);
    expect(d!.homoglyphs).toBe(1);
    expect(d!.specialSpaces).toBe(1);
  });

  it('round-trips a longer secret through the hand encoder', () => {
    const secret = 'hello world';
    const cover =
      'The quick brown fox jumps over the lazy dog while the sun slowly sets behind the old ' +
      'stone bridge near our village, and the tired farmers walk home along the winding river.';
    const stego = encodeHolloway(secret, cover);
    expect(stego).not.toBe(cover); // some glyphs were swapped
    const d = decodeHolloway(stego);
    expect(d).not.toBeNull();
    expect(d!.message.slice(0, secret.length)).toBe(secret);
    // Anything past the secret is padding: zero bits read back as ALPHABET6 index 0 (space).
    expect(d!.message.slice(secret.length)).toMatch(/^ *$/);
    expect(d!.homoglyphs + d!.specialSpaces).toBeGreaterThan(0);
  });

  it('returns null for plain ASCII with no homoglyph or special-space carrier', () => {
    expect(decodeHolloway('hello world, this is plain ascii text with nothing hidden.')).toBeNull();
    expect(decodeHolloway('')).toBeNull();
  });

  it('judges a readable sentence but not junk', () => {
    expect(hollowayReadable('meet me at the old bridge at noon')).toBe(true);
    expect(hollowayReadable('a1b2 x')).toBe(false);
    expect(hollowayReadable('')).toBe(false);
  });
});

describe('the Holloway warning in the tool', () => {
  it('warns that special spaces were lost when a homoglyph text has none', async () => {
    // Several Cyrillic о lookalikes, ordinary spaces throughout.
    const text = 'the quick brоwn fоx jumps оver the lazy dоg today';
    const d = decodeHolloway(text);
    expect(d).not.toBeNull();
    expect(d!.homoglyphs).toBeGreaterThan(0);
    expect(d!.specialSpaces).toBe(0);
    const out = await run(text);
    expect(
      out.some((o) => o.type === 'note' && o.level === 'warn' && /lost on copy-paste/.test(o.text)),
    ).toBe(true);
  });
});
