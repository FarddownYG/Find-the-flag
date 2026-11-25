import { cbc } from '@noble/ciphers/aes.js';
import { encode as encodePng } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { fromHex, toHex, utf8Encode } from '../../lib/bytes';
import {
  buildConstruct,
  decryptWithIv,
  deriveIv,
  encrypt,
  HEADER_MODELS,
  padTo16,
  parseKey,
  testKey,
  windowKeys,
} from './_angecryption';

// A fabricated 24x24 PNG, zero-padded to whole blocks.
function makePng(): Uint8Array {
  const w = 24;
  const data = new Uint8Array(w * w * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 5)) & 0xff;
  return padTo16(encodePng({ width: w, height: w, data, channels: 3, depth: 8 }));
}

const KEY = utf8Encode('FTF-angecrypt-16');
const IV = fromHex('0314253647586970819aabbccddeeff0');
const png = makePng();
const cipher = encrypt(png, KEY, IV);

describe('raw AES-CBC (no padding)', () => {
  it('matches the NIST SP 800-38A CBC-AES128 vector', () => {
    const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c');
    const iv = fromHex('000102030405060708090a0b0c0d0e0f');
    const pt = fromHex('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51');
    expect(toHex(encrypt(pt, key, iv))).toBe(
      '7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2',
    );
  });

  it('refuses a length that is not a whole number of blocks', () => {
    expect(() => encrypt(new Uint8Array(17), KEY, IV)).toThrow();
  });
});

describe('testKey (no IV)', () => {
  it('accepts the right key with at least two strong signatures', () => {
    const r = testKey(cipher, KEY);
    expect(r.ok).toBe(true);
    expect(r.signatures.length).toBeGreaterThanOrEqual(2);
    expect(r.signatures).toContain('png-idat');
    expect(r.signatures).toContain('png-iend');
  });

  it('does not depend on the IV used to encrypt', () => {
    const other = encrypt(png, KEY, new Uint8Array(16).fill(0x5a));
    expect(testKey(other, KEY).ok).toBe(true);
  });

  it('rejects wrong keys (same length, other length, near miss)', () => {
    const wrong = [
      utf8Encode('FTF-angecrypt-17'),
      utf8Encode('0123456789abcdef'),
      utf8Encode('FTF-angecrypt-16-and-more!!'.slice(0, 24)),
      new Uint8Array(32),
    ];
    for (const k of wrong) expect(testKey(cipher, k)).toEqual({ ok: false, signatures: [] });
  });

  it('gives no false positive on 300 random keys', () => {
    let state = 12345;
    const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0);
    for (let n = 0; n < 300; n++) {
      const k = new Uint8Array(16).map(() => next() >>> 24);
      expect(testKey(cipher, k).ok).toBe(false);
    }
  });

  it('is not fooled by a plaintext PNG, nor by a single token', () => {
    expect(testKey(png, KEY).ok).toBe(false);
    // a body where only one strong token survives decryption stays rejected
    const one = new Uint8Array(160);
    one.set(utf8Encode('endobj'), 40);
    const enc = cbc(KEY, IV, { disablePadding: true }).encrypt(one);
    const r = testKey(enc, KEY);
    expect(r.signatures).toEqual(['pdf-endobj']);
    expect(r.ok).toBe(false);
  });

  it('recognises a PDF-shaped body with two keywords', () => {
    const body = new Uint8Array(192);
    body.set(utf8Encode('endobj\nstartxref'), 50);
    const r = testKey(cbc(KEY, IV, { disablePadding: true }).encrypt(body), KEY);
    expect(r.ok).toBe(true);
    expect(r.signatures).toEqual(['pdf-endobj', 'pdf-xref']);
  });
});

describe('IV derivation and decryption', () => {
  it('derives the exact IV from the PNG header model', () => {
    const png16 = HEADER_MODELS.find((m) => m.id === 'png')!.header;
    expect(toHex(png.subarray(0, 16))).toBe(toHex(png16));
    expect(toHex(deriveIv(cipher, KEY, png16))).toBe(toHex(IV));
  });

  it('round-trips to the original PNG', () => {
    const iv = deriveIv(cipher, KEY, png.subarray(0, 16));
    expect(toHex(decryptWithIv(cipher, KEY, iv))).toBe(toHex(png));
  });

  it('works for AES-192 and AES-256 too', () => {
    for (const size of [24, 32]) {
      const key = new Uint8Array(size).map((_, i) => i + 1);
      const c = encrypt(png, key, IV);
      expect(testKey(c, key).ok).toBe(true);
      expect(toHex(deriveIv(c, key, png.subarray(0, 16)))).toBe(toHex(IV));
    }
  });
});

describe('building the construct', () => {
  it('starts with the cover header and decrypts to the hidden file', () => {
    const cover = HEADER_MODELS.find((m) => m.id === 'jpeg')!.header;
    const { cipher: built, iv } = buildConstruct(png, KEY, cover);
    expect(toHex(built.subarray(0, 16))).toBe(toHex(cover));
    expect(toHex(decryptWithIv(built, KEY, iv))).toBe(toHex(png));
    expect(testKey(built, KEY).ok).toBe(true);
  });
});

describe('candidates', () => {
  it('parses hex and text keys, refuses bad lengths', () => {
    expect(parseKey('00112233445566778899aabbccddeeff')!.length).toBe(16);
    expect(toHex(parseKey('FTF-angecrypt-16')!)).toBe(toHex(KEY));
    expect(parseKey('short')).toBeNull();
    expect(parseKey('')).toBeNull();
  });

  it('cuts windows of 16, 24 and 32 bytes, bounded', () => {
    const w = windowKeys(new Uint8Array(100), 10);
    expect(w).toHaveLength(10);
    expect(new Set(w.map((x) => x.key.length))).toEqual(new Set([16, 24, 32]));
    expect(windowKeys(new Uint8Array(15))).toHaveLength(0);
  });
});
