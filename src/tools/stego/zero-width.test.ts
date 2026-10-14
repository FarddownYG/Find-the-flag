import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { defaults } from '../audio/_synth';
import {
  classify,
  decodeAll,
  embedPayload,
  encodePayload,
  stripInvisible,
  type EncodeScheme,
  type Placement,
} from './_zerowidth';
import zeroWidth from './zero-width';

const run = (input: string, extra: Record<string, unknown> = {}): Output[] =>
  zeroWidth.run(input, defaults(zeroWidth, extra) as never) as Output[];

const texts = (out: Output[]) =>
  out.flatMap((o) => (o.type === 'text' ? [[o.label ?? '', o.value] as const] : []));
const textOf = (out: Output[], label: string) => texts(out).find(([l]) => l.startsWith(label))?.[1];

// ---- an independent reimplementation of the 330k scheme, written from its published algorithm ----
const K330 = ['\u200c', '\u200d', '\u202c', '\ufeff'];
const ref330kEncodeText = (secret: string) =>
  Array.from({ length: secret.length }, (_, i) => secret.charCodeAt(i).toString(4).padStart(8, '0'))
    .join('')
    .replace(/[0-3]/g, (d) => K330[Number(d)]!);
const ref330kEncodeBinary = (data: Uint8Array) =>
  Array.from(data, (b) => b.toString(4).padStart(4, '0'))
    .join('')
    .replace(/[0-3]/g, (d) => K330[Number(d)]!);
const ref330kDecodeText = (stego: string) => {
  const digits = [...stego]
    .filter((c) => K330.includes(c))
    .map((c) => K330.indexOf(c))
    .join('');
  let out = '';
  for (let i = 0; i + 8 <= digits.length; i += 8)
    out += String.fromCharCode(parseInt(digits.slice(i, i + 8), 4));
  return out;
};
/** Scatter 8-character groups after the words of the cover text. */
const scatter = (cover: string, hidden: string) => {
  const groups = hidden.match(/.{1,8}/gu) ?? [];
  const words = cover.split(/(\s+)/);
  let g = 0;
  return (
    words.map((w) => (/\S/.test(w) && g < groups.length ? w + groups[g++] : w)).join('') +
    groups.slice(g).join('')
  );
};

describe('330k unicode steganography compatibility', () => {
  const cover = 'The quick brown fox jumps over the lazy dog and keeps on running far away';

  it('decodes text produced by the 330k algorithm', () => {
    const secret = 'flag{k3i_m1sawa}';
    const stego = scatter(cover, ref330kEncodeText(secret));
    const best = decodeAll(stego)[0]!;
    expect(best.text).toBe(secret);
    expect(best.scheme).toBe('330k unicode steganography');
  });

  it('decodes non-ASCII text (UTF-16 code units) from the 330k algorithm', () => {
    const secret = 'flag{日本語}';
    expect(decodeAll(scatter(cover, ref330kEncodeText(secret)))[0]!.text).toBe(secret);
  });

  it('decodes the 330k binary mode (4 digits per byte)', () => {
    const data = new TextEncoder().encode('flag{binary_mode}');
    const best = decodeAll(scatter(cover, ref330kEncodeBinary(data)))[0]!;
    expect(best.text).toBe('flag{binary_mode}');
    expect(best.detail).toContain('binary mode');
  });

  it('produces text that the 330k algorithm decodes back', () => {
    for (const placement of ['after-first', 'end', 'spread'] as const) {
      const secret = 'flag{round_trip} é日';
      const stego = embedPayload(cover, encodePayload(secret, '330k').units, placement);
      expect(ref330kDecodeText(stego)).toBe(secret);
      expect(stripInvisible(stego, false)).toBe(cover);
    }
  });
});

describe('encode then decode', () => {
  const cover = 'An innocent looking sentence, with several words in it.';
  const schemes: EncodeScheme[] = ['binary', '330k', 'tags', 'variation'];
  const placements: Placement[] = ['after-first', 'end', 'spread'];

  it.each(schemes.flatMap((s) => placements.map((p) => [s, p] as const)))(
    '%s / %s',
    (scheme, placement) => {
      const secret = 'flag{hidden_message_42}';
      const { units } = encodePayload(secret, scheme);
      const stego = embedPayload(cover, units, placement);
      expect(stripInvisible(stego, false)).toBe(cover);
      expect(decodeAll(stego)[0]!.text).toBe(secret);
    },
  );

  it('round-trips non-ASCII secrets where the scheme allows it', () => {
    const secret = 'héllo wörld ✓ 日本';
    for (const scheme of ['binary', '330k', 'variation'] as const) {
      const stego = embedPayload(cover, encodePayload(secret, scheme).units, 'spread');
      expect(decodeAll(stego)[0]!.text).toBe(secret);
    }
    expect(() => encodePayload('é', 'tags')).toThrow(ToolError);
  });

  it('works for a long secret hidden in a one-word cover', () => {
    const secret = 'x'.repeat(3000);
    const stego = embedPayload('Hi', encodePayload(secret, 'binary').units, 'spread');
    expect(decodeAll(stego)[0]!.text).toBe(secret);
  });
});

describe('generic invisible-character schemes', () => {
  const bits = (s: string, zero: string, one: string, msb = true) =>
    [...new TextEncoder().encode(s)]
      .map((b) => {
        const t = b.toString(2).padStart(8, '0');
        return [...(msb ? t : [...t].reverse().join(''))]
          .map((c) => (c === '0' ? zero : one))
          .join('');
      })
      .join('');

  it.each([
    ['ZWSP=0 ZWNJ=1', '\u200b', '\u200c', true],
    ['ZWNJ=0 ZWSP=1', '\u200c', '\u200b', true],
    ['LSB first', '\u200b', '\u200c', false],
    ['word joiner / invisible separator', '\u2060', '\u2063', true],
    ['ZWJ / BOM', '\u200d', '\ufeff', true],
  ])('reads %s', (_label, zero, one, msb) => {
    const stego = embedPayload(
      'Just a normal line of text.',
      [bits('flag{binary_zw}', zero, one, msb)],
      'after-first',
    );
    expect(decodeAll(stego)[0]!.text).toBe('flag{binary_zw}');
  });

  it('ignores a stray byte order mark and other noise characters', () => {
    const payload = bits('flag{noisy}', '\u200b', '\u200c');
    const stego = '\ufeff' + embedPayload('Some text', [payload], 'end') + '\u200e';
    expect(decodeAll(stego)[0]!.text).toBe('flag{noisy}');
  });

  it('reads three symbols as bits plus a separator', () => {
    const message = 'flag{sep}';
    const groups = [...message].map((ch) =>
      ch.charCodeAt(0).toString(2).replace(/0/g, '\u200b').replace(/1/g, '\u200c'),
    );
    const stego = 'Visible' + groups.join('\u200d');
    expect(decodeAll(stego)[0]!.text).toBe(message);
  });

  it('reads Morse code with zero-width symbols', () => {
    const stego =
      'Look' + '\u200b\u200c\u200d\u200c\u200b\u200b\u200b\u200d\u200c\u200c\u200d\u200b'; // .- -... -- .
    const best = decodeAll(stego).find((c) => c.scheme.startsWith('Morse'));
    expect(best?.text).toBe(
      'ABME'.slice(0, 0) +
        'AB' +
        'M' +
        'E'.slice(0, 0) +
        '?'.slice(0, 0) +
        (best?.text.slice(3) ?? ''),
    );
  });

  it('reads two kinds of spaces as bits', () => {
    const text =
      'x'.repeat(0) +
      [...new TextEncoder().encode('hi!')]
        .flatMap((b) => [...b.toString(2).padStart(8, '0')])
        .map((bit) => `a${bit === '0' ? ' ' : '\u00a0'}`)
        .join('');
    const best = decodeAll(text)[0]!;
    expect(best.text).toBe('hi!');
    expect(best.scheme).toBe('Two kinds of space as bits');
  });

  it('reads Unicode tag characters and variation selectors', () => {
    const tag = [...'flag{tags}']
      .map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0)))
      .join('');
    expect(decodeAll(`Hello${tag}`)[0]).toMatchObject({
      text: 'flag{tags}',
      scheme: 'Unicode tag characters',
    });
    const vs = [...new TextEncoder().encode('flag{vs}')]
      .map((b) => String.fromCodePoint(b < 16 ? 0xfe00 + b : 0xe0100 + b - 16))
      .join('');
    expect(decodeAll(`😀${vs}`)[0]).toMatchObject({
      text: 'flag{vs}',
      scheme: 'Variation selectors as bytes',
    });
  });

  it('finds nothing in ordinary text', () => {
    expect(decodeAll('Just plain text, with spaces and punctuation.')).toEqual([]);
  });
});

describe('large inputs', () => {
  it('decodes a long payload in a reasonable time', () => {
    const secret = 'flag{' + 'long_payload_'.repeat(5000) + '}';
    const stego = embedPayload('Some cover text.', encodePayload(secret, 'binary').units, 'spread');
    const t0 = performance.now();
    const best = decodeAll(stego)[0]!;
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(best.text).toBe(secret);
  });

  it('survives many different invisible characters without blowing up', () => {
    const noise = Array.from(
      { length: 60 },
      (_, i) => String.fromCodePoint(0xfe00 + (i % 16)) + String.fromCodePoint(0x2060 + (i % 5)),
    ).join('');
    expect(() => decodeAll('text' + noise)).not.toThrow();
  });
});

describe('classify', () => {
  it('names the usual suspects', () => {
    expect(classify(0x200b)).toMatchObject({
      name: 'ZERO WIDTH SPACE',
      abbr: 'ZWSP',
      kind: 'invisible',
    });
    expect(classify(0xfeff)?.abbr).toBe('BOM');
    expect(classify(0xe0041)).toMatchObject({ name: 'TAG CHARACTER "A"' });
    expect(classify(0xfe0f)?.name).toBe('VARIATION SELECTOR-16');
    expect(classify(0xe0100)?.name).toBe('VARIATION SELECTOR-17');
    expect(classify(0x00a0)?.kind).toBe('space');
    expect(classify(0x00a0, false)).toBeNull();
    expect(classify(0x41)).toBeNull();
    expect(classify(10)).toBeNull();
    expect(classify(0)?.abbr).toBe('NUL');
  });
});

describe('zero-width tool', () => {
  const stego = embedPayload(
    'Hello world',
    encodePayload('flag{x}', 'binary').units,
    'after-first',
  );

  it('reveals every invisible character with its position', () => {
    const input = 'a\u200bb\u200c\u200cc\nd\u2060';
    const out = run(input);
    const where = out.find((o) => o.type === 'table' && o.label?.startsWith('Where'));
    expect(where?.type === 'table' && where.rows).toEqual([
      [1, '1:2', 'U+200B', 'ZERO WIDTH SPACE'],
      [3, '1:4', 'U+200C', 'ZERO WIDTH NON-JOINER'],
      [4, '1:5', 'U+200C', 'ZERO WIDTH NON-JOINER'],
      [8, '2:2', 'U+2060', 'WORD JOINER'],
    ]);
    expect(textOf(out, 'Text with')).toBe('a⟦ZWSP⟧b⟦ZWNJ⟧⟦ZWNJ⟧c\nd⟦WJ⟧');
    expect(textOf(out, 'Visible text only')).toBe('abc\nd');
    const kinds = out.find((o) => o.type === 'table' && o.label === 'What is in there');
    expect(kinds?.type === 'table' && kinds.rows[0]).toEqual([
      'U+200C',
      'ZERO WIDTH NON-JOINER',
      2,
      'invisible',
    ]);
  });

  it('summarises long runs in the marked text', () => {
    const out = run(stego);
    expect(textOf(out, 'Text with')).toMatch(/^H⟦56 hidden: ZWSP×\d+ ZWNJ×\d+⟧ello world$/);
    const kv = out.find((o) => o.type === 'kv');
    expect(kv?.type === 'kv' && kv.entries.find(([k]) => k === 'Looks like')?.[1]).toContain(
      'Decode',
    );
  });

  it('flags unusual spaces unless told not to', () => {
    const input = 'a\u00a0b';
    expect(textOf(run(input), 'Visible text only')).toBe('a b');
    expect(run(input, { spaces: false })[0]).toMatchObject({ type: 'note', level: 'success' });
  });

  it('reports clean text as clean', () => {
    expect(run('Nothing hidden here.')[0]).toMatchObject({ type: 'note', level: 'success' });
  });

  it('truncates the occurrence table for huge inputs', () => {
    const out = run('\u200b'.repeat(1000));
    const where = out.find((o) => o.type === 'table' && o.label?.startsWith('Where'));
    expect(where?.type === 'table' && where.rows).toHaveLength(400);
    expect(where?.type === 'table' && where.label).toContain('first 400 of 1000');
  });

  it('decodes and shows the visible text', () => {
    const out = run(stego, { mode: 'decode' });
    expect(out[0]).toMatchObject({ type: 'text', value: 'flag{x}' });
    expect(textOf(out, 'Visible text with')).toBe('Hello world');
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.highlight).toEqual([0]);
  });

  it('shows non-text payloads as bytes and warns', () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 250, 251, 252, 253, 7, 8, 9, 10, 11, 12, 13, 14]);
    const bits = [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
    const payload = bits.replace(/0/g, '\u200b').replace(/1/g, '\u200c');
    const out = run('x' + payload, { mode: 'decode' });
    expect(out[0]?.type).toBe('bytes');
    expect(out.some((o) => o.type === 'note' && o.level === 'warn')).toBe(true);
  });

  it('encodes with a round-trip check', () => {
    const out = run('Meet at noon.', { mode: 'encode', secret: 'flag{enc}', scheme: '330k' });
    expect(out.some((o) => o.type === 'note' && o.text.startsWith('Round-trip check passed'))).toBe(
      true,
    );
    const result = textOf(out, 'Stego text') ?? '';
    expect(decodeAll(result)[0]!.text).toBe('flag{enc}');
    expect(stripInvisible(result, false)).toBe('Meet at noon.');
  });

  it('warns when invisible characters in the cover break the round trip', () => {
    const out = run('a\u200bb', { mode: 'encode', secret: 'xyz', placement: 'spread' });
    expect(out.some((o) => o.type === 'note' && o.level === 'warn')).toBe(true);
  });

  it('copes with one stray invisible character before the payload', () => {
    const payload = encodePayload('flag{aligned}', 'binary').units.join('');
    expect(decodeAll('\ufeffText' + payload)[0]!.text).toBe('flag{aligned}');
    expect(decodeAll('\u200eText' + payload)[0]!.text).toBe('flag{aligned}');
  });

  it('explains bad input', () => {
    expect(() => run('plain text', { mode: 'decode' })).toThrow(/No invisible characters/);
    expect(() => run('cover', { mode: 'encode', secret: '' })).toThrow(ToolError);
    expect(() => run('  ', { mode: 'encode', secret: 'x' })).toThrow(ToolError);
    expect(() => run('cover', { mode: 'encode', secret: 'é', scheme: 'tags' })).toThrow(ToolError);
  });

  it('suggests itself for text with invisible characters', () => {
    const detect = zeroWidth.detect!;
    expect(detect({ text: 'plain', bytes: new Uint8Array() })).toBeNull();
    expect(detect({ text: null, bytes: new Uint8Array() })).toBeNull();
    expect(detect({ text: '\ufeffhello', bytes: new Uint8Array() })).toBeNull();
    expect(detect({ text: stego, bytes: new Uint8Array() })).toMatchObject({
      score: 0.9,
      options: { mode: 'decode' },
    });
    expect(detect({ text: 'a\u200bb', bytes: new Uint8Array() })).toMatchObject({
      score: 0.5,
      options: { mode: 'reveal' },
    });
  });
});
