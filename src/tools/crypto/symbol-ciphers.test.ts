import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import { registeredTools, setRegisteredTools } from '../../core/tool-list';
import type { AnyTool, Glyph, Output } from '../../core/types';
import { utf8Decode } from '../../lib/bytes';
import braille from '../encoding/braille';
import { brailleDecode } from '../stego/_text-analyzer-decode';
import {
  ALPHABET_IDS,
  ALPHABETS,
  SEMAPHORE_POSITIONS,
  brailleToText,
  type AlphabetId,
  type SymbolOptions,
  type Token,
} from './_symbols';
import { buildSamples } from './_symbols-samples';
import { renderRow, renderSheet } from './_symbols-svg';
import symbolCiphers, { MAX_DRAWN } from './symbol-ciphers';

const PLAIN: SymbolOptions = { mirror: false };
const MIRROR: SymbolOptions = { mirror: true };
const ROW = { perRow: 12, labelled: true, title: 'test' };

/** The tool as the UI calls it: defaults, then the options under test. */
const run = (text: string, options: Record<string, unknown> = {}): Output[] =>
  symbolCiphers.run(text, {
    alphabet: 'pigpen',
    mirror: false,
    perRow: 12,
    ...options,
  } as never) as Output[];

const letters = (out: Output[]) => {
  const block = out.find((o) => o.type === 'text');
  return block?.type === 'text' ? block.value : '';
};
const pictures = (out: Output[]) =>
  out.flatMap((o) =>
    o.type === 'picture' ? [{ label: o.label ?? '', svg: utf8Decode(o.data), mime: o.mime }] : [],
  );
const notes = (out: Output[]) => out.flatMap((o) => (o.type === 'note' ? [o.text] : []));

/** XML 1.0 `Char`: tab, line feed, carriage return and everything from space up but the specials. */
const xmlChar = (cp: number) =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff);

/**
 * A small XML 1.0 well-formedness check (one root, balanced tags, quoted attributes, valid
 * entities, only legal characters): null when the document is well formed. The browser's own
 * DOMParser checks the same documents in the e2e suite.
 */
function wellFormed(xml: string): string | null {
  for (const ch of xml) if (!xmlChar(ch.codePointAt(0)!)) return `forbidden character ${ch}`;
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  const entity = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
  const badText = (s: string) => /[<&]/.test(s.replace(entity, ''));
  const open = /<([A-Za-z][\w.:-]*)((?:\s+[A-Za-z_:][\w.:-]*="[^"<]*")*)\s*(\/?)>/y;
  const close = /<\/([A-Za-z][\w.:-]*)\s*>/y;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt < 0 ? xml.length : lt);
    if (badText(text)) return `bad text at ${i}`;
    if (stack.length === 0 && text.trim()) return 'text outside the root';
    if (lt < 0) break;
    i = lt;
    close.lastIndex = i;
    open.lastIndex = i;
    const c = close.exec(xml);
    const o = c ? null : open.exec(xml);
    if (c) {
      if (stack.pop() !== c[1]) return `mismatched </${c[1]}>`;
      i = close.lastIndex;
    } else if (o) {
      if (stack.length === 0) roots++;
      if (!o[3]) stack.push(o[1]!);
      for (const attr of o[2]!.matchAll(/="([^"]*)"/g)) {
        if (badText(attr[1]!)) return `bad attribute value ${attr[1]}`;
      }
      i = open.lastIndex;
    } else return `bad markup at ${i}: ${xml.slice(i, i + 40)}`;
  }
  if (stack.length) return `unclosed <${stack.at(-1)}>`;
  return roots === 1 ? null : `${roots} root elements`;
}

describe('the XML checker used below', () => {
  it('accepts well-formed documents and rejects broken ones', () => {
    expect(wellFormed('<a x="1"><b/>text &amp; more</a>')).toBeNull();
    expect(wellFormed('<a><b></a>')).not.toBeNull();
    expect(wellFormed('<a>1 < 2</a>')).not.toBeNull();
    expect(wellFormed('<a>fish & chips</a>')).not.toBeNull();
    expect(wellFormed('<a x=1/>')).not.toBeNull();
    expect(wellFormed('<a/><b/>')).not.toBeNull();
    expect(wellFormed('<a>\u0001</a>')).not.toBeNull();
    expect(wellFormed('<a>\ud800</a>')).not.toBeNull();
  });
});

/** The letters of the symbols in a token list (the signs the encoder adds have no letter). */
const glyphTexts = (tokens: Token[]) =>
  tokens.flatMap((t) => (t.type === 'glyph' && t.key.text !== '' ? [t.key.text] : []));

/** Tokens read back as text: symbols as their letters, gaps as spaces, plain characters as is. */
const readBack = (tokens: Token[]) =>
  tokens
    .map((t) =>
      t.type === 'glyph'
        ? t.key.text
        : t.type === 'space'
          ? ' '
          : t.type === 'newline'
            ? '\n'
            : t.ch,
    )
    .join('');

describe.each(ALPHABET_IDS)('%s: every symbol', (id: AlphabetId) => {
  const alpha = ALPHABETS[id];
  const keys = alpha.keys(PLAIN);
  const every = keys.map((k) => k.text).join('');

  it('is drawn once, and no two symbols look alike', () => {
    const drawings = [...keys, ...alpha.extras(PLAIN)].map((k) => JSON.stringify(k.glyph.shapes));
    // Braille digits are the cells of a-j (behind the number sign): ten shared drawings.
    expect(new Set(drawings).size).toBe(drawings.length - (id === 'braille' ? 10 : 0));
    for (const k of keys) {
      expect(k.glyph.w).toBeGreaterThan(0);
      expect(k.glyph.h).toBeGreaterThan(0);
      expect(k.glyph.shapes.length).toBeGreaterThan(0);
      expect(k.name).toBeTruthy();
    }
    expect(new Set(keys.map((k) => k.text)).size).toBe(keys.length);
  });

  it('round-trips: the whole alphabet, encoded then read back, is unchanged', () => {
    expect(glyphTexts(alpha.tokenize(every, PLAIN)).join('')).toBe(every);
    // Letters are read in any case.
    expect(glyphTexts(alpha.tokenize(every.toUpperCase(), PLAIN)).join('')).toBe(every);
    expect(glyphTexts(alpha.tokenize(every.toLowerCase(), PLAIN)).join('')).toBe(every);
    // One key at a time: the last symbol drawn for a key's text is that key.
    for (const k of keys) {
      const drawn = alpha.tokenize(k.text, PLAIN).filter((t) => t.type === 'glyph');
      const last = drawn.at(-1);
      expect(last?.type === 'glyph' ? last.key.text : null).toBe(k.text);
    }
  });

  it('keeps words, lines and the characters it cannot draw', () => {
    const text = id === 'braille' ? 'the quick, brown fox\nx{y}_z' : 'THE QUICK BROWN FOX\nX{Y}_Z';
    expect(readBack(alpha.tokenize(text, PLAIN))).toBe(text);
    expect(readBack(alpha.tokenize('A  B\tC\r\nD', PLAIN)).toLowerCase()).toBe('a  b c\nd');
    // \n, \r and \r\n each break the line once.
    const breaks = (t: string) => alpha.tokenize(t, PLAIN).filter((k) => k.type === 'newline');
    expect(breaks('A\rB\r\nC\n\nD')).toHaveLength(4);
    const plain = alpha.tokenize('{}', PLAIN);
    expect(plain.map((t) => t.type)).toEqual(['plain', 'plain']);
  });

  it('draws a well-formed SVG with one glyph per symbol', () => {
    const tokens = alpha.tokenize(every, PLAIN);
    const row = renderRow(alpha, tokens, ROW);
    expect(wellFormed(row.svg)).toBeNull();
    const groups = row.svg.match(/<g class="glyph"/g) ?? [];
    expect(groups.length).toBe(tokens.filter((t) => t.type === 'glyph').length);
    expect(row.glyphs).toBe(groups.length);
    expect(row.svg.match(/data-char="/g)?.length).toBe(groups.length);
    const sheet = renderSheet(alpha, PLAIN, 'Sheet');
    expect(wellFormed(sheet.svg)).toBeNull();
    expect(sheet.glyphs).toBe(keys.length + alpha.extras(PLAIN).length);
    expect(sheet.svg.match(/<g class="glyph"/g)?.length).toBe(sheet.glyphs);
    // A label under every symbol.
    expect(sheet.svg.match(/<text class="label"/g)?.length).toBe(sheet.glyphs);
    for (const svg of [row.svg, sheet.svg]) {
      expect(svg).not.toMatch(/<script|href=|xlink|url\(|<image|<foreignObject|@import/);
      expect(svg.match(/https?:\/\//g)).toEqual(['http://']); // only the SVG namespace
    }
  });
});

describe('pigpen', () => {
  const alpha = ALPHABETS.pigpen;
  const keys = alpha.keys(PLAIN);
  const byLetter = new Map(keys.map((k) => [k.text, k]));
  const outline = (l: string) => byLetter.get(l)!.glyph.shapes[0]!.d;
  const segments = (d: string) => (d.match(/[LHV]/g) ?? []).length;

  it('has the 26 letters of the common layout', () => {
    expect(keys.map((k) => k.text).join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });

  it('draws each # cell by the grid lines around it: corners 2, edges 3, centre closed', () => {
    for (const l of 'ACGI') expect(segments(outline(l))).toBe(2);
    for (const l of 'BDFH') expect(segments(outline(l))).toBe(3);
    expect(outline('E')).toMatch(/Z$/); // the four sides: a closed square
    expect(segments(outline('E'))).toBe(3);
    // The right sides: A has its right and bottom lines, I its top and left, and so on.
    expect(outline('A')).toBe('M31 9V31H9');
    expect(outline('I')).toBe('M31 9H9V31');
    expect(outline('B')).toBe('M9 9V31H31V9'); // open at the top
    expect(outline('H')).toBe('M9 31V9H31V31'); // open at the bottom
    expect(outline('D')).toBe('M9 9H31V31H9'); // open on the left
    expect(outline('F')).toBe('M31 9H9V31H31'); // open on the right
  });

  it('puts a dot in J-R and W-Z, on the same outline as A-I and S-V', () => {
    const shapes = (l: string) => byLetter.get(l)!.glyph.shapes;
    const pairs = [...'ABCDEFGHI'].map((l, i) => [l, 'JKLMNOPQR'[i]!] as const);
    pairs.push(...[...'STUV'].map((l, i) => [l, 'WXYZ'[i]!] as const));
    for (const [plain, dotted] of pairs) {
      expect(shapes(plain)).toHaveLength(1);
      expect(shapes(dotted)).toHaveLength(2);
      expect(shapes(dotted)[0]).toEqual(shapes(plain)[0]);
      expect(shapes(dotted)[1]!.fill).toBe('ink');
    }
  });

  it('draws the X wedges top, left, right, bottom (S T U V)', () => {
    // Each wedge is two lines meeting at the centre (20 20), opening towards the named side.
    expect(outline('S')).toBe('M9 9L20 20L31 9'); // V: opens upwards
    expect(outline('T')).toBe('M9 9L20 20L9 31'); // >: opens to the left
    expect(outline('U')).toBe('M31 9L20 20L31 31'); // <: opens to the right
    expect(outline('V')).toBe('M9 31L20 20L31 31'); // ^: opens downwards
  });

  it('draws a flag with its braces as text', () => {
    const row = renderRow(alpha, alpha.tokenize('FTF{PIGPEN}', PLAIN), ROW);
    expect(row.glyphs).toBe(9);
    expect(row.svg.match(/<text class="plain"/g)).toHaveLength(2);
    expect(row.svg).toContain('>{</text>');
    expect(row.svg).toContain('>}</text>');
  });
});

describe('semaphore', () => {
  const alpha = ALPHABETS.semaphore;
  const keys = alpha.keys(PLAIN);
  const at = (l: string) => [...SEMAPHORE_POSITIONS[l]!].sort((a, b) => a - b);

  /** The arm positions a figure is drawn with: the angle of each shoulder-to-hand segment. */
  const drawnPositions = (glyph: Glyph, mirror: boolean) =>
    glyph.shapes
      .filter((s) => s.width === 2.8)
      .map((s) => {
        const [x1, y1, x2, y2] = s.d.match(/-?\d+(\.\d+)?/g)!.map(Number) as [
          number,
          number,
          number,
          number,
        ];
        const dx = (mirror ? -1 : 1) * (x2 - x1);
        return (Math.round(Math.atan2(dx, y2 - y1) / (Math.PI / 4)) + 8) % 8;
      })
      .sort((a, b) => a - b);

  it('gives every letter its own pair of arm positions', () => {
    const pairs = Object.entries(SEMAPHORE_POSITIONS);
    expect(pairs).toHaveLength(26);
    expect(new Set(pairs.map(([l]) => at(l).join())).size).toBe(26);
    for (const [, [a, b]] of pairs) {
      expect(a).not.toBe(b);
      for (const p of [a, b]) expect(p >= 0 && p <= 7).toBe(true);
    }
  });

  it('follows the known structure of the code', () => {
    // A-G: one arm straight down, the other sweeps round in steps of 45 degrees.
    expect([...'ABCDEFG'].map(at)).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 5],
      [0, 6],
      [0, 7],
    ]);
    expect(at('D')).toEqual([0, 4]); // a straight vertical line
    expect(at('R')).toEqual([2, 6]); // a straight horizontal line
    expect(at('U')).toEqual([3, 5]); // both arms raised (a V)
    expect(at('N')).toEqual([1, 7]); // both arms lowered (an inverted V)
    expect(at('J')).toEqual([4, 6]); // up and left
    // Seen in a mirror a letter is another one: B/F, C/E, A/G, K/V, O/W, P/J, M/S.
    const mirrored = (l: string) =>
      at(l)
        .map((p) => (8 - p) % 8)
        .sort((a, b) => a - b);
    const letterOf = (pair: number[]) =>
      Object.keys(SEMAPHORE_POSITIONS).find((l) => at(l).join() === pair.join());
    expect([...'BCAKOPM'].map((l) => letterOf(mirrored(l)))).toEqual([...'FEGVWJS']);
    for (const l of 'DNRU') expect(letterOf(mirrored(l))).toBe(l); // the symmetric ones
  });

  it('draws the arms where the table puts them', () => {
    for (const k of keys) {
      expect(drawnPositions(k.glyph, false)).toEqual(at(k.text));
    }
    for (const k of alpha.keys(MIRROR)) {
      expect(drawnPositions(k.glyph, true)).toEqual(at(k.text));
    }
  });

  it('draws two flags (red and yellow halves) on every figure', () => {
    for (const k of keys) {
      const fills = k.glyph.shapes.filter((s) => s.fill !== undefined).map((s) => s.fill);
      expect(fills).toHaveLength(4);
      expect(new Set(fills).size).toBe(2);
    }
  });

  it('mirrors the figure on request, point for point', () => {
    const coords = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const mirror = alpha.keys(MIRROR);
    let different = 0;
    for (const [i, k] of keys.entries()) {
      const m = mirror[i]!;
      expect(m.glyph.shapes).toHaveLength(k.glyph.shapes.length);
      for (const [j, s] of k.glyph.shapes.entries()) {
        if (/[a-z]/.test(s.d.replace(/[MLZ]/g, ''))) continue; // the head: a circle on the axis
        const a = coords(s.d);
        const b = coords(m.glyph.shapes[j]!.d);
        expect(b).toHaveLength(a.length);
        for (let n = 0; n < a.length; n += 2) {
          expect(b[n]).toBeCloseTo(60 - a[n]!, 1);
          expect(b[n + 1]).toBeCloseTo(a[n + 1]!, 1);
        }
      }
      if (JSON.stringify(m.glyph) !== JSON.stringify(k.glyph)) different++;
    }
    expect(different).toBeGreaterThan(20);
    const row = renderRow(alpha, alpha.tokenize('ABC', MIRROR), ROW);
    expect(row.svg).not.toBe(renderRow(alpha, alpha.tokenize('ABC', PLAIN), ROW).svg);
  });
});

describe('braille', () => {
  const alpha = ALPHABETS.braille;
  const cells = (text: string) =>
    alpha
      .tokenize(text, PLAIN)
      .map((t) => (t.type === 'glyph' ? t.key.unicode : t.type === 'space' ? '\u2800' : ''))
      .join('');
  const hex = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16));
  const popcount = (n: number) => n.toString(2).replace(/0/g, '').length;

  it('writes the letters with the Unicode Braille Patterns (U+2801 a, U+2803 b ...)', () => {
    // The English letters in the Unicode Braille Patterns block (dots 1-6 are bits 1 2 4 8 16 32).
    const unicode = [
      0x2801, 0x2803, 0x2809, 0x2819, 0x2811, 0x280b, 0x281b, 0x2813, 0x280a, 0x281a, 0x2805,
      0x2807, 0x280d, 0x281d, 0x2815, 0x280f, 0x281f, 0x2817, 0x280e, 0x281e, 0x2825, 0x2827,
      0x283a, 0x282d, 0x283d, 0x2835,
    ];
    expect(hex(cells('abcdefghijklmnopqrstuvwxyz'))).toEqual(unicode.map((n) => n.toString(16)));
    expect(cells('hello')).toBe('⠓⠑⠇⠇⠕');
    expect(cells('HELLO')).toBe(cells('hello'));
  });

  it('puts the number sign before a run of digits and the letter sign before a-j after them', () => {
    expect(hex(cells('42'))).toEqual(['283c', '2819', '2803']); // number sign, d, b
    expect(hex(cells('7 8'))).toEqual(['283c', '281b', '2800', '283c', '2813']); // g, blank, h
    expect(hex(cells('a1b2'))).toEqual(['2801', '283c', '2801', '2830', '2803', '283c', '2803']);
    expect(hex(cells('12ab'))).toEqual(['283c', '2801', '2803', '2830', '2801', '2803']);
    expect(hex(cells('12k'))).toEqual(['283c', '2801', '2803', '2805']); // k needs no letter sign
  });

  it('reads cells back as letters, digits, punctuation and capitals', () => {
    for (const text of [
      'hello world',
      'the quick brown fox, jumps; over: the lazy dog.',
      'a1b2',
      '12ab',
      '0123456789',
      "wow! what? it's so-so",
    ]) {
      expect(brailleToText(cells(text))).toBe(text);
    }
    expect(brailleToText('⠠⠁⠃')).toBe('Ab'); // capital sign: one letter
    expect(brailleToText('⠠⠠⠁⠃ ⠃')).toBe('AB b'); // doubled: the word
    expect(brailleToText('x⠁y')).toBe('xay'); // other characters stay
    expect(brailleToText('⠼⠁⠃⠅⠁')).toBe('12ka'); // k ends the number
    expect(brailleToText('\u283f')).toBe('\u283f'); // all six dots: no such sign, the cell stays
  });

  it('agrees with the independent Braille table of the text analyzer', () => {
    const text = 'the quick brown fox jumps over the lazy dog, 0123456789.';
    expect(brailleDecode(cells(text))).toBe(text);
    expect(brailleToText(cells(text))).toBe(brailleDecode(cells(text)));
  });

  it('writes a digit with the cell of the letter a-j that has its place (1 = a ... 0 = j)', () => {
    const shapes = (t: string) =>
      JSON.stringify(alpha.keys(PLAIN).find((k) => k.text === t)!.glyph);
    for (const [i, digit] of [...'1234567890'].entries()) {
      expect(shapes(digit)).toBe(shapes('abcdefghij'[i]!));
    }
  });

  it('draws six dots, the raised ones solid, and any six-dot cell it is given', () => {
    for (const k of alpha.keys(PLAIN)) {
      expect(k.glyph.shapes).toHaveLength(6);
      const raised = k.glyph.shapes.filter((s) => s.opacity === undefined).length;
      expect(raised).toBe(popcount(k.unicode!.codePointAt(0)! - 0x2800));
    }
    const any = alpha.tokenize('⠿\u2800⠁', PLAIN);
    expect(any.filter((t) => t.type === 'glyph')).toHaveLength(2);
    expect(any.some((t) => t.type === 'space')).toBe(true);
  });
});

describe('the SVG row', () => {
  const alpha = ALPHABETS.pigpen;
  const draw = (text: string, perRow = 12, labelled = true) =>
    renderRow(alpha, alpha.tokenize(text, PLAIN), { perRow, labelled, title: `T: ${text}` });
  const lineYs = (svg: string) => [
    ...new Set(
      [...svg.matchAll(/class="glyph"[^>]*transform="translate\([\d.]+ ([\d.]+)\)"/g)].map(
        (m) => m[1],
      ),
    ),
  ];

  it('wraps at word boundaries and breaks on newlines', () => {
    expect(lineYs(draw('ABCDEFGH', 3).svg)).toHaveLength(3);
    expect(lineYs(draw('AB CDE', 3).svg)).toHaveLength(2);
    expect(lineYs(draw('AB CD', 12).svg)).toHaveLength(1);
    expect(lineYs(draw('AB\nCD\n\nEF', 12).svg)).toHaveLength(3);
    expect(lineYs(draw('AB   CD', 12).svg)).toHaveLength(1);
  });

  it('sizes the picture to its content', () => {
    const size = (svg: string) =>
      svg
        .match(/width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/)!
        .slice(1)
        .map(Number);
    const [w, h, vw, vh] = size(draw('A').svg);
    expect([w, h]).toEqual([vw, vh]);
    expect(size(draw('ABCDEF').svg)[0]).toBeGreaterThan(w!);
    expect(size(draw('ABCDEFGHIJ', 3).svg)[1]).toBeGreaterThan(h!);
  });

  it('escapes every text and replaces what XML cannot carry', () => {
    const nasty = '<script>alert("x")</script> & \'q\' \u0001 \u{1f600} é';
    const row = draw(nasty);
    expect(wellFormed(row.svg)).toBeNull();
    expect(row.svg).not.toContain('<script>');
    expect(row.svg).toContain('&lt;');
    expect(row.svg).toContain('&amp;');
    expect(row.svg).toContain('\u{1f600}');
    expect(row.svg).toContain('�');
    expect(wellFormed(renderRow(alpha, [{ type: 'plain', ch: '\ud800' }], ROW).svg)).toBeNull();
  });

  it('a puzzle picture holds no letters', () => {
    const row = draw('FTF{PIGPEN}', 12, false).svg;
    expect(row).not.toMatch(/data-char|<title|aria-label|role=/);
    expect(row).not.toContain('PIGPEN');
    expect(draw('FTF{PIGPEN}').svg).toContain('data-char="F"');
  });

  it('draws nothing for an empty token list, still as a valid picture', () => {
    const row = renderRow(alpha, [], ROW);
    expect(row.glyphs).toBe(0);
    expect(wellFormed(row.svg)).toBeNull();
  });
});

describe('the tool', () => {
  it('turns letters into symbols and gives the letters back', () => {
    const out = run('FTF{PIGPEN}');
    expect(letters(out)).toBe('FTF{PIGPEN}');
    const [row, sheet] = pictures(out);
    expect(row!.mime).toBe('image/svg+xml');
    expect(wellFormed(row!.svg)).toBeNull();
    expect(row!.svg.match(/<g class="glyph"/g)).toHaveLength(9);
    expect(sheet!.label).toContain('Reference');
    expect(sheet!.svg.match(/<g class="glyph"/g)).toHaveLength(26);
    expect(resultToText(out)).toContain('FTF{PIGPEN}');
  });

  it('reads Braille cells as letters and gives them back as Unicode text', () => {
    const out = run('⠋⠞⠋\u2800⠃⠗⠁⠊⠇⠇⠑\u2800⠼⠁⠃⠉', { alphabet: 'braille' });
    expect(letters(out)).toBe('ftf braille 123');
    expect(out.filter((o) => o.type === 'text')).toHaveLength(2);
    const written = run('braille 42', { alphabet: 'braille' });
    expect(written.some((o) => o.type === 'text' && o.value === '⠃⠗⠁⠊⠇⠇⠑\u2800⠼⠙⠃')).toBe(true);
  });

  it('says which characters it could not draw', () => {
    expect(notes(run('A{B}_C', { alphabet: 'semaphore' })).join('\n')).toMatch(/\{ \} _/);
    const nothing = run('{}', { alphabet: 'pigpen' });
    expect(pictures(nothing)).toHaveLength(1); // only the reference sheet
    expect(notes(nothing).join('\n')).toMatch(/nothing/i);
  });

  it('refuses an empty input and honours the symbols per row', () => {
    expect(() => run('  \n ')).toThrow(ToolError);
    const height = (svg: string) => Number(svg.match(/height="(\d+)"/)![1]);
    const wide = pictures(run('ABCDEFGHIJKL', { perRow: 12 }))[0]!.svg;
    const narrow = pictures(run('ABCDEFGHIJKL', { perRow: 4 }))[0]!.svg;
    expect(height(narrow)).toBeGreaterThan(height(wide));
  });

  it('draws a bounded number of symbols and says so, while the letters stay complete', () => {
    const text = 'ABCDEFGH '.repeat(Math.ceil((MAX_DRAWN + 500) / 8));
    for (const alphabet of ['pigpen', 'semaphore', 'braille']) {
      const t0 = performance.now();
      const out = run(text, { alphabet });
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(letters(out)).toBe(text);
      const row = pictures(out)[0]!;
      expect(row.svg.match(/<g class="glyph"/g)).toHaveLength(MAX_DRAWN);
      expect(wellFormed(row.svg)).toBeNull();
      expect(notes(out).join('\n')).toContain(String(MAX_DRAWN));
    }
    // Just under the bound: everything is drawn and nothing is said.
    const exact = run('A'.repeat(MAX_DRAWN));
    expect(pictures(exact)[0]!.svg.match(/<g class="glyph"/g)).toHaveLength(MAX_DRAWN);
    expect(notes(exact).join('\n')).not.toMatch(/Only the first/);
  });

  it('draws every key of the keyboard differently, a Braille digit with its number sign', () => {
    const keypad = symbolCiphers.keypad!;
    for (const id of ALPHABET_IDS) {
      const keys = keypad({ alphabet: id, mirror: false, perRow: 12 } as never);
      const drawings = keys.map((k) => JSON.stringify(k.glyph));
      expect(new Set(drawings).size).toBe(keys.length);
    }
    const braille = keypad({ alphabet: 'braille', mirror: false, perRow: 12 } as never);
    const digit = braille.find((k) => k.text === '6')!;
    const letter = braille.find((k) => k.text === 'f')!;
    expect(digit.glyph.w).toBeGreaterThan(letter.glyph.w); // two cells wide
    expect(digit.glyph.shapes).toHaveLength(12);
    expect(digit.label).toBe('6');
  });

  it('offers the keys of the chosen alphabet to the keyboard', () => {
    const keypad = symbolCiphers.keypad!;
    for (const id of ALPHABET_IDS) {
      const keys = keypad({ alphabet: id, mirror: false, perRow: 12 } as never);
      expect(keys).toHaveLength(ALPHABETS[id].keys(PLAIN).length);
      for (const k of keys) expect(k.label).toBe(k.text); // a key is named by its letter
    }
    expect(keypad({ alphabet: 'pigpen', mirror: false, perRow: 12 } as never)).toHaveLength(26);
    expect(keypad({ alphabet: 'braille', mirror: false, perRow: 12 } as never)).toHaveLength(44);
  });

  it('the text a keyboard types is what the picture shows: every key, in every alphabet', () => {
    for (const id of ALPHABET_IDS) {
      const typed = ALPHABETS[id]
        .keys(PLAIN)
        .map((k) => k.text)
        .join('');
      const out = run(typed, { alphabet: id });
      expect(letters(out)).toBe(typed);
      const row = pictures(out)[0]!.svg;
      const drawn = [...row.matchAll(/data-char="([^"]*)"/g)].map((m) => m[1]);
      expect(drawn.filter((c) => c !== '').join('')).toBe(typed);
    }
  });

  it('suggests itself for pasted Braille cells only', () => {
    const detect = symbolCiphers.detect!;
    expect(detect({ text: '⠋⠞⠋ ⠃⠗⠁⠊⠇⠇⠑', bytes: new Uint8Array() })?.options).toEqual({
      alphabet: 'braille',
    });
    expect(detect({ text: 'FTF{PIGPEN}', bytes: new Uint8Array() })).toBeNull();
    expect(detect({ text: '⠋⠞', bytes: new Uint8Array() })).toBeNull();
    expect(detect({ text: null, bytes: new Uint8Array() })).toBeNull();
  });
});

describe('the sample pictures', () => {
  it('are the ones the generator draws (run scripts/gen-samples-symbols.mjs)', () => {
    const samples = buildSamples();
    expect(Object.keys(samples)).toHaveLength(3);
    for (const [name, svg] of Object.entries(samples)) {
      const url = new URL(`../../../public/samples/${name}`, import.meta.url);
      expect(readFileSync(url, 'utf8')).toBe(svg);
      expect(wellFormed(svg)).toBeNull();
      expect(svg).not.toMatch(/data-char|<title|aria-label/); // a puzzle: no letters in the file
    }
  });

  it('draw the flags they promise', () => {
    const samples = buildSamples();
    const count = (name: string) => samples[name]!.match(/<g class="glyph"/g)?.length;
    expect(count('symbols-pigpen-flag.svg')).toBe(9); // FTF PIGPEN
    expect(count('symbols-semaphore-line.svg')).toBe(8); // FTF FLAGS
    expect(count('symbols-braille-line.svg')).toBe(10); // ftf braille
  });
});

describe('symbol-ciphers cross-link', () => {
  it('offers the Braille tool only for the Braille alphabet', () => {
    const prev = registeredTools();
    setRegisteredTools([braille] as AnyTool[]);
    try {
      expect(resultToText(run('ftf', { alphabet: 'braille' }))).toContain('Open in');
      expect(resultToText(run('ftf', { alphabet: 'pigpen' }))).not.toContain('Open in');
    } finally {
      setRegisteredTools(prev);
    }
  });
});
