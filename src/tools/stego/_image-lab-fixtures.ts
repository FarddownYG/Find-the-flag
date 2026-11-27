/**
 * Synthetic pictures for the image lab: its samples (scripts/gen-samples-image-lab.mjs loads this
 * file through Vite) and its tests. Everything is drawn here and encoded with fast-png; the
 * "photos" are a gradient plus deterministic sensor-like noise, so their low bits are noise the
 * way a camera's are. No real challenge file is used.
 */
import { encode as encodePng } from 'fast-png';
import { zipSync } from 'fflate';
import type { RgbaImage } from '../../core/types';
import { concatBytes, latin1Encode, utf8Encode } from '../../lib/bytes';
import { comment, ascii, pngChunk, pngWith, tEXt, tiff } from './_image-analyzer-fixtures';
import { drawCard, prng, type TextLine } from './_png-surgeon-fixtures';

export const pngBytes = (img: RgbaImage): Uint8Array =>
  encodePng({ width: img.width, height: img.height, data: img.data, channels: 4, depth: 8 });

/** A smooth scene with sensor noise of a few levels: its low bit planes are noise. */
export function photoLike(width: number, height: number, seed = 1): RgbaImage {
  const rnd = prng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const sky = 1 - y / height;
      data[o] = 60 + 120 * sky + 40 * Math.sin(x / 23) + (rnd() - 0.5) * 12;
      data[o + 1] = 90 + 90 * sky + 30 * Math.cos((x + y) / 31) + (rnd() - 0.5) * 12;
      data[o + 2] = 120 + 100 * sky + 20 * Math.sin(y / 17) + (rnd() - 0.5) * 12;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Pixels covered by text (1) on a w x h grid, drawn with the PNG surgeon's bitmap font. */
export function inkMask(width: number, height: number, lines: TextLine[]): Uint8Array {
  const card = drawCard(width, height, lines);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = card.data[i * 3] === 24 ? 1 : 0;
  return mask;
}

export const SECRET_LINES: TextLine[] = [{ text: 'FTF 2026', x: 24, y: 30, scale: 5 }];

/** Text written into bit 0 of the blue channel of a noisy picture: the plane shows it. */
export function bit0Text(): RgbaImage {
  const img = photoLike(256, 100, 11);
  const mask = inkMask(img.width, img.height, SECRET_LINES);
  for (let i = 0; i < mask.length; i++) {
    img.data[i * 4 + 2] = (img.data[i * 4 + 2]! & 0xfe) | mask[i]!;
  }
  return img;
}

/** Flat 200,200,200 with text in 200,200,201: invisible to the eye, obvious once remapped. */
export function nearBackground(): RgbaImage {
  const w = 256;
  const h = 100;
  const mask = inkMask(w, h, SECRET_LINES);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data.set([200, 200, 200 + mask[i]!, 255], i * 4);
  }
  return { width: w, height: h, data };
}

/** A PNG whose IHDR height was lowered (the CRC still matches the real height). */
export function falsifiedHeight(): { png: Uint8Array; realHeight: number; falseHeight: number } {
  const img = bit0Text();
  const png = pngBytes(img).slice();
  const falseHeight = 40;
  new DataView(png.buffer).setUint32(20, falseHeight); // IHDR height (offset 8 + 8 + 4)
  return { png, realHeight: img.height, falseHeight };
}

/** The message `lsbMessage` hidden zsteg style: b1, rgb, lsb first (MSB-first packing), xy. */
export const LSB_MESSAGE = 'FTF{lab_lsb_b1_rgb}';
export const META_COMMENT = 'FTF{lab_exif_comment}';
export const TEXT_CHUNK = 'FTF{lab_text_chunk}';
export const TRAILING_NOTE = 'FTF{lab_after_iend}';

/** Metadata, a text chunk, an LSB message and a ZIP glued after IEND, in one PNG. */
export function loaded(): Uint8Array {
  const img = photoLike(160, 120, 5);
  const bits: number[] = [];
  for (const byte of latin1Encode(LSB_MESSAGE))
    for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
  bits.forEach((bit, i) => {
    const p = Math.floor(i / 3) * 4 + (i % 3);
    img.data[p] = (img.data[p]! & 0xfe) | bit;
  });
  const exif = tiff({
    ifd0: [[0x010e, ascii('Lab sample picture')]],
    exif: [[0x9286, comment('ASCII', utf8Encode(META_COMMENT))]],
  });
  // Fixed mtime so the ZIP bytes are deterministic: fflate otherwise stamps the current time, which
  // makes the appended-archive strings (and this fixture's string count) vary between runs.
  const zip = zipSync({ 'note.txt': [utf8Encode(TRAILING_NOTE), { mtime: 1577836800000 }] });
  // Several distinct tEXt chunks so the strings table reliably exceeds its cap (the "show every
  // line" test needs more than a dozen strings, independent of run-to-run byte noise).
  return concatBytes(
    pngWith(
      pngBytes(img),
      pngChunk('eXIf', exif),
      tEXt('Comment', TEXT_CHUNK),
      tEXt('Title', 'Loaded sample picture'),
      tEXt('Author', 'Find The Flag samples'),
      tEXt('Software', 'ftf image lab fixture'),
      tEXt('Source', 'generated, not a real file'),
      tEXt('Warning', 'nothing secret here'),
      tEXt('Copyright', 'public sample set'),
    ),
    zip,
  );
}

/** A clean noisy picture: nothing hidden. */
export const cleanPhoto = (): RgbaImage => photoLike(240, 160, 3);

/** A big picture for the speed test (a plain gradient with noise). */
export const bigPicture = (side = 2000): RgbaImage => photoLike(side, side, 9);
