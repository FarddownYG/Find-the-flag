import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = (n: string) => fileURLToPath(new URL(`./corpus/${n}`, import.meta.url));

// Independent minimal decoder: parse RIFF chunks, take 16-bit LE samples, LSBs MSB-first.
function decode(wav: Buffer): string {
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
  let p = 12;
  let bits = 0;
  let ch = 0;
  let data: Buffer | null = null;
  while (p + 8 <= wav.length) {
    const id = wav.toString('ascii', p, p + 4);
    const len = wav.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      expect(wav.readUInt16LE(p + 8)).toBe(1);
      ch = wav.readUInt16LE(p + 10);
      bits = wav.readUInt16LE(p + 22);
    } else if (id === 'data') data = wav.subarray(p + 8, p + 8 + len);
    p += 8 + len + (len & 1);
  }
  expect(ch).toBe(1);
  expect(bits).toBe(16);
  const d = data!;
  const n = d.length >> 1;
  expect(n).toBeGreaterThanOrEqual(16000);
  const bytes: number[] = [];
  for (let i = 0; i + 7 < n; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | (d.readInt16LE((i + k) * 2) & 1);
    bytes.push(b);
  }
  const text = Buffer.from(bytes).toString('latin1');
  const m = /FTF\{[!-z]+\}/.exec(text);
  return m ? m[0] : '';
}

const manifest = JSON.parse(readFileSync(dir('manifest.json'), 'utf8')) as {
  file: string;
  secret: string;
}[];

describe('audio LSB corpus cross-verification', () => {
  it('has at least 4 fixtures', () => expect(manifest.length).toBeGreaterThanOrEqual(4));
  for (const { file, secret } of manifest) {
    it(`${file} decodes to its secret`, () => {
      expect(decode(readFileSync(dir(file)))).toBe(secret);
    });
  }
});
