import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encode as encodePng } from 'fast-png';
import { encrypt } from '../tools/crypto/_angecryption';
import { utf8Encode } from '../lib/bytes';
import { detectCrypto } from './_analyze-crypto';

const sample = (name: string) => new Uint8Array(readFileSync(`public/samples/${name}`));

/** Deterministic pseudo-random bytes (xorshift), standing in for AES output. */
function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

function stripedPng(): Uint8Array {
  const w = 32;
  const data = new Uint8Array(w * w * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
  return encodePng({ width: w, height: w, data, channels: 3, depth: 8 });
}

const pad16 = (b: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(b.length / 16) * 16);
  out.set(b);
  return out;
};

describe('detectCrypto on the fixtures', () => {
  it('angecryption-sample.bin yields at least a probable encrypted finding', async () => {
    const f = await detectCrypto(sample('angecryption-sample.bin'), 'angecryption-sample.bin');
    const hit = f.find((x) => x.kind === 'encrypted');
    expect(hit).toBeDefined();
    expect(['probable', 'confirmed']).toContain(hit?.confidence);
  });

  it('raw uniform blocks with no key anywhere give a probable finding only', async () => {
    const f = await detectCrypto(noise(512, 7));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'encrypted', confidence: 'probable' });
  });

  it('confirms when the key sits inside the file (decrypts to a PNG)', async () => {
    const key = utf8Encode('unrelated-key-16');
    const cipher = encrypt(pad16(stripedPng()), key, new Uint8Array(16));
    const withKey = new Uint8Array(cipher.length + 16);
    withKey.set(cipher);
    withKey.set(key, cipher.length);
    const f = await detectCrypto(withKey);
    expect(f[0]).toMatchObject({ kind: 'encrypted', confidence: 'confirmed' });
    expect(f[0]?.title).toContain('png');
  });
});

describe('detectCrypto never confirms on a clean file', () => {
  it.each(['clean-photo.jpg', 'clean-doc.pdf', 'clean-video.mp4', 'color-swatches.png'])(
    '%s',
    async (file) => {
      const f = await detectCrypto(sample(file), file);
      expect(f.filter((x) => x.confidence === 'confirmed')).toEqual([]);
    },
  );

  it('text, tiny and empty inputs give nothing', async () => {
    expect(await detectCrypto(utf8Encode('hello world, nothing hidden here. '.repeat(20)))).toEqual(
      [],
    );
    expect(await detectCrypto(new Uint8Array(0))).toEqual([]);
    expect(await detectCrypto(new Uint8Array(20))).toEqual([]);
    expect(await detectCrypto(new Uint8Array(512))).toEqual([]);
  });
});
