/**
 * When is a decoding readable? Shared by the invisible-character and the homoglyph channels of
 * "Hidden Unicode text".
 *
 * The readability score of the zero-width tool ranks readings well, but it hardly tells a short
 * message from random printable bytes (any 8 printable characters score 55 to 85), and a text
 * reading tries a couple of dozen framings, so one of them is printable by chance now and then.
 * So a reading is only called readable when it is clean text (no control character, no
 * replacement character) and carries enough evidence: each character is worth the bits by which
 * it beats noise. Noise is a unit drawn at random from `values` possibilities (256 for a byte,
 * 128 for a 7-bit character, 65536 for a 16-bit one); a printable ASCII character is one of 95
 * of them (log2(values / 95) bits), and letters, digits and spaces earn half a bit more since
 * messages are made of them. No single character counts for more than 3.5 bits, so that one lucky
 * character among noise never makes a message. Tag characters need no evidence: they cannot
 * appear by accident and decode exactly. A reading of an unlisted kind needs more evidence than
 * one of a known scheme, and every doubling of the number of orderings tried (`tries`: 6 for
 * three symbols, 24 for four) costs one more bit, since the best of many tries is picked.
 */
import { isValidUtf8, utf8Decode } from '../../lib/bytes';

export type Strength = 'tags' | 'specific' | 'generic';

/** What one character can add to the evidence. */
const MAX_CHAR_BITS = 3.5;

/**
 * Evidence, in bits, that a decoded text is a message and not noise; 0 when it is not clean text.
 * `values` is the number of values one decoded unit can take at random (256 for bytes).
 */
export function evidenceBits(text: string, values = 256): number {
  let bits = 0;
  const ascii = Math.log2(values / Math.min(95, values));
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 9 || cp === 10 || cp === 13) {
      bits += 0.5;
      continue;
    }
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0) || cp === 0xfffd) return 0;
    if (cp >= 0xd800 && cp <= 0xdfff) return 0;
    let own: number;
    if (cp < 0x80) {
      const plain = (cp | 0x20) >= 97 && (cp | 0x20) <= 122;
      own = ascii + (plain || (cp >= 48 && cp <= 57) || cp === 32 || cp === 95 ? 0.5 : 0);
    } else if (values <= 256) {
      // UTF-8 bytes: a valid two-byte sequence is rare in noise, a three-byte one rarer.
      own = cp < 0x800 ? 5 : cp < 0x10000 ? 8 : 11;
    } else if ((cp >= 0xa0 && cp <= 0x24f) || (cp >= 0x370 && cp <= 0x52f)) {
      own = Math.log2(values / 1100);
    } else own = 0.5; // CJK, Hangul and the like: noise lands there a third of the time
    bits += Math.min(MAX_CHAR_BITS, own);
  }
  return bits;
}

const NEEDED: Record<Strength, number> = { tags: 0, specific: 8, generic: 12 };

/**
 * A reading of at least two characters besides spaces that is clean text with enough evidence for
 * its kind.
 */
export function isReadable(text: string, strength: Strength, values = 256, tries = 1): boolean {
  if ([...text.replace(/\s/g, '')].length < 2) return false;
  const bits = evidenceBits(text, values);
  return bits > 0 && bits >= NEEDED[strength] + (strength === 'tags' ? 0 : Math.log2(tries));
}

// ---------- bits and bytes ----------

/** Bits packed MSB first, 8 per byte; the bits that do not fill a byte are dropped. */
export function packBits(bits: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | (bits[i * 8 + j]! & 1);
    out[i] = v;
  }
  return out;
}

/** Bytes without the plain carriers after the message (zero bytes, or 0xFF when inverted). */
export function trimTail(bytes: Uint8Array, fill: number): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === fill) end--;
  return bytes.subarray(0, end);
}

/** The text of some bytes, or null when they are not valid UTF-8. */
export const textOfBytes = (bytes: Uint8Array): string | null =>
  isValidUtf8(bytes) ? utf8Decode(bytes) : null;

/** "53 45 43" for bytes, cut after `max` bytes. */
export function hexPreview(bytes: Uint8Array, max: number): { text: string; more: number } {
  const shown = bytes.subarray(0, max);
  const text = Array.from(shown, (b) => b.toString(16).padStart(2, '0')).join(' ');
  return { text, more: Math.max(0, bytes.length - shown.length) };
}

/** "01010011 01000101" for bytes, cut after `max` bytes. */
export function bitsPreview(bytes: Uint8Array, max: number): { text: string; more: number } {
  const shown = bytes.subarray(0, max);
  const text = Array.from(shown, (b) => b.toString(2).padStart(8, '0')).join(' ');
  return { text, more: Math.max(0, bytes.length - shown.length) };
}
