import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { defaultOptions } from '../../core/registry';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { toBase64, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import { base32Encode } from '../encoding/base32';
import {
  analyze,
  type Base,
  coverLine,
  encodeLine,
  followLayers,
  HIDDEN_BITS,
  hide,
  lineCapacity,
  looksLikeBaseN,
  PADDING_TYPES,
  roundTrips,
  tailString,
} from './_basen-padding';
import { buildSamples } from './_basen-padding-samples';
import basen from './basen-padding';

// ---------- helpers ----------

const bin = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
/** All the hidden bits of an analysis as a "0"/"1" string (whole bytes, then the leftover). */
const bitString = (text: string, base: 'auto' | Base = 'auto') => {
  const a = analyze(text, base);
  return bin(a.payload) + tailString(a);
};

type Opts = Parameters<typeof basen.run>[1];
const run = async (input: string, options: Partial<Opts> = {}): Promise<Output[]> =>
  basen.run(input, { ...defaultOptions(basen as never), ...options } as Opts);

const sample = (name: string) =>
  readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url), 'utf8');

const actionsOf = (out: Output[]) => out.flatMap((o) => (o.type === 'actions' ? o.actions : []));
const kvOf = (out: Output[], label: RegExp) => {
  const kv = out.find((o) => o.type === 'kv' && label.test(o.label ?? ''));
  return kv?.type === 'kv' ? Object.fromEntries(kv.entries) : {};
};

// ---------- the table ----------

describe('hidden bits per padding', () => {
  it('follows the table of unused bits', () => {
    expect(HIDDEN_BITS.base64).toEqual({ 0: 0, 1: 2, 2: 4 });
    expect(HIDDEN_BITS.base32).toEqual({ 0: 0, 1: 3, 3: 1, 4: 4, 6: 2 });
    expect(PADDING_TYPES).toHaveLength(8);
  });

  it('lineCapacity gives the table for every length, with the padding an encoder writes', () => {
    for (let len = 0; len <= 40; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
      const b64 = toBase64(bytes);
      expect(HIDDEN_BITS.base64[b64.length - b64.replace(/=+$/, '').length]).toBe(
        lineCapacity(len, 'base64'),
      );
      const b32 = base32Encode(bytes);
      expect(HIDDEN_BITS.base32[b32.length - b32.replace(/=+$/, '').length]).toBe(
        lineCapacity(len, 'base32'),
      );
    }
  });

  it('encodeLine without hidden bits is the ordinary base64 / base32', () => {
    for (let len = 0; len <= 30; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 91 + 5) & 0xff);
      expect(encodeLine(bytes, 'base64', 0, lineCapacity(len, 'base64'))).toBe(toBase64(bytes));
      expect(encodeLine(bytes, 'base32', 0, lineCapacity(len, 'base32'))).toBe(base32Encode(bytes));
    }
  });
});

describe('reading one line', () => {
  // [description, line, hidden bits, visible text]; the lines are worked out by hand: "AB" is
  // 01000001 01000010, so base64 reads 010000 010100 0010|xx and the last symbol holds 0010 + xx.
  const CASES: [string, string, string, string][] = [
    ['base64, no "="', 'QUJD', '', 'ABC'],
    ['base64, "=" with zeros (2 bits)', 'QUI=', '00', 'AB'],
    ['base64, "=" with 11', 'QUL=', '11', 'AB'],
    ['base64, "=" with 10', 'QUK=', '10', 'AB'],
    ['base64, "==" with zeros (4 bits)', 'QQ==', '0000', 'A'],
    ['base64, "==" with 1111', 'Qf==', '1111', 'A'],
    ['base32, no "="', 'IFBEGRCF', '', 'ABCDE'],
    ['base32, "======" with zeros (2 bits)', 'IE======', '00', 'A'],
    ['base32, "======" with 11', 'IH======', '11', 'A'],
    ['base32, "====" with zeros (4 bits)', 'IFBA====', '0000', 'AB'],
    ['base32, "====" with 1010', 'IFBK====', '1010', 'AB'],
    ['base32, "===" with 0 (1 bit)', 'IFBEG===', '0', 'ABC'],
    ['base32, "===" with 1', 'IFBEH===', '1', 'ABC'],
    ['base32, "=" with zeros (3 bits)', 'IFBEGRA=', '000', 'ABCD'],
    ['base32, "=" with 101', 'IFBEGRF=', '101', 'ABCD'],
  ];

  it.each(CASES)('%s', (_name, line, bits, visible) => {
    const a = analyze(line);
    expect(a.used).toBe(1);
    expect(a.bits).toBe(bits.length);
    expect(bitString(line)).toBe(bits);
    expect(utf8Decode(a.visible)).toBe(visible);
  });

  it('the same lines are what the encoder writes', () => {
    const enc = (text: string, base: Base, bits: string) =>
      encodeLine(utf8Encode(text), base, bits ? parseInt(bits, 2) : 0, bits.length);
    expect(enc('AB', 'base64', '11')).toBe('QUL=');
    expect(enc('A', 'base64', '1111')).toBe('Qf==');
    expect(enc('A', 'base32', '11')).toBe('IH======');
    expect(enc('AB', 'base32', '1010')).toBe('IFBK====');
    expect(enc('ABC', 'base32', '1')).toBe('IFBEH===');
    expect(enc('ABCD', 'base32', '101')).toBe('IFBEGRF=');
  });

  it('counts the lines by padding type', () => {
    const a = analyze(
      ['QUL=', 'Qf==', 'Qf==', 'IFBK====', 'IFBEG===', 'IFBEGRF=', 'IH======', 'IFBEGRCF'].join(
        '\n',
      ),
    );
    const count = (base: Base, pad: number) =>
      a.types.find((t) => t.base === base && t.pad === pad)?.lines;
    expect(count('base64', 0)).toBe(0);
    expect(count('base64', 1)).toBe(1);
    expect(count('base64', 2)).toBe(2);
    expect(count('base32', 0)).toBe(1);
    expect(count('base32', 1)).toBe(1);
    expect(count('base32', 3)).toBe(1);
    expect(count('base32', 4)).toBe(1);
    expect(count('base32', 6)).toBe(1);
    expect(a.carrying).toBe(7);
    expect(a.bits).toBe(2 + 4 + 4 + 4 + 1 + 3 + 2);
  });

  it('reads the URL-safe alphabet (- and _)', () => {
    // bytes fb ff: 111110 111111 1111xx -> "+/8=" (standard), "-_8=" (URL-safe)
    expect([...analyze('+/8=').visible]).toEqual([0xfb, 0xff]);
    expect([...analyze('-_8=').visible]).toEqual([0xfb, 0xff]);
    expect(bitString('-_8=')).toBe('00');
    expect(bitString('-__=')).toBe('11');
    expect(bitString('+//=')).toBe('11');
    expect(analyze('-__=').perBase.base64).toBe(1);
  });
});

describe('several lines', () => {
  it('concatenates the bits, most significant bit first', () => {
    // 1111 + 11 + 1111 = 10 bits: the byte ff and the leftover bits 11
    const a = analyze('Qf==\nQUL=\nQf==');
    expect(a.bits).toBe(10);
    expect([...a.payload]).toEqual([0xff]);
    expect(a.tailBits).toBe(2);
    expect(tailString(a)).toBe('11');
    expect(a.carrying).toBe(3);
  });

  it('keeps the order of the bits across byte boundaries', () => {
    // 1010 (IFBK====) + 0101 (QF== has 0101?) -> use the encoder for the exact bits
    const lines = [
      encodeLine(utf8Encode('A'), 'base64', 0b1010, 4),
      encodeLine(utf8Encode('A'), 'base64', 0b0101, 4),
      encodeLine(utf8Encode('A'), 'base64', 0b1100, 4),
      encodeLine(utf8Encode('A'), 'base64', 0b0011, 4),
    ];
    expect(bitString(lines.join('\n'))).toBe('1010010111000011');
    expect([...analyze(lines.join('\n')).payload]).toEqual([0xa5, 0xc3]);
  });

  it('shows the leftover bits that do not fill a byte', () => {
    const lines = [0b101, 0b001, 0b111].map((v) => encodeLine(utf8Encode('ABCD'), 'base32', v, 3));
    const a = analyze(lines.join('\n'));
    expect(a.bits).toBe(9);
    expect([...a.payload]).toEqual([0b10100111]);
    expect(a.tailBits).toBe(1);
    expect(tailString(a)).toBe('1');
    expect(bitString(lines.join('\n'))).toBe('101001111');
  });

  it('has no byte and only leftover bits under 8 bits', () => {
    const a = analyze('QUL=\nQUL=\nQUI=');
    expect(a.bits).toBe(6);
    expect(a.payload).toHaveLength(0);
    expect(tailString(a)).toBe('111100');
  });

  it('the ordinary decoding is the lines decoded one after the other', () => {
    const text = [toBase64(utf8Encode('flag{vis')), 'Qf==', toBase64(utf8Encode('ible}'))].join(
      '\n',
    );
    expect(utf8Decode(analyze(text).visible)).toBe('flag{visAible}');
  });

  it('tolerates CRLF, lone CR, surrounding spaces and blank lines', () => {
    const lf = 'Qf==\nQf==';
    for (const text of ['  Qf==  \r\n\tQf==\t\r\n\r\n', 'Qf==\rQf==\r', '\n\nQf==\n \n  Qf==  ']) {
      const a = analyze(text);
      expect(a.used).toBe(2);
      expect(a.skipped).toBe(0);
      expect([...a.payload]).toEqual([0xff]);
      expect(a.bits).toBe(analyze(lf).bits);
    }
    expect(analyze('Qf==\r\n\r\nQf==\r\n').blank).toBe(1);
  });

  it('counts and reports the lines that are neither base64 nor base32', () => {
    const text = [
      'hello world',
      'Qf==',
      '!!!!',
      '',
      'a',
      'Qf==',
      'x'.repeat(80) + '!',
      'QQ==',
    ].join('\n');
    const a = analyze(text);
    expect(a.used).toBe(3);
    expect(a.skipped).toBe(4);
    expect(a.lines).toBe(7);
    expect(a.blank).toBe(1);
    expect(a.skippedSamples.map((s) => s.line)).toEqual([1, 3, 5, 7]);
    expect(a.skippedSamples[0]!.text).toBe('hello world');
    expect(a.skippedSamples[3]!.text.endsWith('…')).toBe(true);
    expect(a.skippedSamples[3]!.text.length).toBeLessThan(70);
    expect(a.bits).toBe(12);
  });

  it('rejects padding that does not match the length', () => {
    for (const bad of ['QU=', 'Q===', 'QUJD=', 'IFBK==', 'IFBEG====', '====', '=', 'A']) {
      expect(analyze(bad).used).toBe(0);
    }
  });
});

describe('base64 or base32, line by line', () => {
  it('reads each line by its own alphabet and padding', () => {
    const a = analyze(['Qf==', 'IFBK====', 'QUL=', 'IFBEH==='].join('\n'));
    expect(a.perBase).toEqual({ base64: 2, base32: 2 });
    expect(bitString(['Qf==', 'IFBK====', 'IFBEH==='].join('\n'))).toBe('1111' + '1010' + '1');
  });

  it('a line both could be follows the unambiguous ones', () => {
    // "IFBEGRF=" is valid base64 and base32; "IFBK====" can only be base32
    expect(analyze('IFBK====\nIFBEGRF=').perBase).toEqual({ base64: 0, base32: 2 });
    expect(bitString('IFBK====\nIFBEGRF=')).toBe('1010101');
    // and next to base64-only lines it is base64 (2 bits, not 3)
    const mixed = analyze('Qf==\nQf==\nIFBEGRF=');
    expect(mixed.perBase).toEqual({ base64: 3, base32: 0 });
    expect(mixed.bits).toBe(4 + 4 + 2);
  });

  it('without a hint, capitals and 2-7 on a full line are base32', () => {
    expect(analyze('IFBEGRF=').perBase.base32).toBe(1);
    expect(analyze('MZXW6YTB').perBase.base32).toBe(1);
  });

  it('can be forced, and the lines of the other kind are skipped', () => {
    const text = 'Qf==\nIFBK====';
    expect(analyze(text, 'base64').used).toBe(1);
    expect(analyze(text, 'base64').skipped).toBe(1);
    expect(bitString(text, 'base32')).toBe('1010');
    expect(analyze('IFBEGRF=', 'base64').bits).toBe(2);
    expect(analyze('IFBEGRF=', 'base32').bits).toBe(3);
  });

  it('reads lower-case base32 and refuses mixed case', () => {
    expect(bitString('ifbk====')).toBe('1010');
    expect(analyze('IfBk====').used).toBe(0);
  });
});

// ---------- the encoder ----------

describe('hiding a message', () => {
  const secret = utf8Encode('HIDDEN_OK');
  const secretBits = bin(secret);

  it.each(['base64', 'base32'] as const)('round trip in %s padding', (base) => {
    const res = hide({ base, message: secret, cover: [], repeat: 1 });
    if (!res.ok) throw new Error('generated covers always fit');
    expect(res.lines).toBe(18);
    expect(res.capacity).toBe(72);
    expect(res.used).toBe(72);
    const a = analyze(res.text, base);
    expect(a.bits).toBe(72);
    expect(bin(a.payload)).toBe(secretBits);
    expect(a.tailBits).toBe(0);
    expect(utf8Decode(a.payload)).toBe('HIDDEN_OK');
    expect(analyze(res.text).bits).toBe(72); // auto-detection agrees
    expect(bitString(res.text)).toBe(secretBits);
    expect(roundTrips(res.text, base, secret)).toBe(true);
    // the visible decoding is the generated cover, a plain list
    expect(
      utf8Decode(a.visible)
        .split('\n')
        .slice(0, 2)
        .map((l) => l.trimEnd()),
    ).toEqual(['line 0001', 'line 0002']);
  });

  it('hides in your own cover lines and leaves the other bits at zero', () => {
    const cover = Array.from({ length: 30 }, () => 'Hello, world!'); // 13 bytes: 4 bits per line
    const res = hide({ base: 'base64', message: secret, cover, repeat: 1 });
    if (!res.ok) throw new Error('fits');
    expect(res.lines).toBe(30);
    expect(res.capacity).toBe(120);
    const a = analyze(res.text);
    expect(a.bits).toBe(120);
    expect(utf8Decode(a.payload.subarray(0, 9))).toBe('HIDDEN_OK');
    expect([...a.payload.subarray(9)].every((b) => b === 0)).toBe(true);
    expect(roundTrips(res.text, 'base64', secret)).toBe(true);
    expect(utf8Decode(a.visible)).toBe('Hello, world!'.repeat(30));
  });

  it('repeats the cover', () => {
    const res = hide({ base: 'base32', message: secret, cover: ['ab'], repeat: 18 }); // 2 bytes: 4 bits
    if (!res.ok) throw new Error('fits');
    expect(res.lines).toBe(18);
    expect(res.text.split('\n').every((l) => l.endsWith('===='))).toBe(true);
    expect(utf8Decode(analyze(res.text).payload)).toBe('HIDDEN_OK');
  });

  it('skips cover lines that carry nothing but keeps them', () => {
    const cover = ['abc', 'ab', 'abc', 'a', 'abcdef'];
    const res = hide({
      base: 'base64',
      message: Uint8Array.of(0xab),
      cover: cover.slice(),
      repeat: 5,
    });
    if (!res.ok) throw new Error('fits');
    expect(res.lines).toBe(25);
    expect(res.text.split('\n')[0]).toBe('YWJj'); // "abc" fills its symbols: nothing to hide
    expect(res.carrying).toBe(10);
    expect([...analyze(res.text).payload.subarray(0, 1)]).toEqual([0xab]);
  });

  it('says exactly how many bits are missing', () => {
    const cover = Array.from({ length: 20 }, () => 'ab'); // 2 bytes: 2 bits per base64 line
    const res = hide({ base: 'base64', message: secret, cover, repeat: 1 });
    expect(res).toMatchObject({
      ok: false,
      needed: 72,
      have: 40,
      lines: 20,
      perPass: 40,
      passes: 2,
    });
    const none = hide({ base: 'base64', message: secret, cover: ['abc'], repeat: 9 });
    expect(none).toMatchObject({ ok: false, have: 0, passes: 0 });
  });

  it('writes valid, standard lines', () => {
    const res = hide({ base: 'base64', message: secret, cover: ['é'], repeat: 40 });
    if (!res.ok) throw new Error('fits'); // "é" is 2 bytes in UTF-8
    expect(res.text.split('\n')[0]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(roundTrips(res.text, 'base64', secret)).toBe(true);
  });

  it('generated cover lines carry 4 bits in both encodings', () => {
    for (const base of ['base64', 'base32'] as const) {
      for (const i of [0, 8, 9998, 123456])
        expect(lineCapacity(coverLine(i, base).length, base)).toBe(4);
    }
  });
});

// ---------- layers ----------

describe('layers', () => {
  const layersText = sample('basen-padding-layers.txt');

  it('reads the base32 lines hidden in base64 lines, then the text hidden in those', () => {
    const chain = followLayers(layersText, 'auto', 3, 1);
    expect(chain.layers.map((l) => l.index)).toEqual([1, 2]);
    const [one, two] = chain.layers.map((l) => l.analysis) as [
      ReturnType<typeof analyze>,
      ReturnType<typeof analyze>,
    ];
    expect(one.perBase).toEqual({ base64: 998, base32: 0 });
    expect(one.bits).toBe(3992);
    expect(utf8Decode(one.visible).startsWith('line 0001\nline 0002\n')).toBe(true);
    expect(utf8Decode(one.payload).split('\n')).toHaveLength(20);
    expect(two.perBase).toEqual({ base64: 0, base32: 20 });
    expect(two.bits).toBe(80);
    expect(utf8Decode(two.payload)).toBe('LAYERED_OK');
    expect(chain.stop).toBe('notBase');
  });

  it('stops at the limit and starts again from a later layer', () => {
    const first = followLayers(layersText, 'auto', 1, 1);
    expect(first.layers).toHaveLength(1);
    expect(first.stop).toBe('limit');
    const second = followLayers(layersText, 'auto', 1, 2);
    expect(second.layers.map((l) => l.index)).toEqual([2]);
    expect(utf8Decode(second.layers[0]!.analysis.payload)).toBe('LAYERED_OK');
    expect(second.stop).toBe('notBase');
  });

  it('knows when there is no layer to start from', () => {
    const chain = followLayers(layersText, 'auto', 3, 5);
    expect(chain.emptyAt).toBeGreaterThan(0);
    expect(chain.layers).toHaveLength(0);
  });

  it('only follows payloads that look like padded base64 / base32 lines', () => {
    expect(looksLikeBaseN('LAYERED_OK', 'auto')).toBeNull(); // valid base64 symbols, no padding
    expect(looksLikeBaseN('Test', 'auto')).toBeNull();
    expect(looksLikeBaseN('flag{some text}', 'auto')).toBeNull();
    expect(looksLikeBaseN('Qf==\nQf==', 'auto')).not.toBeNull();
    expect(looksLikeBaseN('Qf==\nnot base', 'auto')).toBeNull(); // 50 % of the lines
    expect(looksLikeBaseN('Qf==\n\u0001\u0002', 'auto')).toBeNull();
  });

  it('three layers in a row', () => {
    const l3 = hide({ base: 'base32', message: utf8Encode('DEEP_OK'), cover: [], repeat: 1 });
    if (!l3.ok) throw new Error('fits');
    const l2 = hide({ base: 'base64', message: utf8Encode(l3.text), cover: [], repeat: 1 });
    if (!l2.ok) throw new Error('fits');
    const l1 = hide({ base: 'base32', message: utf8Encode(l2.text), cover: [], repeat: 1 });
    if (!l1.ok) throw new Error('fits');
    const chain = followLayers(l1.text, 'auto', 8, 1);
    expect(chain.layers.map((l) => l.analysis.perBase.base64 > 0)).toEqual([false, true, false]);
    expect(utf8Decode(chain.layers[2]!.analysis.payload)).toBe('DEEP_OK');
  });
});

// ---------- the tool ----------

describe('basen-padding tool', () => {
  it('shows the bits count, payload text, hex and the visible decoding of a base64 sample', async () => {
    const out = await run(sample('basen-padding-base64.txt'));
    const text = resultToText(out);
    expect(text).toContain('Layer 1: hidden payload (text)');
    expect(text).toContain('HIDDEN_OK');
    expect(text).toContain('48 49 44 44 45 4e 5f 4f 4b'); // HIDDEN_OK in hex
    expect(text).toContain('Layer 1: visible decoding (text)');
    expect(text).toContain('line 0001');
    const kv = kvOf(out, /summary/);
    expect(kv['Hidden bits']).toBe('72 bits from 18 lines');
    expect(kv['Hidden payload']).toBe('9 bytes');
    expect(kv['Leftover bits']).toBe('none');
    expect(kv['Read as']).toBe('base64 (18 lines)');
    expect(kv['Padded lines with non-zero bits']).toBe('18 of 18');
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows).toEqual([['base64', '==', 4, 18, 18, 72]]);
  });

  it('the same for a base32 sample', async () => {
    const out = await run(sample('basen-padding-base32.txt'));
    expect(resultToText(out)).toContain('HIDDEN_OK');
    expect(kvOf(out, /summary/)['Hidden bits']).toBe('72 bits from 18 lines');
    expect(kvOf(out, /summary/)['Read as']).toBe('base32 (18 lines)');
  });

  it('follows two layers by itself and says why it stops', async () => {
    const out = await run(sample('basen-padding-layers.txt'));
    const text = resultToText(out);
    expect(text).toContain('Layer 1: summary');
    expect(text).toContain('Layer 2: summary');
    expect(text).not.toContain('Layer 3');
    expect(kvOf(out, /Layer 1: summary/)['Hidden bits']).toBe('3992 bits from 998 lines');
    expect(kvOf(out, /Layer 2: summary/)['Read as']).toBe('base32 (20 lines)');
    expect(text).toContain('LAYERED_OK');
    expect(text).toContain(
      'Stopped after layer 2: its hidden payload is not base64 / base32 lines',
    );
    expect(text).toContain('EXIF / metadata'); // the cross-link to the file tools
  });

  it('1 level shows layer 1 only, with the one-click way to go on', async () => {
    const out = await run(sample('basen-padding-layers.txt'), { levels: 1 });
    const text = resultToText(out);
    expect(text).not.toContain('Layer 2');
    expect(text).toContain('Stopped at the limit of 1 layer');
    const again = actionsOf(out).find((a) => a.options.start === 2);
    expect(again?.label).toBe('Decode this payload again (layer 2)');
    expect(actionsOf(out).some((a) => a.options.levels === 8)).toBe(true);
    // pressing it: the payload of layer 1 is the input
    const next = await run(sample('basen-padding-layers.txt'), { levels: 1, ...again?.options });
    const nextText = resultToText(next);
    expect(nextText).toContain('Layer 2: hidden payload (text)');
    expect(nextText).toContain('LAYERED_OK');
    expect(nextText).toContain('Starting at layer 2: the input is the hidden payload of layer 1.');
    expect(actionsOf(next).some((a) => a.options.start === 1)).toBe(true);
    expect(actionsOf(next).some((a) => a.options.start === 3)).toBe(true);
  });

  it('errors clearly when there is no layer to start from', async () => {
    await expect(run('Qf==\nQf==', { start: 2 })).resolves.toBeDefined(); // 1 byte: layer 2 is "\xff"
    await expect(run('QQ==', { start: 2 })).rejects.toThrow(/no layer 2 to start from/);
  });

  it('reports skipped lines, leftover bits and ordinary padding', async () => {
    const out = await run('Qf==\nnot base64 at all\nQUL=\r\nQUL=\r\n');
    const text = resultToText(out);
    expect(text).toContain('1 line is neither base64 nor base32 and was skipped');
    expect(text).toContain('2: not base64 at all');
    const kv = kvOf(out, /summary/);
    expect(kv['Hidden bits']).toBe('8 bits from 3 lines');
    expect(kv['Lines']).toBe('3 read as base64 / base32, 1 skipped, 0 blank');
    const ordinary = await run(['QQ==', 'QUI=', 'QUJD'].join('\n'));
    expect(resultToText(ordinary)).toContain('are all 0');
    expect(kvOf(await run('Qf==\nQUL='), /summary/)['Leftover bits']).toBe(
      '111111 (6 bits, not enough for a byte)',
    );
    expect(resultToText(await run('QUJD'))).toContain('no padding bits to read');
  });

  it('forces the encoding when asked', async () => {
    const out = await run('Qf==\nIFBK====', { base: 'base32' });
    expect(kvOf(out, /summary/)['Hidden bits']).toBe('4 bits from 1 line');
    expect(resultToText(out)).toContain('1 line is neither');
  });

  it('is calm on empty and unusable input', async () => {
    expect(resultToText(await run('  \n'))).toContain('Paste base64 / base32 lines');
    expect(resultToText(await run('hello world'))).toContain('no base64 / base32 line found');
  });

  it('gives a binary visible decoding as bytes to download, and plain text as text only', async () => {
    const binary = Uint8Array.from({ length: 60 }, (_, i) => 0x80 + i);
    const lines = Array.from({ length: 20 }, (_, i) => toBase64(binary.subarray(i * 3, i * 3 + 3)));
    const out = await run([...lines, 'Qf=='].join('\n'));
    const labels = out.map((o) => ('label' in o ? o.label : '') ?? '');
    expect(labels).toContain('Layer 1: visible decoding (bytes)');
    expect(labels).not.toContain('Layer 1: visible decoding (text)');
    const bytes = out.find((o) => o.type === 'bytes' && /visible/.test(o.label ?? ''));
    expect(bytes?.type === 'bytes' && bytes.value.length).toBe(61);
    const plain = await run(sample('basen-padding-base64.txt'));
    const plainLabels = plain.map((o) => ('label' in o ? o.label : '') ?? '');
    expect(plainLabels).toContain('Layer 1: visible decoding (text)');
    expect(plainLabels).not.toContain('Layer 1: visible decoding (bytes)');
    expect(plainLabels).toContain('Layer 1: hidden payload (bytes)');
  });

  it('keeps big payloads bounded: a preview in the page, the whole thing in a file', async () => {
    const message = new Uint8Array(70_000).fill(0x41);
    const res = hide({ base: 'base64', message, cover: [], repeat: 1 });
    if (!res.ok) throw new Error('fits');
    const out = await run(res.text, { levels: 1 });
    const files = out.find((o) => o.type === 'files' && /hidden payload/.test(o.label ?? ''));
    expect(files?.type === 'files' && files.files[0]!.data.length).toBe(70_000);
    const textBlock = out.find((o) => o.type === 'text' && /payload \(text\)/.test(o.label ?? ''));
    expect(textBlock?.type === 'text' && textBlock.value.length).toBeLessThan(20_200);
    const hex = out.find((o) => o.type === 'text' && /payload \(hex\)/.test(o.label ?? ''));
    expect(hex?.type === 'text' && hex.value.length).toBeLessThan(2000);
  });

  describe('hide mode', () => {
    it('hides the message and proves the round trip', async () => {
      const out = await run('Hello, world!', { mode: 'hide', message: 'HIDDEN_OK', repeat: 18 });
      const kv = kvOf(out, /Hidden message/);
      expect(kv['Encoding']).toBe('base64');
      expect(kv['Cover']).toBe('lines: 1 × 18 = 18');
      expect(kv['Capacity used']).toBe('72 of 72 bits (100 %)');
      expect(kv['Round trip']).toMatch(/^OK/);
      const lines = out.find((o) => o.type === 'text');
      expect(lines?.type === 'text' && lines.value.split('\n')).toHaveLength(18);
      // and the tool reads its own output
      const back = await run(lines?.type === 'text' ? lines.value : '');
      expect(resultToText(back)).toContain('HIDDEN_OK');
    });

    it('generates the cover on request (or when the input has no line) in base32', async () => {
      const out = await run('anything', {
        mode: 'hide',
        message: 'HIDDEN_OK',
        base: 'base32',
        generate: true,
      });
      expect(
        kvOf(await run('\n \n', { mode: 'hide', message: 'HI', base: 'base32' }), /Hidden/)[
          'Cover'
        ],
      ).toBe('4 generated lines');
      const kv = kvOf(out, /Hidden message/);
      expect(kv['Encoding']).toBe('base32');
      expect(kv['Cover']).toBe('18 generated lines');
      const lines = out.find((o) => o.type === 'text');
      expect(lines?.type === 'text' && lines.value).toMatch(/^[A-Z2-7]+====$/m);
      expect(resultToText(await run(sample('basen-padding-base32.txt')))).toContain('HIDDEN_OK');
    });

    it('notes the padding bits that stay unused', async () => {
      const out = await run('Hello, world!', { mode: 'hide', message: 'HI', repeat: 8 });
      expect(resultToText(out)).toContain('16 padding bits are left over and stay 0');
      expect(kvOf(out, /Hidden message/)['Capacity used']).toBe('16 of 32 bits (50 %)');
    });

    it('errors with the exact missing capacity', async () => {
      const cover = Array.from({ length: 20 }, () => 'ab').join('\n');
      const err = await run(cover, { mode: 'hide', message: 'HIDDEN_OK' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).message).toBe(
        'The message needs 72 bits but these 20 lines carry 40: add lines or use lines whose length is not a multiple of 3. Or set Repeat the cover to 2.',
      );
      const odd = Array.from({ length: 20 }, () => 'abc').join('\n'); // 3 bytes: 1 bit in base32
      const b32 = await run(odd, { mode: 'hide', message: 'HIDDEN_OK', base: 'base32' }).catch(
        (e: unknown) => e,
      );
      expect((b32 as ToolError).message).toContain('these 20 lines carry 20:');
      expect((b32 as ToolError).message).toContain('not a multiple of 5');
    });

    it('needs a message', async () => {
      await expect(run('x', { mode: 'hide', message: '' })).rejects.toThrow(/Type the message/);
    });
  });

  describe('detect', () => {
    const detect = basen.detect!;
    const sampleOf = (text: string) => ({ text, bytes: utf8Encode(text) });

    it('suggests the tool for many padded lines with bits in the padding', () => {
      const d = detect(sampleOf(sample('basen-padding-base64.txt')));
      expect(d?.score).toBeGreaterThanOrEqual(0.8);
      expect(d?.options).toEqual({ mode: 'extract' });
      expect(d?.reason).toBe('18 padded base64 / base32 lines');
      expect(detect(sampleOf(sample('basen-padding-base32.txt')))?.score).toBeGreaterThanOrEqual(
        0.8,
      );
      expect(detect(sampleOf(sample('basen-padding-layers.txt')))?.score).toBeGreaterThanOrEqual(
        0.8,
      );
    });

    it('is shy about ordinary padded lines and silent otherwise', () => {
      const ordinary = Array.from({ length: 12 }, (_, i) => (i % 2 ? 'QUI=' : 'QQ==')).join('\n');
      expect(detect(sampleOf(ordinary))?.score).toBeLessThan(0.4);
      expect(detect(sampleOf('Zm9vYmFy'.repeat(8)))).toBeNull();
      expect(
        detect(sampleOf('hello world, this is just a sentence of text.\nand another')),
      ).toBeNull();
      expect(detect({ text: null, bytes: new Uint8Array(10) })).toBeNull();
    });
  });
});

// ---------- samples, size ----------

describe('samples', () => {
  it('the sample files are what the encoder makes', () => {
    for (const [name, text] of Object.entries(buildSamples())) {
      expect(sample(name), name).toBe(text);
      expect(text.length).toBeLessThan(100 * 1024);
    }
  });

  it('tells apart what the samples hide', () => {
    expect(toHex(analyze(sample('basen-padding-base64.txt')).payload)).toBe(
      toHex(utf8Encode('HIDDEN_OK')),
    );
  });
});

describe('big inputs', () => {
  // Generous budgets: these take tens of milliseconds on a quiet machine.
  it('reads 20 000 lines within a budget', async () => {
    const message = utf8Encode('B'.repeat(10_000)); // 80 000 bits: 20 000 lines of 4 bits
    const t0 = performance.now();
    const res = hide({ base: 'base64', message, cover: [], repeat: 1 });
    if (!res.ok) throw new Error('fits');
    expect(res.lines).toBe(20_000);
    const out = await run(res.text);
    const ms = performance.now() - t0;
    const kv = kvOf(out, /Layer 1: summary/);
    expect(kv['Hidden bits']).toBe('80000 bits from 20000 lines');
    expect(kv['Hidden payload']).toBe('10000 bytes');
    expect(ms).toBeLessThan(3000);
  });

  it('reads several MB of lines, with and without padding bits, in linear time', () => {
    const cover = Array.from({ length: 400 }, (_, i) => `cover text cover text cover text ${i}`);
    const message = utf8Encode('M'.repeat(5_000)); // 40 000 bits
    const res = hide({ base: 'base64', message, cover, repeat: 250 });
    if (!res.ok) throw new Error(`does not fit: ${JSON.stringify(res)}`);
    const text = res.text;
    expect(text.length).toBeGreaterThan(4_000_000);
    const t0 = performance.now();
    const a = analyze(text);
    const small = performance.now() - t0;
    const t1 = performance.now();
    const b = analyze(`${text}\n${text}\n${text}\n${text}`);
    const big = performance.now() - t1;
    expect(a.used).toBe(100_000);
    expect(b.used).toBe(400_000);
    expect(a.bits).toBe(res.capacity);
    expect(utf8Decode(a.payload.subarray(0, 5_000))).toBe('M'.repeat(5_000));
    expect(small).toBeLessThan(3000);
    expect(big).toBeLessThan(10_000);
  });

  it('survives one huge line and a text of junk', () => {
    const line = 'A'.repeat(3_000_000) + '=';
    expect(analyze(line).used).toBe(0); // 3 000 000 symbols + "=": not a valid length
    const junk = 'hello world\n'.repeat(200_000);
    const t0 = performance.now();
    const a = analyze(junk);
    expect(a.skipped).toBe(200_000);
    expect(a.skippedSamples).toHaveLength(5);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
