import { defineTool, number, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { concatBytes, utf8Encode } from '../../lib/bytes';

export type Language = 'brainfuck' | 'ook' | 'short-ook';

const LANGUAGE_NAME: Record<Language, string> = {
  brainfuck: 'Brainfuck',
  ook: 'Ook!',
  'short-ook': 'Short Ook',
};

/** Ook! words come in pairs; each pair is one Brainfuck instruction. */
const OOK_PAIRS: Record<string, string> = {
  '.?': '>',
  '?.': '<',
  '..': '+',
  '!!': '-',
  '!.': '.',
  '.!': ',',
  '!?': '[',
  '?!': ']',
};
const BF_TO_OOK: Record<string, string> = {
  '>': 'Ook. Ook?',
  '<': 'Ook? Ook.',
  '+': 'Ook. Ook.',
  '-': 'Ook! Ook!',
  '.': 'Ook! Ook.',
  ',': 'Ook. Ook!',
  '[': 'Ook! Ook?',
  ']': 'Ook? Ook!',
};
const BF_TO_SHORT: Record<string, string> = Object.fromEntries(
  Object.entries(OOK_PAIRS).map(([pair, bf]) => [bf, pair]),
);

const BF_CHARS = /[-+<>[\].,]/;

const STEP_LIMIT_MAX = 500_000_000;
const TAPE_START = 30_000;
const TAPE_MAX = 1 << 24;
const OUTPUT_MAX = 8 << 20;

/** 1234567 -> "1 234 567" (locale independent, so the output is deterministic). */
const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function lineCol(src: string, offset: number): string {
  const before = src.slice(0, offset);
  const line = before.split('\n').length;
  const col = offset - before.lastIndexOf('\n');
  return `line ${line}, column ${col}`;
}

export function detectLanguage(src: string): Language {
  if ((src.match(/\bOok[.?!]/gi) ?? []).length >= 2) return 'ook';
  const compact = src.replace(/\s+/g, '');
  if (
    compact.length >= 2 &&
    compact.length % 2 === 0 &&
    /^[.?!]+$/.test(compact) &&
    /[?!]/.test(compact)
  ) {
    return 'short-ook';
  }
  return 'brainfuck';
}

interface Instructions {
  /** Brainfuck instruction characters only. */
  code: string;
  /** Offset in the source text of each instruction (for error messages). */
  at: number[];
}

/** Reduce a program in any supported dialect to plain Brainfuck instructions. */
export function toBrainfuck(src: string, language: Language): Instructions {
  const code: string[] = [];
  const at: number[] = [];
  if (language === 'brainfuck') {
    for (let i = 0; i < src.length; i++) {
      if (BF_CHARS.test(src[i]!)) {
        code.push(src[i]!);
        at.push(i);
      }
    }
    return { code: code.join(''), at };
  }
  const symbols: { ch: string; at: number }[] = [];
  if (language === 'ook') {
    for (const m of src.matchAll(/\bOok([.?!])/gi)) symbols.push({ ch: m[1]!, at: m.index });
  } else {
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '.' || src[i] === '?' || src[i] === '!') symbols.push({ ch: src[i]!, at: i });
    }
  }
  if (symbols.length % 2 !== 0) {
    const last = symbols[symbols.length - 1]!;
    throw new ToolError(
      `${LANGUAGE_NAME[language]} instructions are pairs of symbols, but the last one (${lineCol(src, last.at)}) has no partner. Check for a missing or extra word.`,
    );
  }
  for (let i = 0; i < symbols.length; i += 2) {
    const instruction = OOK_PAIRS[symbols[i]!.ch + symbols[i + 1]!.ch];
    if (instruction === undefined) continue; // "Ook? Ook?" is not an instruction
    code.push(instruction);
    at.push(symbols[i]!.at);
  }
  return { code: code.join(''), at };
}

const ADD = 0;
const MOVE = 1;
const OUT = 2;
const IN = 3;
const JZ = 4;
const JNZ = 5;

interface Program {
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
        throw new ToolError(
          `Unmatched "]" at ${lineCol(src, at[i]!)}: there is no "[" to close. Remove it or add the missing "[".`,
        );
      }
      arg[start.op] = op.length + 1;
      push(JNZ, start.op + 1, 1);
      i++;
    }
  }
  const dangling = open.pop();
  if (dangling) {
    throw new ToolError(
      `Unmatched "[" at ${lineCol(src, dangling.at)}: the loop is never closed. Add the missing "]".`,
    );
  }
  return {
    op: Uint8Array.from(op),
    arg: Int32Array.from(arg),
    weight: Int32Array.from(weight),
  };
}

export interface RunResult {
  output: Uint8Array;
  steps: number;
  stopped: 'finished' | 'step-limit' | 'output-limit';
}

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
          throw new ToolError(
            `The pointer moved left of the first cell after ${grouped(steps)} steps. The program expects a tape that wraps or extends to the left; it is probably not plain Brainfuck.`,
          );
        }
        if (ptr >= tape.length) {
          if (ptr >= TAPE_MAX) {
            throw new ToolError(
              `The pointer ran past ${grouped(TAPE_MAX)} cells after ${grouped(steps)} steps: the program is probably looping forever to the right.`,
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

/** Re-spell Brainfuck instructions in another dialect, a few instructions per line. */
export function fromBrainfuck(code: string, language: Language): string {
  if (language === 'brainfuck') return code;
  const table = language === 'ook' ? BF_TO_OOK : BF_TO_SHORT;
  const words = [...code].map((c) => table[c]!);
  const lines: string[] = [];
  const perLine = language === 'ook' ? 6 : 24;
  for (let i = 0; i < words.length; i += perLine) {
    lines.push(words.slice(i, i + perLine).join(language === 'ook' ? ' ' : ''));
  }
  return lines.join('\n');
}

const ESCAPES: Record<string, number> = { n: 10, r: 13, t: 9, '0': 0, '\\': 92 };

/**
 * The Input option as bytes. `\n`, `\r`, `\t`, `\0`, `\\` and `\xNN` stand for single bytes,
 * everything else is UTF-8.
 */
export function inputBytes(s: string): Uint8Array {
  const parts: Uint8Array[] = [];
  let last = 0;
  for (const m of s.matchAll(/\\(x[0-9a-fA-F]{2}|[nrt0\\])/g)) {
    parts.push(utf8Encode(s.slice(last, m.index)));
    const code = m[1]!;
    parts.push(Uint8Array.of(code.startsWith('x') ? parseInt(code.slice(1), 16) : ESCAPES[code]!));
    last = m.index + m[0].length;
  }
  parts.push(utf8Encode(s.slice(last)));
  return concatBytes(...parts);
}

export default defineTool({
  id: 'esolang',
  name: 'Brainfuck / Ook! interpreter',
  category: 'misc',
  description:
    'Run Brainfuck, Ook! and Short Ook programs (language is detected), or turn text into a Brainfuck program.',
  tags: [
    'brainfuck',
    'bf',
    'ook',
    'ook!',
    'short ook',
    'esolang',
    'esoteric',
    'interpreter',
    'text to brainfuck',
  ],
  input: 'text',
  live: false,
  placeholder:
    '++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.',
  options: {
    mode: toggle('Mode', [
      { value: 'run', label: 'Run program' },
      { value: 'generate', label: 'Text → Brainfuck' },
    ]),
    language: toggle('Language', [
      { value: 'auto', label: 'Auto' },
      { value: 'brainfuck', label: 'Brainfuck' },
      { value: 'ook', label: 'Ook!' },
      { value: 'short-ook', label: 'Short Ook' },
    ]),
    input: text('Program input', '', {
      placeholder: 'read by ","  (\\n and \\xNN allowed)',
      hint: 'Bytes the program reads with ",". Reading past the end gives 0.',
      showIf: (v) => v.mode === 'run',
    }),
    steps: number('Step limit', 10_000_000, {
      min: 1000,
      max: STEP_LIMIT_MAX,
      step: 1_000_000,
      hint: 'Stops infinite loops. Output printed so far is still shown.',
      showIf: (v) => v.mode === 'run',
    }),
  },
  examples: [
    {
      label: 'Hello World!',
      input:
        '++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.',
      expect: 'Hello World!',
    },
    {
      label: 'Flag in Brainfuck',
      input:
        '>++++++++++[<++++++++++>-]<++.++++++.-----------.++++++.>++++[<+++++>-]<.>+++++[<----->-]<.>++++[<++++>-]<.>++++[<---->-]<-.++++++++.+++++.--------.+++++++++++++++.>+++[<------>-]<.++++++++.------------.++++++++++.++++++++++.>++++[<----->-]<.+++++++.+++++++++++++++.-------.+++++++++++++++.',
      expect: 'flag{brainfuck_is_fun}',
    },
    {
      label: 'Ook!',
      input: `Ook. Ook? Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook.
Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook! Ook?
Ook? Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook.
Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook?
Ook! Ook! Ook? Ook! Ook? Ook. Ook. Ook. Ook. Ook. Ook! Ook.
Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook.
Ook! Ook. Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook!
Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook!
Ook! Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook.
Ook. Ook. Ook! Ook. Ook. Ook? Ook. Ook. Ook. Ook. Ook. Ook.
Ook. Ook. Ook! Ook? Ook? Ook. Ook. Ook. Ook. Ook. Ook. Ook.
Ook. Ook. Ook. Ook. Ook. Ook? Ook! Ook! Ook? Ook! Ook? Ook.
Ook! Ook. Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook!
Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook! Ook!
Ook! Ook! Ook! Ook. Ook! Ook. Ook! Ook! Ook! Ook! Ook! Ook!
Ook! Ook! Ook! Ook. Ook. Ook? Ook. Ook. Ook. Ook. Ook. Ook.
Ook! Ook? Ook? Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook. Ook.
Ook. Ook. Ook. Ook. Ook. Ook? Ook! Ook! Ook? Ook! Ook? Ook.
Ook! Ook.`,
      expect: 'flag{ook}',
    },
    {
      label: 'Short Ook',
      input: `.?....................!??......................?
!!?!?.....!.............!.!!!!!!!!!!!!!!!!!!!!!!
!.............!..?........!??............?!!?!?.
!.!!!!!!!!!!!!!!!!!!!!!!!!!.!.!!!!!!!!!..?......
!??..............?!!?!?.!.`,
      expect: 'flag{ook}',
    },
    {
      label: 'Reads input (cat)',
      input: ',[.,]',
      options: { input: 'flag{echo}' },
      expect: 'flag{echo}',
    },
    {
      label: 'Infinite loop (step limit)',
      input: '+[]',
      options: { steps: 5000 },
      expect: 'Stopped at the step limit',
    },
    {
      label: 'Text → Brainfuck',
      input: 'flag{bf}',
      options: { mode: 'generate' },
      expect: '>++++++++++[<++++++++++>-]<++.++++++.',
    },
  ],
  detect({ text: sample }) {
    if (!sample || sample.length > 2_000_000) return null;
    const t = sample.trim();
    if ((t.match(/\bOok[.?!]/gi) ?? []).length >= 4) {
      return { score: 0.95, options: { language: 'ook' }, reason: 'Ook! words' };
    }
    const compact = t.replace(/\s+/g, '');
    if (compact.length < 16) return null;
    if (
      compact.length % 2 === 0 &&
      /^[.?!]+$/.test(compact) &&
      compact.includes('?') &&
      compact.includes('!')
    ) {
      return { score: 0.7, options: { language: 'short-ook' }, reason: 'Only . ? ! (Short Ook)' };
    }
    const bf = (compact.match(/[-+<>[\].,]/g) ?? []).length;
    let depth = 0;
    let balanced = true;
    for (const ch of compact) {
      if (ch === '[') depth++;
      else if (ch === ']' && --depth < 0) balanced = false;
    }
    const looksLikeCode = compact.includes('[') || (/\+/.test(compact) && /[<>]/.test(compact));
    if (!balanced || depth !== 0 || !looksLikeCode) return null;
    const ratio = bf / compact.length;
    if (ratio >= 0.9) {
      return { score: 0.9, options: { language: 'brainfuck' }, reason: 'Only Brainfuck symbols' };
    }
    return ratio >= 0.75
      ? { score: 0.55, options: { language: 'brainfuck' }, reason: 'Mostly Brainfuck symbols' }
      : null;
  },
  run(src, { mode, language, input, steps }) {
    if (mode === 'generate') {
      const bytes = utf8Encode(src);
      if (bytes.length === 0) throw new ToolError('Type the text to turn into a program.');
      const target: Language = language === 'auto' ? 'brainfuck' : language;
      const bf = textToBrainfuck(bytes);
      return [
        {
          type: 'text',
          label: `${LANGUAGE_NAME[target]} program`,
          value: fromBrainfuck(bf, target),
        },
        {
          type: 'note',
          level: 'info',
          text: `${bytes.length} byte(s) became ${grouped(bf.length)} instructions. Run it with this tool to check.`,
        },
      ];
    }
    if (!Number.isFinite(steps) || steps < 1) {
      throw new ToolError('The step limit must be a positive number.');
    }
    const detected = language === 'auto' ? detectLanguage(src) : language;
    const instructions = toBrainfuck(src, detected);
    if (instructions.code.length === 0) {
      throw new ToolError(
        `No ${LANGUAGE_NAME[detected]} instructions found. Paste a program made of + - < > [ ] . , (Brainfuck) or Ook. Ook? Ook! words.`,
      );
    }
    const result = execute(compile(src, instructions), inputBytes(input), steps);
    const out: Output[] = [];
    if (result.output.length > 0) {
      out.push({
        type: 'bytes',
        label: 'Program output',
        value: result.output,
        filename: 'output.bin',
      });
    }
    const how =
      language === 'auto' ? `${LANGUAGE_NAME[detected]} (auto-detected)` : LANGUAGE_NAME[detected];
    out.push({
      type: 'note',
      level: 'info',
      text: `${how}: ${grouped(result.steps)} steps executed, ${grouped(result.output.length)} byte(s) printed.`,
    });
    if (result.stopped === 'step-limit') {
      out.push({
        type: 'note',
        level: 'warn',
        text: `Stopped at the step limit (${grouped(steps)} steps): the program probably loops forever, or needs a higher limit. Output so far is shown.`,
      });
    } else if (result.stopped === 'output-limit') {
      out.push({
        type: 'note',
        level: 'warn',
        text: `Stopped after ${grouped(OUTPUT_MAX)} bytes of output. The program probably prints forever.`,
      });
    } else if (result.output.length === 0) {
      out.push({
        type: 'note',
        level: 'warn',
        text: 'The program finished without printing anything.',
      });
    }
    return out;
  },
});
