/**
 * Conformance tests for the esolang tool, written from the languages' own specifications and
 * kept apart from the tool's code: the dialect tables below are typed in the order the
 * specifications list them (> < + - . , [ ]), and every program is made here, so a table that
 * is wrong in the tool is caught instead of being mirrored by the tool's own "text to program"
 * round trip. Every program is made for these tests (they print "FTF", "A", ...).
 */
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import { denormaliseMalbolge, normaliseMalbolge } from './_esolang-malbolge';
import tool, { detectLanguage } from './esolang';

type Opts = Parameters<typeof tool.run>[1];
const defaults: Opts = {
  mode: 'run',
  language: 'auto',
  input: '',
  steps: 10_000_000,
  seed: 1,
  deadfish: 'numbers',
};
const run = async (src: string, opts: Partial<Opts> = {}): Promise<Output[]> =>
  tool.run(src, { ...defaults, ...opts });
/** The bytes the program printed (empty when it printed nothing). */
async function bytesOf(src: string, opts: Partial<Opts> = {}): Promise<Uint8Array> {
  const block = (await run(src, opts)).find((o) => o.type === 'bytes');
  return block && block.type === 'bytes' ? block.value : new Uint8Array();
}
const printed = async (src: string, opts: Partial<Opts> = {}) =>
  utf8Decode(await bytesOf(src, opts));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const triage = (text: string) => tool.detect?.({ text, bytes: utf8Encode(text) }) ?? null;
const rep = (word: string, n: number, sep = ' ') => Array.from({ length: n }, () => word).join(sep);

// ---------- Brainfuck, and an independent engine to decode what the tool writes ----------

const HELLO =
  '++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.';
const HELLO_OUT = 'Hello World!\n';
/** 10 * 7 = 70 "F", 10 * 8 = 80 -> 84 "T", back to 70 "F" */
const FTF = '++++++++++[>+++++++>++++++++<<-]>.>++++.<.';
const REVERSE_BF = '>,[>,]<[.<]';

/** A small, separate Brainfuck engine: 8-bit cells, EOF reads 0. */
function bfRun(code: string, input = ''): string {
  const jump = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '[') open.push(i);
    else if (code[i] === ']') {
      const j = open.pop()!;
      jump.set(i, j);
      jump.set(j, i);
    }
  }
  const tape = new Uint8Array(30000);
  let p = 0;
  let inPos = 0;
  let out = '';
  for (let pc = 0; pc < code.length; pc++) {
    switch (code[pc]) {
      case '+':
        tape[p]!++;
        break;
      case '-':
        tape[p]!--;
        break;
      case '>':
        p++;
        break;
      case '<':
        p--;
        break;
      case '.':
        out += String.fromCharCode(tape[p]!);
        break;
      case ',':
        tape[p] = inPos < input.length ? input.charCodeAt(inPos++) : 0;
        break;
      case '[':
        if (tape[p] === 0) pc = jump.get(pc)!;
        break;
      case ']':
        if (tape[p] !== 0) pc = jump.get(pc)!;
        break;
    }
  }
  return out;
}

/** The dialect tables, in the order of the specifications: > < + - . , [ ] */
type Table = Record<string, string>;
const OOK: Table = {
  '>': 'Ook. Ook?',
  '<': 'Ook? Ook.',
  '+': 'Ook. Ook.',
  '-': 'Ook! Ook!',
  '.': 'Ook! Ook.',
  ',': 'Ook. Ook!',
  '[': 'Ook! Ook?',
  ']': 'Ook? Ook!',
};
const BLUB: Table = Object.fromEntries(
  Object.entries(OOK).map(([bf, words]) => [bf, words.replaceAll('Ook', 'Blub')]),
);
const SHORT_OOK: Table = Object.fromEntries(
  Object.entries(OOK).map(([bf, words]) => [bf, words.replaceAll(/Ook| /g, '')]),
);
const PIKALANG: Table = {
  '>': 'pipi',
  '<': 'pichu',
  '+': 'pi',
  '-': 'ka',
  '.': 'pikachu',
  ',': 'pikapi',
  '[': 'pika',
  ']': 'chu',
};
const ALPHUCK: Table = {
  '>': 'a',
  '<': 'c',
  '+': 'e',
  '-': 'i',
  '.': 'j',
  ',': 'o',
  '[': 'p',
  ']': 's',
};
const COW: Table = {
  '>': 'moO',
  '<': 'mOo',
  '+': 'MoO',
  '-': 'MOo',
  '.': 'Moo',
  '[': 'MOO',
  ']': 'moo',
};
const REVERSEFUCK: Table = {
  '>': '<',
  '<': '>',
  '+': '-',
  '-': '+',
  '.': ',',
  ',': '.',
  '[': ']',
  ']': '[',
};
const spell = (bf: string, table: Table, sep = ' ') => [...bf].map((c) => table[c] ?? c).join(sep);
const invert = (table: Table): Table =>
  Object.fromEntries(Object.entries(table).map(([bf, word]) => [word, bf]));

describe('Brainfuck (conformance)', () => {
  it('runs Hello World, auto-detected as Brainfuck', async () => {
    expect(await printed(HELLO)).toBe(HELLO_OUT);
    expect(resultToText(await run(HELLO))).toContain('Brainfuck (auto-detected)');
  });

  it('prints FTF', async () => {
    expect(await printed(FTF)).toBe('FTF');
    expect(bfRun(FTF)).toBe('FTF');
  });

  it('copies its input (cat) and reverses it', async () => {
    expect(await printed(',[.,]', { input: 'abc' })).toBe('abc');
    expect(await printed(REVERSE_BF, { input: 'xyz' })).toBe('zyx');
  });

  it('wraps cells at 8 bits, so +[+] ends', async () => {
    expect(await printed('+[+]++++++++[>++++++++<-]>+.')).toBe('A');
    expect(hex(await bytesOf('-.', { language: 'brainfuck' }))).toBe('ff');
  });

  it('reads 0 at the end of the input and understands the input escapes', async () => {
    expect(hex(await bytesOf(',.', { language: 'brainfuck' }))).toBe('00');
    expect(await printed(',.,.', { language: 'brainfuck', input: '\\x41\\n' })).toBe('A\n');
  });

  it('ignores prose around the program, with Auto and with an explicit language', async () => {
    const program = 'Print A: ++++++++[>++++++++<-]>+. done';
    expect(await printed(program)).toBe('A');
    expect(await printed(program, { language: 'brainfuck' })).toBe('A');
  });

  it('refuses unbalanced brackets', async () => {
    await expect(run('[[]', { language: 'brainfuck' })).rejects.toThrow(/Unmatched "\["/);
    await expect(run('+]', { language: 'brainfuck' })).rejects.toThrow(/Unmatched "\]"/);
    // Brackets that do pair up are fine, whatever the prose between them says.
    expect(await bytesOf('[[]  and  +]', { language: 'brainfuck' })).toHaveLength(0);
  });

  it('stops a loop that never ends at the step limit and keeps what it printed', async () => {
    const out = await run('++++++++[>++++++++<-]>+[.]', { language: 'brainfuck', steps: 1000 });
    const block = out.find((o) => o.type === 'bytes');
    expect(block?.type === 'bytes' ? utf8Decode(block.value) : '').toMatch(/^A{100,}$/);
    expect(resultToText(out)).toContain('Stopped at the step limit');
  });

  it('multiplies with nested loops: 3 * 4 * 5 = 60', async () => {
    expect(await printed('+++[>++++[>+++++<-]<-]>>.', { language: 'brainfuck' })).toBe('<');
  });

  it('explains a pointer that leaves the tape on the left instead of crashing', async () => {
    await expect(run('<+.', { language: 'brainfuck' })).rejects.toThrow(ToolError);
  });

  it('reads CRLF line ends and tabs inside a program', async () => {
    expect(await printed('++++++++++\r\n[\t>+++++++>++++++++<<-]>.>++++.<.')).toBe('FTF');
  });
});

describe('Ook!, Short Ook and Blub (conformance)', () => {
  it('runs Hello World and FTF written in Ook!, and says it was detected', async () => {
    expect(await printed(spell(HELLO, OOK))).toBe(HELLO_OUT);
    expect(await printed(spell(FTF, OOK))).toBe('FTF');
    expect(resultToText(await run(spell(FTF, OOK)))).toContain('Ook! (auto-detected)');
  });

  it('copies its input', async () => {
    const cat = 'Ook. Ook! Ook! Ook? Ook! Ook. Ook. Ook! Ook? Ook!';
    expect(cat).toBe(spell(',[.,]', OOK));
    expect(await printed(cat, { input: 'meow' })).toBe('meow');
  });

  it('allows line feeds between the words and prose around them', async () => {
    const wrapped = `Ook says:\n${spell(FTF, OOK).replaceAll(' Ook?', '\nOok?')}\nend`;
    expect(wrapped).toContain('\nOok?');
    expect(await printed(wrapped, { language: 'ook' })).toBe('FTF');
  });

  it('reads Short Ook spaced and compact, and recognises it', async () => {
    const spaced = [...spell(FTF, SHORT_OOK, '')].join(' ');
    const compact = spell(FTF, SHORT_OOK, '');
    expect(compact).toMatch(/^[.?!]+$/);
    expect(spaced).toContain('. ');
    expect(await printed(spaced)).toBe('FTF');
    expect(await printed(compact)).toBe('FTF');
    expect(resultToText(await run(compact))).toContain('Short Ook (auto-detected)');
    expect(resultToText(await run(spaced))).toContain('Short Ook (auto-detected)');
  });

  it('runs Hello World in compact Short Ook', async () => {
    expect(await printed(spell(HELLO, SHORT_OOK, ''), { language: 'short-ook' })).toBe(HELLO_OUT);
  });

  it('runs Blub: Hello World, FTF and a reversing program', async () => {
    expect(await printed(spell(HELLO, BLUB))).toBe(HELLO_OUT);
    expect(await printed(spell(FTF, BLUB))).toBe('FTF');
    expect(await printed(spell(REVERSE_BF, BLUB), { input: 'abc' })).toBe('cba');
    expect(resultToText(await run(spell(FTF, BLUB)))).toContain('Blub (auto-detected)');
  });
});

describe('COW (conformance)', () => {
  const cow = (src: string, input = '') => run(src, { language: 'cow', input });

  it('prints FTF and Hello World through MOO / moo loops, detected as COW', async () => {
    expect(await printed(spell(FTF, COW))).toBe('FTF');
    expect(await printed(spell(HELLO, COW))).toBe(HELLO_OUT);
    expect(resultToText(await run(spell(FTF, COW)))).toContain('COW (auto-detected)');
  });

  it('OOM prints the cell as a number and OOO clears it', async () => {
    expect(await printed(`${rep('MoO', 42)} OOM`, { language: 'cow' })).toBe('42');
    expect(await printed('MoO MoO OOO MoO OOM', { language: 'cow' })).toBe('1');
  });

  it('MMM copies into the register, then pastes and empties it', async () => {
    expect(await printed(`${rep('MoO', 65)} MMM moO MMM Moo mOo Moo`, { language: 'cow' })).toBe(
      'AA',
    );
    expect(await printed(`${rep('MoO', 65)} MMM moO MMM moO MMM OOM`, { language: 'cow' })).toBe(
      '0',
    );
  });

  it('oom reads a number, Moo reads a byte into an empty cell and prints a full one', async () => {
    expect(await printed('oom MoO OOM', { language: 'cow', input: '123' })).toBe('124');
    expect(await printed('Moo Moo', { language: 'cow', input: 'Q' })).toBe('Q');
    expect(await printed('Moo Moo', { language: 'cow' })).toBe('');
  });

  it('mOO runs the value in the cell as an instruction', async () => {
    expect(await printed(`${rep('MoO', 6)} mOO OOM`, { language: 'cow' })).toBe('7');
    expect(await printed('MoO MoO mOO OOM', { language: 'cow' })).toBe('0');
    expect(await printed(`${rep('MoO', 11)} mOO OOM`, { language: 'cow', input: '77' })).toBe('77');
  });

  it('mOO with a value that is no instruction ends the program normally', async () => {
    const out = await cow('MoO MoO MoO mOO MoO MoO OOM');
    expect(out.some((o) => o.type === 'bytes')).toBe(false);
    expect(resultToText(out)).not.toContain('Stopped at the step limit');
    expect(resultToText(out)).toContain('mOO ran the cell value 3');
    const twelve = await cow(`${rep('MoO', 12)} mOO OOM`);
    expect(twelve.some((o) => o.type === 'bytes')).toBe(false);
    expect(resultToText(twelve)).toContain('cell value 12');
  });

  it('keeps what was printed before an invalid mOO', async () => {
    expect(await printed(`${rep('MoO', 65)} Moo OOO MoO MoO MoO mOO`, { language: 'cow' })).toBe(
      'A',
    );
  });
});

describe('Pikalang (conformance)', () => {
  it('runs Hello World and FTF written with the specification table', async () => {
    expect(await printed(spell(HELLO, PIKALANG))).toBe(HELLO_OUT);
    const ftf =
      'pi pi pi pi pi pi pi pi pi pi pika pipi pi pi pi pi pi pi pi pipi pi pi pi pi pi pi pi pi ' +
      'pichu pichu ka chu pipi pikachu pipi pi pi pi pi pikachu pichu pikachu';
    expect(ftf).toBe(spell(FTF, PIKALANG));
    expect(await printed(ftf)).toBe('FTF');
    expect(resultToText(await run(ftf))).toContain('Pikalang (auto-detected)');
  });

  it('reads pi as +, ka as -, pipi as > and pichu as <', async () => {
    const one = Uint8Array.of(1);
    for (const program of [
      'pi pikachu',
      'pipi pi pikachu',
      'pi pi ka pikachu',
      'pipi pichu pi pikachu',
    ]) {
      expect(await bytesOf(program, { language: 'pikalang' }), program).toEqual(one);
    }
  });

  it('copies its input with pikapi, pika, pikachu and chu only', async () => {
    expect(await printed('pikapi pika pikachu pikapi chu', { input: 'pika' })).toBe('pika');
  });

  it('writes programs that decode, by the specification table, to the text', async () => {
    const out = await run('FTF{x}', { mode: 'generate', language: 'pikalang' });
    const block = out.find((o) => o.type === 'text');
    const program = block?.type === 'text' ? block.value : '';
    const back = invert(PIKALANG);
    const bf = program
      .split(/\s+/)
      .map((w) => back[w] ?? '?')
      .join('');
    expect(bf).not.toContain('?');
    expect(bfRun(bf)).toBe('FTF{x}');
  });
});

describe('Alphuck (conformance)', () => {
  it('runs Hello World, FTF and a reversing program written with the specification table', async () => {
    expect(await printed(spell(HELLO, ALPHUCK, ''))).toBe(HELLO_OUT);
    const ftf = 'eeeeeeeeeepaeeeeeeeaeeeeeeeeccisajaeeeejcj';
    expect(ftf).toBe(spell(FTF, ALPHUCK, ''));
    expect(await printed(ftf)).toBe('FTF');
    const reverse = 'aopaoscpjcs';
    expect(reverse).toBe(spell(REVERSE_BF, ALPHUCK, ''));
    expect(await printed(reverse, { input: 'abc' })).toBe('cba');
    expect(resultToText(await run(ftf))).toContain('Alphuck (auto-detected)');
  });

  it('reads a as >, c as <, e as + and i as -', async () => {
    const one = Uint8Array.of(1);
    for (const program of ['ej', 'aej', 'eeij', 'acej']) {
      expect(await bytesOf(program, { language: 'alphuck' }), program).toEqual(one);
    }
  });

  it('writes programs that decode, by the specification table, to the text', async () => {
    const out = await run('FTF{x}', { mode: 'generate', language: 'alphuck' });
    const block = out.find((o) => o.type === 'text');
    const program = block?.type === 'text' ? block.value : '';
    const back = invert(ALPHUCK);
    const bf = [...program.replace(/\s+/g, '')].map((c) => back[c] ?? '?').join('');
    expect(bf).not.toContain('?');
    expect(bfRun(bf)).toBe('FTF{x}');
  });
});

describe('ReverseFuck (conformance)', () => {
  it('swaps the meaning of every symbol, loops included', async () => {
    expect(await printed(`${'-'.repeat(65)},-,`, { language: 'reversefuck' })).toBe('AB');
    expect(await printed('.],.[', { language: 'reversefuck', input: 'xy' })).toBe('xy');
    expect(await bytesOf('-,', { language: 'reversefuck' })).toEqual(Uint8Array.of(1));
  });

  it('is recognised by its loops, which are written ]...[', async () => {
    const ftf = '----------]<-------<-------->>+[<,<----,>,';
    expect(ftf).toBe(spell(FTF, REVERSEFUCK, ''));
    expect(await printed(ftf)).toBe('FTF');
    expect(resultToText(await run(ftf))).toContain('ReverseFuck (auto-detected)');
    expect(triage(ftf)?.options).toEqual({ language: 'reversefuck' });
    expect(triage(ftf)?.score).toBeGreaterThanOrEqual(0.7);
  });

  it('points to ReverseFuck when a Brainfuck run fails on brackets that pair up backwards', async () => {
    await expect(
      run('----------]<-------<-------->>+[<,<----,>,', { language: 'brainfuck' }),
    ).rejects.toThrow(/ReverseFuck/);
    // Brackets that are wrong both ways get the plain error.
    await expect(run('+]', { language: 'brainfuck' })).rejects.not.toThrow(/ReverseFuck/);
  });

  it('keeps reading plain Brainfuck as Brainfuck', async () => {
    expect(resultToText(await run(FTF))).toContain('Brainfuck (auto-detected)');
    expect(triage(HELLO)?.options).toEqual({ language: 'brainfuck' });
  });
});

describe('Deadfish (conformance)', () => {
  it('adds, squares, prints, and resets 256 and -1 to 0', async () => {
    const cases: [string, string][] = [
      ['iiso', '4\n'],
      ['iissso', '0\n'],
      ['iissisio', '290\n'],
      ['do', '0\n'],
      [`iiss${'i'.repeat(240)}o`, '0\n'],
      [`iiss${'i'.repeat(239)}o`, '255\n'],
    ];
    for (const [program, expected] of cases) {
      // "do" is also an English word: only a longer program is taken for Deadfish on Auto.
      if (program !== 'do') expect(await printed(program), program).toBe(expected);
      expect(await printed(program, { language: 'deadfish' }), program).toBe(expected);
    }
  });

  it('prints numbers, or characters', async () => {
    const program = 'iiiiiiiisiiiiiioiiiiiiiiiiiiiioddddddddddddddo';
    expect(await printed(program)).toBe('70\n84\n70\n');
    expect(await printed(program, { deadfish: 'chars' })).toBe('FTF');
  });

  it('ignores white space and other characters', async () => {
    expect(await printed('ii s\no\n', { language: 'deadfish' })).toBe('4\n');
  });

  it('XKCD Deadfish is x d k c', async () => {
    expect(await printed('xxkc')).toBe('4\n');
    expect(await printed('xxkkkc', { language: 'xkcd-deadfish' })).toBe('0\n');
    const ftf = 'iiiiiiiisiiiiiioiiiiiiiiiiiiiioddddddddddddddo'
      .replaceAll('i', 'x')
      .replaceAll('s', 'k')
      .replaceAll('o', 'c');
    expect(await printed(ftf, { language: 'xkcd-deadfish', deadfish: 'chars' })).toBe('FTF');
    expect(resultToText(await run('xxkc'))).toContain('XKCD Deadfish (auto-detected)');
  });
});

describe('Befunge-93 (conformance)', () => {
  const befunge = (src: string, opts: Partial<Opts> = {}) =>
    printed(src, { language: 'befunge', ...opts });

  it('prints with a string and a loop, detected as Befunge', async () => {
    const hello = '"!dlroW ,olleH">:#,_@';
    expect(await printed(hello)).toBe('Hello, World!');
    expect(resultToText(await run(hello))).toContain('Befunge-93 (auto-detected)');
  });

  it('does arithmetic, comparisons, swap and pop', async () => {
    expect(await befunge('25*:*.@')).toBe('100 ');
    expect(await befunge('73/.73%.53`.35`.0!.@')).toBe('2 1 1 0 1 ');
    expect(await befunge('12\\..12$.@')).toBe('1 2 1 ');
    expect(await befunge('05-.@')).toBe('-5 ');
    expect(await befunge('.@')).toBe('0 ');
  });

  it('wraps around the edges, horizontally and vertically', async () => {
    expect(await befunge('<@,,,"FTF"')).toBe('FTF');
    expect(await printed('<@,,,"FTF"')).toBe('FTF');
    expect(await befunge('^\n>88*1+,@')).toBe('A');
    expect(await printed('^\n>88*1+,@')).toBe('A');
  });

  it('p can write the @ that ends the program', async () => {
    const program = '"FTF"88*55+8+0p,,,';
    expect(await befunge(program, { steps: 100_000 })).toBe('FTF');
    expect(await printed(program)).toBe('FTF');
    expect(resultToText(await run(program))).toContain('Befunge-93 (auto-detected)');
    expect(triage(program)?.options).toEqual({ language: 'befunge' });
  });

  it('g reads the playfield, and g and p agree', async () => {
    expect(await befunge('50g,@X')).toBe('X');
    expect(await befunge('"F"00p00g,@')).toBe('F');
  });

  it('counts down with # and _ (detected as Befunge)', async () => {
    const countdown = '5>:.1-:#v_@\n ^      <';
    expect(await printed(countdown)).toBe('5 4 3 2 1 ');
    expect(resultToText(await run(countdown))).toContain('Befunge-93 (auto-detected)');
  });

  it('| and _ choose a direction from the top of the stack, with wrap-around', async () => {
    expect(await befunge('v\n0\n|\n@')).toBe('');
    expect(await befunge('1|\n >"D",@\n\n\n >"U",@')).toBe('U');
    expect(await befunge('1_ @,"L"')).toBe('L');
  });

  it('reads numbers with & and characters with ~, and -1 at the end of the input', async () => {
    expect(await befunge('&&+.@', { input: '3 4' })).toBe('7 ');
    expect(await befunge('&&+.@', { input: '12 30' })).toBe('42 ');
    expect(await befunge('~~,,@', { input: 'ab' })).toBe('ba');
    expect(await befunge('~.@')).toBe('-1 ');
  });

  it('keeps the spaces of a string and runs the string round the 80 column torus', async () => {
    expect(await befunge('"a b",,,@')).toBe('b a');
    expect(await befunge('",,,@')).toBe('   ');
  });

  it('# skips the cell on the other side of the left edge', async () => {
    const row = `#<${' '.repeat(72)}@,"Q"@`;
    expect(row).toHaveLength(80);
    expect(await befunge(`>v\n${row}`)).toBe('Q');
  });

  it('? with a seed takes some path and halts', async () => {
    for (const seed of [1, 7]) {
      const out = await run('?@', { language: 'befunge', seed });
      expect(out.some((o) => o.type === 'bytes')).toBe(false);
      expect(resultToText(out)).not.toContain('Stopped at the step limit');
    }
  });

  it('does not crash on a division by zero, and says so', async () => {
    const out = await run('10/.@', { language: 'befunge' });
    expect(out.find((o) => o.type === 'bytes')).toBeDefined();
    expect(resultToText(out)).toContain('Division or modulo by zero');
  });

  it('stops an infinite loop at the step limit', async () => {
    const out = await run('>v\n^<', { language: 'befunge', steps: 1000 });
    expect(resultToText(out)).toContain('Stopped at the step limit');
  });

  it('does not run anything outside 80 x 25', async () => {
    await expect(run(`"A",${' '.repeat(76)}@`, { language: 'befunge' })).rejects.toThrow(ToolError);
    await expect(run(`${'\n'.repeat(25)}@`, { language: 'befunge' })).rejects.toThrow(ToolError);
  });

  it('tolerates CRLF, a final line feed, trailing blanks and 25 lines', async () => {
    const countdown = '5>:.1-:#v_@\r\n ^      <';
    expect(await befunge(countdown)).toBe('5 4 3 2 1 ');
    const tall = `5>:.1-:#v_@\n ^      <${'\n'.repeat(23)}x\n`;
    expect(tall.trimEnd().split('\n')).toHaveLength(25);
    expect(await befunge(tall)).toBe('5 4 3 2 1 ');
    expect(await befunge(`${'5>:.1-:#v_@'.padEnd(82)}\n ^      <`)).toBe('5 4 3 2 1 ');
  });
});

describe('Malbolge (conformance)', () => {
  const FTF_RAW = '(CBA#9]~654X210TA3210/.-,+*)(\'&%$#"!~}|{zyxwZ5t3V1jo.zPkj';
  const FTF_NORMALISED = 'jooo*p<*ppp<ppp<vooooooooooooooooooooooooooojioijipoivjoo';
  const HI_RAW = '(=<`#9]~65YF876543210/.-,+*)(\'&%$#"!~}|{z]KwIYtVEqpo';
  const HI_NORMALISED = 'jpp<*p<*pp<voooooooooooooooooooooooooooooj/o/jo*/ooo';
  const FIVE_RAW = '(&<`#9]76Z{3Wx0/.R?10/.-,+*)(\'&%$#"!~}|{z(\\wZ6tW2q1|nQPNdih';
  const FIVE_NORMALISED = 'j*p<*p<pp<*p<*ppp<voooooooooooooooooooooovjoj<ojio<vojj*poo';

  it('prints FTF, written out in full and in the normalised spelling', async () => {
    expect(await printed(FTF_RAW)).toBe('FTF');
    expect(await printed(FTF_RAW, { language: 'malbolge' })).toBe('FTF');
    expect(await printed(FTF_NORMALISED)).toBe('FTF');
    expect(await printed(FTF_NORMALISED, { language: 'malbolge-normalized' })).toBe('FTF');
    expect(resultToText(await run(FTF_RAW))).toContain('Malbolge (auto-detected)');
    expect(resultToText(await run(FTF_NORMALISED))).toContain('Malbolge (normalised)');
  });

  it('prints a short string and a five character one, in both spellings', async () => {
    expect(await printed(HI_RAW)).toBe('Hi!');
    expect(await printed(HI_NORMALISED)).toBe('Hi!');
    expect(await printed(FIVE_RAW, { language: 'malbolge' })).toHaveLength(5);
    expect(await printed(FIVE_NORMALISED, { language: 'malbolge-normalized' })).toBe(
      await printed(FIVE_RAW, { language: 'malbolge' }),
    );
  });

  it('the two spellings are the same program', () => {
    expect(normaliseMalbolge(FTF_RAW)).toBe(FTF_NORMALISED);
    expect(denormaliseMalbolge(FTF_NORMALISED)).toBe(FTF_RAW);
    expect(normaliseMalbolge(HI_RAW)).toBe(HI_NORMALISED);
    expect(denormaliseMalbolge(FIVE_NORMALISED)).toBe(FIVE_RAW);
  });

  it('ignores line feeds, CRLF, spaces and tabs inside the program', async () => {
    const wrapped = FTF_RAW.replace(/(.{8})/g, '$1\n').replace(/(.{3})\n/g, '$1 \t\r\n');
    expect(wrapped).toMatch(/\r\n/);
    expect(await printed(wrapped, { language: 'malbolge' })).toBe('FTF');
  });

  it('echoes one byte of input, and reads 59048 at the end of the input', async () => {
    expect(await printed('ubO', { language: 'malbolge', input: 'Q' })).toBe('Q');
    expect(hex(await bytesOf('ubO', { language: 'malbolge' }))).toBe('a8'); // 59048 mod 256
  });

  it('refuses a single character and runs a program that only ends', async () => {
    await expect(run('Q', { language: 'malbolge' })).rejects.toThrow(ToolError);
    const out = await run('QC', { language: 'malbolge' });
    expect(out.some((o) => o.type === 'bytes')).toBe(false);
    expect(resultToText(out)).not.toContain('Stopped at the step limit');
  });

  it('refuses a character that is no instruction at its position', async () => {
    await expect(run('!P', { language: 'malbolge' })).rejects.toThrow(ToolError);
  });
});

describe('Text to program (conformance)', () => {
  const written = async (text: string, language: Opts['language']) => {
    const block = (await run(text, { mode: 'generate', language })).find((o) => o.type === 'text');
    return block?.type === 'text' ? block.value : '';
  };

  it('writes programs that the tool runs back to the text', async () => {
    for (const language of [
      'brainfuck',
      'ook',
      'short-ook',
      'cow',
      'blub',
      'pikalang',
      'alphuck',
      'reversefuck',
    ] as const) {
      const program = await written('FTF{gen}', language);
      expect(await printed(program, { language }), language).toBe('FTF{gen}');
    }
    for (const language of ['deadfish', 'xkcd-deadfish'] as const) {
      const program = await written('FTF{gen}', language);
      expect(await printed(program, { language, deadfish: 'chars' }), language).toBe('FTF{gen}');
    }
  });

  it('writes Ook!, Blub, COW and ReverseFuck that the specification tables decode to the text', async () => {
    const decoders: [Opts['language'], (program: string) => string][] = [
      [
        'ook',
        (p) =>
          (p.match(/Ook[.?!] Ook[.?!]/g) ?? []).map((pair) => invert(OOK)[pair] ?? '?').join(''),
      ],
      [
        'blub',
        (p) =>
          (p.match(/Blub[.?!] Blub[.?!]/g) ?? []).map((pair) => invert(BLUB)[pair] ?? '?').join(''),
      ],
      [
        'cow',
        (p) =>
          p
            .split(/\s+/)
            .map((word) => invert(COW)[word] ?? '?')
            .join(''),
      ],
      ['reversefuck', (p) => [...p].map((c) => invert(REVERSEFUCK)[c] ?? '?').join('')],
    ];
    for (const [language, decode] of decoders) {
      const bf = decode(await written('FTF{x}', language));
      expect(bf, String(language)).not.toContain('?');
      expect(bfRun(bf), String(language)).toBe('FTF{x}');
    }
  });

  it('writes Brainfuck when the language is Auto', async () => {
    const program = await written('FTF', 'auto');
    expect(bfRun(program)).toBe('FTF');
  });

  it('says clearly that Befunge and Malbolge programs are not written', async () => {
    await expect(run('FTF{gen}', { mode: 'generate', language: 'befunge' })).rejects.toThrow(
      ToolError,
    );
    await expect(run('FTF{gen}', { mode: 'generate', language: 'malbolge' })).rejects.toThrow(
      ToolError,
    );
  });
});

describe('Telling programs from ordinary text', () => {
  const EVERYDAY = [
    'From: bob@example.com\nSubject: invoice number 42, please pay v2 soon',
    'user@host:~$ ls > out.txt',
    'Email: john@site.com -> reply soon',
    'Contact: alice@mail.com, we have v2 now',
    'Price @ 5 > 4',
  ];

  it('does not take e-mail headers, shell lines or prose for Befunge', () => {
    for (const text of EVERYDAY) {
      expect(triage(text)?.score ?? 0, text).toBeLessThan(0.25);
      expect(triage(text)?.options, text).not.toEqual({ language: 'befunge' });
    }
  });

  it('runs such text as Brainfuck (and says there is nothing to run), not as Befunge', async () => {
    for (const text of EVERYDAY) {
      const error = await run(text).catch((e: unknown) => e);
      expect(String(error instanceof Error ? error.message : ''), text).not.toMatch(/Befunge/);
    }
  });

  it('still recognises a real Befunge program that holds an @ and a v', () => {
    expect(triage('>"!dlroW ,olleH">:#,_@')?.options).toEqual({ language: 'befunge' });
    expect(triage('v\n>"FTF",,,@')?.options).toEqual({ language: 'befunge' });
  });

  it('points a Whitespace program to its own tool instead of complaining about Brainfuck', async () => {
    const whitespace = '   \t\n\t\n \t \n\n\n   \t \n\t\n \t\n\n\n'.repeat(3);
    await expect(run(whitespace)).rejects.toThrow(/Whitespace \(esolang\)/);
    await expect(run(whitespace, { language: 'ook' })).rejects.toThrow(/Whitespace \(esolang\)/);
    // Text with a few blanks is still reported the usual way.
    await expect(run('hello world nothing here')).rejects.toThrow(/No Brainfuck instructions/);
  });

  it('says in its description where Whitespace and Piet programs go', () => {
    expect(tool.description).toMatch(/Whitespace/);
    expect(tool.description).toMatch(/Piet/);
  });
});

describe('ReverseFuck detection stays careful', () => {
  it('does not read a sentence with two stray brackets as a program', () => {
    expect(detectLanguage('see ] and [ here')).toBe('brainfuck');
    expect(detectLanguage('a ] b [ c')).toBe('brainfuck');
  });
});
