/**
 * Regression suite, damaged files: every corruption the verifiers built (signature, zlib
 * header, CRCs, lengths, types, IHDR fields, data after IEND, truncation, unusable inputs),
 * the big and many-chunk cases, the order search limits, and a seeded fuzz. Restorations are
 * checked pixel for pixel against the clean file.
 */
import { zipSync } from 'fflate';
import * as jpegNs from 'jpeg-js';
import { describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { concatBytes, latin1Encode, utf8Decode, utf8Encode } from '../../lib/bytes';
import tool from './png-surgeon';
import { ihdrCrc, parsePng, readIhdr as readIhdrAt } from './_png';
import { DEFAULT_OPTIONS } from './_png-surgeon-core';
import { prng, shuffleByPositions } from './_png-surgeon-fixtures';
import {
  actionsOf,
  chunk,
  cut,
  encode,
  expectPixels,
  expectRestored,
  filesOf,
  IEND,
  ihdrBytes,
  imageOf,
  inverse,
  iTXt,
  kvOf,
  notes,
  type Opts,
  picture,
  png,
  rawStream,
  reorderIds,
  repaired,
  run,
  shuffled,
  SIG,
  summary,
  tableOf,
  tEXt,
  TEXT,
  textBlocks,
  zTXt,
} from './_png-surgeon-kit';

// Every case runs the real tool (and often its order search): room for a busy CI machine.
vi.setConfig({ testTimeout: 30_000 });

type JpegApi = Pick<typeof jpegNs, 'encode'>;
const jpeg: JpegApi =
  typeof jpegNs.encode === 'function'
    ? jpegNs
    : (jpegNs as unknown as { default: JpegApi }).default;

/** Every input built here, for the detect() sweep at the end. */
const INPUTS: Uint8Array[] = [];
const keep = (b: Uint8Array) => (INPUTS.push(b), b);
const runK = (b: Uint8Array, o: Opts = {}, name?: string) => run(keep(b), o, name);

// The control: 40×30 RGB, own chunk writer, fflate zlib, 4 IDAT (784 bytes or so each).
const CTRL = picture(40, 30, [TEXT('FTF 42', 2, 10)], 'rgb8');
const { ihdr: IHDR, zlib: ZLIB } = rawStream(CTRL, 6);
const PIECES = cut(ZLIB, 4);
const CLEAN = png({ ihdr: IHDR, idats: PIECES });
const offsets = (b: Uint8Array) => parsePng(b)!.chunks.map((c) => c.offset);
/** An IHDR payload as fields (for ihdrCrc). */
const readIhdr = (payload: Uint8Array) => readIhdrAt(payload, 0);

describe('control and signature', () => {
  it('a clean 40×30 PNG: 6 chunks, the image, and the very same file back', () => {
    const out = runK(CLEAN);
    expect(summary(out).text).toBe(
      'Nothing to repair: the chunks are consistent and the zlib stream is OK; image below.',
    );
    expect(tableOf(out, 'Chunks')!.rows).toHaveLength(6);
    expectRestored(out, CLEAN);
    expect(Buffer.from(repaired(out)!).equals(Buffer.from(CLEAN))).toBe(true);
  });

  it('signature: last byte wrong, all zeroed, CRLF→LF, missing', () => {
    const variants = [
      concatBytes(SIG.slice(0, 7), new Uint8Array([0]), CLEAN.subarray(8)),
      concatBytes(new Uint8Array(8), CLEAN.subarray(8)),
      concatBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x1a, 0x0a]), CLEAN.subarray(8)),
      CLEAN.subarray(8),
    ];
    for (const v of variants) {
      const out = runK(v);
      expectRestored(out, CLEAN);
      expect(summary(out).text).toContain('PNG signature fixed');
      expect(tableOf(out, 'Chunks')!.rows).toHaveLength(6);
    }
  });
});

describe('zlib stream and CRCs', () => {
  it('zlib header zeroed, swapped, FDICT set, and with the Adler-32 zeroed too', () => {
    const variants: [number, number, boolean, string][] = [
      [0x00, 0x00, false, 'zlib header 00 00 → 78 9C'],
      [0xda, 0x78, false, 'zlib header DA 78 → 78'],
      [0x78, 0xbb, false, 'zlib header 78 BB → 78'],
      [0x00, 0x00, true, 'Adler-32 recomputed'],
    ];
    for (const [a, b, wipeAdler, expected] of variants) {
      const z = ZLIB.slice();
      z[0] = a;
      z[1] = b;
      if (wipeAdler) z.fill(0, z.length - 4);
      const out = runK(png({ ihdr: IHDR, idats: cut(z, 4) }));
      expectRestored(out, CLEAN);
      expect(summary(out).text).toContain(expected);
    }
  });

  it('every CRC wrong: every row flagged, all counted, a valid file back', () => {
    const bad = CLEAN.slice();
    const dv = new DataView(bad.buffer);
    for (const c of parsePng(CLEAN)!.chunks) {
      const at = c.dataStart + c.length;
      dv.setUint32(at, (dv.getUint32(at) ^ 0xdeadbeef) >>> 0);
    }
    const out = runK(bad);
    expect(tableOf(out, 'Chunks')!.highlight).toHaveLength(6);
    expect(summary(out).text).toContain('6 CRCs recomputed');
    expect(parsePng(repaired(out)!)!.chunks.every((c) => c.crcOk)).toBe(true);
    expectRestored(out, CLEAN);
  });

  it('only the IEND CRC wrong, or only one IDAT CRC wrong: reported and counted', () => {
    for (const n of [6, 3]) {
      const bad = CLEAN.slice();
      const c = parsePng(CLEAN)!.chunks[n - 1]!;
      bad[c.dataStart + c.length]! ^= 0xff;
      const out = runK(bad);
      expect(summary(out).text).toBe('Restored: 1 CRC recomputed; zlib stream OK; image below.');
      expectRestored(out, CLEAN);
    }
  });
});

describe('lengths, types, junk and truncation', () => {
  const withText = png({ ihdr: IHDR, before: [tEXt('Comment', 'hello there')], idats: PIECES });
  const at = (b: Uint8Array, n: number) => offsets(b)[n - 1]!;

  it('a tEXt length of 0xFFFFFFFF, or past the end of the file: the rest is still read', () => {
    for (const length of [0xffffffff, 0x00100000]) {
      const bad = withText.slice();
      new DataView(bad.buffer).setUint32(at(withText, 2), length);
      const out = runK(bad);
      const types = tableOf(out, 'Chunks')!.rows.map((r) => r[2]);
      expect(types.filter((t) => t === 'IDAT')).toHaveLength(4);
      expect(types).toContain('IEND');
      expectRestored(out, CLEAN);
    }
  });

  it('IDAT #2 length 50000 (past the end) or 100 (too small): recovered', () => {
    for (const length of [50000, 100]) {
      const bad = CLEAN.slice();
      new DataView(bad.buffer).setUint32(at(CLEAN, 3), length);
      const out = runK(bad);
      expect(summary(out).text).toContain('1 chunk length repaired');
      expectRestored(out, CLEAN);
    }
  });

  it('cut off in the middle of IDAT #3: no crash, partial image, the cut named', () => {
    const third = parsePng(CLEAN)!.chunks[3]!;
    const cutFile = CLEAN.subarray(0, third.dataStart + 300);
    const out = runK(cutFile);
    expect(summary(out).level).toBe('error');
    expect(summary(out).text).toContain('IDAT #3 is cut off by the end of the file');
    expect(imageOf(out)!.label).toMatch(/^Partial rendering/);
    expect(resultToText(out)).toContain('No IEND chunk');
  });

  it('lowercase and garbage chunk types with valid CRCs are listed, not mixed into the image', () => {
    const odd = [
      chunk('idat', new Uint8Array([1, 2, 3])),
      chunk('zzZZ', new Uint8Array([4, 5])),
      chunk(new Uint8Array([0, 1, 0xff, 0x7f]), new Uint8Array([6])),
    ];
    const out = runK(png({ ihdr: IHDR, before: odd, idats: PIECES }));
    const types = tableOf(out, 'Chunks')!.rows.map((r) => r[2]);
    expect(types).toEqual(expect.arrayContaining(['idat', 'zzZZ']));
    expect(types).toHaveLength(9);
    expectPixels(out, CLEAN);
  });

  it('IDAT renamed IDTA, IHDR renamed IHDr, CRC still that of the real type: recognised', () => {
    const idta = concatBytes(
      SIG,
      chunk('IHDR', IHDR),
      ...PIECES.map((d, i) => (i === 1 ? chunk('IDTA', d, { crcType: 'IDAT' }) : chunk('IDAT', d))),
      IEND(),
    );
    const ihdr = concatBytes(
      SIG,
      chunk('IHDr', IHDR, { crcType: 'IHDR' }),
      ...PIECES.map((d) => chunk('IDAT', d)),
      IEND(),
    );
    for (const b of [idta, ihdr]) {
      const out = runK(b);
      expectRestored(out, CLEAN);
      expect(summary(out).text).toContain('1 chunk type repaired');
    }
    // Renamed with a wrong CRC as well: taken for IHDR from its place and size.
    const both = concatBytes(
      SIG,
      chunk('IHDr', IHDR, { crc: 1 }),
      ...PIECES.map((d) => chunk('IDAT', d)),
      IEND(),
    );
    const out = runK(both);
    expectRestored(out, CLEAN);
    expect(resultToText(out)).toContain('IHDR assumed (first chunk, 13 bytes');
  });

  it('37 junk bytes between IDAT #2 and #3: the walk resynchronises', () => {
    const p = at(CLEAN, 4);
    const junk = new Uint8Array(37).map((_, i) => (i * 91 + 7) & 255);
    const out = runK(concatBytes(CLEAN.subarray(0, p), junk, CLEAN.subarray(p)));
    expect(resultToText(out)).toContain('37 unreadable bytes skipped');
    expectRestored(out, CLEAN);
  });

  it('no IHDR at all: the chunks are listed, nothing crashes', () => {
    const out = runK(concatBytes(SIG, ...PIECES.map((d) => chunk('IDAT', d)), IEND()));
    expect(summary(out).text).toMatch(/^Not restored: there is no usable IHDR chunk/);
    expect(tableOf(out, 'Chunks')!.rows).toHaveLength(5);
  });

  it('empty IDATs interleaved, and an IDAT after IEND', () => {
    const empty = new Uint8Array(0);
    const interleaved = png({
      ihdr: IHDR,
      idats: [PIECES[0]!, empty, PIECES[1]!, empty, empty, PIECES[2]!, empty, PIECES[3]!],
    });
    expectRestored(runK(interleaved), CLEAN);
    const late = concatBytes(
      SIG,
      chunk('IHDR', IHDR),
      ...PIECES.slice(0, 3).map((d) => chunk('IDAT', d)),
      IEND(),
      chunk('IDAT', PIECES[3]!),
    );
    const out = runK(late);
    expectRestored(out, CLEAN);
    expect(summary(out).text).toContain('IEND moved after the image data');
  });
});

describe('IHDR fields', () => {
  const sized = (w: number, h: number, depth = 8, colour = 2, stale = false) => {
    const ih = ihdrBytes(w, h, depth, colour);
    return concatBytes(
      SIG,
      chunk('IHDR', ih, stale ? { crc: ihdrCrc(readIhdr(IHDR)) } : {}),
      ...PIECES.map((d) => chunk('IDAT', d)),
      IEND(),
    );
  };

  it('height 30→15, stale or recomputed CRC: 40×30 restored', () => {
    for (const stale of [true, false]) {
      const out = runK(sized(40, 15, 8, 2, stale));
      expectRestored(out, CLEAN);
      expect(summary(out).text).toContain('height 15 → 30');
    }
  });

  it('width 40→20 with a stale CRC: width 40', () => {
    const out = runK(sized(20, 30, 8, 2, true));
    expectRestored(out, CLEAN);
    expect(summary(out).text).toContain('width 20 → 40');
  });

  it('width 40→41 with its CRC recomputed: the data gives width 40 back', () => {
    const out = runK(sized(41, 30));
    expectRestored(out, CLEAN);
    expect(summary(out).text).toContain('width 41 → 40');
    expect(kvOf(out, 'IHDR').Written).toBe(
      '40×30, 8-bit RGB — from the decompressed size: 30 rows of 121 bytes',
    );
  });

  it('absurd fields: no hang or out-of-memory, the mismatch explained, stale CRC recovered', () => {
    const t0 = performance.now();
    const huge = runK(sized(65535, 65535, 16, 6));
    expect(summary(huge).text).toMatch(
      /^Not restored: the zlib stream is right \(it inflates to 3630 bytes and its Adler-32 matches\)/,
    );
    const max = runK(sized(0x7fffffff, 0x7fffffff, 8, 2, true));
    expectRestored(max, CLEAN);
    const exact = runK(sized(0x7fffffff, 0x7fffffff, 8, 2));
    expect(kvOf(exact, 'zlib stream')['Expected from IHDR']).toBe('13835058044544745474 bytes');
    const zero = runK(sized(0, 0));
    expect(summary(zero).text).toMatch(/^Not restored: the IHDR fields are not usable/);
    const odd = runK(sized(40, 30, 3, 7, true));
    expectRestored(odd, CLEAN);
    expect(performance.now() - t0).toBeLessThan(20_000);
  });

  it('Adam7 37×29: shuffled with a hint, height 29→10 with a stale CRC, and with a valid CRC', () => {
    const p = picture(37, 29, [TEXT('A7', 2, 2)], 'rgba8');
    const e = encode(p, { interlace: 'Adam7' });
    const seq = [4, 1, 6, 2, 5, 3];
    const pieces = cut(e.zlib, 6);
    const hinted = png({
      ihdr: e.ihdr,
      before: [tEXt('order', seq.join(' '))],
      idats: shuffleByPositions(pieces, seq),
    });
    expectRestored(runK(hinted), e.png);
    const low = e.ihdr.slice();
    new DataView(low.buffer).setUint32(4, 10);
    const stale = concatBytes(
      SIG,
      chunk('IHDR', low, { crc: ihdrCrc(readIhdr(e.ihdr)) }),
      ...pieces.map((d) => chunk('IDAT', d)),
      IEND(),
    );
    expectRestored(runK(stale), e.png);
    const valid = png({ ihdr: low, idats: pieces });
    const out = runK(valid);
    expectRestored(out, e.png);
    expect(summary(out).text).toContain('height 10 → 29');
  });

  it('16-bit grey without a hint, 4-bit palette with a bad PLTE CRC and a hint, palette height 20→7', () => {
    const g = encode(picture(30, 20, [TEXT('G', 2, 2)], 'gray16'));
    const gs = shuffled(5, 3);
    expectRestored(
      runK(png({ ihdr: g.ihdr, idats: shuffleByPositions(cut(g.zlib, 5), gs) })),
      g.png,
    );

    const pal = encode(picture(30, 20, [TEXT('P4', 2, 2)], 'palette4'));
    const plteBad = pal.before.map((c) => {
      const x = c.slice();
      x[x.length - 1]! ^= 0x55;
      return x;
    });
    const ps = [3, 1, 4, 2];
    const out = runK(
      png({
        ihdr: pal.ihdr,
        before: [...plteBad, tEXt('order', ps.join(' '))],
        idats: shuffleByPositions(cut(pal.zlib, 4), ps),
      }),
    );
    expectRestored(out, pal.png);
    expect(parsePng(repaired(out)!)!.chunks.map((c) => c.type)).toContain('PLTE');

    const low = pal.ihdr.slice();
    new DataView(low.buffer).setUint32(4, 7);
    const cropped = runK(png({ ihdr: low, before: pal.before, idats: cut(pal.zlib, 3) }));
    expectRestored(cropped, pal.png);
  });
});

describe('data after IEND', () => {
  it('a tEXt chunk after IEND is listed and shown', () => {
    const out = runK(concatBytes(CLEAN, tEXt('Comment', 'FTF{after_iend_txt}')));
    expect(kvOf(out, 'Text chunks')['tEXt «Comment»']).toBe('FTF{after_iend_txt}');
    expect(resultToText(out)).toContain('1 chunk after IEND.');
  });

  it('two IENDs with raw text between: extracted, readable, the second IEND noticed', () => {
    const out = runK(concatBytes(CLEAN, utf8Encode('secret: FTF{between_iends}'), IEND()));
    expect(textBlocks(out)).toContain('secret: FTF{between_iends}');
    expect(notes(out)).toContain('Another IEND chunk at');
    const f = filesOf(out).find((x) => x.name.endsWith('-after-iend.txt'))!;
    expect(utf8Decode(f.data)).toBe('secret: FTF{between_iends}');
    // IEND, tEXt, IEND: the chunk is listed and its text shown.
    const out2 = runK(concatBytes(CLEAN, tEXt('Comment', 'between'), IEND()));
    expect(kvOf(out2, 'Text chunks')['tEXt «Comment»']).toBe('between');
  });

  it('plain text appended: extracted and shown (so flag highlighting sees it)', () => {
    const out = runK(concatBytes(CLEAN, utf8Encode('FTF{plain_tail_text}\n')));
    expect(textBlocks(out)).toBe('FTF{plain_tail_text}');
    expect(summary(out).text).toContain('After IEND: plain text (see Files).');
  });

  const zip = zipSync(
    { 'note.txt': utf8Encode('appended note') },
    { mtime: new Date(2024, 0, 1, 12) },
  );
  const jpg = new Uint8Array(
    jpeg.encode({ width: 8, height: 8, data: new Uint8Array(256).fill(128) }, 80).data,
  );
  const extra = encode(picture(9, 7, [], 'rgb8'), { interlace: 'Adam7' }).png;

  it('ZIP, JPEG or PNG appended: identified and extracted byte for byte', () => {
    for (const [payload, ext] of [
      [zip, 'zip'],
      [jpg, 'jpg'],
      [extra, 'png'],
    ] as const) {
      const out = runK(concatBytes(CLEAN, payload));
      const f = filesOf(out).find((x) => x.name === `test-after-iend.${ext}`);
      expect(f, resultToText(out)).toBeDefined();
      expect(Buffer.from(f!.data).equals(Buffer.from(payload))).toBe(true);
    }
  });

  it('ZIP then JPEG appended: both named and carved', () => {
    const out = runK(concatBytes(CLEAN, zip, jpg));
    const names = filesOf(out).map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(['test-after-iend-1.zip', 'test-after-iend-2.jpg']),
    );
    expect(
      Buffer.from(filesOf(out).find((f) => f.name.endsWith('.jpg'))!.data).equals(Buffer.from(jpg)),
    ).toBe(true);
    expect(summary(out).text).toMatch(/After IEND: ZIP archive, JPEG image \(see Files\)\.$/);
  });

  it('padding after IEND: zeros, or line breaks only, named as such', () => {
    expect(notes(runK(concatBytes(CLEAN, new Uint8Array(16))))).toContain('zero padding');
    expect(notes(runK(concatBytes(CLEAN, utf8Encode('\r\n\r\n'))))).toContain('line breaks only');
  });
});

describe('unusable input and options', () => {
  it('0 bytes, a lone signature, a JPEG, ASCII text: a ToolError, never a crash', () => {
    const jpg = new Uint8Array(
      jpeg.encode({ width: 8, height: 8, data: new Uint8Array(256).fill(9) }, 80).data,
    );
    for (const b of [new Uint8Array(0), SIG, jpg, utf8Encode('just some text, not a picture')]) {
      expect(() => run(keep(b))).toThrow(ToolError);
    }
  });

  it('bad typed orders and odd options: a clear message, no crash', () => {
    const b = png({ ihdr: IHDR, idats: shuffleByPositions(PIECES, [2, 4, 1, 3]) });
    expect(summary(run(b, { order: '9 9 x -1 0 100' })).text).toMatch(/^Not restored: Order: /);
    expect(summary(run(b, { order: '1 1 2 3' })).text).toBe(
      'Not restored: Order: 1 appears twice.',
    );
    const many = Array.from({ length: 20000 }, (_, i) => i + 1).join(' ');
    expect(summary(run(b, { order: many })).text).toBe(
      'Not restored: Order: it has 20000 numbers for 4 IDAT chunks.',
    );
    expect(summary(run(CLEAN, { order: '1 2' })).text).toBe(
      'Not restored: Order: it has 2 numbers for 4 IDAT chunks.',
    );
    const one = png({ ihdr: IHDR, idats: [ZLIB] });
    expect(summary(run(one, { order: '1 2' })).text).toBe(
      'Not restored: Order: it has 2 numbers for 1 IDAT chunk.',
    );
    const big = run(CLEAN, { width: 65535, height: 65535 });
    expect(summary(big).text).toMatch(/^Not restored: the zlib stream is right/);
    expect(kvOf(big, 'zlib stream')['Expected with 65535×65535']).toBeDefined();
    const single = run(b, { singleIdat: true });
    expectRestored(single, CLEAN);
    const off = run(b, {
      fixCrc: false,
      fixSignature: false,
      fixZlib: false,
      fixIhdr: false,
      search: false,
    });
    expect(summary(off).level).toBe('error');
  });
});

describe('shuffles at scale', () => {
  it('shuffled 7 IDAT with the hint in tEXt, zTXt or compressed iTXt', () => {
    const e = encode(picture(48, 40, [TEXT('HINT', 2, 2)], 'rgb8'));
    const seq = [5, 2, 7, 1, 4, 6, 3];
    const pieces = cut(e.zlib, 7);
    for (const hint of [
      tEXt('order', inverse(seq).join(' ')),
      zTXt('order', inverse(seq).join(' ')),
      iTXt('order', inverse(seq).join(' '), true),
    ]) {
      expectRestored(
        runK(png({ ihdr: e.ihdr, before: [hint], idats: shuffleByPositions(pieces, seq) })),
        e.png,
      );
    }
  });

  it('combo: bad signature, 6 shuffled IDAT, a hint, a zeroed zlib header, every CRC wrong', () => {
    const z = ZLIB.slice();
    z[0] = 0;
    z[1] = 0;
    const seq = [3, 6, 1, 5, 2, 4];
    const files = shuffleByPositions(cut(z, 6), seq);
    const b = concatBytes(
      new Uint8Array(8),
      chunk('IHDR', IHDR, { crc: 1 }),
      chunk('tEXt', latin1Encode(`order\0${seq.join(' ')}`), { crc: 2 }),
      ...files.map((d) => chunk('IDAT', d, { crc: 3 })),
      chunk('IEND', new Uint8Array(0), { crc: 4 }),
    );
    const out = runK(b);
    expectRestored(out, CLEAN);
    expect(summary(out).text).toContain('6 IDAT chunks reordered');
  });

  it('a 0-based hint with brackets, and a wrong identity decoy beaten by the search', () => {
    const seq = [2, 4, 1, 3];
    const b = png({
      ihdr: IHDR,
      before: [tEXt('order', `[${seq.map((v) => v - 1).join(', ')}]`)],
      idats: shuffleByPositions(PIECES, seq),
    });
    expectRestored(runK(b), CLEAN);
    const decoy = png({
      ihdr: IHDR,
      before: [tEXt('order', '1 2 3 4')],
      idats: shuffleByPositions(PIECES, seq),
    });
    expectRestored(runK(decoy), CLEAN);
  });

  it('no hint: 10 IDAT (40×30), 12 IDAT (800×600 RGBA), 12 IDAT (1920×1080 RGB) in bounded time', () => {
    const t0 = performance.now();
    const b10 = png({ ihdr: IHDR, idats: shuffleByPositions(cut(ZLIB, 10), shuffled(10, 10)) });
    expectRestored(runK(b10), CLEAN);
    for (const [w, h, fmt] of [
      [800, 600, 'rgba8'],
      [1920, 1080, 'rgb8'],
    ] as const) {
      const e = encode(picture(w, h, [TEXT('FTF BIG', 40, 40, 8)], fmt));
      const out = runK(
        png({ ihdr: e.ihdr, idats: shuffleByPositions(cut(e.zlib, 12), shuffled(12, w)) }),
      );
      expectRestored(out, e.png);
    }
    expect(performance.now() - t0).toBeLessThan(60_000);
  }, 90_000);

  it('HD 1920×1080: 11 shuffled IDAT with a hint, and the heavy combo', () => {
    const e = encode(picture(1920, 1080, [TEXT('HD 1080', 100, 100, 10)], 'rgb8'));
    const seq = shuffled(11, 1080);
    const hinted = png({
      ihdr: e.ihdr,
      before: [tEXt('order', seq.join(' '))],
      idats: shuffleByPositions(cut(e.zlib, 11), seq),
    });
    expectRestored(runK(hinted), e.png);
    // Stale-CRC height 300, 12 shuffled IDAT without a hint, zlib header zeroed.
    const z = e.zlib.slice();
    z[0] = 0;
    z[1] = 0;
    const low = e.ihdr.slice();
    new DataView(low.buffer).setUint32(4, 300);
    const heavy = concatBytes(
      SIG,
      chunk('IHDR', low, { crc: ihdrCrc(readIhdr(e.ihdr)) }),
      ...shuffleByPositions(cut(z, 12), shuffled(12, 300)).map((d) => chunk('IDAT', d)),
      IEND(),
    );
    const out = runK(heavy);
    expectRestored(out, e.png);
    expect(summary(out).text).toContain('height 300 → 1080');
  }, 90_000);

  it('300 tiny IDAT shuffled without a hint: no hang, every chunk listed, the cap explained', () => {
    const b = png({ ihdr: IHDR, idats: shuffleByPositions(cut(ZLIB, 300), shuffled(300, 300)) });
    const out = runK(b);
    expect(tableOf(out, 'Chunks')!.rows).toHaveLength(302);
    expect(summary(out).text).toContain('the automatic search stops at 12 chunks (there are 300)');
    expect(notes(out)).toContain('300 IDAT chunks: too many to reorder by hand here');
    expect(reorderIds(out)).toBeNull();
  });

  it('12 shuffled IDAT (800×600) and one flipped byte in IDAT #6: no hang, the damage named', () => {
    const e = encode(picture(800, 600, [TEXT('FLIP', 40, 40, 8)], 'rgba8'));
    const files = shuffleByPositions(cut(e.zlib, 12), shuffled(12, 6)).map((d) => d.slice());
    files[5]![Math.floor(files[5]!.length / 2)]! ^= 0x10;
    const parts = files.map((d) => chunk('IDAT', d));
    // The flipped byte breaks the stored CRC, as it would on disk.
    const fixedCrc = files.map((d, i) =>
      i === 5 ? chunk('IDAT', d, { crc: 0x12345678 }) : parts[i]!,
    );
    const out = runK(concatBytes(SIG, chunk('IHDR', e.ihdr), ...fixedCrc, IEND()));
    expect(summary(out).level).not.toBe('success');
    expect(summary(out).text).toContain('IDAT #6 has a wrong CRC: its data is probably damaged');
  }, 60_000);
});

describe('round trips, fuzz, triage', () => {
  it('the reorder ids, a swap of two of them and every action never crash and keep restoring', () => {
    const cases = [
      png({
        ihdr: IHDR,
        before: [tEXt('order', '3 1 4 2')],
        idats: shuffleByPositions(PIECES, [3, 1, 4, 2]),
      }),
      png({ ihdr: IHDR, idats: shuffleByPositions(PIECES, [2, 4, 1, 3]) }),
      concatBytes(SIG.slice(0, 4), CLEAN.subarray(4)),
    ];
    for (const b of cases) {
      const out = run(b);
      const ids = reorderIds(out);
      if (ids) {
        expectRestored(run(b, { order: ids.join(' ') }), CLEAN);
        const swapped = [ids[1]!, ids[0]!, ...ids.slice(2)];
        const bad = run(b, { order: swapped.join(' ') });
        expect(reorderIds(bad)).toEqual(swapped);
      }
      for (const a of actionsOf(out)) expect(() => run(b, a.options as Opts)).not.toThrow();
    }
  });

  it('fuzz: 300 seeded mutations and every 7th truncation give outputs or a ToolError only', () => {
    const combo = png({
      ihdr: IHDR,
      before: [tEXt('order', '3 1 4 2')],
      idats: shuffleByPositions(PIECES, [3, 1, 4, 2]),
    });
    const r = prng(300);
    const t0 = performance.now();
    for (const base of [CLEAN, combo]) {
      for (let i = 0; i < 300; i++) {
        const m = base.slice();
        const k = 1 + Math.floor(r() * 8);
        for (let j = 0; j < k; j++) m[Math.floor(r() * m.length)] = Math.floor(r() * 256);
        expectToolOutput(m);
      }
      for (let len = 0; len < base.length; len += 7) expectToolOutput(base.subarray(0, len));
    }
    expect(performance.now() - t0).toBeLessThan(120_000);
  }, 180_000);

  it('detect() never throws and stays cheap on every input of this suite', () => {
    expect(INPUTS.length).toBeGreaterThan(40);
    for (const b of INPUTS) {
      const t0 = performance.now();
      expect(() => tool.detect!({ bytes: b, text: null })).not.toThrow();
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });

  it('detect(): broken lengths and cuts are damage; an empty first IDAT and "Border" are not', () => {
    const det = (b: Uint8Array) => tool.detect!({ bytes: b, text: null });
    const withText = png({ ihdr: IHDR, before: [tEXt('Comment', 'x')], idats: PIECES });
    const long = withText.slice();
    new DataView(long.buffer).setUint32(33, 0xffffffff);
    expect(det(long)?.score).toBe(0.85);
    expect(det(CLEAN.subarray(0, CLEAN.length - 300))?.score).toBe(0.85);
    expect(det(png({ ihdr: IHDR, idats: [new Uint8Array(0), ...PIECES] }))).toBeNull();
    expect(det(png({ ihdr: IHDR, before: [tEXt('Border', '5')], idats: PIECES }))).toBeNull();
    expect(det(png({ ihdr: IHDR, before: [tEXt('order', '1 2 3 4')], idats: PIECES }))).toBeNull();
    expect(det(png({ ihdr: IHDR, before: [tEXt('order', '2 1 3 4')], idats: PIECES }))?.score).toBe(
      0.9,
    );
  });
});

function expectToolOutput(b: Uint8Array) {
  try {
    const out = tool.run({ bytes: b, name: 'f.png' }, { ...DEFAULT_OPTIONS }) as Output[];
    expect(Array.isArray(out)).toBe(true);
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
  }
}
