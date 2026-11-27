/**
 * The maths behind the known-plaintext attack on traditional PKWARE ("ZipCrypto") encryption.
 *
 * ZipCrypto is a stream cipher driven by three 32-bit keys. Every entry of an archive starts from
 * the SAME base keys (the state produced by hashing the password), so recovering that base state
 * from one entry's known plaintext decrypts every entry — without ever learning the password.
 *
 * This module holds the pure key arithmetic: the forward schedule (identical to `_zipcrypto.ts`),
 * its exact inverse (CRC-32 step inversion and the multiplicative inverse), a backward step that
 * rolls the keys to an earlier position while recovering the plaintext byte there, and the glue
 * that turns the heavy Biham-Kocher search (done in WebAssembly) into the base keys and the
 * decryption of a whole archive. Pure and deterministic: no DOM, no WASM import here (the search
 * function is injected), so every step is unit-testable in Node.
 */
import { crc32Step } from '../../lib/signatures';

/** The internal cipher state: three 32-bit keys. */
export interface KeyState {
  k0: number;
  k1: number;
  k2: number;
}

/** The keys right after initialisation, before any password byte is mixed in. */
export const INITIAL_KEYS: KeyState = { k0: 0x12345678, k1: 0x23456789, k2: 0x34567890 };

/** The multiplier of the key-1 recurrence (0x08088405). */
const MULT = 134775813;

/** The 12-byte random header that precedes every encrypted entry's data. */
export const ZIPCRYPTO_HEADER = 12;

/** 2-adic inverse of an odd 32-bit number (Newton iteration: bits double each step). */
export function modInverse32(a: number): number {
  let x = 1;
  for (let i = 0; i < 5; i++) x = Math.imul(x, (2 - Math.imul(a, x)) | 0) >>> 0;
  return x >>> 0;
}

const MULT_INV = modInverse32(MULT);

/** The CRC-32 step table and its inverse, built from the project's own `crc32Step`. */
const CRC_TAB: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let x = 0; x < 256; x++) t[x] = crc32Step(0, x); // crc32Step(0, x) === CRC32_TABLE[x]
  return t;
})();

const CRC_INV_TOP: Uint8Array = (() => {
  const inv = new Uint8Array(256);
  for (let x = 0; x < 256; x++) inv[CRC_TAB[x]! >>> 24] = x;
  return inv;
})();

/** Inverse of `crc32Step`: given r = crc32Step(c, b) and b, return c. */
export function crc32StepInverse(r: number, b: number): number {
  const x = CRC_INV_TOP[r >>> 24]!; // = (c ^ b) & 0xff
  return (((r ^ CRC_TAB[x]!) << 8) | ((x ^ b) & 0xff)) >>> 0;
}

/** One keystream byte from the current key2 (exactly as `_zipcrypto.ts`: `key2 | 2`). */
export function streamByte(k2: number): number {
  const t = (k2 | 2) & 0xffff;
  return ((t * (t ^ 1)) >>> 8) & 0xff;
}

/** Advance the keys by one plaintext byte (the encryption/decryption schedule). */
export function forwardUpdate(s: KeyState, plain: number): void {
  s.k0 = crc32Step(s.k0, plain);
  s.k1 = (Math.imul((s.k1 + (s.k0 & 0xff)) >>> 0, MULT) + 1) >>> 0;
  s.k2 = crc32Step(s.k2, s.k1 >>> 24);
}

/**
 * Roll the keys back by one position, given the ciphertext byte there. Returns the plaintext byte
 * at that position and mutates `s` to the earlier state. Needs only ciphertext: key2 and key1 roll
 * back from the current state alone, which yields the keystream byte, hence the plaintext, hence
 * the key0 inversion.
 */
export function backwardUpdate(s: KeyState, cipher: number): number {
  const k2prev = crc32StepInverse(s.k2, s.k1 >>> 24);
  const k1prev = (Math.imul((s.k1 - 1) >>> 0, MULT_INV) - (s.k0 & 0xff)) >>> 0;
  const plain = cipher ^ streamByte(k2prev);
  const k0prev = crc32StepInverse(s.k0, plain);
  s.k0 = k0prev;
  s.k1 = k1prev;
  s.k2 = k2prev;
  return plain;
}

/** The base keys from a password (the state shared by every entry of the archive). */
export function keysFromPassword(password: Uint8Array): KeyState {
  const s = { ...INITIAL_KEYS };
  for (const c of password) forwardUpdate(s, c);
  return s;
}

/** Encrypt bytes that already begin with the 12-byte header, from a base state. For tests. */
export function encryptFromState(base: KeyState, plain: Uint8Array): Uint8Array {
  const s = { ...base };
  const out = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) {
    out[i] = plain[i]! ^ streamByte(s.k2);
    forwardUpdate(s, plain[i]!);
  }
  return out;
}

/** Decrypt an entry's stored bytes (12-byte header + data) from the base keys. */
export function decryptFromState(
  base: KeyState,
  encrypted: Uint8Array,
): { header: Uint8Array; data: Uint8Array } {
  const s = { ...base };
  const plain = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    const p = encrypted[i]! ^ streamByte(s.k2);
    forwardUpdate(s, p);
    plain[i] = p;
  }
  return { header: plain.subarray(0, ZIPCRYPTO_HEADER), data: plain.subarray(ZIPCRYPTO_HEADER) };
}

/** Roll a state backward over `cipherPrefix` (earliest byte last), returning the earlier state. */
export function rollBack(state: KeyState, cipherPrefix: Uint8Array): KeyState {
  const s = { ...state };
  for (let i = cipherPrefix.length - 1; i >= 0; i--) backwardUpdate(s, cipherPrefix[i]!);
  return s;
}

/** Produce `length` keystream bytes from a state (the state is advanced over its own output). */
export function keystreamFromState(state: KeyState, length: number): Uint8Array {
  const s = { ...state };
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = streamByte(s.k2);
    // The keystream advances as if the attacker's guessed plaintext were fed back; callers that
    // need a real advance use decrypt/encrypt. This helper is only for checking a candidate state.
    forwardUpdate(s, out[i]!);
  }
  return out;
}

/**
 * The known-plaintext search, done in WebAssembly, injected so this module stays pure. It takes a
 * contiguous run of plaintext and the matching keystream (plaintext XOR ciphertext) and returns the
 * cipher state right before the first byte of that run, or null when no state is consistent.
 */
export type RecoverKeys = (plaintext: Uint8Array, keystream: Uint8Array) => KeyState | null;

export interface CrackResult {
  /** The base keys shared by every entry. */
  base: KeyState;
  /** The keys at the start of the known-plaintext run (before roll-back), for the trace. */
  atRun: KeyState;
}

/**
 * Recover the archive's base keys from one entry's known plaintext.
 *
 * `entryCipher` is that entry's stored bytes (the 12-byte header followed by the encrypted
 * compressed data). `plaintext` is the known plaintext of the compressed stream, starting at
 * `plainOffset` bytes into the compressed data (0 = right after the header). The keystream over the
 * run is `plaintext XOR entryCipher[header + plainOffset ...]`; the WASM search turns it into the
 * state at the run start, which we then roll back over the header (and any prefix) to the base keys.
 */
export function recoverBaseKeys(
  recover: RecoverKeys,
  entryCipher: Uint8Array,
  plaintext: Uint8Array,
  plainOffset: number,
): CrackResult | null {
  const runStart = ZIPCRYPTO_HEADER + plainOffset;
  if (plaintext.length < 12) return null;
  if (runStart + plaintext.length > entryCipher.length) return null;
  const keystream = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) {
    keystream[i] = plaintext[i]! ^ entryCipher[runStart + i]!;
  }
  const atRun = recover(plaintext, keystream);
  if (!atRun) return null;
  const base = rollBack(atRun, entryCipher.subarray(0, runStart));
  return { base, atRun };
}
