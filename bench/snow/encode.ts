// Independent SNOW-style trailing-whitespace encoder, written from the public scheme description:
// secret -> UTF-8 bytes -> bit stream (MSB first), hidden as invisible spaces/tabs at the end of the
// lines of a multi-line cover text.
//  - 'groups3' (SNOW-compatible): every 3 bits become one tab-terminated group of 0-7 spaces
//    ("   \t" = 3 = 011). The stream is zero-padded to a multiple of 3 bits.
//  - 'binary': one character per bit, space = 0 and tab = 1.
const SPACE = ' ';
const TAB = '\t';

export type Mode = 'groups3' | 'binary';

export interface Options {
  mode?: Mode;
  /** line separator, default "\n" */
  eol?: string;
  /** groups3/binary: max characters per line (cover + whitespace); default unlimited */
  width?: number;
  /** bits (binary) or groups (groups3) per line when no width is given; default: spread evenly */
  perLine?: number;
  /** keep a trailing end-of-line after the last cover line */
  finalEol?: boolean;
}

export function bitString(secret: string): string {
  return Array.from(new TextEncoder().encode(secret), (b) => b.toString(2).padStart(8, '0')).join(
    '',
  );
}

/** Whitespace units, one per 3-bit group or per bit. */
export function units(secret: string, mode: Mode): string[] {
  const bits = bitString(secret);
  if (mode === 'binary') return Array.from(bits, (b) => (b === '1' ? TAB : SPACE));
  const padded = bits.padEnd(Math.ceil(bits.length / 3) * 3, '0');
  const out: string[] = [];
  for (let i = 0; i < padded.length; i += 3) {
    out.push(SPACE.repeat(parseInt(padded.slice(i, i + 3), 2)) + TAB);
  }
  return out;
}

export function encodeSnow(cover: string, secret: string, opts: Options = {}): string {
  const { mode = 'groups3', eol = '\n', width, perLine, finalEol = true } = opts;
  const lines = cover.split('\n');
  const queue = units(secret, mode);
  const out: string[] = [];
  let next = 0;
  const even = Math.ceil(queue.length / lines.length);
  for (const line of lines) {
    let tail = '';
    const cap = perLine ?? even;
    let n = 0;
    while (next < queue.length && n < cap) {
      const u = queue[next] as string;
      if (width !== undefined && line.length + tail.length + u.length > width) break;
      tail += u;
      next++;
      n++;
    }
    out.push(line + tail);
  }
  if (next < queue.length) throw new Error(`cover too short: ${queue.length - next} units left`);
  return out.join(eol) + (finalEol ? eol : '');
}
