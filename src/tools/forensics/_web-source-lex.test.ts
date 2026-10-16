import { describe, expect, it } from 'vitest';
import { LineIndex, lexJs, unescapeJs } from './_web-source-lex';

const raws = (src: string) => lexJs(src).strings.map((s) => s.raw);
const comments = (src: string) => lexJs(src).comments.map((c) => c.text);

describe('lexJs: string literals', () => {
  it('finds single, double and template strings with their positions', () => {
    const src = `a = 'one'; b = "two"; c = \`three\`;`;
    const { strings } = lexJs(src);
    expect(strings.map((s) => [s.quote, s.raw])).toEqual([
      ["'", 'one'],
      ['"', 'two'],
      ['`', 'three'],
    ]);
    for (const s of strings) expect(src.slice(s.start, s.end)).toBe(`${s.quote}${s.raw}${s.quote}`);
  });

  it('keeps escaped quotes and escaped backslashes inside the literal', () => {
    expect(raws(String.raw`x = "say \"hi\""; y = 'it\'s'; z = "back\\";`)).toEqual([
      String.raw`say \"hi\"`,
      String.raw`it\'s`,
      String.raw`back\\`,
    ]);
  });

  it('does not take an apostrophe in a comment for a string', () => {
    const src = [
      "// don't touch this",
      'const a = "real";',
      '/* it\'s "fake" */',
      'const b = 1;',
    ].join('\n');
    expect(raws(src)).toEqual(['real']);
    expect(comments(src)).toEqual([" don't touch this", ' it\'s "fake" ']);
  });

  it('does not take a quote in a regular expression for a string', () => {
    expect(raws(`const re = /["']/g; const s = "after";`)).toEqual(['after']);
    expect(raws(`if (x) { return /'\\//.test(y); } z = "ok";`)).toEqual(['ok']);
    expect(raws(`const re = /[/"]/; const s = 'x';`)).toEqual(['x']);
  });

  it('treats a slash after a name, a number or a closing bracket as a division', () => {
    expect(raws(`a = b / 2; c = d / "x"; e = (f) / 'y';`)).toEqual(['x', 'y']);
  });

  it('ignores a // inside a string and a quote inside a line comment', () => {
    const src = `u = "http://example.test/a"; // trailing "quote"\nv = 'next';`;
    expect(raws(src)).toEqual(['http://example.test/a', 'next']);
    expect(comments(src)).toEqual([' trailing "quote"']);
  });

  it('reads template literals with nested expressions as one string', () => {
    const src = 'a = `x ${b + `y ${"z"}`} w`; c = "after";';
    expect(raws(src)).toEqual(['x ${b + `y ${"z"}`} w', 'after']);
  });

  it('gives up on an unterminated string at the end of its line', () => {
    expect(raws(`x = 'broken\ny = "fine";`)).toEqual(['fine']);
  });

  it('continues a string over a backslash-newline', () => {
    expect(raws('x = "ab\\\ncd";')).toEqual(['ab\\\ncd']);
  });

  it('shifts positions by an offset (a script found inside a page)', () => {
    const { strings, comments: c } = lexJs('a("x"); // note', 100);
    expect(strings[0]!.start).toBe(102);
    expect(c[0]!.start).toBe(108);
  });

  it('is fast on a long minified line', () => {
    const src = 'var a=1;'.repeat(200_000) + 'var s="end";';
    const t0 = performance.now();
    expect(raws(src)).toEqual(['end']);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('never throws on odd input', () => {
    for (const src of ['`', '"', "'", '/', '/*', '//', '${', '`${`', '\\', 'a`b${c', '/[', '"\\']) {
      expect(() => lexJs(src)).not.toThrow();
    }
  });
});

describe('unescapeJs', () => {
  it('decodes hex, unicode, braced unicode and octal escapes, and counts them as encoded', () => {
    expect(unescapeJs(String.raw`\x66\x6c\x61\x67`)).toEqual({ value: 'flag', encoded: 4 });
    // Built from pieces: a four-digit unicode escape must reach unescapeJs as backslash, u, digits.
    const u = (code: string) => `${String.fromCharCode(92)}u${code}`;
    const written = [u('0066'), u('006c'), u('0061'), u('0067')].join('');
    expect(unescapeJs(written)).toEqual({ value: 'flag', encoded: 4 });
    expect(unescapeJs(String.raw`\u{66}\u{1F600}`)).toEqual({ value: 'f\u{1F600}', encoded: 2 });
    expect(unescapeJs(String.raw`\146\154\141\147`)).toEqual({ value: 'flag', encoded: 4 });
  });

  it('decodes the single-character escapes without calling them encoded', () => {
    expect(unescapeJs(String.raw`a\nb\tc\\d\"e\'f`)).toEqual({
      value: 'a\nb\tc\\d"e\'f',
      encoded: 0,
    });
    expect(unescapeJs('plain')).toEqual({ value: 'plain', encoded: 0 });
  });

  it('keeps what it cannot read and drops a line continuation', () => {
    expect(unescapeJs(String.raw`\xZZ`).value).toBe('xZZ');
    expect(unescapeJs('a\\\nb').value).toBe('ab');
    expect(unescapeJs('trailing\\').value).toBe('trailing\\');
  });
});

describe('LineIndex', () => {
  it('gives 1-based line and column', () => {
    const text = 'ab\ncde\n\nf';
    const idx = new LineIndex(text);
    expect(idx.at(0)).toEqual({ line: 1, col: 1 });
    expect(idx.at(1)).toEqual({ line: 1, col: 2 });
    expect(idx.at(3)).toEqual({ line: 2, col: 1 });
    expect(idx.at(text.indexOf('e'))).toEqual({ line: 2, col: 3 });
    expect(idx.at(text.indexOf('f'))).toEqual({ line: 4, col: 1 });
  });
});
