import { describe, expect, it } from 'vitest';
import { crc32Step } from '../../lib/signatures';
import {
  backwardUpdate,
  crc32StepInverse,
  decryptFromState,
  encryptFromState,
  forwardUpdate,
  INITIAL_KEYS,
  type KeyState,
  keysFromPassword,
  modInverse32,
  recoverBaseKeys,
  type RecoverKeys,
  rollBack,
  ZIPCRYPTO_HEADER,
} from './_zipcrypto-attack';

/** A small deterministic PRNG so the tests never touch Math.random. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}
function bytes(n: number, seed: number): Uint8Array {
  const r = rng(seed);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = r() & 0xff;
  return b;
}

describe('zipcrypto attack maths', () => {
  it('crc32StepInverse undoes crc32Step', () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const crc = r() >>> 0;
      const byte = r() & 0xff;
      expect(crc32StepInverse(crc32Step(crc, byte), byte)).toBe(crc);
    }
  });

  it('modInverse32 inverts the key-1 multiplier', () => {
    const MULT = 134775813;
    expect(Math.imul(MULT, modInverse32(MULT)) >>> 0).toBe(1);
    const r = rng(11);
    for (let i = 0; i < 1000; i++) {
      const a = (r() | 1) >>> 0; // odd
      expect(Math.imul(a, modInverse32(a)) >>> 0).toBe(1);
    }
  });

  it('backwardUpdate rolls the keys back and recovers the plaintext byte', () => {
    const base = keysFromPassword(new TextEncoder().encode('S3cret!'));
    const plain = bytes(64, 99);
    // Record the state before each forward step.
    const s: KeyState = { ...base };
    const states: KeyState[] = [];
    for (let i = 0; i < plain.length; i++) {
      states.push({ ...s });
      forwardUpdate(s, plain[i]!);
    }
    const end: KeyState = { ...s };
    // Roll back from the end state over the ciphertext; it should return the plaintext and states.
    const cipher = encryptFromState(base, plain);
    const back: KeyState = { ...end };
    for (let i = plain.length - 1; i >= 0; i--) {
      const p = backwardUpdate(back, cipher[i]!);
      expect(p).toBe(plain[i]);
      expect(back).toEqual(states[i]);
    }
    expect(back).toEqual(base);
  });

  it('recoverBaseKeys + decryptFromState round-trips a whole entry (fake search)', () => {
    const base = keysFromPassword(new TextEncoder().encode('infected'));
    const header = bytes(ZIPCRYPTO_HEADER, 3);
    const data = bytes(400, 5);
    const plainWhole = new Uint8Array(header.length + data.length);
    plainWhole.set(header, 0);
    plainWhole.set(data, header.length);
    const entryCipher = encryptFromState(base, plainWhole);

    // The known plaintext is a slice of the compressed data at some offset.
    const plainOffset = 17;
    const known = data.subarray(plainOffset, plainOffset + 40);

    // A fake "Biham-Kocher": return the true state at the run start (header + offset forward steps).
    const fake: RecoverKeys = (p, ks) => {
      expect(p.length).toBe(ks.length);
      const s: KeyState = { ...base };
      for (let i = 0; i < ZIPCRYPTO_HEADER + plainOffset; i++) forwardUpdate(s, plainWhole[i]!);
      return { ...s };
    };

    const res = recoverBaseKeys(fake, entryCipher, known, plainOffset);
    expect(res).not.toBeNull();
    expect(res!.base).toEqual(base);

    const dec = decryptFromState(res!.base, entryCipher);
    expect([...dec.data]).toEqual([...data]);
  });

  it('rollBack of nothing is identity; initial keys are the documented constants', () => {
    const s: KeyState = { k0: 1, k1: 2, k2: 3 };
    expect(rollBack(s, new Uint8Array(0))).toEqual(s);
    expect(INITIAL_KEYS).toEqual({ k0: 0x12345678, k1: 0x23456789, k2: 0x34567890 });
  });
});
