/**
 * "Does this extracted bit stream look like something?" shared by the image LSB tool and the
 * audio one: a flag, a file (magic bytes), a length-prefixed text, readable text, or a readable
 * stretch after a short header. Pure functions on bytes; the callers word the result.
 */
import { latin1Decode, u32be, u32le } from '../../lib/bytes';
import { identify, type Signature } from '../../lib/signatures';

/** Stricter than the shell's flag pattern: random noise must not look like prefix{...}. */
export const FLAG_RE = /[A-Za-z][A-Za-z0-9_-]{2,24}\{[\x21-\x7a|~]{4,200}\}/;

export const isPrintable = (b: number): boolean =>
  (b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13;

/** Length of the printable ASCII run that starts at `from`. */
export function printableRun(b: Uint8Array, from = 0): number {
  let n = 0;
  while (from + n < b.length && isPrintable(b[from + n]!)) n++;
  return n;
}

/** The first bytes as text, anything unreadable shown as a dot. */
export const preview = (b: Uint8Array, max = 64): string =>
  latin1Decode(b.subarray(0, max)).replace(/[^\x20-\x7e]/g, '·');

/** A signature with at least three fixed magic bytes: a real file, not a coincidence. */
export const strongSignature = (b: Uint8Array): Signature | undefined =>
  identify(b).find((s) => !s.weak && s.magic.filter((m) => m !== null).length >= 3);

export type StreamKind = 'flag' | 'file' | 'prefixed' | 'text' | 'inner';

/** Better kinds first: a flag beats a file beats a length-prefixed text beats plain text. */
export const KIND_TIER: Record<StreamKind, number> = {
  flag: 5,
  file: 4,
  prefixed: 3,
  text: 2,
  inner: 1,
};

export interface StreamHit {
  kind: StreamKind;
  /** Larger is better within a kind. */
  score: number;
  /** Where the interesting data starts in the stream. */
  start: number;
  /** flag: offset of the flag. */
  flagAt?: number;
  /** file: the signature of the file at offset 0. */
  sig?: Signature;
  /** prefixed: the length the 32-bit prefix announces, and its byte order. */
  length?: number;
  little?: boolean;
  /** text and inner: length of the readable run. */
  count?: number;
}

/** Decide whether an extracted prefix looks like something: file, flag, or readable text. */
export function classifyStream(b: Uint8Array): StreamHit | null {
  if (b.length < 6) return null;
  let min = 255;
  let max = 0;
  for (const x of b) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (min === max) return null; // a constant plane carries no message

  const run = printableRun(b);
  const flagAt = latin1Decode(b).search(FLAG_RE);
  if (flagAt >= 0) {
    return { kind: 'flag', score: (flagAt === 0 ? 10000 : 0) + run, start: flagAt, flagAt };
  }
  const sig = strongSignature(b);
  if (sig) return { kind: 'file', score: sig.magic.length, start: 0, sig };
  for (const little of [false, true]) {
    const len = little ? u32le(b, 0) : u32be(b, 0);
    const payload = b.subarray(4);
    if (
      len >= 6 &&
      len <= 0x1000000 &&
      printableRun(payload) >= Math.min(len, 6) &&
      printableRun(payload) >= 6
    ) {
      return { kind: 'prefixed', score: Math.min(len, run), start: 4, length: len, little };
    }
  }
  const distinct = new Set(b.subarray(0, run)).size;
  if (run >= 6 && distinct >= 3) return { kind: 'text', score: run, start: 0, count: run };
  // A long readable stretch after a short header or padding.
  let i = 0;
  while (i < b.length) {
    const r = printableRun(b, i);
    if (r >= 24 && new Set(b.subarray(i, i + r)).size >= 6) {
      return { kind: 'inner', score: r, start: i, count: r };
    }
    i += Math.max(1, r);
  }
  return null;
}
