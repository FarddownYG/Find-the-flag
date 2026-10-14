import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { foldAccents } from '../../lib/readability';
import { affineEncrypt } from '../crypto/affine';
import { atbash } from '../crypto/atbash';
import { rotate } from '../crypto/caesar';
import { makeRng } from '../crypto/_classical';
import { railFenceEncrypt } from '../crypto/rail-fence';
import { PROSE_A, PROSE_B } from '../crypto/_sample-text';
import { parseSubstitutionKey, substitutionApply } from '../crypto/substitution';
import { vigenereTransform } from '../crypto/vigenere';
import { polybiusEncode } from '../crypto/polybius';
import { base32Encode } from '../encoding/base32';
import { base58Encode } from '../encoding/base58';
import { base85Encode } from '../encoding/base85';
import { morseEncode } from '../encoding/morse';
import { toBase64, toHex, utf8Encode } from '../../lib/bytes';
import { STRONG, deleet, foldKey, type Scored } from './_text-analyzer-core';
import {
  REGRESSION_CASES,
  ROUND2_CASES,
  STRESS_CASES,
  TEXT_CASES,
  VARIANT_CASES,
  type StressCase,
} from './_text-analyzer-cases';
import { a1z26Decode, brailleDecode, multitapDecode, relayout } from './_text-analyzer-decode';
import { findHomoglyphs } from './_text-analyzer-hidden';
import { charName, repeats, spacing } from './_text-analyzer-meta';
import { embedPayload, encodePayload } from './_zerowidth';
import tool, { analyze } from './text-analyzer';
import { encodeBinary, encodeSnow } from './whitespace';

const run = (text: string) => tool.run(text, {}) as Output[];
const fold = (s: string) => foldAccents(s).replace(/[^a-z0-9]/g, '');
/** The output or its reading spells the expected message (accents, case, spacing ignored). */
const mentions = (s: Scored, expected: string) =>
  fold(s.result).includes(fold(expected)) || fold(s.reading ?? '').includes(fold(expected));
/** Every reference case: the originals, the verification regressions and the paste variants. */
const ALL_CASES = [...TEXT_CASES, ...REGRESSION_CASES, ...VARIANT_CASES, ...ROUND2_CASES];
const caseText = (name: string) => {
  const found = ALL_CASES.find((c) => c.name === name);
  if (!found) throw new Error(`no case "${name}"`);
  return found.text;
};

/** The scored output of one pass, by its label. */
const passOf = (text: string, label: string) => {
  const a = analyze(text);
  const pass = a.passes.find((p) => p.label === label);
  if (!pass) throw new Error(`no pass "${label}"`);
  return { pass, scored: a.scored.get(pass), analysis: a };
};

const rankOf = (text: string, expected: string) =>
  analyze(text).ranked.findIndex((s) => mentions(s, expected));

const COVER = [
  'The meeting moved to the small room on the second floor.',
  'Coffee will be served from nine, and lunch at half past twelve.',
  'Please bring the printed agenda and your laptop charger.',
  'Parking is free for visitors in the north car park.',
  'Call the front desk if the door is locked when you arrive.',
  'We expect to finish before four so you can catch the train.',
  'Thanks again for travelling all this way to join us.',
  'See you on Thursday morning, and safe travels.',
].join('\n');

describe('reference cases', () => {
  for (const c of ALL_CASES.filter((t) => t.expected)) {
    it(`${c.name}: "${c.expected}" is among the top 3 (${c.technique})`, () => {
      const rank = rankOf(c.text, c.expected!);
      expect(rank).toBeGreaterThanOrEqual(0);
      expect(rank).toBeLessThan(3);
    });
  }

  for (const name of ['Sand to Musset', 'POS Musset / Sand (mandatory case)']) {
    it(`${name}: "Cette Nuit" is the best result and stands out`, () => {
      const sand = ALL_CASES.find((c) => c.name === name)!;
      const a = analyze(sand.text);
      expect(a.ranked[0]!.result).toBe('Cette Nuit');
      expect(a.ranked[0]!.pass.label).toBe('First word of each line');
      expect(a.ranked[0]!.score).toBeGreaterThanOrEqual(STRONG);
      const out = run(sand.text);
      expect(out[0]).toEqual({
        type: 'note',
        level: 'success',
        text: 'Most readable: First word of each line → Cette Nuit',
      });
      expect(out[1]).toEqual({
        type: 'text',
        label: 'First word of each line',
        value: 'Cette Nuit',
      });
    });
  }

  it('the adversarial twin of Sand ("Cette Garde") does not stand out', () => {
    const twin = ALL_CASES.find((c) => c.name.startsWith('Q6 FR couplet'))!;
    const { scored } = passOf(twin.text, 'First word of each line');
    expect(scored!.result).toBe('Cette Garde');
    expect(scored!.score).toBeLessThan(STRONG);
    const sand = passOf(TEXT_CASES[0]!.text, 'First word of each line').scored!;
    expect(sand.score - scored!.score).toBeGreaterThan(20);
  });

  for (const c of ALL_CASES.filter((t) => t.negative)) {
    it(`${c.name}: nothing reaches the strong threshold`, () => {
      const a = analyze(c.text);
      expect(a.ranked.filter((s) => s.score >= STRONG).map((s) => s.result)).toEqual([]);
      expect(run(c.text)[0]).toEqual({
        type: 'note',
        level: 'info',
        text: 'Nothing stands out; every pass is listed below',
      });
    });
  }

  // Runs the whole analyzer on every reference case: ~3 s alone, over the 5 s default when the
  // machine is busy.
  it(
    'every expected hidden message is the strong top hit (unless too short to prove it)',
    {
      timeout: 60_000,
    },
    () => {
      for (const c of ALL_CASES.filter((t) => t.expected && !t.weak)) {
        const top = analyze(c.text).ranked[0]!;
        expect(mentions(top, c.expected!), c.name).toBe(true);
        expect(top.score, c.name).toBeGreaterThanOrEqual(STRONG);
      }
    },
  );
});

/** Every table stays readable: capped rows, capped cells. */
function expectBounded(out: Output[], name: string) {
  for (const o of out) {
    if (o.type !== 'table') continue;
    expect(o.rows.length, `${name}: rows of “${o.label}”`).toBeLessThanOrEqual(250);
    for (const row of o.rows) {
      for (const cell of row)
        expect(String(cell).length, `${name}: a cell of “${o.label}”`).toBeLessThan(400);
    }
  }
}

/**
 * Budgets are measured on a quiet machine; the tests allow this much more so that a busy one
 * does not fail them. A regex trap or a quadratic scan still fails by far (they cost seconds
 * to hours where the budget is milliseconds).
 */
const SLACK = 4;

describe('stress cases', () => {
  run('warm up the word lists\nand the JIT');
  const runCase = (c: StressCase) => {
    for (const [i, input] of c.inputs().entries()) {
      const name = `${c.name} #${i}`;
      const t0 = performance.now();
      let out: Output[] | null = null;
      try {
        out = run(input);
      } catch (e) {
        expect(e, `${name} may only throw a ToolError`).toBeInstanceOf(ToolError);
      }
      const ms = performance.now() - t0;
      if (c.expect === 'error') expect(out, `${name} must be rejected`).toBeNull();
      if (c.expect === 'result') expect(out, `${name} must be analysed`).not.toBeNull();
      if (c.budgetMs) expect(ms, `${name}: ${ms.toFixed(0)} ms`).toBeLessThan(c.budgetMs * SLACK);
      if (!out) continue;
      expectBounded(out, name);
      if (c.surfaces) expect(rankOf(input, c.surfaces), name).toBeLessThan(3);
    }
  };
  for (const c of STRESS_CASES) {
    it(`${c.name} (${c.technique})`, () => runCase(c), 120_000);
  }
});

describe('acrostics and regular picks', () => {
  it('reads first / last letters and words of the lines', () => {
    const text = 'Hold the door\nEvery night we\nLook at the stars\nPlease come too';
    const a = analyze(text);
    const result = (label: string) => a.passes.find((p) => p.label === label)?.result;
    expect(result('First letter of each line')).toBe('HELP');
    expect(result('Last letter of each line')).toBe('reso');
    expect(result('First word of each line')).toBe('Hold Every Look Please');
    expect(result('Last word of each line')).toBe('door we stars too');
    expect(result('2nd letter of each line')).toBe('ovol');
  });

  it('splits hyphenated first words (Voulez-vous → Voulez) and skips blank lines', () => {
    const { pass } = passOf('Quand je\nVoulez-vous bien\n\nVous aussi', 'First word of each line');
    expect(pass.result).toBe('Quand Voulez Vous');
  });

  it('first words that merely start sentences carry little weight', () => {
    const prose = 'The cat sat.\nVisitors came in.\nPlease wait here.';
    const verse = 'The cat sat\nVisitors came in\nPlease wait here';
    const prior = (t: string) => passOf(t, 'First word of each line').pass.prior!;
    expect(prior(prose)).toBeLessThan(prior(verse));
    expect(prior(verse)).toBe(1);
  });

  it('finds a message spelled by every Nth character', () => {
    const message = 'flag{every_third_char}';
    const filler = 'qzxwvkjqzxwvkjqzxwvkjqzxwvkjqzxwvkjqzxwvkjqz';
    let text = '';
    for (let i = 0; i < message.length; i++)
      text += filler[2 * i]! + filler[2 * i + 1]! + message[i];
    const { pass, scored } = passOf(text, 'Every 3rd character');
    expect(pass.result).toBe(message);
    expect(pass.note).toContain('from character 3');
    expect(scored!.score).toBeGreaterThanOrEqual(STRONG);
  });

  it('reads the first letter of each word and each sentence, and the capitals', () => {
    const a = analyze('Some useful notes. Eat less meat. Take everything.\nNot Often Wise');
    const result = (label: string) => a.passes.find((p) => p.label === label)?.result;
    expect(result('First letter of each word')).toBe('SunElmTeNOW');
    expect(result('Third letter of each word')).toBe('mettsaketts');
    expect(result('First letter of each sentence')).toBe('SETN');
    expect(result('Capital letters')).toBe('SETNOW');
  });

  it('reads word lengths as digits (pi mnemonic) and as A1Z26 letters', () => {
    const pi = passOf('How I want a drink, alcoholic of course', 'Word lengths as digits');
    expect(pi.pass.result).toBe('31415926');
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const words = [...'hide'].map((c) => 'x'.repeat(letters.indexOf(c) + 1));
    expect(passOf(words.join(' '), 'Word lengths as letters (A1Z26)').pass.result).toBe('hide');
  });

  it('skips list markers, so a numbered or bulleted poem keeps its acrostic', () => {
    const sand = TEXT_CASES[0]!.text.split('\n');
    for (const marked of [sand.map((l, i) => `${i + 1}. ${l}`), sand.map((l) => `• ${l}`)]) {
      const { pass } = passOf(marked.join('\n'), 'First word of each line');
      expect(pass.result).toBe('Cette Nuit');
    }
    // A dash at the start of one line of prose is not a list.
    expect(passOf('- I know\nyou do', 'First word of each line').pass.result).toBe('I you');
  });

  it('first letters that spell one long word stand out, a short one is only ranked', () => {
    const lines = (word: string) =>
      [...word].map((c) => `${c.toUpperCase()}ver the hills we walk along`).join('\n');
    const long = passOf(lines('tresor'), 'First letter of each line').scored!;
    expect(long.score).toBeGreaterThanOrEqual(STRONG);
    const midi = ALL_CASES.find((c) => c.name.includes('MIDI'))!;
    expect(rankOf(midi.text, 'midi')).toBeLessThan(3);
  });

  it('a run of picked words must form a phrase, not just be words', () => {
    // Function words in a row, a list read back, doubled words: none of it is a message.
    for (const text of [
      'Je marche seul\nLe ciel est bas\nDans le jardin\nEt le soleil',
      'Call the plumber\nPay the bill\nBuy a card\nBook the train',
    ]) {
      expect(passOf(text, 'First word of each line').scored!.score, text).toBeLessThan(25);
    }
  });

  it('weighs verse and wrapped prose differently (rhyme, line-start case)', () => {
    const prior = (t: string) => passOf(t, 'First word of each line').pass.prior!;
    const rhymed = 'cette grande faveur que votre ardeur réclame\nnuit peut-être à ma flamme';
    const wrapped = 'cette grande faveur que votre ardeur\nnuit peut-être à ma flamme';
    expect(prior(rhymed)).toBeGreaterThan(0.9);
    expect(prior(wrapped)).toBeLessThan(0.7);
  });
});

describe('structured reading', () => {
  it('reverses the text, the lines and the words', () => {
    expect(rankOf('.noitats eht ta noon ta em teeM', 'meet me at noon at the station')).toBe(0);
    const { pass } = passOf('one\ntwo\nthree', 'Lines in reverse order');
    expect(pass.result).toBe('three\ntwo\none');
  });

  it('reads odd lines, the diagonal and the grid by columns', () => {
    const grid = ['hxxxx', 'xexxx', 'xxlxx', 'xxxlx', 'xxxxo'].join('\n');
    expect(passOf(grid, 'Diagonal ↘ (character i of line i)').pass.result).toBe('hello');
    const cols = ['mmn', 'eeo', 'eao', 'ttn'].join('\n');
    expect(passOf(cols, 'Read by columns (grid transposed)').pass.result).toBe('meetmeatnoon');
    expect(passOf('a\nb\nc\nd\ne', 'Odd lines (1st, 3rd…)').pass.result).toBe('a\nc\ne');
  });

  it('does not reward a reading that only re-reads the input', () => {
    const { scored } = passOf(PROSE_A.replace(/\. /g, '.\n'), 'Lines in reverse order');
    expect(scored!.raw).toBeGreaterThan(70);
    expect(scored!.score).toBeLessThan(25);
  });

  it('never ranks the input itself and lists identical results once', () => {
    const text = 'Many apples\nEat them\nEvery day\nTo stay healthy';
    const a = analyze(text);
    expect(a.ranked.some((s) => foldKey(s.result) === foldKey(text))).toBe(false);
    const keys = a.ranked.map((s) => foldKey(s.result));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('invisible characters and marks', () => {
  it('decodes zero-width messages with the zero-width tool schemes', () => {
    for (const scheme of ['binary', '330k', 'tags'] as const) {
      const text = embedPayload(COVER, encodePayload('flag{zero_width}', scheme).units, 'spread');
      const top = analyze(text).ranked[0]!;
      expect(top.result, scheme).toBe('flag{zero_width}');
      expect(top.pass.label).toBe('Zero-width and invisible characters');
      expect(top.score).toBeGreaterThanOrEqual(STRONG);
    }
  });

  it('decodes stegsnow and trailing-whitespace bits', () => {
    const snow = encodeSnow(`${COVER}\n${COVER}`, 'flag{snow}', 120);
    expect(passOf(snow, 'Trailing whitespace: stegsnow').pass.result).toBe('flag{snow}');
    expect(analyze(snow).ranked[0]!.result).toBe('flag{snow}');
    const bits = encodeBinary(COVER, 'hidden!');
    expect(passOf(bits, 'Trailing spaces / tabs as bits').pass.result).toBe('hidden!');
  });

  it('decodes unusual spaces and double spaces used as bits', () => {
    const secret = 'flag{nbsp}';
    const bits = [...utf8Encode(secret)].flatMap((b) => b.toString(2).padStart(8, '0').split(''));
    const words = bits.map((_, i) => `w${'abcdefghij'[i % 10]}`);
    const nbsp = words.map((w, i) => w + (bits[i] === '1' ? '\u00a0' : ' ')).join('') + 'end';
    expect(passOf(nbsp, 'Unusual spaces as bits (NBSP, thin, em…)').pass.result).toBe(secret);
    const doubled = words.map((w, i) => w + (bits[i] === '1' ? '  ' : ' ')).join('') + 'end';
    expect(passOf(doubled, 'Single / double spaces between words, as bits').pass.result).toBe(
      secret,
    );
  });

  it('lists homoglyphs with positions', () => {
    const text = 'Pl\u0435ase s\u0435nd the c\u043ede to the usual address';
    const found = findHomoglyphs(text);
    expect(found.map((h) => [h.looksLike, h.column, h.name])).toEqual([
      ['e', 3, 'CYRILLIC SMALL LETTER IE'],
      ['e', 9, 'CYRILLIC SMALL LETTER IE'],
      ['o', 18, 'CYRILLIC SMALL LETTER O'],
    ]);
    expect(passOf(text, 'Homoglyphs: the letters they imitate').pass.result).toBe('eeo');
    const out = resultToText(run(text));
    expect(out).toContain('Homoglyphs (positions in the text without invisible characters)');
    expect(out).toContain('\u043e\to\tU+043E\tCYRILLIC SMALL LETTER O\tline 1, col 18');
    // Cyrillic text is not "homoglyphs".
    expect(findHomoglyphs('Привет, как дела? Всё хорошо.')).toEqual([]);
  });

  it('decodes "which words hold a lookalike" as bits', () => {
    const secret = 'flag{ok}';
    const bits = [...utf8Encode(secret)].flatMap((b) => b.toString(2).padStart(8, '0').split(''));
    const words = ['cake', 'note', 'rose', 'bean', 'coat', 'page', 'home', 'lake'];
    const swap: Record<string, string> = { a: '\u0430', e: '\u0435', o: '\u043e' };
    const text = bits
      .map((bit, i) => {
        const w = words[i % words.length]!;
        return bit === '1' ? w.replace(/[aeo]/, (c) => swap[c]!) : w;
      })
      .join(' ');
    const { pass } = passOf(text, 'Homoglyphs as bits (lookalike letter = 1)');
    expect(pass.result).toBe(secret);
    expect(pass.note).toContain('one bit per word');
    expect(analyze(text).ranked[0]!.result).toBe(secret);
  });

  it('reads letter case as Bacon and extracts capitals inside words', () => {
    const text = 'meEt Me At The old pieR After mIdnight anD brINg It HEre';
    const { pass } = passOf(text, 'Letter case as bits (capital = 1)');
    expect(pass.result).toBe('FLAGBACON');
    expect(analyze(text).ranked[0]!.reading).toBe('flag{bacon}');
    expect(passOf(text, 'Letters in unexpected case').pass.result).toBe('ERIDINE');
    expect(
      passOf('An ordinary Sentence. Another one.', 'Letter case as bits (capital = 1)').pass.result,
    ).toBeNull();
  });
});

describe('encodings', () => {
  const flag = 'flag{decoded_me}';
  it.each([
    ['Hex (base16)', toHex(utf8Encode(flag), ' ')],
    ['Base32', base32Encode(utf8Encode(flag))],
    ['Base64', toBase64(utf8Encode(flag))],
    ['Binary', [...utf8Encode(flag)].map((b) => b.toString(2).padStart(8, '0')).join(' ')],
    ['Decimal character codes', [...utf8Encode(flag)].join(' ')],
    ['Octal character codes', [...utf8Encode(flag)].map((b) => b.toString(8)).join(' ')],
    ['URL escapes (%xx)', [...utf8Encode(flag)].map((b) => `%${b.toString(16)}`).join('')],
    ['HTML entities', [...flag].map((c) => `&#${c.charCodeAt(0)};`).join('')],
    [
      'Unicode escapes (\\u, \\x, U+)',
      [...flag].map((c) => `\\u00${c.charCodeAt(0).toString(16)}`).join(''),
    ],
  ])('%s of the whole text', (label, encoded) => {
    const { pass, analysis } = passOf(encoded, label);
    expect(pass.result).toBe(flag);
    expect(analysis.ranked[0]!.result).toBe(flag);
  });

  it('ranks a leet decoding, not the leet words in another order', () => {
    const a = analyze('th3 fl4g 1s h1dd3n 1n pl41n s1ght');
    expect(a.ranked[0]!.pass.label).toBe('Leet speak (1337 → leet)');
    // The leet words in another order read no better than as written: not ranked, or low.
    const reversed = a.ranked.find((s) => s.pass.label === 'Words in reverse order');
    expect(reversed?.score ?? 0).toBeLessThan(STRONG);
  });

  it('reads Morse, leet, Braille, Polybius and Bacon', () => {
    expect(passOf(morseEncode('meet me at noon').text, 'Morse').pass.result).toBe(
      'MEET ME AT NOON',
    );
    expect(passOf('th3 fl4g 1s h1dd3n h3r3', 'Leet speak (1337 → leet)').pass.result).toBe(
      'the flag is hidden here',
    );
    expect(brailleDecode('⠓⠑⠇⠇⠕ ⠼⠁⠃')).toBe('hello 12');
    expect(passOf('23 15 31 31 34', 'Polybius square (digit pairs 11-55)').pass.result).toBe(
      'HELLO',
    );
    const bacon = 'AABBB AABAA ABABA ABABA ABBAB';
    expect(passOf(bacon, 'Bacon (text made of two symbols)').pass.result).toBe('HELLO');
  });

  it('reads Base58, Ascii85, A1Z26 and tap code', () => {
    expect(passOf(base58Encode(utf8Encode('flag{b58}')), 'Base58').pass.result).toBe('flag{b58}');
    const a85 = base85Encode(utf8Encode('flag{a85}'), 'ascii85');
    expect(passOf(a85, 'Base85 (Ascii85)').pass.result).toBe('flag{a85}');
    const a1z26 = passOf('6 12 1 7 / 9 19 / 8 5 18 5', 'Letter numbers (A1Z26)');
    expect(a1z26.pass.result).toBe('flag is here');
    expect(a1z26.analysis.ranked[0]!.result).toBe('flag is here');
    expect(() => a1z26Decode('6 27')).toThrow(ToolError);
    const tap = polybiusEncode('meet at noon', 'tap', '', 'dots', true).text;
    expect(passOf(tap, 'Tap code (groups of dots)').pass.result).toBe('MEET AT NOON');
  });

  it('reads Braille through the analyzer', () => {
    const top = analyze('⠓⠑⠇⠇⠕ ⠺⠕⠗⠇⠙').ranked[0]!;
    expect(top.pass.label).toBe('Braille');
    expect(top.result).toBe('hello world');
  });

  it('finds Morse, decimal codes and letter numbers inside prose', () => {
    const morse = `The signal was ${morseEncode('meet at noon').text} and then silence.`;
    const m = analyze(morse).ranked[0]!;
    expect(m.pass.label).toMatch(/^Morse inside the text/);
    expect(m.result).toBe('MEET AT NOON');
    const codes = `The numbers ${[...utf8Encode('flag{dec}')].join(' ')} were on the wall.`;
    expect(analyze(codes).ranked[0]!.result).toBe('flag{dec}');
    const numbers = passOf(
      'Remember 6-12-1-7 tonight.',
      'Letter numbers inside the text: “6-12-1-7”',
    );
    expect(numbers.pass.result).toBe('flag');
  });

  it('does not read timestamps, UUIDs or hex ids as leet speak', () => {
    expect(deleet('2024-03-11T08:15:02Z id 9a47 req c4d1e9b3')).toBe(
      '2024-03-11T08:15:02Z id 9a47 req c4d1e9b3',
    );
    expect(deleet('th3 fl4g 1s h1dd3n')).toBe('the flag is hidden');
  });

  it('stays linear on regex traps (bytes or bits followed by a stray character)', () => {
    for (const text of [
      `${'01001000 '.repeat(40)}.`,
      `${'01001000'.repeat(32)}.`,
      `${'7'.repeat(200)}x`,
      `${'%41'.repeat(30_000)}x`,
      'a'.repeat(100_000),
    ]) {
      const t0 = performance.now();
      run(text);
      expect(performance.now() - t0, text.slice(0, 20)).toBeLessThan(2000 * SLACK);
    }
    expect(passOf(`${'01001000 '.repeat(40)}.`, 'Octal character codes').pass.result).toBeNull();
  });

  it('finds an encoded token inside prose', () => {
    const blob = toBase64(utf8Encode('flag{inline_blob}'));
    const text = `Hello, the backup code is ${blob} so keep it safe.`;
    const top = analyze(text).ranked[0]!;
    expect(top.result).toBe('flag{inline_blob}');
    expect(top.pass.label).toMatch(/^Base64 inside the text/);
    const hex = `Packet dump: ${toHex(utf8Encode('secret key'))} end of dump.`;
    expect(analyze(hex).ranked.some((s) => s.result === 'secret key')).toBe(true);
  });

  it('peels several layers with the auto-decoder', () => {
    const layered = toBase64(utf8Encode(toHex(utf8Encode('flag{two_layers}'))));
    const { pass } = passOf(layered, 'Auto-decode (several layers)');
    expect(pass.result).toBe('flag{two_layers}');
    expect(pass.note).toBe('base64 → hex');
  });
});

describe('classical ciphers', () => {
  const french = 'Rendez-vous demain soir à la gare, devant le grand panneau des départs.';

  it('brute-forces Caesar in French and ROT13 / ROT47 / Atbash', () => {
    const { pass } = passOf(rotate(french, 3, 'letters'), 'Caesar (best of 25 shifts)');
    expect(pass.result).toBe(french);
    expect(pass.note).toContain('undoes a key of 3');
    expect(analyze('synt{ebg13_vf_abg_rapelcgvba}').ranked[0]!.result).toBe(
      'flag{rot13_is_not_encryption}',
    );
    expect(passOf(rotate('flag{rot_47}', 47, 'rot47'), 'ROT47').pass.result).toBe('flag{rot_47}');
    expect(passOf(atbash(PROSE_A), 'Atbash').scored!.score).toBeGreaterThanOrEqual(STRONG);
  });

  it('cracks Vigenère, affine and rail fence', () => {
    const vig = vigenereTransform(PROSE_A, [11, 4, 12, 14, 13], 'vigenere', false);
    const v = passOf(vig, 'Vigenère (key cracked)');
    expect(v.pass.result).toBe(PROSE_A);
    expect(v.pass.note).toContain('key LEMON');
    expect(passOf(affineEncrypt(PROSE_B, 5, 8), 'Affine (best of 312 keys)').pass.result).toBe(
      PROSE_B,
    );
    const fence = 'meet me at the old mill after dark and bring the map';
    expect(passOf(railFenceEncrypt(fence, 3), 'Rail fence (2-10 rails)').pass.result).toBe(fence);
  });

  it('solves a substitution only when the text is not readable', () => {
    const rng = makeRng(7);
    const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    for (let i = 25; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [letters[i], letters[j]] = [letters[j]!, letters[i]!];
    }
    const cipher = substitutionApply(
      PROSE_B,
      parseSubstitutionKey(letters.join('')),
      'encrypt',
    ).text;
    const { scored } = passOf(cipher, 'Substitution (solved, English)');
    expect(scored!.score).toBeGreaterThanOrEqual(STRONG);
    expect(passOf(PROSE_B, 'Substitution (solved, English)').pass.note).toMatch(/already readable/);
  });

  it('does not shuffle an acrostic that already reads well into other words', () => {
    const english = TEXT_CASES.find((c) => c.name === 'English acrostic')!;
    const { pass } = passOf(english.text, 'Ciphers on “First letter of each line”');
    expect(pass.result).toBeNull();
    expect(pass.note).toMatch(/^No cipher reads better than the source/);
  });

  it('runs the ciphers on the acrostic too (a ROT13 acrostic)', () => {
    const lines = [...'zrrgngabba'].map((c, i) => `${c.toUpperCase()}${'abcdefghij'[i]} line ${i}`);
    const top = analyze(lines.join('\n')).ranked[0]!;
    expect(top.pass.label).toBe('Ciphers on “First letter of each line”');
    expect(top.reading).toBe('meet at noon');
  });
});

describe('statistics', () => {
  it('names non-ASCII characters', () => {
    expect(charName(0xe9)).toBe('LATIN SMALL LETTER E WITH ACUTE');
    expect(charName(0x2019)).toBe('RIGHT SINGLE QUOTATION MARK');
    expect(charName(0x200b)).toBe('ZERO WIDTH SPACE');
    expect(charName(0x0430)).toBe('CYRILLIC SMALL LETTER A');
    expect(charName(0x153)).toBe('LATIN SMALL LIGATURE OE');
  });

  it('finds repeated substrings and their spacing', () => {
    const r = repeats('abcXYZdefXYZghiXYZ');
    expect(r[0]).toEqual({ text: 'XYZ', positions: [4, 10, 16] });
    expect(spacing(r[0]!.positions)).toBe(6);
  });

  it('reports sizes, classes, IoC, entropy and language', () => {
    const out = resultToText(run(TEXT_CASES[0]!.text));
    expect(out).toContain('Characters: 96 (103 bytes in UTF-8)');
    expect(out).toContain('Language guess: French');
    expect(out).toMatch(/Index of coincidence: 0\.0\d+/);
    expect(out).toContain('LATIN SMALL LETTER E WITH ACUTE');
  });
});

describe('tool', () => {
  it('lists every pass of every family, applicable or not', () => {
    const out = run('just one line');
    const tables = out.filter((o) => o.type === 'table');
    expect(tables.map((t) => t.label)).toEqual(
      expect.arrayContaining([
        'Acrostics and regular picks',
        'Structured reading (line order, reversals, diagonals, columns)',
        'Invisible characters and marks',
        'Encodings',
        'Classical ciphers',
      ]),
    );
    const text = resultToText(out);
    expect(text).toContain('First word of each line\t—\t—\tNeeds at least 2 lines');
  });

  it('rejects empty input and a few blank lines, analyses a whitespace payload', () => {
    expect(() => run('')).toThrow(ToolError);
    expect(() => run('  \n ')).toThrow(ToolError);
    const snow = encodeSnow(COVER, 'hi', 120).replace(/[^ \t\n]/g, '');
    expect(snow.match(/[ \t]/g)!.length).toBeGreaterThan(16);
    expect(() => run(snow)).not.toThrow();
    expect(() => run('\ufeff'.repeat(50))).not.toThrow();
  });

  it('suggests itself for multi-line text, more so with invisible marks', () => {
    const detect = tool.detect!;
    expect(detect({ text: 'one line', bytes: new Uint8Array() })).toBeNull();
    expect(detect({ text: 'two\nlines', bytes: new Uint8Array() })?.score).toBe(0.3);
    const zw = embedPayload('hello there', encodePayload('x', 'binary').units, 'end');
    expect(detect({ text: zw, bytes: new Uint8Array() })?.score).toBe(0.6);
    expect(detect({ text: 'trailing \t\nspace', bytes: new Uint8Array() })?.score).toBe(0.6);
  });

  it('does not treat emoji joiners or Markdown line breaks as hidden marks', () => {
    const detect = tool.detect!;
    const tweet = ALL_CASES.find((c) => c.name.startsWith('Tweet with emojis'))!.text;
    expect(detect({ text: tweet, bytes: new Uint8Array() })).toBeNull();
    const markdown = ALL_CASES.find((c) => c.name.startsWith('Markdown hard breaks'))!.text;
    expect(detect({ text: markdown, bytes: new Uint8Array() })?.score).toBe(0.3);
    // The same joiner between two letters is a covert mark.
    expect(detect({ text: 'a\u200db c', bytes: new Uint8Array() })?.score).toBe(0.6);
  });

  it('caps long notes and says how many homoglyphs are not listed', () => {
    const bits = run('01'.repeat(5000));
    expectBounded(bits, 'bits');
    const flood = run(`x${'\u0430'.repeat(500)} and more`);
    expect(resultToText(flood)).toContain('300 more lookalike letters not listed');
  });
});

describe('round-2 verification fixes', () => {
  it('leaves out the capitals of words written in capitals (visible, not hidden)', () => {
    const { pass } = passOf(caseText('en-caps-warning'), 'Capital letters');
    expect(pass.result).toBeNull();
    expect(pass.note).toMatch(/words written in capitals/);
    const mixed = passOf('Some useful NOTES. Eat less meat. Take everything.', 'Capital letters');
    expect(mixed.pass.result).toBe('SET');
  });

  it('reads the first letter of each paragraph', () => {
    const { pass, analysis } = passOf(
      caseText('extra-paragraph-acrostic-en'),
      'First letter of each paragraph',
    );
    expect(pass.result).toBe('GONORTH');
    expect(analysis.ranked[0]!.reading).toBe('go north');
  });

  it('decodes phone keypad multi-tap and text typed with the wrong keyboard layout', () => {
    expect(multitapDecode('7777 33 66 3 0 44 33 555 7')).toBe('send help');
    expect(() => multitapDecode('22222')).toThrow(ToolError);
    const typed = 'rendew-vous q lq gqre de lyon q ;idi';
    expect(relayout(typed, 'QWERTY', 'AZERTY')).toBe('rendez-vous a la gare de lyon a midi');
    expect(relayout(relayout('hello world', 'QWERTY', 'Dvorak'), 'Dvorak', 'QWERTY')).toBe(
      'hello world',
    );
    // An ordinary text swapped reads worse: the pass does not rank it.
    const { scored } = passOf(PROSE_A, 'Keyboard layout swapped (AZERTY, Dvorak ↔ QWERTY)');
    expect(scored?.score ?? 0).toBe(0);
  });

  it('undoes leet words that become words, and never rewrites a flag', () => {
    expect(deleet('7h3 k3y 15 h1dd3n und3r 7h3 m47')).toBe('the key is hidden under the mat');
    expect(deleet('the flag is flag{1nv1s1bl3_1nk} 4nd n0t 0th3r')).toBe(
      'the flag is flag{1nv1s1bl3_1nk} and not other',
    );
    // Numbers stay numbers when the text is not written in leet.
    expect(deleet('Room 15 at 10h, see 2024-03-11T08:15:02Z')).toBe(
      'Room 15 at 10h, see 2024-03-11T08:15:02Z',
    );
    const napkin = passOf(caseText('leet-in-prose-en'), 'Leet speak (1337 → leet)');
    expect(napkin.pass.result).toBe('the password is monkey');
    for (const name of ['zero-width-binary-en', 'zero-width-tags-en', 'rot47-flag']) {
      const out = run(caseText(name));
      const flag = ALL_CASES.find((c) => c.name === name)!.expected!;
      expect(out[0], name).toEqual({
        type: 'note',
        level: 'success',
        text: expect.stringContaining(flag) as string,
      });
      expect((out[1] as { label: string }).label, name).not.toMatch(/reads/);
    }
  });

  it('reads homoglyph and letter-case bits carried by the letters that can carry them', () => {
    const fr = passOf(caseText('homoglyph-bits-fr'), 'Homoglyphs as bits (lookalike letter = 1)');
    expect(fr.pass.result).toBe('va au nord');
    expect(fr.pass.note).toMatch(/one bit per a\/c\/e\/o\/p letter/);
    const broad = passOf(
      caseText('variant-homoglyph-broad-set'),
      'Homoglyphs as bits (lookalike letter = 1)',
    );
    expect(broad.pass.result).toBe('va au nord');
    for (const name of [
      'case-bits-fr',
      'variant-case-bits-ascii',
      'variant-case-bits-accents-as-carriers',
    ]) {
      const { pass } = passOf(caseText(name), 'Letter case as bits (capital = 1)');
      expect(pass.result, name).toBe('flag{caps}');
    }
  });

  it('cracks a French Vigenère with French letter frequencies', () => {
    const { pass } = passOf(caseText('vigenere-fr'), 'Vigenère (key cracked)');
    expect(pass.note).toContain('key CORBEAU');
    expect(pass.result).toMatch(/^Les documents sont caches dans le coffre/);
  });

  it('judges line orders against the text as written', () => {
    // Short lines between long ones, or between junk: a message. Two languages: not one.
    expect(analyze(caseText('odd-lines-en')).ranked[0]!.pass.label).toBe('Odd lines (1st, 3rd…)');
    expect(analyze(caseText('even-lines-fr')).ranked[0]!.pass.label).toBe('Even lines (2nd, 4th…)');
    const bilingual = passOf(caseText('bilingual-alternating-lines'), 'Odd lines (1st, 3rd…)');
    expect(bilingual.pass.evidence).toBe(0);
    expect(analyze(caseText('reverse-lines-fr')).ranked[0]!.pass.label).toBe(
      'Lines in reverse order',
    );
    // A poster stacked one word per line reads no better upside down.
    const poster = passOf(caseText('en-stacked-poster'), 'Lines in reverse order');
    expect(poster.scored?.score ?? 0).toBeLessThan(20);
  });

  it('drops cipher outputs that are the input with a few letters changed', () => {
    const a = analyze(caseText('last-word-lines-en'));
    // Real attempts read as gibberish and stay low; the near copy (key AAATAAAAA) is gone.
    expect(a.ranked.filter((s) => s.pass.family === 'cipher' && s.score >= 10)).toEqual([]);
    const text = resultToText(run(caseText('last-word-lines-en')));
    expect(text).not.toContain('The toon above');
  });

  it('knows the marks that belong to a script, an emoji or French typography', () => {
    const hindi = passOf(caseText('hindi-zwj'), 'Letters carrying a stray combining mark');
    expect(hindi.pass.result).toBeNull();
    const persian = passOf(caseText('persian-zwnj'), 'Zero-width and invisible characters');
    expect(persian.pass.note).toMatch(/where they belong/);
    const nbsp = passOf(
      caseText('fr-article-typography'),
      'Unusual spaces as bits (NBSP, thin, em…)',
    );
    expect(nbsp.pass.result).toBeNull();
    expect(nbsp.pass.note).toMatch(/French typography/);
    expect(findHomoglyphs(caseText('pl-tr-latin-letters'))).toEqual([]);
    expect(findHomoglyphs(caseText('fr-science-greek-symbols'))).toEqual([]);
    // A Greek letter inside a Latin word is still a lookalike.
    expect(findHomoglyphs('the p\u03b1ssword is here').map((h) => h.looksLike)).toEqual(['a']);
  });

  it('offers a weak best result as a block only when it reads at all', () => {
    const out = run('Hello world');
    expect(out[0]).toEqual({
      type: 'note',
      level: 'info',
      text: 'Nothing stands out; every pass is listed below',
    });
    expect(out[1]!.type).not.toBe('text');
  });
});
