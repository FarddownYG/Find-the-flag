import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = (n: string) => fileURLToPath(new URL(`./corpus/${n}`, import.meta.url));
const manifest = JSON.parse(readFileSync(dir('manifest.json'), 'utf8')) as {
  file: string;
  secret: string;
}[];

// Independent ZIP reader: EOCD -> central directory -> local header -> STORE data.
function readZip(buf: Buffer, flagName: string): string {
  let e = -1;
  for (let i = buf.length - 22; i >= 0; i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      e = i;
      break;
    }
  expect(e).toBeGreaterThanOrEqual(0);
  const n = buf.readUInt16LE(e + 10);
  const cdSize = buf.readUInt32LE(e + 12);
  const cdOff = buf.readUInt32LE(e + 16);
  // For polyglots offsets are relative to the ZIP start; derive it from EOCD position.
  const base = e - cdSize - cdOff;
  let p = base + cdOff;
  for (let k = 0; k < n; k++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28);
    const xl = buf.readUInt16LE(p + 30);
    const cl = buf.readUInt16LE(p + 32);
    const lo = base + buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    if (name === flagName) {
      expect(method).toBe(0);
      expect(buf.readUInt32LE(lo)).toBe(0x04034b50);
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
      return buf.toString('utf8', start, start + csize);
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error('flag.txt not found');
}

describe('archives corpus cross-verify', () => {
  for (const { file, secret } of manifest) {
    it(`${file} -> ${secret}`, () => {
      const buf = readFileSync(dir(file));
      if (file.endsWith('.png')) {
        expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        const iend = buf.indexOf(Buffer.from('IEND'));
        expect(iend).toBeGreaterThan(0);
        const after = iend + 8; // IEND type(4) + CRC(4)
        expect(buf.readUInt32LE(after)).toBe(0x04034b50);
        expect(readZip(buf.subarray(after), 'flag.txt')).toBe(secret);
      } else {
        expect(readZip(buf, 'flag.txt')).toBe(secret);
      }
    });
  }
});
