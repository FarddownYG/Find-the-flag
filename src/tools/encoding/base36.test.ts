import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { fromHex, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import base36, {
  base26Decode,
  base26Encode,
  base36Decode,
  base36Encode,
  baseToNumber,
  excelDecode,
  excelEncode,
  numberToBase,
} from './base36';

/** JavaScript's own conversion: the bytes as one integer, without any leading zero. */
const viaBigInt = (hex: string, radix: number): string =>
  hex ? BigInt(`0x${hex}`).toString(radix) : '';

describe('base36 bytes', () => {
  it('agrees with BigInt#toString(36) for data without leading zero bytes', () => {
    let seed = 36;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8;
    for (const len of [1, 2, 3, 4, 5, 8, 16, 31, 32, 100]) {
      const data = Uint8Array.from({ length: len }, () => rnd() & 0xff);
      data[0] = (data[0]! | 1) & 0xff; // never a leading zero byte
      expect(base36Encode(data)).toBe(viaBigInt(toHex(data), 36));
      expect(toHex(base36Decode(viaBigInt(toHex(data), 36)))).toBe(toHex(data));
    }
  });

  it('known values', () => {
    expect(base36Encode(utf8Encode('hello'))).toBe('5pzcszu7');
    expect(utf8Decode(base36Decode('5pzcszu7'))).toBe('hello');
    expect(base36Encode(utf8Encode('flag{base36_bigint}'))).toBe('1okh233vdr1fz2nano6oob99ewq1z1');
    expect(base36Encode(Uint8Array.of(0xff))).toBe('73'); // 255 = 7*36 + 3
    expect(base36Encode(utf8Encode('hello'), true)).toBe('5PZCSZU7');
  });

  it('keeps leading zero bytes as leading zero digits, and the empty input', () => {
    const data = Uint8Array.of(0, 0, 1, 2, 3);
    expect(base36Encode(data)).toMatch(/^00/);
    expect(toHex(base36Decode(base36Encode(data)))).toBe('0000010203');
    expect(base36Encode(new Uint8Array())).toBe('');
    expect(base36Encode(new Uint8Array(3))).toBe('000');
    expect(toHex(base36Decode('000'))).toBe('000000');
  });

  it('round-trips random bytes with leading zeros in both cases', () => {
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8;
    for (let len = 0; len <= 60; len++) {
      const data = Uint8Array.from({ length: len }, () => rnd() & 0xff);
      if (len > 3) data[0] = data[1] = 0;
      const text = base36Encode(data);
      expect(toHex(base36Decode(text))).toBe(toHex(data));
      expect(toHex(base36Decode(text.toUpperCase()))).toBe(toHex(data));
    }
  });

  it('ignores whitespace and says where the first bad character is', () => {
    expect(utf8Decode(base36Decode('5pzc\n szu7'))).toBe('hello');
    expect(() => base36Decode('5pz-szu7')).toThrow(ToolError);
    expect(() => base36Decode('5pz-szu7')).toThrow(/Not Base36: "-" at position 4/);
  });
});

describe('base26 bytes', () => {
  /** a = 0 ... z = 25, written with plain BigInt arithmetic. */
  const naive = (hex: string): string => {
    let n = BigInt(`0x${hex}`);
    let out = '';
    while (n > 0n) {
      out = String.fromCharCode(97 + Number(n % 26n)) + out;
      n /= 26n;
    }
    return out;
  };

  it('agrees with a plain BigInt conversion', () => {
    for (const hex of ['68656c6c6f', '01', '1900', 'ffffffff', '666c61677b7d']) {
      expect(base26Encode(fromHex(hex))).toBe(naive(hex));
      expect(toHex(base26Decode(naive(hex)))).toBe(hex);
    }
    expect(base26Encode(utf8Encode('hello'))).toBe('cdvlxlttn');
  });

  it('round-trips random bytes and reads capitals', () => {
    let seed = 26;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8;
    for (let len = 0; len <= 40; len++) {
      const data = Uint8Array.from({ length: len }, () => rnd() & 0xff);
      const text = base26Encode(data);
      expect(toHex(base26Decode(text))).toBe(toHex(data));
      expect(toHex(base26Decode(text.toUpperCase()))).toBe(toHex(data));
    }
    expect(() => base26Decode('abc1')).toThrow(/Not Base26: "1" at position 4/);
  });
});

describe('numbers', () => {
  it('agrees with Number#toString(36) and parseInt(…, 36)', () => {
    for (const n of [0, 1, 35, 36, 1295, 1296, 2024, 123456789, 2 ** 40 + 7]) {
      expect(numberToBase(BigInt(n), '0123456789abcdefghijklmnopqrstuvwxyz')).toBe(n.toString(36));
      expect(baseToNumber(n.toString(36), '0123456789abcdefghijklmnopqrstuvwxyz', 'Base36')).toBe(
        BigInt(n),
      );
    }
  });

  it('handles integers beyond 2^53', () => {
    const big = 2n ** 130n + 12345n;
    const digits = numberToBase(big, '0123456789abcdefghijklmnopqrstuvwxyz');
    expect(digits).toBe(big.toString(36));
    expect(baseToNumber(digits, '0123456789abcdefghijklmnopqrstuvwxyz', 'Base36')).toBe(big);
  });

  it('spreadsheet column names (A = 1, Z = 26, AA = 27)', () => {
    const cases: [number, string][] = [
      [1, 'A'],
      [26, 'Z'],
      [27, 'AA'],
      [52, 'AZ'],
      [53, 'BA'],
      [702, 'ZZ'],
      [703, 'AAA'],
      [16384, 'XFD'], // the last column of a spreadsheet
    ];
    for (const [n, name] of cases) {
      expect(excelEncode(BigInt(n))).toBe(name);
      expect(excelDecode(name)).toBe(BigInt(n));
    }
    for (let n = 1; n <= 2000; n++) expect(excelDecode(excelEncode(BigInt(n)))).toBe(BigInt(n));
    expect(excelDecode('xfd')).toBe(16384n);
    expect(() => excelEncode(0n)).toThrow(/no zero/);
    expect(() => excelDecode('A1')).toThrow(/"1" at position 2 is not a letter A–Z/);
  });
});

describe('base36 tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    base36.run({ bytes: utf8Encode(text) }, {
      mode: 'decode',
      format: 'base36-bytes',
      upper: false,
      ...options,
    } as never) as Output[];

  it('decodes and encodes bytes', () => {
    expect(resultToText(run('5pzcszu7'))).toBe('hello');
    expect(resultToText(run('hello', { mode: 'encode', upper: true }))).toBe('5PZCSZU7');
    expect(resultToText(run('hello', { mode: 'encode', format: 'base26-bytes' }))).toBe(
      'cdvlxlttn',
    );
    expect(resultToText(run('cdvlxlttn', { format: 'base26-bytes' }))).toBe('hello');
  });

  it('says when leading zero digits became zero bytes', () => {
    expect(resultToText(run('0054'))).toContain('Leading 0 digits became zero bytes: 2');
  });

  it('numbers: a table and a line of values, in both directions', () => {
    const out = run('zz 1k8 10', { format: 'base36-numbers' });
    expect(out[0]).toEqual({ type: 'text', value: '1295 2024 36' });
    const table = out[1] as { rows: string[][] };
    expect(table.rows).toEqual([
      ['zz', '1295', '050f'],
      ['1k8', '2024', '07e8'],
      ['10', '36', '24'],
    ]);
    expect(
      resultToText(run('1295, 2024;36 0x10', { mode: 'encode', format: 'base36-numbers' })),
    ).toBe('zz 1k8 10 g');
    expect(
      resultToText(run('1295 2024', { mode: 'encode', format: 'base36-numbers', upper: true })),
    ).toBe('ZZ 1K8');
    expect(resultToText(run('ba z', { format: 'base26-numbers' }))).toContain('26 25');
  });

  it('spreadsheet columns, both ways', () => {
    expect(resultToText(run('A Z AA AZ XFD', { format: 'excel' }))).toContain('1 26 27 52 16384');
    expect(resultToText(run('1 26 27 52 16384', { mode: 'encode', format: 'excel' }))).toBe(
      'A Z AA AZ XFD',
    );
  });

  it('explains bad numbers with the token and its position', () => {
    expect(() => run('12 x1', { mode: 'encode', format: 'base36-numbers' })).toThrow(
      /"x1" at position 4/,
    );
    expect(() => run('-5', { mode: 'encode', format: 'base36-numbers' })).toThrow(
      /Negative numbers/,
    );
    expect(() => run('0', { mode: 'encode', format: 'excel' })).toThrow(/no zero/);
    expect(() => run('zz !!', { format: 'base36-numbers' })).toThrow(
      /"!" at position 4 is not a Base36 digit/,
    );
    expect(() => run('   ', { format: 'base36-numbers' })).toThrow(ToolError);
  });

  it('caps the table and says so', () => {
    const many = Array.from({ length: 250 }, (_, i) => i.toString(36)).join(' ');
    const out = run(many, { format: 'base36-numbers' });
    expect((out[1] as { rows: unknown[] }).rows).toHaveLength(200);
    expect(resultToText(out)).toContain('Showing the first 200 of 250');
  });

  it('detect: only text that decodes to something readable, not words', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(base36.detect!(sample('5pzcszu7'))?.score).toBe(0.6); // 5 readable bytes
    // 19 readable bytes: beats the generic 0.8 that Base64 gives to any such token
    expect(base36.detect!(sample('1okh233vdr1fz2nano6oob99ewq1z1'))?.score).toBeGreaterThan(0.8);
    expect(base36.detect!(sample('hello world'))).toBeNull();
    expect(base36.detect!(sample('internationalization'))).toBeNull();
    expect(base36.detect!(sample('1234567890'))).toBeNull();
  });
});
