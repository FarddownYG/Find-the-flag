import { Gunzip, Inflate, Unzlib } from 'fflate';
import { concatBytes } from '../../lib/bytes';

export type InflateKind = 'gzip' | 'zlib' | 'raw';

/** Decompressed output above this size is refused (zip-bomb guard). */
export const INFLATE_CAP = 4 * 1024 * 1024;
/** Input is fed in small slices so that a bomb is noticed after a few hundred KB, not GB. */
const STEP = 512;

export const isGzip = (b: Uint8Array): boolean => b.length > 18 && b[0] === 0x1f && b[1] === 0x8b;

/** zlib header: deflate method, valid FCHECK, no preset dictionary. */
export const isZlib = (b: Uint8Array): boolean =>
  b.length > 6 && (b[0]! & 0x0f) === 8 && ((b[0]! << 8) | b[1]!) % 31 === 0 && (b[1]! & 0x20) === 0;

/**
 * gzip / zlib / raw deflate decompression with an output cap.
 * Returns null for corrupt, truncated, empty or oversized data (never throws).
 */
export function inflateCapped(
  data: Uint8Array,
  kind: InflateKind,
  cap = INFLATE_CAP,
): Uint8Array | null {
  if (!data.length) return null;
  const parts: Uint8Array[] = [];
  let total = 0;
  const onData = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > cap) throw new RangeError('decompressed data too large');
    parts.push(chunk);
  };
  try {
    const stream =
      kind === 'gzip'
        ? new Gunzip(onData)
        : kind === 'zlib'
          ? new Unzlib(onData)
          : new Inflate(onData);
    for (let i = 0; i < data.length; i += STEP) {
      stream.push(data.subarray(i, i + STEP), i + STEP >= data.length);
    }
  } catch {
    return null;
  }
  return total ? concatBytes(...parts) : null;
}
