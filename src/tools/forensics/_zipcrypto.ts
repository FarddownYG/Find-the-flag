/**
 * Traditional PKWARE encryption ("ZipCrypto"), the password scheme of classic ZIP files.
 * It is a stream cipher driven by three 32-bit keys; this is only for opening the user's own
 * files with a password they supply. WinZip AES is a different scheme and is not handled here.
 */
import { crc32Step } from '../../lib/signatures';

/** Length of the random header that precedes every encrypted entry. */
export const ZIPCRYPTO_HEADER = 12;

class Keys {
  private k0 = 0x12345678;
  private k1 = 0x23456789;
  private k2 = 0x34567890;

  constructor(password: Uint8Array) {
    for (const c of password) this.update(c);
  }

  update(byte: number): void {
    this.k0 = crc32Step(this.k0, byte);
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    this.k2 = crc32Step(this.k2, this.k1 >>> 24);
  }

  /** Next byte of the key stream. */
  stream(): number {
    const t = (this.k2 | 2) & 0xffff;
    return ((t * (t ^ 1)) >>> 8) & 0xff;
  }
}

/** Decrypt an entry's stored bytes (12-byte header + data). Returns the header and the data. */
export function zipCryptoDecrypt(
  encrypted: Uint8Array,
  password: Uint8Array,
): { header: Uint8Array; data: Uint8Array } {
  const keys = new Keys(password);
  const plain = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    const p = encrypted[i]! ^ keys.stream();
    keys.update(p);
    plain[i] = p;
  }
  return { header: plain.subarray(0, ZIPCRYPTO_HEADER), data: plain.subarray(ZIPCRYPTO_HEADER) };
}

/** Encrypt `plain` (which must already start with the 12 header bytes). Used by the tests. */
export function zipCryptoEncrypt(plain: Uint8Array, password: Uint8Array): Uint8Array {
  const keys = new Keys(password);
  const out = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) {
    out[i] = plain[i]! ^ keys.stream();
    keys.update(plain[i]!);
  }
  return out;
}

/**
 * The last header byte is a check value: the top byte of the CRC-32, or (when the sizes
 * follow in a data descriptor) the top byte of the DOS time. It rules out about 255 of 256
 * wrong passwords before any data is touched; the CRC-32 of the result settles the rest.
 */
export function checkByteMatches(
  header: Uint8Array,
  crc: number,
  dosTime: number,
  hasDescriptor: boolean,
): boolean {
  const last = header[ZIPCRYPTO_HEADER - 1];
  const fromCrc = (crc >>> 24) & 0xff;
  const fromTime = (dosTime >>> 8) & 0xff;
  return hasDescriptor ? last === fromTime || last === fromCrc : last === fromCrc;
}
