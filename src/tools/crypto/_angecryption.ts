/**
 * Engine of the AngeCryption tool (Ange Albertini's AES-CBC polyglots). No UI here.
 *
 * AES comes from @noble/ciphers (MIT, audited), in its raw CBC / ECB form with the PKCS#7 layer
 * disabled: the buffers are whole numbers of 16-byte blocks. Nothing here is a home-made cipher.
 *
 * The whole idea rests on one property of CBC: P_i = D_K(C_i) XOR C_(i-1), with C_0 = IV. For every
 * block but the first, C_(i-1) is part of the file, so the plaintext of blocks 2..n does not depend
 * on the IV. That lets us test a key on blocks 2..n alone, and only then derive the IV that turns
 * block 1 into the header of the hidden file: IV = D_K(C_1) XOR P1_target.
 */
import { cbc, ecb } from '@noble/ciphers/aes.js';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { concatBytes, fromHex, utf8Encode } from '../../lib/bytes';
import { crc32 } from '../../lib/signatures';

const T = toolT('angecryption');

export const BLOCK = 16;
/** AES-128, AES-192, AES-256. */
export const KEY_SIZES: readonly number[] = [16, 24, 32];
/** A key is tested on at most this many blocks of the body (8 KiB) ... */
const HEAD_BLOCKS = 512;
/** ... plus this many blocks at the very end of the file (512 B), where IEND / EOCD sit. */
const TAIL_BLOCKS = 32;

// ---------------------------------------------------------------------------------------------
// Raw CBC / ECB (no padding)
// ---------------------------------------------------------------------------------------------

function checkKey(key: Uint8Array): void {
  if (!KEY_SIZES.includes(key.length)) throw new ToolError(T('err.keyLength', { n: key.length }));
}

function checkBlocks(data: Uint8Array): void {
  if (data.length % BLOCK !== 0) throw new ToolError(T('err.notBlocks', { n: data.length }));
}

/** Zero-pad to a whole number of 16-byte blocks (raw CBC has no padding scheme of its own). */
export function padTo16(data: Uint8Array): Uint8Array {
  const rest = data.length % BLOCK;
  if (rest === 0 && data.length > 0) return data;
  const out = new Uint8Array(rest === 0 ? BLOCK : data.length + BLOCK - rest);
  out.set(data);
  return out;
}

/** AES-CBC encryption without padding: `plain` must be a multiple of 16 bytes (see padTo16). */
export function encrypt(plain: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  checkKey(key);
  checkBlocks(plain);
  if (iv.length !== BLOCK) throw new ToolError(T('err.ivLength', { n: iv.length }));
  return cbc(key, iv, { disablePadding: true }).encrypt(plain);
}

/** AES-CBC decryption without padding of a whole number of blocks. */
export function decryptWithIv(cipher: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  checkKey(key);
  checkBlocks(cipher);
  if (iv.length !== BLOCK) throw new ToolError(T('err.ivLength', { n: iv.length }));
  return cbc(key, iv, { disablePadding: true }).decrypt(cipher);
}

/** D_K(C_1): block 1 passed through the block cipher alone (before the IV is XORed in). */
function decryptFirstBlock(cipher: Uint8Array, key: Uint8Array): Uint8Array {
  checkKey(key);
  if (cipher.length < BLOCK) throw new ToolError(T('err.tooShort'));
  return ecb(key, { disablePadding: true }).decrypt(cipher.subarray(0, BLOCK));
}

/** The IV that makes block 1 decrypt to `targetHeader` (its first 16 bytes). */
export function deriveIv(
  cipher: Uint8Array,
  key: Uint8Array,
  targetHeader: Uint8Array,
): Uint8Array {
  if (targetHeader.length !== BLOCK) throw new ToolError(T('err.headerLength'));
  const d = decryptFirstBlock(cipher, key);
  const iv = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) iv[i] = d[i]! ^ targetHeader[i]!;
  return iv;
}

/** Plaintext of blocks [from, to) (from >= 1), whatever the IV: block from-1 is the chaining value. */
function decryptRange(cipher: Uint8Array, key: Uint8Array, from: number, to: number): Uint8Array {
  if (to <= from) return new Uint8Array(0);
  const iv = cipher.subarray((from - 1) * BLOCK, from * BLOCK);
  return cbc(key, iv, { disablePadding: true }).decrypt(cipher.subarray(from * BLOCK, to * BLOCK));
}

// ---------------------------------------------------------------------------------------------
// Header models: the first 16 bytes of the hidden file
// ---------------------------------------------------------------------------------------------

export interface HeaderModel {
  /** Family id, the prefix of the signature ids ("png" for "png-idat"). */
  id: string;
  name: string;
  ext: string;
  mime: string;
  /** Exactly 16 bytes. */
  header: Uint8Array;
  /** How many leading bytes are certain for every file of the format; the rest is a typical value. */
  certain: number;
}

const bytes = (...v: number[]) => Uint8Array.from(v);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

export const HEADER_MODELS: readonly HeaderModel[] = [
  {
    id: 'png',
    name: 'PNG image',
    ext: 'png',
    mime: 'image/png',
    // signature + IHDR length (13) + "IHDR": the same 16 bytes in every PNG
    header: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, ...ascii('IHDR')),
    certain: 16,
  },
  {
    id: 'jpeg',
    name: 'JPEG image',
    ext: 'jpg',
    mime: 'image/jpeg',
    // SOI, APP0 (length 16) "JFIF\0", version 1.01, no units, density 1:1 (the common JFIF start)
    header: bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1),
    certain: 11,
  },
  {
    id: 'gif',
    name: 'GIF image',
    ext: 'gif',
    mime: 'image/gif',
    // "GIF89a", then a 16x16 screen with a 2-colour table: only "GIF89a" is certain
    header: bytes(...ascii('GIF89a'), 0x10, 0, 0x10, 0, 0x80, 0, 0, 0, 0, 0),
    certain: 6,
  },
  {
    id: 'pdf',
    name: 'PDF document',
    ext: 'pdf',
    mime: 'application/pdf',
    // "%PDF-1.4", newline, the binary-marker comment, newline, "1"
    header: bytes(...ascii('%PDF-1.4\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x31),
    certain: 5,
  },
  {
    id: 'zip',
    name: 'ZIP archive',
    ext: 'zip',
    mime: 'application/zip',
    // local file header: "PK\3\4", version 2.0, no flags, deflate, zero date and time
    header: bytes(0x50, 0x4b, 3, 4, 0x14, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0),
    certain: 4,
  },
];

export const modelFor = (id: string): HeaderModel | undefined =>
  HEADER_MODELS.find((m) => m.id === id);

/** Overlay a hex header (1 to 16 bytes) on a model, or on zeros when there is no model. */
export function customHeader(hex: string, base?: HeaderModel): Uint8Array {
  const clean = hex.replace(/0x/gi, '').replace(/[\s:,_-]/g, '');
  if (clean === '' || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) {
    throw new ToolError(T('err.badHeaderHex'));
  }
  const given = fromHex(clean);
  if (given.length > BLOCK) throw new ToolError(T('err.headerTooLong'));
  const out = new Uint8Array(BLOCK);
  if (base) out.set(base.header);
  out.set(given);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Key test without the IV: blocks 2..n and their strong signatures
// ---------------------------------------------------------------------------------------------

interface Token {
  id: string;
  pat: number[];
  /** Extra structural check at the match position `i` of the buffer `b`. */
  check?: (b: Uint8Array, i: number, total: number) => boolean;
}

const u32be = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u16le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8)) >>> 0;

/**
 * A PNG chunk whose 4-letter type starts at `i`: its length sits just before and its CRC after
 * the data. When the whole chunk is inside the buffer the CRC must be right; a long IDAT that
 * runs past the buffer is accepted on a plausible length alone.
 */
function pngChunk(b: Uint8Array, i: number, total: number, wholeOnly: boolean): boolean {
  if (i < 4) return false;
  const len = u32be(b, i - 4);
  if (len > total) return false;
  const end = i + 4 + len + 4;
  if (end <= b.length) return crc32(b.subarray(i, i + 4 + len)) === u32be(b, i + 4 + len);
  return !wholeOnly;
}

const PNG_TAGS = [
  'PLTE',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'bKGD',
  'pHYs',
  'tIME',
  'tEXt',
  'zTXt',
  'iTXt',
  'sBIT',
  'eXIf',
];

const TOKENS: Token[] = [
  { id: 'png-idat', pat: ascii('IDAT'), check: (b, i, n) => pngChunk(b, i, n, false) },
  {
    // the CRC of an empty IEND is a constant
    id: 'png-iend',
    pat: [...ascii('IEND'), 0xae, 0x42, 0x60, 0x82],
  },
  ...PNG_TAGS.map((tag) => ({
    id: 'png-chunk',
    pat: ascii(tag),
    check: (b: Uint8Array, i: number, n: number) => pngChunk(b, i, n, true),
  })),
  { id: 'jpeg-dqt', pat: [0xff, 0xdb, 0x00, 0x43, 0x00] },
  { id: 'jpeg-sof', pat: [0xff, 0xc0, 0x00, 0x11, 0x08] },
  { id: 'jpeg-sof', pat: [0xff, 0xc2, 0x00, 0x11, 0x08] },
  { id: 'jpeg-dht', pat: [0xff, 0xc4, 0x00, 0x1f, 0x00] },
  { id: 'jpeg-dht', pat: [0xff, 0xc4, 0x00, 0xb5, 0x10] },
  { id: 'jpeg-sos', pat: [0xff, 0xda, 0x00, 0x0c, 0x03, 0x01] },
  { id: 'jpeg-sos', pat: [0xff, 0xda, 0x00, 0x08, 0x01, 0x01] },
  {
    id: 'gif-gce',
    pat: [0x21, 0xf9, 0x04],
    check: (b, i) => i + 7 < b.length && b[i + 7] === 0 && (b[i + 3]! & 0xe0) === 0,
  },
  { id: 'gif-netscape', pat: ascii('NETSCAPE2.0') },
  { id: 'pdf-endobj', pat: ascii('endobj') },
  { id: 'pdf-endstream', pat: ascii('endstream') },
  { id: 'pdf-xref', pat: ascii('startxref') },
  { id: 'pdf-eof', pat: ascii('%%EOF') },
  {
    id: 'zip-local',
    pat: [0x50, 0x4b, 3, 4],
    check: (b, i) =>
      i + 30 <= b.length && b[i + 4]! <= 63 && b[i + 5] === 0 && u16le(b, i + 26) > 0,
  },
  {
    id: 'zip-central',
    pat: [0x50, 0x4b, 1, 2],
    check: (b, i) => i + 46 <= b.length && b[i + 4]! <= 63 && u16le(b, i + 28) > 0,
  },
  {
    id: 'zip-eocd',
    pat: [0x50, 0x4b, 5, 6],
    check: (b, i) =>
      i + 22 <= b.length &&
      b[i + 4] === 0 &&
      b[i + 5] === 0 &&
      b[i + 6] === 0 &&
      b[i + 7] === 0 &&
      i + 22 + u16le(b, i + 20) <= b.length,
  },
];

/** TOKENS indexed by their first byte: one pass over the buffer instead of one per token. */
const BY_FIRST: Token[][] = (() => {
  const t: Token[][] = Array.from({ length: 256 }, () => []);
  for (const tok of TOKENS) t[tok.pat[0]!]!.push(tok);
  return t;
})();

function scan(b: Uint8Array, total: number, found: Set<string>): void {
  for (let i = 0; i < b.length; i++) {
    const list = BY_FIRST[b[i]!]!;
    for (const tok of list) {
      if (found.has(tok.id) || i + tok.pat.length > b.length) continue;
      let hit = true;
      for (let k = 1; k < tok.pat.length; k++) {
        if (b[i + k] !== tok.pat[k]) {
          hit = false;
          break;
        }
      }
      if (hit && (!tok.check || tok.check(b, i, total))) found.add(tok.id);
    }
  }
}

export interface KeyTest {
  ok: boolean;
  /** Ids of the strong signatures found in blocks 2..n ("png-idat", "png-iend", ...). */
  signatures: string[];
}

/** A key is accepted only when the body carries at least this many distinct strong signatures. */
export const MIN_SIGNATURES = 2;

/**
 * Does decrypting `cipher` with `key` give a body made of a known file format? The IV is not
 * needed: blocks 2..n chain on the ciphertext. Looks at the start of the body (8 KiB) and at the
 * last blocks of the file, and accepts only two or more distinct, structurally checked signatures
 * (PNG chunks with a valid CRC, JPEG DQT/SOF/DHT/SOS, ZIP records, PDF keywords, ...): one stray
 * token or a few matching bytes is never enough.
 */
export function testKey(cipher: Uint8Array, key: Uint8Array): KeyTest {
  checkKey(key);
  const n = Math.floor(cipher.length / BLOCK);
  if (n < 2) return { ok: false, signatures: [] };
  const found = new Set<string>();
  const headEnd = Math.min(n, 1 + HEAD_BLOCKS);
  scan(decryptRange(cipher, key, 1, headEnd), cipher.length, found);
  if (headEnd < n) {
    scan(decryptRange(cipher, key, Math.max(headEnd, n - TAIL_BLOCKS), n), cipher.length, found);
  }
  const signatures = [...found].sort();
  return { ok: signatures.length >= MIN_SIGNATURES, signatures };
}

/** Format family of a signature id list ("png" for ["png-iend", "png-idat"]), by majority. */
export function familyOf(signatures: string[]): string | null {
  const count = new Map<string, number>();
  for (const s of signatures) {
    const f = s.split('-')[0]!;
    count.set(f, (count.get(f) ?? 0) + 1);
  }
  let best: string | null = null;
  let top = 0;
  for (const [f, c] of count) {
    if (c > top) {
      best = f;
      top = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------

export type KeyFormat = 'auto' | 'text' | 'hex';

/** A key from text: hex when it looks like 32/48/64 hex digits (auto), otherwise UTF-8. */
export function parseKey(raw: string, format: KeyFormat = 'auto'): Uint8Array | null {
  const s = raw.replace(/\r$/, '').trim();
  if (s === '') return null;
  const hexForm = s.replace(/^0x/i, '').replace(/[\s:_-]/g, '');
  const isHex = /^[0-9a-f]+$/i.test(hexForm) && hexForm.length % 2 === 0;
  let key: Uint8Array | null;
  if (format === 'hex') key = isHex ? fromHex(hexForm) : null;
  else if (format === 'text') key = utf8Encode(raw.replace(/\r$/, ''));
  else key = isHex && KEY_SIZES.includes(hexForm.length / 2) ? fromHex(hexForm) : utf8Encode(s);
  return key && KEY_SIZES.includes(key.length) ? key : null;
}

/** Cap on the number of lines read from an imported list. */
export const MAX_LIST = 200_000;
/** Cap on the number of keys cut from the file itself. */
export const MAX_WINDOWS = 6000;

/**
 * Keys cut from the file itself: every 16, 24 and 32-byte window, one offset at a time from the
 * start (a key hidden in a comment or a header sits near the front), at most `max` keys.
 */
export function windowKeys(file: Uint8Array, max = MAX_WINDOWS): { key: Uint8Array; at: number }[] {
  const out: { key: Uint8Array; at: number }[] = [];
  for (let at = 0; at + 16 <= file.length && out.length < max; at++) {
    for (const size of KEY_SIZES) {
      if (at + size > file.length || out.length >= max) continue;
      out.push({ key: file.slice(at, at + size), at });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Building the construct
// ---------------------------------------------------------------------------------------------

/**
 * The Angecryption construct: C = cover_header || CBC-Encrypt(P[16:], key, iv = cover_header),
 * with IV = D_K(cover_header) XOR P[0:16]. Decrypting C with (key, IV) gives back `plain`, and the
 * first 16 bytes of C are those of the cover file. `plain` is zero-padded to whole blocks. The rest
 * of C looks like noise: hiding it inside a structure the cover format ignores (a PNG comment
 * chunk with its CRC fixed, ...) is not done here.
 */
export function buildConstruct(
  plain: Uint8Array,
  key: Uint8Array,
  coverHeader: Uint8Array,
): { cipher: Uint8Array; iv: Uint8Array; plain: Uint8Array } {
  if (coverHeader.length !== BLOCK) throw new ToolError(T('err.headerLength'));
  const padded = padTo16(plain);
  const iv = deriveIv(coverHeader, key, padded.subarray(0, BLOCK));
  // deriveIv decrypts block 1 of its first argument: here the cover header stands for C_1
  const rest = encrypt(padded.subarray(BLOCK), key, coverHeader);
  return { cipher: concatBytes(coverHeader, rest), iv, plain: padded };
}

// ---------------------------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------------------------

/** Shannon entropy in bits per byte. */
export function entropy(b: Uint8Array): number {
  if (b.length === 0) return 0;
  const count = new Array<number>(256).fill(0);
  for (const x of b) count[x]!++;
  let h = 0;
  for (const c of count) {
    if (c === 0) continue;
    const p = c / b.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Does the buffer look like AES output (uniform bytes)? The entropy of `n` uniform bytes is a bit
 * under 8 bits (about 8 - 255 / (2 n ln 2)); the test allows a small margin below that.
 */
export function looksRandom(b: Uint8Array): boolean {
  if (b.length < 64) return false;
  const expected = 8 - 255 / (2 * b.length * Math.LN2);
  return entropy(b) >= Math.min(7.9, expected) - 0.3;
}
