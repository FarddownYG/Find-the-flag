import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import { loadBefunge, runBefunge } from './_esolang-befunge';
import { runCow, tokenizeCow } from './_esolang-cow';
import { deadfishVariantOf, runDeadfish, valuesToDeadfish } from './_esolang-deadfish';
import {
  crazy,
  denormaliseMalbolge,
  encrypt,
  isMalbolgeProgram,
  loadMalbolge,
  MALBOLGE_SIZE,
  normaliseMalbolge,
  rotr,
  runMalbolge,
} from './_esolang-malbolge';
import tool, {
  type Language,
  compile,
  detectLanguage,
  execute,
  fromBrainfuck,
  inputBytes,
  textToBrainfuck,
  toBrainfuck,
} from './esolang';

const HELLO =
  '++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.';

type Opts = Parameters<typeof tool.run>[1];
const defaults: Opts = {
  mode: 'run',
  language: 'auto',
  input: '',
  steps: 10_000_000,
  seed: 1,
  deadfish: 'numbers',
};

async function run(src: string, opts: Partial<Opts> = {}) {
  return tool.run(src, { ...defaults, ...opts });
}
async function output(src: string, opts: Partial<Opts> = {}): Promise<Uint8Array> {
  const out = await run(src, opts);
  const block = out.find((o: Output) => o.type === 'bytes');
  return block && block.type === 'bytes' ? block.value : new Uint8Array();
}
const bf = (src: string, input = '', limit = 10_000_000) =>
  execute(compile(src, toBrainfuck(src, 'brainfuck')), utf8Encode(input), limit);

describe('Brainfuck', () => {
  it('runs the canonical Hello World program', async () => {
    expect(utf8Decode(await output(HELLO))).toBe('Hello World!\n');
  });

  it('runs loops, comments and nested loops', async () => {
    expect(utf8Decode(await output('++++++++[>++++++++<-]>+.'))).toBe('A');
    expect(utf8Decode(await output('Print B: ++++++++[>++++++++<-]>++. (done)'))).toBe('B');
    // 5 * 5 * 3 + 2 = 77 = "M"
    expect(utf8Decode(await output('+++[>+++++[>+++++<-]<-]>>++.'))).toBe('M');
  });

  it('wraps cells at 8 bits', () => {
    expect(Array.from(bf('-.').output)).toEqual([255]);
    expect(Array.from(bf(`${'+'.repeat(256)}.`).output)).toEqual([0]);
    expect(Array.from(bf(`${'+'.repeat(257)}.`).output)).toEqual([1]);
    expect(Array.from(bf('-+.').output)).toEqual([0]);
  });

  it('moves the pointer, and cells start at zero', () => {
    expect(Array.from(bf('>+++<.>.').output)).toEqual([0, 3]);
  });

  it('reads input, then zeros at the end of it', () => {
    expect(Array.from(bf(',.,.,.', 'ab').output)).toEqual([97, 98, 0]);
    expect(utf8Decode(bf(',[.,]', 'echo this').output)).toBe('echo this');
  });

  it('counts source instructions exactly, even though runs are folded', () => {
    expect(bf('+++.').steps).toBe(4);
    expect(bf('++[-]').steps).toBe(7);
    expect(bf('[+]').steps).toBe(1);
    expect(bf('+++>>><<<-').steps).toBe(10);
  });

  it('stops infinite loops at the step limit and keeps the output so far', async () => {
    const out = await run('++++++++[>++++++++<-]>+.[]', { steps: 5000 });
    expect(utf8Decode(await output('++++++++[>++++++++<-]>+.[]', { steps: 5000 }))).toBe('A');
    const text = resultToText(out);
    expect(text).toContain('Stopped at the step limit (5 000 steps)');
    expect(out.some((o) => o.type === 'note' && o.level === 'warn')).toBe(true);
  });

  it('applies the default 10 000 000 step limit quickly', async () => {
    const t0 = Date.now();
    const out = await run('-[>-[>-[>-<-]<-]<-]');
    expect(resultToText(out)).toContain('10 000 000 steps');
    expect(resultToText(out)).toContain('Stopped at the step limit');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('reports unmatched brackets with a position', async () => {
    await expect(run('+]')).rejects.toThrow(/Unmatched "\]" at line 1, column 2/);
    await expect(run('++\n[[]')).rejects.toThrow(/Unmatched "\[" at line 2, column 1/);
    await expect(run('+]')).rejects.toThrow(ToolError);
  });

  it('refuses to walk off the left end of the tape', async () => {
    await expect(run('<+')).rejects.toThrow(/left of the first cell/);
  });

  it('refuses a program without instructions', async () => {
    await expect(run('hello world')).rejects.toThrow(/No Brainfuck instructions/);
  });

  it('reports the work done', async () => {
    const text = resultToText(await run(HELLO));
    expect(text).toContain('Brainfuck (auto-detected)');
    expect(text).toMatch(/\d+ steps executed, 13 byte\(s\) printed/);
    expect(resultToText(await run('+', { language: 'brainfuck' }))).toContain(
      'finished without printing anything',
    );
  });

  it('grows the tape to the right', () => {
    expect(Array.from(bf(`${'>'.repeat(40_000)}+.`).output)).toEqual([1]);
  });
});

describe('Program input option', () => {
  it('passes text, with \\n and \\xNN escapes', async () => {
    expect(utf8Decode(await output(',[.,]', { input: 'flag{in}' }))).toBe('flag{in}');
    expect(Array.from(inputBytes('a\\n\\x41\\\\\\0'))).toEqual([97, 10, 65, 92, 0]);
    expect(Array.from(await output(',.', { input: '\\xff' }))).toEqual([255]);
    expect(utf8Decode(inputBytes('é'))).toBe('é');
  });
});

describe('Ook! and Short Ook', () => {
  const pairs: [string, string][] = [
    ['Ook. Ook?', '>'],
    ['Ook? Ook.', '<'],
    ['Ook. Ook.', '+'],
    ['Ook! Ook!', '-'],
    ['Ook! Ook.', '.'],
    ['Ook. Ook!', ','],
    ['Ook! Ook?', '['],
    ['Ook? Ook!', ']'],
  ];

  it('maps every Ook! word pair to its Brainfuck instruction', () => {
    for (const [ook, instruction] of pairs) {
      expect(toBrainfuck(ook, 'ook').code).toBe(instruction);
    }
    expect(toBrainfuck('Ook? Ook?', 'ook').code).toBe('');
    expect(toBrainfuck('ook. OOK. ook! Ook.', 'ook').code).toBe('+.');
  });

  it('maps every Short Ook pair too', () => {
    const short: [string, string][] = [
      ['.?', '>'],
      ['?.', '<'],
      ['..', '+'],
      ['!!', '-'],
      ['!.', '.'],
      ['.!', ','],
      ['!?', '['],
      ['?!', ']'],
    ];
    for (const [s, instruction] of short)
      expect(toBrainfuck(s, 'short-ook').code).toBe(instruction);
    expect(toBrainfuck('.. .. !. \n', 'short-ook').code).toBe('++.');
  });

  it('runs Hello World written in Ook!, Short Ook and Brainfuck alike', async () => {
    for (const language of ['ook', 'short-ook', 'brainfuck'] as const) {
      const program = fromBrainfuck(HELLO, language);
      expect(utf8Decode(await output(program))).toBe('Hello World!\n');
      expect(detectLanguage(program)).toBe(language);
    }
  });

  it('runs a hand-written Ook! program with prose around it', async () => {
    const program = `Print an A: ${'Ook. Ook. '.repeat(65)}Ook! Ook. (that is 65 plus signs and a dot)`;
    expect(utf8Decode(await output(program))).toBe('A');
  });

  it('honours an explicit language over detection', async () => {
    // As Brainfuck this has two '.' instructions; as Short Ook it is '!.' once per pair.
    expect(Array.from(await output('!.', { language: 'short-ook' }))).toEqual([0]);
    expect(resultToText(await run('!.', { language: 'short-ook' }))).toContain('Short Ook:');
  });

  it('complains about an unpaired word', async () => {
    await expect(run('Ook. Ook. Ook!')).rejects.toThrow(/pairs of symbols.*no partner/);
    await expect(run('..!', { language: 'short-ook' })).rejects.toThrow(ToolError);
  });

  it('reports unmatched brackets in Ook! with a position', async () => {
    await expect(run('Ook! Ook?')).rejects.toThrow(/Unmatched "\[" at line 1, column 1/);
  });
});

describe('language detection', () => {
  it('tells the three dialects apart', () => {
    expect(detectLanguage('Ook. Ook? Ook! Ook!')).toBe('ook');
    expect(detectLanguage('.?.. !!\n!. .!')).toBe('short-ook');
    expect(detectLanguage('+[>+<-].')).toBe('brainfuck');
    expect(detectLanguage('...')).toBe('brainfuck');
    expect(detectLanguage('')).toBe('brainfuck');
  });

  it('suggests the tool for pasted programs only', () => {
    const detect = (text: string | null) =>
      tool.detect?.({ text, bytes: new Uint8Array(text?.length ?? 4) }) ?? null;
    expect(detect(HELLO)?.score).toBeGreaterThanOrEqual(0.85);
    expect(detect(HELLO)?.options).toEqual({ language: 'brainfuck' });
    expect(detect(fromBrainfuck(HELLO, 'ook'))?.options).toEqual({ language: 'ook' });
    expect(detect(fromBrainfuck(HELLO, 'short-ook'))?.options).toEqual({ language: 'short-ook' });
    expect(detect('hello, this is plain English text with no code in it.')).toBeNull();
    expect(detect('.- -... -.-. -.. . ..-. --.')).toBeNull(); // Morse code
    expect(detect('[1, 2, 3, 4, 5, 6, 7, 8, 9]')).toBeNull();
    expect(detect('+++')).toBeNull();
    expect(detect(null)).toBeNull();
  });
});

describe('Text → Brainfuck', () => {
  const printed = (program: string) => bf(program).output;

  it('prints every byte value, one at a time', () => {
    for (let b = 0; b < 256; b++) {
      expect(Array.from(printed(textToBrainfuck(Uint8Array.of(b))))).toEqual([b]);
    }
  });

  it('round-trips sentences, repeated letters and arbitrary bytes', () => {
    const samples = [
      'flag{brainfuck_is_fun}',
      'Hello, World!\n',
      'aaaaaaaaaaaaaaaaaaaa',
      'ZZZ zzz AAA aaa',
      'héllo wörld ✓',
      '',
    ];
    for (const s of samples) {
      const bytes = utf8Encode(s);
      expect(utf8Decode(printed(textToBrainfuck(bytes)))).toBe(s);
    }
    let seed = 12345;
    const random = Uint8Array.from({ length: 500 }, () => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed >> 16;
    });
    expect(Array.from(printed(textToBrainfuck(random)))).toEqual(Array.from(random));
  });

  it('is much shorter than one + per unit', () => {
    const program = textToBrainfuck(utf8Encode('flag{brainfuck_is_fun}'));
    expect(program.length).toBeLessThan(300);
    expect(/^[-+<>[\].]+$/.test(program)).toBe(true);
  });

  it('works through the tool in every dialect', async () => {
    for (const language of ['auto', 'brainfuck', 'ook', 'short-ook'] as const) {
      const out = await run('flag{generated}', { mode: 'generate', language });
      const block = out.find((o: Output) => o.type === 'text');
      expect(block).toBeDefined();
      const program = block && block.type === 'text' ? block.value : '';
      expect(utf8Decode(await output(program))).toBe('flag{generated}');
    }
    expect(resultToText(await run('hi', { mode: 'generate' }))).toContain('Brainfuck program');
    expect(resultToText(await run('hi', { mode: 'generate', language: 'ook' }))).toContain(
      'Ook! program',
    );
  });

  it('asks for text when there is none', async () => {
    await expect(run('', { mode: 'generate' })).rejects.toThrow(ToolError);
  });
});

// ---------------------------------------------------------------------------------------------
// More Brainfuck dialects: every one of them is a renamed Brainfuck and shares the engine.
// ---------------------------------------------------------------------------------------------

describe('Blub, Pikalang, Alphuck and ReverseFuck', () => {
  const tables = {
    blub: [
      ['Blub. Blub?', '>'],
      ['Blub? Blub.', '<'],
      ['Blub. Blub.', '+'],
      ['Blub! Blub!', '-'],
      ['Blub! Blub.', '.'],
      ['Blub. Blub!', ','],
      ['Blub! Blub?', '['],
      ['Blub? Blub!', ']'],
    ],
    // pipi and pichu move the pointer, pi and ka change the cell (the language's own table).
    pikalang: [
      ['pipi', '>'],
      ['pichu', '<'],
      ['pi', '+'],
      ['ka', '-'],
      ['pikachu', '.'],
      ['pikapi', ','],
      ['pika', '['],
      ['chu', ']'],
    ],
    // The letters a c e i j o p s, in that order, are > < + - . , [ ]
    alphuck: [
      ['a', '>'],
      ['c', '<'],
      ['e', '+'],
      ['i', '-'],
      ['j', '.'],
      ['o', ','],
      ['p', '['],
      ['s', ']'],
    ],
    reversefuck: [
      ['-', '+'],
      ['+', '-'],
      ['<', '>'],
      ['>', '<'],
      [',', '.'],
      ['.', ','],
      [']', '['],
      ['[', ']'],
    ],
  } as const;

  it('maps every word or symbol to its Brainfuck instruction', () => {
    for (const [language, table] of Object.entries(tables)) {
      for (const [token, instruction] of table) {
        expect(
          toBrainfuck(token, language as keyof typeof tables).code,
          `${language} ${token}`,
        ).toBe(instruction);
      }
    }
  });

  it('runs programs written by hand, one per dialect', async () => {
    expect(utf8Decode(await output('Blub. Blub. '.repeat(67) + 'Blub! Blub.'))).toBe('C');
    expect(utf8Decode(await output('pi '.repeat(66) + 'pikachu'))).toBe('B');
    expect(utf8Decode(await output('e'.repeat(65) + 'j', { language: 'alphuck' }))).toBe('A');
    expect(utf8Decode(await output('-'.repeat(68) + ',', { language: 'reversefuck' }))).toBe('D');
  });

  it('runs Hello World in every dialect, and round-trips the spelling', async () => {
    for (const language of ['blub', 'pikalang', 'alphuck', 'reversefuck'] as const) {
      const program = fromBrainfuck(HELLO, language);
      expect(toBrainfuck(program, language).code).toBe(HELLO);
      expect(utf8Decode(await output(program, { language }))).toBe('Hello World!\n');
    }
    // Every one of them can be recognised on its own.
    for (const language of ['blub', 'pikalang', 'alphuck', 'reversefuck'] as const) {
      const program = fromBrainfuck(HELLO, language);
      expect(detectLanguage(program)).toBe(language);
      expect(utf8Decode(await output(program))).toBe('Hello World!\n');
    }
  });

  it('writes every instruction in every dialect and reads it back', () => {
    const everything = '+-<>[].,+++[>>-<<-]';
    for (const language of [
      'ook',
      'short-ook',
      'blub',
      'pikalang',
      'alphuck',
      'reversefuck',
    ] as const) {
      expect(toBrainfuck(fromBrainfuck(everything, language), language).code).toBe(everything);
    }
  });

  it('Blub follows the Ook! rules: any case, comments, and pairs', async () => {
    expect(toBrainfuck('blub. BLUB. text Blub. Blub!', 'blub').code).toBe('+,');
    expect(toBrainfuck('Blub? Blub?', 'blub').code).toBe('');
    // Blub words are not Ook! words and the other way round.
    expect(toBrainfuck('Ook. Ook.', 'blub').code).toBe('');
    expect(toBrainfuck('Blub. Blub.', 'ook').code).toBe('');
    await expect(run('Blub. Blub. Blub!')).rejects.toThrow(/Blub instructions are pairs/);
    await expect(run('Blub! Blub?')).rejects.toThrow(/Unmatched "\[" at line 1, column 1/);
  });

  it('Pikalang reads whole words only, in any case, and ignores the rest', () => {
    expect(toBrainfuck('Pi, KA! PIPI? pikachu... pika-chu', 'pikalang').code).toBe('+->.[]');
    expect(toBrainfuck('pikaa pip kachu pikapipi', 'pikalang').code).toBe('');
    expect(toBrainfuck('pi\npi\tpi', 'pikalang').code).toBe('+++');
    // Words that exist on every JavaScript object must not turn into instructions.
    expect(
      toBrainfuck('constructor toString valueOf hasOwnProperty __proto__', 'pikalang').code,
    ).toBe('');
  });

  it('Alphuck is case sensitive and ignores every other character', () => {
    expect(toBrainfuck('ACEIJOPS', 'alphuck').code).toBe('');
    expect(toBrainfuck('xyz bdfghklmnqrtuvw 123 aj', 'alphuck').code).toBe('>.');
  });

  it('ReverseFuck turns every symbol into its opposite', async () => {
    // The cat program ",[.,]" is written ".],.[": "," <-> ".", "[" <-> "]".
    expect(toBrainfuck('.],.[', 'reversefuck').code).toBe(',[.,]');
    expect(utf8Decode(await output('.],.[', { language: 'reversefuck', input: 'meow' }))).toBe(
      'meow',
    );
  });

  it('complains in the dialect when there is nothing to run', async () => {
    await expect(run('nothing here', { language: 'pikalang' })).rejects.toThrow(
      /No Pikalang instructions found/,
    );
    await expect(run('XYZ', { language: 'alphuck' })).rejects.toThrow(
      /No Alphuck instructions found.*a c e i j o p s/,
    );
    await expect(run('hello', { language: 'blub' })).rejects.toThrow(/No Blub instructions/);
  });

  it('reports the dialect and the work done', async () => {
    expect(resultToText(await run(fromBrainfuck(HELLO, 'blub')))).toContain('Blub (auto-detected)');
    expect(resultToText(await run('j', { language: 'alphuck' }))).toContain('Alphuck:');
  });
});

// ---------------------------------------------------------------------------------------------
// COW
// ---------------------------------------------------------------------------------------------

describe('COW', () => {
  const rep = (word: string, n: number) => Array.from({ length: n }, () => word).join(' ');
  const cow = (src: string, input = '', limit = 1_000_000) => runCow(src, utf8Encode(input), limit);
  const printed = (src: string, input = '') => utf8Decode(cow(src, input).output);
  /** 7 * 10 = 70 = "F" */
  const PRINT_F = `moO ${rep('MoO', 7)} MOO mOo ${rep('MoO', 10)} moO MOo moo mOo Moo`;

  it('knows the twelve instructions, numbered in order', () => {
    const all = 'moo mOo moO mOO Moo MOo MoO MOO OOO MMM OOM oom';
    expect(Array.from(tokenizeCow(all).ops)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // Spaces are optional and anything else is a comment; the case matters.
    expect(Array.from(tokenizeCow('MoOMoOMoo').ops)).toEqual([6, 6, 4]);
    expect(Array.from(tokenizeCow('hello MoO! (then) Moo.').ops)).toEqual([6, 4]);
    expect(Array.from(tokenizeCow('OOo ooM Mmm mmm MMM').ops)).toEqual([9]);
  });

  it('runs a loop and prints with Moo', async () => {
    expect(printed(PRINT_F)).toBe('F');
    expect(utf8Decode(await output(PRINT_F))).toBe('F');
    expect(printed(`${rep('MoO', 65)} Moo`)).toBe('A');
  });

  it('OOO clears the cell, OOM prints it as a number with no separator', () => {
    expect(printed(`${rep('MoO', 12)} OOM`)).toBe('12');
    expect(printed(`${rep('MoO', 12)} OOM OOM`)).toBe('1212');
    expect(printed(`${rep('MoO', 12)} OOO OOM`)).toBe('0');
  });

  it('keeps 32-bit cells, and prints the low 8 bits of a character', () => {
    expect(printed(`${rep('MoO', 321)} OOM`)).toBe('321');
    expect(Array.from(cow(`${rep('MoO', 321)} Moo`).output)).toEqual([65]);
    expect(printed('MOo OOM')).toBe('-1');
    expect(Array.from(cow('MOo Moo').output)).toEqual([255]);
  });

  it('MMM copies the cell into the register, then pastes it and empties it', () => {
    // cell 0 = 3: copy; move on; paste into cell 1; print both cells.
    expect(printed('MoO MoO MoO MMM moO MMM OOM mOo OOM')).toBe('33');
    // After a paste the register is empty again: this copies (1), changes, pastes (back to 1).
    expect(printed('MoO MMM MoO MoO MMM OOM')).toBe('1');
    // Copy, clear, paste it back; the next MMM then copies again.
    expect(printed('MoO MoO MMM OOO MMM OOM MMM OOM')).toBe('22');
  });

  it('Moo reads a byte when the cell is 0 and prints when it is not', () => {
    expect(printed('Moo Moo', 'A')).toBe('A');
    const cat = 'Moo MOO Moo OOO Moo moo';
    expect(printed(cat, 'hi!')).toBe('hi!');
    expect(printed(cat, '')).toBe('');
    // End of input reads 0.
    expect(printed('Moo OOM', '')).toBe('0');
  });

  it('oom reads a decimal number', () => {
    expect(printed('oom OOM oom OOM oom OOM', '-42 7')).toBe('-4270');
    expect(printed('oom OOM', 'abc 12 def')).toBe('12');
  });

  it('mOO runs the value in the cell as an instruction', () => {
    expect(printed(`${rep('MoO', 6)} mOO OOM`)).toBe('7'); // 6 is MoO: add one
    expect(printed(`${rep('MoO', 10)} mOO`)).toBe('10'); // 10 is OOM: print
    expect(printed(`${rep('MoO', 8)} mOO OOM`)).toBe('0'); // 8 is OOO: clear
    expect(Array.from(cow(`${rep('MoO', 4)} mOO`).output)).toEqual([4]); // 4 is Moo: print
    // 0 is moo: go back to the matching MOO, which then sees the cell is 0 and leaves the loop.
    expect(printed('MoO MOO MOo mOO moo OOM')).toBe('0');
  });

  it('ends the program, keeping its output, when mOO runs a value that is no instruction', () => {
    // The language says an invalid command exits the program: no error, whatever was printed stays.
    const three = cow(`${rep('MoO', 3)} mOO MoO MoO OOM`);
    expect(three.stopped).toBe('finished');
    expect(three.output.length).toBe(0);
    expect(three.notes?.join(' ')).toMatch(/mOO ran the cell value 3.*mOO itself.*ends there/);
    const twelve = cow(`${rep('MoO', 12)} mOO OOM`);
    expect(twelve.stopped).toBe('finished');
    expect(twelve.notes?.join(' ')).toMatch(/cell value 12.*numbered 0 to 11/);
    const negative = cow('MOo mOO OOM');
    expect(negative.stopped).toBe('finished');
    expect(negative.notes?.join(' ')).toMatch(/cell value -1/);
    // Output printed before the invalid mOO is kept ("A", then stop; the 3 in the cell is invalid).
    expect(printed(`${rep('MoO', 65)} Moo OOO ${rep('MoO', 3)} mOO OOM`)).toBe('A');
  });

  it('matches loops, and says where one is not closed', () => {
    // Nested loops: cell 0 counts 3 rounds, cell 1 counts 2, cell 2 gets +5 each: 30; plus 35 = "A".
    const nested = [
      rep('MoO', 3),
      'MOO',
      `moO ${rep('MoO', 2)}`,
      'MOO',
      `moO ${rep('MoO', 5)} mOo MOo`,
      'moo',
      'mOo MOo',
      'moo',
      `moO moO ${rep('MoO', 35)} Moo`,
    ].join(' ');
    expect(printed(nested)).toBe('A');
    expect(() => cow('moo')).toThrow(/Unmatched "moo" at line 1, column 1/);
    expect(() => cow('MoO MOO')).toThrow(/Unmatched "MOO" at line 1, column 5/);
    expect(() => cow('MoO\nMOO')).toThrow(/Unmatched "MOO" at line 2, column 1/);
  });

  it('skips a loop whose cell is 0 and counts loop control as steps', () => {
    expect(printed('MOO MoO MoO moo OOM')).toBe('0');
    const r = cow('MoO MOO MOo moo');
    expect(r.steps).toBe(5); // MoO, MOO, MOo, moo, then MOO again (cell is 0, leaves)
    expect(r.stopped).toBe('finished');
  });

  it('stops infinite loops at the step limit', () => {
    const r = cow('MoO MOO moo', '', 1000);
    expect(r.stopped).toBe('step-limit');
    expect(r.steps).toBe(1000);
  });

  it('refuses to go left of the first cell, and grows to the right', () => {
    expect(() => cow('mOo')).toThrow(/left of the first cell/);
    expect(printed(`${rep('moO', 40_000)} MoO OOM`)).toBe('1');
  });

  it('runs through the tool, detected or chosen', async () => {
    expect(utf8Decode(await output(PRINT_F))).toBe('F');
    expect(resultToText(await run(PRINT_F))).toContain('COW (auto-detected)');
    expect(resultToText(await run(PRINT_F, { language: 'cow' }))).toContain('COW:');
    expect(
      utf8Decode(await output('Moo MOO Moo OOO Moo moo', { language: 'cow', input: 'cat' })),
    ).toBe('cat');
    await expect(run('nothing', { language: 'cow' })).rejects.toThrow(/No COW instructions/);
  });
});

// ---------------------------------------------------------------------------------------------
// Deadfish
// ---------------------------------------------------------------------------------------------

describe('Deadfish', () => {
  const fish = (src: string, format: 'numbers' | 'chars' = 'numbers', limit = 1_000_000) =>
    runDeadfish(src, 'deadfish', limit, format);
  const xkcd = (src: string, format: 'numbers' | 'chars' = 'numbers') =>
    runDeadfish(src, 'xkcd-deadfish', 1_000_000, format);

  it('adds, subtracts, squares and prints the accumulator', () => {
    expect(fish('iiio').values).toEqual([3]);
    expect(utf8Decode(fish('iiio').output)).toBe('3\n');
    expect(fish('iiisoddo').values).toEqual([9, 7]);
    expect(fish('o').values).toEqual([0]);
    expect(fish('iiisiso').values).toEqual([100]); // 3 -> 9 -> 10 -> 100
  });

  it('resets the accumulator when it reaches 256 or -1', () => {
    expect(fish('iiiisso').values).toEqual([0]); // 4 -> 16 -> 256 -> 0
    expect(fish('iiiissso').values).toEqual([0]);
    expect(fish('do').values).toEqual([0]); // -1 -> 0
    expect(fish('iddo').values).toEqual([0]);
    expect(fish('iiiisdo').values).toEqual([15]); // 16 -> 15: no reset
    expect(fish(`${'i'.repeat(255)}io`).values).toEqual([0]); // 255 + 1
    expect(fish(`${'i'.repeat(255)}o`).values).toEqual([255]);
  });

  it('wraps like a 32-bit integer when squares get big', () => {
    // 17 -> 289 -> 83521 -> 83521^2 mod 2^32, as a signed value
    const expected = Number(BigInt.asIntN(32, 83521n * 83521n));
    expect(fish(`${'i'.repeat(17)}sso`).values).toEqual([83521]);
    expect(fish(`${'i'.repeat(17)}ssso`).values).toEqual([expected]);
    expect(expected).toBeLessThan(0);
  });

  it('prints numbers, or one character per o', () => {
    const program = 'iiiiiiiisiiiiiioiiiiiiiiiiiiiioddddddddddddddo';
    expect(fish(program).values).toEqual([70, 84, 70]);
    expect(utf8Decode(fish(program, 'numbers').output)).toBe('70\n84\n70\n');
    expect(utf8Decode(fish(program, 'chars').output)).toBe('FTF');
    // 21 -> 441 -> 194481, and 194481 mod 256 = 177
    expect(fish(`${'i'.repeat(21)}sso`).values).toEqual([194481]);
    expect(Array.from(fish(`${'i'.repeat(21)}sso`, 'chars').output)).toEqual([177]);
  });

  it('ignores other characters and accepts capitals', () => {
    expect(fish('II ss O xyz\n').values).toEqual([16]);
    expect(fish('i i, i; i. o!').values).toEqual([4]);
    // x, k, c mean nothing here; "d" takes -1 back to 0 and the "o" of "hello" prints it.
    expect(fish('xkcd? hello').values).toEqual([0]);
  });

  it('XKCD Deadfish is the same language spelled x d k c', () => {
    expect(xkcd('xxkdc').values).toEqual([3]);
    expect(xkcd('xxxxkkc').values).toEqual([0]); // 4 -> 16 -> 256 -> 0
    expect(xkcd('dc').values).toEqual([0]);
    expect(utf8Decode(xkcd('xxxxxxxxkxxxxxxc', 'chars').output)).toBe('F');
    // The Deadfish letters mean nothing here, and the other way round.
    expect(xkcd('iiso').values).toEqual([]);
    expect(fish('xxkc').values).toEqual([]);
  });

  it('counts commands as steps and stops at the limit', () => {
    expect(fish('iiio').steps).toBe(4);
    const r = fish('iiiiiiiiiio', 'numbers', 3);
    expect(r.stopped).toBe('step-limit');
    expect(r.steps).toBe(3);
    expect(r.values).toEqual([]);
  });

  it('writes a program for any text, in either spelling, and it round-trips', () => {
    const everyByte = Array.from({ length: 256 }, (_, i) => i);
    for (const variant of ['deadfish', 'xkcd-deadfish'] as const) {
      const program = valuesToDeadfish(everyByte, variant);
      const r = runDeadfish(program, variant, 1_000_000, 'numbers');
      expect(r.values).toEqual(everyByte);
      expect(valuesToDeadfish([70], variant).length).toBeLessThan(25);
    }
    // The shortest way to 5 is i i s i (1, 2, 4, 5): not five i.
    const fives = valuesToDeadfish([5, 5, 5], 'deadfish');
    expect(fives).toBe('iisiooo');
    expect(fish(fives).values).toEqual([5, 5, 5]);
    expect(valuesToDeadfish([], 'deadfish')).toBe('');
    // Text with repeated and decreasing letters.
    const text = utf8Encode('flag{deadfish_is_fun}');
    const program = valuesToDeadfish(Array.from(text), 'deadfish');
    expect(utf8Decode(runDeadfish(program, 'deadfish', 1_000_000, 'chars').output)).toBe(
      'flag{deadfish_is_fun}',
    );
  });

  it('recognises programs that are only Deadfish letters', () => {
    expect(deadfishVariantOf('iiisdsiiio')).toBe('deadfish');
    expect(deadfishVariantOf('  IIS \n O ')).toBe('deadfish');
    expect(deadfishVariantOf('xxkdkc')).toBe('xkcd-deadfish');
    expect(deadfishVariantOf('iiii')).toBeNull(); // never prints
    expect(deadfishVariantOf('io')).toBeNull(); // too short to tell
    expect(deadfishVariantOf('iisoq')).toBeNull();
    expect(deadfishVariantOf('hello world')).toBeNull();
    expect(deadfishVariantOf('')).toBeNull();
  });

  it('works through the tool, with the ASCII reading next to the numbers', async () => {
    const program = valuesToDeadfish([70, 84, 70], 'deadfish');
    const numbers = await run(program);
    const text = resultToText(numbers);
    expect(text).toContain('Deadfish (auto-detected)');
    expect(text).toContain('70\n84\n70\n');
    expect(text).toContain('Numbers read as ASCII\nFTF');
    const chars = resultToText(await run(program, { deadfish: 'chars' }));
    expect(chars).toContain('Program output\nFTF');
    expect(chars).not.toContain('Numbers read as ASCII');
    // Values that are not bytes get no ASCII reading.
    expect(resultToText(await run(`${'i'.repeat(17)}sso`))).not.toContain('read as ASCII');
    expect(resultToText(await run('xxkc'))).toContain('XKCD Deadfish (auto-detected)');
  });

  it('asks for commands when there are none', async () => {
    await expect(run('xyz', { language: 'deadfish' })).rejects.toThrow(
      /No Deadfish commands found.*i d s o/,
    );
    await expect(run('iiso', { language: 'xkcd-deadfish' })).rejects.toThrow(/x d k c/);
    await expect(run('xxkc', { language: 'deadfish' })).rejects.toThrow(/No Deadfish commands/);
  });
});

// ---------------------------------------------------------------------------------------------
// Befunge-93
// ---------------------------------------------------------------------------------------------

describe('Befunge-93', () => {
  const befunge = (src: string, input = '', limit = 1_000_000, seed = 1) =>
    runBefunge(src, utf8Encode(input), limit, seed);
  const printed = (src: string, input = '', seed = 1) =>
    utf8Decode(befunge(src, input, 1_000_000, seed).output);

  /** Build a playfield from pieces: field([x, y, text, vertical?], ...). */
  function field(...pieces: [x: number, y: number, text: string, vertical?: boolean][]): string {
    const grid = Array.from({ length: 25 }, () => Array.from({ length: 80 }, () => ' '));
    for (const [x, y, text, vertical] of pieces) {
      [...text].forEach((ch, i) => {
        grid[y + (vertical ? i : 0)]![x + (vertical ? 0 : i)] = ch;
      });
    }
    return grid.map((row) => row.join('').trimEnd()).join('\n');
  }

  /** A `?` in the corner with a different letter printed for each of the four ways out. */
  const RANDOM_WALK = field(
    [0, 0, '?'],
    [1, 0, '"R",@'],
    [75, 0, '@,"L"'],
    [0, 20, '@,"U"', true],
    [0, 1, '"D",@', true],
  );

  it('prints Hello, World! with a string and a loop', () => {
    expect(printed('>"!dlroW ,olleH">:#,_@')).toBe('Hello, World!');
    expect(printed('"!dlroW ,olleH">:#,_@')).toBe('Hello, World!');
  });

  it('does arithmetic with the operands in the right order', () => {
    expect(printed('95-.@')).toBe('4 '); // 9 - 5
    expect(printed('59-.@')).toBe('-4 '); // 5 - 9
    expect(printed('82/.@')).toBe('4 '); // 8 / 2
    expect(printed('28/.@')).toBe('0 '); // 2 / 8
    expect(printed('73%.@')).toBe('1 '); // 7 mod 3
    expect(printed('37%.@')).toBe('3 '); // 3 mod 7
    expect(printed('76*.@')).toBe('42 ');
    expect(printed('76+.@')).toBe('13 ');
  });

  it('truncates division and keeps the sign of the dividend, like C', () => {
    expect(printed('07-2/.@')).toBe('-3 '); // -7 / 2
    expect(printed('07-3%.@')).toBe('-1 '); // -7 mod 3
    expect(printed('07-03-/.@')).toBe('2 '); // -7 / -3
    expect(printed('07-03-%.@')).toBe('-1 '); // -7 mod -3
  });

  it('wraps to 32 bits', () => {
    // 9 squared four times: 81, 6561, 43046721, and then more than fits.
    let v = 9;
    for (let i = 0; i < 4; i++) v = Math.imul(v, v);
    expect(printed('9:*:*:*:*.@')).toBe(`${v} `);
    expect(v).not.toBe(43046721 ** 2);
    expect(printed('9:*:*:*:*:*.@')).toBe(`${Math.imul(v, v)} `);
  });

  it('pops zero from an empty stack', () => {
    expect(printed('.@')).toBe('0 ');
    expect(printed(':.@')).toBe('0 ');
    expect(printed('+.@')).toBe('0 ');
    expect(printed('5$.@')).toBe('0 ');
    expect(printed(',@')).toBe('\0');
  });

  it('has not, greater than, dup and swap', () => {
    expect(printed('0!.5!.@')).toBe('1 0 ');
    expect(printed('31`.13`.33`.@')).toBe('1 0 0 '); // 3 > 1, 1 > 3, 3 > 3
    expect(printed('3:*.@')).toBe('9 ');
    expect(printed('12\\-.@')).toBe('1 '); // swapped: 2 - 1
    expect(printed('12-.@')).toBe('-1 '); // not swapped: 1 - 2
    expect(printed('123$..@')).toBe('2 1 ');
  });

  it('prints numbers with a space after them, and characters as bytes', () => {
    expect(printed('76*.76+.@')).toBe('42 13 ');
    expect(printed('07-.@')).toBe('-7 ');
    expect(Array.from(befunge('"A",@').output)).toEqual([65]);
    expect(Array.from(befunge('01-,@').output)).toEqual([255]); // -1: the low byte
  });

  it('string mode pushes every character, spaces included', () => {
    expect(printed('"abc",,,@')).toBe('cba');
    expect(printed('" ".@')).toBe('32 ');
    expect(printed('"a b",,,@')).toBe('b a');
  });

  it('turns with > < ^ v and wraps around the edges of the 80 x 25 torus', () => {
    // Going left from the first cell comes out of the last column.
    const horizontal = befunge(`<${' '.repeat(78)}@`);
    expect(horizontal.stopped).toBe('finished');
    expect(horizontal.steps).toBe(2);
    // Going up from the first row comes out of the last row.
    const vertical = befunge(field([0, 0, '^'], [0, 24, '@']));
    expect(vertical.stopped).toBe('finished');
    expect(vertical.steps).toBe(2);
    // Going right off the end of the line comes back at the start: this never ends.
    expect(befunge(' '.repeat(79) + '>', '', 500).stopped).toBe('step-limit');
    // Down a column.
    expect(printed(field([0, 0, 'v'], [0, 1, '"x"', true], [0, 4, ',@', true]))).toBe('x');
  });

  it('# jumps over the next cell', () => {
    expect(printed('1#2.@')).toBe('1 ');
    expect(printed('1#2.#.@')).toBe('1 ');
    // ... also going down: the "@" right below the # is skipped.
    expect(
      printed(field([0, 0, 'v'], [0, 1, '#', true], [0, 2, '@', true], [0, 3, '5.@', true])),
    ).toBe('5 ');
  });

  it('_ and | pick a direction from the top of the stack', () => {
    // Row 1 holds both exits: east is `"E",@`, west goes through the left edge and comes back from
    // the last column (`"` at x = 0, `W` at x = 79 ... `@` at x = 76).
    const horizontal = (value: string) =>
      field([0, 0, `${value}v`], [0, 1, '"_"E",@'], [76, 1, '@,"W']);
    expect(printed(horizontal('0'))).toBe('E');
    expect(printed(horizontal('1'))).toBe('W');
    expect(printed(horizontal('7'))).toBe('W');
    // Zero goes down, anything else goes up (and comes in from the bottom edge).
    const vertical = (value: string) =>
      field([0, 0, `${value}|`], [1, 1, '"D",@', true], [1, 20, '@,"U"', true]);
    expect(printed(vertical('0'))).toBe('D');
    expect(printed(vertical('1'))).toBe('U');
    expect(printed(vertical('9'))).toBe('U');
  });

  it('p puts a character in the playfield and g gets one', () => {
    // Without the p this would run along the row for ever; with it the cell at x = 9 is "@".
    const put = befunge('"@"90p');
    expect(put.stopped).toBe('finished');
    expect(put.steps).toBe(10);
    expect(printed('30g.@')).toBe('46 '); // the "." at x = 3
    expect(printed('00g.@')).toBe('48 '); // the "0" at x = 0 (character code 48)
    // Values bigger than a byte survive: 729 goes to (0, 1), and comes back.
    expect(printed('99*9*01p01g.@')).toBe('729 ');
    // A written instruction can be run: "." goes to x = 7, which prints the 5 below it.
    expect(printed('5"."70p @')).toBe('5 ');
    expect(printed('5"x"70p @')).toBe('');
  });

  it('p and g outside the playfield do nothing, and are reported', async () => {
    const r = befunge('99*0g.701-0p@'); // g at x = 81, p at x = -1
    expect(utf8Decode(r.output)).toBe('0 ');
    expect(r.notes?.join('\n')).toContain('outside the 80x25 grid 2 time(s)');
    expect(printed('01-0g.@')).toBe('0 ');
    const text = resultToText(await run('99*0g.@'));
    expect(text).toContain('Befunge-93 (auto-detected)');
    expect(text).toContain('outside the 80x25 grid 1 time(s)');
  });

  it('division and modulo by zero push 0 and are reported', async () => {
    expect(printed('50/.@')).toBe('0 ');
    expect(printed('50%.@')).toBe('0 ');
    const text = resultToText(await run('50/.50%.@', { language: 'befunge' }));
    expect(text).toContain('0 0 ');
    expect(text).toContain('Division or modulo by zero happened 2 time(s)');
  });

  it('reads numbers with & and characters with ~', () => {
    expect(printed('&.@', '123')).toBe('123 ');
    expect(printed('&&+.@', '20 22')).toBe('42 ');
    expect(printed('&.&.@', 'abc -7 x9')).toBe('-7 9 ');
    expect(printed('~,~,@', 'hi')).toBe('hi');
    expect(printed('~~,,@', 'ab')).toBe('ba');
    expect(printed('~.@', 'A')).toBe('65 ');
  });

  it('reads -1 past the end of the input', () => {
    expect(printed('~.@')).toBe('-1 ');
    expect(printed('&.@')).toBe('-1 ');
    expect(printed('~~.@', 'a')).toBe('-1 ');
    expect(printed('&.&.@', '5')).toBe('5 -1 ');
  });

  it('copies the input with a loop that stops on -1 (cat)', () => {
    // Read c, keep c and c + 1; c + 1 is 0 only at the end of the input.
    const cat = field([0, 0, '>~:1+v'], [0, 1, '^,   _@']);
    expect(printed(cat, 'meow')).toBe('meow');
    expect(printed(cat, '')).toBe('');
    expect(printed(cat, 'a b\nc')).toBe('a b\nc');
  });

  it('? takes the same path for the same seed, and every way over many seeds', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const out = printed(RANDOM_WALK, '', seed);
      expect(printed(RANDOM_WALK, '', seed)).toBe(out);
      seen.add(out);
    }
    expect([...seen].sort()).toEqual(['D', 'L', 'R', 'U']);
  });

  it('stops at the step limit and says so', async () => {
    const forever = befunge('><', '', 1234);
    expect(forever.stopped).toBe('step-limit');
    expect(forever.steps).toBe(1234);
    const text = resultToText(await run('><', { language: 'befunge', steps: 5000 }));
    expect(text).toContain('Stopped at the step limit (5 000 steps)');
    const t0 = Date.now();
    expect(resultToText(await run('><', { language: 'befunge' }))).toContain('10 000 000 steps');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('stops a program that only pushes, instead of eating all the memory', () => {
    const r = befunge('1'.padEnd(79, ':'), '', 30_000_000);
    expect(r.stopped).toBe('error');
    expect(r.notes?.join('')).toContain('stack grew past');
  });

  it('ignores unknown characters, trailing spaces and Windows line ends', () => {
    expect(printed('Q7.@')).toBe('7 ');
    expect(printed(`7.@${' '.repeat(200)}`)).toBe('7 ');
    expect(printed('7.@\r\n')).toBe('7 ');
    expect(printed('7.v\r\n  @')).toBe('7 ');
  });

  it('refuses programs that do not fit in 80 x 25', async () => {
    expect(() => loadBefunge('a\n'.repeat(26))).toThrow(/at most 25 lines, but this one has 26/);
    expect(() => loadBefunge('a'.repeat(81))).toThrow(/at most 80 columns wide, but line 1/);
    expect(() => loadBefunge(`@\n${' '.repeat(5)}${'a'.repeat(76)}`)).toThrow(/line 2 has 81/);
    expect(() => loadBefunge('@\n'.repeat(25))).not.toThrow();
    expect(() => loadBefunge('a'.repeat(80))).not.toThrow();
    expect(() => loadBefunge('  \n\n')).toThrow(ToolError);
    await expect(run('a\n'.repeat(26), { language: 'befunge' })).rejects.toThrow(ToolError);
    await expect(run('', { language: 'befunge' })).rejects.toThrow(/Paste a Befunge-93 program/);
  });

  it('works through the tool, detected or chosen, with the seed option', async () => {
    const text = resultToText(await run('>"!egnufeB ,olleH">:#,_@'));
    expect(text).toContain('Befunge-93 (auto-detected)');
    expect(text).toContain('Hello, Befunge!');
    expect(utf8Decode(await output('&&+.@', { language: 'befunge', input: '1 2' }))).toBe('3 ');
    const a = await output(RANDOM_WALK, { language: 'befunge', seed: 3 });
    expect(await output(RANDOM_WALK, { language: 'befunge', seed: 3 })).toEqual(a);
    const outs = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      outs.add(utf8Decode(await output(RANDOM_WALK, { language: 'befunge', seed })));
    }
    expect(outs.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Malbolge
// ---------------------------------------------------------------------------------------------

/** The textbook crazy operation on strings of trits, unlike the table lookup in the tool. */
function refCrazy(a: number, d: number): number {
  const rows = ['100', '102', '221']; // [trit of d][trit of a]
  const A = a.toString(3).padStart(10, '0');
  const D = d.toString(3).padStart(10, '0');
  let out = '';
  for (let i = 0; i < 10; i++) out += rows[Number(D[i])]![Number(A[i])]!;
  return parseInt(out, 3);
}
function refRotr(v: number): number {
  const t = v.toString(3).padStart(10, '0');
  return parseInt(t.slice(-1) + t.slice(0, -1), 3);
}

/**
 * A slow, separate Malbolge machine to compare the tool with: base 3 strings for the arithmetic,
 * and memory beyond the program computed only when something reads or writes it.
 */
function referenceMalbolge(real: string, input: Uint8Array, limit: number) {
  // The memory as loaded (extended on demand: the fill never sees later changes) and the words
  // the running program has changed since.
  const initial = [...real].filter((ch) => !/\s/.test(ch)).map((ch) => ch.charCodeAt(0));
  const changed = new Map<number, number>();
  const read = (i: number): number => {
    while (initial.length <= i) {
      const n = initial.length;
      initial.push(refCrazy(initial[n - 1]!, initial[n - 2]!));
    }
    return changed.get(i) ?? initial[i]!;
  };
  const write = (i: number, v: number) => void changed.set(i, v);
  let a = 0;
  let c = 0;
  let d = 0;
  let steps = 0;
  let inPos = 0;
  const out: number[] = [];
  let stopped: 'finished' | 'step-limit' | 'error' = 'finished';
  for (;;) {
    if (steps >= limit) {
      stopped = 'step-limit';
      break;
    }
    const word = read(c);
    if (word < 33 || word > 126) {
      stopped = 'error';
      break;
    }
    steps++;
    const instruction = (word + c) % 94;
    if (instruction === 81) break;
    if (instruction === 4) c = read(d);
    else if (instruction === 5) out.push(a % 256);
    else if (instruction === 23) a = inPos < input.length ? input[inPos++]! : 59048;
    else if (instruction === 39) {
      a = refRotr(read(d));
      write(d, a);
    } else if (instruction === 40) d = read(d);
    else if (instruction === 62) {
      a = refCrazy(a, read(d));
      write(d, a);
    }
    const next = read(c);
    if (next < 33 || next > 126) {
      stopped = 'error';
      break;
    }
    write(c, encrypt(next));
    c = (c + 1) % 59049;
    d = (d + 1) % 59049;
  }
  return { output: Uint8Array.from(out), steps, stopped };
}

describe('Malbolge', () => {
  // Well-known "Hello, world" programs. They print what their names say, which is how the
  // interpreter was checked: any slip in the crazy operation, the encryption table, the jump
  // rule or the rotation would print garbage instead.
  const HELLO_WORLD = '(=<`#9]~6ZY32Vx/4Rs+0No-&Jk)"Fh}|Bcy?`=*z]Kw%oG4UUS0/@-ejc(:\'8dc';
  const HELLO_COMMA =
    "(=<`:9876Z4321UT.-Q+*)M'&%$H\"!~}|Bzy?=|{z]KwZY44Eq0/{mlk**hKs_dG5[m_BA{?-Y;;Vb'rR5431M}/.zHGwEDCBA@98\\6543W10/.R,+O<";
  const malbolge = (src: string, input = '', limit = 1_000_000, normalised = false) =>
    runMalbolge(src, utf8Encode(input), limit, normalised);

  it('runs the well-known Hello World programs', async () => {
    const a = malbolge(HELLO_WORLD);
    expect(utf8Decode(a.output)).toBe('Hello World!');
    expect(a.stopped).toBe('finished');
    expect(a.steps).toBe(40); // counting the final "end" instruction
    const b = malbolge(HELLO_COMMA);
    expect(utf8Decode(b.output)).toBe('Hello, world.');
    expect(b.steps).toBe(55);
    expect(utf8Decode(await output(HELLO_WORLD))).toBe('Hello World!');
    expect(resultToText(await run(HELLO_COMMA))).toContain('Malbolge (auto-detected)');
  });

  it('ignores white space inside the program', () => {
    const wrapped = HELLO_COMMA.replace(/(.{10})/g, '$1\n  ').replace(/ /g, ' \t');
    expect(utf8Decode(malbolge(wrapped).output)).toBe('Hello, world.');
  });

  it('crazy is tritwise with the documented table', () => {
    // Rows: the trit of D. Columns: the trit of A.
    const table = [
      [1, 0, 0],
      [1, 0, 2],
      [2, 2, 1],
    ];
    // (The nine higher trits are all 0 and 0, which the table turns into 1: that adds 29523.)
    for (let d = 0; d < 3; d++) {
      for (let a = 0; a < 3; a++) expect(crazy(a, d), `a=${a} d=${d}`).toBe(table[d]![a]! + 29523);
    }
    expect(crazy(0, 0)).toBe(29524); // ten trits of 1
    // And on whole words: against the string version, for all trit patterns we care about.
    let seed = 99;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) % 59049;
    for (let i = 0; i < 3000; i++) {
      const a = next();
      const d = next();
      expect(crazy(a, d), `a=${a} d=${d}`).toBe(refCrazy(a, d));
    }
    expect(crazy(59048, 59048)).toBe(refCrazy(59048, 59048));
    expect(crazy(59048, 0)).toBe(refCrazy(59048, 0));
  });

  it('rotr moves the last trit to the front', () => {
    expect(rotr(0)).toBe(0);
    expect(rotr(1)).toBe(19683); // 3^9: the 1 comes back in at the top
    expect(rotr(3)).toBe(1);
    expect(rotr(2)).toBe(39366);
    expect(rotr(19683)).toBe(6561);
    for (const v of [5, 40, 12345, 59048, 29524]) {
      expect(rotr(v)).toBe(refRotr(v));
      let w = v;
      for (let i = 0; i < 10; i++) w = rotr(w);
      expect(w).toBe(v); // ten rotations of ten trits is the identity
    }
  });

  it('encrypts through the 94 character table, which is a permutation', () => {
    const seen = new Set<number>();
    for (let w = 33; w <= 126; w++) {
      const e = encrypt(w);
      expect(e).toBeGreaterThanOrEqual(33);
      expect(e).toBeLessThanOrEqual(126);
      seen.add(e);
    }
    expect(seen.size).toBe(94);
    expect(String.fromCharCode(encrypt(33))).toBe('5');
    expect(String.fromCharCode(encrypt(126))).toBe('@');
  });

  it('loads the program, then fills memory with crazy(previous, the one before)', () => {
    const mem = loadMalbolge(HELLO_WORLD);
    expect(mem.length).toBe(MALBOLGE_SIZE);
    const n = HELLO_WORLD.length;
    expect(String.fromCharCode(mem[0]!)).toBe('(');
    expect(String.fromCharCode(mem[n - 1]!)).toBe('c');
    expect(mem[n]).toBe(refCrazy(mem[n - 1]!, mem[n - 2]!));
    expect(mem[n + 1]).toBe(refCrazy(mem[n]!, mem[n - 1]!));
    expect(mem[MALBOLGE_SIZE - 1]).toBe(refCrazy(mem[MALBOLGE_SIZE - 2]!, mem[MALBOLGE_SIZE - 3]!));
    expect(Math.max(...mem)).toBeLessThan(MALBOLGE_SIZE);
  });

  it('accepts only characters that are an instruction at their own address', () => {
    expect(isMalbolgeProgram(HELLO_WORLD)).toBe(true);
    expect(isMalbolgeProgram(HELLO_COMMA)).toBe(true);
    expect(isMalbolgeProgram('')).toBe(false);
    expect(isMalbolgeProgram('(=<')).toBe(false); // valid but too short to be sure
    expect(isMalbolgeProgram('(=<', 3)).toBe(true);
    expect(isMalbolgeProgram('Hello, World! This is not Malbolge.')).toBe(false);
    // Change the 11th character (index 10) to one that means nothing at that address.
    const broken = `${HELLO_WORLD.slice(0, 10)}Z${HELLO_WORLD.slice(11)}`;
    expect(() => malbolge(broken)).toThrow(
      /"Z" at line 1, column 11 \(instruction 11\) is not a valid Malbolge instruction at that position/,
    );
    // The line and column are those of the text, not of the instruction count.
    expect(() => malbolge(`${HELLO_WORLD.slice(0, 5)}\n\n  ${HELLO_WORLD.slice(5, 10)}Z`)).toThrow(
      /at line 3, column 8 \(instruction 11\)/,
    );
  });

  it('refuses what cannot be a program', () => {
    expect(() => malbolge('(=<é')).toThrow(/not printable ASCII/);
    expect(() => malbolge('(')).toThrow(/at least two instructions/);
    expect(() => malbolge('   ')).toThrow(/at least two instructions/);
    const tooLong = denormaliseMalbolge('o'.repeat(MALBOLGE_SIZE + 1));
    expect(() => malbolge(tooLong)).toThrow(/longer than Malbolge memory/);
    expect(() => malbolge(denormaliseMalbolge('o'.repeat(MALBOLGE_SIZE)), '', 10)).not.toThrow();
  });

  it('writes a program in mnemonics and back (the normalised form)', () => {
    expect(denormaliseMalbolge('j')).toBe('('); // address 0: code 40 + 0
    expect(denormaliseMalbolge('jp')).toBe('(='); // address 1 needs 61 to make 62
    expect(normaliseMalbolge(HELLO_WORLD).startsWith('jpp<')).toBe(true);
    for (const program of [HELLO_WORLD, HELLO_COMMA]) {
      const normalised = normaliseMalbolge(program);
      expect(normalised).toMatch(/^[i<*/jpov]+$/);
      expect(normalised.length).toBe(program.length);
      expect(denormaliseMalbolge(normalised)).toBe(program);
      // Spaces and line breaks do not count as addresses.
      expect(denormaliseMalbolge(normalised.replace(/(.{7})/g, '$1 \n'))).toBe(program);
    }
    expect(normaliseMalbolge('(Z')).toBe('j?'); // the second character is no instruction at address 1
    expect(() => denormaliseMalbolge('jpx')).toThrow(
      /"x" at line 1, column 3 is not a normalised Malbolge operation/,
    );
    // The address makes the difference: the same mnemonic is a different character each time.
    expect(new Set(denormaliseMalbolge('o'.repeat(20))).size).toBe(20);
  });

  it('runs a program given in normalised form', async () => {
    const normalised = normaliseMalbolge(HELLO_COMMA);
    expect(utf8Decode(malbolge(normalised, '', 1_000_000, true).output)).toBe('Hello, world.');
    const text = resultToText(await run(normalised, { language: 'malbolge-normalized' }));
    expect(text).toContain('Hello, world.');
    expect(text).toContain('Malbolge (normalised):');
    expect(text).toContain('Real Malbolge program');
    // Auto-detect recognises mnemonics-only text too.
    expect(resultToText(await run(normalised))).toContain('Malbolge (normalised) (auto-detected)');
    // The real program is shown (cut into lines, which Malbolge ignores).
    const real = await run(normalised, { language: 'malbolge-normalized' });
    const block = real.find((o: Output) => o.type === 'text');
    expect(block && block.type === 'text' ? block.value.replace(/\s/g, '') : '').toBe(HELLO_COMMA);
    await expect(run('jpx', { language: 'malbolge-normalized' })).rejects.toThrow(
      /not a normalised/,
    );
  });

  it('shows the normalised form next to the output of a real program', async () => {
    const out = await run(HELLO_WORLD);
    const block = out.find((o: Output) => o.type === 'text');
    expect(block && block.type === 'text' ? block.label : '').toContain('Normalised form');
    expect(block && block.type === 'text' ? block.value.replace(/\s/g, '') : '').toBe(
      normaliseMalbolge(HELLO_WORLD),
    );
  });

  it('reads input with "/" (59048 at the end) and prints with "<"', () => {
    // "/<v" in mnemonics: read a byte, print it, end.
    const echo = (input: string) => malbolge('/<v', input, 1000, true);
    expect(utf8Decode(echo('Z').output)).toBe('Z');
    expect(Array.from(echo('').output)).toEqual([59048 % 256]); // nothing left to read
    expect(Array.from(echo('ÿ').output)).toEqual([0xc3]); // UTF-8 "ÿ" is c3 bf: the first byte
    // Two reads in a row: the second byte is printed.
    expect(utf8Decode(malbolge('//<v', 'ab', 1000, true).output)).toBe('b');
  });

  it('ends at "v", and "o" does nothing', () => {
    const end = malbolge('vo', '', 1000, true);
    expect(end.steps).toBe(1);
    expect(end.stopped).toBe('finished');
    expect(end.output.length).toBe(0);
    const nops = malbolge('ooooo<v', '', 1000, true);
    expect(nops.steps).toBe(7);
    expect(Array.from(nops.output)).toEqual([0]); // A is still 0
  });

  it('does movd, rotr and crazy on the words they point at', () => {
    // "j" sets D to the first word (the character "(" = 40); the next instruction acts on mem[41].
    const memory = (program: string) => loadMalbolge(denormaliseMalbolge(program));
    const jrot = memory('j*<v');
    expect(Array.from(malbolge('j*<v', '', 1000, true).output)).toEqual([refRotr(jrot[41]!) % 256]);
    const jcrz = memory('jp<v');
    expect(Array.from(malbolge('jp<v', '', 1000, true).output)).toEqual([
      refCrazy(0, jcrz[41]!) % 256,
    ]);
    // A second crazy works on the first one's result.
    const two = memory('jpp<v');
    const first = refCrazy(0, two[41]!);
    expect(Array.from(malbolge('jpp<v', '', 1000, true).output)).toEqual([
      refCrazy(first, two[42]!) % 256,
    ]);
  });

  it('stops with an explanation when the word at C is not an instruction', () => {
    const r = malbolge('oo', '', 1000, true);
    expect(r.stopped).toBe('error');
    expect(r.steps).toBe(2);
    // Memory after the program is crazy(mem[1], mem[0]) = crazy(67, 68).
    expect(r.notes?.join('')).toContain(`the word at C is ${refCrazy(67, 68)}`);
    expect(refCrazy(67, 68)).toBeGreaterThan(126);
  });

  it('stops at the step limit and keeps the output so far', async () => {
    const r = malbolge(HELLO_COMMA, '', 30);
    expect(r.stopped).toBe('step-limit');
    expect(r.steps).toBe(30);
    expect(r.output.length).toBeLessThan(13);
    const text = resultToText(await run(HELLO_COMMA, { steps: 1000 }));
    expect(text).toContain('Hello, world.');
    expect(
      resultToText(await run(HELLO_COMMA, { steps: 1000, language: 'malbolge' })),
    ).not.toContain('Stopped at the step limit');
  });

  it('agrees with a separate, slow implementation on many variations of real programs', () => {
    let seed = 20240607;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const operations = 'ji*p</vo';
    const input = utf8Encode('xyz');
    const seen = { finished: 0, stopped: new Set<string>(), printed: 0 };
    for (let k = 0; k < 80; k++) {
      const base = normaliseMalbolge(k % 2 === 0 ? HELLO_WORLD : HELLO_COMMA).split('');
      for (let edits = 1 + (k % 3); edits > 0; edits--) {
        base[Math.floor(random() * base.length)] = operations[Math.floor(random() * 8)]!;
      }
      const program = denormaliseMalbolge(base.join(''));
      const mine = malbolge(program, 'xyz', 3000);
      const reference = referenceMalbolge(program, input, 3000);
      expect(
        { output: Array.from(mine.output), steps: mine.steps, stopped: mine.stopped },
        `program ${program}`,
      ).toEqual({
        output: Array.from(reference.output),
        steps: reference.steps,
        stopped: reference.stopped,
      });
      seen.stopped.add(mine.stopped);
      if (mine.stopped === 'finished') seen.finished++;
      if (mine.output.length > 0) seen.printed++;
    }
    // The comparison is only worth something if the programs did different things.
    expect(seen.finished).toBeGreaterThan(5);
    expect(seen.printed).toBeGreaterThan(5);
    expect(seen.stopped.size).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Detection, options, Text → program, examples
// ---------------------------------------------------------------------------------------------

describe('detecting the language', () => {
  const triage = (text: string | null) =>
    tool.detect?.({ text, bytes: new Uint8Array(text?.length ?? 4) }) ?? null;
  const FISH = valuesToDeadfish([70, 84, 70, 33], 'deadfish');
  const XKCD = valuesToDeadfish([70, 84, 70, 33], 'xkcd-deadfish');
  const MALBOLGE = '(=<`#9]~6ZY32Vx/4Rs+0No-&Jk)"Fh}|Bcy?`=*z]Kw%oG4UUS0/@-ejc(:\'8dc';
  const BEFUNGE = '>"!dlroW ,olleH">:#,_@';
  const COW = fromBrainfuck(HELLO, 'cow');

  it('Auto picks every language it can tell apart', () => {
    expect(detectLanguage(COW)).toBe('cow');
    expect(detectLanguage('MoO MoO Moo')).toBe('cow');
    expect(detectLanguage(fromBrainfuck(HELLO, 'blub'))).toBe('blub');
    expect(detectLanguage(fromBrainfuck(HELLO, 'pikalang'))).toBe('pikalang');
    expect(detectLanguage(fromBrainfuck(HELLO, 'alphuck'))).toBe('alphuck');
    expect(detectLanguage(FISH)).toBe('deadfish');
    expect(detectLanguage(XKCD)).toBe('xkcd-deadfish');
    expect(detectLanguage(MALBOLGE)).toBe('malbolge');
    expect(detectLanguage(normaliseMalbolge(MALBOLGE))).toBe('malbolge-normalized');
    expect(detectLanguage(BEFUNGE)).toBe('befunge');
    expect(detectLanguage('&&+.@')).toBe('befunge');
  });

  it('keeps Brainfuck for everything else, even with look-alike words in it', () => {
    expect(detectLanguage(HELLO)).toBe('brainfuck');
    expect(detectLanguage('++[>+<-]. @ moo')).toBe('brainfuck');
    expect(detectLanguage('++[>+<-].@')).toBe('brainfuck'); // an @ in a program with [ and ]
    expect(detectLanguage('Moo Moo Moo says the cow')).toBe('brainfuck');
    expect(detectLanguage('pi ka chu is a mouse')).toBe('brainfuck');
    expect(detectLanguage('hello world')).toBe('brainfuck');
    expect(detectLanguage('iiii')).toBe('brainfuck'); // Deadfish that never prints
    expect(detectLanguage('<<<<<<<<<<<<<<')).toBe('brainfuck'); // not mnemonics
  });

  it('Befunge needs an @ that the program really reaches', () => {
    expect(detectLanguage('>v\n^<')).toBe('brainfuck'); // loops forever, no @
    expect(detectLanguage('v\n<\n@')).toBe('brainfuck'); // goes round the row, never reaches the @
    expect(detectLanguage('v\n@')).toBe('befunge');
    expect(detectLanguage(`${'a\n'.repeat(30)}@`)).toBe('brainfuck'); // does not fit 80 x 25
  });

  it('suggests the tool, with the right language, for pasted programs', () => {
    expect(triage(COW)?.options).toEqual({ language: 'cow' });
    expect(triage(COW)?.score).toBeGreaterThanOrEqual(0.9);
    expect(triage(fromBrainfuck(HELLO, 'blub'))?.options).toEqual({ language: 'blub' });
    expect(triage(fromBrainfuck(HELLO, 'pikalang'))?.options).toEqual({ language: 'pikalang' });
    expect(triage(fromBrainfuck(HELLO, 'pikalang'))?.score).toBeGreaterThanOrEqual(0.85);
    expect(triage(FISH)?.options).toEqual({ language: 'deadfish' });
    expect(triage(XKCD)?.options).toEqual({ language: 'xkcd-deadfish' });
    expect(triage(MALBOLGE)?.options).toEqual({ language: 'malbolge' });
    expect(triage(MALBOLGE)?.score).toBeGreaterThanOrEqual(0.85);
    expect(triage(normaliseMalbolge(MALBOLGE))?.options).toEqual({
      language: 'malbolge-normalized',
    });
    expect(triage(BEFUNGE)?.options).toEqual({ language: 'befunge' });
    expect(triage(BEFUNGE)?.score).toBeGreaterThanOrEqual(0.7);
    expect(triage(fromBrainfuck(HELLO, 'alphuck'))?.options).toEqual({ language: 'alphuck' });
    expect(triage(fromBrainfuck(HELLO, 'alphuck'))?.score).toBeLessThan(0.6);
  });

  it('stays quiet about text that only looks a little like code', () => {
    expect(triage('iiio')).toBeNull();
    expect(triage('moo moo moo')).toBeNull();
    expect(triage('(=<')).toBeNull();
    expect(triage('Hello, World! This is not Malbolge at all, just a sentence.')).toBeNull();
    expect(triage('a person said: pi ka chu pikachu is cute')).toBeNull();
    expect(triage('>v\n^<')).toBeNull();
    expect(triage('cap pass')).toBeNull();
    expect(triage('SELECT * FROM users WHERE id = 1;')).toBeNull();
    expect(triage('def f(x):\n    return x @ x\n')).toBeNull();
  });
});

describe('options', () => {
  const options = tool.options!;
  const ALL: Language[] = [
    'brainfuck',
    'ook',
    'short-ook',
    'cow',
    'blub',
    'pikalang',
    'alphuck',
    'reversefuck',
    'deadfish',
    'xkcd-deadfish',
    'befunge',
    'malbolge',
    'malbolge-normalized',
  ];

  it('offers every language, with Auto first and as the default', () => {
    const choices = options.language.choices.map((c) => c.value);
    expect(choices[0]).toBe('auto');
    expect([...choices].sort()).toEqual(['auto', ...ALL].sort());
    expect(options.language.default).toBe('auto');
    expect(tool.name).toBe('Esoteric languages (Brainfuck, Ook!, Befunge, Malbolge…)');
  });

  it('shows each setting only where it matters', () => {
    const show = (key: 'input' | 'steps' | 'seed' | 'deadfish', mode: string, language: string) =>
      options[key].showIf?.({ mode, language }) ?? true;
    expect(show('seed', 'run', 'befunge')).toBe(true);
    expect(show('seed', 'run', 'brainfuck')).toBe(false);
    expect(show('seed', 'generate', 'befunge')).toBe(false);
    expect(show('deadfish', 'run', 'deadfish')).toBe(true);
    expect(show('deadfish', 'run', 'xkcd-deadfish')).toBe(true);
    expect(show('deadfish', 'run', 'befunge')).toBe(false);
    expect(show('input', 'run', 'cow')).toBe(true);
    expect(show('input', 'run', 'deadfish')).toBe(false);
    expect(show('input', 'generate', 'cow')).toBe(false);
    expect(show('steps', 'run', 'malbolge')).toBe(true);
  });

  it('has an example for every language that was added', () => {
    const labels = tool.examples.map((e) => e.label);
    for (const label of [
      'COW',
      'Blub',
      'Pikalang',
      'Alphuck',
      'ReverseFuck',
      'Deadfish',
      'XKCD Deadfish',
      'Befunge-93',
      'Malbolge',
    ]) {
      expect(labels, label).toContain(label);
    }
  });
});

describe('Text → program in the other languages', () => {
  const generated = async (text: string, language: Opts['language']) => {
    const out = await run(text, { mode: 'generate', language });
    const block = out.find((o: Output) => o.type === 'text');
    return block && block.type === 'text' ? block.value : '';
  };

  it('writes Blub, Pikalang, Alphuck, ReverseFuck and COW programs that print the text', async () => {
    for (const language of ['blub', 'pikalang', 'alphuck', 'reversefuck', 'cow'] as const) {
      const program = await generated('flag{generated} é✓', language);
      expect(utf8Decode(await output(program, { language })), language).toBe('flag{generated} é✓');
    }
    expect(resultToText(await run('hi', { mode: 'generate', language: 'cow' }))).toContain(
      'COW program',
    );
  });

  it('writes COW programs for every byte but 0 (Moo would read instead of print)', async () => {
    for (let b = 1; b < 256; b++) {
      const bf = textToBrainfuck(Uint8Array.of(b));
      expect(
        Array.from(runCow(fromBrainfuck(bf, 'cow'), new Uint8Array(0), 100_000).output),
      ).toEqual([b]);
    }
    await expect(run('a\0b', { mode: 'generate', language: 'cow' })).rejects.toThrow(
      /COW cannot print a zero byte/,
    );
  });

  it('turns "," into two COW instructions, since Moo only reads into a zero cell', () => {
    const program = fromBrainfuck(',[.,]', 'cow');
    expect(program.replace(/\s+/g, ' ')).toBe('OOO Moo MOO Moo OOO Moo moo');
    expect(utf8Decode(runCow(program, utf8Encode('echo'), 10_000).output)).toBe('echo');
  });

  it('writes Deadfish and XKCD Deadfish programs and says how to read them', async () => {
    for (const language of ['deadfish', 'xkcd-deadfish'] as const) {
      const program = await generated('flag{fish}', language);
      expect(utf8Decode(await output(program, { language, deadfish: 'chars' }))).toBe('flag{fish}');
      expect(program).toMatch(language === 'deadfish' ? /^[idso]+$/ : /^[xdkc]+$/);
    }
    expect(resultToText(await run('hi', { mode: 'generate', language: 'deadfish' }))).toContain(
      'ASCII characters',
    );
    expect(resultToText(await run('hi', { mode: 'generate', language: 'deadfish' }))).toContain(
      'Deadfish program',
    );
  });

  it('says which languages can be written when asked for Befunge or Malbolge', async () => {
    await expect(run('hi', { mode: 'generate', language: 'befunge' })).rejects.toThrow(
      /Text → program writes .*Brainfuck.*Deadfish.*Befunge-93 can only be run here/,
    );
    await expect(run('hi', { mode: 'generate', language: 'malbolge' })).rejects.toThrow(ToolError);
    await expect(run('hi', { mode: 'generate', language: 'malbolge-normalized' })).rejects.toThrow(
      /Malbolge \(normalised\) can only be run/,
    );
  });
});
