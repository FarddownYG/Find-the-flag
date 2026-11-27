/**
 * Shared protocol table for Holloway-style homoglyph steganography ("Twitter Secret Messages",
 * steg-of-the-dump). This file is DATA only — the canonical variant table and the 6-bit alphabet —
 * so that the encoder (the bench reference generator) and the decoder (the FTF tool) agree on the
 * protocol while their algorithms are written independently. Reimplemented from the published
 * scheme, not copied from the original (which has no licence).
 *
 * Scheme: every character of the cover text that appears in the table carries
 * floor(log2(variants + 1)) bits, where `variants` is the number of homoglyph alternatives for that
 * base character. The chosen glyph encodes the value: index 0 = the original ASCII character, index
 * i = the i-th alternative. Bits are concatenated across the whole text, then read 6 at a time as
 * indices into ALPHABET6.
 */

/** The 6-bit output alphabet (index 0 = space). 48 symbols; indices 48..63 are unused/invalid. */
export const ALPHABET6 = " abcdefghijklmnopqrstuvwxyz123456789'0.:/\\%-_?&;";

/** The 15 space alternatives (index 1..15); index 0 is the ordinary space U+0020 → 4 bits. */
export const SPACE_VARIANTS: readonly number[] = [
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
  0x2029, 0x202f, 0x205f,
];

/**
 * Extra homoglyph alternatives (beyond the fullwidth form) for the commonly-confused letters, as
 * code points, in a FIXED order. The fullwidth form is always alternative #1; these follow.
 */
const EXTRA: Record<string, number[]> = {
  a: [0x0430, 0x03b1], // Cyrillic а, Greek α
  c: [0x0441, 0x03f2], // Cyrillic с, Greek ϲ
  e: [0x0435, 0x212e], // Cyrillic е, estimated ℮
  i: [0x0456, 0x2170], // Cyrillic і, Roman numeral ⅰ
  j: [0x0458], // Cyrillic ј
  o: [0x03bf, 0x043e], // Greek ο, Cyrillic о
  p: [0x0440, 0x03c1], // Cyrillic р, Greek ρ
  s: [0x0455], // Cyrillic ѕ
  v: [0x03bd, 0x2174], // Greek ν, Roman numeral ⅴ
  x: [0x0445, 0x03c7], // Cyrillic х, Greek χ
  y: [0x0443, 0x03b3], // Cyrillic у, Greek γ
};

export interface CharVariants {
  /** The base ASCII character. */
  base: string;
  /** Alternative code points; index i (1-based here) encodes value i, original (value 0) is `base`. */
  alts: number[];
  /** floor(log2(alts.length + 1)) — the bits this character carries. */
  bits: number;
}

const floorLog2 = (n: number): number => Math.floor(Math.log2(n));

/** Build the canonical table: base character -> its ordered alternatives and bit capacity. */
export function hollowayTable(): Map<string, CharVariants> {
  const table = new Map<string, CharVariants>();
  // Space: the 15 variants.
  table.set(' ', {
    base: ' ',
    alts: [...SPACE_VARIANTS],
    bits: floorLog2(SPACE_VARIANTS.length + 1),
  });
  // Every other printable ASCII character: fullwidth form first, then any extras.
  for (let cp = 0x21; cp <= 0x7e; cp++) {
    const base = String.fromCharCode(cp);
    const alts = [cp + 0xfee0, ...(EXTRA[base] ?? [])]; // fullwidth U+FF01..FF5E, then extras
    table.set(base, { base, alts, bits: floorLog2(alts.length + 1) });
  }
  return table;
}

/** Reverse lookup: a code point -> the base character and the variant value it encodes. */
export function hollowayReverse(
  table: Map<string, CharVariants>,
): Map<number, { base: string; value: number }> {
  const rev = new Map<number, { base: string; value: number }>();
  for (const { base, alts } of table.values()) {
    rev.set(base.charCodeAt(0), { base, value: 0 });
    alts.forEach((cp, i) => rev.set(cp, { base, value: i + 1 }));
  }
  return rev;
}
