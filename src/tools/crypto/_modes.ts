/**
 * Block-cipher modes of operation (NIST SP 800-38A) for any block cipher, without padding.
 * DES / 3DES use these; AES uses them only for OFB (the vetted library has no OFB) and in the
 * tests, which check them against the library's own ECB / CBC / CTR / CFB.
 */

export interface BlockCipher {
  readonly blockSize: number;
  /** Encrypt one block in place. */
  encryptBlock(block: Uint8Array): void;
  /** Decrypt one block in place. */
  decryptBlock(block: Uint8Array): void;
}

function wholeBlocks(c: BlockCipher, data: Uint8Array): void {
  if (data.length % c.blockSize !== 0) {
    throw new RangeError(`data must be a multiple of ${c.blockSize} bytes`);
  }
}

function checkIv(c: BlockCipher, iv: Uint8Array): void {
  if (iv.length !== c.blockSize) throw new RangeError(`IV must be ${c.blockSize} bytes`);
}

export function ecbCrypt(c: BlockCipher, data: Uint8Array, decrypt: boolean): Uint8Array {
  wholeBlocks(c, data);
  const bs = c.blockSize;
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(bs);
  for (let i = 0; i < data.length; i += bs) {
    block.set(data.subarray(i, i + bs));
    if (decrypt) c.decryptBlock(block);
    else c.encryptBlock(block);
    out.set(block, i);
  }
  return out;
}

export function cbcCrypt(
  c: BlockCipher,
  iv: Uint8Array,
  data: Uint8Array,
  decrypt: boolean,
): Uint8Array {
  wholeBlocks(c, data);
  checkIv(c, iv);
  const bs = c.blockSize;
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(bs);
  let prev = Uint8Array.from(iv);
  for (let i = 0; i < data.length; i += bs) {
    if (decrypt) {
      block.set(data.subarray(i, i + bs));
      c.decryptBlock(block);
      for (let j = 0; j < bs; j++) out[i + j] = block[j]! ^ prev[j]!;
      prev = data.slice(i, i + bs);
    } else {
      for (let j = 0; j < bs; j++) block[j] = data[i + j]! ^ prev[j]!;
      c.encryptBlock(block);
      out.set(block, i);
      prev = out.slice(i, i + bs);
    }
  }
  return out;
}

/** Full-block CFB (CFB-128 for AES, CFB-64 for DES); the last block may be short. */
export function cfbCrypt(
  c: BlockCipher,
  iv: Uint8Array,
  data: Uint8Array,
  decrypt: boolean,
): Uint8Array {
  checkIv(c, iv);
  const bs = c.blockSize;
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(bs);
  let feedback = Uint8Array.from(iv);
  for (let i = 0; i < data.length; i += bs) {
    block.set(feedback);
    c.encryptBlock(block);
    const n = Math.min(bs, data.length - i);
    for (let j = 0; j < n; j++) out[i + j] = data[i + j]! ^ block[j]!;
    feedback = (decrypt ? data : out).slice(i, i + bs);
    if (feedback.length < bs) break;
  }
  return out;
}

/** OFB: the same operation encrypts and decrypts. */
export function ofbCrypt(c: BlockCipher, iv: Uint8Array, data: Uint8Array): Uint8Array {
  checkIv(c, iv);
  const bs = c.blockSize;
  const out = new Uint8Array(data.length);
  const block = Uint8Array.from(iv);
  for (let i = 0; i < data.length; i += bs) {
    c.encryptBlock(block);
    const n = Math.min(bs, data.length - i);
    for (let j = 0; j < n; j++) out[i + j] = data[i + j]! ^ block[j]!;
  }
  return out;
}

/** CTR with the whole block as a big-endian counter (what OpenSSL and the AES-CTR APIs do). */
export function ctrCrypt(c: BlockCipher, counter: Uint8Array, data: Uint8Array): Uint8Array {
  checkIv(c, counter);
  const bs = c.blockSize;
  const out = new Uint8Array(data.length);
  const ctr = Uint8Array.from(counter);
  const block = new Uint8Array(bs);
  for (let i = 0; i < data.length; i += bs) {
    block.set(ctr);
    c.encryptBlock(block);
    const n = Math.min(bs, data.length - i);
    for (let j = 0; j < n; j++) out[i + j] = data[i + j]! ^ block[j]!;
    for (let j = bs - 1; j >= 0; j--) {
      ctr[j] = (ctr[j]! + 1) & 0xff;
      if (ctr[j] !== 0) break;
    }
  }
  return out;
}
