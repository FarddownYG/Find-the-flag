import { describe, expect, it } from 'vitest';
import { resultToText } from '../../core/result-text';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { utf8Encode } from '../../lib/bytes';
import { createHmac } from './_hmac';
import tool from './hash';

type Opts = Parameters<typeof tool.run>[1];
const defaults: Opts = { hmacKey: '', keyHex: false, expected: '', uppercase: false };

async function hashes(input: string | Uint8Array, opts: Partial<Opts> = {}) {
  const bytes = typeof input === 'string' ? utf8Encode(input) : input;
  const out = await tool.run({ bytes }, { ...defaults, ...opts });
  const table = (label: string) => {
    const t = out.find((o: Output) => o.type === 'table' && o.label?.startsWith(label));
    if (!t || t.type !== 'table') return new Map<string, string>();
    return new Map(t.rows.map((r) => [String(r[0]), String(r[1])]));
  };
  return { out, plain: table('Digests'), mac: table('HMAC'), text: resultToText(out) };
}

describe('hash', () => {
  it('matches the published vectors for the empty string', async () => {
    const { plain } = await hashes('');
    expect(plain.get('MD5')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(plain.get('SHA-1')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(plain.get('SHA-256')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(plain.get('Keccak-256')).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
    expect(plain.get('SHA3-256')).toBe(
      'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a',
    );
    expect(plain.get('BLAKE3')).toBe(
      'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262',
    );
    expect(plain.get('BLAKE2b-256')).toBe(
      '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8',
    );
    expect(plain.get('xxHash64')).toBe('ef46db3751d8e999');
    expect(plain.get('CRC32')).toBe('00000000');
    expect(plain.get('Adler-32')).toBe('00000001');
  });

  it('matches the FIPS / NESSIE vectors for "abc"', async () => {
    const { plain } = await hashes('abc');
    expect(plain.get('MD4')).toBe('a448017aaf21d8525fc10ae87aa6729d');
    expect(plain.get('SHA-1')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(plain.get('SHA-224')).toBe('23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7');
    expect(plain.get('SHA-256')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(plain.get('SHA-384')).toBe(
      'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
    );
    expect(plain.get('SHA-512')).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    );
    expect(plain.get('SHA3-256')).toBe(
      '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532',
    );
    expect(plain.get('SHA3-512')).toBe(
      'b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0',
    );
    expect(plain.get('RIPEMD-160')).toBe('8eb208f7e05d987a9b044a8e98c6b087f15a0bfc');
  });

  it('computes NTLM as MD4 of the UTF-16LE text', async () => {
    const { plain } = await hashes('password');
    expect(plain.get('NTLM')).toBe('8846f7eaee8fb117ad06bdd830b7586c');
    expect(plain.get('MD4')).toBe('8a9d093f14f8701df17732b2bb182c74');
  });

  it('computes the standard checksums', async () => {
    expect((await hashes('123456789')).plain.get('CRC32')).toBe('cbf43926');
    expect((await hashes('Wikipedia')).plain.get('Adler-32')).toBe('11e60398');
  });

  it('hashes raw bytes, not their text form', async () => {
    const { plain } = await hashes(Uint8Array.of(0x00, 0xff, 0x10));
    expect(plain.get('MD5')).toBe('481e4551ec039aada760901cf52b1917');
    expect(plain.get('SHA-256')).toHaveLength(64);
  });

  it('adds HMACs only when a key is set', async () => {
    expect((await hashes('x')).mac.size).toBe(0);
    const fox = 'The quick brown fox jumps over the lazy dog';
    const { mac } = await hashes(fox, { hmacKey: 'key' });
    expect(mac.get('HMAC-MD5')).toBe('80070713463e7749b90c2dc24911e275');
    expect(mac.get('HMAC-SHA1')).toBe('de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9');
    expect(mac.get('HMAC-SHA256')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
    expect(mac.get('HMAC-SHA512')).toBe(
      'b42af09057bac1e2d41708e48a902e09b5ff7f12ab428a4fe86653c73dd248fb82f948a549f7b791a5b41915ee4d1ec3935357e4e2317250d0372afa2ebeeb3a',
    );
  });

  it('reads the HMAC key as hex when asked', async () => {
    const fox = 'The quick brown fox jumps over the lazy dog';
    const asText = await hashes(fox, { hmacKey: 'key' });
    const asHex = await hashes(fox, { hmacKey: '6b6579', keyHex: true });
    expect(asHex.mac.get('HMAC-SHA256')).toBe(asText.mac.get('HMAC-SHA256'));
  });

  it('HMAC handles keys longer than the block size (RFC 4231 case 6)', async () => {
    const key = new Uint8Array(131).fill(0xaa);
    const msg = utf8Encode('Test Using Larger Than Block-Size Key - Hash Key First');
    const sha256 = await createHmac('sha256');
    const sha512 = await createHmac('sha512');
    expect(Buffer.from(sha256(key, msg)).toString('hex')).toBe(
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    );
    expect(Buffer.from(sha512(key, msg)).toString('hex')).toBe(
      '80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f3526b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598',
    );
  });

  it('uppercases on request', async () => {
    const { plain } = await hashes('', { uppercase: true });
    expect(plain.get('MD5')).toBe('D41D8CD98F00B204E9800998ECF8427E');
  });

  describe('compare', () => {
    it('names the algorithm and highlights its row', async () => {
      const { out, text } = await hashes('abc', {
        expected: 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD',
      });
      expect(text).toContain('Matches SHA-256');
      const table = out.find((o) => o.type === 'table');
      expect(table?.type === 'table' && table.highlight).toHaveLength(1);
    });

    it('accepts Base64, 0x prefixes and md5sum lines', async () => {
      const b64 = Buffer.from('900150983cd24fb0d6963f7d28e17f72', 'hex').toString('base64');
      expect((await hashes('abc', { expected: b64 })).text).toContain('Matches MD5');
      expect(
        (await hashes('abc', { expected: '0x900150983cd24fb0d6963f7d28e17f72' })).text,
      ).toContain('Matches MD5');
      expect(
        (await hashes('abc', { expected: '900150983cd24fb0d6963f7d28e17f72  file.txt' })).text,
      ).toContain('Matches MD5');
    });

    it('matches HMAC rows too', async () => {
      const { text } = await hashes('The quick brown fox jumps over the lazy dog', {
        hmacKey: 'key',
        expected: '80070713463e7749b90c2dc24911e275',
      });
      expect(text).toContain('Matches HMAC-MD5');
    });

    it('finds a hash that only matches with a trailing newline', async () => {
      // md5("hello\n") is what `echo hello | md5sum` prints.
      const { text } = await hashes('hello', { expected: 'b1946ac92492d2347c6235b4d2611184' });
      expect(text).toMatch(/trailing newline added/);
      expect(text).toContain('MD5');
    });

    it('explains a miss using the digest size', async () => {
      const { text } = await hashes('hello', { expected: '0'.repeat(40) });
      expect(text).toMatch(/No match/);
      expect(text).toContain('SHA-1');
      expect((await hashes('hello', { expected: 'abcdef12abcdef12ab' })).text).toMatch(
        /not the size of any algorithm/,
      );
    });

    it('rejects an expected value that is neither hex nor Base64', async () => {
      await expect(hashes('hello', { expected: 'not a hash!' })).rejects.toBeInstanceOf(ToolError);
      await expect(hashes('hello', { expected: '%%%%%%%%' })).rejects.toBeInstanceOf(ToolError);
    });
  });

  it('rejects a malformed hex key', async () => {
    await expect(hashes('x', { hmacKey: 'xyz', keyHex: true })).rejects.toBeInstanceOf(ToolError);
  });
});
