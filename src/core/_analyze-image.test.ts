import { readFileSync } from 'node:fs';
import { encode } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { detectImage } from './_analyze-image';

const sample = (name: string) => new Uint8Array(readFileSync(`public/samples/${name}`));
const flags = (f: { flag?: string }[]) => f.map((x) => x.flag).filter(Boolean);

/** A deterministic PNG built from a pixel function (RGBA, 8 bits). */
function png(w: number, h: number, px: (x: number, y: number, c: number) => number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) data[(y * w + x) * 4 + c] = c === 3 ? 255 : px(x, y, c);
  return encode({ width: w, height: h, data, depth: 8, channels: 4 });
}

describe('detectImage on the fixtures', () => {
  it('stego-lsb.png yields a confirmed flag', async () => {
    const f = await detectImage(sample('stego-lsb.png'), 'stego-lsb.png');
    expect(flags(f)).toContain('flag{lsb_hidden_in_pixels}');
    expect(f.find((x) => x.flag)?.confidence).toBe('confirmed');
  });

  it('stego-pvd.png yields FTF{pvd_serpentine}', async () => {
    const f = await detectImage(sample('stego-pvd.png'));
    expect(flags(f)).toContain('FTF{pvd_serpentine}');
  });

  it('stego-pit.png yields FTF{pit_indicator}', async () => {
    const f = await detectImage(sample('stego-pit.png'));
    expect(flags(f)).toContain('FTF{pit_indicator}');
  });

  it('stego-lsb-zone.png yields FTF{lsb_row0_step2}', async () => {
    const f = await detectImage(sample('stego-lsb-zone.png'));
    expect(flags(f)).toContain('FTF{lsb_row0_step2}');
  });

  it('apng-hidden.png yields FTF{apng_frames} from the split frame notes', async () => {
    const f = await detectImage(sample('apng-hidden.png'));
    expect(flags(f)).toContain('FTF{apng_frames}');
  });

  it('every recovered flag carries confirmed confidence', async () => {
    for (const n of ['stego-lsb.png', 'stego-pvd.png', 'stego-pit.png', 'stego-lsb-zone.png']) {
      const f = await detectImage(sample(n));
      for (const x of f.filter((y) => y.flag)) expect(x.confidence).toBe('confirmed');
    }
  });
});

describe('detectImage on clean input: never confirmed', () => {
  it('returns [] for an undecodable JPEG', async () => {
    expect(await detectImage(sample('clean-photo.jpg'), 'clean-photo.jpg')).toEqual([]);
  });

  it('returns [] for random non-image bytes', async () => {
    expect(await detectImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([]);
  });

  const controls: [string, Uint8Array][] = [
    ['smooth gradient', png(96, 96, (x, y, c) => (x * 2 + y + c * 20) & 0xff)],
    ['flat colour', png(64, 64, () => 128)],
    [
      'photo-like texture',
      png(96, 96, (x, y, c) => Math.round(128 + 90 * Math.sin(x / 9 + c) * Math.cos(y / 11 - c))),
    ],
    [
      'noise',
      png(
        96,
        96,
        (x, y, c) => (Math.imul(x * 131 + y * 977 + c * 7919 + 1, 2654435761) >>> 24) & 0xff,
      ),
    ],
  ];
  for (const [label, bytes] of controls) {
    it(`${label}: zero confirmed findings`, async () => {
      const f = await detectImage(bytes);
      expect(f.filter((x) => x.confidence === 'confirmed')).toEqual([]);
      expect(flags(f)).toEqual([]);
    });
  }

  it('the clean PNG samples of the corpus: zero confirmed findings', async () => {
    for (const n of ['meta-plain.png', 'color-swatches.png', 'png-no-hint.png', 'emd-cover.png']) {
      const f = await detectImage(sample(n), n);
      expect(
        f.filter((x) => x.confidence === 'confirmed'),
        n,
      ).toEqual([]);
    }
  });
});
