import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = (n: string) => fileURLToPath(new URL(`./corpus/${n}`, import.meta.url));
const manifest = JSON.parse(readFileSync(dir('manifest.json'), 'utf8')) as {
  file: string;
  secret: string;
}[];
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngText(png: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 8;
  while (p + 12 <= png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString('ascii', p + 4, p + 8);
    if (type === 'tEXt') {
      const d = png.subarray(p + 8, p + 8 + len).toString('latin1');
      const i = d.indexOf('\0');
      out[d.slice(0, i)] = d.slice(i + 1);
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

describe('pdf bench crossverify', () => {
  for (const { file, secret } of manifest) {
    it(`${file}: PDF valid head + appended PNG holds the flag`, () => {
      const buf = readFileSync(dir(file));
      expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
      const eof = buf.indexOf('%%EOF');
      expect(eof).toBeGreaterThan(0);
      // xref offset check on the PDF part
      const head = buf.subarray(0, eof + 6).toString('latin1');
      const xrefPos = Number(/startxref\n(\d+)/.exec(head)![1]);
      expect(head.slice(xrefPos, xrefPos + 4)).toBe('xref');
      const sig = buf.indexOf(SIG, eof);
      expect(sig).toBeGreaterThan(eof);
      expect(pngText(buf.subarray(sig)).Comment).toBe(secret);
    });
  }
});
