/** Pieces shared by the interpreters behind the "esolang" tool. */
import { toolT } from '../../i18n/tool-text';

const T = toolT('esolang');

export type Language =
  | 'brainfuck'
  | 'ook'
  | 'short-ook'
  | 'blub'
  | 'pikalang'
  | 'alphuck'
  | 'reversefuck'
  | 'cow'
  | 'deadfish'
  | 'xkcd-deadfish'
  | 'befunge'
  | 'malbolge'
  | 'malbolge-normalized';

export const LANGUAGE_NAME: Record<Language, string> = {
  brainfuck: 'Brainfuck',
  ook: 'Ook!',
  'short-ook': 'Short Ook',
  blub: 'Blub',
  pikalang: 'Pikalang',
  alphuck: 'Alphuck',
  reversefuck: 'ReverseFuck',
  cow: 'COW',
  deadfish: 'Deadfish',
  'xkcd-deadfish': 'XKCD Deadfish',
  befunge: 'Befunge-93',
  malbolge: 'Malbolge',
  'malbolge-normalized': 'Malbolge (normalised)',
};

/** Display name of a language (the normalised Malbolge spelling has a translated qualifier). */
export const languageName = (language: Language): string =>
  language === 'malbolge-normalized' ? T('value.malbolgeNormalised') : LANGUAGE_NAME[language];

/** Output is capped so that a program printing forever cannot exhaust memory. */
export const OUTPUT_MAX = 8 << 20;

/** 1234567 -> "1 234 567" (locale independent, so the output is deterministic). */
export const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function lineCol(src: string, offset: number): string {
  const before = src.slice(0, offset);
  const line = before.split('\n').length;
  const col = offset - before.lastIndexOf('\n');
  return T('text.lineCol', { line, col });
}

export interface RunResult {
  output: Uint8Array;
  /** Instructions executed (Brainfuck: source instructions, even though runs are folded). */
  steps: number;
  /** 'error' means the program died on something the language does not allow; see `notes`. */
  stopped: 'finished' | 'step-limit' | 'output-limit' | 'error';
  /** Things worth telling the user: why a run died, or oddities that happened on the way. */
  notes?: string[];
}

/** A growing byte buffer that refuses to grow past OUTPUT_MAX. */
export class ByteSink {
  private buf = new Uint8Array(256);
  length = 0;

  /** Appends the low 8 bits of `b`. Returns false (and drops the byte) once the cap is reached. */
  push(b: number): boolean {
    if (this.length >= OUTPUT_MAX) return false;
    if (this.length === this.buf.length) {
      const grown = new Uint8Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.length++] = b;
    return true;
  }

  /** Appends an ASCII string. Returns false if the cap was reached on the way. */
  pushAscii(s: string): boolean {
    for (let i = 0; i < s.length; i++) if (!this.push(s.charCodeAt(i))) return false;
    return true;
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** The "Program input" option, read byte by byte or number by number. */
export class InputStream {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  /** The next byte, or -1 once the input is used up. */
  next(): number {
    return this.pos < this.bytes.length ? this.bytes[this.pos++]! : -1;
  }

  /**
   * The next decimal integer ("-12", "7"): any bytes before it are skipped. Null when no number
   * is left. Values wrap to 32 bits, like the programs' own arithmetic.
   */
  nextInt(): number | null {
    const b = this.bytes;
    const isDigit = (i: number) => i < b.length && b[i]! >= 48 && b[i]! <= 57;
    let i = this.pos;
    while (i < b.length && !isDigit(i) && !(b[i] === 45 && isDigit(i + 1))) i++;
    if (i >= b.length) {
      this.pos = b.length;
      return null;
    }
    const negative = b[i] === 45;
    if (negative) i++;
    let value = 0;
    for (; isDigit(i); i++) value = (value * 10 + (b[i]! - 48)) >>> 0;
    this.pos = i;
    return negative ? -value | 0 : value | 0;
  }
}

/** mulberry32: a tiny seeded generator, so "random" programs give the same output every run. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
