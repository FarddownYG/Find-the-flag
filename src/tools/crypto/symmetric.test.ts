import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resultToText } from '../../core/result-text';
import type { OptionSpecs, Output } from '../../core/types';
import { fromBase64, fromHex, toBase64, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import { cbcCrypt, cfbCrypt, ctrCrypt, ecbCrypt, ofbCrypt } from './_modes';
import {
  ALGOS,
  MODES,
  blockCipher,
  decryptData,
  encryptData,
  evpBytesToKey,
  isBlockCipher,
  ivLength,
  pbkdf2Hmac,
  readCiphertext,
  supports,
  type Algo,
  type Mode,
} from './_symmetric';
import * as F from './_symmetric-examples';
import tool from './symmetric';

type Opts = Parameters<typeof tool.run>[1];

const defaults: Opts = {
  action: 'decrypt',
  algorithm: 'aes-256',
  mode: 'cbc',
  kdf: 'raw',
  key: '',
  keyFormat: 'hex',
  kdfHash: 'sha256',
  iterations: 10000,
  salt: '',
  iv: '',
  ivFormat: 'hex',
  ivPrefix: false,
  inputFormat: 'auto',
  padding: 'pkcs7',
  counter: 0,
  aad: '',
};

type Input = Uint8Array | string;
const run = async (input: Input, o: Partial<Opts> = {}): Promise<Output[]> =>
  tool.run({ bytes: typeof input === 'string' ? utf8Encode(input) : input }, { ...defaults, ...o });

const bytesOf = (out: Output[], label = 'Plaintext'): Uint8Array => {
  const b = out.find((x) => x.type === 'bytes' && x.label === label);
  if (b?.type !== 'bytes') throw new Error(`no "${label}" block in:\n${resultToText(out)}`);
  return b.value;
};
const plain = async (input: Input, o: Partial<Opts>) => utf8Decode(bytesOf(await run(input, o)));
const textOf = (out: Output[], label: string): string => {
  const b = out.find((x) => x.type === 'text' && x.label === label);
  if (b?.type !== 'text') throw new Error(`no "${label}" text in:\n${resultToText(out)}`);
  return b.value;
};
const noteLevels = (out: Output[]) =>
  out.flatMap((x) => (x.type === 'note' ? [`${x.level}: ${x.text}`] : []));
const hasNote = (out: Output[], level: string, re: RegExp) =>
  noteLevels(out).some((n) => n.startsWith(`${level}:`) && re.test(n));
const encrypt = async (input: Input, o: Partial<Opts>) =>
  textOf(await run(input, { ...o, action: 'encrypt' }), 'Ciphertext (hex)');

/** Deterministic pseudo-random bytes (xorshift32), so a failing case can be replayed. */
function prng(seed: number): (n: number) => Uint8Array {
  let s = seed >>> 0 || 1;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      out[i] = s & 0xff;
    }
    return out;
  };
}

// ------------------------------------------------------------- published vectors

describe('AES known answers', () => {
  it.each([
    // FIPS 197 appendix C: one block, keys 00 01 02 …
    ['aes-128', F.KEY16, '69c4e0d86a7b0430d8cdb78070b4c55a'],
    ['aes-192', F.KEY24, 'dda97ca4864cdfe06eaf70a0ec0d7191'],
    ['aes-256', F.KEY32, '8ea2b7ca516745bfeafc49904b496089'],
  ] as const)('FIPS 197 %s', async (algorithm, key, expected) => {
    const pt = fromHex('00112233445566778899aabbccddeeff');
    const o = { algorithm, mode: 'ecb', key, padding: 'none' } as const;
    expect(await encrypt(pt, o)).toBe(expected);
    expect(toHex(bytesOf(await run(fromHex(expected), o)))).toBe(toHex(pt));
  });

  // NIST SP 800-38A appendix F: the same four plaintext blocks under three keys.
  const P =
    '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710';
  const K128 = '2b7e151628aed2a6abf7158809cf4f3c';
  const K192 = '8e73b0f7da0e6452c810f32b809079e562f8ead2522c6b7b';
  const K256 = '603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4';
  const IV = '000102030405060708090a0b0c0d0e0f';
  const CTR = 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';
  const vectors: [string, Algo, Mode, string, string, string][] = [
    [
      'F.1.1 ECB-AES128',
      'aes-128',
      'ecb',
      K128,
      '',
      '3ad77bb40d7a3660a89ecaf32466ef97f5d3d58503b9699de785895a96fdbaaf43b1cd7f598ece23881b00e3ed0306887b0c785e27e8ad3f8223207104725dd4',
    ],
    [
      'F.2.1 CBC-AES128',
      'aes-128',
      'cbc',
      K128,
      IV,
      '7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b273bed6b8e3c1743b7116e69e222295163ff1caa1681fac09120eca307586e1a7',
    ],
    [
      'F.3.13 CFB128-AES128',
      'aes-128',
      'cfb',
      K128,
      IV,
      '3b3fd92eb72dad20333449f8e83cfb4ac8a64537a0b3a93fcde3cdad9f1ce58b26751f67a3cbb140b1808cf187a4f4dfc04b05357c5d1c0eeac4c66f9ff7f2e6',
    ],
    [
      'F.4.1 OFB-AES128',
      'aes-128',
      'ofb',
      K128,
      IV,
      '3b3fd92eb72dad20333449f8e83cfb4a7789508d16918f03f53c52dac54ed8259740051e9c5fecf64344f7a82260edcc304c6528f659c77866a510d9c1d6ae5e',
    ],
    [
      'F.5.1 CTR-AES128',
      'aes-128',
      'ctr',
      K128,
      CTR,
      '874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff5ae4df3edbd5d35e5b4f09020db03eab1e031dda2fbe03d1792170a0f3009cee',
    ],
    [
      'F.1.3 ECB-AES192',
      'aes-192',
      'ecb',
      K192,
      '',
      'bd334f1d6e45f25ff712a214571fa5cc974104846d0ad3ad7734ecb3ecee4eefef7afd2270e2e60adce0ba2face6444e9a4b41ba738d6c72fb16691603c18e0e',
    ],
    [
      'F.2.3 CBC-AES192',
      'aes-192',
      'cbc',
      K192,
      IV,
      '4f021db243bc633d7178183a9fa071e8b4d9ada9ad7dedf4e5e738763f69145a571b242012fb7ae07fa9baac3df102e008b0e27988598881d920a9e64f5615cd',
    ],
    [
      'F.1.5 ECB-AES256',
      'aes-256',
      'ecb',
      K256,
      '',
      'f3eed1bdb5d2a03c064b5a7e3db181f8591ccb10d410ed26dc5ba74a31362870b6ed21b99ca6f4f9f153e7b1beafed1d23304b7a39f9f3ff067d8d8f9e24ecc7',
    ],
    [
      'F.2.5 CBC-AES256',
      'aes-256',
      'cbc',
      K256,
      IV,
      'f58c4c04d6e5f1ba779eabfb5f7bfbd69cfc4e967edb808d679f777bc6702c7d39f23369a9d9bacfa530e26304231461b2eb05e2c39be9fcda6c19078c6a9d1b',
    ],
    [
      'F.5.5 CTR-AES256',
      'aes-256',
      'ctr',
      K256,
      CTR,
      '601ec313775789a5b7a7f504bbf3d228f443e3ca4d62b59aca84e990cacaf5c52b0930daa23de94ce87017ba2d84988ddfc9c58db67aada613c2dd08457941a6',
    ],
  ];

  it.each(vectors)('SP 800-38A %s', async (_name, algorithm, mode, key, iv, cipher) => {
    const o = { algorithm, mode, key, iv, padding: 'none' } as const;
    expect(await encrypt(fromHex(P), o)).toBe(cipher);
    expect(toHex(bytesOf(await run(fromHex(cipher), o)))).toBe(P);
  });
});

describe('AES-GCM known answers (McGrew and Viega test cases)', () => {
  const zeroKey = '00000000000000000000000000000000';
  const zeroNonce = '000000000000000000000000';

  it('test case 1: empty plaintext, only a tag', async () => {
    const out = await run(new Uint8Array(), {
      action: 'encrypt',
      algorithm: 'aes-128',
      mode: 'gcm',
      key: zeroKey,
      iv: zeroNonce,
    }).catch((e: Error) => e);
    // Empty input is refused by the tool; the engine itself does the NIST case.
    expect(out).toBeInstanceOf(Error);
    const e = encryptData({
      algo: 'aes-128',
      mode: 'gcm',
      key: fromHex(zeroKey),
      iv: fromHex(zeroNonce),
      aad: new Uint8Array(),
      counter: 0,
      data: new Uint8Array(),
      padding: 'none',
    });
    expect(toHex(e.output)).toBe('58e2fccefa7e3061367f1d57a4e7455a');
  });

  it('test case 2: one zero block', async () => {
    const o = { algorithm: 'aes-128', mode: 'gcm', key: zeroKey, iv: zeroNonce } as const;
    const sealed = '0388dace60b6a392f328c2b971b2fe78ab6e47d42cec13bdf53a67b21257bddf';
    expect(await encrypt(new Uint8Array(16), o)).toBe(sealed);
    const out = await run(fromHex(sealed), o);
    expect(toHex(bytesOf(out))).toBe('00'.repeat(16));
    expect(hasNote(out, 'success', /tag is valid/)).toBe(true);
    expect(resultToText(out)).toContain('Authentication tag: valid');
  });

  const K = 'feffe9928665731c6d6a8f9467308308';
  const N = 'cafebabefacedbaddecaf888';
  const A = 'feedfacedeadbeeffeedfacedeadbeefabaddad2';
  const P =
    'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39';
  const C =
    '42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091';
  const T = '5bc94fbc3221a5db94fae95ae7121a47';

  it('test case 4: with additional data (AAD as hex)', async () => {
    const o = { algorithm: 'aes-128', mode: 'gcm', key: K, iv: N, aad: `hex:${A}` } as const;
    expect(await encrypt(fromHex(P), o)).toBe(C + T);
    const out = await run(fromHex(C + T), o);
    expect(toHex(bytesOf(out))).toBe(P);
    expect(hasNote(out, 'success', /tag is valid/)).toBe(true);
  });

  it('a wrong tag, wrong AAD or wrong nonce is reported, the text is still decrypted', async () => {
    const o = { algorithm: 'aes-128', mode: 'gcm', key: K, iv: N, aad: `hex:${A}` } as const;
    const badTag = await run(fromHex(C + '00'.repeat(16)), o);
    expect(toHex(bytesOf(badTag))).toBe(P);
    expect(hasNote(badTag, 'warn', /tag does not match/)).toBe(true);
    expect(resultToText(badTag)).toContain('Authentication tag: invalid');
    const noAad = await run(fromHex(C + T), { ...o, aad: '' });
    expect(toHex(bytesOf(noAad))).toBe(P);
    expect(hasNote(noAad, 'warn', /tag does not match/)).toBe(true);
    const badKey = await run(fromHex(C + T), { ...o, key: zeroKey });
    expect(toHex(bytesOf(badKey))).not.toBe(P);
    expect(hasNote(badKey, 'warn', /tag does not match/)).toBe(true);
  });

  it('refuses data shorter than a tag and a 64-bit block cipher', async () => {
    await expect(
      run(new Uint8Array(5), { algorithm: 'aes-128', mode: 'gcm', key: zeroKey, iv: zeroNonce }),
    ).rejects.toThrow(/16-byte tag/);
    await expect(
      run(new Uint8Array(24), { algorithm: '3des', mode: 'gcm', key: F.KEY24 }),
    ).rejects.toThrow(/AES only/);
  });
});

describe('ChaCha20 known answers (RFC 8439)', () => {
  const sunscreen =
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
  const key = toHex(Uint8Array.from({ length: 32 }, (_, i) => i));
  const ciphertext =
    '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0bf91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d807ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab77937365af90bbf74a35be6b40b8eedf2785e42874d';

  it('2.4.2: 12-byte nonce, counter 1', async () => {
    const o = { algorithm: 'chacha20', key, iv: '000000000000004a00000000', counter: 1 } as const;
    expect(await encrypt(sunscreen, o)).toBe(ciphertext);
    expect(await plain(fromHex(ciphertext), o)).toBe(sunscreen);
  });

  it('the same message with the 16-byte IV of openssl (counter, then nonce)', async () => {
    const o = { algorithm: 'chacha20', key, iv: '01000000000000000000004a00000000' } as const;
    expect(await encrypt(sunscreen, o)).toBe(ciphertext);
    expect(await plain(fromHex(ciphertext), o)).toBe(sunscreen);
  });

  it('2.8.2: ChaCha20-Poly1305 with additional data', async () => {
    const aeadKey = toHex(Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i));
    const nonce = '070000004041424344454647';
    const aad = '50515253c0c1c2c3c4c5c6c7';
    const sealed =
      'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b61161ae10b594f09e26a7e902ecbd0600691';
    const o = {
      algorithm: 'chacha20-poly1305',
      key: aeadKey,
      iv: nonce,
      aad: `hex:${aad}`,
    } as const;
    expect(await encrypt(sunscreen, o)).toBe(sealed);
    const out = await run(fromHex(sealed), o);
    expect(utf8Decode(bytesOf(out))).toBe(sunscreen);
    expect(hasNote(out, 'success', /tag is valid/)).toBe(true);
    // Flip one ciphertext bit: the tag no longer verifies, and the text comes out with that
    // one letter changed ("i" xor 1 = "h"), which is what a stream cipher does.
    const tampered = fromHex(sealed);
    tampered[3] = tampered[3]! ^ 1;
    const bad = await run(tampered, o);
    expect(hasNote(bad, 'warn', /tag does not match/)).toBe(true);
    expect(utf8Decode(bytesOf(bad))).toBe(`${sunscreen.slice(0, 3)}h${sunscreen.slice(4)}`);
  });

  it('XChaCha20-Poly1305 (24-byte nonce) round-trips', async () => {
    const o = {
      algorithm: 'chacha20-poly1305',
      key,
      iv: '00'.repeat(23) + '09',
      aad: 'hdr',
    } as const;
    const sealed = await encrypt(sunscreen, o);
    expect(sealed).toHaveLength((sunscreen.length + 16) * 2);
    expect(await plain(fromHex(sealed), o)).toBe(sunscreen);
  });

  it('XChaCha20 and the original 8-byte-nonce ChaCha20 round-trip', async () => {
    for (const iv of ['00'.repeat(24), '00'.repeat(8)]) {
      const o = { algorithm: 'chacha20', key, iv } as const;
      const enc = await encrypt(sunscreen, o);
      expect(await plain(fromHex(enc), o)).toBe(sunscreen);
    }
  });

  it('rejects odd nonce sizes and counters', async () => {
    await expect(
      run(new Uint8Array(4), { algorithm: 'chacha20', key, iv: '0011' }),
    ).rejects.toThrow(/12-byte nonce/);
    await expect(
      run(new Uint8Array(40), { algorithm: 'chacha20-poly1305', key, iv: '00' }),
    ).rejects.toThrow(/12-byte nonce/);
    await expect(
      run(new Uint8Array(4), { algorithm: 'chacha20', key, iv: '00'.repeat(12), counter: 1.5 }),
    ).rejects.toThrow(/whole number/);
  });
});

// ------------------------------------------------- the reference: openssl enc

describe('decrypts what openssl enc produced', () => {
  const raw: [string, Partial<Opts>, string][] = [
    ['aes-128-ecb', { algorithm: 'aes-128', mode: 'ecb', key: F.KEY16 }, F.RAW.aes128ecb],
    [
      'aes-128-cbc',
      { algorithm: 'aes-128', mode: 'cbc', key: F.KEY16, iv: F.IV16 },
      F.RAW.aes128cbc,
    ],
    [
      'aes-128-ctr',
      { algorithm: 'aes-128', mode: 'ctr', key: F.KEY16, iv: F.IV16 },
      F.RAW.aes128ctr,
    ],
    [
      'aes-128-cfb',
      { algorithm: 'aes-128', mode: 'cfb', key: F.KEY16, iv: F.IV16 },
      F.RAW.aes128cfb,
    ],
    [
      'aes-128-ofb',
      { algorithm: 'aes-128', mode: 'ofb', key: F.KEY16, iv: F.IV16 },
      F.RAW.aes128ofb,
    ],
    [
      'aes-192-cbc',
      { algorithm: 'aes-192', mode: 'cbc', key: F.KEY24, iv: F.IV16 },
      F.RAW.aes192cbc,
    ],
    [
      'aes-256-cbc',
      { algorithm: 'aes-256', mode: 'cbc', key: F.KEY32, iv: F.IV16 },
      F.RAW.aes256cbc,
    ],
    ['aes-256-ecb', { algorithm: 'aes-256', mode: 'ecb', key: F.KEY32 }, F.RAW.aes256ecb],
    ['des-ede3-cbc', { algorithm: '3des', mode: 'cbc', key: F.KEY24, iv: F.IV8 }, F.RAW.tdes3cbc],
    ['des-ede3-ecb', { algorithm: '3des', mode: 'ecb', key: F.KEY24 }, F.RAW.tdes3ecb],
    ['des-ede3-cfb', { algorithm: '3des', mode: 'cfb', key: F.KEY24, iv: F.IV8 }, F.RAW.tdes3cfb],
    ['des-ede3-ofb', { algorithm: '3des', mode: 'ofb', key: F.KEY24, iv: F.IV8 }, F.RAW.tdes3ofb],
    [
      'des-ede-cbc (two-key 3DES)',
      { algorithm: '3des', mode: 'cbc', key: F.KEY16, iv: F.IV8 },
      F.RAW.tdes2cbc,
    ],
    ['des-cbc', { algorithm: 'des', mode: 'cbc', key: F.IV8, iv: F.IV8 }, F.RAW.descbc],
    ['des-ecb', { algorithm: 'des', mode: 'ecb', key: F.IV8 }, F.RAW.desecb],
    ['rc4', { algorithm: 'rc4', key: F.KEY16 }, F.RAW.rc4],
    ['chacha20', { algorithm: 'chacha20', key: F.KEY32, iv: F.CHACHA_IV16 }, F.RAW.chacha20],
  ];

  it.each(raw)('%s with a raw key', async (_name, o, cipher) => {
    expect(await plain(fromHex(cipher), o)).toBe(F.PLAINTEXT);
    // And as hex text, the way it is pasted.
    expect(await plain(cipher, o)).toBe(F.PLAINTEXT);
  });

  it.each(raw)("%s: encrypting gives openssl's bytes", async (_name, o, cipher) => {
    expect(await encrypt(F.PLAINTEXT, o)).toBe(cipher);
  });

  const salted: [string, string, Partial<Opts>][] = [
    ['aes-256-cbc -pbkdf2 (SHA-256, 10000)', F.SALTED_PBKDF2, { kdf: 'pbkdf2' }],
    ['aes-256-cbc -md md5', F.SALTED_MD5, { kdf: 'openssl', kdfHash: 'md5' }],
    [
      'aes-256-cbc (SHA-256 EVP_BytesToKey, OpenSSL 1.1+ default)',
      F.SALTED_SHA256,
      { kdf: 'openssl', kdfHash: 'sha256' },
    ],
    [
      'aes-192-cbc -md sha1',
      F.SALTED_AES192_SHA1,
      { algorithm: 'aes-192', kdf: 'openssl', kdfHash: 'sha1' },
    ],
    [
      'aes-128-cbc -pbkdf2 -iter 1000 -md sha512',
      F.SALTED_PBKDF2_SHA512,
      { algorithm: 'aes-128', kdf: 'pbkdf2', kdfHash: 'sha512', iterations: 1000 },
    ],
    ['aes-128-ctr -pbkdf2', F.SALTED_CTR, { algorithm: 'aes-128', mode: 'ctr', kdf: 'pbkdf2' }],
    [
      'des-ede3-cbc -md md5',
      F.SALTED_3DES_MD5,
      { algorithm: '3des', kdf: 'openssl', kdfHash: 'md5' },
    ],
    ['rc4 -md md5', F.SALTED_RC4_MD5, { algorithm: 'rc4', kdf: 'openssl', kdfHash: 'md5' }],
  ];

  it.each(salted)('Salted__ %s', async (_name, blob, o) => {
    const out = await run(blob, { key: F.PASSPHRASE, ...o });
    expect(utf8Decode(bytesOf(out))).toBe(F.PLAINTEXT);
    expect(resultToText(out)).toContain('(from the Salted__ header)');
  });

  it('Salted__ as a binary file (what `openssl enc` writes without -a)', async () => {
    const file = fromBase64(F.SALTED_PBKDF2);
    expect(utf8Decode(file.subarray(0, 8))).toBe('Salted__');
    expect(await plain(file, { kdf: 'pbkdf2', key: F.PASSPHRASE })).toBe(F.PLAINTEXT);
  });

  it('a header-less file (-nosalt, or -S) needs no header and says so', async () => {
    const out = await run(F.NOSALT_MD5, { kdf: 'openssl', kdfHash: 'md5', key: F.PASSPHRASE });
    expect(utf8Decode(bytesOf(out))).toBe(F.PLAINTEXT);
    expect(hasNote(out, 'info', /No Salted__ header/)).toBe(true);
    // openssl enc -S writes the bare ciphertext: give the salt on the side.
    const bare = await run(F.PBKDF2_BODY_BASE64, {
      kdf: 'pbkdf2',
      key: F.PASSPHRASE,
      salt: F.PBKDF2_BODY_SALT_0011,
    });
    expect(utf8Decode(bytesOf(bare))).toBe(F.PLAINTEXT);
    expect(resultToText(bare)).toContain('0011223344556677 (from the Salt option)');
  });

  it('a wrong passphrase shows invalid padding, not an error', async () => {
    const out = await run(F.SALTED_PBKDF2, { kdf: 'pbkdf2', key: 'not-the-passphrase' });
    expect(hasNote(out, 'warn', /PKCS#7 padding is not valid/)).toBe(true);
    expect(resultToText(out)).toContain('Padding: PKCS#7: invalid');
  });

  it('a wrong digest is told apart from the right one by the padding', async () => {
    const md5 = await run(F.SALTED_MD5, { kdf: 'openssl', kdfHash: 'sha256', key: F.PASSPHRASE });
    expect(hasNote(md5, 'warn', /PKCS#7 padding is not valid/)).toBe(true);
  });

  it('noise offers the search, a right answer does not', async () => {
    const wrong = await run(fromHex(F.RAW.aes128ctr), {
      algorithm: 'aes-128',
      mode: 'ctr',
      key: '00'.repeat(16),
      iv: F.IV16,
    });
    expect(hasNote(wrong, 'info', /does not look like text/)).toBe(true);
    const search = wrong.find((x) => x.type === 'actions');
    expect(search?.type === 'actions' && search.actions[0]!.options).toEqual({ action: 'search' });
    const right = await run(fromHex(F.RAW.aes128ctr), {
      algorithm: 'aes-128',
      mode: 'ctr',
      key: F.KEY16,
      iv: F.IV16,
    });
    expect(right.find((x) => x.type === 'actions')).toBeUndefined();
  });

  it('rejects a silly iteration count', async () => {
    await expect(
      run(F.SALTED_PBKDF2, { kdf: 'pbkdf2', key: F.PASSPHRASE, iterations: 0 }),
    ).rejects.toThrow(/Iterations/);
    await expect(
      run(F.SALTED_PBKDF2, { kdf: 'pbkdf2', key: F.PASSPHRASE, iterations: 2.5 }),
    ).rejects.toThrow(/Iterations/);
  });

  it('a Salted__ file read with a raw key points to the OpenSSL option', async () => {
    const out = await run(F.SALTED_PBKDF2, { key: F.KEY32 });
    expect(hasNote(out, 'warn', /Salted__ header/)).toBe(true);
    const actions = out.find((x) => x.type === 'actions');
    expect(actions?.type === 'actions' && actions.actions.map((a) => a.options)).toEqual([
      { kdf: 'openssl' },
      { kdf: 'pbkdf2' },
    ]);
    await expect(run(F.SALTED_PBKDF2, { key: F.KEY16 })).rejects.toThrow(
      /Salted__ header: set Key derivation to OpenSSL enc/,
    );
  });
});

describe('encrypts like openssl enc', () => {
  it('-pbkdf2 body: same ciphertext as `openssl enc -S 0011223344556677`', async () => {
    const out = await run(F.PLAINTEXT, {
      action: 'encrypt',
      kdf: 'pbkdf2',
      key: F.PASSPHRASE,
      salt: F.PBKDF2_BODY_SALT_0011,
    });
    expect(textOf(out, 'Ciphertext (base64)')).toBe(F.PBKDF2_BODY_BASE64);
  });

  it('writes a Salted__ file (base64 like -a, 64 columns) that decrypts back', async () => {
    const out = await run(F.PLAINTEXT, {
      action: 'encrypt',
      kdf: 'pbkdf2',
      key: F.PASSPHRASE,
      salt: F.PBKDF2_BODY_SALT_0011,
    });
    const blob = textOf(out, 'OpenSSL file (Salted__, base64 like openssl enc -a)');
    expect(blob.startsWith('U2FsdGVkX1')).toBe(true);
    expect(blob.split('\n').every((l) => l.length <= 64)).toBe(true);
    expect(await plain(blob, { kdf: 'pbkdf2', key: F.PASSPHRASE })).toBe(F.PLAINTEXT);
    // The downloadable file starts with the header too.
    expect(utf8Decode(bytesOf(out, 'Ciphertext (file)').subarray(0, 8))).toBe('Salted__');
  });

  it('long plaintext wraps the base64 over several lines and still decrypts', async () => {
    const long = F.PLAINTEXT.repeat(10);
    const out = await run(long, {
      action: 'encrypt',
      kdf: 'openssl',
      kdfHash: 'md5',
      key: F.PASSPHRASE,
      salt: '0102030405060708',
    });
    const blob = textOf(out, 'OpenSSL file (Salted__, base64 like openssl enc -a)');
    expect(blob.split('\n').length).toBeGreaterThan(1);
    expect(await plain(blob, { kdf: 'openssl', kdfHash: 'md5', key: F.PASSPHRASE })).toBe(long);
  });

  it('no salt given: a fixed zero salt, with a note', async () => {
    const out = await run(F.PLAINTEXT, { action: 'encrypt', kdf: 'openssl', key: F.PASSPHRASE });
    expect(hasNote(out, 'info', /0000000000000000/)).toBe(true);
    await expect(
      run(F.PLAINTEXT, { action: 'encrypt', kdf: 'openssl', key: F.PASSPHRASE, salt: '0011' }),
    ).rejects.toThrow(/8-byte salt/);
  });

  it('is deterministic: same input and options, same output', async () => {
    const o = { action: 'encrypt', kdf: 'pbkdf2', key: F.PASSPHRASE } as const;
    expect(resultToText(await run(F.PLAINTEXT, o))).toBe(resultToText(await run(F.PLAINTEXT, o)));
  });
});

// ------------------------------------------------- differential: Node's crypto

describe('agrees with Node crypto on pseudo-random data', () => {
  const rnd = prng(0xc0ffee);
  const lengths = [1, 15, 16, 17, 31, 32, 100, 1000];
  const nodeName = (a: Algo, m: Mode) => `aes-${a.slice(4)}-${m}`;

  it.each(['aes-128', 'aes-192', 'aes-256'] as const)('%s, every mode', async (algorithm) => {
    for (const mode of MODES) {
      for (const n of lengths) {
        const key = rnd(Number(algorithm.slice(4)) / 8);
        const iv = rnd(mode === 'gcm' ? 12 : 16);
        const data = rnd(n);
        const name = nodeName(algorithm, mode);
        let expected: string;
        if (mode === 'gcm') {
          const c = createCipheriv(name as 'aes-128-gcm', key, iv);
          expected = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]).toString('hex');
        } else {
          const c = createCipheriv(name, key, mode === 'ecb' ? null : iv);
          expected = Buffer.concat([c.update(data), c.final()]).toString('hex');
        }
        const o = {
          algorithm,
          mode,
          key: toHex(key),
          iv: mode === 'ecb' ? '' : toHex(iv),
        } as const;
        expect(await encrypt(data, o), `${name} ${n}`).toBe(expected);
        expect(toHex(bytesOf(await run(fromHex(expected), o))), `${name} ${n} back`).toBe(
          toHex(data),
        );
      }
    }
  });

  it('3DES-CBC and -ECB', async () => {
    for (const mode of ['cbc', 'ecb'] as const) {
      for (const n of lengths) {
        const key = rnd(24);
        const iv = rnd(8);
        const data = rnd(n);
        const c = createCipheriv(`des-ede3-${mode}`, key, mode === 'ecb' ? null : iv);
        const expected = Buffer.concat([c.update(data), c.final()]).toString('hex');
        const o = {
          algorithm: '3des',
          mode,
          key: toHex(key),
          iv: mode === 'ecb' ? '' : toHex(iv),
        } as const;
        expect(await encrypt(data, o)).toBe(expected);
        expect(toHex(bytesOf(await run(fromHex(expected), o)))).toBe(toHex(data));
      }
    }
  });

  it('ChaCha20-Poly1305 with additional data, and bare ChaCha20', async () => {
    for (const n of lengths) {
      const key = rnd(32);
      const nonce = rnd(12);
      const data = rnd(n);
      const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
      c.setAAD(utf8Encode('header'), { plaintextLength: data.length });
      const expected = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]).toString('hex');
      const o = {
        algorithm: 'chacha20-poly1305',
        key: toHex(key),
        iv: toHex(nonce),
        aad: 'header',
      } as const;
      expect(await encrypt(data, o)).toBe(expected);
      expect(toHex(bytesOf(await run(fromHex(expected), o)))).toBe(toHex(data));

      const iv16 = rnd(16);
      const s = createCipheriv('chacha20', key, iv16);
      const stream = Buffer.concat([s.update(data), s.final()]).toString('hex');
      expect(await encrypt(data, { algorithm: 'chacha20', key: toHex(key), iv: toHex(iv16) })).toBe(
        stream,
      );
    }
  });

  it('decrypting padded CBC data Node produced (Node → tool)', async () => {
    const key = rnd(16);
    const iv = rnd(16);
    const c = createCipheriv('aes-128-cbc', key, iv);
    const sealed = Buffer.concat([c.update(F.PLAINTEXT), c.final()]);
    expect(await plain(sealed, { algorithm: 'aes-128', key: toHex(key), iv: toHex(iv) })).toBe(
      F.PLAINTEXT,
    );
    const back = createDecipheriv('aes-128-cbc', key, iv);
    const enc = await encrypt(F.PLAINTEXT, {
      algorithm: 'aes-128',
      key: toHex(key),
      iv: toHex(iv),
    });
    expect(Buffer.concat([back.update(Buffer.from(enc, 'hex')), back.final()]).toString()).toBe(
      F.PLAINTEXT,
    );
  });
});

describe('modes: every algorithm round-trips', () => {
  const rnd = prng(42);
  const keyLen: Record<Algo, number> = {
    'aes-128': 16,
    'aes-192': 24,
    'aes-256': 32,
    des: 8,
    '3des': 24,
    rc4: 7,
    chacha20: 32,
    'chacha20-poly1305': 32,
  };

  it.each(ALGOS)('%s', async (algorithm) => {
    for (const mode of isBlockCipher(algorithm) ? MODES : (['cbc'] as const)) {
      if (!supports(algorithm, mode)) continue;
      for (const padding of ['pkcs7', 'zero'] as const) {
        const data = utf8Encode('Find The Flag éè round trip ' + mode);
        // Zero padding cannot give back plaintext ending in NUL, none of these do.
        const key = toHex(rnd(keyLen[algorithm]));
        const iv = toHex(rnd(ivLength(algorithm, mode)));
        const o = { algorithm, mode, key, iv, padding } as const;
        const enc = await encrypt(data, o);
        expect(utf8Decode(bytesOf(await run(fromHex(enc), o)))).toBe(utf8Decode(data));
      }
    }
  });

  it('the generic modes agree with the library on AES (ECB, CBC, CFB, CTR)', () => {
    const key = rnd(32);
    const iv = rnd(16);
    const data = rnd(160);
    const c = blockCipher('aes-256', key);
    const lib = (mode: Mode, d: Uint8Array) =>
      encryptData({
        algo: 'aes-256',
        mode,
        key,
        iv,
        aad: new Uint8Array(),
        counter: 0,
        data: d,
        padding: 'none',
      }).output;
    expect(toHex(ecbCrypt(c, data, false))).toBe(toHex(lib('ecb', data)));
    expect(toHex(cbcCrypt(c, iv, data, false))).toBe(toHex(lib('cbc', data)));
    expect(toHex(cfbCrypt(c, iv, data.subarray(0, 157), false))).toBe(
      toHex(lib('cfb', data.subarray(0, 157))),
    );
    expect(toHex(ctrCrypt(c, iv, data.subarray(0, 157)))).toBe(
      toHex(lib('ctr', data.subarray(0, 157))),
    );
    expect(toHex(cbcCrypt(c, iv, cbcCrypt(c, iv, data, false), true))).toBe(toHex(data));
    expect(toHex(ofbCrypt(c, iv, ofbCrypt(c, iv, data)))).toBe(toHex(data));
  });
});

// -------------------------------------------------------------------- padding

describe('padding', () => {
  const o = { algorithm: 'aes-128', mode: 'cbc', key: F.KEY16, iv: F.IV16 } as const;

  it('reports valid PKCS#7 (the strong right-key signal) with the removed size', async () => {
    const out = await run(F.RAW.aes128cbc, o);
    expect(resultToText(out)).toContain('Padding: PKCS#7: valid, padding removed: 4');
    expect(hasNote(out, 'success', /Valid PKCS#7 padding/)).toBe(true);
  });

  it('wrong key: invalid padding, the raw bytes are shown', async () => {
    const out = await run(F.RAW.aes128cbc, { ...o, key: '00'.repeat(16) });
    expect(hasNote(out, 'warn', /not valid/)).toBe(true);
    expect(bytesOf(out)).toHaveLength(32);
  });

  it('zero and none padding', async () => {
    const zero = await encrypt(F.PLAINTEXT, { ...o, padding: 'zero' });
    expect(zero).toHaveLength(64);
    const back = await run(fromHex(zero), { ...o, padding: 'zero' });
    expect(utf8Decode(bytesOf(back))).toBe(F.PLAINTEXT);
    expect(resultToText(back)).toContain('zero padding, trailing zeros removed: 4');
    const none = await run(fromHex(zero), { ...o, padding: 'none' });
    expect(bytesOf(none)).toHaveLength(32);
    expect(resultToText(none)).toContain('Padding: none');
    await expect(run(F.PLAINTEXT, { ...o, action: 'encrypt', padding: 'none' })).rejects.toThrow(
      /whole blocks/,
    );
  });

  it('PKCS#7 pads a whole extra block when the data is already aligned', async () => {
    expect(await encrypt(new Uint8Array(16), { ...o, padding: 'pkcs7' })).toHaveLength(64);
    expect(await encrypt(new Uint8Array(16), { ...o, padding: 'zero' })).toHaveLength(32);
  });

  it('is not applicable to stream modes', async () => {
    const out = await run(F.RAW.aes128ctr, { ...o, mode: 'ctr' });
    expect(resultToText(out)).not.toContain('Padding:');
  });
});

// ---------------------------------------------------------- inputs and fields

describe('ciphertext input', () => {
  const cipher = F.RAW.aes128ecb;
  const o = { algorithm: 'aes-128', mode: 'ecb', key: F.KEY16 } as const;

  it('auto-detects hex (spaces, colons, newlines, upper case), base64 and raw', async () => {
    const spaced = cipher.replace(/(..)/g, '$1 ').trim().toUpperCase();
    const colons = cipher.replace(/(..)(?=.)/g, '$1:');
    const lines = `${cipher.slice(0, 32)}\n${cipher.slice(32)}\n`;
    for (const text of [cipher, spaced, colons, lines, toBase64(fromHex(cipher))]) {
      expect(await plain(text, o), text).toBe(F.PLAINTEXT);
    }
    expect(await plain(fromHex(cipher), o)).toBe(F.PLAINTEXT);
    const out = await run(spaced, o);
    expect(resultToText(out)).toContain('Ciphertext read as: hex (auto-detected)');
    expect(resultToText(await run(toBase64(fromHex(cipher)), o))).toContain(
      'base64 (auto-detected)',
    );
    expect(resultToText(await run(fromHex(cipher), o))).toContain('raw bytes (auto-detected)');
  });

  it('an explicit format is not second-guessed', async () => {
    expect(await plain(cipher, { ...o, inputFormat: 'hex' })).toBe(F.PLAINTEXT);
    expect(await plain(toBase64(fromHex(cipher)), { ...o, inputFormat: 'base64' })).toBe(
      F.PLAINTEXT,
    );
    const out = await run(fromHex(cipher), { ...o, inputFormat: 'raw' });
    expect(resultToText(out)).toContain('Ciphertext read as: raw bytes\n');
    await expect(run('not hex at all!', { ...o, inputFormat: 'hex' })).rejects.toThrow(
      /not valid hex/,
    );
    await expect(run('%%%%', { ...o, inputFormat: 'base64' })).rejects.toThrow(/not valid base64/);
  });

  it('classifies text without decoding the wrong way', () => {
    expect(readCiphertext(utf8Encode('deadbeef'), 'auto').format).toBe('hex');
    expect(readCiphertext(utf8Encode('0xdeadbeef'), 'auto').format).toBe('hex');
    expect(toHex(readCiphertext(utf8Encode('0xdeadbeef'), 'auto').data)).toBe('deadbeef');
    // Base64 may be wrapped over lines (openssl -a), but spaces make it prose, not base64.
    expect(readCiphertext(utf8Encode('U2FsdGVk\nX1+abc=\n'), 'auto').format).toBe('base64');
    expect(readCiphertext(utf8Encode('Hello World this is text'), 'auto').format).toBe('raw');
    expect(readCiphertext(utf8Encode('U2FsdGVkX1+abc='), 'auto').format).toBe('base64');
    expect(readCiphertext(Uint8Array.of(0, 1, 2, 3), 'auto').format).toBe('raw');
    expect(readCiphertext(utf8Encode('hello world, plain'), 'auto').format).toBe('raw');
  });

  it('reads multi-megabyte pasted hex and base64 text', () => {
    const data = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 7 + 3) & 255);
    const asHex = readCiphertext(utf8Encode(toHex(data)), 'auto');
    expect(asHex.format).toBe('hex');
    expect(asHex.data).toHaveLength(data.length);
    const asBase64 = readCiphertext(utf8Encode(toBase64(data)), 'auto');
    expect(asBase64.format).toBe('base64');
    expect(toHex(asBase64.data.subarray(0, 64))).toBe(toHex(data.subarray(0, 64)));
  });

  it('refuses empty input', async () => {
    await expect(run(new Uint8Array(), o)).rejects.toThrow(/No data/);
  });
});

describe('key, IV and format errors', () => {
  const cipher = fromHex(F.RAW.aes128cbc);

  it('names the key size and the algorithm that would take it', async () => {
    await expect(run(cipher, { algorithm: 'aes-256', key: F.KEY16, iv: F.IV16 })).rejects.toThrow(
      /AES-256 needs a 32-byte key, got 16\. Did you mean AES-128/,
    );
    await expect(run(cipher, { algorithm: 'aes-128', key: F.KEY32 })).rejects.toThrow(
      /AES-128 needs a 16-byte key, got 32\. Did you mean AES-256/,
    );
    await expect(run(cipher, { algorithm: '3des', key: F.KEY32 })).rejects.toThrow(
      /3DES needs a 24-byte or 16-byte key, got 32/,
    );
    await expect(run(cipher, { algorithm: 'des', key: F.KEY16 })).rejects.toThrow(
      /DES needs an 8-byte key, got 16/,
    );
    await expect(
      run(cipher, { algorithm: 'chacha20', key: F.KEY16, iv: '00'.repeat(12) }),
    ).rejects.toThrow(/ChaCha20 needs a 32-byte key/);
    await expect(run(cipher, { algorithm: 'rc4', key: '00'.repeat(300) })).rejects.toThrow(
      /RC4 needs a key of 1 to 256 bytes, got 300/,
    );
  });

  it('suggests another key format when that would fit', async () => {
    await expect(run(cipher, { algorithm: 'aes-256', key: F.KEY16, iv: F.IV16 })).rejects.toThrow(
      /Read as plain text, that key would be 32 bytes long/,
    );
    await expect(
      run(cipher, { algorithm: 'aes-128', key: F.KEY16, keyFormat: 'text', iv: F.IV16 }),
    ).rejects.toThrow(
      /AES-128 needs a 16-byte key, got 32\..*Read as hex, that key would be 16 bytes long/,
    );
    await expect(
      run(cipher, { algorithm: 'aes-128', key: 'k'.repeat(16), keyFormat: 'hex', iv: F.IV16 }),
    ).rejects.toThrow(/Key is not valid hex/);
  });

  it('reads the key as hex, base64 or text', async () => {
    const o = { algorithm: 'aes-128', mode: 'cbc', iv: F.IV16 } as const;
    const text = '0123456789abcdef';
    const c = await encrypt(F.PLAINTEXT, { ...o, key: text, keyFormat: 'text' });
    expect(c).toBe(
      await encrypt(F.PLAINTEXT, { ...o, key: toHex(utf8Encode(text)), keyFormat: 'hex' }),
    );
    expect(c).toBe(
      await encrypt(F.PLAINTEXT, { ...o, key: toBase64(utf8Encode(text)), keyFormat: 'base64' }),
    );
  });

  it('requires a key', async () => {
    await expect(run(cipher, { algorithm: 'aes-128', key: '' })).rejects.toThrow(/Enter the key/);
    await expect(run(cipher, { algorithm: 'aes-128', key: '  ' })).rejects.toThrow(/Enter the key/);
    await expect(run(cipher, { kdf: 'openssl', key: '' })).rejects.toThrow(/Enter the key/);
  });

  it('checks the IV size, and an empty IV is all zeros with a note', async () => {
    await expect(run(cipher, { algorithm: 'aes-128', key: F.KEY16, iv: '0011' })).rejects.toThrow(
      /AES-128-CBC needs an IV of 16 bytes, got 2/,
    );
    await expect(
      run(F.PLAINTEXT, { action: 'encrypt', algorithm: '3des', key: F.KEY24, iv: F.IV16 }),
    ).rejects.toThrow(/3DES-CBC needs an IV of 8 bytes, got 16/);
    const out = await run(cipher, { algorithm: 'aes-128', key: F.KEY16 });
    expect(hasNote(out, 'info', /all-zero IV/)).toBe(true);
    expect(resultToText(out)).toContain('(all zeros, no IV given)');
    expect(await encrypt(F.PLAINTEXT, { algorithm: 'aes-128', key: F.KEY16 })).toBe(
      await encrypt(F.PLAINTEXT, { algorithm: 'aes-128', key: F.KEY16, iv: '00'.repeat(16) }),
    );
  });

  it('reads the IV as text or base64', async () => {
    const o = { algorithm: 'aes-128', mode: 'cbc', key: F.KEY16 } as const;
    const iv = '0123456789abcdef';
    const a = await encrypt(F.PLAINTEXT, { ...o, iv, ivFormat: 'text' });
    expect(a).toBe(
      await encrypt(F.PLAINTEXT, { ...o, iv: toBase64(utf8Encode(iv)), ivFormat: 'base64' }),
    );
    expect(a).toBe(await encrypt(F.PLAINTEXT, { ...o, iv: toHex(utf8Encode(iv)) }));
  });

  it('IV in front of the data: taken off when decrypting, written when encrypting', async () => {
    const o = { algorithm: 'aes-128', mode: 'cbc', key: F.KEY16 } as const;
    const withIv = fromHex(F.IV16 + F.RAW.aes128cbc);
    const out = await run(withIv, { ...o, ivPrefix: true });
    expect(utf8Decode(bytesOf(out))).toBe(F.PLAINTEXT);
    expect(resultToText(out)).toContain('(first bytes of the data)');
    expect(await encrypt(F.PLAINTEXT, { ...o, iv: F.IV16, ivPrefix: true })).toBe(
      F.IV16 + F.RAW.aes128cbc,
    );
    await expect(run(new Uint8Array(4), { ...o, ivPrefix: true })).rejects.toThrow(
      /16 bytes of IV first/,
    );
  });

  it('ECB and RC4 take no IV, a stray one is ignored', async () => {
    expect(
      await plain(fromHex(F.RAW.aes128ecb), {
        algorithm: 'aes-128',
        mode: 'ecb',
        key: F.KEY16,
        iv: F.IV16,
      }),
    ).toBe(F.PLAINTEXT);
    expect(await plain(fromHex(F.RAW.rc4), { algorithm: 'rc4', key: F.KEY16, iv: F.IV16 })).toBe(
      F.PLAINTEXT,
    );
  });

  it('data that is not whole blocks says what to check', async () => {
    await expect(
      run(fromHex(F.RAW.aes128ctr), { algorithm: 'aes-128', key: F.KEY16, iv: F.IV16 }),
    ).rejects.toThrow(/AES-128-CBC works on whole blocks, and 28 bytes is not a multiple of 16/);
  });
});

// -------------------------------------------------------- key derivation

describe('key derivation', () => {
  const pass = utf8Encode(F.PASSPHRASE);
  const salt = fromHex('0011223344556677');

  it('EVP_BytesToKey matches the classic definition', async () => {
    const md5 = (b: Uint8Array) => createHash('md5').update(b).digest();
    const d1 = md5(Buffer.concat([pass, salt]));
    const d2 = md5(Buffer.concat([d1, pass, salt]));
    const d3 = md5(Buffer.concat([d2, pass, salt]));
    const expected = Buffer.concat([d1, d2, d3]).subarray(0, 48);
    expect(toHex(await evpBytesToKey(pass, salt, 'md5', 48))).toBe(expected.toString('hex'));
    // No salt: the salt is simply left out.
    expect(toHex(await evpBytesToKey(pass, null, 'md5', 16))).toBe(md5(pass).toString('hex'));
  });

  it('PBKDF2 agrees with RFC 6070 (HMAC-SHA-1) and Node', async () => {
    expect(toHex(await pbkdf2Hmac(utf8Encode('password'), utf8Encode('salt'), 'sha1', 2, 20))).toBe(
      'ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957',
    );
    const { pbkdf2Sync } = await import('node:crypto');
    for (const hash of ['md5', 'sha1', 'sha256', 'sha512'] as const) {
      expect(toHex(await pbkdf2Hmac(pass, salt, hash, 77, 48))).toBe(
        pbkdf2Sync(pass, salt, 77, 48, hash).toString('hex'),
      );
    }
  });

  it('passphrase hashed as the key: MD5 → AES-128, SHA-256 → AES-256, longer hash truncated', async () => {
    const o = { kdf: 'hash', key: 'hunter2', iv: F.IV16 } as const;
    const md5 = createHash('md5').update('hunter2').digest();
    const c = createCipheriv('aes-128-cbc', md5, Buffer.from(F.IV16, 'hex'));
    const sealed = Buffer.concat([c.update(F.PLAINTEXT), c.final()]);
    expect(await plain(sealed, { ...o, algorithm: 'aes-128', kdfHash: 'md5' })).toBe(F.PLAINTEXT);
    const sha = createHash('sha256').update('hunter2').digest();
    const c2 = createCipheriv('aes-256-cbc', sha, Buffer.from(F.IV16, 'hex'));
    const sealed2 = Buffer.concat([c2.update(F.PLAINTEXT), c2.final()]);
    expect(await plain(sealed2, { ...o, algorithm: 'aes-256', kdfHash: 'sha256' })).toBe(
      F.PLAINTEXT,
    );
    const sha1 = createHash('sha1').update('hunter2').digest();
    const c3 = createCipheriv('aes-128-cbc', sha1.subarray(0, 16), Buffer.from(F.IV16, 'hex'));
    const sealed3 = Buffer.concat([c3.update(F.PLAINTEXT), c3.final()]);
    expect(await plain(sealed3, { ...o, algorithm: 'aes-128', kdfHash: 'sha1' })).toBe(F.PLAINTEXT);
    await expect(run(sealed, { ...o, algorithm: 'aes-256', kdfHash: 'md5' })).rejects.toThrow(
      /MD5 gives 16 bytes but AES-256 needs a 32-byte key/,
    );
    expect(
      resultToText(await run(sealed, { ...o, algorithm: 'aes-128', kdfHash: 'md5' })),
    ).toContain('Key derivation: MD5 of the passphrase');
  });

  it('describes the derivation in the details', async () => {
    const out = await run(F.SALTED_PBKDF2, { kdf: 'pbkdf2', key: F.PASSPHRASE });
    const text = resultToText(out);
    expect(text).toContain('Key derivation: PBKDF2-HMAC-SHA-256, iterations: 10000');
    expect(text).toContain('(derived from the passphrase)');
    expect(
      resultToText(await run(F.SALTED_MD5, { kdf: 'openssl', kdfHash: 'md5', key: F.PASSPHRASE })),
    ).toContain('Key derivation: EVP_BytesToKey (MD5)');
  });
});

// --------------------------------------------------------------- try every mode

describe('try every mode', () => {
  const search = (input: Input, o: Partial<Opts>) => run(input, { action: 'search', ...o });
  const best = (out: Output[]) => {
    const b = out.find((x) => x.type === 'bytes' && x.label?.startsWith('Best guess'));
    if (b?.type !== 'bytes') throw new Error(`no best guess in:\n${resultToText(out)}`);
    return b;
  };

  it.each([
    ['aes-128-ecb', F.RAW.aes128ecb, 'Best guess: AES-128 ECB'],
    ['aes-128-cbc', F.RAW.aes128cbc, 'Best guess: AES-128 CBC'],
    ['aes-128-ctr', F.RAW.aes128ctr, 'Best guess: AES-128 CTR'],
    ['aes-128-cfb', F.RAW.aes128cfb, 'Best guess: AES-128 CFB'],
    ['aes-128-ofb', F.RAW.aes128ofb, 'Best guess: AES-128 OFB'],
  ])('finds %s from the key and the IV alone', async (_n, cipher, label) => {
    const out = await search(fromHex(cipher), { key: F.KEY16, iv: F.IV16 });
    expect(best(out).label).toBe(label);
    expect(utf8Decode(best(out).value)).toBe(F.PLAINTEXT);
  });

  it('finds the algorithm among those that take the key size', async () => {
    const a256 = await search(fromHex(F.RAW.aes256cbc), { key: F.KEY32, iv: F.IV16 });
    expect(best(a256).label).toBe('Best guess: AES-256 CBC');
    const a192 = await search(fromHex(F.RAW.aes192cbc), { key: F.KEY24, iv: F.IV16 });
    expect(best(a192).label).toBe('Best guess: AES-192 CBC');
    const des3 = await search(fromHex(F.RAW.tdes3cbc), { key: F.KEY24, iv: F.IV8 });
    expect(best(des3).label).toBe('Best guess: 3DES CBC');
    const des = await search(fromHex(F.RAW.descbc), { key: F.IV8, iv: F.IV8 });
    expect(best(des).label).toBe('Best guess: DES CBC');
    const rc4 = await search(fromHex(F.RAW.rc4), { key: F.KEY16 });
    expect(best(rc4).label).toBe('Best guess: RC4');
    const chacha = await search(fromHex(F.RAW.chacha20), { key: F.KEY32, iv: F.CHACHA_IV16 });
    expect(best(chacha).label).toBe('Best guess: ChaCha20');
  });

  it('with an empty IV, tries an all-zero IV', async () => {
    const c = await encrypt(F.PLAINTEXT, { algorithm: 'aes-128', mode: 'cbc', key: F.KEY16 });
    const out = await search(fromHex(c), { key: F.KEY16 });
    expect(best(out).label).toBe('Best guess: AES-128 CBC');
    expect(utf8Decode(best(out).value)).toBe(F.PLAINTEXT);
  });

  it('with only a passphrase, finds algorithm, mode and digest of an OpenSSL file', async () => {
    const cases: [string, string, string][] = [
      [F.SALTED_PBKDF2, 'Best guess: AES-256 CBC', 'SHA-256'],
      [F.SALTED_MD5, 'Best guess: AES-256 CBC', 'MD5'],
      [F.SALTED_AES192_SHA1, 'Best guess: AES-192 CBC', 'SHA-1'],
      [F.SALTED_CTR, 'Best guess: AES-128 CTR', 'SHA-256'],
      [F.SALTED_3DES_MD5, 'Best guess: 3DES CBC', 'MD5'],
      [F.SALTED_RC4_MD5, 'Best guess: RC4', 'MD5'],
    ];
    for (const [blob, label, hash] of cases) {
      // The derivation cannot be told from the blob: ask for -pbkdf2 only where it was used.
      const kdf = blob === F.SALTED_PBKDF2 || blob === F.SALTED_CTR ? 'pbkdf2' : 'openssl';
      const out = await search(blob, { kdf, key: F.PASSPHRASE });
      expect(best(out).label, blob).toBe(label);
      expect(utf8Decode(best(out).value), blob).toBe(F.PLAINTEXT);
      expect(resultToText(out), blob).toContain(hash);
    }
  });

  it('lists the ranking, offers to apply the best, and says what it did', async () => {
    const out = await search(fromHex(F.RAW.aes128cbc), { key: F.KEY16, iv: F.IV16 });
    const table = out.find((x) => x.type === 'table');
    expect(table?.type === 'table' && table.columns).toEqual([
      'Algorithm',
      'Mode',
      'Check',
      'Printable',
      'Readable',
      'Score',
      'Preview',
    ]);
    expect(table?.type === 'table' && table.rows[0]!.slice(0, 3)).toEqual([
      'AES-128',
      'CBC',
      'padding valid',
    ]);
    expect(table?.type === 'table' && table.highlight).toEqual([0]);
    const actions = out.find((x) => x.type === 'actions');
    expect(actions?.type === 'actions' && actions.actions[0]).toEqual({
      label: 'Use AES-128 CBC',
      options: { action: 'decrypt', algorithm: 'aes-128', mode: 'cbc', padding: 'pkcs7' },
      primary: true,
    });
    expect(hasNote(out, 'info', /Local search over the data you gave/)).toBe(true);
    expect(resultToText(out)).toContain('Key (hex): 000102030405060708090a0b0c0d0e0f');
  });

  it('applying a result (its options) reproduces the best guess', async () => {
    const out = await search(F.SALTED_MD5, { kdf: 'openssl', key: F.PASSPHRASE });
    const actions = out.find((x) => x.type === 'actions');
    if (actions?.type !== 'actions') throw new Error('no actions');
    const applied = actions.actions[0]!.options as Partial<Opts>;
    expect(await plain(F.SALTED_MD5, { kdf: 'openssl', key: F.PASSPHRASE, ...applied })).toBe(
      F.PLAINTEXT,
    );
  });

  it('warns when nothing looks right (wrong key) and does not claim a result', async () => {
    const out = await search(fromHex(F.RAW.aes128cbc), { key: '00'.repeat(16), iv: F.IV16 });
    expect(hasNote(out, 'warn', /No combination gave readable text/)).toBe(true);
    expect(out.find((x) => x.type === 'actions')).toBeUndefined();
  });

  it('GCM is part of the search for a 12-byte nonce, and a valid tag wins', async () => {
    const sealed = await encrypt(F.PLAINTEXT, {
      algorithm: 'aes-128',
      mode: 'gcm',
      key: F.KEY16,
      iv: '000102030405060708090a0b',
    });
    const out = await search(fromHex(sealed), { key: F.KEY16, iv: '000102030405060708090a0b' });
    expect(best(out).label).toBe('Best guess: AES-128 GCM');
    expect(resultToText(out)).toContain('tag valid');
  });

  it('a key no block cipher takes still tries RC4, and empty input is refused', async () => {
    const out = await search(fromHex(F.RAW.rc4), { key: F.KEY16.slice(0, 10) });
    expect(best(out).label).toBe('Best guess: RC4');
    await expect(search(new Uint8Array(), { key: F.KEY16 })).rejects.toThrow(/No data/);
    await expect(search(fromHex(F.RAW.rc4), { key: '' })).rejects.toThrow(/Enter the key/);
  });

  it('a dropped binary file with the IV in front', async () => {
    const out = await search(fromHex(F.IV16 + F.RAW.aes128cbc), { key: F.KEY16, ivPrefix: true });
    expect(best(out).label).toBe('Best guess: AES-128 CBC');
    expect(utf8Decode(best(out).value)).toBe(F.PLAINTEXT);
  });
});

// ------------------------------------------------------------------ the engine

describe('engine edge cases', () => {
  const base = { aad: new Uint8Array(), counter: 0, padding: 'pkcs7' } as const;

  it('encrypts and decrypts empty data with padding (one block of padding)', () => {
    const key = fromHex(F.KEY16);
    const iv = fromHex(F.IV16);
    const enc = encryptData({
      ...base,
      algo: 'aes-128',
      mode: 'cbc',
      key,
      iv,
      data: new Uint8Array(),
    });
    expect(enc.output).toHaveLength(16);
    const dec = decryptData({ ...base, algo: 'aes-128', mode: 'cbc', key, iv, data: enc.output });
    expect(dec.output).toHaveLength(0);
    expect(dec.padding).toBe('valid');
  });

  it('PKCS#7 validation: every byte of the padding must agree', () => {
    const key = fromHex(F.KEY16);
    const iv = fromHex(F.IV16);
    const forged = (block: number[]) =>
      encryptData({
        ...base,
        algo: 'aes-128',
        mode: 'ecb',
        key,
        iv,
        data: Uint8Array.from(block),
        padding: 'none',
      }).output;
    const dec = (c: Uint8Array) =>
      decryptData({ ...base, algo: 'aes-128', mode: 'ecb', key, iv, data: c });
    const pad = (n: number, fill = n) => [
      ...new Array<number>(16 - n).fill(65),
      ...new Array<number>(n).fill(fill),
    ];
    expect(dec(forged(pad(3))).padding).toBe('valid');
    expect(dec(forged(pad(16))).output).toHaveLength(0);
    expect(dec(forged([...new Array<number>(15).fill(65), 0])).padding).toBe('invalid');
    expect(dec(forged([...new Array<number>(15).fill(65), 17])).padding).toBe('invalid');
    expect(dec(forged([...new Array<number>(13).fill(65), 1, 3, 3])).padding).toBe('invalid');
  });

  it('supports() only rules out GCM on 64-bit blocks', () => {
    expect(supports('des', 'gcm')).toBe(false);
    expect(supports('3des', 'gcm')).toBe(false);
    expect(supports('aes-128', 'gcm')).toBe(true);
    expect(supports('rc4', 'gcm')).toBe(true);
  });
});

// ------------------------------------------------------------- triage and options

describe('triage and option visibility', () => {
  it('suggests the tool for OpenSSL Salted__ data, text or binary', () => {
    const asText = tool.detect?.({ text: F.SALTED_PBKDF2, bytes: utf8Encode(F.SALTED_PBKDF2) });
    expect(asText?.score).toBeGreaterThanOrEqual(0.9);
    expect(asText?.options).toEqual({ kdf: 'openssl' });
    const asFile = tool.detect?.({ text: null, bytes: fromBase64(F.SALTED_MD5) });
    expect(asFile?.score).toBeGreaterThanOrEqual(0.9);
    expect(tool.detect?.({ text: 'hello', bytes: utf8Encode('hello') })).toBeNull();
    expect(tool.detect?.({ text: null, bytes: fromHex(F.RAW.aes128cbc) })).toBeNull();
  });

  it('shows only the controls that matter', () => {
    const opts: OptionSpecs = tool.options ?? {};
    const visible = (v: Record<string, unknown>) =>
      Object.entries(opts)
        .filter(([, spec]) => !spec.showIf || spec.showIf({ ...defaults, ...v }))
        .map(([k]) => k);
    const raw = visible({});
    expect(raw).toEqual(
      expect.arrayContaining([
        'algorithm',
        'mode',
        'key',
        'keyFormat',
        'iv',
        'ivFormat',
        'padding',
      ]),
    );
    expect(raw).not.toContain('iterations');
    expect(raw).not.toContain('aad');
    const ecb = visible({ mode: 'ecb' });
    expect(ecb).not.toContain('iv');
    const pbkdf2 = visible({ kdf: 'pbkdf2' });
    expect(pbkdf2).toEqual(expect.arrayContaining(['kdfHash', 'iterations', 'salt']));
    expect(pbkdf2).not.toContain('iv');
    expect(pbkdf2).not.toContain('keyFormat');
    expect(visible({ mode: 'gcm' })).toContain('aad');
    expect(visible({ algorithm: 'chacha20' })).toContain('counter');
    expect(visible({ algorithm: 'rc4' })).not.toContain('mode');
    const search = visible({ action: 'search' });
    expect(search).not.toContain('algorithm');
    expect(search).not.toContain('padding');
    expect(search).toEqual(expect.arrayContaining(['iv', 'aad', 'inputFormat']));
    expect(visible({ action: 'encrypt' })).not.toContain('inputFormat');
  });
});
