/**
 * Engine of the Symmetric ciphers tool: algorithms and modes, padding, key derivation (OpenSSL
 * `enc`, PBKDF2, hashed passphrase) and the parsing of keys / IVs / ciphertext. No UI here.
 *
 * AES (ECB, CBC, CTR, CFB, GCM) and ChaCha20 / Poly1305 come from @noble/ciphers (audited, MIT).
 * What it lacks is written here and tested against the published vectors: DES / 3DES (_des.ts),
 * RC4 (_rc4.ts), and OFB, via the generic modes of _modes.ts.
 */
import {
  cbc as aesCbc,
  cfb as aesCfb,
  ctr as aesCtr,
  ecb as aesEcb,
  gcm as aesGcm,
  unsafe as aesUnsafe,
} from '@noble/ciphers/aes.js';
import {
  chacha20,
  chacha20orig,
  chacha20poly1305,
  xchacha20,
  xchacha20poly1305,
} from '@noble/ciphers/chacha.js';
import { createMD5, createSHA1, createSHA256, createSHA512, pbkdf2, type IHasher } from 'hash-wasm';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import {
  concatBytes,
  fromBase64,
  fromHex,
  latin1Decode,
  u32le,
  utf8Decode,
  utf8Encode,
} from '../../lib/bytes';
import { Des, TripleDes } from './_des';
import { cbcCrypt, cfbCrypt, ctrCrypt, ecbCrypt, ofbCrypt, type BlockCipher } from './_modes';
import { rc4 } from './_rc4';

const T = toolT('symmetric');

// ------------------------------------------------------------------ algorithms

export const ALGOS = [
  'aes-128',
  'aes-192',
  'aes-256',
  'des',
  '3des',
  'rc4',
  'chacha20',
  'chacha20-poly1305',
] as const;
export type Algo = (typeof ALGOS)[number];

export const MODES = ['ecb', 'cbc', 'ctr', 'cfb', 'ofb', 'gcm'] as const;
export type Mode = (typeof MODES)[number];

export type Padding = 'pkcs7' | 'zero' | 'none';
export type Hash = 'md5' | 'sha1' | 'sha256' | 'sha512';
export type Kdf = 'raw' | 'openssl' | 'pbkdf2' | 'hash';

export const HASHES: readonly Hash[] = ['md5', 'sha1', 'sha256', 'sha512'];

export const ALGO_NAME: Record<Algo, string> = {
  'aes-128': 'AES-128',
  'aes-192': 'AES-192',
  'aes-256': 'AES-256',
  des: 'DES',
  '3des': '3DES',
  rc4: 'RC4',
  chacha20: 'ChaCha20',
  'chacha20-poly1305': 'ChaCha20-Poly1305',
};

export const MODE_NAME: Record<Mode, string> = {
  ecb: 'ECB',
  cbc: 'CBC',
  ctr: 'CTR',
  cfb: 'CFB',
  ofb: 'OFB',
  gcm: 'GCM',
};

export const HASH_NAME: Record<Hash, string> = {
  md5: 'MD5',
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  sha512: 'SHA-512',
};

export const isAes = (a: Algo): boolean => a === 'aes-128' || a === 'aes-192' || a === 'aes-256';
export const isBlockCipher = (a: Algo): boolean => isAes(a) || a === 'des' || a === '3des';
export const blockSizeOf = (a: Algo): number =>
  isAes(a) ? 16 : a === 'des' || a === '3des' ? 8 : 0;
/** Authenticated encryption: the ciphertext ends with a 16-byte tag. */
export const isAead = (a: Algo, m: Mode): boolean =>
  a === 'chacha20-poly1305' || (isAes(a) && m === 'gcm');
/** Modes that pad the plaintext to whole blocks. */
export const isPadded = (a: Algo, m: Mode): boolean =>
  isBlockCipher(a) && (m === 'ecb' || m === 'cbc');
/** Does this algorithm use the mode option at all? */
export const usesMode = isBlockCipher;
/** GCM needs a 128-bit block cipher; the stream ciphers have no mode. */
export const supports = (a: Algo, m: Mode): boolean => !isBlockCipher(a) || m !== 'gcm' || isAes(a);

const KEY_LENGTHS: Record<Algo, readonly number[]> = {
  'aes-128': [16],
  'aes-192': [24],
  'aes-256': [32],
  des: [8],
  '3des': [24, 16],
  rc4: [],
  chacha20: [32],
  'chacha20-poly1305': [32],
};

export const acceptsKey = (a: Algo, n: number): boolean =>
  a === 'rc4' ? n >= 1 && n <= 256 : KEY_LENGTHS[a].includes(n);

/** Key length asked of a passphrase derivation (what `openssl enc -<cipher>` uses). */
export const DERIVED_KEY: Record<Algo, number> = {
  'aes-128': 16,
  'aes-192': 24,
  'aes-256': 32,
  des: 8,
  '3des': 24,
  rc4: 16,
  chacha20: 32,
  'chacha20-poly1305': 32,
};

/** The IV length a mode wants. 0 = none. */
export function ivLength(a: Algo, m: Mode): number {
  if (a === 'rc4') return 0;
  if (a === 'chacha20' || a === 'chacha20-poly1305') return 12;
  if (m === 'ecb') return 0;
  if (m === 'gcm') return 12;
  return blockSizeOf(a);
}

/** The IV length `openssl enc` takes out of the derived material (ChaCha20: counter + nonce). */
export const derivedIvLength = (a: Algo, m: Mode): number =>
  a === 'chacha20' ? 16 : ivLength(a, m);

export function usesIv(a: Algo, m: Mode): boolean {
  return ivLength(a, m) > 0;
}

// ---------------------------------------------------------------------- checks

const FIELD_NAME: Record<'key' | 'iv' | 'salt' | 'aad', () => string> = {
  key: () => T('field.key'),
  iv: () => T('field.iv'),
  salt: () => T('field.salt'),
  aad: () => T('field.aad'),
};

/** Names of the text formats of keys, IVs and ciphertext (the format words stay untranslated). */
export const FORMAT_NAME: Record<'hex' | 'base64' | 'text' | 'raw', () => string> = {
  hex: () => T('format.hex'),
  base64: () => T('format.base64'),
  text: () => T('format.text'),
  raw: () => T('format.raw'),
};

/** ToolError for a key of the wrong size, naming the algorithm that would accept it. */
export function checkKey(algo: Algo, key: Uint8Array, hint = ''): void {
  if (acceptsKey(algo, key.length)) return;
  const name = ALGO_NAME[algo];
  const lens = KEY_LENGTHS[algo];
  const base =
    algo === 'rc4'
      ? T('error.keyRc4', { got: key.length })
      : algo === 'des'
        ? T('error.keyDes', { got: key.length })
        : lens.length === 1
          ? T('error.keyOne', { algo: name, need: lens[0]!, got: key.length })
          : T('error.keyTwo', { algo: name, a: lens[0]!, b: lens[1]!, got: key.length });
  const others = ALGOS.filter((a) => a !== algo && a !== 'rc4' && acceptsKey(a, key.length));
  const maybe = others.length
    ? ` ${T('error.didYouMean', { algos: others.map((a) => ALGO_NAME[a]).join(' / ') })}`
    : '';
  throw new ToolError(`${base}${maybe}${hint ? ` ${hint}` : ''}`);
}

export function checkIv(algo: Algo, mode: Mode, iv: Uint8Array): void {
  const need = ivLength(algo, mode);
  if (need === 0) return;
  const name = isBlockCipher(algo) ? `${ALGO_NAME[algo]}-${MODE_NAME[mode]}` : ALGO_NAME[algo];
  if (algo === 'chacha20') {
    if (![8, 12, 16, 24].includes(iv.length)) {
      throw new ToolError(T('error.ivChaCha', { got: iv.length }));
    }
  } else if (algo === 'chacha20-poly1305') {
    if (iv.length !== 12 && iv.length !== 24) {
      throw new ToolError(T('error.ivPoly', { got: iv.length }));
    }
  } else if (mode === 'gcm') {
    if (iv.length < 8) throw new ToolError(T('error.ivGcm', { got: iv.length }));
  } else if (iv.length !== need) {
    throw new ToolError(T('error.iv', { name, need, got: iv.length }));
  }
}

/** Throws a ToolError when the algorithm / mode / key / IV combination cannot run. */
export function validate(algo: Algo, mode: Mode, key: Uint8Array, iv: Uint8Array, hint = ''): void {
  if (!supports(algo, mode)) throw new ToolError(T('error.gcmBlock', { algo: ALGO_NAME[algo] }));
  checkKey(algo, key, hint);
  checkIv(algo, mode, iv);
}

// ------------------------------------------------------------ the raw operation

export interface CryptParams {
  algo: Algo;
  mode: Mode;
  key: Uint8Array;
  iv: Uint8Array;
  /** Additional authenticated data (GCM, ChaCha20-Poly1305). */
  aad: Uint8Array;
  /** First block counter (ChaCha20 with a 12-byte or 24-byte nonce). */
  counter: number;
}

export type TagStatus = 'valid' | 'invalid' | null;

function aesBlock(key: Uint8Array): BlockCipher {
  const enc = aesUnsafe.expandKeyLE(key);
  const dec = aesUnsafe.expandKeyDecLE(key);
  return {
    blockSize: 16,
    encryptBlock: (b) => void aesUnsafe.encryptBlock(enc, b),
    decryptBlock: (b) => void aesUnsafe.decryptBlock(dec, b),
  };
}

/** The block cipher object of an algorithm; the modes run on top of it (see _modes.ts). */
export function blockCipher(algo: Algo, key: Uint8Array): BlockCipher {
  if (isAes(algo)) return aesBlock(key);
  if (algo === 'des') return new Des(key);
  if (algo === '3des') return new TripleDes(key);
  throw new ToolError(T('error.notBlock', { algo: ALGO_NAME[algo] }));
}

function wholeBlocks(p: CryptParams, data: Uint8Array): void {
  const bs = blockSizeOf(p.algo);
  if (data.length % bs !== 0) {
    throw new ToolError(
      T('error.blockLength', {
        name: `${ALGO_NAME[p.algo]}-${MODE_NAME[p.mode]}`,
        size: data.length,
        block: bs,
      }),
    );
  }
}

function aesRaw(p: CryptParams, data: Uint8Array, decrypt: boolean): Uint8Array {
  const noPad = { disablePadding: true };
  switch (p.mode) {
    case 'ecb': {
      wholeBlocks(p, data);
      const c = aesEcb(p.key, noPad);
      return decrypt ? c.decrypt(data) : c.encrypt(data);
    }
    case 'cbc': {
      wholeBlocks(p, data);
      const c = aesCbc(p.key, p.iv, noPad);
      return decrypt ? c.decrypt(data) : c.encrypt(data);
    }
    case 'ctr':
      return aesCtr(p.key, p.iv).encrypt(data);
    case 'cfb': {
      const c = aesCfb(p.key, p.iv);
      return decrypt ? c.decrypt(data) : c.encrypt(data);
    }
    case 'ofb':
      return ofbCrypt(aesBlock(p.key), p.iv, data);
    case 'gcm':
      throw new ToolError(T('error.notBlock', { algo: ALGO_NAME[p.algo] }));
  }
}

function desRaw(p: CryptParams, data: Uint8Array, decrypt: boolean): Uint8Array {
  const c = blockCipher(p.algo, p.key);
  switch (p.mode) {
    case 'ecb':
      wholeBlocks(p, data);
      return ecbCrypt(c, data, decrypt);
    case 'cbc':
      wholeBlocks(p, data);
      return cbcCrypt(c, p.iv, data, decrypt);
    case 'ctr':
      return ctrCrypt(c, p.iv, data);
    case 'cfb':
      return cfbCrypt(c, p.iv, data, decrypt);
    case 'ofb':
      return ofbCrypt(c, p.iv, data);
    case 'gcm':
      throw new ToolError(T('error.gcmBlock', { algo: ALGO_NAME[p.algo] }));
  }
}

/** ChaCha20 as the libraries call it: the nonce length picks the variant. */
function chachaStream(p: CryptParams, data: Uint8Array): Uint8Array {
  if (!Number.isInteger(p.counter) || p.counter < 0 || p.counter > 0xffffffff) {
    throw new ToolError(T('error.counter'));
  }
  const n = p.iv.length;
  if (n === 16) return chacha20(p.key, p.iv.slice(4), data, undefined, u32le(p.iv, 0));
  if (n === 8) return chacha20orig(p.key, p.iv, data, undefined, p.counter);
  if (n === 24) return xchacha20(p.key, p.iv, data, undefined, p.counter);
  return chacha20(p.key, p.iv, data, undefined, p.counter);
}

const TAG = 16;

/** Encrypt without padding. AEAD output is ciphertext followed by the 16-byte tag. */
export function encryptRaw(p: CryptParams, data: Uint8Array): Uint8Array {
  if (p.algo === 'rc4') return rc4(p.key, data);
  if (p.algo === 'chacha20') return chachaStream(p, data);
  if (p.algo === 'chacha20-poly1305') {
    const make = p.iv.length === 24 ? xchacha20poly1305 : chacha20poly1305;
    return make(p.key, p.iv, p.aad).encrypt(data);
  }
  if (p.mode === 'gcm') return aesGcm(p.key, p.iv, p.aad).encrypt(data);
  return isAes(p.algo) ? aesRaw(p, data, false) : desRaw(p, data, false);
}

/**
 * Decrypt without removing padding. For AEAD the last 16 bytes are the tag: when it does not
 * verify, the data is still decrypted (the keystream does not depend on the tag), so a CTF
 * challenge with a damaged or forged tag stays readable, and `tag` says 'invalid'.
 */
export function decryptRaw(p: CryptParams, data: Uint8Array): { data: Uint8Array; tag: TagStatus } {
  if (p.algo === 'rc4') return { data: rc4(p.key, data), tag: null };
  if (p.algo === 'chacha20') return { data: chachaStream(p, data), tag: null };
  if (isAead(p.algo, p.mode)) {
    if (data.length < TAG) throw new ToolError(T('error.tagMissing', { size: data.length }));
    const poly = p.algo === 'chacha20-poly1305';
    const body = data.subarray(0, data.length - TAG);
    try {
      const plain = poly
        ? (p.iv.length === 24 ? xchacha20poly1305 : chacha20poly1305)(p.key, p.iv, p.aad).decrypt(
            data,
          )
        : aesGcm(p.key, p.iv, p.aad).decrypt(data);
      return { data: plain, tag: 'valid' };
    } catch {
      // Authentication failed: the tag, the AAD, the nonce or the key is wrong. Decrypt anyway
      // where the counter stream is easy to rebuild (block 1 for the ChaCha family, nonce || 2
      // for a 96-bit GCM nonce).
      if (poly) {
        const stream = p.iv.length === 24 ? xchacha20 : chacha20;
        return { data: stream(p.key, p.iv, body, undefined, 1), tag: 'invalid' };
      }
      if (p.iv.length === 12) {
        const counter = concatBytes(p.iv, Uint8Array.of(0, 0, 0, 2));
        return { data: aesCtr(p.key, counter).decrypt(body), tag: 'invalid' };
      }
      throw new ToolError(T('error.gcmTag'));
    }
  }
  return {
    data: isAes(p.algo) ? aesRaw(p, data, true) : desRaw(p, data, true),
    tag: null,
  };
}

// --------------------------------------------------------------------- padding

export type PadStatus = 'valid' | 'invalid' | 'zeros' | 'none' | 'n/a';

export function addPadding(data: Uint8Array, bs: number, kind: Padding): Uint8Array {
  if (kind === 'pkcs7') {
    const n = bs - (data.length % bs);
    const out = new Uint8Array(data.length + n);
    out.set(data);
    out.fill(n, data.length);
    return out;
  }
  const rest = data.length % bs;
  if (kind === 'zero') {
    if (rest === 0) return data;
    const out = new Uint8Array(data.length + bs - rest);
    out.set(data);
    return out;
  }
  if (rest !== 0) throw new ToolError(T('error.needsPadding', { size: data.length, block: bs }));
  return data;
}

/** Strip padding and say whether it was well-formed (PKCS#7) or how much was removed (zero). */
export function removePadding(
  data: Uint8Array,
  bs: number,
  kind: Padding,
): { data: Uint8Array; status: PadStatus; removed: number } {
  if (kind === 'none') return { data, status: 'none', removed: 0 };
  if (kind === 'zero') {
    let end = data.length;
    while (end > 0 && data[end - 1] === 0) end--;
    return { data: data.subarray(0, end), status: 'zeros', removed: data.length - end };
  }
  const n = data[data.length - 1] ?? 0;
  let ok = n >= 1 && n <= bs && n <= data.length;
  for (let i = 1; ok && i <= n; i++) if (data[data.length - i] !== n) ok = false;
  return ok
    ? { data: data.subarray(0, data.length - n), status: 'valid', removed: n }
    : { data, status: 'invalid', removed: 0 };
}

// ------------------------------------------------------- decrypt / encrypt data

export interface DecryptInput extends CryptParams {
  data: Uint8Array;
  padding: Padding;
}

export interface DecryptOutcome {
  /** The plaintext: unpadded when the padding was valid, otherwise as decrypted. */
  output: Uint8Array;
  padding: PadStatus;
  removed: number;
  tag: TagStatus;
}

export function decryptData(i: DecryptInput, hint = ''): DecryptOutcome {
  validate(i.algo, i.mode, i.key, i.iv, hint);
  const raw = decryptRaw(i, i.data);
  if (!isPadded(i.algo, i.mode)) {
    return { output: raw.data, padding: 'n/a', removed: 0, tag: raw.tag };
  }
  const un = removePadding(raw.data, blockSizeOf(i.algo), i.padding);
  return { output: un.data, padding: un.status, removed: un.removed, tag: null };
}

export interface EncryptInput extends CryptParams {
  data: Uint8Array;
  padding: Padding;
}

export function encryptData(
  i: EncryptInput,
  hint = '',
): { output: Uint8Array; added: number; tag: Uint8Array | null } {
  validate(i.algo, i.mode, i.key, i.iv, hint);
  const padded = isPadded(i.algo, i.mode)
    ? addPadding(i.data, blockSizeOf(i.algo), i.padding)
    : i.data;
  const out = encryptRaw(i, padded);
  return {
    output: out,
    added: padded.length - i.data.length,
    tag: isAead(i.algo, i.mode) ? out.slice(out.length - TAG) : null,
  };
}

// ----------------------------------------------------------- key derivation

const HASHER: Record<Hash, () => Promise<IHasher>> = {
  md5: createMD5,
  sha1: createSHA1,
  sha256: createSHA256,
  sha512: createSHA512,
};

/** Hash of the passphrase (what "passphrase hashed as key" uses). */
export async function digestOf(pass: Uint8Array, hash: Hash): Promise<Uint8Array> {
  const h = await HASHER[hash]();
  h.init();
  h.update(pass);
  return h.digest('binary').slice();
}

/** OpenSSL's EVP_BytesToKey with one iteration: D1 = H(pass || salt), Di = H(D(i-1) || pass || salt). */
export async function evpBytesToKey(
  pass: Uint8Array,
  salt: Uint8Array | null,
  hash: Hash,
  length: number,
): Promise<Uint8Array> {
  const h = await HASHER[hash]();
  const parts: Uint8Array[] = [];
  let have = 0;
  let prev = new Uint8Array();
  while (have < length) {
    h.init();
    h.update(prev);
    h.update(pass);
    if (salt) h.update(salt);
    prev = h.digest('binary').slice();
    parts.push(prev);
    have += prev.length;
  }
  return concatBytes(...parts).slice(0, length);
}

export async function pbkdf2Hmac(
  pass: Uint8Array,
  salt: Uint8Array,
  hash: Hash,
  iterations: number,
  length: number,
): Promise<Uint8Array> {
  if (!Number.isInteger(iterations) || iterations < 1) throw new ToolError(T('error.iterations'));
  return pbkdf2({
    password: pass,
    salt,
    iterations,
    hashLength: length,
    hashFunction: HASHER[hash](),
    outputType: 'binary',
  });
}

export interface Derivation {
  kdf: Exclude<Kdf, 'raw'>;
  hash: Hash;
  iterations: number;
  /** null: no salt (`openssl enc -nosalt`). */
  salt: Uint8Array | null;
}

/** The bytes a derivation produces from a passphrase: key, then IV, for the longest need. */
export async function deriveStream(
  d: Derivation,
  pass: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (d.kdf === 'hash') return digestOf(pass, d.hash);
  if (d.kdf === 'openssl') return evpBytesToKey(pass, d.salt, d.hash, length);
  return pbkdf2Hmac(pass, d.salt ?? new Uint8Array(), d.hash, d.iterations, length);
}

/** Split derived bytes into the key and the IV of an algorithm (the IV is empty for kdf 'hash'). */
export function splitKeyIv(
  d: Derivation,
  stream: Uint8Array,
  algo: Algo,
  mode: Mode,
): { key: Uint8Array; iv: Uint8Array | null } {
  const keyLen = DERIVED_KEY[algo];
  if (d.kdf === 'hash') {
    if (stream.length < keyLen) {
      throw new ToolError(
        T('error.hashShort', {
          hash: HASH_NAME[d.hash],
          have: stream.length,
          algo: ALGO_NAME[algo],
          need: keyLen,
        }),
      );
    }
    return { key: stream.slice(0, keyLen), iv: null };
  }
  const ivLen = derivedIvLength(algo, mode);
  return { key: stream.slice(0, keyLen), iv: stream.slice(keyLen, keyLen + ivLen) };
}

/** Longest key + IV any algorithm needs from a derivation. */
export const MAX_DERIVED = 48;

export const SALTED = utf8Encode('Salted__');

/** The `Salted__` + 8-byte salt header of `openssl enc` output. */
export function splitSalted(data: Uint8Array): { salt: Uint8Array; body: Uint8Array } | null {
  if (data.length < 16) return null;
  for (let i = 0; i < SALTED.length; i++) if (data[i] !== SALTED[i]) return null;
  return { salt: data.slice(8, 16), body: data.subarray(16) };
}

// ------------------------------------------------------------- text <-> bytes

export type FieldFormat = 'hex' | 'base64' | 'text';

/** Key / IV / salt / AAD text to bytes in the chosen format. */
export function parseField(
  value: string,
  format: FieldFormat,
  field: 'key' | 'iv' | 'salt' | 'aad',
): Uint8Array {
  if (format === 'text') return utf8Encode(value);
  try {
    return format === 'hex' ? fromHex(value) : fromBase64(value);
  } catch (e) {
    if (e instanceof ToolError) {
      throw new ToolError(
        T('error.fieldFormat', {
          field: FIELD_NAME[field](),
          format: FORMAT_NAME[format](),
          reason: e.message,
        }),
      );
    }
    throw e;
  }
}

export type InFormat = 'auto' | 'hex' | 'base64' | 'raw';
export interface CipherRead {
  data: Uint8Array;
  format: 'hex' | 'base64' | 'raw';
  auto: boolean;
}

const isHexDigit = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isBase64Char = (c: number) =>
  (c >= 48 && c <= 57) ||
  (c >= 65 && c <= 90) ||
  (c >= 97 && c <= 122) ||
  c === 43 ||
  c === 47 ||
  c === 45 ||
  c === 95;

/**
 * How many hex digits the text holds when it is nothing but hex digits, with an optional 0x and
 * spaces, newlines, colons or commas between them; -1 otherwise. One pass without a regex, so a
 * multi-megabyte paste cannot overflow the regex engine's stack.
 */
function hexDigitCount(text: string): number {
  let n = 0;
  for (let i = /^0x/i.test(text) ? 2 : 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isHexDigit(c)) n++;
    else if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 58 && c !== 44) return -1;
  }
  return n;
}

/**
 * How many base64 characters (padding apart) the text holds when it is base64 as openssl enc -a
 * writes it: the alphabet in lines, no spaces, up to two = at the very end; -1 otherwise.
 */
function base64CharCount(text: string): number {
  let end = text.length;
  while (end > 0 && text.length - end < 2 && text.charCodeAt(end - 1) === 61) end--;
  let n = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (isBase64Char(c)) n++;
    else if (c !== 10 && c !== 13) return -1;
  }
  return n;
}

/** Ciphertext as pasted or opened: hex or base64 text (auto-detected by default), or raw bytes. */
export function readCiphertext(bytes: Uint8Array, format: InFormat): CipherRead {
  if (format === 'raw') return { data: bytes, format: 'raw', auto: false };
  if (format === 'hex' || format === 'base64') {
    try {
      const text = utf8Decode(bytes);
      return {
        data: format === 'hex' ? fromHex(text) : fromBase64(text),
        format,
        auto: false,
      };
    } catch (e) {
      if (e instanceof ToolError) {
        throw new ToolError(
          T('error.cipherFormat', { format: FORMAT_NAME[format](), reason: e.message }),
        );
      }
      throw e;
    }
  }
  // Auto: only text can be hex or base64 (a binary file is read as it is).
  const isText =
    bytes.length > 0 &&
    bytes.every((b) => (b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13);
  if (isText) {
    const text = latin1Decode(bytes).trim();
    const digits = hexDigitCount(text);
    if (digits >= 2 && digits % 2 === 0) {
      return { data: fromHex(text), format: 'hex', auto: true };
    }
    const chars = base64CharCount(text);
    if (chars >= 4 && chars % 4 !== 1) {
      return { data: fromBase64(text.replace(/[\r\n]+/g, '')), format: 'base64', auto: true };
    }
  }
  return { data: bytes, format: 'raw', auto: true };
}

/** OpenSSL `-a` output: base64 wrapped at 64 columns. */
export function wrapBase64(b64: string, width = 64): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width));
  return lines.join('\n');
}
