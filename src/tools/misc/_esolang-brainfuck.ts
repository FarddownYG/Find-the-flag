import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { grouped, languageName, lineCol, OUTPUT_MAX, type RunResult } from './_esolang-common';

const T = toolT('esolang');

/**
 * Brainfuck and every dialect that is "just a renamed Brainfuck": they are all reduced to plain
 * Brainfuck instructions (toBrainfuck) and share one engine (compile + execute).
 */
export type BrainfuckLanguage =
  'brainfuck' | 'ook' | 'short-ook' | 'blub' | 'pikalang' | 'alphuck' | 'reversefuck';

/** Ook! and Blub words come in pairs; each pair is one Brainfuck instruction. */
const PAIR_TO_BF: Record<string, string> = {
  '.?': '>',
  '?.': '<',
  '..': '+',
  '!!': '-',
  '!.': '.',
  '.!': ',',
  '!?': '[',
  '?!': ']',
};
const BF_TO_PAIR: Record<string, string> = Object.fromEntries(
  Object.entries(PAIR_TO_BF).map(([pair, bf]) => [bf, pair]),
);
/** The word that carries the punctuation: "Ook." / "Blub?". */
const PAIR_WORD = { ook: 'Ook', blub: 'Blub' } as const;
const PAIR_WORD_PATTERN = {
  ook: /\bOok([.?!])/gi,
  blub: /\bBlub([.?!])/gi,
} as const;

/**
 * Pikalang: whitespace separated Pokémon cries. Looked up through a Map (user words!).
 * pi and ka are the cell arithmetic (+ and -), pipi and pichu move the pointer (> and <).
 */
const PIKA_TO_BF = new Map<string, string>([
  ['pipi', '>'],
  ['pichu', '<'],
  ['pi', '+'],
  ['ka', '-'],
  ['pikachu', '.'],
  ['pikapi', ','],
  ['pika', '['],
  ['chu', ']'],
]);
const BF_TO_PIKA = new Map<string, string>([...PIKA_TO_BF].map(([word, bf]) => [bf, word]));

/** How many words the text has, and how many of them are Pikalang instructions. */
export function pikalangWords(src: string): { words: number; known: number } {
  let words = 0;
  let known = 0;
  for (const m of src.matchAll(/[A-Za-z]+/g)) {
    words++;
    if (PIKA_TO_BF.has(m[0].toLowerCase())) known++;
  }
  return { words, known };
}

/**
 * Alphuck: single lowercase letters, every other character is a comment. The letters a c e i j o
 * p s stand for the Brainfuck commands > < + - . , [ ] in that order.
 */
const ALPHUCK_TO_BF: Record<string, string> = {
  a: '>',
  c: '<',
  e: '+',
  i: '-',
  j: '.',
  o: ',',
  p: '[',
  s: ']',
};
const BF_TO_ALPHUCK: Record<string, string> = Object.fromEntries(
  Object.entries(ALPHUCK_TO_BF).map(([letter, bf]) => [bf, letter]),
);

/** ReverseFuck: every Brainfuck symbol is replaced by its opposite (and so is its meaning). */
const REVERSE: Record<string, string> = {
  '+': '-',
  '-': '+',
  '>': '<',
  '<': '>',
  '.': ',',
  ',': '.',
  '[': ']',
  ']': '[',
};

/** COW spelling of the Brainfuck instructions (`,` needs two COW instructions). */
const BF_TO_COW: Record<string, string> = {
  '>': 'moO',
  '<': 'mOo',
  '+': 'MoO',
  '-': 'MOo',
  '.': 'Moo',
  ',': 'OOO Moo',
  '[': 'MOO',
  ']': 'moo',
};

const BF_CHARS = /[-+<>[\].,]/;

/**
 * Do the brackets of the text pair up? Read as Brainfuck ("[" opens) or, with `reversed`, as
 * ReverseFuck ("]" opens). At least one bracket is needed: no brackets says nothing.
 */
export function bracketsPair(src: string, reversed: boolean): boolean {
  const open = reversed ? ']' : '[';
  const close = reversed ? '[' : ']';
  let depth = 0;
  let seen = false;
  for (const ch of src) {
    if (ch === open) {
      depth++;
      seen = true;
    } else if (ch === close) {
      seen = true;
      if (--depth < 0) return false;
    }
  }
  return seen && depth === 0;
}

export interface Instructions {
  /** Brainfuck instruction characters only. */
  code: string;
  /** Offset in the source text of each instruction (for error messages). */
  at: number[];
}

/** Reduce a program in any supported dialect to plain Brainfuck instructions. */
export function toBrainfuck(src: string, language: BrainfuckLanguage): Instructions {
  const code: string[] = [];
  const at: number[] = [];
  const emit = (instruction: string, offset: number) => {
    code.push(instruction);
    at.push(offset);
  };

  if (language === 'brainfuck') {
    for (let i = 0; i < src.length; i++) if (BF_CHARS.test(src[i]!)) emit(src[i]!, i);
    return { code: code.join(''), at };
  }
  if (language === 'reversefuck') {
    for (let i = 0; i < src.length; i++) {
      const instruction = REVERSE[src[i]!];
      if (instruction !== undefined) emit(instruction, i);
    }
    return { code: code.join(''), at };
  }
  if (language === 'alphuck') {
    for (let i = 0; i < src.length; i++) {
      const instruction = ALPHUCK_TO_BF[src[i]!];
      if (instruction !== undefined) emit(instruction, i);
    }
    return { code: code.join(''), at };
  }
  if (language === 'pikalang') {
    for (const m of src.matchAll(/[A-Za-z]+/g)) {
      const instruction = PIKA_TO_BF.get(m[0].toLowerCase());
      if (instruction !== undefined) emit(instruction, m.index);
    }
    return { code: code.join(''), at };
  }

  const symbols: { ch: string; at: number }[] = [];
  if (language === 'ook' || language === 'blub') {
    for (const m of src.matchAll(PAIR_WORD_PATTERN[language])) {
      symbols.push({ ch: m[1]!, at: m.index });
    }
  } else {
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '.' || src[i] === '?' || src[i] === '!') symbols.push({ ch: src[i]!, at: i });
    }
  }
  if (symbols.length % 2 !== 0) {
    const last = symbols[symbols.length - 1]!;
    throw new ToolError(
      T('error.unpaired', { language: languageName(language), where: lineCol(src, last.at) }),
    );
  }
  for (let i = 0; i < symbols.length; i += 2) {
    const instruction = PAIR_TO_BF[symbols[i]!.ch + symbols[i + 1]!.ch];
    if (instruction === undefined) continue; // "Ook? Ook?" is not an instruction
    emit(instruction, symbols[i]!.at);
  }
  return { code: code.join(''), at };
}

const ADD = 0;
const MOVE = 1;
const OUT = 2;
const IN = 3;
const JZ = 4;
const JNZ = 5;

export interface Program {
  op: Uint8Array;
  arg: Int32Array;
  /** How many source instructions each op stands for (runs are folded into one op). */
  weight: Int32Array;
}

/** Fold runs of + - and < >, and resolve loop jumps. Throws on unbalanced brackets. */
export function compile(src: string, { code, at }: Instructions): Program {
  const op: number[] = [];
  const arg: number[] = [];
  const weight: number[] = [];
  const open: { op: number; at: number }[] = [];
  const push = (o: number, a: number, w: number) => {
    op.push(o);
    arg.push(a);
    weight.push(w);
  };
  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    if (ch === '+' || ch === '-') {
      let net = 0;
      const from = i;
      for (; i < code.length && (code[i] === '+' || code[i] === '-'); i++) {
        net += code[i] === '+' ? 1 : -1;
      }
      push(ADD, net, i - from);
    } else if (ch === '>' || ch === '<') {
      let net = 0;
      const from = i;
      for (; i < code.length && (code[i] === '>' || code[i] === '<'); i++) {
        net += code[i] === '>' ? 1 : -1;
      }
      push(MOVE, net, i - from);
    } else if (ch === '.') {
      push(OUT, 0, 1);
      i++;
    } else if (ch === ',') {
      push(IN, 0, 1);
      i++;
    } else if (ch === '[') {
      open.push({ op: op.length, at: at[i]! });
      push(JZ, 0, 1);
      i++;
    } else {
      const start = open.pop();
      if (!start) {
        throw new ToolError(T('error.unmatchedClose', { where: lineCol(src, at[i]!) }));
      }
      arg[start.op] = op.length + 1;
      push(JNZ, start.op + 1, 1);
      i++;
    }
  }
  const dangling = open.pop();
  if (dangling) {
    throw new ToolError(T('error.unmatchedOpen', { where: lineCol(src, dangling.at) }));
  }
  return {
    op: Uint8Array.from(op),
    arg: Int32Array.from(arg),
    weight: Int32Array.from(weight),
  };
}

const TAPE_START = 30_000;
const TAPE_MAX = 1 << 24;

/** Interpret a compiled program: 8-bit wrapping cells, tape growing to the right, EOF reads 0. */
export function execute(prog: Program, input: Uint8Array, stepLimit: number): RunResult {
  const { op, arg, weight } = prog;
  let tape = new Uint8Array(TAPE_START);
  let ptr = 0;
  let pc = 0;
  let steps = 0;
  let inPos = 0;
  let out = new Uint8Array(256);
  let outLen = 0;
  let stopped: RunResult['stopped'] = 'finished';
  while (pc < op.length) {
    if (steps >= stepLimit) {
      stopped = 'step-limit';
      break;
    }
    steps += weight[pc]!;
    switch (op[pc]) {
      case ADD:
        tape[ptr] = tape[ptr]! + arg[pc]!;
        break;
      case MOVE:
        ptr += arg[pc]!;
        if (ptr < 0) {
          throw new ToolError(T('error.leftOfTape', { steps: grouped(steps) }));
        }
        if (ptr >= tape.length) {
          if (ptr >= TAPE_MAX) {
            throw new ToolError(
              T('error.tapeRight', { cells: grouped(TAPE_MAX), steps: grouped(steps) }),
            );
          }
          const grown = new Uint8Array(Math.min(TAPE_MAX, Math.max(tape.length * 2, ptr + 1)));
          grown.set(tape);
          tape = grown;
        }
        break;
      case OUT:
        if (outLen >= OUTPUT_MAX) {
          stopped = 'output-limit';
          pc = op.length;
          break;
        }
        if (outLen === out.length) {
          const grown = new Uint8Array(out.length * 2);
          grown.set(out);
          out = grown;
        }
        out[outLen++] = tape[ptr]!;
        break;
      case IN:
        tape[ptr] = inPos < input.length ? input[inPos++]! : 0;
        break;
      case JZ:
        if (tape[ptr] === 0) pc = arg[pc]! - 1;
        break;
      default:
        if (tape[ptr] !== 0) pc = arg[pc]! - 1;
    }
    pc++;
  }
  return { output: out.slice(0, outLen), steps, stopped };
}

/** Bytes needed to move a cell by `delta` (cell 0 is the printed cell, cell 1 a loop counter). */
function adjust(delta: number): string {
  const sign = delta >= 0 ? '+' : '-';
  const k = Math.abs(delta);
  let best = sign.repeat(k);
  for (let a = 2; a <= k; a++) {
    const b = Math.floor(k / a);
    const rest = k - a * b;
    const loop = `>${'+'.repeat(a)}[<${sign.repeat(b)}>-]<${sign.repeat(rest)}`;
    if (loop.length < best.length) best = loop;
  }
  return best;
}

/** A simple valid Brainfuck program that prints exactly these bytes. */
export function textToBrainfuck(bytes: Uint8Array): string {
  let program = '';
  let cell = 0;
  for (const b of bytes) {
    const delta = ((b - cell + 128) & 255) - 128; // shortest way round the 8-bit wheel
    program += `${adjust(delta)}.`;
    cell = b;
  }
  return program;
}

/** Instructions per output line when a program is re-spelled. */
const PER_LINE: Partial<Record<BrainfuckLanguage | 'cow', number>> = {
  ook: 6,
  blub: 6,
  'short-ook': 24,
  pikalang: 10,
  alphuck: 60,
  cow: 8,
};

/** Re-spell Brainfuck instructions in another dialect, a few instructions per line. */
export function fromBrainfuck(code: string, language: BrainfuckLanguage | 'cow'): string {
  if (language === 'brainfuck') return code;
  if (language === 'reversefuck') return [...code].map((c) => REVERSE[c]!).join('');
  const words = [...code].map((c) => {
    switch (language) {
      case 'ook':
      case 'blub': {
        const pair = BF_TO_PAIR[c]!;
        return `${PAIR_WORD[language]}${pair[0]} ${PAIR_WORD[language]}${pair[1]}`;
      }
      case 'short-ook':
        return BF_TO_PAIR[c]!;
      case 'pikalang':
        return BF_TO_PIKA.get(c)!;
      case 'alphuck':
        return BF_TO_ALPHUCK[c]!;
      default:
        return BF_TO_COW[c]!;
    }
  });
  const joiner = language === 'short-ook' || language === 'alphuck' ? '' : ' ';
  const perLine = PER_LINE[language] ?? 8;
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += perLine) {
    lines.push(words.slice(i, i + perLine).join(joiner));
  }
  return lines.join('\n');
}
