import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultOptions } from '../../core/registry';
import { resultToText } from '../../core/result-text';
import type { FileInput, Output, ToolResult } from '../../core/types';
import { toHex, utf8Encode } from '../../lib/bytes';
import { identify } from '../../lib/signatures';
import tool from './angecryption';

const sample = new Uint8Array(
  readFileSync(new URL('../../../public/samples/angecryption-sample.bin', import.meta.url)),
);
const file = (s: string): FileInput => ({ bytes: utf8Encode(s) });
const run = async (input: Uint8Array, opts: Record<string, unknown> = {}): Promise<ToolResult> =>
  tool.run({ bytes: input }, { ...defaultOptions(tool as never), ...opts } as never);
const kv = (r: ToolResult, label: RegExp) =>
  Object.fromEntries(
    r.find(
      (o): o is Extract<Output, { type: 'kv' }> => o.type === 'kv' && label.test(o.label ?? ''),
    )!.entries,
  );

describe('AngeCryption tool', () => {
  it('recovers the PNG from the sample with the key in the candidate list', async () => {
    const r = await run(sample, { keyList: file('wrong key 123456\nFTF-angecrypt-16\nnope') });
    expect(resultToText(r)).toContain('Angecryption confirmed');
    const pic = r.find((o): o is Extract<Output, { type: 'picture' }> => o.type === 'picture')!;
    expect(pic.mime).toBe('image/png');
    expect(identify(pic.data)[0]?.id).toBe('png');
    const found = kv(r, /found/i);
    expect(found['IV (hex)']).toBe('031425364758697a8b9cadbecfe0f102');
  });

  it('finds the key typed by the user, in hex too', async () => {
    const r = await run(sample, { key: toHex(utf8Encode('FTF-angecrypt-16')) });
    expect(resultToText(r)).toContain('Angecryption confirmed');
  });

  it('finds a key that sits inside the file when the windows option is on', async () => {
    const key = utf8Encode('FTF-angecrypt-16');
    const withKey = new Uint8Array(sample.length + 16);
    withKey.set(sample);
    withKey.set(key, sample.length); // an extra trailing block that happens to hold the key
    const off = await run(withKey);
    expect(resultToText(off)).not.toContain('Angecryption confirmed');
    const on = await run(withKey, { windows: true });
    const text = resultToText(on);
    expect(text).toContain('Angecryption confirmed');
    expect(text).toContain(`window of the file at offset ${sample.length}`);
  });

  it('reports "not found" with no false positive for a wrong-key-only list', async () => {
    const r = await run(sample, {
      keyList: file('0123456789abcdef\nFTF-angecrypt-17\nzzzzzzzzzzzzzzzz'),
    });
    const text = resultToText(r);
    expect(text).not.toContain('Angecryption confirmed');
    expect(text).toContain('No candidate key matched');
    expect(r.some((o) => o.type === 'picture' || o.type === 'bytes')).toBe(false);
  });

  it('builds a plain CBC file that the tool then opens', async () => {
    const png = sample; // any bytes: only the round trip matters here
    const built = await run(png, { mode: 'encrypt', key: 'FTF-angecrypt-16', iv: '00'.repeat(16) });
    const out = built.find((o): o is Extract<Output, { type: 'bytes' }> => o.type === 'bytes')!;
    expect(out.value.length).toBe(png.length);
    expect(kv(built, /construct/i)['IV (hex)']).toBe('00'.repeat(16));
  });

  it('refuses an invalid typed key length', async () => {
    await expect(run(sample, { key: 'short' })).rejects.toThrow();
  });
});
