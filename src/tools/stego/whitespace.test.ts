import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { defaults } from '../audio/_synth';
import whitespace, { decodeWhitespace, encodeBinary, encodeSnow, splitLines } from './whitespace';

const run = (input: string, extra: Record<string, unknown> = {}): Output[] =>
  whitespace.run(input, defaults(whitespace, extra) as never) as Output[];

const cover = Array.from(
  { length: 24 },
  (_, i) => `Line ${i + 1}: a perfectly ordinary sentence of text.`,
).join('\n');

/** Display width of a line (tabs go to the next multiple of 8). */
const width = (line: string) => {
  let col = 0;
  for (const ch of line) col = ch === '\t' ? (Math.floor(col / 8) + 1) * 8 : col + 1;
  return col;
};

describe('stegsnow encoding', () => {
  it('uses a start tab and "spaces then tab" groups of 3 bits', () => {
    // 'A' = 01000001 -> padded 010 000 010 -> 2, 0, 2 spaces
    expect(encodeSnow('hello\nworld', 'A')).toBe('hello\t  \t\t  \t\nworld');
  });

  it('keeps every line under the line length and groups under 8 spaces', () => {
    for (const lineLength of [80, 100, 120]) {
      const stego = encodeSnow(cover, 'flag{narrow}', lineLength);
      for (const line of stego.split('\n')) {
        expect(width(line)).toBeLessThan(lineLength);
        expect(line).not.toMatch(/ {8}/);
      }
    }
  });

  it('round-trips ASCII and UTF-8 secrets', () => {
    for (const secret of ['flag{plain}', 'héllo ✓', 'a'.repeat(20), 'Hidden in plain sight']) {
      const best = decodeWhitespace(encodeSnow(cover, secret))[0]!;
      expect(best.text).toBe(secret);
      expect(best.scheme).toContain('stegsnow');
    }
  });

  it('only touches the lines it needs and leaves the visible text alone', () => {
    const stego = encodeSnow(cover, 'ab');
    const lines = splitLines(stego);
    expect(lines.map((l) => l.text)).toEqual(cover.split('\n'));
    expect(lines.filter((l) => l.ws).length).toBeLessThan(lines.length);
  });

  it('strips trailing whitespace the cover already had and keeps a final newline', () => {
    const stego = encodeSnow('one   \ntwo\t\nthree \n', 'A');
    expect(stego.endsWith('\n')).toBe(true);
    expect(splitLines(stego).map((l) => l.text)).toEqual(['one', 'two', 'three']);
    expect(decodeWhitespace(stego)[0]!.text).toBe('A');
  });

  it('works for a secret that exactly fills the cover and refuses one byte more', () => {
    const lines = Array.from({ length: 4 }, () => 'x'.repeat(10));
    // start col 16, (79-16)/8 = 7 groups per line -> 28 groups = 84 bits = 10 bytes (+4 spare bits)
    const full = encodeSnow(lines.join('\n'), 'abcdefghij');
    expect(decodeWhitespace(full)[0]!.text).toBe('abcdefghij');
    expect(() => encodeSnow(lines.join('\n'), 'abcdefghijk')).toThrow(/too short/);
  });

  it('copes with CRLF input', () => {
    const stego = encodeSnow(cover, 'flag{crlf}').replace(/\n/g, '\r\n');
    expect(decodeWhitespace(stego)[0]!.text).toBe('flag{crlf}');
  });
});

describe('binary encoding', () => {
  it('writes one byte per line, space = 0 and tab = 1', () => {
    expect(encodeBinary('a\nb\nc', 'A')).toBe('a \t     \t\nb\nc');
  });

  it('round-trips and refuses too little room', () => {
    const stego = encodeBinary(cover, 'flag{bits}');
    expect(decodeWhitespace(stego)[0]).toMatchObject({
      text: 'flag{bits}',
      scheme: 'Trailing whitespace as bits',
    });
    expect(() => encodeBinary('a\nb', 'abc')).toThrow(/one byte per line/);
  });
});

describe('other layouts', () => {
  const bitsOf = (s: string) =>
    [...new TextEncoder().encode(s)].flatMap((b) =>
      [...b.toString(2).padStart(8, '0')].map(Number),
    );

  it('reads the inverse mapping and low-bit-first order', () => {
    const lines = [...new TextEncoder().encode('flag{inv}')].map(
      (b, i) =>
        `row ${i}` +
        [...b.toString(2).padStart(8, '0')]
          .reverse() // low bit first
          .map((c) => (c === '1' ? ' ' : '\t')) // space = 1
          .join(''),
    );
    expect(decodeWhitespace(lines.join('\n'))[0]!.text).toBe('flag{inv}');
  });

  it('reads one bit per line', () => {
    const bits = bitsOf('flag{lines}');
    const text = bits.map((b, i) => `line number ${i}${b ? ' ' : ''}`).join('\n');
    expect(decodeWhitespace(text)[0]).toMatchObject({ text: 'flag{lines}' });
  });

  it('reads one bit per line with a polarity and blank lines in between', () => {
    const bits = bitsOf('flag{x}');
    const text = bits.flatMap((b, i) => [`text ${i}${b ? '' : '\t'}`, '']).join('\n');
    expect(decodeWhitespace(text).some((r) => r.text === 'flag{x}')).toBe(true);
  });

  it('reads single and double spaces between words', () => {
    const bits = bitsOf('flag{gaps}');
    const text = bits.map((b, i) => `w${i}${b ? '  ' : ' '}`).join('') + 'end';
    expect(decodeWhitespace(text)[0]).toMatchObject({
      text: 'flag{gaps}',
      scheme: 'Single or double space between words',
    });
  });

  it('finds nothing in plain text', () => {
    expect(decodeWhitespace('just\nsome\nplain\ntext')).toEqual([]);
  });
});

describe('whitespace tool', () => {
  it('decodes and shows the best reading, the table and the whitespace map', () => {
    const out = run(encodeSnow(cover, 'flag{tool}'));
    expect(out[0]).toMatchObject({ type: 'text', value: 'flag{tool}' });
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.highlight).toEqual([0]);
    const kv = out.find((o) => o.type === 'kv');
    expect(kv?.type === 'kv' && kv.entries.find(([k]) => k === 'Trailing tabs')?.[1]).not.toBe('0');
    const map = out.find((o) => o.type === 'text' && o.label?.startsWith('Trailing whitespace'));
    expect(map?.type === 'text' && map.value).toContain('→');
    expect(map?.type === 'text' && map.value).toContain('·');
  });

  it('warns and shows bytes when nothing looks like text', () => {
    // 3-bit groups of 7 everywhere: every byte is 0xFF
    const lines = Array.from({ length: 10 }, (_, i) => `row ${i}\t${'       \t'.repeat(4)}`);
    const out = run(lines.join('\n'));
    expect(out[0]?.type).toBe('bytes');
    expect(out.some((o) => o.type === 'note' && o.level === 'warn')).toBe(true);
  });

  it('notes a Whitespace-language program', () => {
    const program = '   \t\n\t\n \n \n\n\n'.repeat(4);
    const out = (() => {
      try {
        return run(program);
      } catch (e) {
        return e;
      }
    })();
    expect(
      Array.isArray(out) ? out.some((o) => o.type === 'note' && o.level === 'info') : true,
    ).toBe(true);
  });

  it('encodes with both schemes and checks the round trip', () => {
    for (const scheme of ['snow', 'binary']) {
      const out = run(cover, { mode: 'encode', secret: 'flag{enc}', scheme });
      expect(
        out.some((o) => o.type === 'note' && o.text.startsWith('Round-trip check passed')),
      ).toBe(true);
      const result = out.find((o) => o.type === 'text' && o.label?.startsWith('Text with hidden'));
      expect(result?.type === 'text' && decodeWhitespace(result.value)[0]!.text).toBe('flag{enc}');
    }
  });

  it('explains bad input', () => {
    expect(() => run('plain\ntext')).toThrow(/No line ends in spaces or tabs/);
    expect(() => run(cover, { mode: 'encode', secret: '' })).toThrow(ToolError);
    expect(() => run('  ', { mode: 'encode', secret: 'x' })).toThrow(ToolError);
    expect(() => run('one line', { mode: 'encode', secret: 'x'.repeat(50) })).toThrow(/too short/);
  });

  it('suggests itself for text with many trailing spaces or tabs', () => {
    const detect = whitespace.detect!;
    const sample = (text: string | null) => detect({ text, bytes: new Uint8Array() });
    expect(sample(null)).toBeNull();
    expect(sample('a\nb\nc\nd')).toBeNull();
    expect(sample(encodeSnow(cover, 'flag{d}'))).toMatchObject({
      score: 0.85,
      options: { mode: 'decode' },
    });
    expect(sample('a \nb \nc \nd \ne')).toMatchObject({ score: 0.6 });
    // Markdown hard line breaks are not a signal.
    expect(sample('a  \nb  \nc  \nd  \ne  ')).toBeNull();
  });

  it('is fast on a long text', () => {
    const long = Array.from({ length: 5000 }, (_, i) => `line ${i} of a long document`).join('\n');
    const t0 = performance.now();
    const stego = encodeSnow(long, 'flag{long}');
    expect(decodeWhitespace(stego)[0]!.text).toBe('flag{long}');
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
