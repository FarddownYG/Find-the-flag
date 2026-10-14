import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import tool from './text-transform';

type Opts = Parameters<typeof tool.run>[1];
const defaults: Opts = {
  op: 'reverse',
  n: 2,
  offset: 0,
  sep: ' ',
  descending: false,
  ignoreCase: false,
};

const run = async (input: string, opts: Partial<Opts>): Promise<Output[]> =>
  tool.run(input, { ...defaults, ...opts });

/** The first text block, which is the transformed text for every operation except count. */
async function result(input: string, opts: Partial<Opts>): Promise<string> {
  const block = (await run(input, opts)).find((o) => o.type === 'text');
  if (block?.type !== 'text') throw new Error('no text block');
  return block.value;
}

describe('reversing', () => {
  it('reverses the whole text by code point', async () => {
    expect(await result('abc\ndef', { op: 'reverse' })).toBe('fed\ncba');
    expect(await result('a😀b', { op: 'reverse' })).toBe('b😀a');
  });

  it('reverses each line and keeps the line structure', async () => {
    expect(await result('abc\ndef\n', { op: 'reverse-lines' })).toBe('cba\nfed\n');
    expect(await result('abc\r\ndef', { op: 'reverse-lines' })).toBe('cba\nfed');
  });

  it('reverses word order and each word separately', async () => {
    expect(await result('one two  three', { op: 'reverse-word-order' })).toBe('three two  one');
    expect(await result('one two\nthree four', { op: 'reverse-word-order' })).toBe(
      'two one\nfour three',
    );
    expect(await result('one two  three', { op: 'reverse-each-word' })).toBe('eno owt  eerht');
  });
});

describe('case', () => {
  it('changes case', async () => {
    expect(await result('Flag{Mixed}', { op: 'upper' })).toBe('FLAG{MIXED}');
    expect(await result('Flag{Mixed}', { op: 'lower' })).toBe('flag{mixed}');
    expect(await result('Flag{Mixed} 123', { op: 'swap-case' })).toBe('fLAG{mIXED} 123');
  });
});

describe('removing characters', () => {
  it('removes whitespace and line breaks', async () => {
    expect(await result(' a b\tc\n d ', { op: 'remove-whitespace' })).toBe('abcd');
    expect(await result('a\nb\r\nc\rd', { op: 'remove-breaks' })).toBe('abcd');
    expect(await result('a b\nc', { op: 'remove-breaks' })).toBe('a bc');
  });

  it('keeps only letters or digits', async () => {
    expect(await result('a1-b2_c3 é4', { op: 'letters' })).toBe('abcé');
    expect(await result('a1-b2_c3 é4', { op: 'digits' })).toBe('1234');
    expect(await result('123', { op: 'letters' })).toBe('');
  });

  it('strips invisible characters and reports them', async () => {
    const out = await run('fl​ag​\u0007{﻿x}\ttab\n', { op: 'strip-nonprintable' });
    const text = out.find((o) => o.type === 'text');
    expect(text?.type === 'text' && text.value).toBe('flag{x}\ttab\n');
    const note = resultToText(out);
    expect(note).toContain('Removed 4 characters');
    expect(note).toContain('U+200B ×2');
    expect(note).toContain('U+0007');
    expect(note).toContain('U+FEFF');
  });

  it('says so when there is nothing to strip', async () => {
    expect(resultToText(await run('plain text', { op: 'strip-nonprintable' }))).toContain(
      'Nothing to strip',
    );
  });
});

describe('every Nth character', () => {
  it('honours N and the offset', async () => {
    expect(await result('a1b2c3', { op: 'every-nth', n: 2, offset: 0 })).toBe('abc');
    expect(await result('a1b2c3', { op: 'every-nth', n: 2, offset: 1 })).toBe('123');
    expect(await result('abcdefghi', { op: 'every-nth', n: 3, offset: 2 })).toBe('cfi');
    expect(await result('abcdef', { op: 'every-nth', n: 1, offset: 0 })).toBe('abcdef');
    expect(await result('abc', { op: 'every-nth', n: 5, offset: 1 })).toBe('b');
  });

  it('lists every offset in a table and highlights the chosen one', async () => {
    const out = await run('a1b2c3', { op: 'every-nth', n: 3, offset: 1 });
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows).toEqual([
      [0, 'a2'],
      [1, '1c'],
      [2, 'b3'],
    ]);
    expect(table?.type === 'table' && table.highlight).toEqual([1]);
  });

  it('works on code points', async () => {
    expect(await result('😀a😀b', { op: 'every-nth', n: 2, offset: 0 })).toBe('😀😀');
  });

  it('rejects N below 1', async () => {
    await expect(run('abc', { op: 'every-nth', n: 0 })).rejects.toBeInstanceOf(ToolError);
    await expect(run('abc', { op: 'chunk', n: -3 })).rejects.toBeInstanceOf(ToolError);
  });
});

describe('chunk', () => {
  it('splits into groups with the separator', async () => {
    expect(await result('abcdefg', { op: 'chunk', n: 3 })).toBe('abc def g');
    expect(await result('abcdefg', { op: 'chunk', n: 3, sep: '-' })).toBe('abc-def-g');
    expect(await result('abcdef', { op: 'chunk', n: 2, sep: '\\n' })).toBe('ab\ncd\nef');
    expect(await result('abcd', { op: 'chunk', n: 2, sep: '' })).toBe('abcd');
    expect(await result('abc', { op: 'chunk', n: 10 })).toBe('abc');
  });
});

describe('transpose', () => {
  it('swaps rows and columns', async () => {
    expect(await result('ab\ncd', { op: 'transpose' })).toBe('ac\nbd');
    expect(await result('abc\nde', { op: 'transpose' })).toBe('ad\nbe\nc');
  });

  it('is its own inverse for a rectangular block', async () => {
    const block = 'flag\n{ab}\nxyz!';
    const once = await result(block, { op: 'transpose' });
    expect(await result(once, { op: 'transpose' })).toBe(block);
  });
});

describe('sort and unique', () => {
  it('sorts lines by code point, ascending or descending', async () => {
    expect(await result('b\nB\na\nA', { op: 'sort' })).toBe('A\nB\na\nb');
    expect(await result('b\nB\na\nA', { op: 'sort', descending: true })).toBe('b\na\nB\nA');
    expect(await result('b\nB\na\nA', { op: 'sort', ignoreCase: true })).toBe('a\nA\nb\nB');
    expect(await result('b\na\n', { op: 'sort' })).toBe('a\nb\n');
  });

  it('removes repeated lines and reports how many', async () => {
    const out = await run('b\na\nb\nc\na', { op: 'unique' });
    const text = out.find((o) => o.type === 'text');
    expect(text?.type === 'text' && text.value).toBe('b\na\nc');
    expect(resultToText(out)).toContain('Dropped 2 repeated lines');
    expect(await result('A\na\nb', { op: 'unique', ignoreCase: true })).toBe('A\nb');
    expect(resultToText(await run('x\ny', { op: 'unique' }))).toContain('Dropped 0 repeated lines');
  });
});

describe('count', () => {
  it('counts characters, words and lines', async () => {
    const out = await run('hello world\nbye 42', { op: 'count' });
    const kv = out.find((o) => o.type === 'kv');
    const m = new Map(kv?.type === 'kv' ? kv.entries : []);
    expect(m.get('Characters')).toBe('18');
    expect(m.get('Lines')).toBe('2');
    expect(m.get('Words')).toBe('4');
    expect(m.get('Digits')).toBe('2');
    expect(m.get('Letters')).toBe('13');
    expect(m.get('Whitespace')).toBe('3');
    expect(m.get('Unique characters')).toBe('13');
  });

  it('counts bytes and non-ASCII characters', async () => {
    const out = await run('é😀a', { op: 'count' });
    const kv = out.find((o) => o.type === 'kv');
    const m = new Map(kv?.type === 'kv' ? kv.entries : []);
    expect(m.get('Characters')).toBe('3');
    expect(m.get('Bytes (UTF-8)')).toBe('7');
    expect(m.get('Non-ASCII')).toBe('2');
  });

  it('ranks characters by frequency with readable names', async () => {
    const out = await run('aab b\n', { op: 'count' });
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows[0]).toEqual(['a', 'U+0061', 2, '33.3%']);
    const shown = table?.type === 'table' ? table.rows.map((r) => r[0]) : [];
    expect(shown).toContain('(space)');
    expect(shown).toContain('\\n');
  });
});

describe('errors', () => {
  it('asks for input', async () => {
    await expect(run('', { op: 'reverse' })).rejects.toBeInstanceOf(ToolError);
    await expect(run('', { op: 'count' })).rejects.toBeInstanceOf(ToolError);
  });
});
