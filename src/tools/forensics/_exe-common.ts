/**
 * Checks every executable format shares: the UPX marker, and what sits after the last byte the
 * headers account for (the overlay of a PE, data appended to an ELF).
 */
import { indexOfBytes, printableRatio, toHex } from '../../lib/bytes';
import { identify } from '../../lib/signatures';
import { Reader, latin1, regionEntropy, visible, type Budget } from './_exe-bin';
import type { Trailing } from './_exe-types';

const UPX = [0x55, 0x50, 0x58, 0x21]; // "UPX!"
const UPX_SCAN = 32 << 20;
const CHUNK = 1 << 20;

/** Does the file contain the "UPX!" marker UPX leaves in what it packs? (First 32 MiB.) */
export async function upxMarker(r: Reader): Promise<boolean> {
  const end = Math.min(r.size, UPX_SCAN);
  for (let p = 0; p < end; p += CHUNK - 3) {
    const chunk = await r.file.read(p, Math.min(CHUNK, end - p));
    if (indexOfBytes(chunk, UPX) >= 0) return true;
    if (p + chunk.length >= end) break;
  }
  return false;
}

/** Describe the bytes [offset, offset + size) that no header accounts for. */
export async function trailingInfo(
  r: Reader,
  offset: number,
  size: number,
  budget: Budget,
): Promise<Trailing> {
  const head = await r.read(offset, Math.min(size, 4096));
  const best = identify(head).find((s) => !s.weak);
  const textual = head.length > 0 && printableRatio(head.subarray(0, 256)) > 0.9;
  return {
    offset,
    size,
    magic: best ? { id: best.id, name: best.name } : null,
    text: textual ? visible(latin1(head.subarray(0, 256)).replace(/[\0\r\n]+$/, ''), 256) : null,
    head: toHex(head.subarray(0, 16), ' '),
    entropy: await regionEntropy(r, offset, Math.min(size, CHUNK), budget),
  };
}
