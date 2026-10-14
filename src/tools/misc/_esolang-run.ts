import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
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
  languageName,
  OUTPUT_MAX,
  type Language,
  type RunResult,
} from './_esolang-common';
import { runCow, tokenizeCow } from './_esolang-cow';
import { runDeadfish } from './_esolang-deadfish';
import { denormaliseMalbolge, normaliseMalbolge, runMalbolge } from './_esolang-malbolge';

const T = toolT('esolang');

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
const SYNTAX_HINT: Record<BrainfuckLanguage, () => string> = {
  brainfuck: () => T('error.syntax.brainfuck'),
  ook: () => T('error.syntax.ook'),
  'short-ook': () => T('error.syntax.shortOok'),
  blub: () => T('error.syntax.blub'),
  pikalang: () => T('error.syntax.pikalang'),
  alphuck: () => T('error.syntax.alphuck'),
  reversefuck: () => T('error.syntax.reversefuck'),
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
          T('error.noInstructionsWhitespace', { language: languageName(language) }),
        );
      }
      throw new ToolError(
        T('error.noInstructions', {
          language: languageName(language),
          hint: SYNTAX_HINT[language](),
        }),
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
        throw new ToolError(T('error.maybeReverseFuck', { message: e.message }));
      }
      throw e;
    }
    return { result: execute(program, input, steps), extra: [] };
  }
  switch (language) {
    case 'cow':
      if (tokenizeCow(src).ops.length === 0) {
        throw new ToolError(T('error.noCow'));
      }
      return { result: runCow(src, input, steps), extra: [] };
    case 'deadfish':
    case 'xkcd-deadfish': {
      const letters = language === 'deadfish' ? /[idso]/i : /[xdkc]/i;
      if (!letters.test(src)) {
        throw new ToolError(
          T('error.noDeadfish', {
            language: languageName(language),
            letters: language === 'deadfish' ? 'i d s o' : 'x d k c',
          }),
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
          label: T('label.numbersAsAscii'),
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
              label: T('label.realMalbolge'),
              value: chunk(denormaliseMalbolge(src), 64),
            },
          ]
        : [
            {
              type: 'text',
              label: T('label.normalisedForm'),
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
      label: T('label.output'),
      value: result.output,
      filename: 'output.bin',
    });
  }
  out.push(...extra);
  const name = languageName(language);
  const how = autoDetected ? T('text.autoDetected', { language: name }) : name;
  out.push({
    type: 'note',
    level: 'info',
    text: T('note.summary', {
      how,
      steps: T('text.stepsExecuted', { count: result.steps, n: grouped(result.steps) }),
      bytes: T('text.bytesPrinted', {
        count: result.output.length,
        n: grouped(result.output.length),
      }),
    }),
  });
  if (result.stopped === 'step-limit') {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.stepLimit', { limit: grouped(stepLimit) }),
    });
  } else if (result.stopped === 'output-limit') {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.outputLimit', { max: grouped(OUTPUT_MAX) }),
    });
  }
  for (const text of result.notes ?? []) out.push({ type: 'note', level: 'warn', text });
  if (result.stopped === 'finished' && result.output.length === 0) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.noOutput'),
    });
  }
  return out;
}
