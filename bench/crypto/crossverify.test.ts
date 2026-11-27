import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = (n: string) => fileURLToPath(new URL(`./corpus/${n}`, import.meta.url));
const A32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Independent inverse decoders.
const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');
const unhex = (s: string) => Buffer.from(s, 'hex').toString('utf8');
function unbase32(s: string): string {
  let bits = '';
  for (const c of s.replace(/=+$/, '')) bits += A32.indexOf(c).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes).toString('utf8');
}
const rot13 = (s: string) =>
  s.replace(/[A-Za-z]/g, (c) => {
    const b = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });

const decoders: Record<string, (s: string) => string> = {
  '01-base64.txt': unb64,
  '02-hex.txt': unhex,
  '03-base64-twice.txt': (s) => unb64(unb64(s)),
  '04-base32.txt': unbase32,
  '05-hex-of-base64.txt': (s) => unb64(unhex(s)),
  '06-rot13.txt': rot13,
};

const manifest: { file: string; secret: string }[] = JSON.parse(
  readFileSync(dir('manifest.json'), 'utf8'),
);

describe('crypto bench fixtures re-decode to the clear flag', () => {
  for (const { file, secret } of manifest) {
    it(file, () => {
      const dec = decoders[file];
      expect(dec).toBeDefined();
      expect(dec(readFileSync(dir(file), 'utf8'))).toBe(secret);
    });
  }
});
