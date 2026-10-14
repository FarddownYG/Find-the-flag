import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { runBefunge } from './_esolang-befunge';
import {
  bracketsPair,
  compile,
  execute,
  toBrainfuck,
  type BrainfuckLanguage,
  type Program,
} from './_esolang-brainfuck';
import {
  grouped,
  LANGUAGE_NAME,
  OUTPUT_MAX,
  type Language,
  type RunResult,
} from './_esolang-common';
import { runCow, tokenizeCow } from './_esolang-cow';
import { runDeadfish } from './_esolang-deadfish';
import { denormaliseMalbolge, normaliseMalbolge, runMalbolge } from './_esolang-malbolge';

export interface RunSettings {
  input: Uint8Array;
  steps: number;
  /** Seeds Befunge's `?`. */
  seed: number;
  /** What Deadfish's `o` prints. */
  deadfishOutput: 'numbers' | 'chars';
}

export interface Run {
  result: RunResult;
  /** Extra blocks shown after the program output (a disassembly-like view, a reading, ...). */
  extra: Output[];
}

const BRAINFUCK_FAMILY: ReadonlySet<Language> = new Set<Language>([
  'brainfuck',
  'ook',
  'short-ook',
  'blub',
  'pikalang',
  'alphuck',
  'reversefuck',
]);

export function isBrainfuckFamily(language: Language): language is BrainfuckLanguage {
  return BRAINFUCK_FAMILY.has(language);
}

/** What to paste, per dialect: shown when a program has no instruction at all. */
const SYNTAX_HINT: Record<BrainfuckLanguage, string> = {
  brainfuck:
    'Paste a program made of + - < > [ ] . , (Brainfuck) or Ook. Ook? Ook! words, or pick another language.',
  ook: 'Paste a program made of Ook. Ook? Ook! words.',
  'short-ook': 'Paste a program made of pairs of the symbols . ? !',
  blub: 'Paste a program made of Blub. Blub? Blub! words.',
  pikalang: 'Paste a program made of the words pi, ka, pipi, pichu, pikachu, pikapi, pika and chu.',
  alphuck: 'Paste a program made of the lowercase letters a c e i j o p s.',
  reversefuck: 'Paste a program made of + - < > [ ] . , (every symbol means its opposite).',
};

const chunk = (s: string, width: number) =>
  (s.match(new RegExp(`.{1,${width}}`, 'gs')) ?? []).join('\n');

/** True for text that is (almost) only spaces, tabs and line feeds: that is a Whitespace program. */
function looksLikeWhitespaceProgram(src: string): boolean {
  if (src.length < 8 || !/[ ]/.test(src) || !/[\t\n]/.test(src)) return false;
  const blank = src.replace(/[^ \t\r\n]/g, '').length;
  return blank >= 0.9 * src.length;
}

/** Run a program in one language. Throws a ToolError for anything the person can fix. */
export function runProgram(src: string, language: Language, settings: RunSettings): Run {
  const { input, steps } = settings;
  if (isBrainfuckFamily(language)) {
    const instructions = toBrainfuck(src, language);
    if (instructions.code.length === 0) {
      if (looksLikeWhitespaceProgram(src)) {
        throw new ToolError(
          `No ${LANGUAGE_NAME[language]} instructions found, but the text is made of spaces, tabs and line feeds: that is a Whitespace program. Open the "Whitespace (esolang)" tool, which shows the invisible characters and runs it.`,
        );
      }
      throw new ToolError(
        `No ${LANGUAGE_NAME[language]} instructions found. ${SYNTAX_HINT[language]}`,
      );
    }
    let program: Program;
    try {
      program = compile(src, instructions);
    } catch (e) {
      // Unbalanced as written, balanced when read backwards: the person probably meant ReverseFuck.
      if (
        e instanceof ToolError &&
        language === 'brainfuck' &&
        bracketsPair(instructions.code, true)
      ) {
        throw new ToolError(
          `${e.message} The brackets would pair up if [ and ] were swapped: this may be ReverseFuck (choose it in Language).`,
        );
      }
      throw e;
    }
    return { result: execute(program, input, steps), extra: [] };
  }
  switch (language) {
    case 'cow':
      if (tokenizeCow(src).ops.length === 0) {
        throw new ToolError(
          'No COW instructions found. Paste a program made of moo, mOo, moO, mOO, Moo, MOo, MoO, MOO, OOO, MMM, OOM and oom (the case matters).',
        );
      }
      return { result: runCow(src, input, steps), extra: [] };
    case 'deadfish':
    case 'xkcd-deadfish': {
      const letters = language === 'deadfish' ? /[idso]/i : /[xdkc]/i;
      if (!letters.test(src)) {
        throw new ToolError(
          `No ${LANGUAGE_NAME[language]} commands found. Paste a program made of ${language === 'deadfish' ? 'i d s o' : 'x d k c'}.`,
        );
      }
      const fish = runDeadfish(src, language, steps, settings.deadfishOutput);
      const extra: Output[] = [];
      const { values } = fish;
      if (
        settings.deadfishOutput === 'numbers' &&
        values.length > 0 &&
        values.every((v) => v >= 0 && v <= 255)
      ) {
        extra.push({
          type: 'bytes',
          label: 'Numbers read as ASCII',
          value: Uint8Array.from(values),
          filename: 'ascii.bin',
        });
      }
      return { result: fish, extra };
    }
    case 'befunge':
      return { result: runBefunge(src, input, steps, settings.seed), extra: [] };
    default: {
      // Malbolge: also show the same program in the other spelling.
      const normalised = language === 'malbolge-normalized';
      const result = runMalbolge(src, input, steps, normalised);
      const extra: Output[] = normalised
        ? [
            {
              type: 'text',
              label: 'Real Malbolge program',
              value: chunk(denormaliseMalbolge(src), 64),
            },
          ]
        : [
            {
              type: 'text',
              label: 'Normalised form (what each character does at its position)',
              value: chunk(normaliseMalbolge(src), 64),
            },
          ];
      return { result, extra };
    }
  }
}

/** Turn a finished run into the blocks the tool shows. */
export function describeRun(
  run: Run,
  language: Language,
  autoDetected: boolean,
  stepLimit: number,
): Output[] {
  const { result, extra } = run;
  const out: Output[] = [];
  if (result.output.length > 0) {
    out.push({
      type: 'bytes',
      label: 'Program output',
      value: result.output,
      filename: 'output.bin',
    });
  }
  out.push(...extra);
  const how = autoDetected ? `${LANGUAGE_NAME[language]} (auto-detected)` : LANGUAGE_NAME[language];
  out.push({
    type: 'note',
    level: 'info',
    text: `${how}: ${grouped(result.steps)} steps executed, ${grouped(result.output.length)} byte(s) printed.`,
  });
  if (result.stopped === 'step-limit') {
    out.push({
      type: 'note',
      level: 'warn',
      text: `Stopped at the step limit (${grouped(stepLimit)} steps): the program probably loops forever, or needs a higher limit. Output so far is shown.`,
    });
  } else if (result.stopped === 'output-limit') {
    out.push({
      type: 'note',
      level: 'warn',
      text: `Stopped after ${grouped(OUTPUT_MAX)} bytes of output. The program probably prints forever.`,
    });
  }
  for (const text of result.notes ?? []) out.push({ type: 'note', level: 'warn', text });
  if (result.stopped === 'finished' && result.output.length === 0) {
    out.push({
      type: 'note',
      level: 'warn',
      text: 'The program finished without printing anything.',
    });
  }
  return out;
}
