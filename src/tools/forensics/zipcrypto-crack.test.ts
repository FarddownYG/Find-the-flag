import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resultToText } from '../../core/result-text';
import { ToolError } from '../../core/errors';
import tool from './zipcrypto-crack';

const sample = (n: string) => new Uint8Array(readFileSync(`public/samples/${n}`));
const fileInput = (n: string) => ({ bytes: sample(n), name: n });
const bytesInput = (n: string) => ({ bytes: sample(n), name: n });

interface Opts {
  known: { bytes: Uint8Array; name: string } | null;
  plaintextArchive: { bytes: Uint8Array; name: string } | null;
  offset: number;
  reEmit: boolean;
}
const DEFAULTS: Opts = { known: null, plaintextArchive: null, offset: 0, reEmit: true };

async function run(zip: string, opts: Partial<typeof DEFAULTS> = {}): Promise<string> {
  const out = await tool.run(bytesInput(zip) as never, { ...DEFAULTS, ...opts } as never);
  return resultToText(out);
}

describe('zipcrypto-crack', () => {
  it('cracks a STORED ZipCrypto archive from a known file (CRC-confirmed)', async () => {
    const text = await run('zipcrack-stored.zip', { known: fileInput('zipcrack-note.txt') });
    expect(text).toContain('FTF{zipcrypto_known_plaintext}');
  }, 60000);

  it('cracks a DEFLATE ZipCrypto archive from a plaintext archive', async () => {
    const text = await run('zipcrack-deflate.zip', {
      plaintextArchive: fileInput('zipcrack-deflate-plain.zip'),
    });
    expect(text).toContain('FTF{deflate_plaintext_archive}');
  }, 60000);

  it('detects WinZip AES and refuses to attack it', async () => {
    const text = await run('zipcrack-aes.zip', { known: fileInput('zipcrack-note.txt') });
    expect(text).toContain('AES');
    expect(text).not.toContain('key0');
  });

  it('rejects a wrong plaintext with an explicit CRC error (no crash)', async () => {
    const wrong = sample('zipcrack-note.txt');
    wrong[20] = wrong[20]! ^ 0x01; // flip one byte
    await expect(
      tool.run(
        bytesInput('zipcrack-stored.zip') as never,
        {
          ...DEFAULTS,
          known: { bytes: wrong, name: 'wrong.txt' },
        } as never,
      ),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('refuses fewer than 12 known bytes', async () => {
    const eight = sample('zipcrack-note.txt').subarray(0, 8);
    await expect(
      tool.run(
        bytesInput('zipcrack-stored.zip') as never,
        {
          ...DEFAULTS,
          known: { bytes: eight, name: 'eight.txt' },
        } as never,
      ),
    ).rejects.toThrow();
  });

  it('with no known plaintext, lists the entries and explains how to supply it', async () => {
    const text = await run('zipcrack-stored.zip');
    expect(text).toContain('ZipCrypto');
    expect(text.toLowerCase()).toContain('crc');
    expect(text).not.toContain('key0');
  });
});
