/**
 * Regression suite, IDAT order: every reading, hint format and search case the verifiers
 * built, plus the manual reorder round trips. Each restoration is checked pixel for pixel
 * against the clean encoding (and sample for sample in the downloaded file).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Output } from '../../core/types';
import { resultToText } from '../../core/result-text';
import { shuffleByPositions } from './_png-surgeon-fixtures';
import { concatBytes, latin1Encode } from '../../lib/bytes';
import {
  actionsOf,
  chunk,
  cut,
  encode,
  type Encoded,
  expectHonest,
  expectPixels,
  expectRestored,
  fileOrder,
  IEND,
  inverse,
  iTXt,
  noise,
  type Opts,
  picture,
  type Picture,
  png,
  rawStream,
  reorderIds,
  run,
  shuffled,
  SIG,
  summary,
  tableOf,
  tEXt,
  TEXT,
  zTXt,
} from './_png-surgeon-kit';
import type { Reading } from './_png-surgeon-order';

// Every case runs the real tool (and often its order search): room for a busy CI machine.
vi.setConfig({ testTimeout: 30_000 });

const LINES = [TEXT('FTF OK 42', 2, 16)];
const pic = (fmt: Parameters<typeof picture>[3], w = 48, h = 40) => picture(w, h, LINES, fmt);
const otherName = (r: Reading) => (r === 'position' ? 'chunk→position' : 'position→chunk');
const readingName = (r: Reading) => (r === 'position' ? 'position→chunk' : 'chunk→position');

interface Built {
  bytes: Uint8Array;
  clean: Uint8Array;
  enc: Encoded;
}

/** A clean encoding cut into pieces, stored in the file order `seq` (read with `reading`) gives. */
function build(
  p: Picture,
  pieces: number | ((zlib: Uint8Array) => Uint8Array[]),
  seq: number[],
  reading: Reading,
  text: Uint8Array[] = [],
  opts: { interlace?: 'Adam7'; level?: 0; after?: Uint8Array[] } = {},
): Built {
  const enc = encode(p, opts);
  const parts = typeof pieces === 'number' ? cut(enc.zlib, pieces) : pieces(enc.zlib);
  const bytes = png({
    ihdr: enc.ihdr,
    before: [...enc.before, ...text],
    idats: fileOrder(parts, seq, reading),
    after: opts.after,
  });
  return { bytes, clean: enc.png, enc };
}

/** Restored with exactly this reading, and the other reading listed as failing. */
function expectReading(out: Output[], clean: Uint8Array, reading: Reading) {
  expectRestored(out, clean);
  expect(summary(out).text).toContain(readingName(reading));
  const rows = tableOf(out, 'Orders tried')?.rows ?? [];
  const other = rows.find((r) => r[1] === otherName(reading));
  if (other) expect(other[3]).not.toBe('OK');
}

describe('readings and hint formats (C01–C12, C20, C21, C25)', () => {
  const cases: {
    name: string;
    pic: () => Picture;
    pieces: number | ((z: Uint8Array) => Uint8Array[]);
    seq: number[];
    reading: Reading;
    hint: (seq: number[]) => Uint8Array;
    opts?: { interlace?: 'Adam7'; level?: 0 };
    after?: boolean;
    run?: Opts;
  }[] = [
    {
      name: "C01 RGB8, 3 IDAT, tEXt 'order' '2 3 1', position only",
      pic: () => pic('rgb8'),
      pieces: 3,
      seq: [2, 3, 1],
      reading: 'position',
      hint: (s) => tEXt('order', s.join(' ')),
    },
    {
      name: "C02 RGBA8, 3 IDAT, tEXt 'Order' with commas, chunk only",
      pic: () => pic('rgba8'),
      pieces: 3,
      seq: [2, 3, 1],
      reading: 'chunk',
      hint: (s) => tEXt('Order', s.join(',')),
    },
    {
      name: "C03 RGB8, 7 IDAT, tEXt 'sequence' with dashes, position only",
      pic: () => pic('rgb8'),
      pieces: 7,
      seq: [3, 5, 1, 7, 2, 4, 6],
      reading: 'position',
      hint: (s) => tEXt('sequence', s.join('-')),
    },
    {
      name: "C04 palette 8-bit, 7 IDAT, zTXt 'idat_order', 0-based, chunk only",
      pic: () => pic('palette8'),
      pieces: 7,
      seq: [4, 0, 6, 2, 5, 1, 3],
      reading: 'chunk',
      hint: (s) => zTXt('idat_order', s.join(' ')),
    },
    {
      name: "C05 RGBA8, 11 IDAT, uncompressed iTXt 'order', ', ' separators, position only",
      pic: () => pic('rgba8', 64, 48),
      pieces: 11,
      seq: shuffled(11, 5),
      reading: 'position',
      hint: (s) => iTXt('order', s.join(', '), false),
    },
    {
      name: "C06 gray 16-bit, 11 IDAT, compressed iTXt 'sequence', dashes, chunk only",
      pic: () => pic('gray16', 64, 48),
      pieces: 11,
      seq: shuffled(11, 6),
      reading: 'chunk',
      hint: (s) => iTXt('sequence', s.join('-'), true),
    },
    {
      name: "C07 RGB8 96×72, 20 IDAT, tEXt 'order', 0-based with commas, position only",
      pic: () => pic('rgb8', 96, 72),
      pieces: 20,
      seq: shuffled(20, 7).map((v) => v - 1),
      reading: 'position',
      hint: (s) => tEXt('order', s.join(',')),
    },
    {
      name: "C08 RGBA 16-bit, 20 IDAT, zTXt 'Order' after the IDATs, chunk only",
      pic: () => pic('rgba16', 64, 48),
      pieces: 20,
      seq: shuffled(20, 8),
      reading: 'chunk',
      hint: (s) => zTXt('Order', s.join(' ')),
      after: true,
    },
    {
      name: "C09 Adam7 RGBA8 37×29, 7 IDAT, tEXt 'order', position only",
      pic: () => pic('rgba8', 37, 29),
      pieces: 7,
      seq: [6, 3, 7, 1, 5, 2, 4],
      reading: 'position',
      hint: (s) => tEXt('order', s.join(' ')),
      opts: { interlace: 'Adam7' },
    },
    {
      name: "C10 Adam7 gray+alpha 16-bit 33×27, 11 IDAT, iTXt 'idat_order', 0-based dashes, chunk only",
      pic: () => pic('graya16', 33, 27),
      pieces: 11,
      seq: shuffled(11, 10).map((v) => v - 1),
      reading: 'chunk',
      hint: (s) => iTXt('idat_order', s.join('-'), false),
      opts: { interlace: 'Adam7' },
    },
    {
      name: 'C11 palette + tRNS, 11 IDAT of very uneven sizes, position only',
      pic: () => pic('palette8', 96, 72),
      pieces: (z) => {
        const big = Math.floor(z.length * 0.4);
        const mid = Math.floor(z.length * 0.15);
        return cut(z, [big, 1, 3, 2, 1, mid, 5, 1, 7, 2]);
      },
      seq: shuffled(11, 11),
      reading: 'position',
      hint: (s) => tEXt('order', s.join(' ')),
    },
    {
      name: "C12 RGB8, 7 IDAT, the zlib header split over two 1-byte IDATs, 'sequence', chunk only",
      pic: () => pic('rgb8', 64, 48),
      pieces: (z) => cut(z, [1, 1, 300, 2, 1, 150]),
      seq: [4, 6, 2, 7, 1, 3, 5],
      reading: 'chunk',
      hint: (s) => tEXt('sequence', s.join(' ')),
    },
    {
      name: 'C20 an involution (both readings are the same order), 4 IDAT',
      pic: () => pic('rgb8'),
      pieces: 4,
      seq: [2, 1, 3, 4],
      reading: 'position',
      hint: (s) => tEXt('order', s.join(' ')),
    },
    {
      name: 'C21 stored deflate blocks (level 0) of a noisy picture, 7 IDAT, chunk only',
      pic: () => noise(40, 30, 21),
      pieces: 7,
      seq: [3, 7, 5, 1, 2, 6, 4],
      reading: 'chunk',
      hint: (s) => tEXt('order', s.join(' ')),
      opts: { level: 0 },
    },
    {
      name: "C25 hint '[a, b, c]\\n' with brackets and a newline, search off, position",
      pic: () => pic('rgb8'),
      pieces: 5,
      seq: [2, 5, 1, 4, 3],
      reading: 'position',
      hint: (s) => tEXt('order', `[${s.join(', ')}]\n`),
      run: { search: false },
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const hint = c.hint(c.seq);
      const b = build(c.pic(), c.pieces, c.seq, c.reading, c.after ? [] : [hint], {
        ...c.opts,
        after: c.after ? [hint] : undefined,
      });
      const out = run(b.bytes, c.run);
      if (c.name.startsWith('C20')) {
        expectRestored(out, b.clean);
        expect(tableOf(out, 'Orders tried')!.rows[0]![1]).toContain('same order as the other');
      } else expectReading(out, b.clean, c.reading);
    });
  }
});

describe('hint keywords and separators (D04)', () => {
  const seq = [4, 7, 2, 6, 1, 3, 5];
  const variants: [string, (s: number[]) => Uint8Array][] = [
    ['ORDER', (s) => tEXt('ORDER', s.join(' '))],
    ['Sequence', (s) => tEXt('Sequence', s.join(' '))],
    ['idat-order', (s) => tEXt('idat-order', s.join(' '))],
    ['IDAT order', (s) => tEXt('IDAT order', s.join(' '))],
    ['chunk_order', (s) => tEXt('chunk_order', s.join(' '))],
    ["Comment 'order: …'", (s) => tEXt('Comment', `order: ${s.join(' ')}`)],
    ["';' separators", (s) => tEXt('order', s.join(';'))],
    ['newlines', (s) => tEXt('order', s.join('\n'))],
    ["Comment 'idat: …'", (s) => tEXt('Comment', `idat: ${s.join(',')}`)],
    ['zTXt 0-based', (s) => zTXt('order', s.map((v) => v - 1).join(' '))],
    ['compressed iTXt, commas', (s) => iTXt('order', s.join(','), true)],
  ];
  for (const [name, hint] of variants) {
    it(`${name}: found and applied with the search off`, () => {
      const b = build(pic('rgb8'), 7, seq, 'position', [hint(seq)]);
      expectReading(run(b.bytes, { search: false }), b.clean, 'position');
    });
  }
});

describe('search, wrong and malformed hints (C13–C19, C24, D05)', () => {
  it('C13 no hint, 5 IDAT: found by search', () => {
    const b = build(pic('rgb8'), 5, [3, 1, 5, 2, 4], 'chunk');
    const out = run(b.bytes);
    expectRestored(out, b.clean);
    expect(summary(out).text).toContain('order found without a hint');
  });

  it('C14 / C14b no hint, 9 IDAT RGBA 56×48: found, and an honest failure with the search off', () => {
    const b = build(pic('rgba8', 56, 48), 9, shuffled(9, 14), 'chunk');
    expectRestored(run(b.bytes), b.clean);
    const off = run(b.bytes, { search: false });
    expect(summary(off).level).toBe('error');
    expect(summary(off).text).toMatch(/^Not restored: .*turn the search on/);
  });

  it('C15 / C15b a wrong involution hint: honest with the search off, beaten by the search', () => {
    const b = build(pic('rgb8'), 7, [3, 6, 1, 7, 2, 5, 4], 'chunk', [
      tEXt('order', '2 1 3 4 5 7 6'),
    ]);
    const off = run(b.bytes, { search: false });
    expect(summary(off).text).toMatch(/^Not restored: the hint 'order' gives no valid zlib stream/);
    const on = run(b.bytes);
    expectRestored(on, b.clean);
    expect(summary(on).text).toContain(
      "order found without a hint, the hint 'order' does not work",
    );
  });

  it('C16 a wrong hint (two numbers swapped) on 20 IDAT: an honest failure', () => {
    const seq = shuffled(20, 16);
    const wrong = inverse(seq);
    [wrong[3], wrong[9]] = [wrong[9]!, wrong[3]!];
    const b = build(pic('rgb8', 96, 72), 20, seq, 'chunk', [tEXt('order', wrong.join(' '))]);
    const out = run(b.bytes);
    expect(summary(out).level).toBe('error');
    expect(summary(out).text).toMatch(/^Not restored: the hint 'order' gives no valid zlib stream/);
  });

  it('C17 / D05 a malformed hint (duplicate, too few numbers) is flagged, then searched', () => {
    for (const text of ['1 2 2 4 5', '3 1 2']) {
      const b = build(pic('rgb8'), 5, [4, 1, 5, 3, 2], 'chunk', [tEXt('order', text)]);
      const out = run(b.bytes);
      expectRestored(out, b.clean);
      expect(resultToText(out)).toContain('The text chunk «order» looks like an order hint, but');
    }
  });

  it('C18 / C18b an order typed in Order, read both ways in auto, reports the reading', () => {
    const seq = shuffled(11, 18);
    const b = build(pic('rgb8', 64, 48), 11, seq, 'chunk');
    const asChunk = run(b.bytes, { order: seq.join(' ') });
    expectRestored(asChunk, b.clean);
    expect(summary(asChunk).text).toContain('typed order, chunk→position');
    const asPosition = run(b.bytes, { order: inverse(seq).join(' ') });
    expectRestored(asPosition, b.clean);
    expect(summary(asPosition).text).toContain('typed order, position→chunk');
  });

  it('C19 / C19b / C19c a forced reading is honoured: wrong fails honestly, right restores', () => {
    const seq = [5, 3, 7, 1, 6, 2, 4];
    const b = build(pic('rgb8'), 7, seq, 'position', [tEXt('order', seq.join(' '))]);
    const typed = run(b.bytes, { order: seq.join(' '), reading: 'chunk' });
    expect(summary(typed).level).toBe('error');
    const hintWrong = run(b.bytes, { reading: 'chunk', search: false });
    expect(summary(hintWrong).text).toMatch(/^Not restored: the hint 'order'/);
    expect(actionsOf(hintWrong).map((a) => a.label)).toContain('Try both readings');
    expectReading(run(b.bytes, { reading: 'position' }), b.clean, 'position');
  });

  it('C24 already in order with an identity hint: nothing to repair', () => {
    const e = encode(pic('rgb8'));
    const bytes = png({
      ihdr: e.ihdr,
      before: [tEXt('order', '1 2 3 4 5')],
      idats: cut(e.zlib, 5),
    });
    const out = run(bytes);
    expect(summary(out).text).toBe(
      'Nothing to repair: the chunks are consistent and the zlib stream is OK; image below.',
    );
    expectPixels(out, e.png);
    // Nothing to reorder: no list is offered for chunks already in order.
    expect(reorderIds(out)).toBeNull();
  });

  it('D05 another chunk between the IDATs, and every IDAT and tEXt CRC wrong', () => {
    const seq = [6, 2, 7, 4, 1, 5, 3];
    const e = encode(pic('rgb8'));
    const files = fileOrder(cut(e.zlib, 7), seq, 'position');
    const mk = (bad: boolean) => {
      const crc = bad ? { crc: 0xdeadbeef } : {};
      return concatBytes(
        SIG,
        chunk('IHDR', e.ihdr),
        tEXt('order', seq.join(' ')),
        ...files.slice(0, 3).map((d) => chunk('IDAT', d, crc)),
        chunk('tEXt', latin1Encode('Comment\0between the IDATs'), crc),
        ...files.slice(3).map((d) => chunk('IDAT', d, crc)),
        IEND(),
      );
    };
    for (const bad of [false, true]) {
      const out = run(mk(bad));
      expectRestored(out, e.png);
      if (bad) expect(summary(out).text).toContain('8 CRCs recomputed');
    }
  });

  it('D05 more IDAT chunks than the search handles (13, 20), no hint: an honest failure', () => {
    for (const n of [13, 20]) {
      const b = build(pic('rgb8', 96, 72), n, shuffled(n, n), 'chunk');
      const out = run(b.bytes);
      expect(summary(out).text).toMatch(
        new RegExp(`the automatic search stops at 12 chunks \\(there are ${n}\\)`),
      );
      expect(reorderIds(out)).toHaveLength(n);
    }
  });

  it('D05 12 IDAT, and 7 very uneven IDAT (1, 2, 1, 600, 1, 3 bytes…), no hint: found', () => {
    const b = build(pic('rgb8', 96, 72), 12, shuffled(12, 12), 'chunk');
    expectRestored(run(b.bytes), b.clean);
    const u = build(
      pic('rgb8', 96, 72),
      (z) => cut(z, [1, 2, 1, 600, 1, 3]),
      [5, 1, 7, 3, 6, 2, 4],
      'chunk',
    );
    expectRestored(run(u.bytes), u.clean);
  });
});

describe('manual reorder and actions (C23, D02, E02)', () => {
  const seq = shuffled(7, 23);
  const hinted = build(pic('rgb8'), 7, seq, 'chunk', [tEXt('order', seq.join(' '))]);

  it('C23 the reorder ids of a success work again whatever reading the UI holds', () => {
    const ok = run(hinted.bytes);
    expectRestored(ok, hinted.clean);
    const ids = reorderIds(ok)!;
    expect(ids.every((id) => /^#\d+$/.test(id))).toBe(true);
    for (const reading of ['auto', 'position', 'chunk'] as const) {
      const again = run(hinted.bytes, { order: ids.join(' '), reading });
      expectRestored(again, hinted.clean);
      expect(summary(again).text).toContain('(order set in the list)');
      expect(reorderIds(again)).toEqual(ids);
    }
  });

  it('D02 "Apply the order found" after a search works with any reading', () => {
    const b = build(pic('rgb8'), 7, shuffled(7, 2), 'chunk');
    const found = run(b.bytes);
    const apply = actionsOf(found).find((a) => a.label === 'Apply the order found')!;
    for (const reading of ['auto', 'position', 'chunk'] as const) {
      expectRestored(run(b.bytes, { ...(apply.options as Opts), reading }), b.clean);
    }
  });

  for (const reading of ['auto', 'position', 'chunk'] as const) {
    it(`E02 dragging one item at a time (reading ${reading}): the list stays as dragged and ends restored`, () => {
      const s = shuffled(7, 31);
      const b = build(pic('rgb8'), 7, s, 'chunk');
      // The arrangement that restores, as the list names it: IDAT numbers in position order.
      const target = inverse(s).map((v) => `#${v}`);
      let out = run(b.bytes, { search: false, reading });
      for (let i = 0; i < target.length; i++) {
        const ids = reorderIds(out)!;
        const next = ids.slice();
        const [moved] = next.splice(ids.indexOf(target[i]!), 1);
        next.splice(i, 0, moved!);
        out = run(b.bytes, { search: false, reading, order: next.join(' ') });
        expect(reorderIds(out)).toEqual(next);
      }
      expectRestored(out, b.clean);
    });
  }

  it('↓ on the first item breaks the order; "Use the hint" brings it back', () => {
    const ids = reorderIds(run(hinted.bytes))!;
    const swapped = [ids[1]!, ids[0]!, ...ids.slice(2)];
    const bad = run(hinted.bytes, { order: swapped.join(' ') });
    expect(summary(bad).text).toMatch(
      /^Not restored: the order set in the list \(#…\) gives no valid/,
    );
    expect(reorderIds(bad)).toEqual(swapped);
    const use = actionsOf(bad).find((a) => a.label === "Use the hint 'order'")!;
    expectRestored(run(hinted.bytes, use.options as Opts), hinted.clean);
  });
});

describe('Adler-32 decides (D03 / E01, F01)', () => {
  // Stored blocks with samples 0..4: every row start is a valid filter type in any order, so
  // only the Adler-32 tells the orders apart, and with equal-size pieces of such flat data it
  // often cannot (its A half ignores the order; the B half collides). Either the right order
  // is found and unique, or the tool says it cannot tell: never a success with wrong pixels.
  const pic04 = noise(40, 30, 3, 4);
  const { ihdr, zlib } = rawStream(pic04, 0);
  const clean = png({ ihdr, idats: [zlib] });
  const pieces = cut(zlib, 7);
  const honest = (out: Output[]) => {
    if (expectHonest(out, clean) === 'restored') return;
    expect(summary(out).level).toBe('warn');
    expect(summary(out).text).toMatch(
      /^Unconfirmed: .*(Several IDAT orders inflate with a matching Adler-32|could not try every order)/,
    );
  };
  const variants: [string, number[]][] = [
    ['header and Adler-32 parts kept in place', [1, 4, 6, 2, 5, 3, 7]],
    ['header elsewhere', [5, 3, 1, 7, 2, 6, 4]],
  ];
  for (const [name, seq] of variants) {
    const bytes = png({ ihdr, idats: shuffleByPositions(pieces, seq) });
    for (const fixZlib of [true, false]) {
      it(`${name}, no hint, fixZlib ${fixZlib}: never scrambled pixels called restored`, () => {
        const out = run(bytes, { fixZlib });
        honest(out);
        expect(summary(out).text).not.toContain('Adler-32 recomputed');
        expect(summary(out).text).not.toMatch(/^Nothing to repair/);
      });
    }
    for (const reading of ['position', 'chunk'] as const) {
      it(`${name}, hint read as ${reading}: the matching reading, or an honest doubt`, () => {
        const text = reading === 'chunk' ? seq.join(' ') : inverse(seq).join(' ');
        const out = run(
          png({ ihdr, before: [tEXt('order', text)], idats: shuffleByPositions(pieces, seq) }),
        );
        honest(out);
        const rows = tableOf(out, 'Orders tried')!.rows;
        // (An involution gives one row for both readings.)
        const right = rows.find(
          (r) => r[1] === readingName(reading) || String(r[1]).includes('same order'),
        )!;
        expect(right[3]).toBe('OK');
      });
    }
  }

  it('the same flat data in pieces of unequal size: found and unique', () => {
    const uneven = cut(zlib, [300, 700, 150, 900, 420, 260]);
    const seq = [5, 3, 1, 7, 2, 6, 4];
    const out = run(png({ ihdr, idats: shuffleByPositions(uneven, seq) }));
    honest(out);
  });

  it('no order matches a wiped Adler-32: never called restored', () => {
    const wiped = zlib.slice();
    wiped.fill(0, wiped.length - 4);
    const bytes = png({ ihdr, idats: shuffleByPositions(cut(wiped, 7), [1, 4, 6, 2, 5, 3, 7]) });
    const out = run(bytes);
    expect(summary(out).level).toBe('warn');
    expect(summary(out).text).toMatch(/^Unconfirmed: .*matches no order the search tried/);
    expect(resultToText(out)).toContain('order unconfirmed');
  });

  it('only the Adler-32 is wiped on chunks in order: recomputed, still a success', () => {
    const e = encode(pic('rgb8'));
    const wiped = e.zlib.slice();
    wiped.fill(0, wiped.length - 4);
    const out = run(png({ ihdr: e.ihdr, idats: cut(wiped, 4) }));
    expectRestored(out, e.png);
    expect(summary(out).text).toContain('Adler-32 recomputed');
  });

  it('a dark, low-entropy picture shuffled without a hint is never a false success', () => {
    const dark = picture(160, 60, [TEXT('DARK 77', 10, 20, 3)], 'gray8');
    dark.data = (dark.data as Uint8Array).map((v) => (v < 100 ? 255 : 0));
    for (const seed of [1, 2]) {
      const b = build(dark, 11, shuffled(11, seed), 'chunk');
      expectHonest(run(b.bytes), b.clean);
    }
  }, 30_000);

  it('F01 stored blocks of a noisy picture, no hint, 7 and 12 IDAT: found, or an honest give-up', () => {
    const p = noise(48, 40, 9);
    const { ihdr: ih, zlib: z } = rawStream(p, 0);
    const c = png({ ihdr: ih, idats: [z] });
    for (const n of [7, 12]) {
      const out = run(png({ ihdr: ih, idats: shuffleByPositions(cut(z, n), shuffled(n, n + 1)) }));
      expectHonest(out, c);
    }
  }, 30_000);
});

describe('several hints (E03 / F01)', () => {
  it('a wrong tEXt "order" before the right zTXt "sequence": the second is tried and used', () => {
    for (const [n, search] of [
      [7, false],
      [20, true],
    ] as const) {
      const seq = shuffled(n, 40 + n);
      const decoy = shuffled(n, 90 + n);
      const b = build(pic('rgb8', 96, 72), n, seq, 'chunk', [
        tEXt('order', decoy.join(' ')),
        zTXt('sequence', seq.join(' ')),
      ]);
      const out = run(b.bytes, { search });
      expectRestored(out, b.clean);
      expect(summary(out).text).toContain("(hint 'sequence', chunk→position)");
    }
  });

  it('every hint failing is reported hint by hint', () => {
    const b = build(pic('rgb8'), 5, [3, 1, 5, 2, 4], 'chunk', [
      tEXt('order', '2 1 3 4 5'),
      tEXt('sequence', '1 3 2 4 5'),
    ]);
    const out = run(b.bytes, { search: false });
    expect(summary(out).text).toMatch(
      /^Not restored: no hint gives a valid zlib stream \(hint 'order', /,
    );
    expect(summary(out).text).toContain("hint 'sequence', ");
  });
});
