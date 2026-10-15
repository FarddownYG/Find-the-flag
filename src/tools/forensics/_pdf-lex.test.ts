import { describe, expect, it } from 'vitest';
import {
  formatName,
  formatPretty,
  formatValue,
  isArray,
  isDict,
  Lexer,
  parseValue,
  pdfText,
  type PdfValue,
} from './_pdf-lex';

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const latin = (b: Uint8Array) => String.fromCharCode(...b);

describe('PDF lexer', () => {
  it('reads numbers, booleans, null and references', () => {
    const lx = new Lexer(bytes('12 -3.5 +.25 4. true false null 7 0 R 7 0 Rx'));
    const got: (PdfValue | undefined)[] = [];
    for (let i = 0; i < 8; i++) got.push(lx.readValue());
    expect(got.slice(0, 7)).toEqual([12, -3.5, 0.25, 4, true, false, null]);
    expect(got[7]).toEqual({ k: 'ref', num: 7, gen: 0 });
    // "7 0 Rx" is not a reference: 7, 0, then the keyword Rx
    expect(lx.readValue()).toBe(7);
    expect(lx.readValue()).toBe(0);
    expect(lx.readValue()).toEqual({ k: 'kw', v: 'Rx' });
  });

  it('keeps integers apart in content streams (no references)', () => {
    const lx = new Lexer(bytes('1 0 R'), 0, 5, false);
    expect(lx.readValue()).toBe(1);
    expect(lx.readValue()).toBe(0);
    expect(lx.readValue()).toEqual({ k: 'kw', v: 'R' });
  });

  it('decodes names with #xx escapes (7.3.5)', () => {
    expect(parseValue('/Name1')).toEqual({ k: 'name', v: 'Name1' });
    expect(parseValue('/A#42')).toEqual({ k: 'name', v: 'AB' });
    expect(parseValue('/J#61vaScript')).toEqual({ k: 'name', v: 'JavaScript' });
    expect(parseValue('/Lime#20Green')).toEqual({ k: 'name', v: 'Lime Green' });
    expect(parseValue('/')).toEqual({ k: 'name', v: '' });
    expect(parseValue('/Caf#C3#A9')).toEqual({ k: 'name', v: 'Café' });
    expect(formatName('Lime Green')).toBe('/Lime#20Green');
  });

  it('reads literal strings with escapes and balanced parentheses (7.3.4.2)', () => {
    const s = parseValue('(a(b)c\\)\\n\\101\\53\\0053\\\r\nx)') as { b: Uint8Array };
    expect(latin(s.b)).toBe('a(b)c)\nA+\u00053x');
    expect(latin((parseValue('(One\\\nTwo)') as { b: Uint8Array }).b)).toBe('OneTwo');
    expect(latin((parseValue('(line\r\nbreak)') as { b: Uint8Array }).b)).toBe('line\nbreak');
    // unterminated: takes what is there
    expect(latin((parseValue('(abc') as { b: Uint8Array }).b)).toBe('abc');
  });

  it('reads hexadecimal strings, odd digit counts included (7.3.4.3)', () => {
    expect(Array.from((parseValue('<48 65 6C6c 6F>') as { b: Uint8Array }).b)).toEqual([
      0x48, 0x65, 0x6c, 0x6c, 0x6f,
    ]);
    expect(Array.from((parseValue('<901FA>') as { b: Uint8Array }).b)).toEqual([0x90, 0x1f, 0xa0]);
    expect(Array.from((parseValue('<>') as { b: Uint8Array }).b)).toEqual([]);
  });

  it('reads nested dictionaries and arrays', () => {
    const v = parseValue('<< /Type /Page /Kids [1 0 R 2 0 R] /D << /A (x) /B [] >> /N 5 >>');
    if (!isDict(v)) throw new Error('not a dict');
    expect([...v.map.keys()]).toEqual(['Type', 'Kids', 'D', 'N']);
    const kids = v.map.get('Kids');
    expect(isArray(kids) && kids.items).toEqual([
      { k: 'ref', num: 1, gen: 0 },
      { k: 'ref', num: 2, gen: 0 },
    ]);
    expect(formatValue(v)).toBe('<< /Type /Page /Kids [1 0 R 2 0 R] /D << /A (x) /B [] >> /N 5 >>');
  });

  it('survives damaged dictionaries', () => {
    const lx = new Lexer(bytes('<< /A 1 /B >> '));
    const d = lx.readValue();
    expect(isDict(d) && d.map.get('B')).toBe(null);
    // missing value then stream keyword: the dictionary stops before "stream"
    const lx2 = new Lexer(bytes('<< /Length 5 /Filter stream\ndata'));
    const d2 = lx2.readValue();
    expect(isDict(d2) && [...d2.map.keys()]).toEqual(['Length']);
    expect(lx2.atWord('stream')).toBe(true);
    // an unterminated dictionary and array end at the end of the data
    expect(isDict(parseValue('<< /A [1 2'))).toBe(true);
    // stray closing brackets are skipped as keywords
    expect(parseValue(']')).toEqual({ k: 'kw', v: ']' });
  });

  it('refuses absurd nesting without overflowing the stack', () => {
    expect(parseValue('['.repeat(5000))).toBeUndefined();
    expect(parseValue('<<'.repeat(5000))).toBeUndefined();
  });

  it('skips comments', () => {
    const lx = new Lexer(bytes('% hello\n12 % more\r(a) %tail'));
    expect(lx.readValue()).toBe(12);
    expect(lx.readValue()).toMatchObject({ k: 'str' });
    expect(lx.readValue()).toBeUndefined();
  });

  it('formats values on one line and over several', () => {
    expect(formatValue(parseValue('(a(b)\\\\)'))).toBe('(a\\(b\\)\\\\)');
    expect(formatValue(parseValue('<00FF>'))).toBe('<00ff>');
    expect(formatValue(parseValue('<FEFF00480069>'))).toBe('(Hi)');
    expect(formatValue(parseValue('[1 2.5 /N (s)]'))).toBe('[1 2.5 /N (s)]');
    const long = formatValue(parseValue(`[${'1 '.repeat(500)}]`), 40);
    expect(long.length).toBeLessThanOrEqual(41);
    expect(long.endsWith('…')).toBe(true);
    expect(formatPretty(parseValue('<< /A 1 /B << /C 2 >> >>'))).toBe(
      '<<\n  /A 1\n  /B <<\n    /C 2\n  >>\n>>',
    );
  });

  it('decodes text strings: UTF-16BE, UTF-8, PDFDocEncoding', () => {
    expect(pdfText(Uint8Array.from([0xfe, 0xff, 0x00, 0x48, 0x00, 0xe9]))).toBe('Hé');
    expect(pdfText(Uint8Array.from([0xff, 0xfe, 0x48, 0x00]))).toBe('H');
    expect(pdfText(Uint8Array.from([0xef, 0xbb, 0xbf, 0xc3, 0xa9]))).toBe('é');
    expect(pdfText(Uint8Array.from([0x80, 0x84, 0xa0, 0x41]))).toBe('•—€A');
  });
});
