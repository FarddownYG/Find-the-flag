/**
 * Reference encoder for Holloway-style homoglyph steganography. Used only to generate test
 * challenges for the bench. Written from the protocol spec; depends only on the shared table.
 */
import { ALPHABET6, hollowayTable } from '../../src/tools/stego/_holloway-table';

/** Bits carried by one cover character (0 if it is not in the table). */
function bitsOf(table: ReturnType<typeof hollowayTable>, ch: string): number {
  return table.get(ch)?.bits ?? 0;
}

/** Total number of bits the cover can carry. */
export function capacityBits(cover: string): number {
  const table = hollowayTable();
  let total = 0;
  for (const ch of cover) total += bitsOf(table, ch);
  return total;
}

/** Secret -> bitstream (6 bits per char, MSB first). Throws on characters outside ALPHABET6. */
export function secretToBits(secret: string): number[] {
  const bits: number[] = [];
  for (const ch of secret.toLowerCase()) {
    const idx = ALPHABET6.indexOf(ch);
    if (idx < 0) throw new Error(`Secret character not in ALPHABET6: ${JSON.stringify(ch)}`);
    for (let b = 5; b >= 0; b--) bits.push((idx >> b) & 1);
  }
  return bits;
}

/** Embed `secret` into `cover` using homoglyph substitution. Throws if the cover is too short. */
export function encodeHolloway(cover: string, secret: string): string {
  const bits = secretToBits(secret);
  const capacity = capacityBits(cover);
  if (bits.length > capacity) {
    throw new Error(`Cover too short: need ${bits.length} bits, capacity is ${capacity}`);
  }
  const table = hollowayTable();
  let pos = 0;
  let out = '';
  for (const ch of cover) {
    const entry = table.get(ch);
    if (!entry) {
      out += ch;
      continue;
    }
    let v = 0;
    for (let k = 0; k < entry.bits; k++) v = (v << 1) | (bits[pos + k] ?? 0);
    pos += entry.bits;
    const cp = v === 0 ? undefined : entry.alts[v - 1];
    out += cp === undefined ? entry.base : String.fromCodePoint(cp);
  }
  return out;
}
