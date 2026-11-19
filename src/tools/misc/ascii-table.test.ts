import { describe, expect, it } from 'vitest';
import type { Output } from '../../core/types';
import tool from './ascii-table';

type Opts = { range: 'ascii' | 'latin1'; controls: boolean };
const run = async (text: string, o: Partial<Opts> = {}) =>
  tool.run(text, { range: 'ascii', controls: true, ...o });

type Table = Extract<Output, { type: 'table' }>;
const tables = (out: Output[]) => out.filter((o): o is Table => o.type === 'table');
const reference = (out: Output[]) => tables(out).at(-1)!;

describe('ascii-table', () => {
  it('shows control names for an empty input', async () => {
    const out = await run('');
    expect(tables(out)).toHaveLength(1);
    const ref = reference(out);
    expect(ref.rows).toHaveLength(128);
    expect(ref.rows[0]![5]).toBe('NUL');
    expect(ref.rows[10]![5]).toBe('LF');
    expect(ref.rows[27]![5]).toBe('ESC');
    expect(ref.rows[127]![5]).toBe('DEL');
    expect(ref.highlight).toEqual([]);
  });

  it('leaves names blank when controls is off', async () => {
    const ref = reference(await run('', { controls: false }));
    expect(ref.rows[0]![5]).toBe('');
    expect(ref.rows[0]![4]).toBe('·');
  });

  it('maps a letter to the right code and highlights it', async () => {
    const out = await run('FF');
    const [mine, ref] = tables(out);
    expect(mine!.rows).toEqual([
      ['F', 70, '0x46', ''],
      ['F', 70, '0x46', ''],
    ]);
    expect(ref!.rows[70]).toEqual([70, '0x46', '0o106', '01000110', 'F', '', 2]);
    expect(ref!.highlight).toEqual([70]);
  });

  it('formats 8-bit binary and octal', async () => {
    const ref = reference(await run(''));
    expect(ref.rows[65]).toEqual([65, '0x41', '0o101', '01000001', 'A', '', '']);
  });

  it('covers 0-255 in latin-1 and finds é = 0xe9', async () => {
    const out = await run('é', { range: 'latin1' });
    const [mine, ref] = tables(out);
    expect(ref!.rows).toHaveLength(256);
    expect(mine!.rows[0]).toEqual(['é', 233, '0xe9', '']);
    expect(ref!.rows[233]![1]).toBe('0xe9');
    expect(ref!.highlight).toEqual([233]);
    expect(ref!.rows[133]![5]).toBe('NEL');
  });

  it('keeps code points above the range in "Your text" with a note', async () => {
    const out = await run('é☃😀');
    const [mine, ref] = tables(out);
    expect(mine!.rows.map((r) => r.slice(0, 3))).toEqual([
      ['é', 233, '0xe9'],
      ['☃', 0x2603, '0x2603'],
      ['😀', 0x1f600, '0x1f600'],
    ]);
    // Note text comes from the locale file (keys only until the fragment is merged).
    expect(mine!.rows[0]![3]).toMatch(/outside/i);
    expect(ref!.highlight).toEqual([]);
  });

  it('detect returns null', () => {
    expect(tool.detect!({ text: 'abc', bytes: new Uint8Array() })).toBeNull();
  });
});
