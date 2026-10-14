import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import { assemble, disassemble, hideInCover, textToProgram } from './_ws-asm';
import { decodeNumber, encodeNumber, OPS, parse, toLetters, toWhitespace } from './_ws-core';
import {
  decodeSource,
  extractAll,
  extractLetters,
  extractMarkers,
  extractMarkersTrailing,
  extractTrailing,
  looksLikeLetters,
  markerRegion,
  markInvisible,
  reveal,
  summarizeLines,
} from './_ws-extract';
import { outputScore, printableShare } from './_ws-pick';
import { execute, floorDiv, floorMod, type VmResult } from './_ws-vm';
import tool, { unescapeInput } from './whitespace-lang';

type Opts = Parameters<typeof tool.run>[1];
const defaults: Opts = {
  mode: 'run',
  extract: 'auto',
  bareLines: 'count',
  start: 'BEGIN',
  end: 'END',
  input: '',
  steps: 5_000_000,
  cover: '',
};

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

async function runTool(input: string | Uint8Array, opts: Partial<Opts> = {}): Promise<Output[]> {
  const bytes = typeof input === 'string' ? utf8Encode(input) : input;
  return tool.run({ bytes }, { ...defaults, ...opts });
}

function block(out: Output[], label: string): string | undefined {
  const b = out.find((o) => o.type === 'text' && o.label === label);
  return b && b.type === 'text' ? b.value : undefined;
}

const programOutput = async (input: string | Uint8Array, opts: Partial<Opts> = {}) =>
  block(await runTool(input, opts), 'Program output');

/** Texts of the notes of one level. */
const notes = (out: Output[], level: 'info' | 'warn' | 'error' | 'success') =>
  out.flatMap((o) => (o.type === 'note' && o.level === level ? [o.text] : []));

/**
 * A run that stopped with a runtime error: one error note, no "Program output" (that label is for
 * runs without an error), what it printed in "Output before the error", and the disassembly.
 */
function expectCrash(out: Output[], message: RegExp, kept?: string): string {
  const errors = notes(out, 'error');
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(message);
  expect(block(out, 'Program output')).toBeUndefined();
  expect(block(out, 'Output before the error')).toBe(kept);
  expect(block(out, 'Disassembly')).toBeDefined();
  expect(
    block(out, 'Revealed text (· space, → tab, ⏎ line feed, ␍ carriage return)'),
  ).toBeDefined();
  return errors[0]!;
}

async function toolError(input: string | Uint8Array, opts: Partial<Opts> = {}): Promise<string> {
  try {
    await runTool(input, opts);
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    return (e as Error).message;
  }
  throw new Error('expected a ToolError');
}

/** Assemble and run. */
function vm(src: string, input = '', stepLimit = 1_000_000): VmResult {
  return execute(parse(assemble(src)), { input, stepLimit });
}

const lines = (...l: string[]) => l.join('\n');

describe('tokens and numbers', () => {
  it('keeps only space, tab and line feed (CR and everything else are comments)', () => {
    expect(toLetters('a b\tc\r\nd\u00a0\u200b')).toBe('STL');
    expect(toWhitespace('S T L x')).toBe(' \t\n');
  });

  it('encodes numbers as sign + binary + L, arbitrary precision', () => {
    expect(encodeNumber(70n)).toBe('STSSSTTSL');
    expect(encodeNumber(-5n)).toBe('TTSTL');
    expect(encodeNumber(0n)).toBe('SSL');
    const big = 2n ** 100n + 3n;
    expect(decodeNumber(encodeNumber(big).slice(0, -1))).toBe(big);
    expect(decodeNumber(encodeNumber(-big).slice(0, -1))).toBe(-big);
  });

  it('reads a number without digits (or even without a sign) as 0', () => {
    expect(decodeNumber('S')).toBe(0n);
    expect(decodeNumber('T')).toBe(0n);
    expect(decodeNumber('')).toBe(0n);
    expect(parse('SSSL').instrs[0]!.num).toBe(0n);
    expect(parse('SSL').instrs[0]!.num).toBe(0n);
  });
});

describe('parser', () => {
  it('parses every instruction', () => {
    const code = OPS.map((o) =>
      o.arg === 'number' ? `${o.code}STL` : o.arg === 'label' ? `${o.code}STL` : o.code,
    ).join('');
    const parsed = parse(code);
    expect(parsed.tail).toBeUndefined();
    expect(parsed.instrs.map((i) => i.op.name)).toEqual(OPS.map((o) => o.name));
    expect(parsed.instrs[0]!.num).toBe(1n);
    expect(parsed.instrs.find((i) => i.op.name === 'call')!.label).toBe('ST');
  });

  it('accepts empty labels', () => {
    const p = parse('LSSL');
    expect(p.instrs[0]!.op.name).toBe('label');
    expect(p.instrs[0]!.label).toBe('');
  });

  it('stops at an unterminated number or label, keeping what came before', () => {
    const num = parse('SSSTLSSST');
    expect(num.instrs).toHaveLength(1);
    expect(num.tail).toMatchObject({ start: 5, incomplete: true, kind: 'unterminated' });
    expect(num.tail!.reason).toMatch(/unterminated number/);
    expect(parse('LSSST').tail!.reason).toMatch(/unterminated label/);
    expect(parse('TL').tail).toMatchObject({ incomplete: true, kind: 'partial' });
    expect(parse('SSSTLL').tail).toMatchObject({ start: 5, raw: 'L', kind: 'partial' });
  });

  it('names exactly the invalid sequence, not the next instruction', () => {
    const p = parse('SLSTLLSS');
    expect(p.instrs.map((i) => i.op.name)).toEqual(['dup']);
    expect(p.tail).toMatchObject({ start: 3, incomplete: false, kind: 'invalid' });
    expect(p.tail!.reason).toBe('TLL (tab, line feed, line feed) is not a Whitespace instruction');
    expect(parse('STTSL').tail!.reason).toMatch(/^STT \(space, tab, tab\) is not/);
    expect(parse('LLSL').tail!.reason).toMatch(/^LLS \(/);
    expect(parse('STT').tail!.reason).toMatch(/^STT \(/);
  });
});

describe('stack instructions', () => {
  it('push, dup, swap, drop', () => {
    expect(vm('push 1\npush 2\nswap\noutnum\noutnum\nend').output).toBe('12');
    expect(vm('push 7\ndup\nadd\noutnum\nend').output).toBe('14');
    expect(vm('push 1\npush 2\ndrop\noutnum\nend').output).toBe('1');
  });

  it('copy n copies the n-th item, 0 being the top', () => {
    const r = vm('push 10\npush 20\npush 30\ncopy 2\ncopy 0\nend');
    expect(r.stack).toEqual([10n, 20n, 30n, 10n, 10n]);
    expect(vm('push 1\ncopy 1\nend').error).toMatchObject({ index: 1, op: 'copy' });
    expect(vm('push 1\ncopy -1\nend').error?.message).toMatch(/copy -1/);
  });

  it('slide n removes n items under the top', () => {
    expect(vm('push 1\npush 2\npush 3\npush 4\nslide 2\nend').stack).toEqual([1n, 4n]);
    expect(vm('push 1\npush 2\nslide 0\nend').stack).toEqual([1n, 2n]);
    // Like the reference interpreter: sliding more than there is keeps only the top.
    expect(vm('push 1\npush 2\npush 3\nslide 9\nend').stack).toEqual([3n]);
    expect(vm('push 1\npush 2\nslide -1\nend').stack).toEqual([1n, 2n]);
  });

  it('reports a stack underflow with the instruction index and mnemonic', () => {
    expect(vm('push 1\nadd\nend').error).toMatchObject({ index: 1, op: 'add' });
    expect(vm('dup\nend').error?.message).toMatch(/stack underflow: dup needs 1 value/);
    expect(vm('push 1\nswap').error?.message).toMatch(/swap needs 2 values and the stack holds 1/);
    expect(vm('outchar').error?.op).toBe('outchar');
    expect(vm('jz x\nlabel x').error?.op).toBe('jz');
  });
});

describe('arithmetic', () => {
  it('pops b then a and pushes a op b', () => {
    expect(vm('push 7\npush 3\nadd\nend').stack).toEqual([10n]);
    expect(vm('push 7\npush 3\nsub\nend').stack).toEqual([4n]);
    expect(vm('push 7\npush -3\nmul\nend').stack).toEqual([-21n]);
  });

  it('div and mod use floor semantics (Haskell div/mod)', () => {
    const cases: [number, number, number, number][] = [
      [7, 2, 3, 1],
      [-7, 2, -4, 1],
      [7, -2, -4, -1],
      [-7, -2, 3, -1],
      [6, 3, 2, 0],
      [-6, 3, -2, 0],
      [0, -5, 0, 0],
    ];
    for (const [a, b, d, m] of cases) {
      expect(floorDiv(BigInt(a), BigInt(b))).toBe(BigInt(d));
      expect(floorMod(BigInt(a), BigInt(b))).toBe(BigInt(m));
      const r = vm(`push ${a}\npush ${b}\ndiv\npush ${a}\npush ${b}\nmod\nend`);
      expect(r.stack).toEqual([BigInt(d), BigInt(m)]);
    }
  });

  it('uses arbitrary precision', () => {
    const src = ['push 1', ...Array<string>(100).fill('push 2\nmul'), 'outnum', 'end'].join('\n');
    expect(vm(src).output).toBe((2n ** 100n).toString());
  });

  it('fails on division by zero', () => {
    expect(vm('push 1\npush 0\ndiv\nend').error).toMatchObject({ index: 2, op: 'div' });
    expect(vm('push 1\npush 0\nmod\nend').error?.message).toMatch(/division by zero/);
  });
});

describe('heap', () => {
  it('stores and retrieves, never-stored cells read as 0', () => {
    const r = vm('push 5\npush 42\nstore\npush 5\nretrieve\npush 6\nretrieve\nend');
    expect(r.stack).toEqual([42n, 0n]);
    expect(r.heap.size).toBe(1);
  });

  it('accepts negative and huge addresses and overwrites', () => {
    const big = (2n ** 80n).toString();
    const r = vm(
      `push -3\npush 1\nstore\npush -3\npush 2\nstore\npush ${big}\npush 9\nstore\npush -3\nretrieve\npush ${big}\nretrieve\nend`,
    );
    expect(r.stack).toEqual([2n, 9n]);
  });
});

describe('flow control', () => {
  it('jumps to labels marked later, and loops', () => {
    // Count down from 3: prints 321.
    const src = lines(
      'push 3',
      'loop:',
      'dup',
      'jz done',
      'dup',
      'outnum',
      'push 1',
      'sub',
      'jump loop',
      'done:',
      'end',
    );
    expect(vm(src).output).toBe('321');
  });

  it('jz jumps only on 0, jn only on negative values', () => {
    const test = (jump: string, v: number) =>
      vm(`push ${v}\n${jump} yes\npush 0\noutnum\nend\nyes:\npush 1\noutnum\nend`).output;
    expect(test('jz', 0)).toBe('1');
    expect(test('jz', 5)).toBe('0');
    expect(test('jz', -1)).toBe('0');
    expect(test('jn', -1)).toBe('1');
    expect(test('jn', 0)).toBe('0');
    expect(test('jn', 3)).toBe('0');
  });

  it('calls nested subroutines and returns', () => {
    const src = lines(
      'call a',
      "push 'C'",
      'outchar',
      'end',
      'a:',
      "push 'A'",
      'outchar',
      'call b',
      "push 'a'",
      'outchar',
      'ret',
      'b:',
      "push 'B'",
      'outchar',
      'ret',
    );
    expect(vm(src).output).toBe('ABaC');
  });

  it('compares labels as strings (S and SS are different, the empty label works)', () => {
    const code = [
      'LSL' + 'SS' + 'L', // jump SS
      'LSS' + 'S' + 'L', // label S
      'SS' + encodeNumber(1n) + 'TLST' + 'LLL', // print 1, end
      'LSS' + 'SS' + 'L', // label SS
      'LST' + 'L', // call ""
      'SS' + encodeNumber(2n) + 'TLST' + 'LLL', // print 2, end
      'LSS' + 'L', // label ""
      'SS' + encodeNumber(3n) + 'TLST' + 'LTL', // print 3, return
    ].join('');
    expect(execute(parse(code), { input: '', stepLimit: 100 }).output).toBe('32');
  });

  it('fails on an unknown label only when the jump is taken', () => {
    expect(vm('jump nowhere\nend').error).toMatchObject({ index: 0, op: 'jump' });
    expect(vm('jump nowhere\nend').error?.message).toMatch(/never marked/);
    expect(vm('push 1\njz nowhere\nend').stopped).toBe('end');
    expect(vm('call nowhere').error?.op).toBe('call');
  });

  it('fails on ret with an empty call stack', () => {
    expect(vm('push 1\nret').error).toMatchObject({ index: 1, op: 'ret' });
  });

  it('end stops; running off the last instruction is reported', () => {
    const r = vm("push 'x'\noutchar\nend\npush 'y'\noutchar");
    expect(r).toMatchObject({ output: 'x', stopped: 'end', steps: 3 });
    expect(vm("push 'x'\noutchar").stopped).toBe('fell-off');
  });

  it('a partial instruction code at the very end is running off the end, not an error', () => {
    const r = execute(parse(`${assemble("push 'x'\noutchar")}L`), { input: '', stepLimit: 100 });
    expect(r).toMatchObject({ output: 'x', stopped: 'fell-off', partialEnd: 'L' });
    expect(r.error).toBeUndefined();
    // An unterminated argument cannot run: still an error.
    const u = execute(parse(`${assemble("push 'x'\noutchar")}SSST`), { input: '', stepLimit: 9 });
    expect(u.error).toMatchObject({ op: 'incomplete', step: 3 });
  });

  it('numbers the failing step the same way for runtime and parse errors', () => {
    expect(vm('dup').error).toMatchObject({ index: 0, step: 1 });
    expect(execute(parse('SSSTLTLL'), { input: '', stepLimit: 9 }).error).toMatchObject({
      index: 1,
      op: 'invalid',
      step: 2,
    });
  });

  it('the first of two identical labels wins', () => {
    const r = vm('jump x\nx:\npush 1\noutnum\nend\nx:\npush 2\noutnum\nend');
    expect(r.output).toBe('1');
    expect(r.duplicateLabels).toEqual([assemble('label x').slice(3, -1)]);
  });

  it('fails when execution reaches unparsable code, ignores it otherwise', () => {
    const bad = parse(`${assemble("push 'A'\noutchar")}TLL`);
    const r = execute(bad, { input: '', stepLimit: 100 });
    expect(r.output).toBe('A');
    expect(r.error).toMatchObject({ index: 2, op: 'invalid', step: 3 });
    const ok = parse(`${assemble("push 'A'\noutchar\nend")}SS`);
    expect(execute(ok, { input: '', stepLimit: 100 }).stopped).toBe('end');
  });
});

describe('I/O', () => {
  it('prints characters (any code point) and numbers', () => {
    expect(vm("push 'é'\noutchar\npush 0x1F600\noutchar\npush -42\noutnum\nend").output).toBe(
      'é😀-42',
    );
  });

  it('prints U+FFFD for values that are not characters', () => {
    const r = vm('push -1\noutchar\npush 0xD800\noutchar\npush 0x110000\noutchar\nend');
    expect(r.output).toBe('���');
    expect(r.badChars).toBe(3);
  });

  it('readchar stores code points, then -1 at the end of the input', () => {
    const src = lines(
      'push 0',
      'readchar',
      'push 1',
      'readchar',
      'push 2',
      'readchar',
      'push 0',
      'retrieve',
      'push 1',
      'retrieve',
      'push 2',
      'retrieve',
      'end',
    );
    expect(vm(src, 'a😀').stack).toEqual([97n, 0x1f600n, -1n]);
    expect(vm(src, '').stack).toEqual([-1n, -1n, -1n]);
  });

  it('readnum reads one decimal integer per line', () => {
    const src =
      'push 0\nreadnum\npush 1\nreadnum\npush 0\nretrieve\npush 1\nretrieve\nadd\noutnum\nend';
    expect(vm(src, '12\n-5\n').output).toBe('7');
    expect(vm(src, ' +40 \r\n2').output).toBe('42');
    expect(vm(src, '123456789012345678901234567890\n0').output).toBe(
      '123456789012345678901234567890',
    );
  });

  it('readnum fails at the end of the input or on a non-number', () => {
    expect(vm('push 0\nreadnum\nend', '').error).toMatchObject({ index: 1, op: 'readnum' });
    expect(vm('push 0\nreadnum\nend', '').error?.message).toMatch(/no input left/);
    expect(vm('push 0\nreadnum\nend', 'abc\n').error?.message).toMatch(/"abc".*not a decimal/);
  });

  it('mixes readchar and readnum on the same input', () => {
    const src =
      'push 0\nreadchar\npush 1\nreadnum\npush 0\nretrieve\noutchar\npush 1\nretrieve\noutnum\nend';
    expect(vm(src, 'x99\n').output).toBe('x99');
  });

  it('the Input option understands escapes', () => {
    expect(unescapeInput('a\\nb\\tc\\x41\\u00e9\\u{1F600}\\\\n')).toBe('a\nb\tcAé😀\\n');
  });

  it('the tool passes the Input option to the program', async () => {
    // cat: read characters until -1, print them.
    const cat = assemble(
      lines(
        'loop:',
        'push 0',
        'readchar',
        'push 0',
        'retrieve',
        'dup',
        'jn done',
        'outchar',
        'jump loop',
        'done:',
        'end',
      ),
    );
    expect(await programOutput(toWhitespace(cat), { input: 'hi\\nthere' })).toBe('hi\nthere');
  });
});

describe('step and output limits', () => {
  it('stops runaway programs at the step limit, keeping the output so far', () => {
    const r = vm("loop:\npush 'A'\noutchar\njump loop", '', 30);
    expect(r).toMatchObject({ stopped: 'step-limit', steps: 30 });
    expect(r.output).toBe('A'.repeat(10));
  });

  it('the tool warns at the step limit and still shows the output', async () => {
    const out = await runTool(toWhitespace(assemble("loop:\npush 'A'\noutchar\njump loop")), {
      extract: 'all',
      steps: 3000,
    });
    expect(resultToText(out)).toContain('Stopped at the step limit');
    expect(block(out, 'Program output')).toBe('A'.repeat(1000));
  });

  it('stops at the output limit', () => {
    const r = execute(parse(assemble("loop:\npush 'A'\noutchar\njump loop")), {
      input: '',
      stepLimit: 1_000_000,
      outputLimit: 50,
    });
    expect(r).toMatchObject({ stopped: 'output-limit', output: 'A'.repeat(50) });
  });
});

describe('the four samples print "FTF\\n"', () => {
  const cases = [
    ['esolang-ftf.ws', 'all'],
    ['esolang-ftf-poem.txt', 'trailing'],
    ['esolang-ftf-interleaved.txt', 'all'],
    ['esolang-ftf-markers.txt', 'markers'],
  ] as const;

  it.each(cases)('%s (auto)', async (name, mode) => {
    const out = await runTool(sample(name));
    expect(block(out, 'Program output')).toBe('FTF\n');
    const note = out[0]!;
    expect(note.type === 'note' && note.text).toMatch(
      mode === 'all' ? /all whitespace/ : mode === 'trailing' ? /trailing/ : /between "BEGIN"/,
    );
  });

  it.each(cases)('%s (explicit %s extraction)', async (name, mode) => {
    expect(await programOutput(sample(name), { extract: mode })).toBe('FTF\n');
  });

  it('the program uses the heap, a conditional loop and a subroutine', () => {
    const names = parse(toLetters(utf8Decode(sample('esolang-ftf.ws')))).instrs.map(
      (i) => i.op.name,
    );
    for (const op of ['store', 'retrieve', 'jz', 'jump', 'call', 'ret', 'outchar', 'end']) {
      expect(names).toContain(op);
    }
  });

  it('the poem is exactly what hideInCover() makes of the program (script and tool agree)', () => {
    const code = toLetters(utf8Decode(sample('esolang-ftf.ws')));
    const poem = utf8Decode(sample('esolang-ftf-poem.txt'));
    const cover = poem
      .split('\n')
      .map((l) => l.replace(/[ \t]+$/, ''))
      .join('\n');
    expect(hideInCover(code, cover).text).toBe(poem);
    expect(cover).not.toMatch(/\t/); // the visible poem has only ordinary spaces
  });

  it('the wrong extraction does not print FTF', async () => {
    const poem = await runTool(sample('esolang-ftf-poem.txt'), { extract: 'all' });
    expect(block(poem, 'Program output')).toBeUndefined();
    expect(notes(poem, 'error')[0]).toMatch(/instruction #17 \(invalid\)/);
    // Every line of the interleaved file ends with a letter: no trailing whitespace at all.
    expect(await toolError(sample('esolang-ftf-interleaved.txt'), { extract: 'trailing' })).toMatch(
      /No spaces or tabs found at the end of any line/,
    );
  });
});

describe('extraction', () => {
  it('all: every space, tab and line feed, with source lines', () => {
    const ex = extractAll('a b\n\tc\r\nd ');
    expect(ex.code).toBe('SLTLS');
    expect(Array.from(ex.lines)).toEqual([1, 1, 2, 2, 3]);
  });

  it('trailing: the trailing spaces/tabs of each line then its line feed', () => {
    expect(extractTrailing('one two \t\nthree\nfour\t', 'count').code).toBe('STLLT');
    expect(extractTrailing('one two \t\nthree\nfour\t', 'skip').code).toBe('STLT');
    // Inner whitespace and leading indentation are not part of it.
    expect(extractTrailing('  a b\t c \n', 'count').code).toBe('SL');
  });

  it('trailing "lead": lines before the first coded one are skipped, the others count', () => {
    const text = 'Title\n\nfirst \nsecond\nthird\t\n';
    expect(extractTrailing(text, 'count').code).toBe('LLSLLTL');
    expect(extractTrailing(text, 'lead').code).toBe('SLLTL');
    expect(extractTrailing(text, 'skip').code).toBe('SLTL');
    expect(Array.from(extractTrailing(text, 'lead').lines)).toEqual([3, 3, 4, 5, 5]);
  });

  it('trailing ignores the CR of CRLF line endings', () => {
    expect(extractTrailing('ab \t\r\ncd\t\r\n', 'count').code).toBe('STLTL');
  });

  it('markers: the whitespace between the first start and the next end marker', () => {
    const text = 'x END y BEGIN \t\n END z \t';
    const r = markerRegion(text, 'BEGIN', 'END')!;
    expect(extractMarkers(text, r).code).toBe('STLS');
    expect(r.endFound).toBe(true);
    expect(r.lineFrom).toBeNull();
    expect(markerRegion(text, 'NOPE', 'END')).toBeNull();
    const open = markerRegion('BEGIN \t', 'BEGIN', 'END')!;
    expect(open.endFound).toBe(false);
    expect(extractMarkers('BEGIN \t', open).code).toBe('ST');
    const t2 = 'a\nb BEGIN\t';
    expect(extractMarkers(t2, markerRegion(t2, 'BEGIN', '')!).lines[0]).toBe(2);
    expect(extractMarkers(' \t', markerRegion(' \t', '', '')!).code).toBe('ST');
  });

  it('markers on their own lines: the line break after the start marker can be skipped', () => {
    const text = 'intro\r\nBEGIN\r\n \t\nEND\r\nafter';
    const r = markerRegion(text, 'BEGIN', 'END')!;
    expect(r.lineFrom).toBe(r.from + 2);
    expect(extractMarkers(text, r, false).code).toBe('LSTL');
    expect(extractMarkers(text, r, true).code).toBe('STL');
    expect(extractMarkers(text, r, true).lines[0]).toBe(3);
    const poem = 'x\nBEGIN\na \t\nb\nEND\n';
    expect(
      extractMarkersTrailing(poem, markerRegion(poem, 'BEGIN', 'END')!, 'count'),
    ).toMatchObject({ code: 'STLL' });
  });

  it('letters: S, T, L in any case and [Space] [Tab] [LF] words', () => {
    expect(extractLetters('SS sT L\n[Space][TAB][lf] [Line Feed] x').code).toBe('SSSTLSTLL');
    expect(looksLikeLetters('SSSTSSSTTSL TLSS\nSSSTSTSTSSL TLSS LLL')).toBe(true);
    expect(looksLikeLetters('[Space][Space][Tab][LF][Space][Tab][LF][LF]')).toBe(true);
    expect(looksLikeLetters('Still, this is a sentence.')).toBe(false);
  });

  it('runs CRLF files', async () => {
    const crlf = (name: string) => utf8Encode(utf8Decode(sample(name)).replace(/\n/g, '\r\n'));
    expect(await programOutput(crlf('esolang-ftf.ws'))).toBe('FTF\n');
    expect(await programOutput(crlf('esolang-ftf-poem.txt'))).toBe('FTF\n');
    expect(await programOutput(crlf('esolang-ftf-poem.txt'), { extract: 'trailing' })).toBe(
      'FTF\n',
    );
    expect(await programOutput(crlf('esolang-ftf-markers.txt'), { extract: 'markers' })).toBe(
      'FTF\n',
    );
  });

  it('keeps a BOM (a comment) and reports it', async () => {
    const bytes = utf8Encode(`\ufeff${utf8Decode(sample('esolang-ftf.ws'))}`);
    expect(decodeSource(bytes).text.charCodeAt(0)).toBe(0xfeff);
    const out = await runTool(bytes);
    expect(block(out, 'Program output')).toBe('FTF\n');
    expect(resultToText(out)).toContain('⟨BOM⟩ ×1');
  });

  it('explains a missing start marker or empty extraction', async () => {
    expect(await toolError('hello \t\n', { extract: 'markers', start: '<<' })).toMatch(
      /start marker "<<" does not appear/,
    );
    expect(await toolError('no\ntrailing\nhere', { extract: 'trailing' })).toMatch(
      /at the end of any line/,
    );
    expect(await toolError('nothing-at-all', { extract: 'all' })).toMatch(/No spaces or tabs/);
    expect(await toolError('only\nline\nfeeds\n')).toMatch(/No spaces or tabs found anywhere/);
    expect(await toolError('')).toMatch(/Paste a Whitespace program/);
  });
});

describe('runtime errors are an error note, with the output so far and the disassembly', () => {
  const program = (src: string) => toWhitespace(assemble(src));

  it.each([
    ['push 1\nadd\nend', /instruction #1 \(add\), step 2: stack underflow/],
    ['push 1\npush 0\ndiv\nend', /instruction #2 \(div\).*division by zero/],
    ['jump nope\nend', /instruction #0 \(jump\).*never marked/],
    ['ret', /instruction #0 \(ret\).*empty call stack/],
    ['push 0\nreadnum\nend', /instruction #1 \(readnum\).*no input left/],
  ])('%j', async (src, message) => {
    expectCrash(await runTool(program(src), { extract: 'all' }), message);
  });

  it('reports an unterminated number when execution reaches it', async () => {
    const code = `${assemble("push 'A'\noutchar")}SSSTT`;
    const out = await runTool(toWhitespace(code), { extract: 'all' });
    expectCrash(out, /instruction #2 \(incomplete\), step 3: .*unterminated number/, 'A');
  });

  it('auto mode says that nothing ran cleanly and lists what every extraction did', async () => {
    const out = await runTool(program("push 'O'\noutchar\npush 'K'\noutchar\nadd"));
    expectCrash(out, /instruction #4 \(add\)/, 'OK');
    expect(notes(out, 'warn')[0]).toMatch(
      /^Auto: no extraction gives a program that runs without an error and prints text\. The closest, all whitespace, printed "OK" and then stopped with an error.*Tried: all whitespace → printed "OK", then error at #4 \(add\)/,
    );
  });

  it('assembler errors give the line', () => {
    expect(() => assemble('push 1\nfrobnicate')).toThrow(
      /Line 2: unknown instruction "frobnicate"/,
    );
    expect(() => assemble('push')).toThrow(/Line 1: push needs a number/);
    expect(() => assemble('push abc')).toThrow(/"abc" is not a number/);
    expect(() => assemble('dup 3')).toThrow(/dup takes no argument/);
    expect(() => assemble('jump a b')).toThrow(/not a label/);
    expect(() => assemble('; only a comment')).toThrow(ToolError);
  });
});

describe('reveal', () => {
  it('makes every invisible character visible', () => {
    const r = reveal(' \t\n\r\u00a0\u200b\u200c\u200d\u2060\ufeff\u2003x\u0007\ufe0f\u{e0061}');
    expect(r.text).toBe('·→⏎\n␍⟨NBSP⟩⟨ZWSP⟩⟨ZWNJ⟩⟨ZWJ⟩⟨WJ⟩⟨BOM⟩⟨EMSP⟩x⟨BEL⟩⟨VS16⟩⟨TAG:a⟩');
    expect(r.special.get('ZWSP')).toBe(1);
    expect(r.special.has('·')).toBe(false);
  });

  it('truncates very long input', () => {
    const r = reveal('ab'.repeat(10), 5);
    expect(r).toMatchObject({ text: 'ababa', truncated: true });
  });

  it('the tool shows the revealed text, invisible characters and a per-line table', async () => {
    const out = await runTool(sample('esolang-ftf-poem.txt'));
    const revealed = out.find((o) => o.type === 'text' && o.label?.startsWith('Revealed'));
    expect(revealed?.type === 'text' && revealed.value).toContain(
      'The·Quiet·Keeper····⏎\n···→···→→·⏎',
    );
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.columns).toEqual([
      'Line',
      'Visible text',
      'Trailing count',
      'Trailing S/T',
    ]);
    expect(table?.type === 'table' && table.rows[0]).toEqual([1, 'The Quiet Keeper', 4, 'SSSS']);
    // A bare program has no visible text: no table.
    expect((await runTool(sample('esolang-ftf.ws'))).some((o) => o.type === 'table')).toBe(false);
    const zw = await runTool(`hi\u200b${toWhitespace(assemble("push 'A'\noutchar\nend"))}`, {
      extract: 'all',
    });
    expect(resultToText(zw)).toContain('⟨ZWSP⟩ ×1');
    // Not a trailing extraction and the run is clean: no per-line table.
    expect(zw.some((o) => o.type === 'table')).toBe(false);
  });

  it('marks invisible characters of the program output', () => {
    expect(markInvisible('A\u0000B\u0007\n\tC')).toEqual({ text: 'A⟨NUL⟩B⟨BEL⟩\n\tC', count: 2 });
  });

  it('summarizes lines', () => {
    expect(summarizeLines('a \t\r\n\t\nb')).toEqual([
      { line: 1, visible: 'a', trailing: 'ST' },
      { line: 2, visible: '', trailing: 'T' },
      { line: 3, visible: 'b', trailing: '' },
    ]);
  });
});

describe('assembler and disassembler', () => {
  const EVERYTHING = lines(
    'push 0',
    'push -1',
    'push 123456789012345678901234567890',
    "push 'F'",
    "push '\\n'",
    "push ';'",
    "push '#'",
    'push 0x41',
    'push 0b101',
    'dup',
    'copy 2',
    'swap',
    'drop',
    'slide 1',
    'add',
    'sub',
    'mul',
    'div',
    'mod',
    'store',
    'retrieve',
    'start:',
    'label TS',
    'label 5',
    'label ""',
    'call start',
    'jump TS',
    'jz 5',
    'jn ""',
    'ret',
    'outchar',
    'outnum',
    'readchar',
    'readnum',
    'end',
  );

  it('the disassembly is valid assembler input (round trip)', () => {
    const code = assemble(EVERYTHING);
    const parsed = parse(code);
    expect(parsed.tail).toBeUndefined();
    expect(parsed.instrs).toHaveLength(35);
    const listing = disassemble(parsed);
    expect(assemble(listing)).toBe(code);
  });

  it('cuts long number literals in the token column, and the listing still assembles', () => {
    const code = assemble(`push ${2n ** 70n}\noutnum\npush 9\npush 100\npush 'é'\noutchar\nend`);
    const listing = disassemble(parse(code));
    expect(listing).toMatch(/ SS STS+…S+L {2}push 1180591620717411303424\n/);
    expect(listing.split('\n')[1]!.indexOf('push')).toBeLessThan(40);
    const rows = listing.split('\n').slice(1);
    const at = rows.map((r) => r.search(/(push|outnum|outchar|end)/));
    expect(new Set(at).size).toBe(1); // the instruction column is aligned
    expect(assemble(listing)).toBe(code);
    // Characters are noted for printable ASCII, and for others only when they are printed.
    expect(listing).toMatch(/push 100\s+; 'd'/);
    expect(listing).toMatch(/push 9$/m);
    expect(listing).toMatch(/push 233\s+; 'é'/);
    expect(disassemble(parse(assemble('push 1234\noutnum')))).toMatch(/push 1234$/m);
  });

  it('round-trips the FTF sample and shows readable lines', () => {
    const code = toLetters(utf8Decode(sample('esolang-ftf.ws')));
    const listing = disassemble(parse(code));
    expect(assemble(listing)).toBe(code);
    expect(listing).toMatch(/SS STSSSTTSL\s+push 70\s+; 'F'/);
    expect(listing).toMatch(/LST TSL\s+call TS\s+; L2/);
    expect(listing).toMatch(/LLL\s+end/);
  });

  it('marks unknown labels, duplicates and the unparsable tail in the listing', () => {
    const listing = disassemble(parse(`${assemble('jump nowhere\nx:\nx:')}TLL`));
    expect(listing).toMatch(/jump T\s+; never marked/);
    expect(listing).toMatch(/L1 again/);
    expect(listing).toMatch(
      /parsing stops here: TLL \(tab, line feed, line feed\) is not a Whitespace instruction/,
    );
  });

  it('gives symbolic labels codes that do not collide with literal ones', () => {
    const code = assemble('jump T\nloop:\nend\nT:\njump loop');
    const parsed = parse(code);
    expect(parsed.instrs.map((i) => i.label)).toEqual(['T', 'TS', undefined, 'T', 'TS']);
    expect(execute(parsed, { input: '', stepLimit: 10 }).stopped).toBe('end');
  });

  it('understands aliases and labels written name:', () => {
    const src = "start: printc_test:\n push 'k'\n printc\n exit";
    expect(() => assemble(src)).toThrow(/unknown instruction "printc_test:"/);
    expect(vm("x: push 'k'\nprintc\nexit").output).toBe('k');
    expect(vm('push 5\ndiscard\npush 3\nprintn\nhalt').output).toBe('3');
    expect(vm("jmp a\npush 'n'\nprintc\na:\npush 'y'\nputc\nexit").output).toBe('y');
  });

  it('the tool assembles, shows the bytes and test-runs the program', async () => {
    const src = "push 'O'\noutchar\npush 'K'\noutchar\nend";
    const out = await runTool(src, { mode: 'assemble' });
    const bytes = out.find((o) => o.type === 'bytes');
    expect(bytes?.type === 'bytes' && utf8Decode(bytes.value)).toBe(toWhitespace(assemble(src)));
    expect(block(out, 'Program output (test run)')).toBe('OK');
    expect(block(out, 'Revealed program')).toMatch(/^···→··→→→→⏎\n→⏎\n··/); // push 79, outchar
    expect(resultToText(out)).toContain('Assembled 5 instructions');
  });
});

describe('Text → Whitespace', () => {
  const run = (code: string) => execute(parse(code), { input: '', stepLimit: 1_000_000 }).output;

  it.each(['FTF\n', 'flag{wh1t3_sp4c3}', 'é 😀 \t\r\n', ' '])('round-trips %j', (text) => {
    const { code, listing } = textToProgram(text);
    expect(run(code)).toBe(text);
    expect(assemble(listing)).toBe(code);
  });

  it('the tool generates a pure whitespace program that prints the text', async () => {
    const out = await runTool('FTF', { mode: 'generate' });
    const bytes = out.find((o) => o.type === 'bytes');
    const program = bytes?.type === 'bytes' ? utf8Decode(bytes.value) : '';
    expect(program).toMatch(/^[ \t\n]+$/);
    expect(block(out, 'Program output (test run)')).toBe('FTF');
    expect(await programOutput(program)).toBe('FTF');
  });

  it('hides the program in the trailing whitespace of a cover text', async () => {
    const out = await runTool('FTF\n', {
      mode: 'generate',
      cover: 'Roses are red, \\nviolets are blue.\\nthis line is plain',
    });
    const bytes = out.find((o) => o.type === 'bytes');
    const hidden = bytes?.type === 'bytes' ? utf8Decode(bytes.value) : '';
    const visible = hidden.split('\n').map((l) => l.replace(/[ \t]+$/, ''));
    expect(visible.slice(0, 3)).toEqual([
      'Roses are red,',
      'violets are blue.',
      'this line is plain',
    ]);
    expect(visible.slice(3).every((l) => l === '')).toBe(true);
    expect(resultToText(out)).toMatch(/empty line\(s\) added.*1 cover line\(s\) had their own/);
    expect(block(out, 'Program output (test run)')).toBe('FTF\n');
    expect(await programOutput(hidden, { extract: 'trailing' })).toBe('FTF\n');
    expect(await programOutput(hidden)).toBe('FTF\n');
  });

  it('a long cover keeps its extra lines and still works', () => {
    const { code } = textToProgram('A');
    const cover = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const h = hideInCover(code, cover);
    expect(h.linesAdded).toBe(0);
    expect(h.text.split('\n')).toHaveLength(12);
    expect(run(extractTrailing(h.text, 'count').code)).toBe('A');
  });

  it('refuses empty text', async () => {
    expect(await toolError('', { mode: 'generate' })).toMatch(/Type the text/);
  });
});

describe('tool modes and report', () => {
  it('Run shows output, disassembly, reveal and stats in that order', async () => {
    const out = await runTool(sample('esolang-ftf.ws'));
    const order = out.map((o) => (o.type === 'text' ? o.label : o.type));
    expect(order).toEqual([
      'note',
      'Program output',
      'Disassembly',
      'Revealed text (· space, → tab, ⏎ line feed, ␍ carriage return)',
      'kv',
    ]);
    const kv = out.find((o) => o.type === 'kv');
    expect(kv?.type === 'kv' && Object.fromEntries(kv.entries)).toMatchObject({
      Instructions: '27',
      'Stack depth at end': '2',
      'Heap cells': '4',
    });
  });

  it('warns when the program has no end', async () => {
    const out = await runTool(toWhitespace(assemble("push 'z'\noutchar")), { extract: 'all' });
    expect(block(out, 'Program output')).toBe('z');
    expect(resultToText(out)).toContain('ran off its last instruction without an end');
  });

  it('Disassemble does not run in an explicit mode and never fails on runtime errors', async () => {
    const crash = toWhitespace(assemble('add\nend'));
    const explicit = await runTool(crash, { mode: 'disasm', extract: 'all' });
    expect(block(explicit, 'Program output')).toBeUndefined();
    expect(resultToText(explicit)).toContain('(not run)');
    expect(block(explicit, 'Disassembly')).toMatch(/TSSS\s+add/);
    const auto = await runTool(crash, { mode: 'disasm' });
    expect(resultToText(auto)).toMatch(/Run: instruction #0 \(add\), step 1/);
  });

  it('Disassemble counts distinct labels, not marks', async () => {
    const out = await runTool(toWhitespace(assemble('x:\nx:\ny:\nend')), {
      mode: 'disasm',
      extract: 'all',
    });
    const kv = out.find((o) => o.type === 'kv');
    expect(kv?.type === 'kv' && Object.fromEntries(kv.entries).Labels).toBe('2');
  });

  it('hides Input and Step limit when nothing runs, shows the markers in auto mode', () => {
    const o = tool.options!;
    const v = (x: Record<string, unknown>) => ({ ...defaults, ...x });
    expect(o.input.showIf!(v({ mode: 'disasm', extract: 'all' }))).toBe(false);
    // Disassemble + Auto only gives each extraction a short fixed trial run.
    expect(o.steps.showIf!(v({ mode: 'disasm', extract: 'auto' }))).toBe(false);
    expect(o.input.showIf!(v({ mode: 'disasm', extract: 'auto' }))).toBe(false);
    expect(o.steps.showIf!(v({ mode: 'assemble' }))).toBe(true);
    expect(o.input.showIf!(v({ mode: 'run' }))).toBe(true);
    expect(o.start.showIf!(v({ mode: 'run', extract: 'auto' }))).toBe(true);
    expect(o.end.showIf!(v({ mode: 'run', extract: 'trailing' }))).toBe(false);
    expect(o.bareLines.showIf!(v({ mode: 'run', extract: 'markers-trailing' }))).toBe(true);
  });

  it('an output that reads like text beats noise in auto mode', () => {
    expect(outputScore('FTF\n')).toBeGreaterThan(outputScore('\u0001\u0002\u0003\u0004'));
    expect(outputScore('flag{x}')).toBeGreaterThan(outputScore('flagx'));
    expect(outputScore('')).toBe(0);
  });
});

describe('detect', () => {
  const detect = (bytes: Uint8Array) => tool.detect!({ text: utf8Decode(bytes), bytes, name: 'x' });

  it('runs the extractions: a program that prints text is near certain', () => {
    expect(detect(sample('esolang-ftf.ws'))).toMatchObject({
      score: 0.9,
      reason: 'A Whitespace program in all whitespace prints "FTF"',
    });
    for (const name of [
      'esolang-ftf-poem.txt',
      'esolang-ftf-interleaved.txt',
      'esolang-ftf-markers.txt',
    ]) {
      expect(detect(sample(name))?.score, name).toBe(0.9);
    }
  });

  it('finds programs interleaved with letters, between own-line markers, in UTF-16', () => {
    const interleaved = [...toWhitespace(textToProgram('Mixed').code)].map((c) => `w${c}`).join('');
    expect(detect(utf8Encode(interleaved))?.score).toBe(0.9);
    const marked = `Notes\nBEGIN\n${toWhitespace(textToProgram('Lines').code)}END\nbye\n`;
    expect(detect(utf8Encode(marked))).toMatchObject({
      score: 0.9,
      reason: 'A Whitespace program in between markers (own lines) prints "Lines"',
    });
    const program = toWhitespace(textToProgram('U16').code);
    const le = Uint8Array.from([0xff, 0xfe, ...[...program].flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(tool.detect!({ text: null, bytes: le, name: 'x' })?.score).toBe(0.9);
  });

  it('falls back to the shape of the text when nothing runs cleanly', () => {
    const noOutput = toWhitespace(assemble('push 1\npush 2\nadd\ndrop\nend'));
    expect(detect(utf8Encode(noOutput.repeat(3)))).toMatchObject({
      score: 0.8,
      reason: 'Mostly spaces, tabs and line feeds',
    });
    const junk = 'one \t\ntwo\t\t\nthree  \t\nfour\t \nfive\n';
    expect(detect(utf8Encode(junk))?.score).toBe(0.55);
  });

  it('ignores ordinary text and Markdown line breaks', () => {
    expect(detect(utf8Encode('Just a sentence.\nAnother one here.\n'))).toBeNull();
    expect(detect(utf8Encode('a  \nb  \nc  \nd  \ne  \n'))).toBeNull();
    expect(detect(utf8Encode('       \n\n   '))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Regression cases from independent black-box verification. Programs are given as S/T/L letters
// (separators ignored) and run as real whitespace with "All whitespace", unless said otherwise.
// Every program and cover text here is made up for these tests.
// ---------------------------------------------------------------------------------------------

/** S/T/L letters -> real whitespace; anything else (spaces, commas) is a separator. */
const ws = (letters: string) => toWhitespace(letters.replace(/[^STL]/g, ''));
const numL = (n: bigint | number) => encodeNumber(BigInt(n));
const pushL = (n: bigint | number) => `SS${numL(n)}`;
const OUTC = 'TLSS';
const OUTN = 'TLST';
const SPACE = `${pushL(32)}${OUTC}`;
const END = 'LLL';
const runL = (letters: string, opts: Partial<Opts> = {}) =>
  runTool(ws(letters), { extract: 'all', ...opts });
const printedL = async (letters: string, opts: Partial<Opts> = {}) =>
  block(await runL(letters, opts), 'Program output');
/** A program printing `text` (push + outchar per character, then end). */
const print = (text: string) => textToProgram(text).code;

const COVER = [
  'Low tide keeps the harbour lamps awake',
  'and gulls argue over borrowed bread',
  'the ferry hums a song it cannot finish',
  'while rope and rust exchange their weather',
  'a child counts boats and loses count',
  'the lighthouse blinks in patient morse',
  'salt writes small letters on the glass',
  'nobody reads them but the wind',
  'the nets come home with nothing in them',
  'and still the sea pretends to listen',
  'evening folds the water like a letter',
  'stamped with one star and sent away',
];

/** The program in the trailing whitespace of the cover lines (cycled), one piece per line. */
function hidePoem(code: string, cover: readonly string[] = COVER): string {
  const need = Math.max(1, code.split('L').length - 1);
  const rows = Array.from({ length: need }, (_, i) => cover[i % cover.length]!);
  return hideInCover(code, rows.join('\n')).text;
}

/** Stores `text` in the heap, prints it with a loop calling a subroutine, then prints `n`. */
function progLoop(text: string, n: number): string {
  const src: string[] = [];
  [...text].forEach((ch, i) => src.push(`push ${i}`, `push ${ch.codePointAt(0)}`, 'store'));
  src.push(
    'push 0',
    'loop:',
    'dup',
    'retrieve',
    'dup',
    'jz done',
    'call show',
    'push 1',
    'add',
    'jump loop',
    'show:',
    'outchar',
    'ret',
    'done:',
    'drop',
    'drop',
    `push ${n}`,
    'outnum',
    'end',
  );
  return assemble(src.join('\n'));
}

const utf16le = (text: string, bom: boolean) => {
  const units = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  const bytes = units.flatMap((u) => [u & 0xff, u >> 8]);
  return Uint8Array.from(bom ? [0xff, 0xfe, ...bytes] : bytes);
};

describe('regression: stack, numbers and arithmetic', () => {
  it.each([
    ['push+outchar "Hi" + end', 'SSSTSSTSSSLTLSSSSSTTSTSSTLTLSSLLL', 'Hi'],
    ['outnum positive 12345', 'SSSTTSSSSSSTTTSSTLTLSTLLL', '12345'],
    ['push negative -42, outnum', 'SSTTSTSTSLTLSTLLL', '-42'],
    ['zero with no digits (+0 "SL" and -0 "TL")', 'SSSLTLSTSSTLTLSTLLL', '00'],
    ['leading zero digits (+2, -3)', 'SSSSSTSLTLSTSSTSSTTLTLSTLLL', '2-3'],
    ['dup: 7 dup add', 'SSSTTTLSLSTSSSTLSTLLL', '14'],
    ['swap: push 1, push 2, swap, outn, outn', 'SSSTLSSSTSLSLTTLSTTLSTLLL', '12'],
    ['discard: push 1 push 2 drop outn', 'SSSTLSSSTSLSLLTLSTLLL', '1'],
    [
      'copy n: [10,20,30] copy 2/0/1 then stack intact',
      'SSSTSTSLSSSTSTSSLSSSTTTTSLSTSSTSLTLSTSTSSSLTLSTSTSSTLTLSTSSSTSSSSSLTLSSTLSTTLSTTLSTLLL',
      '103020 302010',
    ],
    [
      'slide: [1,2,3,4] slide 2 -> [1,4]; slide 0 no-op',
      'SSSTLSSSTSLSSSTTLSSSTSSLSTLSTSLSTLSSLTLSTTLSTLLL',
      '41',
    ],
    [
      'arith operand order: 10-3, 3-10, -6*7, 5+(-8)',
      'SSSTSTSLSSSTTLTSSTTLSTSSSTSSSSSLTLSSSSSTTLSSSTSTSLTSSTTLSTSSSTSSSSSLTLSSSSTTTSLSSSTTTLTSSLTLSTSSSTSSSSSLTLSSSSSTSTLSSTTSSSLTSSSTLSTLLL',
      '7 -7 -42 -3',
    ],
    [
      'heap argument order (pop value, pop address)',
      'SSSTLSSSTSLTTSSSSTSLTTTTLSTSSSTSSSSSLTLSSSSSTLTTTTLSTLLL',
      '0 2',
    ],
  ])('%s', async (_name, letters, expected) => {
    expect(await printedL(letters)).toBe(expected);
  });

  it('big push 2^70+1 and -(2^65)', async () => {
    const letters = `SSST${'S'.repeat(69)}TL${OUTN}${SPACE}SSTT${'S'.repeat(65)}L${OUTN}${END}`;
    expect(await printedL(letters)).toBe('1180591620717411303425 -36893488147419103232');
  });

  it('big arithmetic 2^64*2^64 and 2^64+2^64-1', async () => {
    const p64 = `SSST${'S'.repeat(64)}L`;
    const letters = `${p64}SLSTSSL${OUTN}${SPACE}${p64}SLSTSSSSSSTLTSST${OUTN}${END}`;
    expect(await printedL(letters)).toBe(
      '340282366920938463463374607431768211456 36893488147419103231',
    );
  });

  const pairs: [number, number][] = [
    [7, 2],
    [-7, 2],
    [7, -2],
    [-7, -2],
    [-6, 2],
    [6, -3],
    [0, -5],
    [1, 3],
    [-1, 3],
  ];
  const divProgram = (op: string) =>
    pairs.map(([a, b]) => `${pushL(a)}${pushL(b)}${op}${OUTN}${SPACE}`).join('') + END;

  it('floor div, every sign combination', async () => {
    expect(await printedL(divProgram('TSTS'))).toBe('3 -4 -4 3 -3 -2 0 0 -1 ');
  });

  it('floor mod (sign of the divisor), same pairs', async () => {
    expect(await printedL(divProgram('TSTT'))).toBe('1 1 -1 -1 0 0 0 1 2 ');
  });

  it('big floor div/mod: -(2^100) div 3, -(2^100) mod 3, 2^100 mod -7', async () => {
    const neg = `SSTT${'S'.repeat(100)}L`;
    const pos = `SSST${'S'.repeat(100)}L`;
    const letters = `${neg}SSSTTLTSTS${OUTN}${SPACE}${neg}SSSTTLTSTT${OUTN}${SPACE}${pos}SSTTTTLTSTT${OUTN}${END}`;
    expect(await printedL(letters)).toBe('-422550200076076467165567735126 2 -5');
  });

  it('heap: store/retrieve, default 0, negative and 2^70 addresses, overwrite', async () => {
    const big = 2n ** 70n;
    const store = (a: bigint | number, v: number) => `${pushL(a)}${pushL(v)}TTS`;
    const get = (a: bigint | number) => `${pushL(a)}TTT${OUTN}`;
    const letters = [
      store(5, 99),
      store(-3, 7),
      store(big, -1),
      store(5, 100),
      get(5),
      SPACE,
      get(6),
      SPACE,
      get(-3),
      SPACE,
      get(big),
      END,
    ].join('');
    expect(await printedL(letters)).toBe('100 0 7 -1');
  });

  it('push 2^1000-1, outnum', async () => {
    const out = await printedL(`SSS${'T'.repeat(1000)}L${OUTN}${END}`);
    expect(out).toBe((2n ** 1000n - 1n).toString());
    expect(out).toHaveLength(302);
  });

  it('C12 arithmetic floor div/mod, BigInt, copy/slide/swap/mul/sub (pure file, auto)', async () => {
    const src = [
      'push -7',
      'push 2',
      'div',
      'outnum',
      "push ' '",
      'outchar',
      'push -7',
      'push 2',
      'mod',
      'outnum',
      "push ' '",
      'outchar',
      'push 7',
      'push -2',
      'div',
      'outnum',
      "push ' '",
      'outchar',
      'push 7',
      'push -2',
      'mod',
      'outnum',
      "push ' '",
      'outchar',
      `push ${2n ** 70n}`,
      'outnum',
      "push ' '",
      'outchar',
      'push 1',
      'push 2',
      'push 3',
      'copy 2',
      'outnum',
      "push ' '",
      'outchar',
      'push 10',
      'push 20',
      'push 30',
      'slide 2',
      'outnum',
      "push ' '",
      'outchar',
      'push 5',
      'push 6',
      'swap',
      'outnum',
      'outnum',
      "push ' '",
      'outchar',
      'push 3',
      'push 4',
      'mul',
      'push 2',
      'sub',
      'outnum',
      'end',
    ].join('\n');
    expect(await programOutput(toWhitespace(assemble(src)))).toBe(
      '-4 1 -4 -1 1180591620717411303424 1 30 56 10',
    );
  });
});

describe('regression: labels and flow control', () => {
  it.each([
    [
      'jump to a label used before it is marked',
      'LSLTSTLSSSTSTTSSSLTLSSLSSTSTLSSSTSTTSSTLTLSSLLL',
      'Y',
    ],
    ['empty label: jmp "" / mark ""', 'LSLLSSSTSTTSSSLTLSSLSSLSSSTSSTSTTLTLSSLLL', 'K'],
    [
      'labels compared as strings: S, SS, TS, STS distinct',
      'LSLSSLLSSSLSSSTTSSSSTLTLSSLLLLSSSSLLSTSTSLLSTTSLLLLLSSTSLSSSTTTSTSSLTLSSLTLLSSSTSLSSSTTTSSTTLTLSSLTL',
      'st',
    ],
    [
      'labels "", S, SS, T all distinct (call each)',
      'LSTLLSTSLLSTSSLLSTTLLLLLSSTLSSSTTSTSSLTLSSLTLLSSSSLSSSTTSSTTLTLSSLTLLSSSLSSSTTSSTSLTLSSLTLLSSLSSSTTSSSTLTLSSLTL',
      '1234',
    ],
    [
      'nested call/return main->A->B',
      'LSTTTLSSSTSSSTSTLTLSSLLLLSSTTLSSSTTSSSSTLTLSSLSTTSSLSSSTTSSSTTLTLSSLTLLSSTSSLSSSTTSSSTSLTLSSLTL',
      'abcE',
    ],
    [
      'recursive subroutine printing 4..1',
      'SSSTSSLLSTTLLLLLSSTLSLSLTSTTLSLSTLSTSSSTLTSSTLSTTLLSSTTLLTL',
      '4321',
    ],
    [
      'call to subroutine marked later in the file',
      'LSTTTSSTLSSSTSSSSTLTLSSLLLLSSTTSSTLSSSTTTSSTTLTLSSSSSTTTSTSTLTLSSSSSTTSSSTSLTLSSLTL',
      'sub!',
    ],
    ['jz loop countdown 3..1', 'SSSTTLLSSSLSLSTLSTSSSTLTSSTSLSLTSTLLSLSLLSSTLSLLLLL', '321'],
    ['jn loop -3..-1, 0 does not jump', 'SSTTTLLSSSLSLSTLSTSSSTLTSSSSLSLTTSLTLSTLLL', '-3-2-10'],
    [
      'backward jz and forward jmp',
      'LSLTLLSSSLSSSTTSSSTSLTLSSLLLLSSTLSSSTTSSTTSLTLSSSSSSLLTSSLSSSTSTTSSSLTLSSLLL',
      'fb',
    ],
    ['end in the middle; code after is ignored', 'SSSTSSSSSTLTLSSLLLSSSTSSSSTSLTLSS', 'A'],
    ['invalid code after end is never reached', 'SSSTSSSSSTLTLSSLLLSTTSL', 'A'],
    [
      'end inside a subroutine stops the program',
      'LSTSLSSSTSTTSSSLTLSSLLLLSSSLSSSTTSTSSTLTLSSSSSTTSTTTSLTLSSLLL',
      'in',
    ],
  ])('%s', async (_name, letters, expected) => {
    expect(await printedL(letters)).toBe(expected);
  });

  it('jz pops and ignores -1; jn ignores 0 and 1', async () => {
    const out = await runL(
      'SSTTLLTSTLSSSSLLTTTLSSSTLLTTTLSSSTTSTTTTLTLSSSSSTTSTSTTLTLSSLLLLSSTLSSSTSSSSTSLTLSSSSSTSSSSSTLTLSSSSSTSSSTSSLTLSSLLL',
    );
    expect(block(out, 'Program output')).toBe('ok');
    const kv = out.find((o) => o.type === 'kv');
    expect(kv?.type === 'kv' && Object.fromEntries(kv.entries)['Stack depth at end']).toBe('0');
  });

  it('64-token label', async () => {
    const lab = `${'ST'.repeat(32)}L`;
    const letters = `LSL${lab}${pushL(88)}${OUTC}LSS${lab}${pushL(76)}${OUTC}${END}`;
    expect(await printedL(letters)).toBe('L');
  });

  it('C18 empty label, forward jump, jn, astral code point', async () => {
    const src = [
      'jump ""',
      "push 'B'",
      'outchar',
      'label ""',
      'push -1',
      'jn L5',
      "push 'X'",
      'outchar',
      'label 5',
      "push 'o'",
      'outchar',
      "push 'k'",
      'outchar',
      'push 0x1F600',
      'outchar',
      'end',
    ].join('\n');
    expect(await programOutput(toWhitespace(assemble(src.replace('jn L5', 'jn 5'))))).toBe('ok😀');
  });

  it('program without trailing LLL', async () => {
    const out = await runL('SSSTSSTTTTLTLSSSSSTSSTSTTLTLSS');
    expect(block(out, 'Program output')).toBe('OK');
    expect(notes(out, 'warn').join(' ')).toMatch(/ran off its last instruction without an end/);
  });

  it('duplicate label mark: a warning', async () => {
    const out = await runL('LSSTLLSSTLLLL');
    expect(notes(out, 'warn').join(' ')).toMatch(/marked more than once: T\. The first mark wins/);
    expect(notes(out, 'error')).toEqual([]);
  });
});

describe('regression: input and output', () => {
  const read3 =
    'SSSSLTLTSSSSTLTLTSSSSTSLTLTSSSSSLTTTTLSTSSSTSSSSSLTLSSSSSTLTTTTLSTSSSTSSSSSLTLSSSSSTSLTTTTLSTLLL';

  it('readchar "AB" then EOF', async () => {
    expect(await printedL(read3, { input: 'AB' })).toBe('65 66 -1');
  });

  it('readchar non-BMP input reads code points, not UTF-16 units', async () => {
    expect(await printedL(read3, { input: 'é😀' })).toBe('233 128512 -1');
  });

  it('readchar on empty input', async () => {
    expect(await printedL('SSSTSSTLTLTSSSSTSSTLTTTTLSTLLL', { input: '' })).toBe('-1');
  });

  it('readchar escapes: \\n, then \\t \\x41 \\u{1F600}', async () => {
    expect(await printedL('SSSSLTLTSSSSSLTTTTLSTLLL', { input: '\\n' })).toBe('10');
    expect(await printedL(read3, { input: '\\t\\x41\\u{1F600}' })).toBe('9 65 128512');
  });

  it('readnum two lines "42\\n-17" summed', async () => {
    expect(
      await printedL('SSSSLTLTTSSSTLTLTTSSSSLTTTSSSTLTTTTSSSTLSTLLL', { input: '42\\n-17' }),
    ).toBe('25');
  });

  it('readnum big value + 1 (real newline in the input)', async () => {
    expect(
      await printedL('SSSSLTLTTSSSSLTTTSSSTLTSSSTLSTLLL', {
        input: '123456789012345678901234567890\n',
      }),
    ).toBe('123456789012345678901234567891');
  });

  it('readchar then readnum reads the rest of the line', async () => {
    const letters = 'SSSSLTLTSSSSTLTLTTSSSSLTTTTLSTSSSTSSSSSLTLSSSSSTLTTTTLSTLLL';
    expect(await printedL(letters, { input: 'x12\\n' })).toBe('120 12');
  });

  it('readnum then readchar (the line feed is consumed by readnum)', async () => {
    const letters = 'SSSSLTLTTSSSTLTLTSSSSSLTTTTLSTSSSTSSSSSLTLSSSSSTLTTTTLSTLLL';
    expect(await printedL(letters, { input: '5\\nZ' })).toBe('5 90');
  });

  it.each([
    [' 7 ', '7'],
    ['42\r\n', '42'],
    ['-0', '0'],
    ['8', '8'],
  ])('readnum tolerant parsing of %j', async (input, expected) => {
    expect(await printedL('SSSSLTLTTSSSSLTTTTLSTLLL', { input })).toBe(expected);
  });

  it('readnum stores at the popped address (1000)', async () => {
    const letters = 'SSSTTTTTSTSSSLTLTTSSSTTTTTSTSSSLTTTSSSTSLTSSLTLSTLLL';
    expect(await printedL(letters, { input: '21' })).toBe('42');
  });

  it('readnum at EOF: error, partial output "<" kept', async () => {
    const out = await runL('SSSTTTTSSLTLSSSSSSLTLTTSSSSLTTTTLSTLLL', { input: '' });
    expectCrash(out, /\(readnum\).*no input left/, '<');
  });

  it('readnum on a non-numeric line', async () => {
    expectCrash(
      await runL('SSSSLTLTTLLL', { input: 'abc' }),
      /readnum read the input line "abc", which is not a decimal integer/,
    );
  });

  it('C13 readnum + readchar with the Input option', async () => {
    const src = [
      'push 100',
      'readnum',
      'push 101',
      'readchar',
      'push 102',
      'readchar',
      'push 103',
      'readchar',
      'push 104',
      'readchar',
      'push 100',
      'retrieve',
      'push 2',
      'mul',
      'outnum',
      'push 103',
      'retrieve',
      'outchar',
      'push 102',
      'retrieve',
      'outchar',
      'push 101',
      'retrieve',
      'outchar',
      'push 104',
      'retrieve',
      'outnum',
      'end',
    ].join('\n');
    const prog = toWhitespace(assemble(src));
    expect(await programOutput(prog, { input: '21\\nabc' })).toBe('42cba-1');
    expect(await programOutput(prog, { input: '21\nabc' })).toBe('42cba-1');
    expectCrash(await runTool(prog), /no input left/);
    expectCrash(await runTool(prog, { input: 'abc\\nxyz' }), /"abc", which is not a decimal/);
    const echo = toWhitespace(assemble('push 0\nreadnum\npush 0\nretrieve\noutnum\nend'));
    expect(await programOutput(echo, { input: '  -17  ' })).toBe('-17');
  });

  it('outchar non-ASCII: é, 中, 😀', async () => {
    const letters = 'SSSTTTSTSSTLTLSSSSSTSSTTTSSSTSTTSTLTLSSSSSTTTTTSTTSSSSSSSSSLTLSSLLL';
    expect(await printedL(letters)).toBe('é中😀');
  });

  it('outchar NUL and lone surrogate 0xD800: printed, warned, and shown marked', async () => {
    const out = await runL('SSSTSSSSSTLTLSSSSSSLTLSSSSSTTSTTSSSSSSSSSSSLTLSSSSSTSSSSTSLTLSSLLL');
    expect(block(out, 'Program output')).toBe('A\u0000�B');
    expect(block(out, 'Output, invisible characters shown')).toBe('A⟨NUL⟩�B');
    expect(notes(out, 'warn').join(' ')).toMatch(/1 outchar value\(s\) were not valid/);
  });

  it.each([
    ['-1', 'SSTTLTLSSLLL'],
    ['0x110000', 'SSSTSSSTSSSSSSSSSSSSSSSSLTLSSLLL'],
    ['2^70', `SSST${'S'.repeat(70)}L${OUTC}${END}`],
  ])('outchar of the invalid code point %s: U+FFFD and a warning', async (_n, letters) => {
    const out = await runL(letters);
    expect(block(out, 'Program output')).toBe('�');
    expect(notes(out, 'warn').join(' ')).toMatch(/not valid Unicode code points/);
  });

  it('long output (405 characters) then a runtime error keeps every character', async () => {
    const text = `flag_${'abcdefghij'.repeat(40)}`;
    const letters = [...text].map((c) => `${pushL(c.charCodeAt(0))}${OUTC}`).join('') + OUTN + END;
    const out = await runL(letters);
    const msg = expectCrash(out, /instruction #810 \(outnum\), step 811: stack underflow/, text);
    expect(msg).not.toContain('flag_'); // the output is in its own block, not in the message
    expect(text).toHaveLength(405);
  });
});

describe('regression: comments, line endings and layout', () => {
  const HI = 'SSSTSSTSSSLTLSSSSSTTSTSSTLTLSSSSSTSSSSTLTLSSSSTTSTLTLSTLLL';
  const between = (letters: string, fill: (i: number) => string) =>
    [...ws(letters)].map((c, i) => fill(i) + c).join('');

  it('comments between every token (letters, digits, punctuation, é, €, emoji)', async () => {
    const chars = [...'abcxyzé€😀0123,.;#'];
    const text = `${between(HI, (i) => chars[i % chars.length]!)}trailing words`;
    expect(await programOutput(text, { extract: 'all' })).toBe('Hi!-5');
  });

  it('comments made of the letters S, T and L', async () => {
    const words = ['STL', 'Lst', 'TTS'];
    const text = `${between(HI, (i) => words[i % 3]!)}STILL_LAST`;
    expect(await programOutput(text, { extract: 'all' })).toBe('Hi!-5');
    expect(await programOutput(text)).toBe('Hi!-5');
  });

  it('other Unicode spaces are comments (NBSP, VT, FF, ZWSP, U+3000, U+2003)', async () => {
    const odd = ['\u00a0', '\u000b', '\u000c', '\u200b', '\u3000', '\u2003'];
    expect(
      await programOutput(
        between(HI, (i) => odd[i % 6]!),
        { extract: 'all' },
      ),
    ).toBe('Hi!-5');
  });

  it('CRLF line endings, and a lone CR before every token', async () => {
    expect(await programOutput(ws(HI).replace(/\n/g, '\r\n'), { extract: 'all' })).toBe('Hi!-5');
    expect(
      await programOutput(
        between(HI, () => '\r'),
        { extract: 'all' },
      ),
    ).toBe('Hi!-5');
  });

  it("'x' after every token (prose-like interleave)", async () => {
    const text = [...ws('SSSTTSTTTTLTLSSSSSTTSTSTTLTLSSLLL')].map((c) => `${c}x`).join('');
    expect(await programOutput(text, { extract: 'all' })).toBe('ok');
  });

  it('C6 program in all whitespace, interleaved with letters (default options)', async () => {
    const text =
      'W h e r\te T h\te\tR i\tv\ne\tr\nM e e t s T\th\te S\te a W\te\nW\tr\ni t e N o t\th\ti\tn\tg W h e\nr\te\nT h e R i v\te\tr M e\te t\ts\nT\th\ne S e a W e\tW\tr i t\te N o\nt\th\ni n g\nW\nh\n.';
    expect(await programOutput(text)).toBe('Mixed');
  });

  it('C1 pure Whitespace file: heap + call/ret + loop + forward label', async () => {
    const text =
      '   \n   \t  \t\t  \n\t\t    \t\n   \t\t \t\t\t\t\n\t\t    \t \n   \t\t \t\t\t\t\n\t\t    \t\t\n   \t\t\t    \n\t\t    \t  \n   \t     \n\t\t    \t \t\n   \t  \t\t\t\t\n\t\t    \t\t \n   \t  \t \t\t\n\t\t    \t\t\t\n   \t \t \n\t\t    \t   \n   \n\t\t    \n\n \t\t\n   \t  \t\t \t  \t \n\t\n \t\n\n\n\n  \t\n\n  \t \n \n \t\t\t \n \n\t \t\t\n\t\n     \t\n\t   \n \n\t \n\n  \t\t\n \n\n \n\n\n\t\n';
    expect(await programOutput(text)).toBe('Loop OK\n1234');
  });

  it('C16 pure Whitespace program with no end instruction', async () => {
    const out = await runTool(toWhitespace(print('NoEnd').slice(0, -3)));
    expect(block(out, 'Program output')).toBe('NoEnd');
    expect(notes(out, 'warn').join(' ')).toMatch(/without an end/);
    // No self-contradicting headline.
    expect(notes(out, 'info')[0]).toMatch(
      /^Auto: the program is in all whitespace\. The "line ends.*" extractions? gives? the same program\. By hand/,
    );
    expect(notes(out, 'info')[0]).not.toMatch(/no other extraction/i);
  });

  it('C22 pure Whitespace with CRLF', async () => {
    expect(await programOutput(toWhitespace(print('CR')).replace(/\n/g, '\r\n'))).toBe('CR');
  });
});

describe('regression: errors and limits', () => {
  it('underflow on outnum after output', async () => {
    expectCrash(await runL('SSSTSSSSSTLTLSSTLSTLLL'), /\(outnum\), step 3: stack underflow/, 'A');
  });

  it.each([
    ['add', 'SSSTLTSSSLLL'],
    ['swap', 'SSSTLSLTLLL'],
    ['dup', 'SLSLLL'],
    ['store', 'SSSTLTTSLLL'],
    ['jz', 'LTSSLLSSSLLLL'],
  ])('underflow on %s', async (op, letters) => {
    expectCrash(await runL(letters), new RegExp(`\\(${op}\\).*stack underflow: ${op} needs`));
  });

  it.each([
    ['5', 'SSSTLSTSSTSTLTLSTLLL', 'copy 5'],
    ['2^70', `SSSTLSTSST${'S'.repeat(70)}L${END}`, `copy ${2n ** 70n}`],
  ])('copy index out of range (%s)', async (_n, letters, text) => {
    expectCrash(await runL(letters), new RegExp(`${text}: the stack holds 1 item`));
  });

  it('copy -1: a negative index is never valid, whatever the stack holds', async () => {
    expectCrash(await runL('SSSTLSTSTTLTLSTLLL'), /copy -1: the index must be 0 or more/);
  });

  it.each([
    ['5', 'SSSTLSSSTSLSTLSTSTLTLSTLLL', '2'],
    ['2^70', `SSSTLSSSTSLSTLST${'S'.repeat(70)}LTLSTLLL`, '2'],
    ['-1', 'SSSTLSSSTSLSTLTTLTLSTTLSTLLL', '21'],
  ])('slide %s (beyond the stack, or negative: x : drop n xs)', async (_n, letters, expected) => {
    expect(await printedL(letters)).toBe(expected);
  });

  it('unknown label (jmp, and call after output)', async () => {
    expectCrash(await runL('LSLTTTLLLL'), /\(jump\).*label TTT is never marked/);
    expectCrash(await runL('SSSTTTTSTSLTLSSLSTTSTSLLLL'), /\(call\).*TSTS is never marked/, 'z');
  });

  it('division and modulo by zero', async () => {
    expectCrash(await runL('SSSTLSSSSLTSTSTLSTLLL'), /\(div\).*division by zero \(1 div 0\)/);
    expectCrash(await runL('SSSTLSSSSLTSTTTLSTLLL'), /\(mod\).*division by zero \(1 mod 0\)/);
  });

  it('return without call keeps "r"', async () => {
    expectCrash(await runL('SSSTTTSSTSLTLSSLTL'), /\(ret\).*empty call stack/, 'r');
  });

  it('invalid stack instruction STT is named exactly', async () => {
    const msg = expectCrash(await runL('SSSTSSSSSTLSTTSLLLL'), /\(invalid\), step 2/);
    expect(msg).toContain('STT (space, tab, tab) is not a Whitespace instruction');
  });

  it('invalid I/O instruction TLL is named exactly', async () => {
    const msg = expectCrash(await runL('SSSTSSSSSTLTLLLLL'), /\(invalid\)/);
    expect(msg).toContain('TLL (tab, line feed, line feed) is not');
  });

  it('truncated number / truncated label', async () => {
    expectCrash(await runL('SSSTST'), /\(incomplete\), step 1: .*unterminated number after push/);
    expectCrash(await runL('LSSTST'), /unterminated label after label/);
  });

  it('runaway loop stopped by the step limit (steps=1000)', async () => {
    const out = await runL('LSSSLLSLSL', { steps: 1000 });
    expect(notes(out, 'warn').join(' ')).toMatch(/Stopped at the step limit \(1 000 instructions/);
    expect(notes(out, 'error')).toEqual([]);
  });

  it('runaway output loop keeps the partial output (steps=30)', async () => {
    const out = await runL('LSSSLSSSTTTTSSSLTLSSLSLSL', { steps: 30 });
    expect(block(out, 'Program output')).toBe('x'.repeat(10));
    expect(notes(out, 'warn').join(' ')).toMatch(/step limit/);
  });

  it('infinite recursion (call self) stops cleanly', async () => {
    expectCrash(await runL('LSSSLLSTSL'), /1 000 000 nested calls/);
  });

  it('infinite push loop stops cleanly at the stack limit', async () => {
    expectCrash(await runL('LSSSLSSSTLLSLSL'), /more than 2 000 000 values/);
  });

  it('step limit boundary: 5 instructions with steps=5, then steps=4', async () => {
    const hi = 'SSSTSSTSSSLTLSSSSSTTSTSSTLTLSSLLL';
    const five = await runL(hi, { steps: 5 });
    expect(block(five, 'Program output')).toBe('Hi');
    expect(notes(five, 'warn')).toEqual([]);
    const four = await runL(hi, { steps: 4 });
    expect(block(four, 'Program output')).toBe('Hi');
    expect(notes(four, 'warn').join(' ')).toMatch(/step limit \(4 instructions/);
  });

  it('runtime errors and limits (assembled programs)', async () => {
    const run = (src: string, opts: Partial<Opts> = {}) =>
      runTool(toWhitespace(assemble(src)), { extract: 'all', ...opts });
    expectCrash(await run("push 'A'\noutchar\npush 1\npush 0\ndiv"), /division by zero/, 'A');
    expectCrash(await run("push 'r'\noutchar\nret"), /empty call stack/, 'r');
    expectCrash(await run("push 'u'\noutchar\njump 1001"), /never marked/, 'u');
    const lls = `${assemble("push 'B'\noutchar")}LLSSSL`;
    expectCrash(
      await runTool(ws(lls), { extract: 'all' }),
      /LLS \(line feed, line feed, space\)/,
      'B',
    );
    const loop = await run('x:\npush 120\noutchar\njump x', { steps: 200 });
    expect(block(loop, 'Program output')).toMatch(/^x+$/);
    expect(notes(loop, 'warn').join(' ')).toMatch(/step limit/);
    expect(block(await run('push -5\noutchar\nend'), 'Program output')).toBe('�');
    const dup = await run("label 1\nlabel 1\npush 'd'\noutchar\nend");
    expect(block(dup, 'Program output')).toBe('d');
    expect(notes(dup, 'warn').join(' ')).toMatch(/more than once/);
    const ctl = await run(
      "push 0\noutchar\npush 7\noutchar\npush 'o'\noutchar\npush 'k'\noutchar\nend",
    );
    expect(block(ctl, 'Program output')).toBe('\u0000\u0007ok');
    expect(block(ctl, 'Output, invisible characters shown')).toBe('⟨NUL⟩⟨BEL⟩ok');
  });
});

describe('regression: extraction from cover texts', () => {
  const FTF = 'SSSTSSSTTSLTLSSSSSTSTSTSSLTLSSSSSTSSSTTSLTLSSLLL';
  const roses = [
    'Roses are red',
    'Violets are blue',
    'Sugar is sweet',
    'And so are you',
    'The rain is wet',
    'The sky is wide',
    'The sea is deep',
    'The road is long',
    'The night is still',
    'The day is done',
    'The book is shut',
    'The lamp is out',
  ];
  const rosePoem = FTF.split('L')
    .map((seg, i) => `${roses[i % roses.length]}${ws(seg)}`)
    .join('\n');

  it('trailing: program in the line ends of a poem (explicit and auto)', async () => {
    expect(await programOutput(rosePoem, { extract: 'trailing' })).toBe('FTF');
    expect(await programOutput(rosePoem)).toBe('FTF');
    expect(await programOutput(rosePoem.replace(/\n/g, '\r\n'), { extract: 'trailing' })).toBe(
      'FTF',
    );
  });

  it('auto on a bare program, and markers with spaced words around', async () => {
    expect(await programOutput(ws(FTF))).toBe('FTF');
    const text = `some words here BEGIN${ws(FTF)}END and more words\n`;
    expect(await programOutput(text, { extract: 'markers' })).toBe('FTF');
    expect(await programOutput(text)).toBe('FTF');
  });

  it('C2 program in the trailing whitespace of an original poem', async () => {
    const text =
      'Low tide keeps the harbour lamps awake   \t \t    \nand gulls argue over borrowed bread\t\nthe ferry hums a song it cannot finish     \t\t \t\t\t\t\nwhile rope and rust exchange their weather\t\na child counts boats and loses count     \t\t  \t \t\nthe lighthouse blinks in patient morse\t\nsalt writes small letters on the glass     \t\t \t\t \t\nnobody reads them but the wind\t\nthe nets come home with nothing in them  \nand still the sea pretends to listen\nevening folds the water like a letter\n';
    const out = await runTool(text);
    expect(block(out, 'Program output')).toBe('Poem');
    expect(notes(out, 'info')[0]).toMatch(/^Auto: the program is in the trailing spaces\/tabs/);
    expect(notes(out, 'info')[0]).toContain(
      'By hand: Program is in = "Line ends (trailing spaces/tabs)", Lines without trailing spaces/tabs = "Count (each gives its L)".',
    );
    // C19: Disassemble mode on the same poem.
    const dis = block(await runTool(text, { mode: 'disasm' }), 'Disassembly')!;
    expect(dis).toMatch(/push 80\s+; 'P'/);
    expect(dis).toMatch(/TLSS\s+outchar/);
    expect(dis).toMatch(/LLL\s+end/);
  });

  it('C3 trailing + plain poem lines after the end, no final newline', async () => {
    const text = `${hidePoem(print('Tail'))}the end of the song\nwritten on the shore\nby nobody`;
    expect(await programOutput(text)).toBe('Tail');
  });

  const C4 =
    'Harbour Song\n\nLow tide keeps the harbour lamps awake   \t \t \t  \nand gulls argue over borrowed bread\t\nthe ferry hums a song it cannot finish     \t\t \t  \t\nwhile rope and rust exchange their weather\t\na child counts boats and loses count     \t\t\t \t  \nthe lighthouse blinks in patient morse\t\nsalt writes small letters on the glass     \t\t \t\t  \nnobody reads them but the wind\t\nthe nets come home with nothing in them     \t\t  \t \t\nand still the sea pretends to listen\t\nevening folds the water like a letter  \nstamped with one star and sent away\nLow tide keeps the harbour lamps awake\n';

  it('C4 poem with a title line and a blank line before the coded stanza', async () => {
    const out = await runTool(C4);
    expect(block(out, 'Program output')).toBe('Title');
    expect(notes(out, 'warn')).toEqual([]); // it ends with its own end instruction
    expect(notes(out, 'info')[0]).toMatch(/starting|before the first one that has some/);
    const lead = await runTool(C4, { extract: 'trailing', bareLines: 'lead' });
    expect(block(lead, 'Program output')).toBe('Title');
    const skip = await runTool(C4, { extract: 'trailing', bareLines: 'skip' });
    expect(block(skip, 'Program output')).toBe('Title');
    expect(notes(skip, 'warn').join(' ')).toMatch(/partial instruction .*\(L\)/);
  });

  it('C5 trailing mode with CRLF line endings', async () => {
    expect(await programOutput(hidePoem(print('Crlf')).replace(/\n/g, '\r\n'))).toBe('Crlf');
  });

  const C7 =
    'Dear reader, the recipe is simple: two cups of flour and a pinch of salt. <ws>   \t  \t\t \t\n\t\n     \t\t    \t\n\t\n     \t\t\t  \t \n\t\n     \t\t \t \t\t\n\t\n  \n\n\n</ws> Bake it until golden and serve it warm to your friends.\nKind regards, the baker.\n';

  it('C7 custom inline markers <ws> … </ws> (explicit markers mode)', async () => {
    expect(await programOutput(C7, { extract: 'markers', start: '<ws>', end: '</ws>' })).toBe(
      'Mark',
    );
  });

  it('C8 the same text in auto mode, default and custom markers', async () => {
    expect(await programOutput(C7)).toBe('Mark');
    expect(await programOutput(C7, { start: '<ws>', end: '</ws>' })).toBe('Mark');
  });

  const C9 =
    'Notes from the workshop, kept for later.\nNothing interesting here, just a list of tools.\nBEGIN\n   \t  \t\t  \n\t\n     \t\t \t  \t\n\t\n     \t\t \t\t\t \n\t\n     \t\t  \t \t\n\t\n     \t\t\t  \t\t\n\t\n  \n\n\nEND\nThat is all for today, see you next week.\n';

  it('C9 BEGIN / END markers on their own lines inside prose (auto)', async () => {
    const out = await runTool(C9);
    expect(block(out, 'Program output')).toBe('Lines');
    expect(notes(out, 'info')[0]).toMatch(/between "BEGIN" and "END"/);
    const scissors = C9.replace('BEGIN', '---8<---').replace('END', '--->8---');
    expect(await programOutput(scissors, { start: '---8<---', end: '--->8---' })).toBe('Lines');
    expect(
      await programOutput(scissors, { extract: 'markers', start: '---8<---', end: '--->8---' }),
    ).toBe('Lines');
  });

  it('C9b/c/d explicit markers: plain, with a real line feed, with a \\n escape', async () => {
    const b = await runTool(C9, { extract: 'markers' });
    expect(block(b, 'Program output')).toBe('Lines');
    expect(notes(b, 'info')[0]).toMatch(/without the line break that ends the "BEGIN" line/);
    expect(await programOutput(C9, { extract: 'markers', start: 'BEGIN\n' })).toBe('Lines');
    expect(await programOutput(C9, { extract: 'markers', start: 'BEGIN\\n' })).toBe('Lines');
    // The line break after the marker is still tried as code: a program starting with a label.
    const lab = `x BEGIN${ws(`LSSTL${print('ok')}`)}END`;
    expect(await programOutput(lab, { extract: 'markers' })).toBe('ok');
  });

  it('markers on their own lines with CRLF', async () => {
    const text = `intro text here\nBEGIN\n${toWhitespace(print('Q'))}END\noutro\n`.replace(
      /\n/g,
      '\r\n',
    );
    expect(await programOutput(text)).toBe('Q');
  });

  it('a trailing-style poem between BEGIN/END lines, with a preface', async () => {
    const text = `Preface line\nBEGIN\n${hidePoem(print('In'))}END\nafter\n`;
    const out = await runTool(text);
    expect(block(out, 'Program output')).toBe('In');
    expect(notes(out, 'warn')).toEqual([]);
    expect(await programOutput(text, { extract: 'markers-trailing' })).toBe('In');
  });

  it('C11 poem indented with tabs and spaces, program in the trailing whitespace', async () => {
    const text = hidePoem(print('Tabs'))
      .split('\n')
      .map((l, i) => (l.trim() ? `${'\t'.repeat(i % 3)}${i % 2 ? '  ' : ''}${l}` : l))
      .join('\n');
    expect(text).toContain('\t  and gulls argue over borrowed bread');
    expect(await programOutput(text)).toBe('Tabs');
  });

  it('C14 zero-width characters, BOM and NBSP inside the cover', async () => {
    const text =
      'Low tide keeps the ha\u200c\ufeffrbour lamps awake   \t \t\t \t \nand gulls argue\u200b over borrowed bread\t\nthe ferry hums a\u200c\ufeff song it cannot finish     \t\t\t \t\t\t\nwhile\u200b rope and rust exchange their weather\t\na\u200c\ufeff child counts boats and loses count  \nthe\u200b lighthouse blinks in patient morse\nsa\u200c\ufefflt writes small letters on the glass\n';
    const out = await runTool(text);
    expect(block(out, 'Program output')).toBe('Zw');
    expect(resultToText(out)).toMatch(/⟨ZWNJ⟩ ×4, ⟨BOM⟩ ×4, ⟨ZWSP⟩ ×3/);
    expect(resultToText(out)).toContain('ha⟨ZWNJ⟩⟨BOM⟩rbour');
  });

  it('C17 decorative lines without code between coded lines', async () => {
    const text =
      'Low tide keeps the harbour lamps awake   \t \t  \t\t\nand gulls argue over borrowed bread\t\n~ ~ ~\nthe ferry hums a song it cannot finish     \t\t \t \t\t\nwhile rope and rust exchange their weather\t\n~ ~ ~\na child counts boats and loses count     \t\t \t  \t\nthe lighthouse blinks in patient morse\t\n~ ~ ~\nsalt writes small letters on the glass     \t\t\t    \nnobody reads them but the wind\t\n~ ~ ~\nthe nets come home with nothing in them  \n';
    for (const t of [text, text.slice(0, -1)]) {
      const skip = await runTool(t, { extract: 'trailing', bareLines: 'skip' });
      expect(block(skip, 'Program output')).toBe('Skip');
      expect(notes(skip, 'error')).toEqual([]);
      expect(notes(skip, 'warn').join(' ')).toMatch(/without an end/);
      expect(await programOutput(t)).toBe('Skip');
    }
  });

  it('C23 a long CRLF poem hiding a heap/call loop, plain lines after it', async () => {
    const code = progLoop('crlf loop', 7);
    const text = `${hidePoem(code).replace(/\n/g, '\r\n')}goodnight\r\nharbour\r\n`;
    expect(text.split('\r\n').length).toBeGreaterThan(40);
    expect(await programOutput(text)).toBe('crlf loop7');
  });

  it('a cover with tab-separated columns', async () => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `row${i}\tvalue ${i}\t\tnote  ${COVER[i]!.slice(0, 10).trim()}`,
    );
    const text = hideInCover(print('Col'), rows.join('\n')).text;
    expect(await programOutput(text)).toBe('Col');
  });

  it('S/T/L letters and [Space] [Tab] [LF] words (auto and explicit)', async () => {
    expect(await programOutput(FTF)).toBe('FTF');
    const words = FTF.replace(/S/g, '[Space]').replace(/T/g, '[Tab]').replace(/L/g, '[LF]\n');
    expect(await programOutput(words)).toBe('FTF');
    expect(await programOutput(FTF.toLowerCase(), { extract: 'letters' })).toBe('FTF');
  });
});

describe('regression: text that does not hide a program', () => {
  it('C10 trailing whitespace that is not a program (Markdown hard breaks, editor junk)', async () => {
    const text =
      '# Shopping list  \nMilk and eggs  \nBread, the dark kind \t\n    - apples\t\nCall mum about Sunday   \n\nRemember the umbrella \nand the keys\t \t\n';
    const out = await runTool(text);
    expect(block(out, 'Program output')).toBeUndefined();
    expect(notes(out, 'info').some((t) => t.startsWith('Auto: the program is in'))).toBe(false);
    expect(notes(out, 'warn')[0]).toMatch(
      /^Auto: no extraction gives a program that runs without an error and prints text, so this text probably does not hide a Whitespace program/,
    );
    expect(notes(out, 'warn')[0]).toMatch(/Tried: .*line ends → .*all whitespace → /);
  });

  it('C15 ordinary prose', async () => {
    const out = await runTool(
      'This is a perfectly ordinary paragraph.\nIt has words, and commas, and nothing else.\n',
    );
    expect(block(out, 'Program output')).toBeUndefined();
    expect(notes(out, 'warn')[0]).toMatch(/^Auto: no extraction gives a program/);
  });

  it('200 random trailing-junk poems never give a "Program output"', async () => {
    let seed = 0;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const fooled: string[] = [];
    for (let s = 1; s <= 200; s++) {
      seed = s;
      const n = 6 + Math.floor(rnd() * 14);
      const rows = Array.from({ length: n }, (_, i) => {
        const tail = Array.from({ length: Math.floor(rnd() * 12) }, () =>
          rnd() < 0.5 ? ' ' : '\t',
        ).join('');
        return `${COVER[i % COVER.length]}${tail}`;
      });
      const out = await runTool(`${rows.join('\n')}\n`);
      const printed = block(out, 'Program output');
      if (printed !== undefined) fooled.push(`${s}: ${JSON.stringify(printed)}`);
    }
    expect(fooled).toEqual([]);
  });
});

describe('regression: encodings', () => {
  it('Latin-1 bytes', async () => {
    const text = hidePoem(
      print('Lat'),
      COVER.map((l) => `café crème ${l}`),
    );
    const out = await runTool(Uint8Array.from(text, (c) => c.charCodeAt(0)));
    expect(block(out, 'Program output')).toBe('Lat');
    expect(notes(out, 'info')[0]).toBe('The file was read as Latin-1: it is not valid UTF-8.');
    expect(resultToText(out)).toContain('café·crème·Low');
  });

  it('UTF-16LE with a BOM (CRLF poem), and without a BOM (pure program)', async () => {
    const poem = hidePoem(print('U16')).replace(/\n/g, '\r\n');
    const out = await runTool(utf16le(poem, true));
    expect(block(out, 'Program output')).toBe('U16');
    expect(notes(out, 'info')[0]).toMatch(/read as UTF-16LE: it starts with the byte order mark/);
    expect(resultToText(out)).not.toContain('NUL');
    expect(await programOutput(utf16le(toWhitespace(print('U16')), false))).toBe('U16');
  });
});

describe('regression: generate and assemble round trips', () => {
  const bytesOf = (out: Output[]) => {
    const b = out.find((o) => o.type === 'bytes');
    return b?.type === 'bytes' ? b.value : new Uint8Array();
  };

  it.each([
    ['FTF', ''],
    ['FTF', 'roses are red\\nviolets are blue'],
    ['Héllo 😀\n', 'a\\nb\\nc'],
  ])('generate %j with cover %j, then run it back', async (message, cover) => {
    const made = await runTool(message, { mode: 'generate', cover });
    expect(block(made, 'Program output (test run)')).toBe(message);
    expect(await programOutput(bytesOf(made))).toBe(message);
  });

  it('assemble mnemonics', async () => {
    const out = await runTool('push 70\noutchar\npush 84\noutchar\npush 70\noutchar\nend\n', {
      mode: 'assemble',
    });
    expect(block(out, 'Program output (test run)')).toBe('FTF');
    expect(await programOutput(bytesOf(out))).toBe('FTF');
  });

  it('disassembly of every opcode: 24 rows, the right mnemonic for each', async () => {
    const code = OPS.map((o) => (o.arg === 'none' ? o.code : `${o.code}STL`)).join('');
    const out = await runTool(toWhitespace(code), { mode: 'disasm', extract: 'all' });
    const rows = block(out, 'Disassembly')!.split('\n').slice(1);
    expect(rows).toHaveLength(24);
    rows.forEach((row, i) => expect(row).toMatch(new RegExp(`\\s${OPS[i]!.name}\\b`)));
  });
});

// ---------------------------------------------------------------------------------------------
// Round-2 regression cases (independent black-box verification). Programs are S/T/L letters run
// with "All whitespace" unless said otherwise; covers, poems and programs are made up for these
// tests. A "warn"-free run must not say that the text probably hides no program.
// ---------------------------------------------------------------------------------------------

const asmL = (...src: string[]) => assemble(src.join('\n'));
/** S/T/L letters with each token preceded by fillers[i % n] (comments, junk, words...). */
const salt = (letters: string, fillers: readonly string[]) =>
  [...letters.replace(/[^STL]/g, '')]
    .map((c, i) => `${fillers[i % fillers.length]}${ws(c)}`)
    .join('');
const NOT_A_PROGRAM = /probably does not hide a Whitespace program/;
/** Every note of a run, for checks that span levels. */
const allNotes = (out: Output[]) => out.flatMap((o) => (o.type === 'note' ? [o.text] : []));
const kvOf = (out: Output[], label: string) => {
  const kv = out.find((o) => o.type === 'kv' && o.label === label);
  return kv?.type === 'kv' ? Object.fromEntries(kv.entries) : {};
};
const HEAP_WS =
  'SSSSLSSSTSTSTTTLTTSSSSTLSSSTSTSSTTLTTSSSSTSLSSSTSSSSTLTTSSSSSLLSSSLSLSTTTSLSLTSTLTLSSSSSTLTSSSLSLSLLSSTLSLLSLLLLL';
const FTF42 = 'SSSTSSSTTSLTLSSSSSTTTSTSSLTLSSSSSTTSSTTSLTLSSSSSTSTTSTLTLSSSSSTSTSTSLTLSTLLL';
const NESTED =
  'LSTTSLSSSTSSSSTLTLSSLLLLSSTSLSSSTSSSSSTLTLSSLSTTSSLSSSTSSSSTTLTLSSLTLLSSTSSLSSSTSSSSTSLTLSSLSTTSTLLTLLSSTSTLSSSTSTTTTTLTLSSLTL';
const POEM6 = [
  'The  harbour\tkeeps its lamps awake',
  'gulls\targue  over borrowed bread',
  'a ferry hums\t\ta song',
  'rope  and rust\ttrade their weather',
  'a child counts boats',
  'the lighthouse blinks\tin morse',
];

describe('regression round 2: VM semantics (pure programs)', () => {
  it.each([
    ['heap string + jz loop (heap[3] never stored = 0)', HEAP_WS, 'WS!'],
    [
      'negative arithmetic add/mul/sub order',
      'SSTTSTLSSSTTLTSSSTLSTSSSTSSSSSLTLSSSSTTTLSSSTTTLTSSLTLSTSSSTSSSSSLTLSSSSSTSTSLSSTTTLTSSTTLSTSSSTSSSSSLTLSSSSTTSTSLSSTTTLTSSTTLSTLLL',
      '-2 -21 13 -7',
    ],
    [
      'zero with no digits (+ and -), leading zero digits',
      'SSSLTLSTSSSTSTTSSLTLSSSSTLTLSTSSSTSTTSSLTLSSSSSSSSLTLSTSSSTSTTSSLTLSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSTSTLTLSTLLL',
      '0,0,0,5',
    ],
    [
      'empty label as jump target used before mark',
      'LSLLSSSTSTTSSSLTLSSLSSLSSSTSTTSSTLTLSSLLL',
      'Y',
    ],
    ['empty label as subroutine (call/ret)', 'LSTLSSSTSSSSTLTLSSLLLLSSLSSSTSSSTSTLTLSSLTL', 'E!'],
    [
      'labels "", S, SS, SSS are distinct',
      'LSLSSLLSSSLSSSTTSSSSTLTLSSLLLLSSSSLSSSTTSSSTSLTLSSLSLLLSSSSSLSSSTTSSSTTLTLSSLLLLSSLSSSTTSSTSSLTLSSLSLSSSL',
      'bdc',
    ],
    [
      'labels T, ST, SST are distinct',
      'LSLSSTLLSSTLSSSTTSSSTLTLSSLLLLSSSTLSSSTTSSTSLTLSSLLLLSSSSTLSSSTTSSTTLTLSSLSLSTL',
      '32',
    ],
    ['nested calls three deep', NESTED, 'AB_C!'],
    [
      'call inside a loop, the stack keeps the counter',
      'SSSTTLLSSTTTSTSSTTSSLSLSLTSTTTSTSSSTSTLLSTTTTSTSTSSSSLSSSTLTSSTLSLTTTSTSSTTSSLLSSTTTSTSSSTSTLLLLLSSTTTSTSTSSSSLSSSTSTSTSLTLSSLTL',
      '***',
    ],
    ['end inside a subroutine', 'LSTSLSSSTSTTSSSLTLSSLLLLSSSLSSSTSTTSSTLTLSSLLL', 'Y'],
    [
      'copy n / slide n',
      'SSSTLSSSTSLSSSTTLSTSSTSLTLSTSTSSSLTLSTSTLSTSLTLSTSSSTSTTSSLTLSSSSSTSTSLSSSTSTSSLSSSTTTTSLSSSTSTSSSLSTLSTSLTSSSTLSTLLL',
      '133,50',
    ],
    [
      'copy 3 and slide 0',
      'SSSTSTLSSSTTSLSSSTTTLSSSTSSSLSTSSTTLTLSTSTLSSLTLSTTLSTTLSTTLSTLLL',
      '58765',
    ],
    ['slide beyond the depth keeps the top', 'SSSTLSSSTSLSSSTTLSTLSTSTSLTLSTLLL', '3'],
    [
      'swap + operand order of sub',
      'SSSTLSSSTSLSLTTSSTTLSTSSSTSSSSSLTLSSSSSTSSSSSTLSSSTSSSSTSLSLTTLSSTLSSLLL',
      '1 AB',
    ],
    ['dup / drop', 'SSSTLSSSTSLSLLSLSTSSSTLSTLLL', '2'],
    [
      'outchar of non-ASCII code points',
      'SSSTTTSTSSTLTLSSSSSTTTTTSTTSSSSSSSSSLTLSSSSSTSSTTTSSSTSTTSTLTLSSSSSTSSSSSTSTSTTSSLTLSSLLL',
      'é😀中€',
    ],
    ['jn countdown loop', 'SSSTTLLSSTLSLSTLSTSSSTLTSSTSLSLTTTTLLSLTLLSSTTLSLLLLL', '3210'],
    [
      'jz loop a..e',
      'SSSTTSSSSTLLSSSLSLSTLSSSSSTLTSSSSLSSSSTTSSTTSLTSSTLTSTTTSTSSSTSTLLSLSLLSSTTTSTSSSTSTLSLLLLL',
      'abcde',
    ],
    [
      'jz pops the value whether it jumps or not',
      'SSSTTTLSSSTLLTSTTTSTSTTSTSLTLSTSSSTSTTTTLTLSSSSSTSSSLSSSSLLTSTTTSTSTTSTSLSSSTSTTSSSLTLSSLLLLSSTTTSTSTTSTSLTLSTLLL',
      '7/8',
    ],
    [
      'jn does not jump on 0, jumps on -1',
      'SSSSLLTTTTTSTSSTTTSLSSSTSTSSSSLTLSSSSTTLLTTTTTSTSSTTTSLSSSTSTTSSSLTLSSLLLLSSTTTSTSSTTTSLSSSTSSTTTSLTLSSLLL',
      'PN',
    ],
    [
      'recursive factorial(25)',
      'SSSTTSSTLLSTTTTSTSSSTTSLTLSTLLLLSSTTTSTSSSTTSLSLSLTSTTTSTSSSSTSLSLSSSSTLTSSTLSTTTTSTSSSTTSLTSSLLTLLSSTTTSTSSSSTSLSLLSSSTLLTL',
      '15511210043330985984000000',
    ],
    [
      'recursion depth 100 000 (sum 1..100000)',
      'SSSTTSSSSTTSTSTSSSSSLLSTSLTLSTLLLLSSSLSLSLTSTTTSTSTTSTSLSLSSSSTLTSSTLSTSLTSSSLTLLSSTTTSTSTTSTSLLTL',
      '5000050000',
    ],
    ['program without a final end', 'SSSTSSSSSTLTLSSSSSTSSSSTSLTLSS', 'AB'],
    [
      'duplicate label: the first mark wins',
      'LSLSLLSSSLSSSTTSSSTLTLSSLLLLSSSLSSSTTSSTSLTLSSLLL',
      '1',
    ],
    ['unreached garbage after end', 'SSSTSSSSSTLTLSSLLLTTL', 'A'],
    ['output that is only whitespace', 'SSSTSSSSSLTLSSSSSTSSTLTLSSSSSTSTSLTLSSLLL', ' \t\n'],
    ['output NUL', 'SSSSLTLSSSSSTSSSSSTLTLSSLLL', '\u0000A'],
  ])('%s', async (_name, letters, expected) => {
    expect(await printedL(letters)).toBe(expected);
  });

  it('big numbers beyond 2^64: push, mul, add, negative', async () => {
    const big = 1180591620717411303429n;
    const neg = -1267650600228229401496703205376n;
    const code = asmL(
      `push ${big}`,
      'outnum',
      'push 32',
      'outchar',
      `push ${2n ** 64n}`,
      'dup',
      'mul',
      'outnum',
      'push 32',
      'outchar',
      `push ${neg}`,
      'outnum',
      'push 32',
      'outchar',
      `push ${2n ** 64n - 1n}`,
      'push 1',
      'add',
      'outnum',
      'end',
    );
    expect(await printedL(code)).toBe(`${big} ${2n ** 128n} ${neg} ${2n ** 64n}`);
    expect(await printedL(asmL(`push ${2n ** 300n}`, 'push 1', 'sub', 'outnum', 'end'))).toBe(
      String(2n ** 300n - 1n),
    );
  });

  it('floor div / mod for every sign combination and big operands', async () => {
    const pairs: [bigint, bigint][] = [
      [7n, 2n],
      [-7n, 2n],
      [7n, -2n],
      [-7n, -2n],
      [-6n, 3n],
      [6n, -3n],
      [1n, 5n],
      [-1n, 5n],
      [0n, -3n],
      [100n, -7n],
      [-100n, 7n],
      [-36893488147419103233n, 2n],
      [36893488147419103233n, -18446744073709551616n],
    ];
    const src = pairs.flatMap(([a, b]) => [
      `push ${a}`,
      `push ${b}`,
      'div',
      'outnum',
      'push 32',
      'outchar',
      `push ${a}`,
      `push ${b}`,
      'mod',
      'outnum',
      'push 59',
      'outchar',
    ]);
    expect(await printedL(asmL(...src, 'end'))).toBe(
      '3 1;-4 1;-4 -1;3 -1;-2 0;-2 0;0 1;-1 4;0 0;-15 -5;-15 5;-18446744073709551617 1;-3 -18446744073709551615;',
    );
  });

  it('heap: default 0, overwrite, 2^70 address, negative value', async () => {
    const a = 2n ** 70n;
    const code = asmL(
      'push 999',
      'retrieve',
      'outnum',
      'push 32',
      'outchar',
      'push 5',
      'push 1',
      'store',
      'push 5',
      'push 2',
      'store',
      'push 5',
      'retrieve',
      'outnum',
      'push 32',
      'outchar',
      `push ${a}`,
      'push -7',
      'store',
      `push ${a}`,
      'retrieve',
      'outnum',
      'push 32',
      'outchar',
      `push ${a + 1n}`,
      'retrieve',
      'outnum',
      'end',
    );
    expect(await printedL(code)).toBe('0 2 -7 0');
  });

  it('long labels sharing a prefix (60 and 61 tokens)', async () => {
    const l60 = 'ST'.repeat(30);
    const code = `LSL${l60}SL LSS${l60}L ${pushL(119)}${OUTC}${END} LSS${l60}SL ${pushL(114)}${OUTC}LSL${l60}L`;
    expect(await printedL(code)).toBe('rw');
  });

  it('copy 2^70 is an error, slide 2^70 keeps only the top', async () => {
    expectCrash(await runL(`SSSTLSTSST${'S'.repeat(70)}LLLL`), /copy 1180591620717411303424/);
    expect(await printedL(`SSSTLSSSTSLSSSTSSTLSTLST${'S'.repeat(70)}LTLSTLLL`)).toBe('9');
  });

  it('jn / jz on huge values (BigInt comparisons)', async () => {
    const h = 2n ** 70n;
    const code = asmL(
      `push -${h}`,
      'jn N',
      'push 120',
      'outchar',
      'end',
      'N:',
      `push ${h}`,
      'jz Z',
      'push 111',
      'outchar',
      'push 107',
      'outchar',
      'end',
      'Z:',
      'push 98',
      'outchar',
      'end',
    );
    expect(await printedL(code)).toBe('ok');
  });

  it('3^10000 by a loop: exact 4772-digit outnum', async () => {
    const code =
      'SSSTLSSSTSSTTTSSSTSSSSLLSSTTTSTSSTTSSLSLSLTSTTTSTSSSTSTLSLTSSSTTLTSSLSLTSSSTLTSSTLSLTTTSTSSTTSSLLSSTTTSTSSSTSTLSLLTLSTLLL';
    const printed = await printedL(code);
    expect(printed).toBe(String(3n ** 10000n));
    expect(printed).toHaveLength(4772);
    expect(printed!.startsWith('163135018534')).toBe(true);
  });
});

describe('regression round 2: input', () => {
  it.each([
    ['readchar with input', 'SSSSLTLTSSSSTLTLTSSSSTLTTTTLSSSSSSLTTTTLSSLLL', 'ab', 'ba'],
    [
      'readchar at EOF gives -1 (twice)',
      'SSSSLTLTSSSSTLTLTSSSSTSLTLTSSSSSLTTTTLSTSSSTSSSSSLTLSSSSSTLTTTTLSTSSSTSSSSSLTLSSSSSTSLTTTTLSTLLL',
      'Z',
      '90 -1 -1',
    ],
    [
      'readchar of non-BMP + escapes reads code points',
      'SSSSLTLTSSSSTLTLTSSSSTSLTLTSSSSTTLTLTSSSSSLTTTTLSTSSSTSSSSSLTLSSSSSTLTTTTLSTSSSTSSSSSLTLSSSSSTSLTTTTLSTSSSTSSSSSLTLSSSSSTTLTTTTLSTLLL',
      'é\\u{1F600}\\n☃',
      '233 128512 10 9731',
    ],
    [
      'readnum: lines, negative, beyond 2^64',
      'SSSSLTLTTSSSTLTLTTSSSTSLTLTTSSSSLTTTSSSTLTTTTSSSTLSTSSSTSSSSSLTLSSSSSTSLTTTTLSTLLL',
      '42\\n-17\\n123456789012345678901234567890',
      '25 123456789012345678901234567890',
    ],
    [
      'readchar then readnum takes the rest of the line',
      'SSSSLTLTSSSSTLTLTTSSSTSLTLTTSSSSLTTTTLSSSSSTLTTTTLSTSSSTSTTSSLTLSSSSSTSLTTTTLSTLLL',
      'x12\\n7',
      'x12,7',
    ],
    [
      'readnum tolerates spaces around the number and CR at the line end',
      'SSSSLTLTTSSSTLTLTTSSSSLTTTSSSTLTTTTSSSTLSTLLL',
      '  12  \\x0d\\n13\\x0d\\n',
      '25',
    ],
    [
      'readchar after readnum continues on the next line',
      'SSSSLTLTTSSSTLTLTSSSSSLTTTTLSTSSSTLTTTTLSSLLL',
      '5\\nA',
      '5A',
    ],
    [
      'R2-09 readchar until -1, uppercase echo',
      'LSSTLSSSLTLTSSSSLTTTSLSLTTTSLSSSTSSSSSLTSSTTLSSLSLTLLSSTSLSLLLLL',
      'ink',
      'INK',
    ],
    [
      'R2-10 readnum ×2 + add (escaped \\n)',
      'SSSLTLTTSSSTLTLTTSSSLTTTSSSTLTTTTSSSTLSTLLL',
      '40\\n2',
      '42',
    ],
    ['R2-10 negative', 'SSSLTLTTSSSTLTLTTSSSLTTTSSSTLTTTTSSSTLSTLLL', '-50\\n8', '-42'],
  ])('%s', async (_name, letters, input, expected) => {
    expect(await printedL(letters, { input })).toBe(expected);
  });

  it('readnum at EOF and on a non-number line: clean errors', async () => {
    expectCrash(await runL('SSSSLTLTTSSSSLTTTTLSTLLL'), /readnum found no input left/);
    expectCrash(await runL('SSSSLTLTTSSSSLTTTTLSTLLL', { input: 'abc' }), /input line "abc"/);
  });

  it('readchar with an empty Input says that the program read input', async () => {
    const out = await runL('SSSSLTLTSSSSSLTTTTLSTLLL');
    expect(block(out, 'Program output')).toBe('-1');
    expect(allNotes(out).join(' ')).toMatch(/readchar ×1\) but the Input option is empty/);
    const given = await runL('SSSSLTLTSSSSSLTTTTLSTLLL', { input: 'A' });
    expect(allNotes(given).join(' ')).not.toMatch(/Input option is empty/);
  });
});

describe('regression round 2: errors and limits are clean', () => {
  it.each([
    ['add with one item', 'SSSTLTSSSLLL', /stack underflow: add needs 2 values/],
    ['outchar on an empty stack', 'TLSSLLL', /stack underflow: outchar/],
    ['swap with one item', 'SSSTLSLTLLL', /stack underflow: swap/],
    ['dup on an empty stack', 'SLSLLL', /stack underflow: dup/],
    ['store with one item', 'SSSTLTTSLLL', /stack underflow: store/],
    ['jz on an empty stack', 'LTSSLLSSSLLLL', /stack underflow: jz/],
    ['copy beyond the depth', 'SSSTLSSSTSLSTSSTTLLLL', /copy 3: the stack holds 2 item/],
    ['copy of a negative index', 'SSSTLSSSTSLSTSTTLLLL', /copy -1: the index must be 0 or more/],
    ['jump to an unknown label', 'LSLTTTLLLL', /label TTT is never marked/],
    ['call of an unknown label', 'LSTSTSTLLLL', /label STST is never marked/],
    ['modulo by zero', 'SSSTSTLSSSSLTSTTLLL', /division by zero \(5 mod 0\)/],
    ['truncated push', 'SSSTT', /unterminated number/],
    [
      'invalid arithmetic opcode TSL',
      'SSSTLSSSTLTSLSLLL',
      /TSL \(tab, space, line feed\) is not a Whitespace instruction/,
    ],
    [
      'invalid heap opcode TTL',
      'SSSTLTTLLLL',
      /TTL \(tab, tab, line feed\) is not a Whitespace instruction/,
    ],
  ])('%s', async (_name, letters, message) => {
    expectCrash(await runL(letters), message);
  });

  it('errors keep what was printed before them', async () => {
    expectCrash(await runL('SSSTSSTSSSLTLSSSSSTLSSSSLTSTSLLL'), /division by zero/, 'H');
    expectCrash(await runL('SSSTTSTSTTLTLSSLTLLLL'), /ret without a matching call/, 'k');
  });

  it('jumping over unparseable code to a later mark stops cleanly at the parse problem', async () => {
    const out = await runL('LSLSLTTLLSSSLSSSTSTTSTSLTLSSLLL');
    expectCrash(out, /TTL \(tab, tab, line feed\) is not a Whitespace instruction|never marked/);
  });

  it('outchar of an invalid code point prints U+FFFD with a warning, never a lone surrogate', async () => {
    for (const letters of [
      'SSTTLTLSSLLL',
      'SSSTSSSTSSSSSSSSSSSSSSSSLTLSSLLL',
      'SSSTTSTTSSSSSSSSSSSLTLSSLLL',
    ]) {
      const out = await runL(letters);
      expect(block(out, 'Program output')).toBe('�');
      expect(notes(out, 'warn').join(' ')).toMatch(
        /not valid Unicode code points .* print as �\. The reference interpreter stops with an error there; this tool prints � and goes on/,
      );
    }
  });

  it('a small step limit keeps the partial output', async () => {
    const out = await runL('LSSSLSSSTSSSSTSLTLSSLSLSL', { steps: 31 });
    const printed = block(out, 'Program output')!;
    expect(printed).toMatch(/^B+$/);
    expect(printed.length).toBeLessThanOrEqual(31);
    expect(notes(out, 'warn').join(' ')).toMatch(/Stopped at the step limit \(31 instructions/);
  });

  it('tight loop, infinite recursion and unbounded pushes stop cleanly', async () => {
    expect(resultToText(await runL('LSSLLSLL'))).toMatch(/Stopped at the step limit \(5 000 000/);
    expect(resultToText(await runL('LSSSLLSTSL'))).toMatch(/nested calls|step limit/);
    expect(resultToText(await runL('LSSSLSSSTLLSLSL', { steps: 2_000_000 }))).toMatch(
      /step limit|stack holds more than/,
    );
  }, 30_000);

  it('the leftover stack is reported', async () => {
    expect(kvOf(await runL('SSSTLSSSTSLSSSTTLLLL'), 'Run')['Stack depth at end']).toBe('3');
  });

  it('a printing infinite loop at the default step limit returns quickly (linear output)', async () => {
    const loop = 'LSSTLSSSTSSSSSTLTLSSLSLTL';
    for (const text of [ws(loop), hidePoem(loop)]) {
      const t = performance.now();
      const out = await runTool(text);
      expect(performance.now() - t).toBeLessThan(5000);
      expect(block(out, 'Program output')!.startsWith('AAAA')).toBe(true);
      expect(notes(out, 'warn').join(' ')).toMatch(/Stopped after 1 048 576 characters of output/);
      expect(allNotes(out).join(' ')).not.toMatch(NOT_A_PROGRAM);
    }
    for (const steps of [300, 20_000, 200_000]) {
      const out = await runL(loop, { steps });
      expect(block(out, 'Program output')).toBe('A'.repeat(Math.floor(steps / 3)));
    }
    const silent = await runL('LSSTLLSLTL', { steps: 200_000 });
    expect(notes(silent, 'warn').join(' ')).toMatch(/Stopped at the step limit/);
    const asm = await runTool('label loop\npush 65\noutchar\njump loop', { mode: 'assemble' });
    expect(block(asm, 'Program output (test run)')!.startsWith('AAAA')).toBe(true);
  }, 30_000);

  it('Disassemble + Auto on a printing infinite loop lists it after a short trial only', async () => {
    const poem = hidePoem('LSSTLSSSTSSSSSTLTLSSLSLTL');
    const t = performance.now();
    const out = await runTool(poem, { mode: 'disasm' });
    expect(performance.now() - t).toBeLessThan(2000);
    expect(block(out, 'Disassembly')).toMatch(/jump T/);
    expect(resultToText(out)).toMatch(/short trial run \(20 000 steps, no input\)/);
    expect(block(out, 'Program output')).toBeUndefined();
    expect(resultToText(await runTool(poem, { mode: 'disasm', extract: 'trailing' }))).toContain(
      '(not run)',
    );
  });
});

describe('regression round 2: comments, encodings and line endings', () => {
  it.each([
    [
      'letters, digits, punctuation and CR before every token',
      ['x', 'Ж', '#', '9', '\r', 'é', '{', '}', 'ab'],
    ],
    [
      'other Unicode spaces (NBSP, VT, FF, U+2003, U+3000, NEL, U+2028)',
      [' ', '\u000b', '\u000c', ' ', '　', '\u0085', ' '],
    ],
    ['zero-width characters', ['​', '‍', '⁠', '‌']],
  ])('comments: %s', async (_name, fillers) => {
    expect(await programOutput(salt(HEAP_WS, fillers), { extract: 'all' })).toBe('WS!');
    expect(await programOutput(`\ufeff${salt(HEAP_WS, fillers)}`)).toBe('WS!');
  });

  it('binary garbage bytes (FF 00 FE 80) between tokens', async () => {
    const bytes: number[] = [];
    [...HEAP_WS].forEach((c, i) => {
      bytes.push(c === 'S' ? 0x20 : c === 'T' ? 0x09 : 0x0a);
      if (i % 3 === 2) bytes.push(0xff, 0x00, 0xfe, 0x80);
    });
    expect(await programOutput(Uint8Array.from(bytes), { extract: 'all' })).toBe('WS!');
  });

  it('UTF-16LE with a BOM (Notepad)', async () => {
    expect(await programOutput(utf16le(ws(HEAP_WS), true))).toBe('WS!');
  });

  it('CRLF line endings, explicit and auto', async () => {
    const crlf = ws(NESTED).replace(/\n/g, '\r\n');
    expect(await programOutput(crlf, { extract: 'all' })).toBe('AB_C!');
    expect(await programOutput(crlf)).toBe('AB_C!');
  });
});

describe('regression round 2: where the program is hidden', () => {
  const poem = hidePoem(FTF42, POEM6);

  it('trailing camouflage: a poem with spaces and tabs between its words', async () => {
    expect(poem.split('\n')[0]).toMatch(/^The {2}harbour\tkeeps/);
    expect(await programOutput(poem, { extract: 'trailing' })).toBe('Ftf-42');
    const out = await runTool(poem);
    expect(block(out, 'Program output')).toBe('Ftf-42');
    expect(notes(out, 'warn')).toEqual([]);
  });

  it('CRLF poem with a title and a blank line', async () => {
    const text = `Harbour Notes\r\n\r\n${poem.replace(/\n/g, '\r\n')}`;
    expect(await programOutput(text, { extract: 'trailing', bareLines: 'lead' })).toBe('Ftf-42');
    expect(await programOutput(text)).toBe('Ftf-42');
  });

  it('all whitespace, a word before every token', async () => {
    const words = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'tide', 'rope'];
    expect(await programOutput(salt(FTF42, words))).toBe('Ftf-42');
  });

  it.each([
    [
      'inline markers',
      `Dear reader,\tnothing  here.\n BEGIN${ws(FTF42)}END \t and the rest has spaces too.\n`,
      {},
    ],
    [
      'markers alone on their lines',
      `Intro words here\nBEGIN\n${ws(FTF42)}END\nOutro with  spaces\n`,
      {},
    ],
    ['custom markers << >>', `x  y\t<<${ws(FTF42)}>> z \t\n`, { start: '<<', end: '>>' }],
    [
      'start marker with \\t escapes, custom end',
      `x\t#\t${ws(FTF42)}~~ tail \t\n`,
      { start: '\\t#\\t', end: '~~' },
    ],
    ['END missing: to the end of the text', `preface BEGIN${ws(FTF42)}`, {}],
  ])('markers: %s (explicit and auto)', async (_name, text, opts) => {
    expect(await programOutput(text, { extract: 'markers', ...opts })).toBe('Ftf-42');
    expect(await programOutput(text, opts)).toBe('Ftf-42');
  });

  it('default BEGIN/END found by auto in prose with spaces', async () => {
    const text = `Some prose with  spaces.\tBEGIN${ws(FTF42)}END and\t more  prose \t\n`;
    const out = await runTool(text);
    expect(block(out, 'Program output')).toBe('Ftf-42');
    expect(notes(out, 'info')[0]).toMatch(/between "BEGIN" and "END"/);
  });

  it('line ends between markers, noisy trailing whitespace outside them', async () => {
    const text = [
      'noise one  \t',
      'noise two\t ',
      'BEGIN',
      poem,
      'END',
      'tail noise \t\t',
      '',
    ].join('\n');
    expect(await programOutput(text, { extract: 'markers-trailing' })).toBe('Ftf-42');
    expect(await programOutput(text)).toBe('Ftf-42');
  });

  it('S/T/L letters grouped, and [Space] [Tab] [LF] words', async () => {
    const grouped =
      'SSSTSSSTTSL TLSS SSSTTTSTSSL TLSS\nSSSTTSSTTSL TLSS SSSTSTTSTL TLSS\nSSSTSTSTSL TLST LLL ';
    expect(await programOutput(grouped, { extract: 'letters' })).toBe('Ftf-42');
    expect(await programOutput(grouped)).toBe('Ftf-42');
    const words = [...FTF42].map((c) => ({ S: '[Space]', T: '[Tab]', L: '[LF]\n' })[c]).join(' ');
    expect(await programOutput(words, { extract: 'letters' })).toBe('Ftf-42');
  });

  it('trap: Python source indented with spaces and tabs, program at the line ends', async () => {
    const python = [
      'def tide(level):',
      '    if level > 3:',
      '        return "high"',
      '\tfor i in range(3):',
      '\t\tprint(i)',
      '            pass',
      '    return "low"',
      'print(tide(4))',
    ];
    const out = await runTool(hidePoem(FTF42, python));
    expect(block(out, 'Program output')).toBe('Ftf-42');
    expect(notes(out, 'info')[0]).toMatch(/^Auto: the program is in the trailing spaces\/tabs/);
  });

  it('trap: the words BEGIN ... END inside the poem', async () => {
    const cover = [...POEM6.slice(0, 2), 'BEGIN again, said the END of the day', ...POEM6.slice(3)];
    expect(await programOutput(hidePoem(FTF42, cover))).toBe('Ftf-42');
  });

  it('trap: an uppercase cover full of S, T and L letters', async () => {
    const cover = [
      'STILL LOST, THE TOTAL SILENCE',
      'SALT LETTERS SETTLE ON STONE',
      'TALL MASTS LIST IN THE SWELL',
      'LITTLE STARS, SLOW TIDES',
      'THE LAST LANTERN STILL LIT',
      'SHELLS AND STILTS AT LOW TIDE',
    ];
    expect(await programOutput(hidePoem(FTF42, cover))).toBe('Ftf-42');
  });

  it('skip: blank stanza lines without code give no L (program without end)', async () => {
    const code = 'SSSTSSSSSTLTLSSSSSTSSSSTSLTLSSSSSSL';
    const rows = code
      .split('L')
      .slice(0, -1)
      .flatMap((seg, i) => [`Stanza line ${i}${ws(seg)}`, ...(i % 2 ? [''] : [])]);
    const out = await runTool(`${rows.join('\n')}\n`, { extract: 'trailing', bareLines: 'skip' });
    expect(block(out, 'Program output')).toBe('AB');
    expect(notes(out, 'warn').join(' ')).toMatch(/without an end/);
  });

  it('a readnum program in a poem (auto, Input 21), and a runaway one with steps=100', async () => {
    expect(
      await programOutput(hidePoem('SSSSLTLTTSSSSLTTTSSSTSLTSSLTLSTLLL'), { input: '21' }),
    ).toBe('42');
    const out = await runTool(hidePoem('LSSSLSSSTSTTSTSLTLSSLSLSL'), { steps: 100 });
    expect(block(out, 'Program output')).toMatch(/^Z{20,}$/);
    expect(notes(out, 'warn').join(' ')).toMatch(/Stopped at the step limit/);
    expect(allNotes(out).join(' ')).not.toMatch(NOT_A_PROGRAM);
    expect(notes(out, 'info')[0]).toMatch(/prints text until the step limit stops it/);
  });
});

describe('regression round 2: output in any script counts as text', () => {
  const JA =
    'SSSTTSSTSTTTTSSTSTLTLSSSSSTTSSTTTSSTSTTSSLTLSSSSSTSSSTSTSTSSTTTTSLTLSSSSSTTSSSSSTTSTTTSLTLSSSSSTTSSSSTTSTSTSTLTLSSSSSTTSSSSTTTSTSSTLTLSSSSSTTSSSSTSTTSSSSLTLSSLLL';
  const NIHONGO = 'SSSTTSSTSTTTTSSTSTLTLSSSSSTTSSTTTSSTSTTSSLTLSSSSSTSSSTSTSTSSTTTTSLTLSSLLL';
  const IH =
    'SSSTSSTSSSLSSSTTSTSSTLTLSSTLSSSSSTTSSTSTTTTSSTSTLTLSSSSSTTSSTTTSSTSTTSSLTLSSSSSTSSSTSTSTSSTTTTSLTLSSLLL';
  const prose = (code: string) =>
    `Some prose with  spaces.\tBEGIN${ws(code)}END and\t more  prose \t\n`;

  /** A successful auto run: the output, an "is in" note, and no "does not hide" warning. */
  async function found(text: string | Uint8Array, expected: string, opts: Partial<Opts> = {}) {
    const out = await runTool(text, opts);
    expect(block(out, 'Program output')).toBe(expected);
    expect(notes(out, 'info').some((t) => t.startsWith('Auto: the program is in'))).toBe(true);
    expect(allNotes(out).join(' ')).not.toMatch(NOT_A_PROGRAM);
    return out;
  }

  it('a program printing only CJK text in the line ends of a poem', async () => {
    expect(textToProgram('日本語のフラグ').code).toBe(JA);
    await found(hidePoem(JA), '日本語のフラグ');
  });

  it('CJK programs between the default markers, prose with spaces around', async () => {
    const out = await found(prose(NIHONGO), '日本語');
    expect(notes(out, 'info')[0]).toMatch(/between "BEGIN" and "END"/);
    await found(prose(IH), 'iH日本語');
  });

  it('accents, Cyrillic, CJK, emoji and a lone ñ in pure programs', async () => {
    for (const s of [
      'Été réussi, bravo ! ✓',
      'voilà',
      'café crème',
      'Ça marche !',
      'flag{été}',
      'naïve-Zoë',
      'ok 🚩',
      'Привет',
      '日本語',
      '🚩🚩',
      'ñ',
    ]) {
      await found(ws(print(s)), s);
    }
    expect(print('Привет')).toBe(
      'SSSTSSSSSTTTTTLTLSSSSSTSSSTSSSSSSLTLSSSSSTSSSSTTTSSSLTLSSSSSTSSSSTTSSTSLTLSSSSSTSSSSTTSTSTLTLSSSSSTSSSTSSSSTSLTLSSLLL',
    );
  });

  it('the tool reads back its own Text → Whitespace output, in any script', async () => {
    const bytesOf = (out: Output[]) => {
      const b = out.find((o) => o.type === 'bytes');
      return b?.type === 'bytes' ? b.value : new Uint8Array();
    };
    for (const message of ['FTF ✓ ünï 😀', 'Привет, ça va ? 🚩']) {
      await found(bytesOf(await runTool(message, { mode: 'generate' })), message);
    }
    const cover = 'Tide is low\\nGulls are loud\\nRope is wet\\nAnd so is the cloud';
    await found(bytesOf(await runTool('Ftf☃', { mode: 'generate', cover })), 'Ftf☃');
  });

  it('R2-12 zero-width, NBSP and BOM noise inside the words of the poem', async () => {
    const code =
      'SSSTTTTTSTTSTSTSTSSTLTLSSSSSTTTSTSSTLTLSSSSSTSSSSSLTLSSSSSTTSTTTTLTLSSSSSTTSTSTTLTLSSLLL';
    const noisy = COVER.map((l, i) =>
      i % 3 === 0
        ? `\u200b${l.replace(' ', '\u00a0')}`
        : i % 3 === 1
          ? l.replace('e', 'e\u200d')
          : `\ufeff${l}\u00a0`,
    );
    const out = await found(hidePoem(code, noisy), '🚩é ok');
    expect(resultToText(out)).toMatch(/⟨ZWSP⟩ ×\d+/);
    expect(resultToText(out)).toMatch(/⟨BOM⟩ ×\d+/);
    expect(block(out, 'Disassembly')).toMatch(/push 128681\s+; '🚩'/);
    expect(block(out, 'Disassembly')).toMatch(/push 233\s+; 'é'/);
  });

  it('R2-50 two stanzas: the markers one wins and the other is reported', async () => {
    const outer = 'SSSTTSTTTTLTLSSSSSTTTSTSTLTLSSSSSTTTSTSSLTLSSSSSTTSSTSTLTLSSSSSTTTSSTSLTLSSLLL';
    for (const [inner, expected] of [
      [print('Привет'), 'Привет'],
      [print('inner'), 'inner'],
    ] as const) {
      const text = `${hidePoem(outer)}BEGIN\n${hidePoem(inner)}END\n`;
      const out = await found(text, expected);
      expect(notes(out, 'warn').join(' ')).toMatch(
        /Other extractions also print text: line ends → printed "outer"/,
      );
    }
  });

  it('noise is still not text: mixed alphabets in a word, U+FFFD, unassigned code points', () => {
    expect(printableShare('цtf-42')).toBeLessThan(0.85);
    expect(printableShare('\u{465E5}本語')).toBeLessThan(0.85);
    expect(printableShare('\ufffd\ufffd')).toBe(0);
    expect(printableShare('日本語のフラグ')).toBe(1);
    expect(printableShare('Привет, ça va ? 🚩')).toBe(1);
    expect(printableShare('👨‍👩‍👧')).toBe(1);
  });

  it('short fragments of other extractions do not raise "Other extractions also print text"', async () => {
    const heap = hidePoem(progLoop('harbour', 3));
    expect(notes(await found(heap, 'harbour3'), 'warn')).toEqual([]);
    const made = await runTool('beacon', {
      mode: 'generate',
      cover: COVER.slice(0, 6).join('\\n'),
    });
    const b = made.find((o) => o.type === 'bytes');
    const hidden = b?.type === 'bytes' ? b.value : new Uint8Array();
    expect(notes(await found(hidden, 'beacon'), 'warn')).toEqual([]);
    // M1: the counts of the note (6 cover lines, 15 line feeds: 9 lines added).
    expect(notes(made, 'info')[0]).toMatch(
      /^Hidden in the trailing whitespace of 6 line\(s\) of the cover, and of 9 empty line\(s\) added/,
    );
  });
});

describe('regression round 2: reveal, disassemble, assemble, generate', () => {
  it('the revealer shows every invisible character', async () => {
    const raw = 'a\u200bb\u200cc\u200dd\u2060e\ufefff\u00a0g h\ti\r\nj\u3000k\u202el';
    const out = await runTool(raw, { extract: 'all' });
    const shown = block(out, 'Revealed text (· space, → tab, ⏎ line feed, ␍ carriage return)')!;
    expect(shown).toMatch(/^a⟨ZWSP⟩b⟨ZWNJ⟩c⟨ZWJ⟩d⟨WJ⟩e⟨BOM⟩f⟨NBSP⟩g·h→i␍⏎\nj⟨[^⟩]+⟩k⟨[^⟩]+⟩l$/);
  });

  it('the trailing-whitespace table has no row after the final line feed', async () => {
    const text = `${hidePoem(print('Row'))}`;
    const n = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const out = await runTool(text);
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows).toHaveLength(n);
    expect(table?.type === 'table' && table.label).toMatch(new RegExp(` of ${n} lines`));
  });

  it('Disassemble on a program that waits for input forever: listed, not run, no input error', async () => {
    const out = await runTool(ws('LSSSLSSSSLTLTSSSSSLTTTTLSSLSLSL'), { mode: 'disasm' });
    expect(block(out, 'Disassembly')).toMatch(/readchar[\s\S]*jump S/);
    expect(notes(out, 'error')).toEqual([]);
    expect(resultToText(out)).not.toMatch(/readnum found no input/);
    expect(kvOf(out, 'Program').Parsing).toBe('complete');
  });

  it('disassembly of every instruction: one readable line each, labels compared as strings', async () => {
    const code = [
      'SSSL',
      'SSTL',
      pushL(-5),
      pushL(2n ** 64n),
      'SLS',
      'STSSTL',
      'SLT',
      'SLL',
      'STLSTSL',
      'TSSS',
      'TSST',
      'TSSL',
      'TSTS',
      'TSTT',
      'TTS',
      'TTT',
      'LSSL',
      'LSSSL',
      'LSSSSL',
      'LSTTL',
      'LSLSTL',
      'LTSTSL',
      'LTTTTL',
      'LTL',
      'TLSS',
      'TLST',
      'TLTS',
      'TLTT',
      'LLL',
    ].join('');
    const rows = block(await runTool(ws(code), { mode: 'disasm', extract: 'all' }), 'Disassembly')!
      .split('\n')
      .slice(1);
    const names = rows.map((r) => /\s([a-z]+)(?: |$)/.exec(r.replace(/;.*/, ''))?.[1]);
    expect(names).toEqual([
      'push',
      'push',
      'push',
      'push',
      'dup',
      'copy',
      'swap',
      'drop',
      'slide',
      'add',
      'sub',
      'mul',
      'div',
      'mod',
      'store',
      'retrieve',
      'label',
      'label',
      'label',
      'call',
      'jump',
      'jz',
      'jn',
      'ret',
      'outchar',
      'outnum',
      'readchar',
      'readnum',
      'end',
    ]);
    expect(rows[3]).toMatch(/push 18446744073709551616/);
    expect(rows[16]).toMatch(/label ""\s+; L1$/);
    expect(rows[17]).toMatch(/label S\s+; L2$/);
    expect(rows[18]).toMatch(/label SS\s+; L3$/);
    for (const i of [19, 20, 21, 22]) expect(rows[i]).toMatch(/; never marked$/);
  });

  it('disassembly comments: no raw control or invisible character, emoji and others commented', async () => {
    const values = [10, 9, 13, 8203, 127, 128512, 133, 92, 39, 32, -65, 0x2028];
    const listing = disassemble(parse(values.map((v) => `${pushL(v)}${OUTC}`).join('') + END));
    const raw = [...listing].filter((c) => {
      const cp = c.codePointAt(0)!;
      return (
        (cp < 0x20 && cp !== 10) || (cp >= 0x7f && cp < 0xa0) || cp === 0x200b || cp === 0x2028
      );
    });
    expect(raw).toEqual([]);
    expect(listing).toMatch(/push 128512\s+; '😀'/);
    expect(listing).toMatch(/push 8203\s+; '\\u\{200B\}'/);
    expect(listing).toMatch(/push 8232\s+; '\\u\{2028\}'/);
    expect(listing).toMatch(/push 92\s+; '\\\\'/);
    expect(listing).toMatch(/push 39\s+; '\\''/);
    expect(listing).toMatch(/push 10\s+; '\\n'/);
    // The listing is still valid assembler input.
    expect(assemble(listing)).toBe(parse(assemble(listing)).code);
    expect(textToProgram('😀').listing).toBe("push 128512  ; '😀'\noutchar\nend");
  });

  it('Assemble: FTF, named labels, guessed mnemonics, and an unknown one', async () => {
    const ftf = await runTool('push 70\noutchar\npush 84\noutchar\npush 70\noutchar\nend', {
      mode: 'assemble',
    });
    expect(block(ftf, 'Program output (test run)')).toBe('FTF');
    const loop = await runTool(
      'push 3\nlabel loop\ndup\njz done\ndup\noutnum\npush 1\nsub\njump loop\nlabel done\nend',
      { mode: 'assemble' },
    );
    expect(block(loop, 'Program output (test run)')).toBe('321');
    expect(block(loop, 'Disassembly')).toMatch(/label T\s[\s\S]*jz TS[\s\S]*label TS\s/);
    const guessed = await runTool('push 1\npush 2\nadd\nprintnum\nexit', { mode: 'assemble' });
    expect(block(guessed, 'Program output (test run)')).toBe('3');
    expect(await toolError('push 1\nfrobnicate\nend', { mode: 'assemble' })).toMatch(
      /Line 2: unknown instruction "frobnicate"/,
    );
  });

  it('bad input to the tool is a ToolError', async () => {
    expect(await toolError('')).toMatch(/Paste a Whitespace program/);
    expect(await toolError('hello')).toMatch(/No spaces or tabs found/);
    expect(await toolError('', { mode: 'generate' })).toMatch(/Type the text/);
  });
});

describe('regression round 2: camouflage', () => {
  it('R2-01 a poem hiding call/ret and a sentinel print loop', async () => {
    const code =
      'SSSLSSSTTSTTTSLSSSTTTSSTSLSSSTTSSTSTLSSSTTTSTSSLSSSTTSTTTSLSSSTTSSSSTLSSSTTSTTSSLLSTTLLLLLSSTLSLSLTSTSLTLSSLSLTLLSSTSLSLLLTL';
    expect(await programOutput(hidePoem(code))).toBe('lantern');
  });

  it('R2-02 heap string + index loop, a title and blank line first, 2 lines after', async () => {
    const code =
      'SSSTTSSTSSLSSSTTSTSSSLTTSSSSTTSSTSTLSSSTTSSSSTLTTSSSSTTSSTTSLSSSTTTSSTSLTTSSSSTTSSTTTLSSSTTSSSTSLTTSSSSTTSTSSSLSSSTTSTTTTLTTSSSSTTSTSSTLSSSTTTSTSTLTTSSSSTTSTSTSLSSSTTTSSTSLTTSSSSLLSSTLSLSSSSTTSSTSSLTSSSTTTTLSSSSSTLTSSSSLSSSSTTTLTSSTLTSTSLLSLTLLSSTSLSLLLLL';
    const text = `SEA SHANTY No. 7\n\n${hidePoem(code)}\n-- anonymous\n`;
    expect(await programOutput(text)).toBe('harbour');
  });

  const COUNTDOWN =
    'SSSTSTLLSSTLSLSTLSTSSSTSSSSSLTLSSSSSTLTSSTSLSLTSTSLLSLTLLSSTSLSLLSSSTTSSTTTLTLSSSSSTTSTTTTLTLSSSSSTSSSSTLTLSSLLL';

  it('R2-03/04 countdown in a poem with CRLF, and with mixed CRLF/LF line ends', async () => {
    const lf = hidePoem(COUNTDOWN);
    expect(await programOutput(lf.replace(/\n/g, '\r\n'))).toBe('5 4 3 2 1 go!');
    let i = 0;
    const mixed = lf.replace(/\n/g, () => (++i % 3 === 0 ? '\r\n' : '\n'));
    expect(await programOutput(mixed)).toBe('5 4 3 2 1 go!');
  });

  it('R2-05 all whitespace as the separators of prose: floor div/mod and BigInt', async () => {
    const nl = ['push 10', 'outchar'];
    const code = asmL(
      ...['push -7', 'push 2', 'div', 'outnum', ...nl],
      ...['push -7', 'push 2', 'mod', 'outnum', ...nl],
      ...['push 7', 'push -2', 'div', 'outnum', ...nl],
      ...['push 7', 'push -2', 'mod', 'outnum', ...nl],
      ...[`push ${2n ** 100n}`, 'outnum', ...nl],
      ...[`push ${2n ** 100n}`, 'dup', 'mul', 'outnum', ...nl],
      ...['push 3', 'push 4', 'mul', 'push 5', 'sub', 'outnum', 'end'],
    );
    const words = 'Rope is cheap and patience is cheaper so tie the knot twice and wait'.split(' ');
    let w = 0;
    let text = '';
    for (let i = 0; i < code.length;) {
      const n = 1 + (i % 3);
      text += words[w++ % words.length]! + ws(code.slice(i, i + n));
      i += n;
    }
    text += 'fin.';
    expect(await programOutput(text)).toBe(`-4\n1\n-4\n-1\n${2n ** 100n}\n${2n ** 200n}\n7`);
  });

  const SNIP = 'SSSTTTSSTTLTLSSSSSTTSTTTSLTLSSSSSTTSTSSTLTLSSSSSTTTSSSSLTLSSLLL';
  const email = (start: string, end: string) =>
    `Hi Sam,\n\nthe draft is below, as promised.\n${start}${ws(SNIP)}${end}\nCheers, see you at the dock.\nAna\n`;

  it('R2-06/07 scissors markers (auto with them, auto without them) and inline cut markers', async () => {
    const text = email('-----8<-----\n', '----->8-----');
    expect(await programOutput(text, { start: '-----8<-----', end: '----->8-----' })).toBe('snip');
    expect(await programOutput(text)).toBe('snip');
    expect(
      await programOutput(email('cut>>', '<<cut'), {
        extract: 'markers',
        start: 'cut>>',
        end: '<<cut',
      }),
    ).toBe('snip');
  });

  it('R2-08 default BEGIN/END with decoys: BEGINNER, "the END of a line", LEGEND', async () => {
    const text = `BEGINNER'S GUIDE TO KNOTS\nA bowline makes a fixed LOOP at the END of a line.\nBEGIN${toWhitespace(print('bowline'))}END\nLEGEND: the rabbit comes out of the hole.\n`;
    const out = await runTool(text);
    expect(block(out, 'Program output')).toBe('bowline');
    expect(notes(out, 'info')[0]).toMatch(
      /^Auto: the program is in the whitespace between "BEGIN" and "END"/,
    );
    expect(await programOutput(text, { extract: 'markers' })).toBe('bowline');
    expect(markerRegion(text, 'BEGIN', 'END')!.from).toBe(text.indexOf('BEGIN\u0020') + 5);
  });

  it('R2-11 tab-indented poem, string labels, empty label, forward call', async () => {
    const code = asmL(
      'jump ""',
      ...[...'BAD'].flatMap((c) => [`push ${c.charCodeAt(0)}`, 'outchar']),
      'label ""',
      ...[...'GOOD'].flatMap((c) => [`push ${c.charCodeAt(0)}`, 'outchar']),
      'call TT',
      'jump ST',
      'label SST',
      ...[...'WRONG'].flatMap((c) => [`push ${c.charCodeAt(0)}`, 'outchar']),
      'end',
      'label ST',
      ...[...'RIGHT'].flatMap((c) => [`push ${c.charCodeAt(0)}`, 'outchar']),
      'end',
      'label TT',
      'push 33',
      'outchar',
      'ret',
    );
    const cover = COVER.map(
      (l, i) =>
        `${i % 4 === 3 ? '' : '\t'.repeat(1 + (i % 2))}${l.replace(' ', i % 2 ? '\t' : ' ')}`,
    );
    expect(await programOutput(hidePoem(code, cover))).toBe('GOOD!RIGHT');
  });

  it('R2-13 BEGIN/END lines around a coded stanza, noisy trailing whitespace outside', async () => {
    const code = asmL(
      'push 1',
      'push 2',
      'push 3',
      'copy 2',
      'outnum',
      "push ','",
      'outchar',
      'swap',
      'outnum',
      "push ','",
      'outchar',
      'push 10',
      'push 20',
      'push 30',
      'push 40',
      'slide 2',
      ...['outnum', "push ','", 'outchar', 'outnum', "push ','", 'outchar', 'outnum', "push ','"],
      ...['outchar', 'outnum', 'end'],
    );
    const stanza = hidePoem(code).replace(/\n$/, '');
    const text = [
      'Logbook  ',
      'Weather: fair \t',
      'BEGIN',
      stanza,
      'END',
      'Signed by the mate   ',
      'Tea at four\t\t',
      '',
    ].join('\n');
    expect(await programOutput(text)).toBe('1,2,40,10,3,1');
  });

  it('R2-14/15/16 Markdown hard breaks, Python with stray trailing spaces, plain prose', async () => {
    for (const text of [
      '# Packing list  \nRope, two lengths  \nLantern oil\t\nMatches, dry  \nBiscuits  \n\nSee you Sunday  \n',
      'def tide(h):    \n    if h > 3:  \n        return "high" \n    return "low"\t\n\n\nprint(tide(4))  \n',
      'The tide is out.\nThe boats are dry.\nNothing to see here.\n',
    ]) {
      const out = await runTool(text);
      expect(block(out, 'Program output')).toBeUndefined();
      expect(allNotes(out).some((t) => t.startsWith('Auto: the program is in'))).toBe(false);
    }
  });

  it('R2-17 letters grouped by 8, and [Space][Tab][LF] words', async () => {
    const neg = asmL(
      'push -1',
      'jn neg',
      "push 'p'",
      'outchar',
      'end',
      'neg:',
      "push 'n'",
      'outchar',
      "push 'e'",
      'outchar',
      "push 'g'",
      'outchar',
      'end',
    );
    const by8 = neg.replace(/(.{8})/g, '$1 ');
    expect(await programOutput(by8)).toBe('neg');
    const words = 'SSSLTLSTSSTLTLSTLLL'
      .replace(/S/g, '[Space]')
      .replace(/T/g, '[Tab]')
      .replace(/L/g, '[LF]\n');
    expect(await programOutput(words)).toBe('00');
  });

  it('R2-18 BOM + CRLF (Notepad) poem', async () => {
    const code = 'SSSTTSSSTSLTLSSSSSTTSSTSTLTLSSSSSTTSSSSTLTLSSSSSTTSTTSTLTLSSLLL';
    expect(await programOutput(`\ufeff${hidePoem(code).replace(/\n/g, '\r\n')}`)).toBe('beam');
  });

  it('R2-19 C source indented with spaces, readnum program at the line ends', async () => {
    const c = [
      '#include <stdio.h>',
      '',
      'int main(void) {',
      '    int tide = 4;',
      '    if (tide > 3) {',
      '        puts("high");',
      '    } else {',
      '        puts("low");',
      '    }',
      '    return 0;',
      '}',
    ];
    const text = hidePoem('SSSLTLTTSSSTLTLTTSSSLTTTSSSTLTTTTSSSTLSTLLL', c);
    expect(await programOutput(text, { input: '40\n2' })).toBe('42');
  });

  it('R2-33 stanza breaks without code (skip), program without end', async () => {
    const code = 'SSSTTTSTSSLTLSSSSSTTSTSSTLTLSSSSSTTSSTSSLTLSSSSSTTSSTSTLTLSS';
    const rows = hidePoem(code).split('\n');
    const text = rows.flatMap((r, i) => (i % 4 === 3 ? [r, ''] : [r])).join('\n');
    expect(await programOutput(text)).toBe('tide');
  });

  it('R2-40 a title with stray trailing spaces and a blank line before the coded poem', async () => {
    const text = `SEA SHANTY No. 8  \n\n${hidePoem(print('beam'))}`;
    expect(await programOutput(text)).toBe('beam');
    expect(
      await programOutput(text, { extract: 'markers-trailing', start: 'No. 8  \\n', end: '' }),
    ).toBe('beam');
  });

  it('R2-43..49 VM semantics', async () => {
    const sp = ['push 32', 'outchar'];
    expect(
      await printedL(
        asmL(
          'push 0',
          'readchar',
          'push 1',
          'readchar',
          'push 0',
          'retrieve',
          'outnum',
          ...sp,
          'push 1',
          'retrieve',
          'outnum',
          'end',
        ),
        { input: '\\u{1F6A9}\\x41' },
      ),
    ).toBe('128681 65');
    expect(
      await printedL(
        asmL(
          'push -3',
          'retrieve',
          'outnum',
          'push -3',
          'push 9',
          'store',
          'push -3',
          'retrieve',
          'outnum',
          'end',
        ),
      ),
    ).toBe('09');
    expect(
      await printedL(
        asmL(
          'push 0',
          'jn x',
          "push 'a'",
          'outchar',
          'push -3',
          'jz x',
          "push 'b'",
          'outchar',
          'end',
          'x:',
          "push 'X'",
          'outchar',
          'end',
        ),
      ),
    ).toBe('ab');
    expect(
      await printedL(
        asmL(
          'call f',
          "push 'c'",
          'outchar',
          'end',
          'f:',
          "push 'a'",
          'outchar',
          'call g',
          'ret',
          'g:',
          "push 'b'",
          'outchar',
          'ret',
        ),
      ),
    ).toBe('abc');
    expect(await printedL(asmL(`push ${-(2n ** 80n)}`, 'outnum', 'end'))).toBe(
      '-1208925819614629174706176',
    );
    expectCrash(await runL(asmL('ret')), /ret without a matching call/);
    expectCrash(await runL(asmL('push 1', 'copy 5', 'end')), /copy 5: the stack holds 1 item/);
  });
});
