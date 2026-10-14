import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import { fromHex, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import { PROSE_A, PROSE_B } from './_sample-text';
import tool, {
  bruteForceByte,
  crackRepeatingKey,
  keyLengthDistances,
  knownPlaintextAnywhere,
  knownPlaintextAt,
  parseKey,
  xorBytes,
} from './xor';

type Opts = Parameters<typeof tool.run>[1];

const run = (data: Uint8Array, options: Partial<Opts> = {}): ToolResult =>
  tool.run(
    { bytes: data },
    {
      mode: 'brute',
      keyFormat: 'text',
      key: '',
      maxLen: 40,
      known: 'flag{',
      offset: 0,
      everyOffset: false,
      ...options,
    },
  ) as ToolResult;

const bytesOf = (blocks: ToolResult): Uint8Array => {
  const b = blocks.find((x) => x.type === 'bytes');
  if (b?.type !== 'bytes') throw new Error('no bytes block');
  return b.value;
};

describe('xor key mode', () => {
  it('xors with a repeating text key and is its own inverse', () => {
    const plain = utf8Encode('flag{xor_is_symmetric}');
    const enc = xorBytes(plain, utf8Encode('key'));
    expect(toHex(enc).slice(0, 6)).toBe('0d0918');
    expect(utf8Decode(xorBytes(enc, utf8Encode('key')))).toBe('flag{xor_is_symmetric}');
  });

  it('parses hex, decimal and text keys to the same bytes', () => {
    const want = [0x6b, 0x33, 0x79];
    expect([...parseKey('k3y', 'text')]).toEqual(want);
    expect([...parseKey('6b 33 79', 'hex')]).toEqual(want);
    expect([...parseKey('0x6b,0x33,0x79', 'hex')]).toEqual(want);
    expect([...parseKey('107 51 121', 'decimal')]).toEqual(want);
    expect([...parseKey('107, 51, 121', 'decimal')]).toEqual(want);
  });

  it('decrypts through the tool', () => {
    const enc = xorBytes(utf8Encode('flag{via_the_tool}'), utf8Encode('s3'));
    const out = run(enc, { mode: 'key', key: '7333', keyFormat: 'hex' });
    expect(utf8Decode(bytesOf(out))).toBe('flag{via_the_tool}');
  });

  it('rejects bad keys', () => {
    expect(() => parseKey('', 'text')).toThrow(ToolError);
    expect(() => parseKey('256', 'decimal')).toThrow(/0 to 255/);
    expect(() => parseKey('12 x', 'decimal')).toThrow(ToolError);
    expect(() => parseKey('zz', 'hex')).toThrow(ToolError);
    expect(() => run(utf8Encode('abc'), { mode: 'key', key: '' })).toThrow(ToolError);
    expect(() => run(new Uint8Array(), {})).toThrow(/No data/);
  });
});

describe('xor single-byte brute force', () => {
  it('ranks the right key first for a short flag', () => {
    const enc = xorBytes(utf8Encode('flag{one_byte_xor_is_weak}'), [0x2a]);
    const ranked = bruteForceByte(enc);
    expect(ranked).toHaveLength(256);
    expect(ranked[0]!.key).toBe(0x2a);
    const out = run(enc);
    expect(utf8Decode(bytesOf(out))).toBe('flag{one_byte_xor_is_weak}');
    const table = out.find((b) => b.type === 'table');
    expect(table?.type === 'table' && table.rows).toHaveLength(20);
    expect(table?.type === 'table' && table.rows[0]![0]).toBe('0x2a');
    expect(table?.type === 'table' && table.rows[0]![1]).toBe('*');
  });

  it('finds every single-byte key on real English text', () => {
    for (const key of [0x01, 0x20, 0x42, 0x7f, 0x80, 0xa5, 0xff]) {
      const enc = xorBytes(utf8Encode(PROSE_B), [key]);
      expect(bruteForceByte(enc)[0]!.key).toBe(key);
    }
  });

  it('prefers the lower key on a tie and reports hex in the label', () => {
    const out = run(xorBytes(utf8Encode(PROSE_A), [0x5c]));
    expect(resultToText(out)).toContain('Best guess · key 0x5c');
  });
});

describe('xor repeating key', () => {
  it('computes Hamming distances that favour the true length', () => {
    const enc = xorBytes(utf8Encode(PROSE_A), utf8Encode('SECRET'));
    const lengths = keyLengthDistances(enc, 30);
    expect(lengths[0]!.length % 6).toBe(0);
    expect(lengths[0]!.distance).toBeLessThan(3.5);
  });

  it.each(['ICE', 'k3y!', 'Terminator', 'flag{x}'])(
    'cracks the key %s from English text',
    (key) => {
      const enc = xorBytes(utf8Encode(PROSE_A + ' ' + PROSE_B), utf8Encode(key));
      const { candidates } = crackRepeatingKey(enc, 40);
      expect(utf8Decode(candidates[0]!.key)).toBe(key);
      const out = run(enc, { mode: 'crack' });
      expect(utf8Decode(bytesOf(out))).toBe(PROSE_A + ' ' + PROSE_B);
      expect(resultToText(out)).toContain(`Key (text): "${key}"`);
      expect(resultToText(out)).toContain(`Key (hex): ${toHex(utf8Encode(key))}`);
    },
  );

  it('cracks a non-ASCII key and reports it as hex', () => {
    const key = Uint8Array.of(0x9a, 0x03, 0xc4, 0x71);
    const enc = xorBytes(utf8Encode(PROSE_A), key);
    const out = resultToText(run(enc, { mode: 'crack' }));
    expect(out).toContain('Key (hex): 9a03c471');
    expect(out).toContain('Key (text): (not printable)');
  });

  it('reduces a doubled key to its period', () => {
    const enc = xorBytes(utf8Encode(PROSE_B), utf8Encode('abcabc'));
    expect(utf8Decode(crackRepeatingKey(enc, 40).candidates[0]!.key)).toBe('abc');
  });

  it('refuses tiny inputs', () => {
    expect(() => run(utf8Encode('hi'), { mode: 'crack' })).toThrow(ToolError);
  });
});

describe('xor known plaintext', () => {
  it('derives a short key from a crib at offset 0', () => {
    const enc = xorBytes(utf8Encode('flag{known_plaintext_xor}'), utf8Encode('xor3'));
    const out = run(enc, { mode: 'known' });
    expect(utf8Decode(bytesOf(out))).toBe('flag{known_plaintext_xor}');
    expect(resultToText(out)).toContain('Key (text): "xor3"');
    expect(resultToText(out)).toContain('Offset: 0');
  });

  it('detects the period for one-, two- and three-byte keys', () => {
    for (const key of ['k', 'ab', 'ctf']) {
      const enc = xorBytes(utf8Encode('flag{period_detection}'), utf8Encode(key));
      const [best] = knownPlaintextAt(enc, utf8Encode('flag{'), 0, 40);
      expect(utf8Decode(best!.key)).toBe(key);
      expect(best!.verified).toBe(true);
    }
  });

  it('extends a key longer than the crib statistically', () => {
    const plain = PROSE_A.slice(0, 400);
    const enc = xorBytes(utf8Encode(plain), utf8Encode('longerkey!'));
    const out = run(enc, { mode: 'known', known: 'The old' });
    expect(utf8Decode(bytesOf(out))).toBe(plain);
    expect(resultToText(out)).toContain('Key (text): "longerkey!"');
  });

  it('handles a crib that is not at the start, with an offset', () => {
    const msg = 'xx secret message: flag{offset_crib} end';
    const enc = xorBytes(utf8Encode(msg), utf8Encode('abc'));
    const out = run(enc, { mode: 'known', offset: 19 });
    expect(utf8Decode(bytesOf(out))).toBe(msg);
    expect(resultToText(out)).toContain('Key (text): "abc"');
  });

  it('tries every offset when asked', () => {
    const msg = 'padding padding flag{slide_the_crib} padding';
    const enc = xorBytes(utf8Encode(msg), utf8Encode('K!'));
    const found = knownPlaintextAnywhere(enc, utf8Encode('flag{'), 40);
    expect(found[0]!.extra).toBe(msg.indexOf('flag{'));
    expect(utf8Decode(found[0]!.key)).toBe('K!');
    const out = run(enc, { mode: 'known', everyOffset: true });
    expect(utf8Decode(bytesOf(out))).toBe(msg);
    expect(resultToText(out)).toContain(`known text at offset ${msg.indexOf('flag{')}`);
  });

  it('accepts a hex crib', () => {
    const enc = xorBytes(utf8Encode('flag{hex_crib}'), [0x55]);
    const out = run(enc, { mode: 'known', known: 'hex:666c61677b' });
    expect(utf8Decode(bytesOf(out))).toBe('flag{hex_crib}');
  });

  it('explains when the crib does not fit', () => {
    const noise = fromHex('00112233445566778899aabbccddeeff00112233');
    expect(() => run(noise, { mode: 'known', everyOffset: true })).toThrow(/No offset/);
    expect(() => run(noise, { mode: 'known', known: 'flag{', offset: 18 })).toThrow(/past the end/);
    expect(() => run(noise, { mode: 'known', known: '' })).toThrow(/known plaintext/);
    expect(() => run(utf8Encode('abc'), { mode: 'known' })).toThrow(/longer than the data/);
  });
});
