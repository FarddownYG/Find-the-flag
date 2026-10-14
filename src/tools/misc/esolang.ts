import { defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { concatBytes, utf8Encode } from '../../lib/bytes';
import {
  compile,
  execute,
  fromBrainfuck,
  textToBrainfuck,
  toBrainfuck,
} from './_esolang-brainfuck';
import { grouped, LANGUAGE_NAME, type Language } from './_esolang-common';
import { valuesToDeadfish } from './_esolang-deadfish';
import { detectLanguage, guessLanguage } from './_esolang-detect';
import { describeRun, isBrainfuckFamily, runProgram } from './_esolang-run';

export type { Language } from './_esolang-common';
export type { RunResult } from './_esolang-common';
export { compile, detectLanguage, execute, fromBrainfuck, textToBrainfuck, toBrainfuck };

const STEP_LIMIT_MAX = 500_000_000;

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

/** Languages that "Text → program" can write. */
const GENERATED =
  'Brainfuck, Ook!, Short Ook, Blub, Pikalang, Alphuck, ReverseFuck, COW and Deadfish';

export default defineTool({
  id: 'esolang',
  name: 'Esoteric languages (Brainfuck, Ook!, Befunge, Malbolge…)',
  category: 'misc',
  description:
    'Run Brainfuck and its dialects (Ook!, COW, Blub, Pikalang…), Deadfish, Befunge-93 and Malbolge programs (language is detected), or turn text into a program. Whitespace and Piet programs have their own tools.',
  tags: [
    'brainfuck',
    'bf',
    'ook',
    'ook!',
    'short ook',
    'cow',
    'moo',
    'blub',
    'pikalang',
    'pikachu',
    'alphuck',
    'reversefuck',
    'deadfish',
    'xkcd deadfish',
    'befunge',
    'befunge-93',
    'malbolge',
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
      { value: 'generate', label: 'Text → program' },
    ]),
    language: select(
      'Language',
      [
        { value: 'auto', label: 'Auto-detect' },
        { value: 'brainfuck', label: 'Brainfuck' },
        { value: 'ook', label: 'Ook!' },
        { value: 'short-ook', label: 'Short Ook (. ? ! pairs)' },
        { value: 'cow', label: 'COW (moo, mOo, MOO…)' },
        { value: 'blub', label: 'Blub' },
        { value: 'pikalang', label: 'Pikalang' },
        { value: 'alphuck', label: 'Alphuck (a c e i j o p s)' },
        { value: 'reversefuck', label: 'ReverseFuck' },
        { value: 'deadfish', label: 'Deadfish (i d s o)' },
        { value: 'xkcd-deadfish', label: 'XKCD Deadfish (x d k c)' },
        { value: 'befunge', label: 'Befunge-93' },
        { value: 'malbolge', label: 'Malbolge' },
        { value: 'malbolge-normalized', label: 'Malbolge (normalised: i < / * j p o v)' },
      ],
      'auto',
    ),
    input: text('Program input', '', {
      placeholder: 'read by the program  (\\n and \\xNN allowed)',
      hint: 'Bytes the program reads (Brainfuck ",", Befunge "~" and "&", Malbolge "/", COW "Moo" and "oom"). Reading past the end gives 0 (Brainfuck family, COW), -1 (Befunge) or 59048 (Malbolge).',
      showIf: (v) =>
        v.mode === 'run' && v.language !== 'deadfish' && v.language !== 'xkcd-deadfish',
    }),
    steps: number('Step limit', 10_000_000, {
      min: 1000,
      max: STEP_LIMIT_MAX,
      step: 1_000_000,
      hint: 'Stops infinite loops. Output printed so far is still shown.',
      showIf: (v) => v.mode === 'run',
    }),
    seed: number('Random seed', 1, {
      min: 0,
      max: 4_294_967_295,
      hint: 'Seeds the "?" command of Befunge, so the same program and seed always take the same path.',
      showIf: (v) => v.mode === 'run' && v.language === 'befunge',
    }),
    deadfish: toggle(
      'Deadfish output',
      [
        { value: 'numbers', label: 'Numbers' },
        { value: 'chars', label: 'ASCII characters' },
      ],
      'numbers',
      {
        hint: 'What "o" (or "c") prints: the value as a number, as the language says, or as one character (the Deadfish~ habit, handy for hidden messages).',
        showIf: (v) =>
          v.mode === 'run' && (v.language === 'deadfish' || v.language === 'xkcd-deadfish'),
      },
    ),
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
      label: 'COW',
      input: `moO MoO MoO MoO MoO MoO MoO MoO
MOO mOo MoO MoO MoO MoO MoO MoO
MoO MoO MoO MoO moO MOo moo mOo
Moo MoO MoO MoO MoO MoO MoO MoO
MoO MoO MoO MoO MoO MoO MoO Moo
MOo MOo MOo MOo MOo MOo MOo MOo
MOo MOo MOo MOo MOo MOo Moo`,
      expect: 'FTF',
    },
    {
      label: 'Blub',
      input: `Blub. Blub? Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub.
Blub. Blub. Blub. Blub. Blub! Blub? Blub? Blub. Blub. Blub. Blub. Blub.
Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub.
Blub. Blub. Blub. Blub. Blub. Blub? Blub! Blub! Blub? Blub! Blub? Blub.
Blub! Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub.
Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub. Blub.
Blub. Blub. Blub. Blub. Blub. Blub. Blub! Blub. Blub! Blub! Blub! Blub!
Blub! Blub! Blub! Blub! Blub! Blub! Blub! Blub! Blub! Blub! Blub! Blub!
Blub! Blub! Blub! Blub! Blub! Blub! Blub! Blub! Blub! Blub! Blub! Blub!
Blub! Blub.`,
      expect: 'FTF',
    },
    {
      label: 'Pikalang',
      input: `pi pi pi pi pi pi pi pi pi pi
pika pipi pi pi pi pi pi pi pi pipi
pi pi pi pi pi pi pi pi pichu pichu
ka chu pipi pikachu pipi pi pi pi pi pikachu
pichu pikachu`,
      expect: 'FTF',
    },
    {
      label: 'Alphuck',
      input: 'eeeeeeeeeepaeeeeeeeaeeeeeeeeccisajaeeeejcj',
      expect: 'FTF',
    },
    {
      label: 'ReverseFuck',
      input: '----------]<-------<-------->>+[<,<----,>,',
      expect: 'FTF',
    },
    {
      label: 'Deadfish',
      input: 'iiisdsiiiiiioiiiiiiiiiiiiiioddddddddddddddo',
      expect: 'FTF',
    },
    {
      label: 'XKCD Deadfish',
      input: 'xxxkdkxxxxxxcxxxxxxxxxxxxxxcddddddddddddddc',
      expect: 'FTF',
    },
    {
      label: 'Befunge-93',
      input: '>"!egnufeB ,olleH">:#,_@',
      expect: 'Hello, Befunge!',
    },
    {
      label: 'Befunge reads numbers',
      input: '&&+.@',
      options: { input: '20 22' },
      expect: '42',
    },
    {
      label: 'Malbolge',
      input: '(CBA#9]~654X210TA3210/.-,+*)(\'&%$#"!~}|{zyxwZ5t3V1jo.zPkj',
      expect: 'FTF',
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
    const guess = guessLanguage(sample);
    return guess
      ? { score: guess.score, options: { language: guess.language }, reason: guess.reason }
      : null;
  },
  run(src, { mode, language, input, steps, seed, deadfish }) {
    if (mode === 'generate') {
      const bytes = utf8Encode(src);
      if (bytes.length === 0) throw new ToolError('Type the text to turn into a program.');
      const target: Language = language === 'auto' ? 'brainfuck' : language;
      let program: string;
      let count: number;
      let reading = '';
      if (target === 'deadfish' || target === 'xkcd-deadfish') {
        program = valuesToDeadfish(Array.from(bytes), target);
        count = program.length;
        reading =
          ' It prints each byte as a number: run it with "ASCII characters" selected to read the text.';
      } else if (isBrainfuckFamily(target) || target === 'cow') {
        if (target === 'cow' && bytes.includes(0)) {
          throw new ToolError(
            'COW cannot print a zero byte (Moo reads a character when the cell is 0). Remove the NUL characters from the text.',
          );
        }
        const bf = textToBrainfuck(bytes);
        program = fromBrainfuck(bf, target);
        count = bf.length;
      } else {
        throw new ToolError(
          `Text → program writes ${GENERATED} programs. ${LANGUAGE_NAME[target]} can only be run here.`,
        );
      }
      return [
        { type: 'text', label: `${LANGUAGE_NAME[target]} program`, value: program },
        {
          type: 'note',
          level: 'info',
          text: `${bytes.length} byte(s) became ${grouped(count)} instructions. Run it with this tool to check.${reading}`,
        },
      ];
    }
    if (!Number.isFinite(steps) || steps < 1) {
      throw new ToolError('The step limit must be a positive number.');
    }
    const detected = language === 'auto' ? detectLanguage(src) : language;
    const run = runProgram(src, detected, {
      input: inputBytes(input),
      steps,
      seed: Number.isFinite(seed) ? Math.trunc(seed) : 1,
      deadfishOutput: deadfish,
    });
    return describeRun(run, detected, language === 'auto', steps);
  },
});
