import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromHex, toHex, utf8Encode } from '../../lib/bytes';
import { Des, TripleDes } from './_des';
import { cbcCrypt, cfbCrypt, ctrCrypt, ecbCrypt, ofbCrypt } from './_modes';
import { rc4 } from './_rc4';

const hex = (s: string) => fromHex(s);

/** One block through a cipher, as hex. */
function block(c: Des | TripleDes, dir: 'enc' | 'dec', input: string): string {
  const b = hex(input);
  if (dir === 'enc') c.encryptBlock(b);
  else c.decryptBlock(b);
  return toHex(b);
}

describe('DES known answers (FIPS 46-3 and the NIST / Rivest test sets)', () => {
  const vectors: [key: string, plain: string, cipher: string][] = [
    // The worked example of the classic DES walkthrough.
    ['133457799bbcdff1', '0123456789abcdef', '85e813540f0ab405'],
    // "Now is t" under the key 0123456789abcdef (FIPS 81 style example).
    ['0123456789abcdef', '4e6f772069732074', '3fa40e8a984d4815'],
    ['0000000000000000', '0000000000000000', '8ca64de9c1b123a7'],
    ['ffffffffffffffff', 'ffffffffffffffff', '7359b2163e4edc58'],
    // NIST variable plaintext known-answer test, first vector.
    ['0101010101010101', '8000000000000000', '95f8a5e5dd31d900'],
    ['0101010101010101', '4000000000000000', 'dd7f121ca5015619'],
    ['3000000000000000', '1000000000000001', '958e6e627a05557b'],
  ];

  it.each(vectors)('key %s: %s -> %s and back', (key, plain, cipher) => {
    const des = new Des(hex(key));
    expect(block(des, 'enc', plain)).toBe(cipher);
    expect(block(des, 'dec', cipher)).toBe(plain);
  });

  it('ignores the parity bits of the key', () => {
    const a = new Des(hex('133457799bbcdff1'));
    const b = new Des(hex('123456789abcdef0'));
    expect(block(a, 'enc', '0123456789abcdef')).toBe(block(b, 'enc', '0123456789abcdef'));
  });

  it('rejects a key that is not 8 bytes', () => {
    expect(() => new Des(new Uint8Array(7))).toThrow(RangeError);
  });
});

describe('Triple DES known answers', () => {
  it('matches the three-key ECB example "The qufck brown fox jump"', () => {
    const key = hex('0123456789abcdef23456789abcdef01456789abcdef0123');
    const plain = utf8Encode('The qufck brown fox jump');
    const out = ecbCrypt(new TripleDes(key), plain, false);
    expect(toHex(out)).toBe('a826fd8ce53b855fcce21c8112256fe668d5c05dd9b6b900');
    expect(toHex(ecbCrypt(new TripleDes(key), out, true))).toBe(toHex(plain));
  });

  it('is plain DES when the three keys are equal (NIST SP 800-67 backward compatibility)', () => {
    const k = '0101010101010101';
    const tdes = new TripleDes(hex(k + k + k));
    expect(block(tdes, 'enc', '8000000000000000')).toBe('95f8a5e5dd31d900');
    const two = new TripleDes(hex(k + k));
    expect(block(two, 'enc', '8000000000000000')).toBe('95f8a5e5dd31d900');
  });

  it('two-key 3DES uses K1 again as K3', () => {
    const a = new TripleDes(hex('0123456789abcdef23456789abcdef01'));
    const b = new TripleDes(hex('0123456789abcdef23456789abcdef010123456789abcdef'));
    expect(block(a, 'enc', '0011223344556677')).toBe(block(b, 'enc', '0011223344556677'));
  });

  it('rejects other key sizes', () => {
    expect(() => new TripleDes(new Uint8Array(8))).toThrow(RangeError);
    expect(() => new TripleDes(new Uint8Array(32))).toThrow(RangeError);
  });

  it('agrees with Node on random data in CBC', () => {
    for (let n = 0; n < 5; n++) {
      const key = randomBytes(24);
      const iv = randomBytes(8);
      const plain = randomBytes(8 * (1 + n * 3));
      const node = createCipheriv('des-ede3-cbc', key, iv);
      node.setAutoPadding(false);
      const expected = Buffer.concat([node.update(plain), node.final()]);
      const mine = cbcCrypt(new TripleDes(key), iv, plain, false);
      expect(toHex(mine)).toBe(expected.toString('hex'));
      const back = createDecipheriv('des-ede3-cbc', key, iv);
      back.setAutoPadding(false);
      expect(toHex(cbcCrypt(new TripleDes(key), iv, mine, true))).toBe(toHex(plain));
      expect(Buffer.concat([back.update(mine), back.final()]).toString('hex')).toBe(toHex(plain));
    }
  });
});

describe('RC4 (RFC 6229 keystream vectors)', () => {
  const zeros = new Uint8Array(32);
  const stream = (key: string) => toHex(rc4(hex(key), zeros));

  it('40-bit key 0102030405: offsets 0 and 16', () => {
    const s = stream('0102030405');
    expect(s.slice(0, 32)).toBe('b2396305f03dc027ccc3524a0a1118a8');
    expect(s.slice(32, 64)).toBe('6982944f18fc82d589c403a47a0d0919');
  });

  it('64-bit key 0102030405060708', () => {
    expect(stream('0102030405060708').slice(0, 32)).toBe('97ab8a1bf0afb96132f2f67258da15a8');
  });

  it('128-bit key 0102030405060708090a0b0c0d0e0f10', () => {
    expect(stream('0102030405060708090a0b0c0d0e0f10').slice(0, 32)).toBe(
      '9ac7cc9a609d1ef7b2932899cde41b97',
    );
  });

  it('192-bit key 0102…18', () => {
    expect(stream('0102030405060708090a0b0c0d0e0f101112131415161718').slice(0, 32)).toBe(
      '0595e57fe5f0bb3c706edac8a4b2db11',
    );
  });

  it('classic text examples', () => {
    expect(toHex(rc4(utf8Encode('Key'), utf8Encode('Plaintext')))).toBe('bbf316e8d940af0ad3');
    expect(toHex(rc4(utf8Encode('Wiki'), utf8Encode('pedia')))).toBe('1021bf0420');
    expect(toHex(rc4(utf8Encode('Secret'), utf8Encode('Attack at dawn')))).toBe(
      '45a01f645fc35b383552544b9bf5',
    );
  });

  it('is its own inverse and rejects empty keys', () => {
    const data = utf8Encode('round trip');
    expect(toHex(rc4(utf8Encode('k'), rc4(utf8Encode('k'), data)))).toBe(toHex(data));
    expect(() => rc4(new Uint8Array(), data)).toThrow(RangeError);
  });
});

describe('generic modes on DES (against Node for 3DES, themselves for the rest)', () => {
  const key = hex('0123456789abcdef23456789abcdef01456789abcdef0123');
  const iv = hex('0001020304050607');
  const plain = utf8Encode('Find The Flag symmetric test, a bit longer than a block');

  it('CFB and OFB match OpenSSL-compatible Node output, any length', () => {
    for (const name of ['cfb', 'ofb'] as const) {
      const node = createCipheriv(`des-ede3-${name}`, key, iv);
      const expected = Buffer.concat([node.update(plain), node.final()]);
      const mine =
        name === 'cfb'
          ? cfbCrypt(new TripleDes(key), iv, plain, false)
          : ofbCrypt(new TripleDes(key), iv, plain);
      expect(toHex(mine)).toBe(expected.toString('hex'));
    }
  });

  it('CTR is ECB of the counter blocks XORed in', () => {
    const c = new TripleDes(key);
    const ctr = hex('00000000000000fe');
    const out = ctrCrypt(c, ctr, new Uint8Array(24));
    const blocks = hex('00000000000000fe00000000000000ff0000000000000100');
    expect(toHex(out)).toBe(toHex(ecbCrypt(c, blocks, false)));
  });

  it('CFB decrypt inverts encrypt', () => {
    const c = new TripleDes(key);
    const enc = cfbCrypt(c, iv, plain, false);
    expect(toHex(cfbCrypt(c, iv, enc, true))).toBe(toHex(plain));
  });
});
