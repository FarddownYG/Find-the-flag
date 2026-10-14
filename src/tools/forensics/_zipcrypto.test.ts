import { readFileSync } from 'node:fs';
import { inflateSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { concatBytes, utf8Encode } from '../../lib/bytes';
import { crc32 } from '../../lib/signatures';
import { ENCRYPTED_ZIP } from './_realfiles';
import { extractZipEntry, parseZip } from './_zip';
import { noise } from './_fixtures';
import {
  checkByteMatches,
  ZIPCRYPTO_HEADER,
  zipCryptoDecrypt,
  zipCryptoEncrypt,
} from './_zipcrypto';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

/** The encrypted flag.txt of the sample, as stored in the file. */
function lockedEntry(zip: Uint8Array) {
  const info = parseZip(zip)!;
  const e = info.entries.find((x) => x.encrypted)!;
  return { e, raw: zip.subarray(e.dataStart, e.dataStart + e.csize) };
}

describe('ZipCrypto', () => {
  const zip = sample('forensics-zipcrypto.zip');

  it('decrypts the sample with the right password: check byte, CRC and content', () => {
    const { e, raw } = lockedEntry(zip);
    expect(raw.length).toBe(e.csize);
    const { header, data } = zipCryptoDecrypt(raw, utf8Encode('infected'));
    expect(header).toHaveLength(ZIPCRYPTO_HEADER);
    expect(checkByteMatches(header, e.crc, e.dosTime, e.hasDescriptor)).toBe(true);
    const plain = inflateSync(data);
    expect(strFromU8(plain)).toBe('flag{zip_crypto}');
    expect(crc32(plain)).toBe(e.crc);
  });

  it('rejects wrong passwords, by the check byte or at the latest by the CRC', () => {
    const { e, raw } = lockedEntry(zip);
    for (const pw of ['', 'wrong', 'Infected', 'infecte', 'infected1', 'infected ', 'ünïcode']) {
      const { header, data } = zipCryptoDecrypt(raw, utf8Encode(pw));
      const passesCheck = checkByteMatches(header, e.crc, e.dosTime, e.hasDescriptor);
      let crcMatches = false;
      if (passesCheck) {
        try {
          crcMatches = crc32(inflateSync(data)) === e.crc;
        } catch {
          crcMatches = false;
        }
      }
      expect(crcMatches, `password "${pw}"`).toBe(false);
    }
    // and through the whole extraction path
    expect(extractZipEntry(zip, e, utf8Encode('infected'))).toMatchObject({
      problem: null,
      decrypted: true,
      crcOk: true,
    });
    expect(extractZipEntry(zip, e, utf8Encode('nope')).problem).toMatch(/wrong password/);
    expect(extractZipEntry(zip, e, null).problem).toMatch(/encrypted with ZipCrypto/);
  });

  it('opens a file written by Info-ZIP (the check byte comes from the DOS time there)', () => {
    const info = parseZip(ENCRYPTED_ZIP)!;
    const e = info.entries[0]!;
    expect(e.hasDescriptor).toBe(true);
    const r = extractZipEntry(ENCRYPTED_ZIP, e, utf8Encode('hunter2'));
    expect(r.data && strFromU8(r.data)).toBe('flag{real_zip_tool}');
    expect(extractZipEntry(ENCRYPTED_ZIP, e, utf8Encode('hunter')).problem).toMatch(
      /wrong password/,
    );
  });

  it('round-trips any data under any password', () => {
    for (const [size, pw] of [
      [0, 'a'],
      [1, ''],
      [100, 'password'],
      [5000, 'päss wörd ✓'],
    ] as const) {
      const plain = concatBytes(noise(12, size + 1), noise(size, size + 2));
      const password = utf8Encode(pw);
      const encrypted = zipCryptoEncrypt(plain, password);
      expect(encrypted).toHaveLength(plain.length);
      if (size > 0) expect(encrypted).not.toEqual(plain);
      const { header, data } = zipCryptoDecrypt(encrypted, password);
      expect(concatBytes(header, data)).toEqual(plain);
    }
  });

  it('accepts either check byte when sizes follow the data', () => {
    const header = new Uint8Array(12);
    header[11] = 0x12;
    expect(checkByteMatches(header, 0x12000000, 0x0000, false)).toBe(true);
    expect(checkByteMatches(header, 0x34000000, 0x1200, true)).toBe(true);
    expect(checkByteMatches(header, 0x12000000, 0x3400, true)).toBe(true);
    expect(checkByteMatches(header, 0x34000000, 0x5600, true)).toBe(false);
    expect(checkByteMatches(header, 0x34000000, 0x1200, false)).toBe(false);
  });
});
