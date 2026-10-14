import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import tool from './timestamp';

const run = async (input: string): Promise<Output[]> => tool.run(input, {});

function tables(out: Output[]) {
  return out.flatMap((o) => (o.type === 'table' ? [o] : []));
}

/** UTC column of the first table, keyed by interpretation name. */
async function dates(input: string, which = 0): Promise<Map<string, string>> {
  const t = tables(await run(input))[which];
  if (!t) throw new Error('no table');
  return new Map(t.rows.map((r) => [String(r[0]), String(r[1])]));
}

const INSTANT = '2023-11-14T22:13:20.000Z';

describe('number to date', () => {
  it('reads Unix time in every unit', async () => {
    expect((await dates('0')).get('Unix seconds')).toBe('1970-01-01T00:00:00.000Z');
    expect((await dates('1700000000')).get('Unix seconds')).toBe(INSTANT);
    expect((await dates('1700000000123')).get('Unix milliseconds')).toBe(
      '2023-11-14T22:13:20.123Z',
    );
    expect((await dates('1700000000123456')).get('Unix microseconds')).toBe(
      '2023-11-14T22:13:20.123Z',
    );
    expect((await dates('1700000000123456789')).get('Unix nanoseconds')).toBe(
      '2023-11-14T22:13:20.123Z',
    );
  });

  it('reads the Windows and .NET epochs exactly', async () => {
    expect((await dates('116444736000000000')).get('Windows FILETIME (100 ns since 1601)')).toBe(
      '1970-01-01T00:00:00.000Z',
    );
    expect((await dates('133444736000000000')).get('Windows FILETIME (100 ns since 1601)')).toBe(
      INSTANT,
    );
    expect((await dates('638355968000000000')).get('.NET ticks (100 ns since year 1)')).toBe(
      INSTANT,
    );
  });

  it('reads Chrome, Cocoa, HFS+ and Excel times', async () => {
    expect((await dates('13344473600000000')).get('Chrome / WebKit (µs since 1601)')).toBe(INSTANT);
    expect((await dates('721692800')).get('Apple Cocoa (s since 2001)')).toBe(INSTANT);
    expect((await dates('3782844800')).get('HFS+ / classic Mac (s since 1904)')).toBe(INSTANT);
    expect(
      (await dates('45244.92592592593')).get('Excel / OLE serial (days since 1899-12-30)'),
    ).toBe(INSTANT);
    expect((await dates('25569')).get('Excel / OLE serial (days since 1899-12-30)')).toBe(
      '1970-01-01T00:00:00.000Z',
    );
  });

  it('reads a 32-bit FAT / DOS date-time', async () => {
    expect((await dates('1466872234')).get('FAT / DOS date-time (local time)')).toBe(INSTANT);
    expect((await dates('1466872234')).get('Unix seconds')).toBe('2016-06-25T16:30:34.000Z');
    expect((await dates('5')).get('FAT / DOS date-time (local time)')).toBe('-');
  });

  it('handles fractions and negative numbers', async () => {
    expect((await dates('1700000000.5')).get('Unix seconds')).toBe('2023-11-14T22:13:20.500Z');
    expect((await dates('-1')).get('Unix seconds')).toBe('1969-12-31T23:59:59.000Z');
    expect((await dates('+86400')).get('Unix seconds')).toBe('1970-01-02T00:00:00.000Z');
    expect((await dates('1_700_000_000')).get('Unix seconds')).toBe(INSTANT);
  });

  it('shows a dash where the date is out of range', async () => {
    expect((await dates('9'.repeat(30))).get('Unix seconds')).toBe('-');
  });

  it('highlights plausible readings only', async () => {
    const t = tables(await run('1700000000'))[0]!;
    expect(t.highlight).toContain(0);
    expect(t.rows[0]![2]).toBe('yes');
    expect(t.rows[1]![2]).toBe('');
    const ms = tables(await run('1700000000000'))[0]!;
    expect(ms.highlight).toContain(1);
    expect(ms.highlight).not.toContain(0);
  });

  it('says when nothing is plausible', async () => {
    const out = await run('9'.repeat(30));
    expect(out.some((o) => o.type === 'note' && /may not be a timestamp/.test(o.text))).toBe(true);
    const good = await run('1700000000');
    expect(good.some((o) => o.type === 'note')).toBe(false);
  });
});

describe('hex input', () => {
  it('reads 0x numbers big-endian and offers the little-endian reading', async () => {
    const out = tables(await run('0x6553F100'));
    expect(out).toHaveLength(2);
    expect(out[0]!.label).toMatch(/as a number/);
    expect(new Map(out[0]!.rows.map((r) => [r[0], r[1]])).get('Unix seconds')).toBe(INSTANT);
    expect(out[1]!.label).toMatch(/little-endian/);
  });

  it('reads FILETIME bytes from a hex dump little-endian first', async () => {
    const spaced = await dates('00 80 3e d5 de b1 9d 01');
    expect(spaced.get('Windows FILETIME (100 ns since 1601)')).toBe('1970-01-01T00:00:00.000Z');
    const bare = await dates('00803ed5deb19d01');
    expect(bare.get('Windows FILETIME (100 ns since 1601)')).toBe('1970-01-01T00:00:00.000Z');
    const colons = await dates('00:00:6d:c6:47:17:da:01');
    expect(colons.get('Windows FILETIME (100 ns since 1601)')).toBe(INSTANT);
  });

  it('reads 4 bytes of Unix time little-endian', async () => {
    expect((await dates('00 f1 53 65')).get('Unix seconds')).toBe(INSTANT);
  });

  it('also keeps the big-endian reading', async () => {
    const out = tables(await run('00 f1 53 65'));
    expect(out[1]!.label).toMatch(/big-endian/);
  });

  it('pads odd-length 0x numbers', async () => {
    expect((await dates('0x0')).get('Unix seconds')).toBe('1970-01-01T00:00:00.000Z');
    expect((await dates('0xABC')).get('Unix seconds')).toBe('1970-01-01T00:45:48.000Z');
  });
});

describe('date to numbers', () => {
  async function numbers(input: string): Promise<Map<string, string>> {
    const t = tables(await run(input))[0]!;
    return new Map(t.rows.map((r) => [String(r[0]), String(r[1])]));
  }

  it('prints every numeric form of an ISO date', async () => {
    const n = await numbers('2023-11-14T22:13:20Z');
    expect(n.get('Unix seconds')).toBe('1700000000');
    expect(n.get('Unix milliseconds')).toBe('1700000000000');
    expect(n.get('Unix microseconds')).toBe('1700000000000000');
    expect(n.get('Windows FILETIME (100 ns since 1601)')).toBe('133444736000000000');
    expect(n.get('.NET ticks (100 ns since year 1)')).toBe('638355968000000000');
    expect(n.get('Chrome / WebKit (µs since 1601)')).toBe('13344473600000000');
    expect(n.get('Apple Cocoa (s since 2001)')).toBe('721692800');
    expect(n.get('HFS+ / classic Mac (s since 1904)')).toBe('3782844800');
    expect(n.get('FAT / DOS date-time (local time), 2 s resolution')).toBe('1466872234');
    expect(n.get('FILETIME as 8 bytes (little-endian)')).toBe('00 00 6d c6 47 17 da 01');
    expect(n.get('Excel / OLE serial (days since 1899-12-30)')).toMatch(/^45244\.925925925/);
  });

  it('gives the hex of whole values', async () => {
    const t = tables(await run('2023-11-14T22:13:20Z'))[0]!;
    expect(t.rows[0]![2]).toBe('0x6553f100');
    expect(t.columns).toEqual(['Format', 'Value', 'Hex']);
  });

  it('round-trips with the number direction', async () => {
    const n = await numbers('1999-12-31 23:59:59');
    const back = await dates(n.get('Windows FILETIME (100 ns since 1601)')!);
    expect(back.get('Windows FILETIME (100 ns since 1601)')).toBe('1999-12-31T23:59:59.000Z');
  });

  it('reads a date without a zone as UTC, never local time', async () => {
    expect((await numbers('2023-11-14 22:13:20')).get('Unix seconds')).toBe('1700000000');
    expect((await numbers('2023-11-14T22:13:20')).get('Unix seconds')).toBe('1700000000');
    expect((await numbers('2023-11-14')).get('Unix seconds')).toBe('1699920000');
    expect((await numbers('2023/11/14 22:13')).get('Unix seconds')).toBe('1699999980');
  });

  it('applies zone offsets', async () => {
    expect((await numbers('2023-11-14T23:13:20+01:00')).get('Unix seconds')).toBe('1700000000');
    expect((await numbers('2023-11-14T17:13:20-0500')).get('Unix seconds')).toBe('1700000000');
    expect((await numbers('2023-11-14T22:13:20 UTC')).get('Unix seconds')).toBe('1700000000');
  });

  it('keeps sub-second precision', async () => {
    const n = await numbers('2023-11-14T22:13:20.123456789Z');
    expect(n.get('Unix seconds')).toBe('1700000000.123456789');
    expect(n.get('Unix nanoseconds')).toBe('1700000000123456789');
    expect(n.get('Unix milliseconds')).toBe('1700000000123.456789');
  });

  it('reads RFC 2822 and similar text dates', async () => {
    expect((await numbers('Tue, 14 Nov 2023 22:13:20 GMT')).get('Unix seconds')).toBe('1700000000');
  });

  it('handles dates before 1970 and 1601', async () => {
    const n = await numbers('1969-12-31T23:59:59Z');
    expect(n.get('Unix seconds')).toBe('-1');
    expect(n.get('Unix milliseconds')).toBe('-1000');
    const old = await numbers('1500-01-01T00:00:00Z');
    expect(old.get('Windows FILETIME (100 ns since 1601)')).toMatch(/^-/);
    expect(old.has('FILETIME as 8 bytes (little-endian)')).toBe(false);
  });
});

describe('errors', () => {
  it('rejects empty input and text that is neither a number nor a date', async () => {
    await expect(run('')).rejects.toBeInstanceOf(ToolError);
    await expect(run('   ')).rejects.toBeInstanceOf(ToolError);
    await expect(run('hello')).rejects.toThrow(/Cannot read "hello"/);
  });

  it('rejects impossible dates', async () => {
    await expect(run('2023-02-30')).rejects.toThrow(/not a real calendar date/);
    await expect(run('2023-13-01')).rejects.toBeInstanceOf(ToolError);
    await expect(run('2023-11-14T25:00:00Z')).rejects.toThrow(/not a real calendar date/);
  });

  it('rejects absurdly long numbers', async () => {
    await expect(run('1'.repeat(41))).rejects.toThrow(/longer than/);
  });
});

describe('detect', () => {
  const detect = (text: string | null) => tool.detect!({ text, bytes: new Uint8Array() });
  it('recognises likely timestamps and dates only', () => {
    expect(detect('1700000000')?.score).toBe(0.6);
    expect(detect('1700000000000')?.score).toBe(0.55);
    expect(detect('133444736000000000')?.score).toBe(0.6);
    expect(detect('2023-11-14T22:13:20Z')?.score).toBe(0.7);
    expect(detect('42')).toBeNull();
    expect(detect('hello')).toBeNull();
    expect(detect(null)).toBeNull();
  });
});
