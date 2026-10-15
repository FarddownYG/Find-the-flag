import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { toHex, utf8Encode } from '../../lib/bytes';
import { defaults } from '../audio/_synth';
import { decodeAll, encodePayload, embedPayload } from './_zerowidth';
import {
  glyphReadings,
  hideInGlyphs,
  normalizeText,
  readReplaceable,
  substitutesOf,
} from './_unicode-hidden-glyph';
import { PAIRS, hideInInvisibles, readInvisibles } from './_unicode-hidden-invisible';
import { evidenceBits, isReadable } from './_unicode-hidden-read';
import { buildSamples } from './_unicode-hidden-samples';
import { imitates, scanText } from './_unicode-hidden-scan';
import { loadUnicodeData } from './_unicode-lookup';
import tool from './unicode-hidden';

const data = await loadUnicodeData();

const run = async (input: string, extra: Record<string, unknown> = {}): Promise<Output[]> =>
  tool.run(input, defaults(tool, extra) as never);
const flat = async (input: string, extra: Record<string, unknown> = {}) =>
  resultToText(await run(input, extra));
const textBlock = (out: Output[], label: string) => {
  const block = out.find((o) => o.type === 'text' && (o.label ?? '').startsWith(label));
  return block?.type === 'text' ? block.value : undefined;
};
const kv = (out: Output[], label: string, key: string) => {
  const block = out.find((o) => o.type === 'kv' && o.label === label);
  return block?.type === 'kv' ? block.entries.find(([k]) => k === key)?.[1] : undefined;
};
const table = (out: Output[], label: string) => {
  const block = out.find((o) => o.type === 'table' && (o.label ?? '').startsWith(label));
  return block?.type === 'table' ? block : undefined;
};

const FRENCH = `Il était une fois, dans un petit village du sud-ouest de la France, une boulangère très appréciée : Mme Éloïse Dupré. Chaque matin, dès 5 h 30, elle préparait des pains « à l’ancienne », des tartes aux pommes, des croissants au beurre et des pâtisseries dont l’odeur envahissait la rue. Les enfants, ravis, s’arrêtaient devant la vitrine avant d’aller à l’école ; les voisins, eux, discutaient de la récolte, du prix du blé (1 250 €/t) et de l’œuvre du curé. « Où est passé mon cœur ? » demandait parfois M. Ôtez en riant ; « Ça, c’est le mystère de l’été ! » répondait-elle. Naïve ou rusée ? Ni l’une ni l’autre : simplement généreuse – et très ponctuelle. À Noël, la maison sentait la cannelle, l’orange, le café… Superficie : 25 m² ; température : 18 °C ; 3 × 4 = 12 ; 50 % de remise ! Ÿ, ÿ, Æ, æ, Œ, œ, Ç, ç.`;
const COVER =
  'The quick brown fox jumps over the lazy dog while the sun slowly sets behind the old stone bridge near our village, and the farmers, tired after a long day in the fields, walk home along the river.';

describe('what is a message (not noise)', () => {
  it('counts the evidence for a reading', () => {
    expect(evidenceBits('SECRET42')).toBeGreaterThan(14);
    expect(evidenceBits('a\u0001b')).toBe(0);
    expect(evidenceBits('ab�')).toBe(0);
    // 7-bit characters are printable half of the time by chance: less evidence per character.
    expect(evidenceBits('SECRET42', 128)).toBeLessThan(evidenceBits('SECRET42', 256));
    expect(isReadable('SECRET42', 'generic')).toBe(true);
    expect(isReadable('V.WJmjWKf', 'generic', 128)).toBe(false);
    expect(isReadable('hi', 'generic')).toBe(false);
    expect(isReadable('hi', 'tags')).toBe(true);
    expect(isReadable('h', 'tags')).toBe(false);
  });
});

describe('invisible characters', () => {
  it('reveals the markers and extracts SECRET42 from zero-width binary', async () => {
    const stego = hideInInvisibles(
      'Hello team, nothing to see here.',
      'SECRET42',
      PAIRS['zwsp-zwnj']!,
      'after-first',
    ).text;
    const out = await run(stego);
    const text = resultToText(out);
    expect(textBlock(out, 'Text with the invisible')).toMatch(
      /^H⟨64 hidden: ZWSP×\d+ ZWNJ×\d+⟩ello team, nothing to see here\.$/,
    );
    expect(text).toContain('SECRET42');
    expect(textBlock(out, 'Hidden message')).toBe('SECRET42');
    expect(kv(out, 'Hidden message: hex, bits and size', 'Hex')).toBe('53 45 43 52 45 54 34 32');
    expect(kv(out, 'Hidden message: hex, bits and size', 'Hidden bits')).toBe('64');
    expect(kv(out, 'Hidden message: hex, bits and size', 'Bits')).toBe(
      '01010011 01000101 01000011 01010010 01000101 01010100 00110100 00110010',
    );
    // The carriers are listed with their positions and names.
    const where = table(out, 'Where they are');
    expect(where?.rows).toHaveLength(64);
    expect(where?.rows[0]).toEqual([
      1,
      '1:2',
      'U+200B',
      '⟨ZWSP⟩',
      'ZERO WIDTH SPACE',
      'Cf',
      'General Punctuation',
      'Invisible',
    ]);
    expect(textBlock(out, 'Visible text')).toBe('Hello team, nothing to see here.');
    expect(out.some((o) => o.type === 'note' && o.level === 'success')).toBe(true);
  });

  it('shows the markers of a few characters one by one, and the tag characters by name', async () => {
    const out = await run('a​b‌‍c⁠d﻿e\u{e0041}f');
    expect(textBlock(out, 'Text with the invisible')).toBe(
      'a⟨ZWSP⟩b⟨ZWNJ⟩⟨ZWJ⟩c⟨WJ⟩d⟨BOM⟩e⟨TAG A⟩f',
    );
  });

  it.each(Object.entries(PAIRS))('reads the binary pair %s', (_name, pair) => {
    const stego = hideInInvisibles('Some ordinary words here.', 'SECRET42', pair, 'spread').text;
    const analysis = readInvisibles(scanText(stego, data));
    expect(analysis.best?.text).toBe('SECRET42');
    expect(analysis.best?.readable).toBe(true);
  });

  it('reads every ordered pair of ZWSP, ZWNJ, ZWJ, BOM and the word joiner', () => {
    const symbols = [0x200b, 0x200c, 0x200d, 0xfeff, 0x2060];
    for (const a of symbols) {
      for (const b of symbols) {
        if (a === b) continue;
        const { units } = encodePayload('HIDDEN_OK', 'binary', [a, b]);
        const stego = embedPayload('A short cover sentence.', units, 'end');
        const best = readInvisibles(scanText(stego, data)).best;
        expect(best?.text, `${a.toString(16)} ${b.toString(16)}`).toBe('HIDDEN_OK');
      }
    }
  });

  it('reads a pair among stray symbols of other kinds (noise or separators)', () => {
    const { units } = encodePayload('SECRET42', 'binary', [0x2060, 0x200d]);
    // Three other invisible characters, more frequent than the word joiner or less: any pair may carry.
    const noisy = embedPayload('The cover text has some words in it.', units, 'end').replace(
      /e/g,
      'e​',
    );
    const analysis = readInvisibles(scanText(noisy, data));
    expect(analysis.best?.text).toBe('SECRET42');
    expect(analysis.distinct.size).toBe(3);
  });

  it('reads tag characters, framed by a language tag and a cancel tag', async () => {
    const stego = 'hello \u{e0001}\u{e0068}\u{e0069}\u{e007f}';
    const out = await run(stego);
    expect(textBlock(out, 'Hidden message')).toBe('hi');
    expect(textBlock(out, 'Text with the invisible')).toBe(
      'hello ⟨LANG TAG⟩⟨TAG h⟩⟨TAG i⟩⟨CANCEL TAG⟩',
    );
    const where = table(out, 'Where they are');
    expect(where?.rows.map((r) => r[2])).toEqual(['U+E0001', 'U+E0068', 'U+E0069', 'U+E007F']);
    expect(where?.rows[1]?.[4]).toBe('TAG LATIN SMALL LETTER H');
    expect(readInvisibles(scanText(stego, data)).best?.id).toBe('tags');
  });

  it('reads bytes hidden as variation selectors', () => {
    // 0x09 and 0x0a are VS10 and VS11 (U+FE09, U+FE0A); the other bytes are VS17.. (U+E0100..).
    const secret = 'ok\tsee\nme';
    const { units } = encodePayload(secret, 'variation');
    expect(units[2]).toBe('︉');
    const stego = embedPayload('Plain looking sentence', units, 'end');
    const best = readInvisibles(scanText(stego, data)).best;
    expect(best?.id).toBe('variation');
    expect(best?.text).toBe(secret);
  });

  it('reads the other schemes of the zero-width tool (330k)', () => {
    const stego = embedPayload(
      'Some text to carry it',
      encodePayload('flag{330k}', '330k').units,
      'spread',
    );
    expect(readInvisibles(scanText(stego, data)).best?.text).toBe('flag{330k}');
  });

  it('does not take the variation selector of an emoji for a payload', async () => {
    for (const text of ['I ❤️ you', '❤️❤️❤️', '1️⃣ 2️⃣']) {
      const scan = scanText(text, data);
      expect(scan.counts.invisible).toBe(0);
      const analysis = readInvisibles(scan);
      expect(analysis.carriers).toEqual([]);
      expect(analysis.best).toBeNull();
      const out = await run(text);
      // Still listed, with the reason why it is fine.
      expect(table(out, 'Where they are')?.rows.some((r) => r[2] === 'U+FE0F')).toBe(true);
      expect(resultToText(out)).toContain('In place: emoji sequence');
      expect(out.some((o) => o.type === 'note' && o.level === 'warn')).toBe(false);
    }
  });

  it('leaves the joiners of an emoji family, a flag, a leading BOM and a script alone', () => {
    const family = 'a \u{1f468}‍\u{1f469}‍\u{1f467} b';
    const england = 'x \u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f} y';
    for (const text of [family, england, '﻿hello', 'می‌خواهم', 'क्‍ष', 'שלום‏ עולם']) {
      const scan = scanText(text, data);
      expect(scan.counts.invisible, text).toBe(0);
      expect(readInvisibles(scan).best).toBeNull();
    }
  });

  it('reads a tag payload after the black flag when it is not a flag', () => {
    const text = `x \u{1f3f4}${[...'hello world!'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')}\u{e007f}`;
    expect(readInvisibles(scanText(text, data)).best?.text).toBe('hello world!');
  });

  it('keeps a no-break space where French puts one, flags it elsewhere', () => {
    const french = scanText('Quoi ? Vraiment ! 12 000 « bon »', data);
    expect(french.counts.space).toBe(0);
    expect(french.counts.inplace).toBe(3);
    const odd = scanText('foo bar', data);
    expect(odd.counts.space).toBe(1);
  });

  it('says plainly when nothing reads as text, and hands over the carriers', async () => {
    // A 6-bit packing of letters (A = 0 ... Z = 25) as ZWSP / ZWNJ: no known scheme reads it.
    const sixBit = [...'FLAGISHERE']
      .map((c) => (c.charCodeAt(0) - 65).toString(2).padStart(6, '0'))
      .join('')
      .replace(/0/g, '​')
      .replace(/1/g, '‌');
    const out = await run(`Some innocent text${sixBit} and more text.`);
    const text = resultToText(out);
    expect(readInvisibles(scanText(`x${sixBit}`, data)).best).toBeNull();
    expect(
      out.some(
        (o) =>
          o.type === 'note' &&
          o.level === 'warn' &&
          /no way of reading them gives text/.test(o.text),
      ),
    ).toBe(true);
    expect(text).not.toContain('Hidden message (');
    expect(text).toContain('Closest readings (weak: they may be chance)');
    // The carriers, in order, and the raw stream as 0/1.
    const listed = textBlock(out, 'Carrier code points');
    expect(listed?.split(' ')).toHaveLength(60);
    expect(listed?.startsWith('U+200B U+200B U+200B U+200B U+200B U+200B U+200B U+200B')).toBe(
      false,
    );
    const stream = textBlock(out, 'Raw symbol stream');
    expect(stream?.replace(/ /g, '')).toBe(
      [...'FLAGISHERE'].map((c) => (c.charCodeAt(0) - 65).toString(2).padStart(6, '0')).join(''),
    );
    expect(
      out.find((o) => o.type === 'text' && (o.label ?? '').startsWith('Raw symbol stream')),
    ).toMatchObject({
      label: 'Raw symbol stream (0 = U+200B ZWSP, 1 = U+200C ZWNJ)',
    });
  });

  it('does not claim a message from a few stray invisible characters', async () => {
    for (const text of [
      'a​b c​d e​f',
      'x​‌​‌‌​​‌​z',
      'one­two­three­four­five­six­seven­eight­nine',
    ]) {
      const analysis = readInvisibles(scanText(text, data));
      expect(analysis.best, text).toBeNull();
      const out = await run(text);
      expect(
        out.some(
          (o) =>
            o.type === 'note' && o.level === 'success' && /hidden in the invisible/.test(o.text),
        ),
      ).toBe(false);
    }
  });
});

describe('lookalike letters', () => {
  it('finds no lookalike and no invisible character in a French paragraph', async () => {
    const scan = scanText(FRENCH, data);
    expect(scan.counts.homoglyph).toBe(0);
    expect(scan.counts.invisible).toBe(0);
    expect(scan.counts.control).toBe(0);
    expect(scan.counts.space).toBe(0);
    expect(scan.mixedWords).toBe(0);
    expect(scan.counts.other).toBeGreaterThan(50);
    const out = await run(FRENCH);
    expect(resultToText(out)).toContain('Nothing hidden');
    expect(glyphReadings(scan, data)).toEqual([]);
    expect(readInvisibles(scan).carriers).toEqual([]);
    expect(kv(out, 'Summary', 'Lookalike letters (homoglyphs)')).toBe('0');
  });

  it('finds none in other ordinary texts either', () => {
    const texts = [
      'Привет, мир! Это обычный русский текст. Мы читаем и пишем по-русски.',
      'Η γρήγορη καφέ αλεπού. Le coefficient α = 0,05 est faible.',
      "Yarın ığdır'a gidiyorum, şimdi çalışıyorum. Işık ılık.",
      'これはＡＢＣテスト１２３です。中文文本 with English 한국어 텍스트',
      'Zażółć gęślą jaźń. Straße, Übergrößen, ñandú, å, ø, þ, ð, ł.',
      'Let x ∈ ℝ, f: ℕ → ℤ, ① ② ③, m² 1ᵉʳ 2ᵉ, ﬁnd the ﬂow, µg ± ° × ÷.',
      'مرحبا بالعالم‏ שלום עולם‏',
      'I ❤️ you, \u{1f468}‍\u{1f469}‍\u{1f467}.',
    ];
    for (const text of texts) {
      const scan = scanText(text, data);
      expect(scan.counts.homoglyph, text).toBe(0);
      expect(scan.counts.invisible, text).toBe(0);
    }
  });

  it('finds lookalikes in Latin words, whole words, fullwidth and mathematical forms', () => {
    const hits = (text: string) => scanText(text, data).hitIndex.map((i) => [...text][i]);
    expect(hits('visit pаypаl.com')).toEqual(['а', 'а']);
    expect(hits('The word аре is odd')).toEqual(['а', 'р', 'е']);
    expect(hits('Ｈｅｌｌｏ world')).toHaveLength(5);
    expect(hits('Say \u{1d407}\u{1d41e}\u{1d425}\u{1d425}\u{1d428}')).toHaveLength(5);
    expect(hits('COVIDС 19')).toEqual(['С']);
    // A word written in another script keeps its letters; a Greek letter alone is a symbol.
    expect(hits('Le mot « Привет » et α')).toEqual([]);
    expect(scanText('visit pаypаl.com', data).mixedWords).toBe(1);
  });

  it('finds exactly the letters a foreign encoder replaced, and reads the bits back', () => {
    const message = 'HELLO WORLD';
    const bits = [...utf8Encode(message)].map((b) => b.toString(2).padStart(8, '0')).join('');
    const map: Record<string, string> = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р' };
    const cover = `${'Peter explored a cave near the copper mine, then pocketed a pretty yellow pebble and expressed a happy opinion about every pony, apple and acorn they met; a cheerful crowd of explorers camped, chose a pace, and scooped up a cheap cocoa recipe. '.repeat(2)}`;
    let k = 0;
    const replaced: number[] = [];
    const result = [...cover]
      .map((ch, i) => {
        if (!(ch in map)) return ch;
        const bit = bits[k++] ?? '0';
        if (bit === '1') replaced.push(i);
        return bit === '1' ? map[ch]! : ch;
      })
      .join('');
    expect(k).toBeGreaterThan(bits.length);
    expect(new Set(replaced.map((i) => cover[i])).size).toBe(5);

    const scan = scanText(result, data);
    expect(scan.hitIndex).toEqual(replaced);
    expect(scan.hitLetter).toEqual(replaced.map((i) => cover[i]));
    expect(normalizeText(scan)).toBe(cover);
    const best = glyphReadings(scan, data).find((r) => r.readable);
    expect(best?.text).toBe(message);
    expect(best?.id).toBe('seen');
  });

  it('reads the replaced letters themselves, and the inverse polarity', () => {
    // The first letter of each word is swapped: the replaced letters spell "password".
    const swap: Record<string, string> = { p: 'р', a: 'а', s: 'ѕ', w: 'ѡ', o: 'о', r: 'г', d: 'ԁ' };
    const words = 'pens are so smart we often read daily'.split(' ');
    const marked = words.map((w) => swap[w[0]!]! + w.slice(1)).join(' ');
    const word = scanText(marked, data);
    expect(word.hitLetter.join('')).toBe('password');
    const best = glyphReadings(word, data)[0];
    expect(best?.id).toBe('letters');
    expect(best?.text).toBe('password');
    expect(best?.readable).toBe(true);
  });

  it('reads the opposite polarity (replaced = 0)', () => {
    // A foreign encoder that swaps a letter for a 0 bit and keeps it for a 1.
    const bits = [...utf8Encode('INVERSE OK')].map((b) => b.toString(2).padStart(8, '0')).join('');
    const { byLetter } = substitutesOf(data);
    let k = 0;
    const text = [...COVER]
      .map((ch) => {
        const sub = byLetter.get(ch);
        if (sub === undefined) return ch;
        const bit = bits[k++] ?? '1';
        return bit === '0' ? String.fromCodePoint(sub) : ch;
      })
      .join('');
    expect(k).toBeGreaterThan(bits.length);
    const readings = glyphReadings(scanText(text, data), data);
    const best = readings.find((r) => r.readable);
    expect(best?.text).toBe('INVERSE OK');
    expect(best?.inverse).toBe(true);
  });

  it('hides a message in lookalike letters and reads it back', async () => {
    const message = 'HIDDEN_OK';
    const hidden = hideInGlyphs(COVER, utf8Encode(message), data);
    if (!hidden.ok) throw new Error('too short');
    expect(hidden.bits).toBe(72);
    expect(hidden.capacity).toBeGreaterThanOrEqual(72);
    const scan = scanText(hidden.text, data);
    expect(normalizeText(scan)).toBe(COVER);
    expect(new TextDecoder().decode(readReplaceable(scan, data)!)).toBe(message);
    expect(glyphReadings(scan, data).find((r) => r.readable)?.text).toBe(message);
    // Every swap is a one-bit letter with a different code point.
    for (const i of scan.hitIndex) expect(scan.cps[i]!).toBeGreaterThan(0x7f);

    const out = await run(COVER, { mode: 'hide', method: 'homoglyph', secret: message });
    const text = resultToText(out);
    expect(text).toContain('Round trip: OK');
    expect(text).toMatch(/Capacity used: 72 of \d+ bits \(\d+ %\)/);
    expect(textBlock(out, 'Text with the message hidden')).toBe(hidden.text);
    // And the analysis of the result finds it.
    expect(await flat(hidden.text)).toContain('HIDDEN_OK');
  });

  it('round-trips many messages and covers', () => {
    const messages = ['a', 'Hi', 'flag{x}', 'é日本 ok', 'SECRET42', 'x'.repeat(10)];
    for (const message of messages) {
      const cover = `${COVER} ${COVER}`;
      const hidden = hideInGlyphs(cover, utf8Encode(message), data);
      if (!hidden.ok) throw new Error(`too short for ${message}`);
      const scan = scanText(hidden.text, data);
      const back = readReplaceable(scan, data);
      expect(new TextDecoder().decode(back!), message).toBe(message);
    }
  });

  it('every swappable letter has a substitute that reads back as that letter', () => {
    const { byLetter, replaceable } = substitutesOf(data);
    expect(replaceable.size).toBeGreaterThanOrEqual(40);
    for (const letter of 'acehiopsuxy') expect(replaceable.has(letter)).toBe(true);
    for (const [letter, cp] of byLetter) {
      expect(cp).toBeGreaterThan(0x7f);
      expect(imitates(data, data.category(cp), cp), letter).toBe(letter);
      // The substitute and the letter share a skeleton.
      expect(
        data.skeleton.get(cp)?.toLowerCase() ===
          (data.asciiSkeleton.get(letter) ?? letter).toLowerCase() ||
          data.skeleton.get(cp) === (data.asciiSkeleton.get(letter) ?? letter),
      ).toBe(true);
    }
    // Cyrillic first, then Greek.
    expect(byLetter.get('a')).toBe(0x430);
    expect(byLetter.get('u')).toBe(0x3c5);
    expect(byLetter.get('I')).toBe(0x406);
  });

  it('says exactly how many bits are missing when the cover is too short', async () => {
    const hidden = hideInGlyphs('Short cover.', utf8Encode('HIDDEN_OK'), data);
    expect(hidden).toEqual({ ok: false, needed: 72, have: 9 });
    await expect(
      run('Short cover.', { mode: 'hide', method: 'homoglyph', secret: 'HIDDEN_OK' }),
    ).rejects.toThrow(/needs 72 bits, the cover carries 9/);
    await expect(
      run('Short cover.', { mode: 'hide', method: 'homoglyph', secret: 'HIDDEN_OK' }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('replaces the lookalikes a cover already has before hiding', async () => {
    const cover = COVER.replace('quick', 'quіck');
    const out = await run(cover, { mode: 'hide', method: 'homoglyph', secret: 'OK!' });
    expect(resultToText(out)).toContain('The cover already had 1 lookalike letter');
    expect(resultToText(out)).toContain('Round trip: OK');
  });

  it('lists the swapped letters with name, code point and the letter they imitate', async () => {
    const out = await run('visit pаypаl.com');
    const rows = table(out, 'Lookalike letters')?.rows;
    expect(rows?.[0]).toEqual([
      7,
      '1:8',
      'а',
      'U+0430',
      'CYRILLIC SMALL LETTER A',
      'a',
      'Cyrillic',
    ]);
    expect(textBlock(out, 'Text with the lookalike')).toBe('visit p⟨а⟩yp⟨а⟩l.com');
    expect(textBlock(out, 'ASCII skeleton')).toBe('visit paypal.com');
    expect(kv(out, 'Summary', 'Words mixing scripts')).toBe('1');
    expect(kv(out, 'Summary', 'Lookalike letters (homoglyphs)')).toBe('2 (Cyrillic×2)');
  });

  it('says plainly when the pattern of swapped letters reads as nothing', async () => {
    const out = await run('visit pаypаl.com and онly then');
    expect(
      out.some(
        (o) => o.type === 'note' && o.level === 'warn' && /does not read as text/.test(o.text),
      ),
    ).toBe(true);
    expect(textBlock(out, 'Pattern of the letters')).toMatch(/^[01 ]+$/);
  });
});

describe('the tool', () => {
  it('hides a message in invisible characters and reads it back, with any pair and placement', async () => {
    for (const placement of ['after-first', 'end', 'spread']) {
      for (const pair of ['zwsp-zwnj', 'zwj-wj', 'wj-zwsp', 'zwnj-bom']) {
        const out = await run('Meet me at the usual place at noon.', {
          mode: 'hide',
          secret: 'SECRET42',
          pair,
          placement,
        });
        expect(resultToText(out), `${placement} ${pair}`).toContain('Round trip: OK');
        const stego = textBlock(out, 'Text with the message hidden')!;
        expect(readInvisibles(scanText(stego, data)).best?.text).toBe('SECRET42');
      }
    }
  });

  it('refuses an empty secret or cover with a sentence', async () => {
    await expect(run('cover', { mode: 'hide', secret: '' })).rejects.toThrow(/Secret message/);
    await expect(run('  ', { mode: 'hide', secret: 'x' })).rejects.toThrow(/cover text/);
    await expect(run('')).rejects.toThrow(/Paste a text/);
  });

  it('shows the bytes of a message that is not text', async () => {
    const payload = Uint8Array.from([0xff, 0xfe, 0xfd, 0xfc, 0x80, 0x81, 0x82, 0x83]);
    const out = await run(
      'x' +
        [...payload]
          .map((b) => b.toString(2).padStart(8, '0'))
          .join('')
          .replace(/0/g, '​')
          .replace(/1/g, '‌'),
    );
    expect(resultToText(out)).not.toContain('Hidden message (');
    expect(out.some((o) => o.type === 'note' && o.level === 'warn')).toBe(true);
  });

  it('is not fooled by a plain ASCII text', async () => {
    const out = await run('Just a plain sentence, with punctuation: nothing else!');
    expect(resultToText(out)).toContain('Nothing hidden');
    expect(table(out, 'Characters by code point')).toBeUndefined();
  });

  it('bounds the tables and previews of a big result', async () => {
    const out = await run('​‌'.repeat(500) + 'pаypаl '.repeat(600));
    expect(table(out, 'Where they are')?.rows).toHaveLength(400);
    expect(table(out, 'Where they are')?.label).toContain('first 400 of');
    expect(table(out, 'Lookalike letters')?.rows).toHaveLength(400);
    expect(table(out, 'Lookalike letters')?.label).toBe('Lookalike letters (first 400 of 1200)');
    const marked = textBlock(out, 'Text with the invisible')!;
    expect(marked.length).toBeLessThan(25_000);
  });

  it('suggests itself for invisible characters and for lookalike letters only', () => {
    const detect = tool.detect!;
    const sample = (text: string) => ({ text, bytes: utf8Encode(text) });
    expect(detect(sample(FRENCH))).toBeNull();
    expect(detect(sample('plain'))).toBeNull();
    expect(detect(sample('I ❤️ you'))).toBeNull();
    expect(detect(sample('﻿hello'))).toBeNull();
    const payload = detect(
      sample(hideInInvisibles('Hello there', 'SECRET42', PAIRS['zwsp-zwnj']!, 'end').text),
    );
    expect(payload?.score).toBeGreaterThanOrEqual(0.85);
    expect(payload?.score).toBeLessThanOrEqual(0.9);
    expect(payload?.reason).toContain('64 invisible characters');
    expect(detect(sample('a​b'))?.score).toBe(0.5);
    const tags = detect(sample('hi \u{e0001}\u{e0068}\u{e0069}\u{e007f}'));
    expect(tags?.score).toBeGreaterThanOrEqual(0.85);
    const mixed = detect(sample('visit pаypаl.com'));
    expect(mixed?.score).toBe(0.75);
    expect(mixed?.reason).toContain('1 word mixing Latin and Cyrillic');
    expect(detect(sample('Привет, мир'))).toBeNull();
  });

  it('keeps its samples in step with the encoders', async () => {
    const samples = buildSamples(data);
    for (const [name, text] of Object.entries(samples)) {
      const file = await readFile(
        new URL(`../../../public/samples/${name}`, import.meta.url),
        'utf8',
      );
      expect(file, name).toBe(text);
    }
    expect(Object.keys(samples)).toHaveLength(3);
    expect(await flat(samples['unicode-hidden-zerowidth.txt']!)).toContain('SECRET42');
    expect(await flat(samples['unicode-hidden-homoglyph.txt']!)).toContain('HIDDEN_OK');
    expect(await flat(samples['unicode-hidden-tags.txt']!)).toContain('TAGS_OK');
  });

  it('agrees with the zero-width tool on what it decodes', () => {
    const stego = hideInInvisibles(
      'Hello world',
      'flag{x}',
      PAIRS['zwsp-zwnj']!,
      'after-first',
    ).text;
    expect(decodeAll(stego)[0]?.text).toBe('flag{x}');
    expect(readInvisibles(scanText(stego, data)).best?.text).toBe('flag{x}');
    expect(toHex(utf8Encode('flag{x}'))).toBe('666c61677b787d');
  });
});

describe('big inputs', () => {
  const MB = 1_000_000;
  const repeat = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const timed = async (text: string) => {
    const t0 = performance.now();
    const out = await run(text);
    return { ms: performance.now() - t0, out };
  };

  it('analyses 1 MB of ordinary text in well under 2 s', async () => {
    const { ms, out } = await timed(repeat(FRENCH + '\n', MB));
    expect(ms).toBeLessThan(2000);
    expect(resultToText(out)).toContain('Nothing hidden');
  });

  it('analyses 1 MB of Cyrillic text in well under 2 s', async () => {
    const { ms } = await timed(
      repeat('Съешь же ещё этих мягких французских булок, да выпей чаю. ', MB),
    );
    expect(ms).toBeLessThan(2000);
  });

  it('analyses 1 MB with a lookalike letter every few words in well under 2 s', async () => {
    const swapped = repeat('The quick brown fox jumps over the lazy dog. ', MB).replace(
      /[aeo]/g,
      (c, i: number) => (i % 2 ? { a: 'а', e: 'е', o: 'о' }[c]! : c),
    );
    const { ms, out } = await timed(swapped);
    expect(ms).toBeLessThan(2000);
    expect(table(out, 'Lookalike letters')?.rows).toHaveLength(400);
  });

  it('analyses 1 MB of invisible characters in well under 2 s', async () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let text = 'x';
    for (let i = 0; i < MB; i++) text += rnd() < 0.5 ? '​' : '‌';
    const { ms, out } = await timed(text);
    expect(ms).toBeLessThan(2000);
    expect(resultToText(out)).toContain('Only the first 40000 invisible characters were read.');
  });
});
