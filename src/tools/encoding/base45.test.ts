import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { fromHex, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import base45, { base45Decode, base45DecodeText, base45Encode } from './base45';

// RFC 9285 section 4.3 (examples).
const RFC: [string, string][] = [
  ['AB', 'BB8'],
  ['Hello!!', '%69 VD92EX0'],
  ['base-45', 'UJCLQE7W581'],
  ['ietf!', 'QED8WEX0'],
];

// Made with the independent Python implementation (pip "base45" 0.4.4) from seeded random bytes.
const PYTHON: [string, string][] = [
  ['', ''],
  ['8b', '43'],
  ['d5f9', 'C2R'],
  ['83299b', '7QGK3'],
  ['ad0b25f7', 'J*L:Z4'],
  ['053a913c9f', 'XT0AGIO3'],
  ['1222458b4e6c', '7D2SZ86-9'],
  ['db26d0491d1058', 'WVR-EQFU3/1'],
  ['a480b6a330d22d0aa8a2c6821efcbf6b', '$ZK04NX76AV5FELD4PC-3/8O'],
  [
    'b34f087fffd9966bd4c5c249e92cc41f0e93a29a565d058f19cd3401b98ee8e066',
    '3UMF31MFWW0JJ+QCPOMLTWZO-$11PKE-ASV0ZB3%P6RKN JTC2',
  ],
  ['ffff', 'FGW'],
  ['ff', 'U5'],
];

describe('base45', () => {
  it.each(RFC)('RFC 9285 example %j', (text, b45) => {
    expect(base45Encode(utf8Encode(text))).toBe(b45);
    expect(utf8Decode(base45Decode(b45))).toBe(text);
  });

  it.each(PYTHON)('matches the Python reference for %s', (hex, b45) => {
    expect(base45Encode(fromHex(hex))).toBe(b45);
    expect(toHex(base45Decode(b45))).toBe(hex);
  });

  it('round-trips random binary of every length from 0 to 120', () => {
    let seed = 4505;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8;
    for (let len = 0; len <= 120; len++) {
      const data = Uint8Array.from({ length: len }, () => rnd() & 0xff);
      expect(toHex(base45Decode(base45Encode(data)))).toBe(toHex(data));
    }
  });

  it('keeps the space: it is the 37th digit, not padding', () => {
    expect(base45Encode(utf8Encode('He'))).toBe('%69');
    // "VD92EX0" inside the RFC example: the space is data
    expect(Array.from(base45Decode('%69 VD92EX0'))).toEqual(Array.from(utf8Encode('Hello!!')));
  });

  it('ignores line breaks but counts them in positions', () => {
    expect(utf8Decode(base45Decode('%69 V\r\nD92EX0'))).toBe('Hello!!');
    expect(() => base45Decode('%69\n~VD')).toThrow(/"~" at position 5/);
  });

  it('rejects characters outside the alphabet with their position', () => {
    expect(() => base45Decode('BB8~')).toThrow(ToolError);
    expect(() => base45Decode('BB8~')).toThrow(/"~" at position 4/);
    expect(() => base45Decode('BB\t8')).toThrow(/"U\+0009" at position 3/);
  });

  it('explains lower case, and reads it when asked', () => {
    expect(() => base45Decode('bb8')).toThrow(/upper case only/);
    expect(() => base45Decode('bb8')).toThrow(/position 1/);
    expect(utf8Decode(base45Decode('bb8', true))).toBe('AB');
  });

  it('rejects a group that stands for more than two bytes', () => {
    // GGW = 16 + 16*45 + 32*2025 = 65536: one more than 0xFFFF
    expect(() => base45Decode('GGW')).toThrow(/"GGW" at positions 1–3.*65536.*65535/);
    expect(() => base45Decode('BB8:::')).toThrow(/positions 4–6/);
  });

  it('rejects a last pair above 255 and a lone last character', () => {
    expect(() => base45Decode('U6')).toThrow(/"U6" at positions 1–2.*300.*255/);
    expect(() => base45Decode('BB8U')).toThrow(/Truncated Base45.*position 4/);
    expect(() => base45Decode('A')).toThrow(/Truncated/);
  });

  it('decodes the HC1: prefix of an EU certificate and tells it was there', () => {
    const z = zlibSync(utf8Encode('flag{hc1_inflated}'));
    const r = base45DecodeText(`HC1:${base45Encode(z)}`);
    expect(r.prefix).toBe(true);
    expect(toHex(r.bytes)).toBe(toHex(z));
    expect(base45DecodeText('BB8').prefix).toBe(false);
  });
});

describe('base45 tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    base45.run({ bytes: utf8Encode(text) }, {
      mode: 'decode',
      ignoreCase: false,
      ...options,
    } as never) as Output[];

  it('decodes and encodes', () => {
    expect(resultToText(run('%69 VD92EX0'))).toBe('Hello!!');
    expect(resultToText(run('ietf!', { mode: 'encode' }))).toBe('QED8WEX0');
  });

  it('notes the removed HC1: prefix, and the zlib layer under it', () => {
    const z = zlibSync(utf8Encode('flag{hc1_inflated}'));
    const out = run(`HC1:${base45Encode(z)}`);
    const text = resultToText(out);
    expect(text).toContain('The HC1: prefix was removed');
    expect(text).toContain('zlib');
    const plain = resultToText(run(`HC1:${base45Encode(utf8Encode('plain'))}`));
    expect(plain).toContain('The HC1: prefix was removed');
    expect(plain).not.toContain('zlib');
  });

  it('reports bad input as ToolError', () => {
    expect(() => run('not base45!')).toThrow(ToolError);
  });

  it('detect: Base45 that decodes to text or to a certificate, not capital words', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(base45.detect!(sample('%69 VD92EX0'))?.score).toBeGreaterThan(0.7);
    const z = base45Encode(zlibSync(utf8Encode('flag{hc1_inflated}')));
    expect(base45.detect!(sample(`HC1:${z}`))?.score).toBeGreaterThanOrEqual(0.9);
    expect(base45.detect!(sample(z))?.score).toBeGreaterThanOrEqual(0.6);
    expect(base45.detect!(sample('HELLO WORLD THIS IS A TEST'))).toBeNull();
    expect(base45.detect!(sample('hello world'))).toBeNull();
    expect(base45.detect!(sample('SHORT'))).toBeNull();
    // base32 uses the same capitals and digits, but does not decode to anything readable here
    expect(base45.detect!(sample('MZXW6YTBOI======'))).toBeNull();
  });
});
