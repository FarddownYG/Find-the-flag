import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareInput } from '../../core/prepare';
import { resultToText } from '../../core/result-text';
import type { GalleryItem, ImageInput, Output, RgbaImage } from '../../core/types';
import { decodeJpeg } from './_image-analyzer-thumb';
import {
  bigPicture,
  bit0Text,
  cleanPhoto,
  falsifiedHeight,
  loaded,
  META_COMMENT,
  nearBackground,
  pngBytes,
  TEXT_CHUNK,
  TRAILING_NOTE,
} from './_image-lab-fixtures';
import { findNearColours, pickSuspects } from './_image-lab-triage';
import tool from './image-lab';

const defaults = { maxSide: 1200, minLength: 8, showAll: false, writeup: false };

async function lab(bytes: Uint8Array, o: Partial<typeof defaults> = {}) {
  const input = (await prepareInput('image', { bytes, name: 'lab.png' })) as ImageInput;
  return (await tool.run(input, { ...defaults, ...o })) as Output[];
}

const galleryOf = (out: Output[]) => {
  const g = out.find((o) => o.type === 'gallery');
  if (g?.type !== 'gallery') throw new Error('no gallery');
  return g;
};
const itemsOf = (out: Output[]): GalleryItem[] => galleryOf(out).groups.flatMap((g) => g.items);
const suspects = (out: Output[]) => itemsOf(out).filter((i) => i.suspect);
const pixels = (items: GalleryItem[]) =>
  items.reduce((n, i) => n + i.image.width * i.image.height, 0);

describe('image-lab triage', () => {
  it('ranks the plane that carries text first', async () => {
    const out = await lab(pngBytes(bit0Text()));
    const g = galleryOf(out);
    expect(g.lookFirst?.[0]).toBe('plane-b0');
    expect(suspects(out).map((i) => i.id)).toContain('plane-b0');
    expect(resultToText(out)).toContain('Look first: B0 · blue bit 0 (lowest)');
  });

  it('flags the remaps that reveal a near-background text', async () => {
    const out = await lab(pngBytes(nearBackground()));
    const flagged = suspects(out).map((i) => i.id);
    expect(flagged).toContain('remap-all');
    expect(flagged).toContain('remap-step32');
    const reason = itemsOf(out).find((i) => i.id === 'remap-all')!.note;
    expect(reason).toContain('#c8c8c8');
    expect(reason).toContain('#c8c8c9');
    // The picture really is invisible: one level apart in blue.
    const near = findNearColours(nearBackground())!;
    expect(near.gap).toBe(1);
  });

  it('gives a clean photo no suspect and says what was checked', async () => {
    const out = await lab(pngBytes(cleanPhoto()));
    expect(galleryOf(out).lookFirst).toEqual([]);
    expect(suspects(out)).toEqual([]);
    expect(resultToText(out)).toContain('Nothing stands out');
  });

  it('gives a decoded JPEG photo no suspect either', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../public/samples/clean-photo.jpg', import.meta.url)),
    );
    const image: RgbaImage = decodeJpeg(bytes);
    const out = (await tool.run({ bytes, name: 'clean-photo.jpg', image }, defaults)) as Output[];
    expect(suspects(out)).toEqual([]);
  });

  it('keeps a plane suspect only when it stands out from the others', () => {
    const flat = ['a', 'b', 'c', 'd'].map((id) => ({ id, score: 0.4 }));
    expect(pickSuspects(flat)).toEqual([]);
    const one = [...flat.slice(0, 3).map((s) => ({ ...s, score: 0.02 })), { id: 'x', score: 0.6 }];
    expect(pickSuspects(one).map((s) => s.id)).toEqual(['x']);
    expect(
      pickSuspects([
        { id: 'low', score: 0.1 },
        { id: 'n', score: 0 },
      ]),
    ).toEqual([]);
  });

  it('does not see near colours in a photo', () => {
    expect(findNearColours(cleanPhoto())).toBeNull();
  });
});

describe('image-lab structure and hidden data', () => {
  it('repairs a falsified IHDR height and analyses the real picture', async () => {
    const { png, realHeight, falseHeight } = falsifiedHeight();
    const input = (await prepareInput('image', { bytes: png })) as ImageInput;
    expect(input.image.height).toBe(falseHeight); // the decoder only sees the cropped picture
    const out = (await tool.run(input, defaults)) as Output[];
    const repaired = itemsOf(out).find((i) => i.id === 'repaired')!;
    expect(repaired.image.height).toBe(realHeight);
    expect(repaired.suspect).toBe(true);
    expect(galleryOf(out).lookFirst?.[0]).toBe('repaired');
    const text = resultToText(out);
    expect(text).toContain(`256×${falseHeight}`);
    expect(text).toContain('repaired.png');
    // The planes are drawn from the repaired picture, so its text plane is found too.
    expect(galleryOf(out).lookFirst).toContain('plane-b0');
  });

  it('surfaces EXIF, tEXt, data after IEND and the LSB message', async () => {
    const out = await lab(loaded());
    const text = resultToText(out);
    expect(text).toContain(META_COMMENT);
    expect(text).toContain(TEXT_CHUNK);
    expect(text).toContain('after the end of the image');
    expect(text).toContain(TRAILING_NOTE);
    const lsb = out.find((o) => o.type === 'table' && o.label?.includes('LSB'));
    expect(lsb?.type === 'table' && String(lsb.rows[0]?.[2])).toContain('FTF{lab_lsb_b1_rgb}');
    expect(lsb?.type === 'table' && lsb.rows[0]?.[0]).toContain('rgb, bit 0');
  });

  it('caps the strings table and lifts the cap on request', async () => {
    const bytes = loaded();
    const short = resultToText(await lab(bytes, { minLength: 3 }));
    const all = resultToText(await lab(bytes, { minLength: 3, showAll: true }));
    expect(short).toContain('turn on');
    expect(all.length).toBeGreaterThan(short.length);
  });

  it('gives honest password-tool commands and never runs them', async () => {
    const out = await lab(pngBytes(cleanPhoto()));
    const text = resultToText(out);
    expect(text).toContain("openstego.jar extract -sf 'lab.png'");
    expect(text).toContain('steghide');
    expect(text).toContain('never guesses');
  });

  it('adds a writeup on request', async () => {
    const out = await lab(pngBytes(bit0Text()), { writeup: true });
    const w = out.find((o) => o.type === 'text');
    expect(w?.type === 'text' && w.value).toContain('# Image analysis writeup');
  });
});

describe('image-lab on a big picture', () => {
  it('finishes a 2000×2000 image quickly with a bounded gallery', async () => {
    const big = bigPicture(2000);
    const bytes = pngBytes(big);
    const start = Date.now();
    const out = await lab(bytes);
    const ms = Date.now() - start;
    expect(ms).toBeLessThan(20_000);
    expect(resultToText(out)).toContain('shrunk to 1200×1200');
    const items = itemsOf(out);
    expect(
      Math.max(...items.map((i) => Math.max(i.image.width, i.image.height))),
    ).toBeLessThanOrEqual(1200);
    // Structured-clone payload: well under 25 million pixels (100 MB).
    expect(pixels(items)).toBeLessThan(25_000_000);
    expect(items.length).toBeGreaterThan(60);
  });
});
