import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import { prepareInput } from '../../core/prepare';
import { resultToText } from '../../core/result-text';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import pvd from './pvd';

const SAMPLE = new URL('../../../public/samples/stego-pvd.png', import.meta.url);

/** A calm mid-range grey cover: every pair stays inside 0..255, so nothing falls off boundary. */
function cover(w: number, h: number, seed = 11): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < w * h; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const v = 90 + ((s >>> 16) % 70); // 90..159
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

const pngBytes = (img: RgbaImage) =>
  encode({
    width: img.width,
    height: img.height,
    data: new Uint8Array(img.data),
    channels: 4,
    depth: 8,
  });

const asInput = (img: RgbaImage, bytes = pngBytes(img)): ImageInput => ({ image: img, bytes });

const run = async (input: ImageInput, o: Record<string, unknown>): Promise<string> =>
  resultToText((await pvd.run(input, o as never)) as Output[]);

// The settings the sample was embedded with (scripts/gen-samples-stego.mjs).
const SAMPLE_SETTINGS = {
  mode: 'decode',
  table: 'wu-tsai',
  custom: '',
  traversal: 'serpentine',
  channel: 'gray',
  overflow: true,
  bitOrder: 'msb',
  stop: 'length',
  message: '',
};

describe('PVD tool', () => {
  it('auto-finds the message hidden with serpentine Wu & Tsai', async () => {
    const input = (await prepareInput('image', { bytes: readFileSync(SAMPLE) })) as ImageInput;
    const text = await run(input, { ...SAMPLE_SETTINGS, mode: 'auto' });
    expect(text).toContain('FTF{pvd_serpentine}');
  });

  it('decodes the sample by hand with the right settings', async () => {
    const input = (await prepareInput('image', { bytes: readFileSync(SAMPLE) })) as ImageInput;
    const text = await run(input, SAMPLE_SETTINGS);
    expect(text).toContain('FTF{pvd_serpentine}');
  });

  it('does not recover the message with the wrong traversal', async () => {
    const input = (await prepareInput('image', { bytes: readFileSync(SAMPLE) })) as ImageInput;
    const text = await run(input, { ...SAMPLE_SETTINGS, traversal: 'row' });
    expect(text).not.toContain('FTF{pvd_serpentine}');
  });

  it('round-trips encode → decode at the tool level', async () => {
    const enc = await pvd.run(asInput(cover(64, 48)), {
      ...SAMPLE_SETTINGS,
      mode: 'encode',
      message: 'FTF{roundtrip}',
    } as never);
    const imgOut = (enc as Output[]).find((o) => o.type === 'image');
    expect(imgOut).toBeTruthy();
    const stego = (imgOut as { image: RgbaImage }).image;
    const text = await run(asInput(stego), SAMPLE_SETTINGS);
    expect(text).toContain('FTF{roundtrip}');
  });

  it('warns on a JPEG (lossy formats destroy PVD differences)', async () => {
    const img = cover(32, 32);
    const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
    const text = await run(asInput(img, jpegMagic), { ...SAMPLE_SETTINGS, mode: 'auto' });
    expect(text).toMatch(/jpeg/i);
  });

  it('does not invent a flag in a plain cover image', async () => {
    const text = await run(asInput(cover(80, 60, 99)), { ...SAMPLE_SETTINGS, mode: 'auto' });
    expect(text).not.toContain('FTF{');
  });
});
