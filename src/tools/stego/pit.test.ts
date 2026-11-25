import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import { prepareInput } from '../../core/prepare';
import { resultToText } from '../../core/result-text';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import pit from './pit';

const SAMPLE = new URL('../../../public/samples/stego-pit.png', import.meta.url);
const FLAG = 'FTF{pit_indicator}';

const pngBytes = (img: RgbaImage) =>
  encode({
    width: img.width,
    height: img.height,
    data: new Uint8Array(img.data),
    channels: 4,
    depth: 8,
  });
const asInput = (img: RgbaImage): ImageInput => ({ image: img, bytes: pngBytes(img) });
const sample = async () =>
  (await prepareInput('image', { bytes: readFileSync(SAMPLE) })) as ImageInput;

const run = async (input: ImageInput, o: Record<string, unknown>): Promise<string> =>
  resultToText((await pit.run(input, o as never)) as Output[]);

/** The settings the sample was hidden with (scripts/gen-samples-stego.mjs). */
const SAMPLE_SETTINGS = {
  mode: 'decode',
  indicator: 'g',
  code00: 'none',
  code01: 'c1',
  code10: 'c2',
  code11: 'c2c1',
  bitsPerChannel: 2,
  bitOrder: 'msb',
  headerBytes: 8,
  headerEndian: 'be',
  headerPixel: 0,
  startMode: 'row',
  startRow: 1,
  message: '',
};

describe('PIT tool', () => {
  it('auto-finds the sample variant and the exact message', async () => {
    const text = await run(await sample(), { ...SAMPLE_SETTINGS, mode: 'auto' });
    expect(text).toContain(FLAG);
    expect(text).toMatch(/def chans/);
  });

  it('decodes the sample by hand with the right settings', async () => {
    expect(await run(await sample(), SAMPLE_SETTINGS)).toContain(FLAG);
  });

  it('does not recover the message with the wrong indicator or start row', async () => {
    const input = await sample();
    expect(await run(input, { ...SAMPLE_SETTINGS, indicator: 'b' })).not.toContain(FLAG);
    expect(await run(input, { ...SAMPLE_SETTINGS, startRow: 2 })).not.toContain(FLAG);
    // The trap: right after the header (still row 0) is not where the body is.
    expect(await run(input, { ...SAMPLE_SETTINGS, startMode: 'after' })).not.toContain(FLAG);
  });

  it('finds no message in the same cover without one', async () => {
    const { image } = await sample();
    // Wipe the payload: a calm gradient with every two low bits equal on all rows.
    const clean: RgbaImage = {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data.length),
    };
    for (let i = 0; i < clean.data.length; i++)
      clean.data[i] = i % 4 === 3 ? 255 : 100 + ((i >> 5) & 15);
    const text = await run(asInput(clean), { ...SAMPLE_SETTINGS, mode: 'auto' });
    expect(text).not.toContain('FTF{');
    expect(text).not.toMatch(/best candidates/i);
  });

  it('finds no message in a noisy image', async () => {
    const w = 64;
    const h = 40;
    const data = new Uint8ClampedArray(w * h * 4);
    let s = 3;
    for (let i = 0; i < data.length; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      data[i] = i % 4 === 3 ? 255 : (s >>> 16) & 255;
    }
    const text = await run(asInput({ width: w, height: h, data }), {
      ...SAMPLE_SETTINGS,
      mode: 'auto',
    });
    expect(text).not.toContain('FTF{');
  });

  it('round-trips encode → decode at the tool level (rotating indicator, 3 bits)', async () => {
    const { image } = await sample();
    const s = { ...SAMPLE_SETTINGS, indicator: 'rotate', bitsPerChannel: 3, bitOrder: 'lsb' };
    const enc = (await pit.run(asInput(image), {
      ...s,
      mode: 'encode',
      message: 'FTF{roundtrip}',
    } as never)) as Output[];
    const img = enc.find((x) => x.type === 'image');
    expect(img).toBeTruthy();
    expect(await run(asInput((img as { image: RgbaImage }).image), s)).toContain('FTF{roundtrip}');
  });

  it('refuses a message that does not fit', async () => {
    const { image } = await sample();
    await expect(
      run(asInput(image), { ...SAMPLE_SETTINGS, mode: 'encode', message: 'x'.repeat(5000) }),
    ).rejects.toThrow();
  });
});
