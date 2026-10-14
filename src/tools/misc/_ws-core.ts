/**
 * Whitespace (the esolang, v0.3): instruction table, token helpers and the parser.
 *
 * A program is written with three tokens: Space (S), Tab (T) and Line feed (L). Everything else
 * is a comment. Internally a program is a string of the letters S, T and L ("code").
 */

export type ArgKind = 'none' | 'number' | 'label';

export interface OpDef {
  /** Mnemonic used by the disassembler and the assembler. */
  name: string;
  /** Instruction modification parameter + command, as S/T/L letters. */
  code: string;
  arg: ArgKind;
  /** Values popped from the stack (checked before running the instruction). */
  pops: number;
  summary: string;
}

/** Every Whitespace 0.3 instruction. The codes form a prefix-free set. */
export const OPS: readonly OpDef[] = [
  { name: 'push', code: 'SS', arg: 'number', pops: 0, summary: 'push n' },
  { name: 'dup', code: 'SLS', arg: 'none', pops: 1, summary: 'duplicate the top' },
  { name: 'copy', code: 'STS', arg: 'number', pops: 0, summary: 'copy the n-th item (0 = top)' },
  { name: 'swap', code: 'SLT', arg: 'none', pops: 2, summary: 'swap the top two' },
  { name: 'drop', code: 'SLL', arg: 'none', pops: 1, summary: 'discard the top' },
  { name: 'slide', code: 'STL', arg: 'number', pops: 1, summary: 'remove n items under the top' },
  { name: 'add', code: 'TSSS', arg: 'none', pops: 2, summary: 'a + b' },
  { name: 'sub', code: 'TSST', arg: 'none', pops: 2, summary: 'a - b' },
  { name: 'mul', code: 'TSSL', arg: 'none', pops: 2, summary: 'a * b' },
  { name: 'div', code: 'TSTS', arg: 'none', pops: 2, summary: 'a div b (floor)' },
  { name: 'mod', code: 'TSTT', arg: 'none', pops: 2, summary: 'a mod b (sign of b)' },
  { name: 'store', code: 'TTS', arg: 'none', pops: 2, summary: 'heap[address] = value' },
  { name: 'retrieve', code: 'TTT', arg: 'none', pops: 1, summary: 'push heap[address]' },
  { name: 'label', code: 'LSS', arg: 'label', pops: 0, summary: 'mark a location' },
  { name: 'call', code: 'LST', arg: 'label', pops: 0, summary: 'call a subroutine' },
  { name: 'jump', code: 'LSL', arg: 'label', pops: 0, summary: 'jump' },
  { name: 'jz', code: 'LTS', arg: 'label', pops: 1, summary: 'jump if the popped value is 0' },
  { name: 'jn', code: 'LTT', arg: 'label', pops: 1, summary: 'jump if the popped value < 0' },
  { name: 'ret', code: 'LTL', arg: 'none', pops: 0, summary: 'return from a subroutine' },
  { name: 'end', code: 'LLL', arg: 'none', pops: 0, summary: 'end the program' },
  { name: 'outchar', code: 'TLSS', arg: 'none', pops: 1, summary: 'print a character' },
  { name: 'outnum', code: 'TLST', arg: 'none', pops: 1, summary: 'print a number' },
  { name: 'readchar', code: 'TLTS', arg: 'none', pops: 1, summary: 'read a character' },
  { name: 'readnum', code: 'TLTT', arg: 'none', pops: 1, summary: 'read a number (one line)' },
];

export const OP_BY_NAME: ReadonlyMap<string, OpDef> = new Map(OPS.map((o) => [o.name, o]));
const OP_BY_CODE: ReadonlyMap<string, OpDef> = new Map(OPS.map((o) => [o.code, o]));

export interface Instr {
  op: OpDef;
  /** Number argument (push, copy, slide). */
  num?: bigint;
  /** Label argument as S/T letters (label, call, jump, jz, jn). May be empty. */
  label?: string;
  /** Offset of the first token in the code. */
  start: number;
  /** The instruction's tokens, e.g. "SSSTSSSTTSL". */
  raw: string;
}

export interface ParseTail {
  /** Offset in the code of the first token that is not part of a complete instruction. */
  start: number;
  /** The leftover tokens. */
  raw: string;
  /** Why parsing stopped there, as a sentence fragment ("unterminated number"). */
  reason: string;
  /**
   * 'partial': the code ends before an instruction code is complete (a lone L, "TL"...), usually
   * the final line break of a file. 'unterminated': an instruction whose number or label has no
   * terminating L. 'invalid': a sequence that is not an instruction.
   */
  kind: 'partial' | 'unterminated' | 'invalid';
  /** True when the code simply ends in the middle of an instruction (vs an invalid sequence). */
  incomplete: boolean;
}

export interface Parsed {
  code: string;
  instrs: Instr[];
  /** Set when parsing stopped before the end of the code. */
  tail?: ParseTail;
}

/** ' ' -> S, '\t' -> T, '\n' -> L; every other character is a comment and dropped. */
export function toLetters(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === ' ') out += 'S';
    else if (ch === '\t') out += 'T';
    else if (ch === '\n') out += 'L';
  }
  return out;
}

/** S/T/L letters -> real Whitespace characters (other characters are dropped). */
export function toWhitespace(code: string): string {
  let out = '';
  for (const ch of code) {
    if (ch === 'S') out += ' ';
    else if (ch === 'T') out += '\t';
    else if (ch === 'L') out += '\n';
  }
  return out;
}

/** Canonical encoding of a number: sign, binary digits (most significant first), L. */
export function encodeNumber(n: bigint): string {
  const neg = n < 0n;
  const bits = (neg ? -n : n).toString(2).replace(/0/g, 'S').replace(/1/g, 'T');
  return `${neg ? 'T' : 'S'}${bits}L`;
}

/** Decode the letters of a number (without its terminating L). Empty = 0, sign only = 0. */
export function decodeNumber(letters: string): bigint {
  if (letters.length <= 1) return 0n;
  const bits = letters.slice(1).replace(/S/g, '0').replace(/T/g, '1');
  const v = BigInt(`0b${bits}`);
  return letters[0] === 'T' ? -v : v;
}

/** True if `fragment` is the beginning of some instruction code (e.g. "TL" or "LS"). */
function isOpPrefix(fragment: string): boolean {
  return OPS.some((o) => o.code.startsWith(fragment));
}

const SPELLED: Record<string, string> = { S: 'space', T: 'tab', L: 'line feed' };

/** "STT" -> "space, tab, tab". */
export const spell = (letters: string) => Array.from(letters, (c) => SPELLED[c] ?? c).join(', ');

/** Why the code cannot be parsed at `rest` (which does not start with an instruction code). */
function badTail(start: number, rest: string): ParseTail {
  // Longest beginning of `rest` that still begins some instruction code.
  let k = 1;
  while (k < rest.length && isOpPrefix(rest.slice(0, k + 1))) k++;
  if (k >= rest.length) {
    return {
      start,
      raw: rest,
      reason: `the code ends in the middle of an instruction (${rest})`,
      kind: 'partial',
      incomplete: true,
    };
  }
  const seq = rest.slice(0, k + 1);
  return {
    start,
    raw: rest,
    reason: `${seq} (${spell(seq)}) is not a Whitespace instruction`,
    kind: 'invalid',
    incomplete: false,
  };
}

/**
 * Parse a program (S/T/L letters). Parsing stops at the first invalid or unfinished instruction:
 * what came before is kept and the rest is reported in `tail`, so a program whose garbage is
 * never reached still runs (like the lazy reference interpreter).
 */
export function parse(code: string): Parsed {
  const instrs: Instr[] = [];
  let p = 0;
  while (p < code.length) {
    let op: OpDef | undefined;
    for (let len = 2; len <= 4 && !op; len++) op = OP_BY_CODE.get(code.slice(p, p + len));
    if (!op) return { code, instrs, tail: badTail(p, code.slice(p)) };
    const start = p;
    p += op.code.length;
    if (op.arg === 'none') {
      instrs.push({ op, start, raw: op.code });
      continue;
    }
    const lf = code.indexOf('L', p);
    if (lf < 0) {
      return {
        code,
        instrs,
        tail: {
          start,
          raw: code.slice(start),
          reason: `unterminated ${op.arg} after ${op.name} (no line feed ends it)`,
          kind: 'unterminated',
          incomplete: true,
        },
      };
    }
    const letters = code.slice(p, lf);
    p = lf + 1;
    const raw = code.slice(start, p);
    if (op.arg === 'number') instrs.push({ op, num: decodeNumber(letters), start, raw });
    else instrs.push({ op, label: letters, start, raw });
  }
  return { code, instrs };
}

/** "S"/"T"/"L" letter counts of a code string. */
export function tokenCounts(code: string): { s: number; t: number; l: number } {
  let s = 0;
  let t = 0;
  let l = 0;
  for (const ch of code) {
    if (ch === 'S') s++;
    else if (ch === 'T') t++;
    else if (ch === 'L') l++;
  }
  return { s, t, l };
}

const CHAR_ESCAPES: Record<number, string> = { 9: '\\t', 10: '\\n', 13: '\\r' };

/** A visible character of any script: letter, digit, punctuation or symbol (emoji included). */
const VISIBLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
/** Invisible but meaningful: format characters (zero width, BOM, bidi) and the odd spaces. */
const INVISIBLE = /^[\p{Cf}\p{Zs}\p{Zl}\p{Zp}]$/u;

/**
 * The character literal of a code point, as the assembler reads it: 'F', 'é', '😀', '\n', '\t',
 * '\r', or an escape '\u{200B}' for invisible characters (zero width, BOM, NBSP...). Null for
 * other controls (0 is usually an address or a terminator), unassigned and private-use values.
 */
export function charLiteral(n: bigint): string | null {
  if (n < 0n || n > 0x10ffffn) return null;
  const cp = Number(n);
  const esc = CHAR_ESCAPES[cp];
  if (esc) return `'${esc}'`;
  if (cp === 0x27 || cp === 0x5c) return `'\\${String.fromCodePoint(cp)}'`;
  if (cp >= 0xd800 && cp < 0xe000) return null;
  const ch = String.fromCodePoint(cp);
  if (cp === 0x20 || (VISIBLE.test(ch) && cp !== 0xfffd)) return `'${ch}'`;
  if (cp >= 0xa0 && INVISIBLE.test(ch)) return `'\\u{${cp.toString(16).toUpperCase()}}'`;
  return null;
}

/** 1234567 -> "1 234 567" (locale independent, so the output is deterministic). */
export const grouped = (n: number | bigint) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
