import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import tool from './number-base';

type Opts = Parameters<typeof tool.run>[1];
const defaults: Opts = { mode: 'number', base: 'auto', custom: 7 };

const run = async (input: string, opts: Partial<Opts> = {}): Promise<Output[]> =>
  tool.run(input, { ...defaults, ...opts });

async function kv(input: string, opts: Partial<Opts> = {}): Promise<Map<string, string>> {
  const out = await run(input, opts);
  const block = out.find((o) => o.type === 'kv');
  if (!block || block.type !== 'kv') throw new Error('no kv block');
  return new Map(block.entries);
}

describe('number → bases and bytes', () => {
  it('shows every base of a decimal number', async () => {
    const r = await kv('255');
    expect(r.get('Decimal')).toBe('255');
    expect(r.get('Hex')).toBe('0xff');
    expect(r.get('Octal')).toBe('0o377');
    expect(r.get('Binary')).toBe('0b11111111');
    expect(r.get('Base36')).toBe('73');
    expect(r.get('Base62')).toBe('47');
    expect(r.get('Size')).toBe('8 bits, 1 bytes');
  });

  it('turns an RSA-sized hex number into text (long_to_bytes)', async () => {
    const r = await kv('0x666c61677b6e756d3262797465737d');
    expect(r.get('As text (big-endian)')).toBe('flag{num2bytes}');
    expect(r.get('Bytes (hex)')).toBe('66 6c 61 67 7b 6e 75 6d 32 62 79 74 65 73 7d');
    expect(r.get('Read as')).toBe('base 16');
  });

  it('matches Python for big integers in both byte orders', async () => {
    // int.from_bytes(b"flag{x}", "big") and "little"
    expect((await kv('28829613228259453')).get('As text (big-endian)')).toBe('flag{x}');
    expect((await kv('35316843499580518')).get('As text (little-endian)')).toBe('flag{x}');
    expect(
      (await kv('2511413510842060413510119088141712512283210298218286115709')).get(
        'As text (big-endian)',
      ),
    ).toBe('flag{rsa_small_e_attack}');
  });

  it('is exact for numbers far beyond 2^53', async () => {
    const big = 2n ** 4096n + 12345n;
    const r = await kv(big.toString());
    expect(r.get('Decimal')).toBe(big.toString());
    expect(r.get('Hex')).toBe(`0x${big.toString(16)}`);
    expect(r.get('Size')).toBe('4097 bits, 513 bytes');
  });

  it('handles zero and single bytes', async () => {
    const zero = await kv('0');
    expect(zero.get('Bytes (hex)')).toBe('00');
    expect(zero.get('Size')).toBe('1 bits, 1 bytes');
    expect((await kv('0x41')).get('As text (big-endian)')).toBe('A');
  });

  it('escapes bytes that are not text', async () => {
    const r = await kv('0xff');
    expect(r.get('As text (big-endian)')).toBe('\\xff');
    expect((await kv('0x0001')).get('As text (big-endian)')).toBe('\\x01');
    expect((await kv('0x41ff42')).get('As text (big-endian)')).toBe('A\\xffB');
  });

  it('decodes UTF-8 multi-byte text', async () => {
    expect((await kv('0xc3a9')).get('As text (big-endian)')).toBe('é');
  });

  it('reports negative numbers without pretending they are bytes', async () => {
    const r = await kv('-255');
    expect(r.get('Hex')).toBe('-0xff');
    expect(r.get('Binary')).toBe('-0b11111111');
    expect(r.get('As text (big-endian)')).toMatch(/negative/);
  });

  it('accepts underscores and a plus sign', async () => {
    expect((await kv('+1_000_000')).get('Decimal')).toBe('1000000');
  });
});

describe('input base', () => {
  it('auto-detects prefixes, decimal and bare hex', async () => {
    expect((await kv('0b1010')).get('Decimal')).toBe('10');
    expect((await kv('0o777')).get('Decimal')).toBe('511');
    expect((await kv('0XFF')).get('Decimal')).toBe('255');
    expect((await kv('1010')).get('Decimal')).toBe('1010');
    expect((await kv('deadbeef')).get('Decimal')).toBe('3735928559');
    expect((await kv('deadbeef')).get('Read as')).toBe('base 16');
  });

  it('honours an explicit base', async () => {
    expect((await kv('1010', { base: '2' })).get('Decimal')).toBe('10');
    expect((await kv('777', { base: '8' })).get('Decimal')).toBe('511');
    expect((await kv('ff', { base: '16' })).get('Decimal')).toBe('255');
    expect((await kv('zz', { base: '36' })).get('Decimal')).toBe('1295');
    expect((await kv('ZZ', { base: '36' })).get('Decimal')).toBe('1295');
    expect((await kv('0xff', { base: '16' })).get('Decimal')).toBe('255');
  });

  it('treats 0b as digits when the base is hexadecimal', async () => {
    expect((await kv('0b1', { base: '16' })).get('Decimal')).toBe('177');
  });

  it('base62 is case sensitive: digits, then A-Z, then a-z', async () => {
    expect((await kv('z', { base: '62' })).get('Decimal')).toBe('61');
    expect((await kv('A', { base: '62' })).get('Decimal')).toBe('10');
    expect((await kv('a', { base: '62' })).get('Decimal')).toBe('36');
    expect((await kv('100', { base: '62' })).get('Decimal')).toBe('3844');
    expect((await kv('3844')).get('Base62')).toBe('100');
  });

  it('supports any custom base from 2 to 62', async () => {
    expect((await kv('666', { base: 'custom', custom: 7 })).get('Decimal')).toBe('342');
    expect((await kv('12', { base: 'custom', custom: 3 })).get('Decimal')).toBe('5');
    expect((await kv('yz', { base: 'custom', custom: 36 })).get('Decimal')).toBe('1259');
  });

  it('round-trips big numbers through every base it prints', async () => {
    const samples = [0n, 1n, 61n, 62n, 3844n, 2n ** 64n - 1n, 7n ** 300n + 11n, 2n ** 1000n];
    for (const n of samples) {
      const r = await kv(n.toString());
      for (const [key, base] of [
        ['Hex', '16'],
        ['Octal', '8'],
        ['Binary', '2'],
        ['Base36', '36'],
        ['Base62', '62'],
      ] as const) {
        const text = r.get(key)!.replace(/^0[xob]/, '');
        expect((await kv(text, { base })).get('Decimal'), `${key} of ${n}`).toBe(n.toString());
      }
    }
  });

  it('rejects digits that do not belong to the base', async () => {
    await expect(run('12', { base: '2' })).rejects.toThrow(/not a base-2 digit/);
    await expect(run('0b102')).rejects.toBeInstanceOf(ToolError);
    await expect(run('xyz')).rejects.toThrow(/Cannot guess the base/);
    await expect(run('0x')).rejects.toThrow(/no digits/);
    await expect(run('12ab', { base: '10' })).rejects.toBeInstanceOf(ToolError);
    await expect(run('1', { base: 'custom', custom: 1 })).rejects.toThrow(/2 to 62/);
    await expect(run('1', { base: 'custom', custom: 63 })).rejects.toBeInstanceOf(ToolError);
    await expect(run('1', { base: 'custom', custom: 2.5 })).rejects.toBeInstanceOf(ToolError);
  });

  it('rejects empty and oversized input', async () => {
    await expect(run('')).rejects.toBeInstanceOf(ToolError);
    await expect(run('   \n ')).rejects.toBeInstanceOf(ToolError);
    await expect(run('9'.repeat(100_001))).rejects.toThrow(/longer than/);
  });
});

describe('several numbers', () => {
  it('returns a table and the joined bytes', async () => {
    const out = await run('65 66\n67, 0x44');
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows).toHaveLength(4);
    expect(table?.type === 'table' && table.rows[3]).toEqual([
      '0x44',
      '68',
      '0x44',
      '0o104',
      '0b1000100',
      '1w',
      'D',
      'D',
    ]);
    const joined = out.find((o) => o.type === 'text');
    expect(joined?.type === 'text' && joined.value).toBe('ABCD');
  });

  it('skips the joined text when a number is negative', async () => {
    const out = await run('65 -1');
    expect(out.some((o) => o.type === 'text')).toBe(false);
  });
});

describe('text → integer', () => {
  it('computes bytes_to_long in both byte orders', async () => {
    const out = await run('flag{x}', { mode: 'text' });
    const block = out[0];
    const r = new Map(block?.type === 'kv' ? block.entries : []);
    expect(r.get('Integer (big-endian)')).toBe('28829613228259453');
    expect(r.get('Hex (big-endian)')).toBe('0x666c61677b787d');
    expect(r.get('Integer (little-endian)')).toBe('35316843499580518');
    expect(r.get('Hex (little-endian)')).toBe('0x7d787b67616c66');
    expect(r.get('Size')).toBe('7 bytes, 55 bits');
  });

  it('round-trips with the number direction', async () => {
    for (const s of ['flag{round_trip}', 'héllo wörld', 'A', '日本語 CTF']) {
      const asInt = new Map(
        ((await run(s, { mode: 'text' }))[0] as Extract<Output, { type: 'kv' }>).entries,
      );
      const back = await kv(asInt.get('Integer (big-endian)')!);
      expect(back.get('As text (big-endian)')).toBe(s);
    }
  });

  it('ignores one trailing newline but keeps inner ones', async () => {
    const a = new Map(
      ((await run('ab\n', { mode: 'text' }))[0] as Extract<Output, { type: 'kv' }>).entries,
    );
    expect(a.get('Integer (big-endian)')).toBe('24930');
    const b = new Map(
      ((await run('a\nb', { mode: 'text' }))[0] as Extract<Output, { type: 'kv' }>).entries,
    );
    expect(b.get('Integer (big-endian)')).toBe(String(0x610a62));
  });

  it('needs some text', async () => {
    await expect(run('', { mode: 'text' })).rejects.toBeInstanceOf(ToolError);
    await expect(run('\n', { mode: 'text' })).rejects.toBeInstanceOf(ToolError);
  });
});

describe('detect', () => {
  const detect = (text: string | null) => tool.detect!({ text, bytes: new Uint8Array() });
  it('suggests itself for huge integers only', () => {
    expect(detect('2511413510842060413510119088141712512283210298218286115709')?.score).toBe(0.55);
    expect(detect('0x666c61677b6e756d3262797465737d')?.score).toBe(0.55);
    expect(detect('12345')).toBeNull();
    expect(detect('hello')).toBeNull();
    expect(detect(null)).toBeNull();
  });
});
