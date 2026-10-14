import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import {
  ByteSink,
  grouped,
  InputStream,
  languageName,
  lineCol,
  type RunResult,
} from './_esolang-common';

const T = toolT('esolang');

/**
 * Malbolge (Ben Olmstead, 1998), the standard machine:
 *
 *  - memory: 59049 (3^10) words of 10 trits, each 0..59048; registers A, C, D start at 0;
 *  - the program is loaded at address 0, whitespace skipped; every loaded character must be an
 *    instruction at its own position: ((character + address) mod 94) has to be one of the eight
 *    values below (that is the "normalised program" rule: the same character means different
 *    things at different addresses). The rest of memory is filled with
 *    mem[i] = crazy(mem[i-1], mem[i-2]);
 *  - one step: the word at C must be a printable character (33..126); the instruction is
 *    (word + C) mod 94; after it, the word at C (C may just have been changed by a jump) is
 *    replaced through the encryption table, then C and D each go up by one (mod 59049).
 *
 *     4 j/i  jmp     C = mem[D]
 *     5  <   out     print A as a byte
 *    23  /   in      A = next input byte, or 59048 at the end of the input
 *    39  *   rotr    A = mem[D] = mem[D] rotated one trit to the right
 *    40  j   movd    D = mem[D]
 *    62  p   crz     A = mem[D] = crazy(A, mem[D])
 *    68  o   nop
 *    81  v   end     stop
 *  every other value is a no-op as well.
 */
export const MALBOLGE_SIZE = 59049;

/** Instruction value -> the mnemonic used when writing a program in "normalised" form. */
const MNEMONIC = new Map<number, string>([
  [4, 'i'],
  [5, '<'],
  [23, '/'],
  [39, '*'],
  [40, 'j'],
  [62, 'p'],
  [68, 'o'],
  [81, 'v'],
]);
const VALUE_OF = new Map<string, number>([...MNEMONIC].map(([value, ch]) => [ch, value]));

/** Characters 33..126 -> what they turn into after being executed. */
const ENCRYPTION =
  '5z]&gqtyfr$(we4{WP)H-Zn,[%\\3dL+Q;>U!pJS72FhOA1CB6v^=I_0/8|jsb9m<.TVac`uY*MK\'X~xDl}REokN:#?G"i@';

/** Tritwise "crazy" operation on one trit of A (column) and one of D (row). */
const CRAZY_TRIT = [
  [1, 0, 0],
  [1, 0, 2],
  [2, 2, 1],
] as const;

let crazyHalf: Uint8Array | null = null;
/** crazy on two 5-trit halves (243 x 243 entries), so a full 10-trit crazy is two lookups. */
function halfTable(): Uint8Array {
  if (crazyHalf) return crazyHalf;
  const table = new Uint8Array(243 * 243);
  for (let a = 0; a < 243; a++) {
    for (let d = 0; d < 243; d++) {
      let result = 0;
      let weight = 1;
      for (let i = 0, ra = a, rd = d; i < 5; i++, ra = (ra / 3) | 0, rd = (rd / 3) | 0) {
        result += CRAZY_TRIT[rd % 3]![ra % 3]! * weight;
        weight *= 3;
      }
      table[a * 243 + d] = result;
    }
  }
  crazyHalf = table;
  return table;
}

/** The "crazy" operation: tritwise, on 10-trit words. */
export function crazy(a: number, d: number): number {
  const t = halfTable();
  const lo = t[(a % 243) * 243 + (d % 243)]!;
  const hi = t[Math.floor(a / 243) * 243 + Math.floor(d / 243)]!;
  return lo + hi * 243;
}

/** One trit to the right, the trit that falls off coming back in on the left. */
export function rotr(v: number): number {
  return Math.floor(v / 3) + (v % 3) * 19683;
}

/** The encrypted form of a word that was just executed (33..126 only). */
export function encrypt(word: number): number {
  return ENCRYPTION.charCodeAt(word - 33);
}

const mod = (n: number, m: number) => ((n % m) + m) % m;
const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/** Normalised form -> real program. Each mnemonic (i < / * j p o v) becomes the character that means it at its address. */
export function denormaliseMalbolge(src: string): string {
  let out = '';
  let address = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (isSpace(ch)) continue;
    const value = VALUE_OF.get(ch);
    if (value === undefined) {
      throw new ToolError(T('error.malbolgeNotOp', { ch, where: lineCol(src, i) }));
    }
    out += String.fromCharCode(33 + mod(value - 33 - address, 94));
    address++;
  }
  return out;
}

/** Real program -> normalised form (what each character does at its address). Invalid ones become "?". */
export function normaliseMalbolge(src: string): string {
  let out = '';
  let address = 0;
  for (const ch of src) {
    if (isSpace(ch)) continue;
    out += MNEMONIC.get((ch.charCodeAt(0) + address) % 94) ?? '?';
    address++;
  }
  return out;
}

/**
 * Load a real Malbolge program into memory (and fill the rest). Throws a ToolError naming the
 * first character that breaks the normalised-program rule.
 */
export function loadMalbolge(src: string): Uint16Array {
  const mem = new Uint16Array(MALBOLGE_SIZE);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (isSpace(ch)) continue;
    const code = src.charCodeAt(i);
    if (code < 33 || code > 126) {
      throw new ToolError(
        T('error.malbolgeNotPrintable', { ch: JSON.stringify(ch), where: lineCol(src, i) }),
      );
    }
    if (n >= MALBOLGE_SIZE) {
      throw new ToolError(T('error.malbolgeTooLong', { size: MALBOLGE_SIZE }));
    }
    if (!MNEMONIC.has((code + n) % 94)) {
      throw new ToolError(
        T('error.malbolgeInvalid', {
          ch,
          where: lineCol(src, i),
          n: n + 1,
          normalised: languageName('malbolge-normalized'),
        }),
      );
    }
    mem[n++] = code;
  }
  if (n < 2) throw new ToolError(T('error.malbolgeShort'));
  for (let i = n; i < MALBOLGE_SIZE; i++) mem[i] = crazy(mem[i - 1]!, mem[i - 2]!);
  return mem;
}

/** True if every non-blank character is a valid instruction at its position (and there are enough). */
export function isMalbolgeProgram(src: string, minLength = 8): boolean {
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (isSpace(ch)) continue;
    const code = src.charCodeAt(i);
    if (code < 33 || code > 126 || !MNEMONIC.has((code + n) % 94)) return false;
    n++;
  }
  return n >= minLength;
}

/** A program written only with the eight mnemonics, using several of them. */
export function isNormalisedMalbolge(src: string, minLength = 10): boolean {
  const seen = new Set<string>();
  let n = 0;
  for (const ch of src) {
    if (isSpace(ch)) continue;
    if (!VALUE_OF.has(ch)) return false;
    seen.add(ch);
    n++;
  }
  return n >= minLength && seen.size >= 4;
}

export function runMalbolge(
  src: string,
  input: Uint8Array,
  stepLimit: number,
  normalised: boolean,
): RunResult {
  const mem = loadMalbolge(normalised ? denormaliseMalbolge(src) : src);
  const stream = new InputStream(input);
  const sink = new ByteSink();
  let a = 0;
  let c = 0;
  let d = 0;
  let steps = 0;
  let stopped: RunResult['stopped'] = 'finished';
  const notes: string[] = [];

  const died = (why: string) => {
    stopped = 'error';
    notes.push(T('note.malbolgeDied', { steps: grouped(steps), why, c }));
  };

  for (;;) {
    if (steps >= stepLimit) {
      stopped = 'step-limit';
      break;
    }
    const word = mem[c]!;
    if (word < 33 || word > 126) {
      died(T('text.malbolgeNotInstruction', { word }));
      break;
    }
    steps++;
    const instruction = (word + c) % 94;
    if (instruction === 81) break; // end
    switch (instruction) {
      case 4: // jmp
        c = mem[d]!;
        break;
      case 5: // out
        if (!sink.push(a)) stopped = 'output-limit';
        break;
      case 23: {
        // in
        const b = stream.next();
        a = b < 0 ? MALBOLGE_SIZE - 1 : b;
        break;
      }
      case 39: // rotr
        a = mem[d] = rotr(mem[d]!);
        break;
      case 40: // movd
        d = mem[d]!;
        break;
      case 62: // crz
        a = mem[d] = crazy(a, mem[d]!);
        break;
      default: // 68 (nop) and every value that is no instruction
        break;
    }
    if (stopped === 'output-limit') break;
    const next = mem[c]!;
    if (next < 33 || next > 126) {
      died(T('text.malbolgeNoEncrypt', { word: next }));
      break;
    }
    mem[c] = encrypt(next);
    c = c === MALBOLGE_SIZE - 1 ? 0 : c + 1;
    d = d === MALBOLGE_SIZE - 1 ? 0 : d + 1;
  }
  return { output: sink.bytes(), steps, stopped, notes };
}
