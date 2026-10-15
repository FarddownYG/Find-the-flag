/**
 * The standard security handler of PDF (ISO 32000-1 7.6 and ISO 32000-2 7.6), user password only:
 * RC4 40 / 128 bit (V 1-3, R 2-3), crypt filters with RC4 or AES-128 (V 4, R 4), AES-256 (V 5, R 5
 * and R 6). The owner password and public-key handlers are not supported. A stream or string is
 * decrypted with a key made from the file key and the object number (or the file key itself for
 * AES-256), so the document model asks for each one as it reads it.
 *
 * MD5 and SHA-2 come from hash-wasm (already bundled for the hash tool, synchronous once the
 * hasher exists, and it works on pages that are not a secure context), AES from @noble/ciphers
 * and RC4 from the crypto tools.
 */
import { cbc, ecb } from '@noble/ciphers/aes.js';
import { createMD5, createSHA256, createSHA384, createSHA512, type IHasher } from 'hash-wasm';
import { concatBytes, utf8Encode } from '../../lib/bytes';
import { rc4 } from '../crypto/_rc4';
import { isDict, isName, isNum, isString, type PdfDict, type PdfValue } from './_pdf-lex';

export type CryptMethod = 'identity' | 'rc4' | 'aes128' | 'aes256';

export interface CryptFilter {
  name: string;
  /** /CFM as written: V2, AESV2, AESV3, None. */
  cfm: string;
  method: CryptMethod;
  /** Key length in bits as the file declares it, or null. */
  bits: number | null;
}

export interface EncryptInfo {
  filter: string;
  subFilter: string | null;
  v: number;
  r: number;
  /** Key length in bits (/Length, 40 when absent). */
  bits: number;
  o: Uint8Array;
  u: Uint8Array;
  oe: Uint8Array | null;
  ue: Uint8Array | null;
  perms: Uint8Array | null;
  /** /P as a signed 32-bit integer. */
  p: number;
  encryptMetadata: boolean;
  /** Crypt filters by name (V 4 and 5), and the names chosen for streams, strings and files. */
  filters: CryptFilter[];
  stmF: string;
  strF: string;
  eff: string | null;
  id0: Uint8Array;
  /** What the handler can do for this dictionary, or why it cannot. */
  supported: boolean;
  problem: string | null;
}

export interface Decryptor {
  string(num: number, gen: number, data: Uint8Array): Uint8Array;
  stream(
    num: number,
    gen: number,
    data: Uint8Array,
    opts: { cryptName: string | null; metadata: boolean },
  ): Uint8Array;
  /** The file key, for display. */
  keyBits: number;
}

export type UnlockResult =
  | { ok: true; decryptor: Decryptor; password: 'empty' | 'given'; warning: string | null }
  | { ok: false; reason: 'password' | 'unsupported'; detail: string };

// ---------- the Encrypt dictionary ----------

const bytesOf = (v: PdfValue | undefined): Uint8Array | null => (isString(v) ? v.b : null);
const numOf = (v: PdfValue | undefined, def: number): number => (isNum(v) ? v : def);
const nameValue = (v: PdfValue | undefined): string | null => (isName(v) ? v.v : null);

export function readEncrypt(
  dict: PdfDict,
  id0: Uint8Array,
  resolve: (v: PdfValue | undefined) => PdfValue | undefined,
): EncryptInfo {
  const get = (k: string) => resolve(dict.map.get(k));
  const v = numOf(get('V'), 0);
  const r = numOf(get('R'), 0);
  const filters: CryptFilter[] = [];
  const cf = get('CF');
  if (isDict(cf)) {
    for (const [name, entry] of cf.map) {
      const e = resolve(entry);
      if (!isDict(e)) continue;
      const cfm = nameValue(resolve(e.map.get('CFM'))) ?? 'None';
      const length = resolve(e.map.get('Length'));
      const bits = isNum(length) ? (length >= 40 ? length : length * 8) : null;
      filters.push({ name, cfm, method: methodOf(cfm), bits });
    }
  }
  const pRaw = numOf(get('P'), 0);
  const info: EncryptInfo = {
    filter: nameValue(get('Filter')) ?? '',
    subFilter: nameValue(get('SubFilter')),
    v,
    r,
    bits: v === 1 ? 40 : numOf(get('Length'), 40),
    o: bytesOf(get('O')) ?? new Uint8Array(0),
    u: bytesOf(get('U')) ?? new Uint8Array(0),
    oe: bytesOf(get('OE')),
    ue: bytesOf(get('UE')),
    perms: bytesOf(get('Perms')),
    p: pRaw | 0,
    encryptMetadata: get('EncryptMetadata') !== false,
    filters,
    stmF: nameValue(get('StmF')) ?? 'Identity',
    strF: nameValue(get('StrF')) ?? 'Identity',
    eff: nameValue(get('EFF')),
    id0,
    supported: true,
    problem: null,
  };
  if (info.filter !== 'Standard') {
    info.supported = false;
    info.problem = `security handler ${info.filter || '(none)'}`;
  } else if (![1, 2, 3, 4, 5].includes(v) || ![2, 3, 4, 5, 6].includes(r)) {
    info.supported = false;
    info.problem = `V ${v}, R ${r}`;
  }
  return info;
}

function methodOf(cfm: string): CryptMethod {
  switch (cfm) {
    case 'V2':
      return 'rc4';
    case 'AESV2':
      return 'aes128';
    case 'AESV3':
      return 'aes256';
    default:
      return 'identity';
  }
}

/** The names of the permission bits that are set in /P (Table 22). */
export const PERMISSION_BITS: [number, string][] = [
  [3, 'print'],
  [4, 'modify'],
  [5, 'copy'],
  [6, 'annotate'],
  [9, 'fillForms'],
  [10, 'accessibility'],
  [11, 'assemble'],
  [12, 'printHighQuality'],
];

export const permissionsAllowed = (p: number): string[] =>
  PERMISSION_BITS.filter(([bit]) => (p & (1 << (bit - 1))) !== 0).map(([, name]) => name);

// ---------- key derivation ----------

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

interface Hashers {
  md5: IHasher;
  sha256: IHasher;
  sha384: IHasher;
  sha512: IHasher;
}

function digest(h: IHasher, ...parts: Uint8Array[]): Uint8Array {
  h.init();
  for (const p of parts) h.update(p);
  return h.digest('binary');
}

/** The password as bytes for R 2-4: Latin-1 / PDFDocEncoding, padded or cut to 32 bytes. */
function paddedPassword(pw: string): Uint8Array {
  const out = new Uint8Array(32);
  let n = 0;
  for (const ch of pw) {
    if (n >= 32) break;
    out[n++] = ch.charCodeAt(0) & 0xff;
  }
  out.set(PAD.subarray(0, 32 - n), n);
  return out;
}

const le32 = (n: number) =>
  Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

/** Algorithm 2: the file key from a user password (R 2-4). */
function legacyKey(h: Hashers, enc: EncryptInfo, pw: string, keyBytes: number): Uint8Array {
  const parts = [paddedPassword(pw), enc.o.subarray(0, 32), le32(enc.p), enc.id0];
  if (enc.r >= 4 && !enc.encryptMetadata) parts.push(Uint8Array.from([255, 255, 255, 255]));
  let key = digest(h.md5, ...parts);
  if (enc.r >= 3) for (let i = 0; i < 50; i++) key = digest(h.md5, key.subarray(0, keyBytes));
  return key.slice(0, keyBytes);
}

/** Algorithms 4 and 5: does this file key reproduce /U? (R 2-4) */
function legacyUserOk(h: Hashers, enc: EncryptInfo, key: Uint8Array): boolean {
  if (enc.r === 2) return equal(rc4(key, PAD), enc.u.subarray(0, 32));
  let x = rc4(key, digest(h.md5, PAD, enc.id0));
  for (let i = 1; i <= 19; i++)
    x = rc4(
      key.map((b) => b ^ i),
      x,
    );
  return equal(x, enc.u.subarray(0, 16));
}

const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Algorithm 2.B (ISO 32000-2): the hardened hash of R 6. */
function hash2B(h: Hashers, password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
  let k = digest(h.sha256, password, salt, udata);
  let last = 0;
  for (let i = 0; i < 64 || last > i - 32; i++) {
    const unit = concatBytes(password, k, udata);
    const k1 = new Uint8Array(unit.length * 64);
    for (let j = 0; j < 64; j++) k1.set(unit, j * unit.length);
    const e = cbc(k.subarray(0, 16), k.subarray(16, 32), { disablePadding: true }).encrypt(k1);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j]!;
    k = digest(sum % 3 === 0 ? h.sha256 : sum % 3 === 1 ? h.sha384 : h.sha512, e);
    last = e[e.length - 1]!;
  }
  return k.slice(0, 32);
}

function modernHash(h: Hashers, r: number, pw: Uint8Array, salt: Uint8Array): Uint8Array {
  return r === 5 ? digest(h.sha256, pw, salt) : hash2B(h, pw, salt, new Uint8Array(0));
}

/** R 5 and 6: the file key from the user password, or null when /U does not match. */
function modernKey(h: Hashers, enc: EncryptInfo, pw: string): Uint8Array | null {
  if (enc.u.length < 48 || !enc.ue || enc.ue.length < 32) return null;
  const password = utf8Encode(pw).subarray(0, 127);
  const validation = enc.u.subarray(32, 40);
  const keySalt = enc.u.subarray(40, 48);
  if (!equal(modernHash(h, enc.r, password, validation), enc.u.subarray(0, 32))) return null;
  const inter = modernHash(h, enc.r, password, keySalt);
  return cbc(inter, new Uint8Array(16), { disablePadding: true }).decrypt(enc.ue.subarray(0, 32));
}

// ---------- decrypting data ----------

function objectKey(h: Hashers, fileKey: Uint8Array, num: number, gen: number, aes: boolean) {
  const tail = [num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255];
  const salt = aes ? [0x73, 0x41, 0x6c, 0x54] : [];
  const hashed = digest(h.md5, fileKey, Uint8Array.from([...tail, ...salt]));
  return hashed.slice(0, Math.min(fileKey.length + 5, 16));
}

/** AES-CBC with the IV in front; PKCS#5 padding removed when it is well formed. */
function aesDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 32) return new Uint8Array(0);
  const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16);
  const plain = cbc(key, data.subarray(0, 16), { disablePadding: true }).decrypt(body);
  const pad = plain[plain.length - 1] ?? 0;
  if (pad >= 1 && pad <= 16 && plain.length >= pad) {
    let ok = true;
    for (let i = 0; i < pad; i++) if (plain[plain.length - 1 - i] !== pad) ok = false;
    if (ok) return plain.subarray(0, plain.length - pad);
  }
  return plain;
}

function makeDecryptor(h: Hashers, enc: EncryptInfo, fileKey: Uint8Array): Decryptor {
  const method = (name: string | null): CryptMethod => {
    if (name === null || name === 'Identity') return 'identity';
    const f = enc.filters.find((x) => x.name === name);
    if (f) return f.method;
    return 'identity';
  };
  // V 1-3 have no crypt filters: everything is RC4.
  const legacy = enc.v < 4;
  const stmMethod = legacy ? 'rc4' : method(enc.stmF);
  const strMethod = legacy ? 'rc4' : method(enc.strF);
  const apply = (m: CryptMethod, num: number, gen: number, data: Uint8Array): Uint8Array => {
    switch (m) {
      case 'rc4':
        return rc4(objectKey(h, fileKey, num, gen, false), data);
      case 'aes128':
        return aesDecrypt(objectKey(h, fileKey, num, gen, true), data);
      case 'aes256':
        return aesDecrypt(fileKey, data);
      default:
        return data;
    }
  };
  return {
    keyBits: fileKey.length * 8,
    string: (num, gen, data) => apply(strMethod, num, gen, data),
    stream: (num, gen, data, opts) => {
      if (opts.metadata && !enc.encryptMetadata) return data;
      const m = opts.cryptName !== null ? method(opts.cryptName) : stmMethod;
      return apply(m, num, gen, data);
    },
  };
}

let hashersPromise: Promise<Hashers> | null = null;
function hashers(): Promise<Hashers> {
  hashersPromise ??= Promise.all([
    createMD5(),
    createSHA256(),
    createSHA384(),
    createSHA512(),
  ]).then(([md5, sha256, sha384, sha512]) => ({ md5, sha256, sha384, sha512 }));
  return hashersPromise;
}

/**
 * Open the document with the empty user password and then with each password given. The
 * owner password is not handled: when no user password fits, the answer says so.
 */
export async function unlock(enc: EncryptInfo, passwords: string[]): Promise<UnlockResult> {
  if (!enc.supported) {
    return { ok: false, reason: 'unsupported', detail: enc.problem ?? 'unknown handler' };
  }
  const h = await hashers();
  const candidates: { pw: string; kind: 'empty' | 'given' }[] = [
    { pw: '', kind: 'empty' },
    ...passwords.filter((p) => p !== '').map((pw) => ({ pw, kind: 'given' as const })),
  ];
  for (const { pw, kind } of candidates) {
    if (enc.r >= 5) {
      const key = modernKey(h, enc, pw);
      if (!key) continue;
      let warning: string | null = null;
      if (enc.perms && enc.perms.length >= 16) {
        const p = ecb(key, { disablePadding: true }).decrypt(enc.perms.subarray(0, 16));
        if (!(p[9] === 0x61 && p[10] === 0x64 && p[11] === 0x62)) warning = 'perms';
      }
      return { ok: true, decryptor: makeDecryptor(h, enc, key), password: kind, warning };
    }
    const keyBytes =
      enc.r === 2
        ? 5
        : enc.v === 4
          ? cryptFilterBytes(enc)
          : Math.max(5, Math.min(16, enc.bits >> 3));
    const key = legacyKey(h, enc, pw, keyBytes);
    if (legacyUserOk(h, enc, key)) {
      return { ok: true, decryptor: makeDecryptor(h, enc, key), password: kind, warning: null };
    }
  }
  return { ok: false, reason: 'password', detail: '' };
}

/** V 4: the key is 128 bits unless the crypt filter says otherwise. */
function cryptFilterBytes(enc: EncryptInfo): number {
  const f = enc.filters.find((x) => x.name === enc.stmF) ?? enc.filters[0];
  const bits = f?.bits ?? enc.bits;
  return Math.max(5, Math.min(16, bits >> 3));
}

export const encryptionLabel = (enc: EncryptInfo): string => {
  const methods = new Set<string>();
  if (enc.v < 4) methods.add(`RC4 ${enc.bits}`);
  else for (const f of enc.filters) methods.add(f.cfm);
  return [...methods].join(', ');
};
