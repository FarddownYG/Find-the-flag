import { readFileSync } from 'node:fs';
import { decode } from 'fast-png';
import { Unzlib, unzipSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { defaultOptions } from '../../core/registry';
import { resultToText } from '../../core/result-text';
import type { AnyTool, Output, RgbaImage } from '../../core/types';
import { concatBytes, latin1Encode, utf8Decode, utf8Encode } from '../../lib/bytes';
import { crc32 } from '../../lib/signatures';
import tool from './png-surgeon';
import { ihdrCrc, parsePng } from './_png';
import { DEFAULT_OPTIONS, type SurgeryOptions } from './_png-surgeon-core';
import {
  assemble,
  brokenOriginal,
  buildBroken,
  buildNoHint,
  buildShuffled,
  drawCard,
  encodeParts,
  noHintOriginal,
  pngChunk,
  PNG_SIG,
  prng,
  type RgbImage,
  rgbToRgba,
  SHUFFLE_SEQ,
  shuffleByPositions,
  shuffledOriginal,
  splitStream,
  tEXt,
} from './_png-surgeon-fixtures';
import { applyReading, isNumberList, toPermutation } from './_png-surgeon-order';
import { parseTolerant } from './_png-surgeon-parse';
import { checkStream, headerCandidates, heightForSize, layoutOf } from './_png-surgeon-zlib';

type Opts = Partial<SurgeryOptions>;
const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));
const run = (bytes: Uint8Array, opts: Opts = {}, name = 'test.png') =>
  tool.run({ bytes, name }, { ...DEFAULT_OPTIONS, ...opts }) as Output[];
const summary = (out: Output[]) => {
  const n = out[0];
  if (n?.type !== 'note') throw new Error('no summary');
  return n;
};
const imageOf = (out: Output[]) => {
  const o = out.find((x) => x.type === 'image');
  if (o?.type !== 'image') throw new Error('no image');
  return o;
};
const filesOf = (out: Output[]) => {
  const o = out.find((x) => x.type === 'files');
  return o?.type === 'files' ? o.files : [];
};
const kvOf = (out: Output[], label: string) => {
  const o = out.find((x) => x.type === 'kv' && x.label === label);
  if (o?.type !== 'kv') throw new Error(`no kv ${label}`);
  return Object.fromEntries(o.entries);
};
const tableOf = (out: Output[], label: string) => {
  const o = out.find((x) => x.type === 'table' && x.label === label);
  if (o?.type !== 'table') throw new Error(`no table ${label}`);
  return o;
};
const actionsOf = (out: Output[]) => out.flatMap((o) => (o.type === 'actions' ? o.actions : []));
const reorderOf = (out: Output[]) => {
  const o = out.find((x) => x.type === 'reorder');
  if (o?.type !== 'reorder') throw new Error('no reorder block');
  return o;
};
/** Compare an RGBA output with the RGB drawing it must reproduce exactly. */
const samePixels = (img: RgbaImage, original: RgbImage) => {
  const want = rgbToRgba(original);
  expect([img.width, img.height]).toEqual([want.width, want.height]);
  let diff = 0;
  for (let i = 0; i < want.data.length; i++) if (img.data[i] !== want.data[i]) diff++;
  expect(diff).toBe(0);
};
/** The repaired file, decoded by fast-png directly (not through the tool). */
const repairedFile = (out: Output[]) => {
  const f = filesOf(out).find((x) => x.name.endsWith('-repaired.png'));
  if (!f) throw new Error('no repaired file');
  return f.data;
};

const ORIGINAL = shuffledOriginal();
/** Pieces of the shuffled sample's stream, in the right order. */
const PIECES = splitStream(encodeParts(ORIGINAL).zlib, SHUFFLE_SEQ.length, 11);
const IHDR = encodeParts(ORIGINAL).ihdr;
const shuffledWith = (before: Uint8Array[], seq = SHUFFLE_SEQ, pieces = PIECES, ihdr = IHDR) =>
  assemble({ ihdr, before, idats: shuffleByPositions(pieces, seq) });
/** The position→chunk form of a chunk→position sequence (its inverse). */
const inverse = (seq: number[]) => {
  const out = new Array<number>(seq.length);
  seq.forEach((pos, j) => (out[pos - 1] = j + 1));
  return out;
};
/** Offset of the n-th (1-based) chunk of a PNG. */
const chunkOffset = (png: Uint8Array, n: number) => parsePng(png)!.chunks[n - 1]!.offset;

describe('samples', () => {
  it('are exactly what the generator script writes', () => {
    expect(sample('png-shuffled-idat.png')).toEqual(buildShuffled());
    expect(sample('png-no-hint.png')).toEqual(buildNoHint());
    expect(sample('png-broken.png')).toEqual(buildBroken());
  });

  it('shuffled: the order hint is applied, pixels identical to the drawing', () => {
    const png = sample('png-shuffled-idat.png');
    // What a normal decoder sees: the file does not decode.
    expect(() => decode(png)).toThrow();
    const out = run(png, {}, 'png-shuffled-idat.png');
    expect(summary(out)).toEqual({
      type: 'note',
      level: 'success',
      text: "Restored: 11 IDAT chunks reordered (hint 'order', chunk→position); zlib stream OK; image below.",
    });
    samePixels(imageOf(out).image, ORIGINAL);
    // The downloadable file is a valid PNG on its own: every CRC right, decodes the same.
    const fixed = repairedFile(out);
    expect(parsePng(fixed)!.chunks.every((c) => c.crcOk)).toBe(true);
    const d = decode(fixed);
    expect([d.width, d.height, d.channels]).toEqual([320, 120, 3]);
    expect(Buffer.from(d.data as Uint8Array).equals(Buffer.from(ORIGINAL.data))).toBe(true);
    // Text chunks are kept (Comment, order) and IDATs are consecutive, in the restored order.
    expect(parsePng(fixed)!.chunks.map((c) => c.type)).toEqual([
      'IHDR',
      'tEXt',
      'tEXt',
      ...Array(11).fill('IDAT'),
      'IEND',
    ]);
  });

  it('no hint: the order is searched, pixels identical to the drawing', () => {
    const out = run(sample('png-no-hint.png'));
    expect(summary(out).text).toBe(
      'Restored: 11 IDAT chunks reordered (order found without a hint); zlib stream OK; image below.',
    );
    samePixels(imageOf(out).image, noHintOriginal());
    expect(resultToText(out)).toMatch(/Order found without a hint in \d+ tries: [\d ]+\./);
    // Offered as a manual order too, and that order works as typed.
    const apply = actionsOf(out).find((a) => a.label === 'Apply the order found')!;
    const again = run(sample('png-no-hint.png'), apply.options as Opts);
    expect(summary(again).text).toContain('(order set in the list)');
    samePixels(imageOf(again).image, noHintOriginal());
  });

  it('broken: signature, zlib header, CRCs, height and the ZIP after IEND', () => {
    const out = run(sample('png-broken.png'), {}, 'png-broken.png');
    expect(summary(out).text).toBe(
      'Restored: PNG signature fixed; zlib header 00 00 → 78 9C; 2 CRCs recomputed; height 60 → 120; zlib stream OK; image below. After IEND: ZIP archive (see Files).',
    );
    samePixels(imageOf(out).image, brokenOriginal());
    const fixed = repairedFile(out);
    expect(parsePng(fixed)!.signatureOk).toBe(true);
    expect(parsePng(fixed)!.chunks.every((c) => c.crcOk)).toBe(true);
    expect(decode(fixed).height).toBe(120);
    const ihdr = kvOf(out, 'IHDR');
    expect(ihdr.Stored).toBe('320×60, 8-bit RGB');
    expect(ihdr.Written).toBe(
      '320×120, 8-bit RGB — IHDR CRC brute force, matches the decompressed size',
    );
    expect(kvOf(out, 'zlib stream')['Expected from IHDR']).toBe('57660 bytes');
    const zip = filesOf(out).find((f) => f.name === 'png-broken-after-iend.zip')!;
    expect(utf8Decode(unzipSync(zip.data)['readme.txt']!)).toContain('appended after IEND');
    expect(resultToText(out)).toContain('The PNG signature is damaged (89 50 4E 47 0D 00 1A 0A)');
    // The candidate heights are one click away.
    const heights = actionsOf(out).map((a) => a.label);
    expect(heights).toContain('Height 60 (as stored)');
    expect(heights).not.toContain('Height 120');
    const cropped = run(sample('png-broken.png'), { height: 60 });
    expect(imageOf(cropped).image.height).toBe(60);
    // Back to the full height in one click.
    const labels = actionsOf(cropped).map((a) => a.label);
    expect(labels).toEqual(expect.arrayContaining(['Height 120', 'Automatic size']));
  });
});

describe('IDAT order', () => {
  it('tries both readings and keeps the one that inflates', () => {
    const out = run(sample('png-shuffled-idat.png'));
    const tried = tableOf(out, 'Orders tried').rows;
    expect(tried.map((r) => [r[0], r[1], r[3]])).toEqual([
      ["hint 'order'", 'chunk→position', 'OK'],
      [
        "hint 'order'",
        'position→chunk',
        'IDAT #4 comes first but does not start with a zlib header (80 25)',
      ],
    ]);
    // The same arrangement written as position→chunk: now that reading wins.
    const png = shuffledWith([tEXt('order', inverse(SHUFFLE_SEQ).join(' '))]);
    const out2 = run(png);
    expect(summary(out2).text).toContain("(hint 'order', position→chunk)");
    samePixels(imageOf(out2).image, ORIGINAL);
  });

  it('reports a forced wrong reading and offers the other one', () => {
    const out = run(sample('png-shuffled-idat.png'), { reading: 'position' });
    expect(summary(out).level).toBe('error');
    expect(summary(out).text).toBe(
      "Not restored: the hint 'order' gives no valid zlib stream (position→chunk: IDAT #4 comes first but does not start with a zlib header (80 25)).",
    );
    expect(actionsOf(out).map((a) => a.label)).toContain('Try both readings');
  });

  it('reads 0- and 1-based hints with any separator, and plain number lists', () => {
    for (const text of [
      SHUFFLE_SEQ.map((v) => v - 1).join('-'),
      SHUFFLE_SEQ.join(', '),
      `order: ${SHUFFLE_SEQ.join(';')}`,
    ]) {
      const out = run(shuffledWith([tEXt('IDAT order', text)]));
      expect(summary(out).text).toContain('chunk→position');
      samePixels(imageOf(out).image, ORIGINAL);
    }
    // No telling keyword, but the text is nothing but the numbers.
    const plain = run(shuffledWith([tEXt('Comment', SHUFFLE_SEQ.join(' '))]));
    expect(summary(plain).text).toContain("hint 'Comment'");
    // A typed 0-based order.
    const typed = run(sample('png-shuffled-idat.png'), {
      order: SHUFFLE_SEQ.map((v) => v - 1).join(' '),
    });
    expect(summary(typed).text).toContain('typed order, chunk→position');
  });

  it('explains hints and typed orders that cannot be permutations', () => {
    const short = run(shuffledWith([tEXt('order', SHUFFLE_SEQ.slice(1).join(' '))]));
    expect(resultToText(short)).toContain(
      'The text chunk «order» looks like an order hint, but it has 10 numbers for 11 IDAT chunks.',
    );
    const dup = run(sample('png-shuffled-idat.png'), { order: '1 1 2 3 4 5 6 7 8 9 10' });
    expect(summary(dup).text).toBe('Not restored: Order: 1 appears twice.');
    const range = run(sample('png-shuffled-idat.png'), { order: '1 2 3 4 5 6 7 8 9 10 12' });
    expect(summary(range).text).toContain('12 is not an IDAT chunk number (1 to 11, or 0 to 10)');
    expect(toPermutation([0, 2, 1], 3)).toEqual({ perm: [0, 2, 1], zeroBased: true });
    expect(applyReading([2, 0, 1], 'chunk')).toEqual([1, 2, 0]);
    expect(isNumberList(SHUFFLE_SEQ.join(' '))).toBe(true);
    expect(isNumberList('Created in 2024 by 3 people')).toBe(false);
  });

  it('manual reorder: breaking the order fails, the hint action restores it', () => {
    const png = sample('png-shuffled-idat.png');
    const ok = run(png);
    const ids = reorderOf(ok).items.map((i) => i.id);
    expect(reorderOf(ok).option).toBe('order');
    // The ids in the block are a working order (position→chunk) on their own.
    const same = run(png, { order: ids.join(' ') });
    expect(summary(same).level).toBe('success');
    samePixels(imageOf(same).image, ORIGINAL);
    // ↓ on the first item: swap the first two.
    const broken = [ids[1]!, ids[0]!, ...ids.slice(2)];
    const bad = run(png, { order: broken.join(' ') });
    expect(summary(bad).level).toBe('error');
    expect(summary(bad).text).toMatch(
      /^Not restored: the order set in the list \(#…\) gives no valid/,
    );
    const useHint = actionsOf(bad).find((a) => a.label === "Use the hint 'order'")!;
    expect(useHint.primary).toBe(true);
    const back = run(png, useHint.options as Opts);
    expect(summary(back).level).toBe('success');
    samePixels(imageOf(back).image, ORIGINAL);
  });

  it('searches up to 12 chunks and says so clearly above that, without hanging', () => {
    const many = (count: number, seed: number) => {
      const pieces = splitStream(encodeParts(ORIGINAL).zlib, count, seed);
      const seq = Array.from({ length: count }, (_, i) => i + 1);
      const r = prng(seed);
      for (let i = seq.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [seq[i], seq[j]] = [seq[j]!, seq[i]!];
      }
      return shuffledWith([], seq, pieces);
    };
    const t0 = performance.now();
    const twelve = run(many(12, 4));
    expect(summary(twelve).text).toContain('order found without a hint');
    samePixels(imageOf(twelve).image, ORIGINAL);
    const sixteen = run(many(16, 9));
    // Generous bound (slow CI): the point is that nothing hangs.
    expect(performance.now() - t0).toBeLessThan(20_000);
    expect(summary(sixteen).text).toMatch(
      /^Not restored: with the IDAT chunks in file order, .+; there is no hint and the automatic search stops at 12 chunks \(there are 16\): type the order in Order\.$/,
    );
    // Still a partial rendering of what decodes, and the reorder block to fix it by hand.
    expect(reorderOf(sixteen).items).toHaveLength(16);
  }, 60_000);

  it('restores an Adam7 interlaced image', () => {
    const img = drawCard(97, 61, [{ text: 'ADAM7', x: 4, y: 20, scale: 3 }]);
    const { ihdr, zlib } = encodeParts(img, 'Adam7');
    expect(ihdr[12]).toBe(1);
    const seq = [5, 2, 7, 1, 3, 8, 6, 4];
    const pieces = splitStream(zlib, seq.length, 3);
    const png = assemble({
      ihdr,
      before: [tEXt('sequence', seq.join(' '))],
      idats: shuffleByPositions(pieces, seq),
    });
    const out = run(png);
    expect(summary(out).text).toBe(
      "Restored: 8 IDAT chunks reordered (hint 'sequence', chunk→position); zlib stream OK; image below.",
    );
    samePixels(imageOf(out).image, img);
    // Adam7 sizes: the inflated size gives the height back.
    const h = {
      width: 97,
      height: 61,
      bitDepth: 8,
      colorType: 2,
      compression: 0,
      filter: 0,
      interlace: 1,
    };
    expect(heightForSize(h, layoutOf(h)!.total)).toBe(61);
    expect(layoutOf(h)!.passes).toHaveLength(7);
  });

  it('a 2000×2000 picture with 40 IDAT chunks and a hint stays interactive', () => {
    const img = drawCard(2000, 2000, [{ text: 'FTF CHUNK SURGEON', x: 40, y: 900, scale: 18 }]);
    const r = prng(5);
    for (let i = 0; i < img.data.length; i++) img.data[i] = (img.data[i]! + ((r() * 24) | 0)) & 255;
    const { ihdr, zlib } = encodeParts(img);
    const seq = Array.from({ length: 40 }, (_, i) => i + 1);
    const rr = prng(99);
    for (let i = seq.length - 1; i > 0; i--) {
      const j = Math.floor(rr() * (i + 1));
      [seq[i], seq[j]] = [seq[j]!, seq[i]!];
    }
    const png = assemble({
      ihdr,
      before: [tEXt('order', seq.join(','))],
      idats: shuffleByPositions(splitStream(zlib, 40, 3), seq),
    });
    const t0 = performance.now();
    const out = run(png);
    const ms = performance.now() - t0;
    expect(summary(out).text).toContain('40 IDAT chunks reordered');
    expect(imageOf(out).image.width).toBe(2000);
    // About 0.3 s here; the bound is loose so that a slow CI machine does not flake.
    expect(ms).toBeLessThan(6000);
  }, 60_000);
});

describe('tolerant parsing', () => {
  it('resynchronises after an impossible length instead of stopping', () => {
    const png = buildShuffled().slice();
    // IDAT #5 of the file (chunk 8) claims 4 GB.
    new DataView(png.buffer).setUint32(chunkOffset(png, 8), 0xffffff00);
    // _png.parsePng (like pngcheck) stops there.
    const strict = parsePng(png)!;
    expect(strict.problem).not.toBeNull();
    expect(strict.chunks.length).toBe(7);
    const p = parseTolerant(png)!;
    expect(p.chunks.map((c) => c.type).filter((t) => t === 'IDAT')).toHaveLength(11);
    expect(p.chunks[7]!.status).toBe('length-fixed');
    expect(p.chunks.at(-1)!.type).toBe('IEND');
    const out = run(png);
    expect(summary(out).text).toBe(
      "Restored: 1 chunk length repaired; 11 IDAT chunks reordered (hint 'order', chunk→position); zlib stream OK; image below.",
    );
    samePixels(imageOf(out).image, ORIGINAL);
    expect(resultToText(out)).toContain('the length field says 4294967040: the real length is');
  });

  it('a length too small, garbage between chunks and a garbled type', () => {
    const png = buildShuffled();
    const at = chunkOffset(png, 6);
    const small = png.slice();
    const dv = new DataView(small.buffer);
    dv.setUint32(at, dv.getUint32(at) - 100);
    expect(parseTolerant(small)!.chunks[5]!.status).toBe('length-fixed');
    expect(summary(run(small)).level).toBe('success');

    const junk = new Uint8Array(37).map((_, i) => (i * 73 + 11) & 255);
    const gap = concatBytes(png.subarray(0, at), junk, png.subarray(at));
    const pg = parseTolerant(gap)!;
    expect(pg.gaps).toEqual([expect.objectContaining({ offset: at, length: 37 })]);
    expect(pg.chunks.filter((c) => c.type === 'IDAT')).toHaveLength(11);
    const outGap = run(gap);
    expect(summary(outGap).level).toBe('success');
    expect(resultToText(outGap)).toContain('37 unreadable bytes skipped');

    const garbled = png.slice();
    garbled[at + 6] = 0; // IDAT -> ID\0T
    const c = parseTolerant(garbled)!.chunks[5]!;
    expect([c.type, c.status, c.storedType]).toEqual(['IDAT', 'type-fixed', 'ID\0T']);
    expect(summary(run(garbled)).text).toContain('1 chunk type repaired');
  });

  it('lists chunks after IEND, several IENDs, and extracts what follows', () => {
    const extra = concatBytes(tEXt('secret', 'after the end'), pngChunk('IEND', new Uint8Array(0)));
    const png = concatBytes(
      buildShuffled(),
      extra,
      utf8Encode('TRAILING TEXT DATA, NOT A CHUNK\n'),
    );
    const out = run(png, {}, 'tail.png');
    const text = resultToText(out);
    expect(text).toContain('2 chunks after IEND.');
    expect(text).toContain('Several IEND chunks: the first one ends the image.');
    expect(kvOf(out, 'Text chunks')['tEXt «secret»']).toBe('after the end');
    const tail = filesOf(out).find((f) => f.name === 'tail-after-iend.txt')!;
    expect(utf8Decode(tail.data)).toBe('TRAILING TEXT DATA, NOT A CHUNK\n');
    // The rebuilt image stops at its own IEND.
    expect(parsePng(repairedFile(out))!.chunks.filter((x) => x.type === 'IEND')).toHaveLength(1);
  });

  it('a missing signature and a missing IEND', () => {
    const png = buildShuffled();
    const noSig = png.subarray(8, png.length - 12);
    const out = run(noSig);
    expect(summary(out).text).toContain('PNG signature fixed');
    expect(resultToText(out)).toContain('There is no PNG signature: the chunks start at offset 0.');
    expect(resultToText(out)).toContain('No IEND chunk');
    samePixels(imageOf(out).image, ORIGINAL);
  });

  it('shows zTXt and iTXt in full, and reads a hint from a compressed iTXt', () => {
    const long = 'Long note. '.repeat(40) + 'END';
    const ztxt = pngChunk(
      'zTXt',
      concatBytes(
        latin1Encode('Description'),
        new Uint8Array([0, 0]),
        zlibSync(latin1Encode(long)),
      ),
    );
    const itxt = (
      keyword: string,
      compressed: boolean,
      lang: string,
      trans: string,
      body: string,
    ) =>
      pngChunk(
        'iTXt',
        concatBytes(
          latin1Encode(keyword),
          new Uint8Array([0, compressed ? 1 : 0, 0]),
          latin1Encode(lang),
          new Uint8Array([0]),
          utf8Encode(trans),
          new Uint8Array([0]),
          compressed ? zlibSync(utf8Encode(body)) : utf8Encode(body),
        ),
      );
    const png = shuffledWith([
      ztxt,
      itxt('Title', false, 'fr', 'Titre', 'Chirurgien de chunks — été'),
      itxt('Sequence', true, '', '', SHUFFLE_SEQ.join(' ')),
    ]);
    const out = run(png);
    expect(summary(out).text).toContain("(hint 'Sequence', chunk→position)");
    const texts = kvOf(out, 'Text chunks');
    expect(texts['zTXt «Description» — compressed']).toBe(long);
    expect(texts['iTXt «Title» [fr] (Titre)']).toBe('Chirurgien de chunks — été');
    expect(texts['iTXt «Sequence» — compressed, order hint']).toBe(SHUFFLE_SEQ.join(' '));
  });
});

describe('repairs', () => {
  it('recomputes CRCs, or keeps them when asked', () => {
    const broken = sample('png-broken.png');
    const keep = run(broken, { fixCrc: false });
    const kept = parsePng(repairedFile(keep))!;
    // tEXt keeps its wrong CRC; the image still decodes.
    expect(kept.chunks.find((c) => c.type === 'tEXt')!.crcOk).toBe(false);
    expect(summary(keep).text).not.toContain('CRCs recomputed');
    samePixels(imageOf(keep).image, brokenOriginal());
  });

  it('zlib header: zeroed, missing, or with only the FCHECK broken', () => {
    const { ihdr, zlib } = encodeParts(ORIGINAL);
    expect([zlib[0], zlib[1]]).toEqual([0x78, 0x5e]);
    const variants: [Uint8Array, string][] = [
      [concatBytes(new Uint8Array([0, 0x5e]), zlib.subarray(2)), 'zlib header 00 5E → 78 5E'],
      [zlib.subarray(2), 'missing zlib header 78 9C added'],
      [concatBytes(new Uint8Array([0x78, 0x5f]), zlib.subarray(2)), 'zlib header 78 5F → 78 5E'],
    ];
    for (const [stream, expected] of variants) {
      const png = assemble({ ihdr, idats: splitStream(stream, 3, 2) });
      const out = run(png);
      expect(summary(out).text).toContain(expected);
      samePixels(imageOf(out).image, ORIGINAL);
    }
    expect(headerCandidates(0, 0)[0]).toEqual([0x78, 0x9c]);
    expect(headerCandidates(0x78, 0xda)[0]).toEqual([0x78, 0xda]);
    // Without the repair the stream is reported as broken, with where.
    const zeroed = assemble({
      ihdr,
      idats: [concatBytes(new Uint8Array([0, 0]), zlib.subarray(2))],
    });
    const off = run(zeroed, { fixZlib: false });
    expect(summary(off).text).toBe(
      'Not restored: the zlib stream is broken: IDAT #1 comes first but does not start with a zlib header (00 00).',
    );
  });

  it('a wrong Adler-32 is recomputed', () => {
    const { ihdr, zlib } = encodeParts(ORIGINAL);
    const bad = zlib.slice();
    bad[bad.length - 1]! ^= 0xff;
    const out = run(assemble({ ihdr, idats: splitStream(bad, 2, 1) }));
    expect(summary(out).text).toContain('Adler-32 recomputed');
    const fixed = parsePng(repairedFile(out))!;
    const idat = concatBytes(
      ...fixed.chunks
        .filter((c) => c.type === 'IDAT')
        .map((c) => repairedFile(out).subarray(c.dataStart, c.dataStart + c.length)),
    );
    expect(idat).toEqual(zlib);
  });

  it('height from the decompressed size when the IHDR CRC was recomputed too', () => {
    const { ihdr, zlib } = encodeParts(ORIGINAL);
    const low = ihdr.slice();
    new DataView(low.buffer).setUint32(4, 50);
    const out = run(assemble({ ihdr: low, idats: [zlib] }));
    expect(summary(out).text).toContain('height 50 → 120');
    expect(kvOf(out, 'IHDR').Written).toBe(
      '320×120, 8-bit RGB — from the decompressed size: 120 rows of 961 bytes',
    );
    samePixels(imageOf(out).image, ORIGINAL);
  });

  it('a damaged IHDR CRC alone keeps the stored size', () => {
    const png = buildShuffled().slice();
    // The CRC of a 320×77 header: brute force finds that height, the data says 120.
    const ihdr = {
      width: 320,
      height: 77,
      bitDepth: 8,
      colorType: 2,
      compression: 0,
      filter: 0,
      interlace: 0,
    };
    new DataView(png.buffer).setUint32(8 + 8 + 13, ihdrCrc(ihdr));
    const out = run(png);
    expect(tableOf(out, 'IHDR candidates (CRC brute force)').rows[0]).toEqual([
      320,
      77,
      'height',
      'no',
    ]);
    expect(summary(out).text).toBe(
      "Restored: 11 IDAT chunks reordered (hint 'order', chunk→position); 1 CRC recomputed; zlib stream OK; image below.",
    );
    expect(kvOf(out, 'IHDR').Written).toBe('320×120, 8-bit RGB — as stored');
    samePixels(imageOf(out).image, ORIGINAL);
  });

  it('a single IDAT on request, and nothing to do on a clean PNG', () => {
    const one = run(sample('png-shuffled-idat.png'), { singleIdat: true });
    expect(parsePng(repairedFile(one))!.chunks.filter((c) => c.type === 'IDAT')).toHaveLength(1);
    samePixels(imageOf(one).image, ORIGINAL);
    const clean = run(repairedFile(one));
    expect(summary(clean).text).toBe(
      'Nothing to repair: the chunks are consistent and the zlib stream is OK; image below.',
    );
  });

  it('shows the rows that decode when the stream is damaged', () => {
    const pieces = PIECES.map((p) => p.slice());
    const r = prng(1);
    for (let i = 0; i < pieces[6]!.length; i++) pieces[6]![i] = (r() * 256) | 0;
    const out = run(assemble({ ihdr: IHDR, idats: pieces }));
    expect(summary(out).level).toBe('error');
    expect(summary(out).text).toMatch(
      /^Not restored: with the IDAT chunks in file order, row \d+ starts with filter type \d+ \(the data goes wrong in IDAT #7\); there is no hint and no other order works \(\d+ tries\), so a chunk is probably damaged\.$/,
    );
    const partial = imageOf(out);
    expect(partial.label).toMatch(/^Partial rendering: the first \d+ rows that inflated$/);
    // Every row the first six chunks hold is there and right.
    let produced = 0;
    const z = new Unzlib((c) => (produced += c.length));
    for (const p of PIECES.slice(0, 6)) z.push(p, false);
    const sure = Math.floor(produced / 961) - 1;
    const img = partial.image;
    expect(img.height).toBeGreaterThanOrEqual(sure);
    const want = rgbToRgba(ORIGINAL).data.subarray(0, sure * 320 * 4);
    expect(Buffer.from(img.data.subarray(0, sure * 320 * 4)).equals(Buffer.from(want))).toBe(true);
    expect(kvOf(out, 'zlib stream')['Where it breaks']).toBe(
      `byte ${img.height * 961} of the inflated data, while inflating IDAT #7`,
    );
  });
});

describe('stream check', () => {
  it('prefix checks fail fast on a wrong chunk, pass on the right one', () => {
    const layout = layoutOf({
      width: 320,
      height: 120,
      bitDepth: 8,
      colorType: 2,
      compression: 0,
      filter: 0,
      interlace: 0,
    });
    expect(checkStream(PIECES.slice(0, 4), { layout, final: false }).ok).toBe(true);
    expect(checkStream([PIECES[0]!, PIECES[5]!], { layout, final: false }).ok).toBe(false);
    const full = checkStream(PIECES, { layout, final: true });
    expect(full.ok).toBe(true);
    expect(full.produced).toBe(115320);
    expect(full.adlerStored).toBe(full.adlerComputed);
  });
});

describe('input and triage', () => {
  it('declares the same defaults as the core', () => {
    expect(defaultOptions(tool as unknown as AnyTool)).toEqual(DEFAULT_OPTIONS);
  });

  it('refuses what is not a PNG', () => {
    expect(() => run(new Uint8Array(0))).toThrow(ToolError);
    expect(() => run(utf8Encode('GIF89a not a png at all, sorry'))).toThrow(
      /does not look like a PNG/,
    );
  });

  it('suggests itself for damaged or shuffled PNGs only', () => {
    const det = (b: Uint8Array) => tool.detect!({ bytes: b, text: null });
    expect(det(sample('png-shuffled-idat.png'))?.score).toBe(0.9);
    expect(det(sample('png-no-hint.png'))?.score).toBe(0.85);
    expect(det(sample('png-broken.png'))).toEqual({
      score: 0.85,
      reason: 'PNG with a damaged structure (signature, chunk length, type or CRC, or cut off)',
    });
    expect(det(repairedFile(run(sample('png-no-hint.png'))))).toBeNull();
    expect(det(utf8Encode('hello'))).toBeNull();
  });

  it('every chunk CRC of a sample matches crc32 over type and data', () => {
    const png = sample('png-shuffled-idat.png');
    for (const c of parseTolerant(png)!.chunks) {
      expect(c.crcComputed).toBe(crc32(png.subarray(c.offset + 4, c.dataStart + c.length)));
    }
    expect(PNG_SIG).toEqual(png.subarray(0, 8));
  });
});
