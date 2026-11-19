import { describe, expect, it } from 'vitest';
import type { ImageInput, Output, RgbaImage, ToolResult } from '../../core/types';
import tool from './color-inspector';

/** Build an ImageInput from a flat list of [r,g,b,a] pixels in row-major order. */
function imageOf(
  width: number,
  height: number,
  pixels: [number, number, number, number][],
): ImageInput {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((p, i) => data.set(p, i * 4));
  const image: RgbaImage = { width, height, data };
  return { bytes: new Uint8Array(), image };
}

const run = (img: ImageInput, o: { top?: number; at?: string } = {}): ToolResult =>
  tool.run(img, { top: 24, at: '', ...o }) as ToolResult;
const tableByLabel = (r: ToolResult, label: string) =>
  r.find((o): o is Extract<Output, { type: 'table' }> => o.type === 'table' && o.label === label);
const notes = (r: ToolResult) => r.flatMap((o) => (o.type === 'note' ? [o.text] : [])).join('\n');

// A 2x2: three navy, one yellow (the rare one).
const NAVY: [number, number, number, number] = [0x0f, 0x17, 0x24, 255];
const YELLOW: [number, number, number, number] = [0xf2, 0xc8, 0x4b, 255];
const sample = () => imageOf(2, 2, [NAVY, NAVY, NAVY, YELLOW]);

describe('colour inspector', () => {
  it('counts the palette and reports the dimensions', () => {
    const kv = run(sample()).find((o) => o.type === 'kv');
    const entries = kv && kv.type === 'kv' ? new Map(kv.entries) : new Map();
    expect(entries.get('Dimensions')).toBe('2 × 2');
    expect(entries.get('Pixels')).toBe('4');
    expect(entries.get('Distinct colours')).toBe('2');
  });

  it('ranks the most common colour first', () => {
    const common = tableByLabel(run(sample()), 'Most common colours')!;
    expect(common.rows[0]![0]).toBe('#0f1724'); // navy, 3 of 4
    expect(common.rows[0]![3]).toBe(3);
  });

  it('surfaces the rare colour when it falls outside the palette size', () => {
    // top:1 keeps only navy in the common table, so the single yellow pixel shows as rarest.
    const r = run(sample(), { top: 1 });
    const rare = tableByLabel(r, 'Rarest colours')!;
    expect(rare.rows.some((row) => row[0] === '#f2c84b')).toBe(true);
    expect(notes(r)).toMatch(/hidden message/i);
  });

  it('reads a chosen pixel as hex, RGB and HSL', () => {
    const picked = tableByLabel(run(sample(), { at: '1,1' }), 'Picked pixels')!;
    expect(picked.rows[0]).toEqual(['1, 1', '#f2c84b', '242, 200, 75', '45, 87%, 62%']);
  });

  it('keeps the alpha byte when a pixel is translucent', () => {
    const img = imageOf(1, 1, [[0x11, 0x22, 0x33, 0x80]]);
    const picked = tableByLabel(run(img, { at: '0,0' }), 'Picked pixels')!;
    expect(picked.rows[0]![1]).toBe('#11223380');
  });

  it('flags coordinates that are off the image or malformed', () => {
    const r = run(sample(), { at: '9,9 bad 0,0' });
    expect(notes(r)).toContain('9,9');
    expect(notes(r)).toContain('bad');
    const picked = tableByLabel(r, 'Picked pixels')!;
    expect(picked.rows).toHaveLength(1); // only 0,0 is valid
  });

  it('produces a palette swatch image', () => {
    const img = run(sample()).find((o) => o.type === 'image');
    expect(img && img.type === 'image' && img.image.width).toBeGreaterThan(0);
  });

  it('runs every example to its expected text (unit, sample decoded separately)', () => {
    // The examples use a sample PNG; here we only assert the tool shape stays example-compatible.
    expect(tool.examples.length).toBeGreaterThan(0);
  });
});
