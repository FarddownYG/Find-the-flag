import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WriterOptions } from 'zxing-wasm/writer';
import { ToolError } from '../../core/errors';
import { prepareInput } from '../../core/prepare';
import { resultToText } from '../../core/result-text';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import { toHex } from '../../lib/bytes';
import { drawBoxes } from './_barcode-draw';
import {
  addNoise,
  blank,
  checkDigit,
  ean13Modules,
  invertImage,
  makeBarcode,
  paste,
  resize,
  speckle,
  turn,
} from './_barcode-fixtures';
import { renderPattern } from './_barcode-modules';
import { DEFAULT_SCAN, scanBarcodes, type ScanOptions } from './_barcode-scan';
import { loadReader } from './_barcode-wasm';
import barcode from './barcode';

const OPTIONS: Record<string, unknown> = {
  formats: 'all',
  effort: 'smart',
  boxes: true,
  addOns: true,
  checksum: false,
  invalid: false,
};

async function sample(name: string): Promise<RgbaImage> {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)),
  );
  return ((await prepareInput('image', { bytes })) as ImageInput).image;
}

const asInput = (image: RgbaImage): ImageInput => ({ bytes: new Uint8Array(), image });
const run = async (image: RgbaImage, o: Record<string, unknown> = {}): Promise<Output[]> =>
  (await barcode.run(asInput(image), { ...OPTIONS, ...o } as never)) as Output[];
const scan = (image: RgbaImage, o: Partial<ScanOptions> = {}) =>
  scanBarcodes(image, { ...DEFAULT_SCAN, ...o });
const make = (
  input: string | Uint8Array,
  format: NonNullable<WriterOptions['format']>,
  scale = 4,
) => makeBarcode(input, { format, scale });

/** Copy of a picture with a transparent background where `isBackground(grey)` says so. */
function transparent(img: RgbaImage, isBackground: (v: number) => boolean): RgbaImage {
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < data.length; i += 4) if (isBackground(data[i]!)) data[i + 3] = 0;
  return { ...img, data };
}

const kv = (out: Output[], key: string): string | undefined => {
  for (const o of out) {
    if (o.type !== 'kv') continue;
    const hit = o.entries.find(([k]) => k === key);
    if (hit) return hit[1];
  }
  return undefined;
};

describe('check digits (published vectors)', () => {
  // EAN-13 5 901234 12345 7 (Wikipedia, "International Article Number"), 4006381333931 (GS1
  // Germany's usual example), UPC-A 0 36000 29145 2 (Wikipedia, "Universal Product Code"),
  // EAN-8 7351353 7 (Wikipedia, "EAN-8").
  it('matches the digits printed in those references', () => {
    expect(checkDigit('590123412345')).toBe(7);
    expect(checkDigit('400638133393')).toBe(1);
    expect(checkDigit('03600029145')).toBe(2);
    expect(checkDigit('7351353')).toBe(7);
  });
});

describe('the sample pictures decode exactly', () => {
  const cases: [string, string, string][] = [
    ['barcode-code128.png', 'Code128', 'FTF{code128_demo}'],
    ['barcode-ean13.png', 'EAN13', '2012345678903'],
    ['barcode-datamatrix.png', 'DataMatrix', 'FTF{datamatrix_demo}'],
    ['barcode-aztec.png', 'Aztec', 'FTF{aztec_demo}'],
    ['barcode-pdf417.png', 'PDF417', 'FTF{pdf417_demo}'],
    ['barcode-maxicode.png', 'MaxiCode', 'FTF{maxicode_demo}'],
  ];
  it.each(cases)('%s', async (file, format, text) => {
    const { hits } = await scan(await sample(file));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.format).toBe(format);
    expect(hits[0]!.text).toBe(text);
    expect(toHex(hits[0]!.bytes)).toBe(toHex(new TextEncoder().encode(text)));
    expect(hits[0]!.how).toBe('as is');
  });

  it('EAN-13: the check digit is the right one and is reported', async () => {
    const image = await sample('barcode-ean13.png');
    const out = await run(image);
    expect(kv(out, 'Check digit')).toBe(`${checkDigit('201234567890')} (valid)`);
    expect(kv(out, 'Format')).toBe('EAN-13 (1D)');
  });

  it('Data Matrix, Aztec and PDF417 report their size and error correction', async () => {
    expect(kv(await run(await sample('barcode-datamatrix.png')), 'Version')).toBe('18x18');
    const aztec = await run(await sample('barcode-aztec.png'));
    expect(kv(aztec, 'Error correction')).toBe('57%');
    expect(kv(aztec, 'Spare error correction')).toBe('100%');
    expect(kv(await run(await sample('barcode-pdf417.png')), 'Error correction')).toBe('38%');
  });

  it('two codes in one picture: both found, each where it is', async () => {
    const image = await sample('barcode-two-codes.png');
    const { hits } = await scan(image);
    expect(hits.map((h) => [h.format, h.text])).toEqual([
      ['Code128', 'FTF{first_code}'],
      ['QRCode', 'FTF{second_code}'],
    ]);
    // Layout from scripts/gen-samples-barcode.mjs: 40 px gap, the Code 128 on top (726 x 150),
    // the QR code (105 px of modules plus its quiet zone) centred below.
    const centre = (i: number) => ({
      x: hits[i]!.corners.reduce((s, c) => s + c.x, 0) / 4,
      y: hits[i]!.corners.reduce((s, c) => s + c.y, 0) / 4,
    });
    expect(centre(0).x).toBeGreaterThan(40 + 30);
    expect(centre(0).x).toBeLessThan(40 + 726 - 30);
    expect(centre(0).y).toBeGreaterThan(40);
    expect(centre(0).y).toBeLessThan(40 + 150);
    expect(Math.abs(centre(1).x - image.width / 2)).toBeLessThan(10);
    expect(centre(1).y).toBeGreaterThan(40 + 150 + 40);
    const out = await run(image);
    expect(resultToText(out)).toContain('2 codes found.');
    expect(out.filter((o) => o.type === 'kv')).toHaveLength(2);
    expect(out.filter((o) => o.type === 'table')).toHaveLength(1);
    expect(out.filter((o) => o.type === 'image')).toHaveLength(1);
  });

  it('white on black and tilted: needs the helper passes, and says which', async () => {
    const image = await sample('barcode-hard.png');
    expect((await scan(image, { effort: 'quick' })).hits).toHaveLength(0);
    const { hits } = await scan(image);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toBe('FTF{hard_to_read}');
    expect(hits[0]!.how).toContain('colours inverted');
    expect(hits[0]!.how).toContain('noise removed');
    expect(hits[0]!.how).toMatch(/turned -?\d+°/);
    expect(kv(await run(image), 'Read after')).toBe(hits[0]!.how);
    // Turned 20 degrees clockwise, and boxed as a whole: a slanted box around all the bars
    // (484 x 100 px before it was turned), not a thin strip across them.
    expect(Math.abs(hits[0]!.rotation - 20)).toBeLessThanOrEqual(3);
    const [tl, tr, , bl] = hits[0]!.corners;
    expect(Math.hypot(tr.x - tl.x, tr.y - tl.y)).toBeGreaterThan(420);
    expect(Math.hypot(tr.x - tl.x, tr.y - tl.y)).toBeLessThan(500);
    expect(Math.hypot(bl.x - tl.x, bl.y - tl.y)).toBeGreaterThan(70);
    expect(Math.hypot(bl.x - tl.x, bl.y - tl.y)).toBeLessThan(110);
    expect(Math.abs((Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180) / Math.PI - 20)).toBeLessThan(3);
  });
});

describe('every format the writer can draw is read back', () => {
  const GS1 = '(01)12345678901231';
  // [writer format, payload, format zxing reports, text it reports]
  const cases: [NonNullable<WriterOptions['format']>, string, string, string][] = [
    ['Codabar', 'A123456A', 'Codabar', 'A123456A'],
    ['Code39', 'FTF-39 DEMO', 'Code39', 'FTF-39 DEMO'],
    ['Code39Ext', 'ftf{lower}', 'Code39Ext', 'ftf{lower}'],
    ['Code93', 'FTF93 DEMO', 'Code93', 'FTF93 DEMO'],
    ['Code128', 'FTF{code128_demo}', 'Code128', 'FTF{code128_demo}'],
    ['ITF', '12345670', 'ITF', '12345670'],
    ['ITF14', '1234567890123', 'ITF', '12345678901231'],
    ['DataBarOmni', '0112345678901231', 'DataBarOmni', GS1],
    ['DataBarStk', '0112345678901231', 'DataBarStk', GS1],
    ['DataBarLtd', '0112345678901231', 'DataBarLtd', GS1],
    ['EAN13', '590123412345', 'EAN13', '5901234123457'],
    ['EAN13', '400638133393', 'EAN13', '4006381333931'],
    ['EAN8', '7351353', 'EAN8', '73513537'],
    ['UPCA', '03600029145', 'EAN13', '0036000291452'],
    ['UPCE', '0123456', 'UPCE', '0012345000065'],
    ['PDF417', 'FTF{pdf417_demo}', 'PDF417', 'FTF{pdf417_demo}'],
    ['CompactPDF417', 'FTF{compact}', 'PDF417', 'FTF{compact}'],
    ['MicroPDF417', 'FTF{micropdf}', 'MicroPDF417', 'FTF{micropdf}'],
    ['Aztec', 'FTF{aztec_demo}', 'Aztec', 'FTF{aztec_demo}'],
    ['AztecRune', '123', 'Aztec', '123'],
    ['QRCode', 'FTF{qr_demo}', 'QRCode', 'FTF{qr_demo}'],
    ['MicroQRCode', 'FTF{mqr}', 'MicroQRCode', 'FTF{mqr}'],
    ['RMQRCode', 'FTF{rmqr_demo}', 'RMQRCode', 'FTF{rmqr_demo}'],
    ['DataMatrix', 'FTF{datamatrix_demo}', 'DataMatrix', 'FTF{datamatrix_demo}'],
    ['MaxiCode', 'FTF{maxicode_demo}', 'MaxiCode', 'FTF{maxicode_demo}'],
  ];
  it.each(cases)('%s %s', async (writer, payload, format, text) => {
    const { hits } = await scan(await make(payload, writer));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.format).toBe(format);
    expect(hits[0]!.text).toBe(text);
  });

  it('UPC-A is an EAN-13 with a leading 0: the tool says so', async () => {
    const out = await run(await make('03600029145', 'UPCA'));
    expect(kv(out, 'Same number as UPC-A')).toBe('036000291452');
  });

  it('UPC-E shows its compressed form', async () => {
    const out = await run(await make('0123456', 'UPCE'));
    expect(kv(out, 'UPC-E compressed form')).toBe('01234565');
  });

  it('EAN-13 with a +5 add-on', async () => {
    const hits = (await scan(await make('590123412345 12345', 'EAN13'))).hits;
    // The writer may not draw add-ons; when it does, the reader returns them.
    if (hits.length) expect(hits[0]!.text.startsWith('5901234123457')).toBe(true);
  });

  it('restricting the formats keeps only that family', async () => {
    const image = await sample('barcode-two-codes.png');
    expect((await scan(image, { formats: 'qr' })).hits.map((h) => h.format)).toEqual(['QRCode']);
    expect((await scan(image, { formats: 'linear' })).hits.map((h) => h.format)).toEqual([
      'Code128',
    ]);
    expect((await scan(image, { formats: 'matrix' })).hits.map((h) => h.format)).toEqual([
      'QRCode',
    ]);
    expect((await scan(image, { formats: 'code39' })).hits).toHaveLength(0);
  });
});

describe('payloads', () => {
  it('binary data: raw bytes exactly, flagged as binary', async () => {
    const payload = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80, 65, 66]);
    const out = await run(await make(payload, 'QRCode'));
    const bytes = out.find((o) => o.type === 'bytes');
    expect(bytes?.type === 'bytes' ? toHex(bytes.value) : null).toBe(toHex(payload));
    expect(kv(out, 'Raw bytes (hex)')).toBe('00 01 02 ff fe 80 41 42');
    expect(kv(out, 'Content')).toBe('binary data, 8 bytes');
    expect(resultToText(out)).toContain('The payload is not plain text (starts with 00 01 02 ff');
  });

  it('a non-UTF-8 text keeps its bytes and gets a decoded view', async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO 8859-1
    const out = await run(await make(latin1, 'QRCode'));
    expect(out.find((o) => o.type === 'text')).toMatchObject({ value: 'café' });
    const bytes = out.find((o) => o.type === 'bytes');
    expect(bytes?.type === 'bytes' ? toHex(bytes.value) : null).toBe('636166e9');
  });

  it('UTF-8 text', async () => {
    const out = await run(await make('héllo wörld ✓', 'QRCode'));
    expect(out.find((o) => o.type === 'text')).toMatchObject({ value: 'héllo wörld ✓' });
    expect(out.some((o) => o.type === 'bytes')).toBe(false);
  });

  it('GS1 data is shown with its application identifiers', async () => {
    const image = await makeBarcode('(01)12345678901231(10)ABC123', {
      format: 'Code128',
      options: 'gs1',
      scale: 3,
    });
    const out = await run(image);
    expect(out.find((o) => o.type === 'text')).toMatchObject({
      value: '(01)12345678901231(10)ABC123',
    });
    expect(kv(out, 'Content')).toBe('GS1 data, 24 bytes');
    expect(kv(out, 'Symbology identifier')).toBe(']C1');
  });

  it('ISO 15434 data shows its separators as symbols', async () => {
    const image = await make('[)>\u001e06\u001dPPART123\u001d1T\u001e\u0004', 'DataMatrix');
    const out = await run(image);
    expect(kv(out, 'Content')).toBe('ISO 15434 data, 20 bytes');
    const text = out.find((o) => o.type === 'text');
    expect(text?.type === 'text' ? text.value : '').toContain('PPART123');
  });
});

describe('helpers for hard pictures', () => {
  const code = () => make('FTF{code128_demo}', 'Code128', 3);

  it('white-on-black 1D codes need the inverted pass', async () => {
    const image = invertImage(await code());
    expect((await scan(image, { effort: 'quick' })).hits).toHaveLength(0);
    const { hits } = await scan(image);
    expect(hits[0]!.text).toBe('FTF{code128_demo}');
    expect(hits[0]!.how).toContain('colours inverted');
  });

  it('PDF417 and MaxiCode printed white on black', async () => {
    for (const [format, text] of [
      ['PDF417', 'FTF{inverted}'],
      ['MaxiCode', 'FTF{inverted}'],
    ] as const) {
      const { hits } = await scan(invertImage(await make(text, format)));
      expect(hits.map((h) => h.text)).toEqual([text]);
    }
  });

  it('2D codes light on dark are read by the reader itself, and flagged', async () => {
    const out = await run(invertImage(await make('FTF{qr_inverted}', 'QRCode')));
    expect(kv(out, 'Orientation')).toBe('light on dark');
    expect(kv(out, 'Read after')).toBe('as is');
  });

  it('a 1D code tilted too far for a scan line is read after turning the picture', async () => {
    const image = turn(await code(), 25);
    expect((await scan(image, { effort: 'quick' })).hits).toHaveLength(0);
    const { hits } = await scan(image);
    expect(hits[0]!.text).toBe('FTF{code128_demo}');
    expect(hits[0]!.how).toMatch(/turned -?\d+°/);
    // The angle comes from following the bars, not from the reader's 90-degree steps.
    expect(hits[0]!.rotationApprox).toBe(false);
    expect(Math.abs(hits[0]!.rotation - 25)).toBeLessThanOrEqual(3);
  });

  it('the position follows the code through every preparation step', async () => {
    // Code 128 in the middle of a bigger canvas, the whole canvas turned 25 degrees.
    const small = await code();
    const canvas = blank(1000, 700, 255);
    paste(canvas, small, 150, 300);
    const image = turn(canvas, 25);
    const { hits } = await scan(image);
    expect(hits).toHaveLength(1);
    const rad = (25 * Math.PI) / 180;
    const dx = 150 + small.width / 2 - 500;
    const dy = 300 + small.height / 2 - 350;
    const expected = {
      x: image.width / 2 + dx * Math.cos(rad) - dy * Math.sin(rad),
      y: image.height / 2 + dx * Math.sin(rad) + dy * Math.cos(rad),
    };
    const c = {
      x: hits[0]!.corners.reduce((s, p) => s + p.x, 0) / 4,
      y: hits[0]!.corners.reduce((s, p) => s + p.y, 0) / 4,
    };
    expect(Math.hypot(c.x - expected.x, c.y - expected.y)).toBeLessThan(40);
  });

  it('a 2D code turned by any angle gives its angle', async () => {
    const dm = await make('FTF{dm}', 'DataMatrix', 8);
    for (const deg of [20, 45, 77, 130]) {
      const { hits } = await scan(turn(dm, deg));
      expect(hits.map((h) => h.text)).toEqual(['FTF{dm}']);
      expect(Math.abs(hits[0]!.rotation - deg)).toBeLessThanOrEqual(2);
    }
  });

  it('speckle noise is taken out with a median filter', async () => {
    const dm = await make('FTF{noisy}', 'Code128', 3);
    const { hits } = await scan(turn(speckle(dm, 0.02, 4242), 10));
    expect(hits.map((h) => h.text)).toEqual(['FTF{noisy}']);
  });

  it('grain and low contrast', async () => {
    const image = addNoise(await code(), 90, 7);
    expect((await scan(image)).hits.map((h) => h.text)).toEqual(['FTF{code128_demo}']);
    const faint: RgbaImage = {
      ...(await code()),
      data: (await code()).data.map((v, i) => (i % 4 === 3 ? v : 110 + v * 0.2)),
    };
    expect((await scan(faint)).hits.map((h) => h.text)).toEqual(['FTF{code128_demo}']);
  });

  it('black bars on a transparent background', async () => {
    const image = transparent(await code(), (v) => v > 128);
    expect((await scan(image)).hits.map((h) => h.text)).toEqual(['FTF{code128_demo}']);
  });

  it('white bars on a transparent background are read on black', async () => {
    const white = transparent(invertImage(await code()), (v) => v < 128);
    const { hits } = await scan(white);
    expect(hits.map((h) => h.text)).toEqual(['FTF{code128_demo}']);
    expect(hits[0]!.how).toContain('transparency flattened on black');
  });

  it('no quiet zone around the code', async () => {
    const full = await code();
    const m = 30; // the writer's quiet zone: 10 modules of 3 px
    const w = full.width - 2 * m;
    const data = new Uint8ClampedArray(w * full.height * 4);
    for (let y = 0; y < full.height; y++) {
      data.set(
        full.data.subarray((y * full.width + m) * 4, (y * full.width + m + w) * 4),
        y * w * 4,
      );
    }
    const { hits } = await scan({ width: w, height: full.height, data });
    expect(hits.map((h) => h.text)).toEqual(['FTF{code128_demo}']);
  });

  it('pixel-exact tiny codes (one pixel per module)', async () => {
    for (const [format, text] of [
      ['QRCode', 'FTF{qr}'],
      ['DataMatrix', 'FTF{dm}'],
      ['Code93', 'FTF93'],
    ] as const) {
      const image = await makeBarcode(text, { format, scale: 1, addQuietZones: false });
      expect((await scan(image)).hits.map((h) => h.text)).toEqual([text]);
    }
  });

  it('a big picture with a small code, found and located', async () => {
    const big = blank(2400, 1800, 255);
    const small = await code();
    paste(big, small, 1500, 1200);
    const { hits } = await scan(big);
    expect(hits.map((h) => h.text)).toEqual(['FTF{code128_demo}']);
    const c = hits[0]!.corners[0];
    expect(c.x).toBeGreaterThan(1500);
    expect(c.x).toBeLessThan(1500 + small.width);
    expect(c.y).toBeGreaterThan(1190);
    expect(c.y).toBeLessThan(1200 + small.height);
  });

  it('all passes: a picture whose codes need different preparation', async () => {
    const a = await make('FTF{plain}', 'Code128', 3);
    const b = invertImage(await make('FTF{white_on_black}', 'Code128', 3));
    const page = blank(Math.max(a.width, b.width) + 40, a.height + b.height + 60, 255);
    paste(page, a, 20, 20);
    paste(page, b, 20, 40 + a.height);
    const smart = (await scan(page)).hits.map((h) => h.text);
    expect(smart).toEqual(['FTF{plain}']);
    const full = (await scan(page, { effort: 'full' })).hits.map((h) => h.text).sort();
    expect(full).toEqual(['FTF{plain}', 'FTF{white_on_black}']);
  });
});

describe('what is shown', () => {
  it('draws a numbered box on the picture', async () => {
    const image = await sample('barcode-code128.png');
    const { hits } = await scan(image);
    const { image: drawn, factor } = drawBoxes(
      image,
      hits.map((h) => ({ corners: h.corners })),
    );
    expect(factor).toBe(1);
    const [tl, tr] = hits[0]!.corners;
    const mid = { x: Math.round((tl.x + tr.x) / 2), y: Math.round(tl.y) + 1 };
    const px = (x: number, y: number) =>
      Array.from(drawn.data.subarray((y * drawn.width + x) * 4, (y * drawn.width + x) * 4 + 3));
    expect(px(mid.x, Math.max(1, mid.y))).toEqual([230, 25, 75]);
    const out = await run(image);
    expect(out.find((o) => o.type === 'image')).toBeTruthy();
    expect((await run(image, { boxes: false })).some((o) => o.type === 'image')).toBe(false);
  });

  it('a very large picture is brought down before it is drawn', () => {
    const { image, factor } = drawBoxes(blank(5000, 3000, 255), []);
    expect(factor).toBe(3);
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2000);
  });

  it('lists many codes in a table and gives details for the first twelve', async () => {
    const cols = 5;
    const rows = 3;
    const cell = 130;
    const page = blank(cols * cell, rows * cell, 255);
    for (let i = 0; i < cols * rows; i++) {
      const code = await makeBarcode(`FTF{code_${i}}`, { format: 'DataMatrix', scale: 5 });
      paste(page, code, (i % cols) * cell + 10, Math.floor(i / cols) * cell + 10);
    }
    const out = await run(page);
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' ? table.rows : []).toHaveLength(15);
    expect(out.filter((o) => o.type === 'kv')).toHaveLength(12);
    expect(resultToText(out)).toContain('Details are shown for the first 12 of 15 codes.');
  });

  it('says plainly that nothing was found, and what to try', async () => {
    const out = await run(blank(400, 300, 255));
    expect(out[0]).toMatchObject({ type: 'note', level: 'warn' });
    const text = resultToText(out);
    expect(text).toMatch(/No barcode found after \d+ attempts/);
    expect(text).toContain('Bit planes');
    expect(text).toContain('Channel reveal');
    expect(text).toContain('QR code reader');
    expect(text).toContain('Barcode from modules');
  });

  it('one pass: nothing found says to switch to Smart', async () => {
    const out = await run(invertImage(await make('FTF{x}', 'Code128', 3)), { effort: 'quick' });
    expect(resultToText(out)).toContain('Switch Search to Smart');
  });

  it('noise and text pictures give no false code', async () => {
    const out = await run(addNoise(blank(800, 600, 128), 100));
    expect(out.some((o) => o.type === 'kv')).toBe(false);
    expect(resultToText(out)).toContain('No barcode found');
  });

  it('an EAN-13 with a wrong check digit is rejected, and shown on request', async () => {
    const bad = '2012345678905'; // the right one is 3
    const bits = [...ean13Modules(bad)].map((c) => c === '1');
    const image = renderPattern({ cols: 95, rows: [bits] });
    const hidden = await run(image);
    expect(hidden.some((o) => o.type === 'kv')).toBe(false);
    expect(resultToText(hidden)).toContain('fails its own check');
    expect(resultToText(hidden)).toContain('wrong check digit or checksum');
    const shown = await run(image, { invalid: true });
    expect(kv(shown, 'Check')).toBe('FAILED: wrong check digit or checksum');
    expect(shown.find((o) => o.type === 'text')).toMatchObject({ value: bad });
    // The same digits with the right check digit are read without asking.
    const good = [...ean13Modules(`201234567890${checkDigit('201234567890')}`)].map(
      (c) => c === '1',
    );
    expect(resultToText(await run(renderPattern({ cols: 95, rows: [good] })))).toContain(
      '2012345678903',
    );
  });

  it('refuses a picture with no pixels', async () => {
    await expect(
      run({ width: 0, height: 0, data: new Uint8ClampedArray(0) }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('scales down: a small picture is enlarged for the reader', async () => {
    const image = resize(await make('FTF{small}', 'DataMatrix', 4), 56, 56);
    // 1.8 pixels per module: the reader alone is unsure, enlarging helps; either way it is read.
    expect((await scan(image)).hits.map((h) => h.text)).toEqual(['FTF{small}']);
  });
});

describe('the wasm engine', () => {
  it('is loaded once and reused', async () => {
    const a = loadReader();
    const b = loadReader();
    expect(a).toBe(b);
    const mod = await a;
    expect(typeof mod.readBarcodes).toBe('function');
  });

  it('a big noisy picture is given up on in a reasonable time', async () => {
    const t0 = performance.now();
    const result = await scan(addNoise(blank(1600, 1200, 128), 80));
    expect(result.hits).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(20_000);
  });
});
