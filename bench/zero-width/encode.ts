// Independent zero-width binary encoder, written from the public scheme description:
// secret -> UTF-8 bytes -> bits (MSB first); 0 = U+200B (ZWSP), 1 = U+200C (ZWNJ);
// U+200D (ZWJ) optionally separates bytes. The run is placed in a visible cover sentence.
const ZERO = '​';
const ONE = '‌';
const SEP = '‍';

export type Placement = 'after' | 'before' | 'inside' | 'spread';

export interface Options {
  /** insert U+200D between bytes */
  separator?: boolean;
  placement?: Placement;
}

export function bitsOf(secret: string): string[] {
  const bytes = new TextEncoder().encode(secret);
  return Array.from(bytes, (b) =>
    Array.from({ length: 8 }, (_, i) => ((b >> (7 - i)) & 1 ? ONE : ZERO)).join(''),
  );
}

export function zeroWidthRun(secret: string, separator: boolean): string {
  return bitsOf(secret).join(separator ? SEP : '');
}

export function encodeZeroWidth(cover: string, secret: string, opts: Options = {}): string {
  const { separator = false, placement = 'after' } = opts;
  const run = zeroWidthRun(secret, separator);
  if (placement === 'before') return run + cover;
  if (placement === 'after') return cover + run;
  if (placement === 'inside') {
    // whole run hidden right after the first word
    const i = cover.indexOf(' ');
    const at = i < 0 ? cover.length : i;
    return cover.slice(0, at) + run + cover.slice(at);
  }
  // spread: one byte-chunk after each of the first visible characters
  const chunks = bitsOf(secret);
  const chars = Array.from(cover);
  if (chars.length < chunks.length) throw new Error('cover too short to spread the secret');
  return chars
    .map((c, i) =>
      i < chunks.length ? c + chunks[i] + (separator && i < chunks.length - 1 ? SEP : '') : c,
    )
    .join('');
}
