import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { defaultOptions } from '../../core/registry';
import type { Output } from '../../core/types';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import {
  analyze,
  MAX_INPUT,
  textQuality,
  write,
  type InputChoice,
  type Separator,
} from './_base-convert';
import baseConvert from './base-convert';
import binary, { binaryEncode } from './binary';
import { charcodeEncode } from './charcode';
import hex, { hexEncode } from './hex';

type Options = Record<string, string>;
const run = (text: string, options: Options = {}): Output[] =>
  baseConvert.run(text, {
    ...defaultOptions(baseConvert as never),
    ...options,
  } as never) as Output[];

/** The value of the text block with this label. */
function block(out: Output[], label: string): string {
  const found = out.find((o) => o.type === 'text' && o.label === label);
  if (!found || found.type !== 'text') throw new Error(`no "${label}" block`);
  return found.value;
}
const BIN = 'Binary (8-bit groups)';

/** The decoded text block (a bytes block) of a codes reading. */
function decoded(out: Output[]): string {
  const found = out.find(
    (o) => o.type === 'bytes' || (o.type === 'text' && o.label === 'Decoded text'),
  );
  if (!found) throw new Error('no decoded block');
  return found.type === 'bytes'
    ? utf8Decode(found.value)
    : found.type === 'text'
      ? found.value
      : '';
}

const notes = (out: Output[]) =>
  out.flatMap((o) => (o.type === 'note' ? [`${o.level}: ${o.text}`] : []));
const best = (text: string, choice: InputChoice = 'auto', bits: 7 | 8 = 8) =>
  analyze(text, choice, bits).readings[0]!;

describe('text in every base', () => {
  const FLAG = 'FTF{octal}';

  it('writes the bytes of a text as binary, octal, decimal and hex', () => {
    const out = run(FLAG);
    expect(block(out, BIN)).toBe(
      '01000110 01010100 01000110 01111011 01101111 01100011 01110100 01100001 01101100 01111101',
    );
    expect(block(out, 'Octal')).toBe('106 124 106 173 157 143 164 141 154 175');
    expect(block(out, 'Decimal')).toBe('70 84 70 123 111 99 116 97 108 125');
    expect(block(out, 'Hex')).toBe('46 54 46 7b 6f 63 74 61 6c 7d');
  });

  it('matches the Binary, Hex and Char codes tools byte for byte', () => {
    const bytes = utf8Encode('Hé☃ flag{x}\n');
    const out = run('Hé☃ flag{x}\n\n');
    expect(block(out, BIN)).toBe(binaryEncode(bytes));
    expect(block(out, 'Hex')).toBe(hexEncode(bytes, 'space'));
    expect(block(out, 'Octal')).toBe(charcodeEncode('Hé☃ flag{x}\n', 'oct', 'space', 'utf8'));
    expect(block(out, 'Decimal')).toBe(charcodeEncode('Hé☃ flag{x}\n', 'dec', 'space', 'utf8'));
  });

  it('says how many characters and bytes, and warns about non-ASCII', () => {
    const out = run('é☃');
    const kv = out.find((o) => o.type === 'kv');
    expect(kv?.type === 'kv' ? kv.entries : []).toEqual([
      ['Characters', '2'],
      ['Bytes', '5'],
    ]);
    expect(notes(out).join('\n')).toMatch(/UTF-8 bytes/);
    expect(notes(run('ASCII only!'))).toEqual([]);
  });

  it('takes any text and every separator back to the same text', () => {
    const texts = [
      FLAG,
      'Hello, World!',
      'ça va ? 日本語 ☃',
      'line1\nline2\ttab',
      ' '.repeat(3) + 'x',
    ];
    const seps: Separator[] = ['space', 'comma', 'newline', 'none'];
    const bases = [
      ['Binary (8-bit groups)', '2'],
      ['Octal', '8'],
      ['Decimal', '10'],
      ['Hex', '16'],
    ] as const;
    for (const text of texts) {
      for (const separator of seps) {
        const out = run(text, { separator });
        for (const [label, choice] of bases) {
          const written = block(out, label);
          const back = best(written, choice);
          expect(back.text, `${JSON.stringify(text)} via ${label}, ${separator}`).toBe(text);
        }
      }
    }
  });

  it('round-trips in Auto too, whatever base it picks', () => {
    for (const text of [FLAG, 'The quick brown fox', 'flag{auto_mode_works}']) {
      for (const label of [BIN, 'Octal', 'Decimal', 'Hex']) {
        expect(decoded(run(block(run(text), label))), label).toBe(text);
      }
    }
  });

  it('refuses 7-bit groups for bytes above 127 and shows 8 bits instead', () => {
    const out = run('é', { width: '7' });
    expect(block(out, 'Binary (8-bit groups)')).toBe('11000011 10101001');
    expect(notes(out).join('\n')).toMatch(/above 127/);
    expect(block(run('Hi', { width: '7' }), 'Binary (7-bit groups)')).toBe('1001000 1101001');
  });

  it('honours the separator and the hex case', () => {
    expect(block(run('Hi', { separator: 'comma', hexCase: 'upper' }), 'Hex')).toBe('48,69');
    expect(block(run('flag', { hexCase: 'upper' }), 'Hex')).toBe('66 6C 61 67');
    expect(block(run('flag', { separator: 'newline' }), 'Octal')).toBe('146\n154\n141\n147');
    expect(block(run('Hi', { separator: 'none' }), BIN)).toBe('0100100001101001');
    expect(block(run('Hi\u0001', { separator: 'none' }), 'Decimal')).toBe('072105001');
  });
});

describe('a list of codes', () => {
  it('reads octal, decimal and hex flags and says which base', () => {
    const cases: [string, string, number][] = [
      ['106 124 106 173 157 143 164 141 154 175', 'FTF{octal}', 8],
      ['70 84 70 123 100 101 99 125', 'FTF{dec}', 10],
      ['46 54 46 7b 68 65 78 7d', 'FTF{hex}', 16],
      ['0x46 0x54 0x46 0x7b 0x68 0x65 0x78 0x7d', 'FTF{hex}', 16],
      ['\\x46\\x54\\x46\\x7b\\x68\\x65\\x78\\x7d', 'FTF{hex}', 16],
      ['0o106 0o124 0o106 0o173 0o157 0o175', 'FTF{o}', 8],
    ];
    for (const [input, text, radix] of cases) {
      const top = best(input);
      expect(top.kind, input).toBe('codes');
      expect(top.text, input).toBe(text);
      expect(top.radices, input).toContain(radix);
      expect(decoded(run(input)), input).toBe(text);
    }
  });

  it('reads FTF{octal} written in octal and in the other bases', () => {
    const flag = 'FTF{octal}';
    const octal = '106 124 106 173 157 143 164 141 154 175';
    expect(analyze(octal, 'auto', 8).confidence).toBe('high');
    expect(best(octal, '8').text).toBe(flag);
    // The same codes read as decimal or hex are not text: octal wins by a wide margin.
    const readings = analyze(octal, 'auto', 8).readings;
    expect(readings[0]!.score).toBeGreaterThan(60);
    expect(readings.slice(1).every((r) => r.score < 20)).toBe(true);
  });

  it('accepts any separator, mixed, or none at all', () => {
    const octal = 'FTF{octal}'.split('').map((c) => c.charCodeAt(0).toString(8).padStart(3, '0'));
    const mixed = [
      octal.join(' '),
      octal.join(','),
      octal.join(', '),
      octal.join('\n'),
      octal.join('\t'),
      octal.join(';'),
      octal.join(''),
      octal.map((o, i) => o + [' ', ',', ';', '\n', '\t'][i % 5]).join(''),
      `[${octal.join(', ')}]`,
      octal.map((o) => `\\${o}`).join(''),
    ];
    for (const input of mixed) {
      expect(best(input, '8').text, JSON.stringify(input)).toBe('FTF{octal}');
      expect(best(input).text, JSON.stringify(input)).toBe('FTF{octal}');
    }
    const hexBlob = 'FTF{hex}'
      .split('')
      .map((c) => c.charCodeAt(0).toString(16))
      .join('');
    expect(best(hexBlob).text).toBe('FTF{hex}');
    expect(best(`0x${hexBlob}`).text).toBe('FTF{hex}');
    expect(best(`b'${hexBlob}'`).text).toBe('FTF{hex}');
    const dec = 'FTF{dec}'
      .split('')
      .map((c) => String(c.charCodeAt(0)).padStart(3, '0'))
      .join('');
    expect(best(dec).text).toBe('FTF{dec}');
  });

  it('lists every reading that is valid, best first, when the digits are ambiguous', () => {
    const analysis = analyze('101 102 103', 'auto', 8);
    const byRadix = new Map(analysis.readings.map((r) => [r.radices.join(), r] as const));
    expect(byRadix.get('8')?.text).toBe('ABC');
    expect(byRadix.get('10')?.text).toBe('efg');
    expect(byRadix.get('16')?.kind).toBe('codes');
    expect(byRadix.get('16')?.values).toEqual([0x101n, 0x102n, 0x103n]);
    expect(analysis.confidence).toBe('low');
    // The two readings that spell letters come before the one with accented capitals.
    expect(analysis.readings[2]!.radices).toEqual([16]);

    const out = run('101 102 103');
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' ? table.rows.map((r) => r[1]) : []).toEqual(
      expect.arrayContaining(['ABC', 'efg']),
    );
    expect(notes(out).join('\n')).toMatch(/warn: Read as .* \(confidence: low\)/);
    expect(notes(out).join('\n')).toMatch(/Also valid: /);
  });

  it('ranks by readability, not by the order of the bases', () => {
    // 2 = hex FTF, but the same digits are also decimal and octal: the readable one first.
    expect(best('46 54 46').radices).toContain(16);
    expect(best('46 54 46').text).toBe('FTF');
    expect(best('106 124 106').text).toBe('FTF');
    expect(best('70 84 70').text).toBe('FTF');
    // Words beat symbols: 'hello' in octal is not read as the decimal gibberish.
    const hello = 'hello world'
      .split('')
      .map((c) => c.charCodeAt(0).toString(8))
      .join(' ');
    expect(best(hello).text).toBe('hello world');
    expect(best(hello).radices).toEqual([8]);
  });

  it('reads binary groups of 8 or 7 bits, spaced or not', () => {
    const t = 'FTF{bin}';
    const eight = binaryEncode(utf8Encode(t));
    const seven = binaryEncode(utf8Encode(t), 7);
    expect(best(eight).text).toBe(t);
    expect(best(eight).bits).toBe(8);
    expect(best(eight.replace(/ /g, '')).text).toBe(t);
    expect(best(seven).text).toBe(t);
    expect(best(seven).bits).toBe(7);
    expect(best(seven.replace(/ /g, ''), 'auto', 7).text).toBe(t);
    expect(best(seven.replace(/ /g, ''), 'auto', 7).bits).toBe(7);
    expect(best(seven.replace(/ /g, ''), 'auto', 8).text).toBe(t);
    // 56 bits cut by 7 or by 8 are two different texts: both are listed.
    const abc = binaryEncode(utf8Encode('abcdefg'), 8, '');
    const both = analyze(abc, 'auto', 8).readings.filter((r) => r.kind === 'codes');
    expect(both.map((r) => r.bits).sort()).toEqual([7, 8]);
    expect(both[0]!.text).toBe('abcdefg');
  });

  it('keeps the 7-bit choice for the output too', () => {
    const out = run(binaryEncode(utf8Encode('Hi'), 7), { width: '7' });
    expect(decoded(out)).toBe('Hi');
    expect(block(out, 'Binary (7-bit groups)')).toBe('1001000 1101001');
    expect(block(out, 'Hex')).toBe('48 69');
  });

  it('shows the other representations of the codes it read', () => {
    const out = run('106 124 106 173 157 143 164 141 154 175');
    expect(block(out, 'Decimal')).toBe('70 84 70 123 111 99 116 97 108 125');
    expect(block(out, 'Hex')).toBe('46 54 46 7b 6f 63 74 61 6c 7d');
    expect(block(out, BIN).split(' ')[0]).toBe('01000110');
    expect(notes(out)[0]).toBe('success: Read as Octal character codes (confidence: high).');
  });

  it('reads code points above 255 as characters and keeps them in full', () => {
    const out = run('70 84 70 9731 125');
    expect(decoded(out)).toBe('FTF☃}');
    expect(block(out, 'Hex')).toBe('46 54 46 2603 7d');
    expect(block(out, 'Octal')).toBe('106 124 106 23003 175');
    expect(block(out, 'Binary')).toBe('01000110 01010100 01000110 10011000000011 01111101');
    expect(run('U+0046 U+2603').length).toBeGreaterThan(0);
    expect(best('U+0046 U+2603').text).toBe('F☃');
  });

  it('says when the numbers are not text and still shows them', () => {
    const out = run('2024 10 16');
    expect(notes(out)[0]).toBe('warn: Read as Decimal numbers (confidence: low).');
    expect(block(out, 'Decimal')).toBe('2024 10 16');
    expect(block(out, 'Hex')).toBe('7e8 0a 10');
  });

  it('keeps plain words as text even when every letter is a hex digit', () => {
    expect(best('dead beef').kind).toBe('text');
    expect(best('ace add bad').kind).toBe('text');
    expect(best('hello world').kind).toBe('text');
    expect(analyze('FTF{octal}', 'auto', 8).codeLike).toBe(false);
  });

  it('a forced base reads only that base and explains a mismatch', () => {
    const forced = analyze('101 102 103', '16', 8).readings;
    expect(forced.every((r) => r.radices.join() === '16')).toBe(true);
    expect(forced.map((r) => r.kind)).toContain('codes');
    expect(() => analyze('98 99', '8', 8)).toThrow(ToolError);
    expect(() => analyze('98 99', '8', 8)).toThrow(/octal/);
    expect(() => analyze('hello', '2', 8)).toThrow(/"h"/);
    expect(() => analyze('xyz', '16', 8)).toThrow(ToolError);
    expect(analyze('hello', 'text', 8).readings[0]!.kind).toBe('text');
    expect(analyze('1010', 'text', 8).readings).toHaveLength(1);
  });

  it('refuses empty and oversized input', () => {
    expect(() => run('   \n')).toThrow(ToolError);
    expect(() => run('7'.repeat(MAX_INPUT + 1))).toThrow(/100000 this tool handles/);
    expect(() => run('')).toThrow(/Type or paste/);
  });
});

describe('a single number', () => {
  const bases = (n: bigint) => {
    const out = run(n.toString());
    return {
      binary: block(out, 'Binary'),
      octal: block(out, 'Octal'),
      decimal: block(out, 'Decimal'),
      hex: block(out, 'Hex'),
    };
  };

  it('writes a number in bases 2, 8, 10 and 16', () => {
    expect(bases(2989n)).toEqual({
      binary: '101110101101',
      octal: '5655',
      decimal: '2989',
      hex: 'bad',
    });
    expect(bases(0n)).toEqual({ binary: '0', octal: '0', decimal: '0', hex: '0' });
  });

  it('is exact for huge integers', () => {
    for (const n of [2n ** 64n, 2n ** 200n + 12345n, 10n ** 60n + 7n, 3n ** 300n]) {
      const got = bases(n);
      expect(got.binary).toBe(n.toString(2));
      expect(got.octal).toBe(n.toString(8));
      expect(got.decimal).toBe(n.toString());
      expect(got.hex).toBe(n.toString(16));
      expect(BigInt(`0b${got.binary}`)).toBe(n);
      expect(BigInt(`0o${got.octal}`)).toBe(n);
      expect(BigInt(`0x${got.hex}`)).toBe(n);
    }
  });

  it('reads 0x, 0b, 0o, signs and underscores', () => {
    expect(block(run('0xff'), 'Decimal')).toBe('255');
    expect(block(run('0b101010'), 'Decimal')).toBe('42');
    expect(block(run('0o777'), 'Decimal')).toBe('511');
    expect(block(run('-255'), 'Hex')).toBe('-ff');
    expect(block(run('1_000_000'), 'Hex')).toBe('f4240');
    expect(block(run('deadbeef'), 'Decimal')).toBe('3735928559');
    expect(block(run('0xDEADBEEF', { hexCase: 'upper' }), 'Hex')).toBe('DEADBEEF');
  });

  it('takes the input base when the digits fit several', () => {
    expect(block(run('101', { input: '2' }), 'Decimal')).toBe('5');
    expect(block(run('101', { input: '8' }), 'Decimal')).toBe('65');
    expect(block(run('101', { input: '10' }), 'Decimal')).toBe('101');
    expect(block(run('101', { input: '16' }), 'Decimal')).toBe('257');
    expect(best('101').radices).toEqual([10]);
    const all = analyze('101', 'auto', 8).readings.map((r) => [r.radices[0], r.values[0]]);
    expect(all).toEqual(
      expect.arrayContaining([
        [10, 101n],
        [16, 257n],
        [8, 65n],
        [2, 5n],
      ]),
    );
  });

  it('reads a long run of 0 and 1 as binary', () => {
    expect(best('10101010').radices).toEqual([2]);
    expect(best('10101010').values[0]).toBe(170n);
  });

  it('spells a number that is a text (long_to_bytes) and a code point', () => {
    const text = run('2511413510842060413510119088141712512283210298218286115709');
    expect(block(text, 'Number as bytes (big-endian)')).toBe('flag{rsa_small_e_attack}');
    const char = run('65');
    const kv = char.find((o) => o.type === 'kv');
    expect(kv?.type === 'kv' ? kv.entries : []).toEqual([
      ['Bits', '7'],
      ['Bytes', '1'],
      ['Character', 'A'],
    ]);
    // Nothing printable to spell: no text block.
    expect(
      run('1000000000').some(
        (o) => o.type === 'text' && o.label === 'Number as bytes (big-endian)',
      ),
    ).toBe(false);
  });

  it('points to Number / base converter for other bases and long_to_bytes', () => {
    const out = run('4096');
    const actions = out.find((o) => o.type === 'actions');
    expect(actions?.type === 'actions' ? actions.actions[0]!.open : null).toEqual({
      tool: 'number-base',
      text: '4096',
    });
  });

  it('keeps a blob that spells text as text, and a number as a number', () => {
    expect(best('666c61677b6865787d').kind).toBe('codes');
    expect(best('666c61677b6865787d').text).toBe('flag{hex}');
    expect(best('2024').kind).toBe('number');
    expect(best('123456').kind).toBe('number');
    expect(best('104101').kind).toBe('codes'); // 'he': ties with the number, listed with it
    expect(analyze('104101', 'auto', 8).confidence).toBe('low');
  });

  it('writes a list of numbers too large for characters', () => {
    const out = run('123456789012345678901234567890, 98765432109876543210');
    expect(block(out, 'Hex').split(' ')).toEqual([
      123456789012345678901234567890n.toString(16),
      98765432109876543210n.toString(16),
    ]);
    expect(out.some((o) => o.type === 'actions')).toBe(true);
  });
});

describe('write', () => {
  const o = { width: 8 as const, separator: 'space' as const, upper: false };

  it('pads bytes to 8, 3, 3 and 2 digits for none', () => {
    const w = write([1n, 255n], { ...o, separator: 'none' }, true);
    expect(w).toMatchObject({
      binary: '0000000111111111',
      octal: '001377',
      decimal: '001255',
      hex: '01ff',
    });
  });

  it('does not pad a lone number', () => {
    expect(write([5n], o, false)).toMatchObject({
      binary: '101',
      octal: '5',
      decimal: '5',
      hex: '5',
    });
    expect(write([-5n], o, false).binary).toBe('-101');
  });
});

describe('textQuality', () => {
  it('prefers clean ASCII and words to symbols and control characters', () => {
    const q = (s: string) => textQuality(s);
    expect(q('The flag is here')).toBeGreaterThan(q('FTF'));
    expect(q('FTF')).toBeGreaterThan(q('j|j'));
    expect(q('j|j')).toBeGreaterThan(q('\u0001\u0002\u0003'));
    expect(q('\u0001\u0002\u0003')).toBe(0);
    expect(q('')).toBe(0);
    expect(q('flag{ok}')).toBeGreaterThan(q('ĆĤĆų'));
  });
});

describe('triage', () => {
  const detect = (text: string) => baseConvert.detect!({ text, bytes: utf8Encode(text) });

  it('recognises a list of octal, decimal or hex codes and preselects the base', () => {
    const octal = detect('106 124 106 173 157 143 164 141 154 175');
    expect(octal?.options).toEqual({ input: '8' });
    expect(octal?.reason).toMatch(/Octal character codes/);
    expect(detect('70 84 70 123 100 101 99 125')?.options).toEqual({ input: '10' });
    expect(detect('46 54 46 7b 68 65 78 7d')?.options).toEqual({ input: '16' });
    expect(octal!.score).toBeGreaterThanOrEqual(0.25);
    expect(octal!.score).toBeLessThan(0.7);
  });

  it('does not steal plain text, single numbers or things that are not text', () => {
    for (const t of [
      'hello world',
      'FTF{octal}',
      'dead beef',
      '12345',
      '2511413510842060413510119088141712512283210298218286115709',
      '2024 10 16',
      '1 2 3 4 5 6',
      '',
      'ZmxhZ3t0cmlhZ2V9',
    ]) {
      expect(detect(t), JSON.stringify(t)).toBeNull();
    }
  });

  it('ranks below the Binary and Hex tools whenever they match', () => {
    const bits = binaryEncode(utf8Encode('FTF{triage}'));
    const hexed = hexEncode(utf8Encode('FTF{triage}'), 'space');
    for (const [sample, peer] of [
      [bits, binary],
      [hexed, hex],
      [hexEncode(utf8Encode('FTF{triage}'), 'none'), hex],
    ] as const) {
      const theirs = peer.detect!({ text: sample, bytes: utf8Encode(sample) });
      const ours = detect(sample);
      expect(theirs, sample).not.toBeNull();
      if (ours) expect(ours.score, sample).toBeLessThan(theirs!.score);
    }
  });

  it('is cheap on long input', () => {
    const long = Array.from({ length: 6000 }, (_, i) => String(65 + (i % 26))).join(' ');
    const t0 = performance.now();
    detect(long);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('big inputs', () => {
  it('reads a list of 24 000 codes in every base quickly', () => {
    const codes = Array.from({ length: 24_000 }, (_, i) => 97 + (i % 26));
    const octal = codes.map((c) => c.toString(8)).join(' ');
    const t0 = performance.now();
    const top = analyze(octal, 'auto', 8).readings[0]!;
    expect(top.radices).toEqual([8]);
    expect(top.text!.slice(0, 5)).toBe('abcde');
    expect(top.values).toHaveLength(24_000);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('analyses and writes 100 000 bytes without choking', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz0123456789 '.repeat(2800).slice(0, MAX_INPUT);
    const t0 = performance.now();
    const out = run(text);
    expect(block(out, 'Hex').length).toBe(MAX_INPUT * 3 - 1);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
