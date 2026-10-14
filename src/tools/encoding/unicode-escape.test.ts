import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { resultToText } from '../../core/result-text';
import { toHex } from '../../lib/bytes';
import unicode, {
  hasUnicodeEscape,
  unicodeEscape,
  unicodeUnescape,
  unicodeUnescapeBytes,
} from './unicode-escape';

describe('unicode escapes: decode', () => {
  it('\\uXXXX, \\u{...}, \\UXXXXXXXX', () => {
    expect(unicodeUnescape('\\u0066\\u006c\\u0061\\u0067')).toBe('flag');
    expect(unicodeUnescape('\\u00e9\\u00E9 \\u2713')).toBe('éé ✓');
    expect(unicodeUnescape('\\u{66}\\u{1F600}\\u{000066}')).toBe('f😀f');
    expect(unicodeUnescape('\\U00000066\\U0001F600')).toBe('f😀');
  });

  it('combines UTF-16 surrogate pairs and neutralises lone surrogates', () => {
    expect(unicodeUnescape('\\ud83d\\ude00')).toBe('😀');
    expect(unicodeUnescape('%ud83d%ude00')).toBe('😀');
    expect(unicodeUnescape('\\ud83d!')).toBe('\ufffd!');
    expect(unicodeUnescape('\\ude00\\u0041')).toBe('\ufffdA');
  });

  it('%uXXXX and U+XXXX (spaces between U+ items are separators)', () => {
    expect(unicodeUnescape('%u0066%u006C%u0061%u0067')).toBe('flag');
    expect(unicodeUnescape('U+0066 U+006C U+0061 U+0067')).toBe('flag');
    expect(unicodeUnescape('U+0066U+006CU+1F600')).toBe('fl😀');
    expect(unicodeUnescape('x U+0041 y')).toBe('x A y');
    expect(unicodeUnescape('menu+1234 U+0041')).toBe('menu+1234 A');
  });

  it('octal escapes', () => {
    expect(unicodeUnescape('\\146\\154\\141\\147')).toBe('flag');
    expect(unicodeUnescape('\\101\\102\\0')).toBe('AB\0');
  });

  it('\\xHH: UTF-8 bytes when they make valid UTF-8, characters otherwise (auto)', () => {
    expect(unicodeUnescape('\\xc3\\xa9')).toBe('é');
    expect(unicodeUnescape('\\xe2\\x9c\\x93')).toBe('✓');
    expect(unicodeUnescape('caf\\xe9')).toBe('café');
    expect(unicodeUnescape('\\x66\\x6c\\x61\\x67')).toBe('flag');
  });

  it('explicit byte mode', () => {
    expect(unicodeUnescape('\\xc3\\xa9', 'codepoint')).toBe('Ã©');
    expect(unicodeUnescape('\\xc3\\xa9', 'bytes')).toBe('é');
    expect(toHex(unicodeUnescapeBytes('\\xff\\xfe', 'bytes'))).toBe('fffe');
    expect(toHex(unicodeUnescapeBytes('\\xff\\xfe', 'auto'))).toBe('c3bfc3be');
    expect(unicodeUnescape('\\101', 'codepoint')).toBe('A');
  });

  it('simple escapes can be switched off', () => {
    expect(unicodeUnescape('a\\nb\\tc\\\\d\\"e\\\'f\\u0041')).toBe('a\nb\tc\\d"e\'fA');
    expect(unicodeUnescape('a\\nb\\u0041', 'auto', false)).toBe('a\\nbA');
  });

  it('keeps text around escapes and invalid escapes untouched', () => {
    expect(unicodeUnescape('C:\\xampp\\u00e9 \\u12 \\q')).toBe('C:\\xampp\u00e9 \\u12 \\q');
    expect(unicodeUnescape('héllo \\u0041')).toBe('héllo A');
  });

  it('mixes styles in one string', () => {
    expect(unicodeUnescape('\\u0066\\x6c%u0061U+0067\\173')).toBe('flag{');
  });

  it('throws ToolError when there is nothing to decode or a code point is impossible', () => {
    expect(() => unicodeUnescape('just text')).toThrow(ToolError);
    expect(() => unicodeUnescape('just text')).toThrow(/No escape sequences/);
    expect(() => unicodeUnescape('\\U00110000')).toThrow(/beyond the last Unicode code point/);
    expect(() => unicodeUnescape('\\u{110000}')).toThrow(ToolError);
  });

  it('hasUnicodeEscape', () => {
    expect(hasUnicodeEscape('a\\u0041')).toBe(true);
    expect(hasUnicodeEscape('plain \\n text')).toBe(false);
  });
});

describe('unicode escapes: encode', () => {
  const text = 'flag{café ✓ 😀}';

  it('every style, non-ASCII only', () => {
    expect(unicodeEscape(text, 'u')).toBe('flag{caf\\u00e9 \\u2713 \\ud83d\\ude00}');
    expect(unicodeEscape(text, 'u-brace')).toBe('flag{caf\\u{e9} \\u{2713} \\u{1f600}}');
    expect(unicodeEscape(text, 'U')).toBe('flag{caf\\U000000e9 \\U00002713 \\U0001f600}');
    expect(unicodeEscape(text, 'percent-u')).toBe('flag{caf%u00e9 %u2713 %ud83d%ude00}');
    expect(unicodeEscape(text, 'x')).toBe(
      'flag{caf\\xc3\\xa9 \\xe2\\x9c\\x93 \\xf0\\x9f\\x98\\x80}',
    );
    expect(unicodeEscape(text, 'octal')).toBe(
      'flag{caf\\303\\251 \\342\\234\\223 \\360\\237\\230\\200}',
    );
    expect(unicodeEscape(text, 'uplus')).toBe('flag{caf' + 'U+00E9 U+2713 U+1F600}');
  });

  it('every character', () => {
    expect(unicodeEscape('flag', 'u', 'all')).toBe('\\u0066\\u006c\\u0061\\u0067');
    expect(unicodeEscape('hi', 'x', 'all')).toBe('\\x68\\x69');
    expect(unicodeEscape('hi', 'uplus', 'all')).toBe('U+0068U+0069');
  });

  it('U+ pads to six digits when the next character would be read as part of the number', () => {
    expect(unicodeEscape('éa', 'uplus')).toBe('U+0000E9a');
    expect(unicodeEscape('éz', 'uplus')).toBe('U+00E9z');
    expect(unicodeEscape('é1', 'uplus')).toBe('U+0000E91');
  });

  it('round-trips every style and scope, including awkward neighbours', () => {
    const awkward = 'a é1 éa ñ9 ✓f 😀B "quoted" \\ back\\slash\nnew\tline {x}';
    for (const style of ['u', 'u-brace', 'x', 'U', 'percent-u', 'uplus', 'octal'] as const) {
      for (const scope of ['nonascii', 'all'] as const) {
        const enc = unicodeEscape(awkward, style, scope);
        // plain backslashes in the source text are not escaped when scope is non-ASCII only,
        // so only compare the all-characters round trip for text containing them
        if (scope === 'all') expect(unicodeUnescape(enc, 'auto', false)).toBe(awkward);
      }
    }
    const noBackslash = awkward.replace(/\\/g, '/');
    for (const style of ['u', 'u-brace', 'x', 'U', 'percent-u', 'uplus', 'octal'] as const) {
      expect(unicodeUnescape(unicodeEscape(noBackslash, style, 'nonascii'))).toBe(noBackslash);
    }
  });
});

describe('unicode escapes tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    unicode.run(text, {
      mode: 'decode',
      bytes: 'auto',
      simple: true,
      style: 'u',
      scope: 'nonascii',
      ...options,
    } as never) as Output[];

  it('decodes to text and encodes', () => {
    expect(run('\\u0066lag')).toEqual([{ type: 'text', value: 'flag' }]);
    expect(run('é', { mode: 'encode' })).toEqual([{ type: 'text', value: '\\u00e9' }]);
  });

  it('forced byte mode with invalid UTF-8 gives a bytes block and a hint', () => {
    const out = run('\\xff\\xfe', { bytes: 'bytes' });
    expect(out[0]).toMatchObject({ type: 'bytes' });
    expect(resultToText(out)).toContain('binary');
  });

  it('bad input is a ToolError', () => {
    expect(() => run('nothing escaped here')).toThrow(ToolError);
  });

  it('detect: needs real escapes', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(unicode.detect!(sample('\\u0066\\u006c\\u0061\\u0067'))?.score).toBeGreaterThan(0.85);
    expect(unicode.detect!(sample('\\x41'))?.score).toBeLessThan(0.7);
    expect(unicode.detect!(sample('hello \\n world'))).toBeNull();
    expect(unicode.detect!(sample('MENU+1234 U+0041'))?.score).toBeLessThan(0.7);
  });
});
