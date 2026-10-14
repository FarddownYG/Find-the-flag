import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { concatBytes, utf8Encode } from '../../lib/bytes';
import strings, { findStrings } from './strings';
import { noise } from './_fixtures';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

const defaults = { min: 4, encoding: 'all', filter: '', offsets: false };
const run = (bytes: Uint8Array, opts: Record<string, unknown> = {}) =>
  strings.run({ bytes }, { ...defaults, ...opts } as never);

const wide = (s: string, little = true) => {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) out[i * 2 + (little ? 0 : 1)] = s.charCodeAt(i);
  return out;
};

function table(out: Awaited<ReturnType<typeof run>>) {
  const t = out.find((o) => o.type === 'table');
  if (t?.type !== 'table') throw new Error('table expected');
  return t;
}

describe('strings: scanning', () => {
  const bin = sample('forensics-strings.bin');

  it('finds ASCII and UTF-16 strings at their exact offsets', () => {
    const found = findStrings(bin, 4);
    expect(found.map((f) => [f.offset, f.encoding, f.text])).toEqual([
      [0x100, 'ascii', 'GCC: (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0'],
      [0x400, 'ascii', 'admin:hunter2'],
      [0x600, 'utf16le', 'flag{wide_strings_are_sneaky}'],
      [0x900, 'ascii', 'Usage: %s <password>'],
      [0xb00, 'utf16be', 'Nothing to see here (big-endian)'],
    ]);
  });

  it('honours the encoding choice', () => {
    expect(findStrings(bin, 4, ['ascii']).map((f) => f.text)).toEqual([
      'GCC: (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0',
      'admin:hunter2',
      'Usage: %s <password>',
    ]);
    // Read as UTF-16LE only, the big-endian string shows up one byte later, as GNU strings does.
    expect(findStrings(bin, 4, ['utf16le']).map((f) => [f.offset, f.text])).toEqual([
      [0x600, 'flag{wide_strings_are_sneaky}'],
      [0xb01, 'Nothing to see here (big-endian)'],
    ]);
  });

  it('applies the minimum length (inclusive) and keeps tabs inside strings', () => {
    const data = concatBytes(
      Uint8Array.of(1, 2),
      utf8Encode('abc'),
      Uint8Array.of(0),
      utf8Encode('abcd'),
      Uint8Array.of(0xff),
      utf8Encode('a\tb c'),
    );
    expect(findStrings(data, 4, ['ascii']).map((f) => f.text)).toEqual(['abcd', 'a\tb c']);
    expect(findStrings(data, 3, ['ascii']).map((f) => f.text)).toEqual(['abc', 'abcd', 'a\tb c']);
    expect(findStrings(data, 5, ['ascii']).map((f) => f.text)).toEqual(['a\tb c']);
  });

  it('finds UTF-16 at an odd offset and does not read ASCII text as UTF-16', () => {
    const data = concatBytes(
      Uint8Array.of(0xaa),
      wide('hidden'),
      Uint8Array.of(0xbb, 0xcc),
      utf8Encode('plain ascii text'),
    );
    const found = findStrings(data, 4);
    expect(found.map((f) => [f.offset, f.encoding, f.text])).toEqual([
      [1, 'utf16le', 'hidden'],
      [15, 'ascii', 'plain ascii text'],
    ]);
  });

  it('reports each UTF-16BE string once, not also as shifted UTF-16LE', () => {
    const data = concatBytes(new Uint8Array(4), wide('big endian text', false), new Uint8Array(4));
    const found = findStrings(data, 4);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ encoding: 'utf16be', text: 'big endian text', offset: 4 });
  });

  it('is not fooled by random bytes at a sensible minimum length', () => {
    expect(findStrings(noise(10_000, 3, false), 4)).toEqual([]);
  });

  it('scans 20 MB quickly', () => {
    const big = noise(20 << 20, 5, false);
    big.set(utf8Encode('flag{buried_deep}'), 12_345_678);
    const t0 = performance.now();
    const found = findStrings(big, 6);
    expect(performance.now() - t0).toBeLessThan(6000);
    expect(found.map((f) => f.text)).toEqual(['flag{buried_deep}']);
  });
});

describe('strings: tool output', () => {
  const bin = sample('forensics-strings.bin');

  it('lists flag-like strings first, then the rest in file order', async () => {
    const t = table(await run(bin));
    expect(t.rows[0]).toEqual(['0x600', 'utf16le', 'flag{wide_strings_are_sneaky}']);
    expect(t.rows.slice(1).map((r) => r[0])).toEqual(['0x100', '0x400', '0x900', '0xb00']);
    expect(t.highlight).toEqual([0]);
  });

  it('gives a pipeable plain list in file order, with optional offsets', async () => {
    const out = await run(bin);
    const list = out.find((o) => o.type === 'text');
    if (list?.type !== 'text') throw new Error('text expected');
    expect(list.value.split('\n')).toEqual([
      'GCC: (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0',
      'admin:hunter2',
      'flag{wide_strings_are_sneaky}',
      'Usage: %s <password>',
      'Nothing to see here (big-endian)',
    ]);
    const withOffsets = (await run(bin, { offsets: true })).find((o) => o.type === 'text');
    expect(withOffsets?.type === 'text' && withOffsets.value.split('\n')[1]).toBe(
      '00000400 admin:hunter2',
    );
  });

  it('filters by plain text (ignoring case) or by /regex/', async () => {
    expect(table(await run(bin, { filter: 'HUNTER' })).rows).toEqual([
      ['0x400', 'ascii', 'admin:hunter2'],
    ]);
    expect(table(await run(bin, { filter: '/^usage/i' })).rows.map((r) => r[0])).toEqual(['0x900']);
    expect(table(await run(bin, { filter: '/hunter\\d/' })).rows).toHaveLength(1);
    // A path-looking filter is plain text, not a broken regex.
    expect((await run(bin, { filter: '/etc/passwd' }))[0]).toMatchObject({ type: 'note' });
  });

  it('explains an invalid regex and an empty result', async () => {
    await expect(Promise.resolve().then(() => run(bin, { filter: '/(/' }))).rejects.toThrow(
      ToolError,
    );
    const none = await run(bin, { min: 500 });
    expect(none).toEqual([expect.objectContaining({ type: 'note', level: 'info' })]);
    await expect(Promise.resolve().then(() => run(new Uint8Array(0)))).rejects.toThrow(ToolError);
  });

  it('caps at 20 000 results but never drops a flag-like string', async () => {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 25_000; i++) parts.push(utf8Encode(`filler${i}`), Uint8Array.of(0));
    parts.push(utf8Encode('flag{at_the_very_end}'));
    const out = await run(concatBytes(...parts));
    const t = table(out);
    expect(t.rows).toHaveLength(20_000);
    expect(t.rows[0]![2]).toBe('flag{at_the_very_end}');
    const note = out.find((o) => o.type === 'note');
    expect(note?.type === 'note' && note.text).toContain('Showing 20000 of 25001');
  });

  it('detect() only suggests itself for binary data', () => {
    expect(strings.detect?.({ text: null, bytes: noise(500, 2, true) })).toMatchObject({
      score: 0.3,
    });
    expect(strings.detect?.({ text: 'hello', bytes: utf8Encode('hello') })).toBeNull();
  });
});
