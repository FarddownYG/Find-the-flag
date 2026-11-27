/**
 * Decoder for Holloway-style homoglyph steganography ("Twitter Secret Messages"). The cover text is
 * the carrier: every character that has an entry in the shared table carries floor(log2(variants+1))
 * bits, and the glyph chosen for that position encodes a value (0 = the original ASCII character,
 * i = the i-th alternative). The bits of all such positions, concatenated MSB-first, are read six at
 * a time as indices into ALPHABET6 to recover the secret.
 *
 * This module is written independently of the encoder (the bench reference generator): it shares
 * only the protocol DATA (`_holloway-table.ts`), never the encoder's algorithm, so a bug in one is
 * not mirrored in the other. Pure: text in, decoded message out, no state and no I/O.
 */
import { ALPHABET6, hollowayReverse, hollowayTable } from './_holloway-table';

export interface HollowayResult {
  /** The recovered secret: one ALPHABET6 character per complete 6-bit group. */
  message: string;
  /** Total number of bits the carriers contributed to the stream. */
  bits: number;
  /** Carriers that are a homoglyph letter (a non-original, non-space alternative glyph). */
  homoglyphs: number;
  /** Carriers that are one of the special Unicode space variants. */
  specialSpaces: number;
}

/**
 * Decode a Holloway homoglyph message. Returns null when the text has no homoglyph or special-space
 * carrier at all (a plain cover encodes nothing: its ASCII characters all carry the value 0, which
 * would read back as a run of spaces, so reporting it would be noise).
 */
export function decodeHolloway(text: string): HollowayResult | null {
  const table = hollowayTable();
  const reverse = hollowayReverse(table);
  const bitsOf = new Map<string, number>();
  for (const [base, v] of table) bitsOf.set(base, v.bits);

  let homoglyphs = 0;
  let specialSpaces = 0;
  let message = '';
  let total = 0;
  // A small sliding bit accumulator (always fewer than six leftover bits after each flush), so the
  // whole stream is never materialised: works in constant memory over a megabyte of cover text.
  let acc = 0;
  let pending = 0;

  for (const ch of text) {
    const entry = reverse.get(ch.codePointAt(0)!);
    if (entry === undefined) continue;
    const bits = bitsOf.get(entry.base)!;
    acc = (acc << bits) | (entry.value & ((1 << bits) - 1));
    pending += bits;
    total += bits;
    if (entry.value !== 0) {
      if (entry.base === ' ') specialSpaces++;
      else homoglyphs++;
    }
    while (pending >= 6) {
      const index = (acc >> (pending - 6)) & 0x3f;
      message += ALPHABET6[index] ?? '�';
      pending -= 6;
    }
    acc &= (1 << pending) - 1; // drop the bits already read, keep the stream bounded
  }

  if (homoglyphs + specialSpaces === 0) return null;
  return { message, bits: total, homoglyphs, specialSpaces };
}

/**
 * Whether a recovered message reads as natural text rather than the junk a few incidental lookalikes
 * (a phishing domain, a stray fullwidth letter) decode to. Deliberately strict: several words, mostly
 * letters, and ordinary word lengths — enough to tell a real hidden sentence from chance.
 */
export function hollowayReadable(message: string): boolean {
  const s = message.replace(/\s+$/, '');
  if (s.length < 12) return false;
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return false;
  const letters = (s.match(/[a-z]/g) ?? []).length;
  if (letters / s.length < 0.6) return false;
  const avg = tokens.reduce((sum, t) => sum + t.length, 0) / tokens.length;
  return avg >= 2 && avg <= 12;
}
