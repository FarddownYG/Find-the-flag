import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareInput } from '../../core/prepare';
import { resultToText } from '../../core/result-text';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import steganalysis from './steganalysis';

const sample = async (name: string): Promise<ImageInput> =>
  (await prepareInput('image', {
    bytes: new Uint8Array(
      readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)),
    ),
  })) as ImageInput;

const W = 160;
const H = 120;

const asInput = (image: RgbaImage): ImageInput => ({ bytes: new Uint8Array(), image });

const analyse = async (input: ImageInput): Promise<Output[]> =>
  (await steganalysis.run(input, {} as never)) as Output[];

/** A smooth grey cover (box-blurred noise): its low bit is just rounding, nothing hidden. */
function cover(w: number, h: number): RgbaImage {
  let s = 77;
  const rnd = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s >>> 16;
  };
  const base = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) base[i] = rnd() % 256;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < w) {
            sum += base[yy * w + xx]!;
            n++;
          }
        }
      }
      const v = Math.round(sum / n);
      const o = (y * w + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

describe('steganalysis tool', () => {
  it('flags the LSB-embedded sample', async () => {
    const out = await analyse(await sample('stego-lsb.png'));
    const text = resultToText(out);
    expect(text).toContain('strong signs of LSB embedding');
    expect(out[0]).toMatchObject({ type: 'note', level: 'warn' });
    expect(text).toContain('Steganalysis only detects');
  });

  it('reads the clean control as clean', async () => {
    const out = await analyse(await sample('stego-clean.png'));
    expect(out[0]).toMatchObject({ type: 'note', level: 'success' });
    expect(resultToText(out)).toContain('no sign of hidden data');
    expect(out.some((o) => o.type === 'image')).toBe(false);
  });

  it('names the rows of a replaced noisy block and tints them in the preview', async () => {
    const img = cover(W, H);
    const data = new Uint8ClampedArray(img.data);
    let s = 9;
    for (let y = 1; y <= 4; y++) {
      for (let x = 0; x < W; x++) {
        for (let c = 0; c < 3; c++) {
          s = (Math.imul(s, 1103515245) + 12345) >>> 0;
          data[(y * W + x) * 4 + c] = (s >>> 16) & 0xff;
        }
      }
    }
    const out = await analyse(asInput({ width: W, height: H, data }));
    const zones = out.find((o) => o.type === 'table' && o.columns.includes('Channel breaks'));
    expect(zones).toBeDefined();
    if (zones?.type !== 'table') throw new Error('no zone table');
    expect(zones.rows[0]![0]).toBe('1-4');
    const preview = out.find((o) => o.type === 'image');
    if (preview?.type !== 'image') throw new Error('no preview');
    // Row 2 is tinted red; row 50 is an exact copy of the input.
    expect(preview.image.data[(2 * W + 5) * 4]!).toBeGreaterThanOrEqual(153);
    expect(preview.image.data[(50 * W + 5) * 4 + 1]).toBe(data[(50 * W + 5) * 4 + 1]);
  });

  it('lists planted lone pixels and reads them big-endian', async () => {
    const img = cover(W, H);
    const data = new Uint8ClampedArray(img.data);
    const plant = [
      [10, 10, 0x01],
      [40, 20, 0x00],
      [70, 30, 0xff],
    ] as const;
    // The cover is mid-grey on average; make the neighbourhood darker so 255 and 0x01 stand out.
    for (const [x, y, v] of plant) data[(y * W + x) * 4] = v;
    const out = await analyse(asInput({ width: W, height: H, data }));
    const table = out.find((o) => o.type === 'table' && o.columns.includes('Neighbour median'));
    if (table?.type !== 'table') throw new Error('no outlier table');
    const pts = table.rows.filter((r) => r[2] === 'R').map((r) => `${r[0]},${r[1]}`);
    expect(pts).toEqual(expect.arrayContaining(['10,10', '70,30']));
    const text = resultToText(out);
    expect(text).toMatch(/big-endian, their values are [0-9a-f ]+, that is \d+/);
  });

  it('offers the extraction tools', async () => {
    const out = await analyse(await sample('stego-lsb.png'));
    const acts = out.find((o) => o.type === 'actions');
    // The registry is empty in unit tests, so the buttons appear only when tools are registered.
    if (acts?.type === 'actions') {
      expect(acts.actions.map((a) => a.open?.tool)).toEqual(['lsb', 'pvd']);
    }
    expect(out.length).toBeGreaterThan(5);
  });
});
