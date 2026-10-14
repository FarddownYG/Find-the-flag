import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareInput } from '../../core/prepare';
import { resultToText } from '../../core/result-text';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import { qrEncode, renderQr } from './_qr-encode';
import { scanQr } from './_qr-scan';
import qr from './qr';

const asInput = (image: RgbaImage): ImageInput => ({ bytes: new Uint8Array(), image });
const run = (image: RgbaImage) => qr.run(asInput(image), {}) as Output[];
const text = (out: Output[]) => {
  const t = out.find((o) => o.type === 'text');
  return t?.type === 'text' ? t.value : null;
};

async function sampleImage(): Promise<RgbaImage> {
  const bytes = new Uint8Array(
    readFileSync(new URL('../../../public/samples/stego-qr.png', import.meta.url)),
  );
  return ((await prepareInput('image', { bytes })) as ImageInput).image;
}

function blank(w: number, h: number, value: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4).fill(value);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width: w, height: h, data };
}
function paste(dst: RgbaImage, src: RgbaImage, x0: number, y0: number): void {
  for (let y = 0; y < src.height; y++) {
    dst.data.set(
      src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4),
      ((y0 + y) * dst.width + x0) * 4,
    );
  }
}
const invert = (img: RgbaImage): RgbaImage => ({
  ...img,
  data: img.data.map((v, i) => (i % 4 === 3 ? v : 255 - v)),
});
function crop(img: RgbaImage, m: number): RgbaImage {
  const w = img.width - 2 * m;
  const h = img.height - 2 * m;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    data.set(
      img.data.subarray(((y + m) * img.width + m) * 4, ((y + m) * img.width + m + w) * 4),
      y * w * 4,
    );
  }
  return { width: w, height: h, data };
}

describe('QR reader', () => {
  it('decodes the sample image and reports version and encoding', async () => {
    const out = run(await sampleImage());
    expect(text(out)).toBe('flag{qr_scanned}');
    const t = resultToText(out);
    expect(t).toContain('Version: 1 (21x21 modules)');
    expect(t).toContain('Encoding: byte');
    expect(t).toContain('Read after: as is');
    expect(t).toMatch(/Position: around \(116, 116\)/);
  });

  it('hard-coded sample matrix equals what a real encoder produces', async () => {
    const img = await sampleImage();
    const modules = qrEncode('flag{qr_scanned}');
    expect(modules.length).toBe(21);
    // Sample: 8 px per module, 4 modules quiet zone.
    for (let y = 0; y < 21; y++) {
      for (let x = 0; x < 21; x++) {
        const px = ((y + 4) * 8 + 4) * img.width + (x + 4) * 8 + 4;
        expect(img.data[px * 4] === 0).toBe(modules[y]![x]);
      }
    }
  });

  it('reads an inverted code (light modules on a dark background)', async () => {
    const out = run(invert(await sampleImage()));
    expect(text(out)).toBe('flag{qr_scanned}');
    expect(resultToText(out)).toContain('inverted');
  });

  it('reads a code with no quiet zone at all', async () => {
    const out = run(crop(await sampleImage(), 32));
    expect(text(out)).toBe('flag{qr_scanned}');
  });

  it('reads a tiny code (1 pixel per module) by upscaling', () => {
    const tiny = renderQr(qrEncode('tiny code'), 1, 0);
    const out = run(tiny);
    expect(text(out)).toBe('tiny code');
  });

  it('reads a low-contrast, noisy code after binarizing', () => {
    const light = renderQr(qrEncode('faint'), 6, 4, {
      dark: [120, 120, 120, 255],
      light: [150, 150, 150, 255],
    });
    let seed = 5;
    const noisy: RgbaImage = {
      ...light,
      data: light.data.map((v, i) => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return i % 4 === 3 ? v : v + ((seed >>> 16) % 9) - 4;
      }),
    };
    expect(text(run(noisy))).toBe('faint');
  });

  it('reads a code on a transparent background', () => {
    const img = renderQr(qrEncode('see through'), 8, 4, {
      dark: [0, 0, 0, 255],
      light: [0, 0, 0, 0],
    });
    const out = run(img);
    expect(text(out)).toBe('see through');
    expect(resultToText(out)).toContain('transparency flattened on white');
  });

  it('finds several codes and says where they are', () => {
    const page = blank(700, 300, 255);
    paste(page, renderQr(qrEncode('left code'), 8, 4), 10, 10);
    paste(page, renderQr(qrEncode('right code'), 8, 4), 380, 40);
    const { hits } = scanQr(page);
    expect(hits.map((h) => utf8Decode(Uint8Array.from(h.code.binaryData))).sort()).toEqual([
      'left code',
      'right code',
    ]);
    const out = run(page);
    expect(resultToText(out)).toContain('2 QR codes found.');
    const [a, b] = hits;
    expect(Math.abs(a!.centre.x - b!.centre.x)).toBeGreaterThan(200);
  });

  it('offers raw bytes for a binary payload', () => {
    const payload = Uint8Array.from([
      0x00, 0xff, 0x80, 0x01, 0xfe, 0x7f, 0x90, 0xa5, 0x50, 0x4b, 3, 4,
    ]);
    const out = run(renderQr(qrEncode(payload), 6, 4));
    const b = out.find((o) => o.type === 'bytes');
    if (b?.type !== 'bytes') throw new Error('no bytes output');
    expect(Array.from(b.value)).toEqual(Array.from(payload));
    expect(b.filename).toBe('qr-data.bin');
    expect(text(out)).toBeNull();
    expect(resultToText(out)).toContain('Payload: 12 bytes, binary');
  });

  it('decodes a larger version (5) and non-ASCII text', () => {
    const msg =
      'flag{' + 'é'.repeat(10) + '_and_a_rather_long_payload_to_force_version_4_0123456789}';
    const out = run(renderQr(qrEncode(msg), 5, 4));
    expect(text(out)).toBe(msg);
    expect(resultToText(out)).toContain('Version: 5 (37x37 modules)');
  });

  it('finds a small code inside a large image in reasonable time', () => {
    const big = blank(2400, 1800, 230);
    paste(big, renderQr(qrEncode('needle'), 9, 4), 1500, 900);
    const t0 = performance.now();
    const out = run(big);
    expect(text(out)).toBe('needle');
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(resultToText(out)).toMatch(/Position: around \(16\d\d, 10\d\d\)/);
  });

  it('says clearly when there is no code, without taking forever', () => {
    const noise = blank(500, 500, 0);
    let seed = 3;
    for (let i = 0; i < noise.data.length; i += 4) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      noise.data[i] = noise.data[i + 1] = noise.data[i + 2] = (seed >>> 16) & 255;
    }
    const t0 = performance.now();
    const out = run(noise);
    expect(resultToText(out)).toMatch(/No QR code found after \d+ attempts/);
    expect(out[0]).toMatchObject({ type: 'note', level: 'warn' });
    expect(performance.now() - t0).toBeLessThan(15000);
  }, 30000);

  it('rejects an image without pixels', () => {
    expect(() => run({ width: 0, height: 0, data: new Uint8ClampedArray(0) })).toThrow(/no pixels/);
  });
});

describe('test encoder', () => {
  it('round-trips through jsQR for all supported versions', () => {
    for (const len of [1, 17, 18, 32, 33, 53, 54, 78, 79, 106]) {
      const payload = utf8Encode('x'.repeat(len));
      const { hits } = scanQr(renderQr(qrEncode(payload), 4, 4));
      expect(hits).toHaveLength(1);
      expect(hits[0]!.code.binaryData.length).toBe(len);
    }
  });
});
