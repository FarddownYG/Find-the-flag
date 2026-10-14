import { describe, expect, it } from 'vitest';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import {
  DEFAULT_MAPPING,
  ORIENTATIONS,
  bestOrientations,
  columnValue,
  decodeDocuColor,
  describeOrientation,
  encodeDocuColor,
  fullYear,
  inverseOrientation,
  matrixToText,
  orient,
  parityCheck,
  parseMatrixText,
  renderMatrix,
  singleDotFix,
  type DocuFields,
  type Mapping,
  type Matrix,
} from './_docucolor';
import docucolor from './docucolor';

// ---------- helpers ----------

/** Small seeded PRNG (mulberry32) so the random round trips are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/** Years 1969-2068: what the default century pivot can hold (DEDA: closest to 2018). */
function randomFields(r: (n: number) => number): DocuFields {
  return {
    minute: r(60),
    hour: r(24),
    day: 1 + r(31),
    month: 1 + r(12),
    year: 1969 + r(100),
    serial: Array.from({ length: 8 }, () => r(10)).join(''),
  };
}

/**
 * Independent oracle, written from the EFF description only: column c (1-based) holds its value
 * on rows 2-8 with weights 64..1; every row 2-8 and every column gets a parity dot in row 1 /
 * column 1 so that it holds an odd number of dots.
 */
function eff(values: Record<number, number>): boolean[][] {
  const m = Array.from({ length: 8 }, () => Array.from({ length: 15 }, () => false));
  for (const [c, v] of Object.entries(values))
    for (let bit = 0; bit < 7; bit++) m[1 + bit]![Number(c) - 1] = ((v >> (6 - bit)) & 1) === 1;
  for (let r = 1; r < 8; r++) m[r]![0] = m[r]!.slice(1).filter(Boolean).length % 2 === 0;
  for (let c = 0; c < 15; c++) m[0]![c] = m.slice(1).filter((row) => row[c]).length % 2 === 0;
  return m;
}

const dots = (cells: boolean[]) => cells.filter(Boolean).length;
const col = (m: boolean[][], c: number) => m.map((row) => row[c] === true);
const flip = (m: Matrix, r: number, c: number): Matrix =>
  m.map((row, i) => row.map((v, j) => (i === r && j === c ? !v : v)));

const run = (input: string, options: Record<string, unknown> = {}) => {
  const defaults = Object.fromEntries(
    Object.entries(docucolor.options ?? {}).map(([k, spec]) => [k, spec.default]),
  );
  return docucolor.run(input, { ...defaults, ...options } as never) as Output[];
};
const kv = (out: Output[]) => {
  const block = out.find((o) => o.type === 'kv');
  return block?.type === 'kv' ? Object.fromEntries(block.entries) : {};
};
const notes = (out: Output[]) =>
  out.flatMap((o) => (o.type === 'note' ? [`${o.level}: ${o.text}`] : []));

const SAMPLE: DocuFields = {
  minute: 42,
  hour: 8,
  day: 5,
  month: 11,
  year: 2019,
  serial: '31415926',
};
const SEP = { 10: 127 };

// ---------- the format, against the EFF description ----------

describe('DocuColor layout (EFF)', () => {
  it('reads a column top to bottom with rows 2-8 worth 64..1 (minute 50 = 32 + 16 + 2)', () => {
    const m = eff({ 2: 50 });
    expect(
      m
        .slice(1)
        .map((row) => (row[1] ? '1' : '0'))
        .join(''),
    ).toBe('0110010');
    expect(columnValue(m, 2)).toBe(50);
    const d = decodeDocuColor(m);
    expect(d.columns[1]).toMatchObject({ col: 2, field: 'minute', bits: '0110010', value: 50 });
  });

  it('maps columns as the EFF guide: 2 min, 5 h, 6 day, 7 month, 8 year, 14-11 serial', () => {
    const m = eff({ 2: 42, 5: 8, 6: 5, 7: 11, 8: 19, 10: 127, 11: 26, 12: 59, 13: 41, 14: 31 });
    const d = decodeDocuColor(m);
    expect(d.fields).toEqual(SAMPLE);
    expect(d.parity).toEqual({ ok: true, badRows: [], badCols: [] });
    expect(d.plausible).toBe(true);
    expect(d.columns.map((c) => c.field)).toEqual([
      'parity',
      'minute',
      'unused',
      'unused (DEDA: maker)',
      'hour',
      'day',
      'month',
      'year (2 digits)',
      'unused',
      'separator (EFF)',
      'serial 7-8',
      'serial 5-6',
      'serial 3-4',
      'serial 1-2',
      'unknown',
    ]);
    // The encoder builds exactly the tile the EFF rules describe.
    expect(encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP)).toEqual(m);
  });

  it('decodes a hand-written literal tile', () => {
    // Minute 1 (row 8 of column 2) and nothing else. Rows 2-7 are empty, so each gets its
    // parity dot; column 1 then holds 6 dots, so the corner dot makes it odd.
    const tile = parseMatrixText(
      [
        '1 0 1 1 1 1 1 1 1 1 1 1 1 1 1',
        '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
        '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
        '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
        '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
        '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
        '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
        '0 1 0 0 0 0 0 0 0 0 0 0 0 0 0',
      ].join('\n'),
    );
    const d = decodeDocuColor(tile);
    expect(d.parity.ok).toBe(true);
    expect(d.fields.minute).toBe(1);
    expect(d.fields.serial).toBe('00000000');
    expect(d.fields.year).toBe(2000);
    expect(encodeDocuColor({ ...d.fields })).toEqual(tile);
  });
});

describe('parity convention', () => {
  it('odd (EFF): rows 2-8 and all 15 columns odd, the parity column and corner included; row 1 even', () => {
    const r = rng(7);
    for (let k = 0; k < 300; k++) {
      const m = encodeDocuColor(randomFields(r), DEFAULT_MAPPING, r(2) ? SEP : {});
      for (let row = 1; row < 8; row++) expect(dots(m[row]!) % 2).toBe(1);
      for (let c = 0; c < 15; c++) expect(dots(col(m, c)) % 2).toBe(1);
      // 15 odd columns add up to an odd total, rows 2-8 too: row 1 is necessarily even,
      // which is why the EFF exempts the top row (and only it).
      expect(dots(m[0]!) % 2).toBe(0);
      expect(parityCheck(m).ok).toBe(true);
      expect(parityCheck(m, false).ok).toBe(false);
    }
  });

  it('even parity is the mirror convention', () => {
    const m = encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP, false);
    for (let row = 1; row < 8; row++) expect(dots(m[row]!) % 2).toBe(0);
    for (let c = 1; c < 15; c++) expect(dots(col(m, c)) % 2).toBe(0);
    expect(parityCheck(m, false).ok).toBe(true);
    expect(parityCheck(m).ok).toBe(false);
    expect(decodeDocuColor(m, DEFAULT_MAPPING, false).fields).toEqual(SAMPLE);
  });

  it('locates a flipped dot (1-based row and column)', () => {
    const m = encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP);
    for (let r = 1; r < 8; r++) {
      for (let c = 1; c < 15; c++) {
        const bad = flip(m, r, c);
        expect(parityCheck(bad)).toEqual({ ok: false, badRows: [r + 1], badCols: [c + 1] });
        expect(singleDotFix(bad)).toEqual({ row: r + 1, col: c + 1, matrix: m });
      }
    }
    // A parity-column dot upsets its row and column 1, a parity-row dot only its column.
    expect(parityCheck(flip(m, 3, 0))).toEqual({ ok: false, badRows: [4], badCols: [1] });
    expect(singleDotFix(flip(m, 3, 0))).toEqual({ row: 4, col: 1, matrix: m });
    expect(parityCheck(flip(m, 0, 6))).toEqual({ ok: false, badRows: [], badCols: [7] });
    expect(singleDotFix(flip(m, 0, 6))?.matrix).toEqual(m);
    // The corner belongs to column 1, which the EFF counts too ("every column ... odd").
    expect(parityCheck(flip(m, 0, 0))).toEqual({ ok: false, badRows: [], badCols: [1] });
    expect(singleDotFix(flip(m, 0, 0))).toEqual({ row: 1, col: 1, matrix: m });
    // Two errors are not "fixed".
    expect(singleDotFix(flip(flip(m, 2, 3), 5, 9))).toBeNull();
  });
});

describe('plausibility', () => {
  const base = encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP);
  const withField = (f: Partial<DocuFields>) =>
    decodeDocuColor(encodeDocuColor({ ...SAMPLE, ...f }, DEFAULT_MAPPING, SEP));

  it('accepts real dates and serials', () => {
    expect(decodeDocuColor(base).plausible).toBe(true);
    expect(withField({ minute: 59, hour: 23, day: 31, month: 12, year: 2068 }).plausible).toBe(
      true,
    );
    expect(withField({ minute: 0, hour: 0, day: 1, month: 1, year: 1969 }).plausible).toBe(true);
  });

  it.each([
    [{ minute: 60 }, 'minute 60 > 59'],
    [{ hour: 24 }, 'hour 24 > 23'],
    [{ day: 0 }, 'day 0 not in 1-31'],
    [{ day: 32 }, 'day 32 not in 1-31'],
    [{ month: 0 }, 'month 0 not in 1-12'],
    [{ month: 13 }, 'month 13 not in 1-12'],
  ])('rejects %o', (f, issue) => {
    const d = withField(f);
    expect(d.parity.ok).toBe(true);
    expect(d.plausible).toBe(false);
    expect(d.dateOk).toBe(false);
    expect(d.serialOk).toBe(true);
    expect(d.issues).toEqual([issue]);
  });

  it('rejects a year column above 99 (not two decimal digits)', () => {
    const d = decodeDocuColor(eff({ 2: 42, 5: 8, 6: 5, 7: 11, 8: 100, 10: 127 }));
    expect(d.parity.ok).toBe(true);
    expect(d.issues).toEqual(['year column 100 > 99']);
    expect(d.dateOk).toBe(false);
  });

  it('rejects a serial column above 99 and shows it as [value]', () => {
    const m = encodeDocuColor(
      { ...SAMPLE, serial: '314159' },
      { ...DEFAULT_MAPPING, serialColumns: [14, 13, 12] },
      { ...SEP, 11: 120 },
    );
    const d = decodeDocuColor(m);
    expect(d.plausible).toBe(false);
    expect(d.dateOk).toBe(true);
    expect(d.serialOk).toBe(false);
    expect(d.fields.serial).toBe('314159[120]');
    expect(d.issues).toEqual(['serial column 11 = 120 > 99']);
  });
});

describe('encode errors', () => {
  it.each([
    [{ ...SAMPLE, serial: '123456789' }, DEFAULT_MAPPING, /9 digits/],
    [{ ...SAMPLE, serial: '12a4' }, DEFAULT_MAPPING, /decimal digits/],
    [{ ...SAMPLE, minute: 128 }, DEFAULT_MAPPING, /0-127/],
    [{ ...SAMPLE, year: 1968 }, DEFAULT_MAPPING, /must be 1969-2068; got 1968/],
    [{ ...SAMPLE, year: 2069 }, DEFAULT_MAPPING, /must be 1969-2068; got 2069/],
    [{ ...SAMPLE, year: 1999 }, { ...DEFAULT_MAPPING, century: 2000 }, /must be 2000-2099/],
    [SAMPLE, { ...DEFAULT_MAPPING, hour: 2 }, /Column 2 is mapped twice: minute and hour/],
    [SAMPLE, { ...DEFAULT_MAPPING, day: 1 }, /column 1 is parity/],
    [SAMPLE, { ...DEFAULT_MAPPING, month: 16 }, /from 2 to 15/],
  ] as [DocuFields, Mapping, RegExp][])('%o', (f, mapping, msg) => {
    expect(() => encodeDocuColor(f, mapping)).toThrow(msg);
  });

  it('refuses extras on a mapped column', () => {
    expect(() => encodeDocuColor(SAMPLE, DEFAULT_MAPPING, { 2: 5 })).toThrow(/minute/);
  });

  it('pads short serials on the left', () => {
    const d = decodeDocuColor(encodeDocuColor({ ...SAMPLE, serial: '123456' }));
    expect(d.fields.serial).toBe('00123456');
    expect(columnValue(encodeDocuColor({ ...SAMPLE, serial: '123456' }), 14)).toBe(0);
  });
});

// ---------- round trips ----------

describe('round trips', () => {
  it('encode -> decode is exact for 2000 random dates and serials (with and without column 10)', () => {
    const r = rng(2024);
    for (let k = 0; k < 2000; k++) {
      const f = randomFields(r);
      const m = encodeDocuColor(f, DEFAULT_MAPPING, k % 2 ? SEP : { 15: r(128) });
      const d = decodeDocuColor(m);
      expect(d.fields).toEqual(f);
      expect(d.parity.ok).toBe(true);
      expect(d.plausible).toBe(true);
    }
  });

  it('a tile scanned in any of the 8 orientations comes back exactly', () => {
    const r = rng(99);
    for (let k = 0; k < 250; k++) {
      const f = randomFields(r);
      const tile = encodeDocuColor(f, DEFAULT_MAPPING, SEP);
      for (const o of ORIENTATIONS) {
        const scanned = orient(tile, o);
        const tries = bestOrientations(scanned);
        expect(tries).toHaveLength(4);
        const best = tries[0]!;
        expect(best.matrix).toEqual(tile);
        expect(best.parityOk && best.plausible).toBe(true);
        expect(best.orientation).toEqual(inverseOrientation(o));
        expect(decodeDocuColor(best.matrix).fields).toEqual(f);
      }
    }
  });

  it('round trips through the text form', () => {
    const r = rng(5);
    for (let k = 0; k < 100; k++) {
      const tile = encodeDocuColor(randomFields(r), DEFAULT_MAPPING, SEP);
      expect(parseMatrixText(matrixToText(tile))).toEqual(tile);
    }
  });

  it('round trips with a custom mapping, and the default mapping then reads something else', () => {
    const mapping: Mapping = {
      minute: 3,
      hour: 4,
      day: 9,
      month: 15,
      year: 2,
      serialColumns: [11, 12, 13],
      century: 1900,
    };
    const f = { ...SAMPLE, year: 1987, serial: '271828' };
    const m = encodeDocuColor(f, mapping);
    expect(decodeDocuColor(m, mapping).fields).toEqual(f);
    expect(decodeDocuColor(m).fields).not.toEqual(f);
  });

  it('a corrupted tile fails parity in every orientation', () => {
    const tile = flip(encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP), 3, 5);
    for (const o of ORIENTATIONS)
      expect(bestOrientations(orient(tile, o)).every((t) => !t.parityOk)).toBe(true);
  });
});

describe('orientation helpers', () => {
  const tile = encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP);

  it('inverseOrientation undoes orient, 4 turns are the identity', () => {
    for (const o of ORIENTATIONS)
      expect(orient(orient(tile, o), inverseOrientation(o))).toEqual(tile);
    let m: boolean[][] = tile;
    for (let k = 0; k < 4; k++) m = orient(m, { rotate: 90, mirror: false });
    expect(m).toEqual(tile);
  });

  it('turns clockwise: the top-left cell goes top-right', () => {
    const g = [
      [true, false, false],
      [false, false, false],
    ];
    expect(orient(g, { rotate: 90, mirror: false })).toEqual([
      [false, true],
      [false, false],
      [false, false],
    ]);
    expect(orient(g, { rotate: 0, mirror: true })[0]).toEqual([false, false, true]);
  });

  it('describes orientations', () => {
    expect(describeOrientation({ rotate: 0, mirror: false })).toBe('as given');
    expect(describeOrientation({ rotate: 180, mirror: false })).toBe('turned 180°');
    expect(describeOrientation({ rotate: 270, mirror: false })).toBe(
      'turned 90° counter-clockwise',
    );
    expect(describeOrientation({ rotate: 0, mirror: true })).toBe('mirrored left-right');
  });

  it('rejects grids of the wrong size', () => {
    expect(() => bestOrientations([[true, false]])).toThrow(/this grid is 1 × 2/);
    expect(() => decodeDocuColor(orient(tile, { rotate: 90, mirror: false }))).toThrow(/15 × 8/);
  });

  it('without the column-10 separator a mirrored reading can also look valid: both are listed', () => {
    const plain = encodeDocuColor({ ...SAMPLE, serial: '00000000' });
    const tries = bestOrientations(plain);
    expect(tries[0]!.matrix).toEqual(plain);
    // The mirror keeps every row and column count, so it passes parity too.
    const mirrored = tries.find((t) => t.orientation.mirror && t.orientation.rotate === 0)!;
    expect(mirrored.parityOk).toBe(true);
  });
});

describe('text parsing', () => {
  const tile = encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP);
  const as = (on: string, off: string, sep: string) =>
    tile.map((row) => row.map((c) => (c ? on : off)).join(sep)).join('\n');

  it.each([
    ['1', '0', ' '],
    ['1', '0', ''],
    ['x', '.', ''],
    ['X', '.', ' '],
    ['●', '·', ' '],
    ['●', '·', ''],
    ['o', '.', ''],
    ['#', '-', ''],
  ])('reads %s / %s separated by "%s"', (on, off, sep) => {
    expect(parseMatrixText(as(on, off, sep))).toEqual(tile);
  });

  it('ignores blank lines, CRLF, brackets and commas', () => {
    const py = `[${tile.map((row) => `[${row.map((c) => (c ? 1 : 0)).join(', ')}]`).join(',\r\n')}]`;
    expect(parseMatrixText(`\n${py}\n\n`)).toEqual(tile);
  });

  it('names a bad character and a ragged row', () => {
    expect(() => parseMatrixText('101\n1z1')).toThrow(/Line 2: "z"/);
    expect(() => parseMatrixText('101\n11')).toThrow(/row 1 has 3, row 2 has 2/);
  });
});

describe('render', () => {
  it('draws one tile with a margin, yellow dots on white', () => {
    const tile = encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP);
    const img = renderMatrix(tile, { cell: 10 });
    expect([img.width, img.height]).toEqual([170, 100]);
    const px = (x: number, y: number) => [
      ...img.data.slice((y * 170 + x) * 4, (y * 170 + x) * 4 + 3),
    ];
    // Cell (row 1, column 10) is the separator: a dot at its centre; the margin is white.
    expect(px(10 * 10 + 5, 2 * 10 + 5)).toEqual([255, 214, 0]);
    expect(px(2, 2)).toEqual([255, 255, 255]);
  });
});

// ---------- the tool ----------

describe('docucolor tool', () => {
  const text = matrixToText(encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP));

  it('decodes, says parity OK, lists columns and orientations', () => {
    const out = run(text);
    expect(notes(out)[0]).toMatch(/^success: Parity OK/);
    expect(kv(out)).toEqual({
      Printed: '2019-11-05 08:42',
      Serial: '31415926',
      'Orientation used': 'as given',
      Parity: 'OK',
    });
    const tables = out.filter((o) => o.type === 'table');
    expect(tables).toHaveLength(2);
    const cols = tables[0]!;
    if (cols.type !== 'table') throw new Error('table expected');
    expect(cols.columns).toEqual(['Col', 'Field', 'Bits', 'Value', 'Parity']);
    expect(cols.rows[0]).toEqual([1, 'parity', expect.stringMatching(/^[01]{7}$/), '—', 'ok']);
    expect(cols.rows[1]).toEqual([2, 'minute', '0101010', 42, 'ok']);
    expect(cols.rows[13]).toEqual([14, 'serial 1-2', '0011111', 31, 'ok']);
    expect(cols.highlight).toEqual([1, 4, 5, 6, 7, 10, 11, 12, 13]);
  });

  it('reads a tile given upside down or sideways, and says how it turned it', () => {
    const tile = encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP);
    const out = run(matrixToText(orient(tile, { rotate: 90, mirror: false })));
    expect(kv(out)['Printed']).toBe('2019-11-05 08:42');
    expect(kv(out)['Orientation used']).toBe('turned 90° counter-clockwise');
    expect(kv(run(matrixToText(orient(tile, { rotate: 180, mirror: false }))))).toMatchObject({
      'Orientation used': 'turned 180°',
      Serial: '31415926',
    });
  });

  it('is frank about a parity failure and proposes the single-dot fix as a guess', () => {
    const bad = matrixToText(flip(encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP), 3, 5));
    const n = notes(run(bad));
    expect(n[0]).toBe(
      'error: Parity FAILED (row 4, column 6) — the reading below is uncertain. None of the 4 orientations that give an 8 × 15 tile passes parity.',
    );
    expect(n[1]).toMatch(
      /^warn: A single misread dot .* row 4, column 6 .* reads 2019-11-05 08:42, serial 31415926\. That is a guess/,
    );
    expect(kv(run(bad))).toMatchObject({
      Printed: '2019-11-21 08:42 (uncertain)',
      Parity: 'FAILED (row 4, column 6)',
    });
  });

  it('corrects one misread dot only when asked, and says so (amber, never green)', () => {
    const tile = encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP);
    // Upside down and one dot wrong: auto mode must still find the orientation and the dot.
    const bad = matrixToText(orient(flip(tile, 6, 12), { rotate: 180, mirror: false }));
    const out = run(bad, { fixOne: true });
    const n = notes(out);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatch(
      /^warn: Corrected, not clean: parity failed as read \(row 7, column 13\); flipping the dot at row 7, column 13/,
    );
    expect(kv(out)).toEqual({
      Printed: '2019-11-05 08:42 (1 dot corrected)',
      Serial: '31415926 (1 dot corrected)',
      'Orientation used': 'turned 180°',
      Parity: 'OK after flipping row 7, column 13 (FAILED as read)',
    });
    const t = out.filter((o) => o.type === 'text').pop();
    expect(t?.type === 'text' && t.value).toBe(matrixToText(tile));
    // Two wrong dots cannot be corrected: still red.
    const two = matrixToText(flip(flip(tile, 2, 3), 5, 9));
    expect(notes(run(two, { fixOne: true }))[0]).toMatch(
      /^error: Parity FAILED \(rows 3, 6, columns 4, 10\)/,
    );
    // A clean tile is untouched by the option.
    expect(notes(run(text, { fixOne: true }))[0]).toMatch(/^success: Parity OK/);
  });

  it('warns when parity passes but the values are not a date (amber, and no fake date)', () => {
    const m = encodeDocuColor({ ...SAMPLE, month: 14 }, DEFAULT_MAPPING, SEP);
    const out = run(matrixToText(m), { orientation: 'r0' });
    const n = notes(out);
    expect(kv(out)['Printed']).toBe('— (uncertain)');
    expect(kv(out)['Serial']).toBe('31415926 (uncertain)');
    expect(n).toEqual([
      'warn: Parity OK, but the values are not a valid date or serial (month 14 not in 1-12): low confidence. Check the orientation and the column mapping.',
    ]);
    // The raw value is still in the column table.
    const cols = out.find((o) => o.type === 'table');
    expect(cols?.type === 'table' && cols.rows[6]).toEqual([7, 'month', '0001110', 14, 'ok']);
  });

  it('can be forced to an orientation, and refuses one that does not fit', () => {
    const tile = encodeDocuColor(SAMPLE, DEFAULT_MAPPING, SEP);
    const out = run(matrixToText(tile), { orientation: 'm0' });
    expect(kv(out)['Orientation used']).toBe('mirrored left-right');
    expect(notes(out).some((x) => x.startsWith('warn: Parity OK, but the values are not'))).toBe(
      true,
    );
    expect(notes(out).some((x) => x.startsWith('success'))).toBe(false);
    expect(() => run(matrixToText(tile), { orientation: 'r90' })).toThrow(/does not give/);
  });

  it('uses the mapping options', () => {
    const mapping: Mapping = { ...DEFAULT_MAPPING, serialColumns: [11, 12, 13, 14] };
    const m = encodeDocuColor(SAMPLE, mapping, SEP);
    expect(kv(run(matrixToText(m), { serialCols: '11 12 13 14' }))['Serial']).toBe('31415926');
    expect(kv(run(matrixToText(m)))['Serial']).toBe('26594131');
    expect(() => run(text, { serialCols: '14, x' })).toThrow(/"x" is not a column/);
    expect(() => run(text, { hourCol: 2 })).toThrow(/mapped twice/);
  });

  it('encodes: matrix text, tile image, round-trip note', () => {
    const out = run('2019-11-05 08:42 3141-5926', { mode: 'encode' });
    expect(notes(out)[0]).toBe(
      'success: Round trip OK: the tile decodes back to 2019-11-05 08:42, serial 31415926, odd parity.',
    );
    const t = out.find((o) => o.type === 'text');
    expect(t?.type === 'text' && t.value).toBe(text);
    const img = out.find((o) => o.type === 'image');
    expect(img?.type === 'image' && [img.image.width, img.image.height]).toEqual([272, 160]);
    // Decoding the encoder's own text gives the same values.
    expect(kv(run(t?.type === 'text' ? t.value : ''))['Printed']).toBe('2019-11-05 08:42');
  });

  it('encodes from the decoder output pasted back, serial first or last, or no serial', () => {
    const tile = (s: string) => {
      const t = run(s, { mode: 'encode' }).find((o) => o.type === 'text');
      return t?.type === 'text' ? t.value : '';
    };
    expect(tile('Printed: 2019-11-05 08:42\nSerial: 31415926')).toBe(text);
    expect(tile('31415926 2019-11-05T08:42')).toBe(text);
    expect(kv(run(tile('2019-11-05 08:42')))['Serial']).toBe('00000000');
  });

  it('checks the encode input', () => {
    const enc = (s: string, o: Record<string, unknown> = {}) => run(s, { mode: 'encode', ...o });
    expect(() => enc('2023-02-29 10:00')).toThrow(/2023-02-29 10:00 is not a calendar date/);
    expect(() => enc('2023-02-28 24:00')).toThrow(/time of day/);
    expect(() => enc('14/03/2024 10:00')).toThrow(/YYYY-MM-DD HH:MM/);
    expect(() => enc('')).toThrow(/YYYY-MM-DD HH:MM/);
    expect(() => enc('2023-02-28 10:00 12ab')).toThrow(/must be digits/);
    expect(() => enc('2023-02-28 10:00 123456789')).toThrow(/9 digits/);
    expect(() => enc('1950-01-01 00:00')).toThrow(/must be 1969-2068/);
    expect(resultToText(enc('1950-01-01 00:00', { century: '1900' }))).toContain('Round trip OK');
    expect(resultToText(enc('1999-01-01 00:00'))).toContain('Round trip OK');
  });

  it('asks for input when empty', () => {
    expect(() => run('  ')).toThrow(/Paste the dot matrix/);
  });

  it('detects pasted grids', () => {
    const d = docucolor.detect!;
    expect(d({ text, bytes: new Uint8Array() })?.score).toBeGreaterThan(0.8);
    const bits = text.replace(/●/g, '1').replace(/·/g, '0');
    expect(d({ text: bits, bytes: new Uint8Array() })?.score).toBeGreaterThan(0.5);
    expect(d({ text: 'hello', bytes: new Uint8Array() })).toBeNull();
    expect(d({ text: '0101\n1010', bytes: new Uint8Array() })).toBeNull();
  });
});

// ---------- regressions from the format review (EFF guide, DEDA source) ----------

describe('format review: reference tile, parity column, century, maker', () => {
  // Written by hand from the EFF rules for 2007-06-23 19:41, serial 40179362 (c2 = 41, c5 = 19,
  // c6 = 23, c7 = 6, c8 = 7, c10 = 127, c11 = 62, c12 = 93, c13 = 17, c14 = 40), odd parity, the
  // corner making column 1 odd; the reviewer checked that DEDA's Pattern4 accepts and decodes it.
  const HAND = [
    '001101101000111',
    '100000000101000',
    '110000000110010',
    '100011000111100',
    '010000000111010',
    '100001110111000',
    '100011110110000',
    '010011010101100',
  ];
  const hand = HAND.map((row) => [...row].map((c) => c === '1'));
  const fields: DocuFields = {
    year: 2007,
    month: 6,
    day: 23,
    hour: 19,
    minute: 41,
    serial: '40179362',
  };

  it('decodes the hand-made tile, and the encoder rebuilds it bit for bit', () => {
    const out = run(HAND.join('\n'));
    expect(kv(out)).toEqual({
      Printed: '2007-06-23 19:41',
      Serial: '40179362',
      'Orientation used': 'as given',
      Parity: 'OK',
    });
    expect(notes(out)[0]).toMatch(/^success: Parity OK/);
    expect(encodeDocuColor(fields, DEFAULT_MAPPING, SEP)).toEqual(hand);
    const enc = run('2007-06-23 19:41 40179362', { mode: 'encode' });
    const t = enc.find((o) => o.type === 'text');
    expect(t?.type === 'text' && t.value).toBe(matrixToText(hand));
  });

  it('reads it back in all 8 orientations, and lists every column as the EFF does', () => {
    for (const o of ORIENTATIONS) {
      const v = kv(run(matrixToText(orient(hand, o))));
      expect(v['Printed'], describeOrientation(o)).toBe('2007-06-23 19:41');
      expect(v['Serial'], describeOrientation(o)).toBe('40179362');
    }
    const cols = run(HAND.join('\n')).find((o) => o.type === 'table');
    if (cols?.type !== 'table') throw new Error('table expected');
    expect(cols.rows.map((r) => [r[0], r[1], r[3]])).toEqual([
      [1, 'parity', '—'],
      [2, 'minute', 41],
      [3, 'unused', 0],
      [4, 'unused (DEDA: maker)', 0],
      [5, 'hour', 19],
      [6, 'day', 23],
      [7, 'month', 6],
      [8, 'year (2 digits)', 7],
      [9, 'unused', 0],
      [10, 'separator (EFF)', 127],
      [11, 'serial 7-8', 62],
      [12, 'serial 5-6', 93],
      [13, 'serial 3-4', 17],
      [14, 'serial 1-2', 40],
      [15, 'unknown', 0],
    ]);
  });

  it("reads DEDA's six-digit serial (columns 13, 12, 11) when asked", () => {
    expect(kv(run(HAND.join('\n'), { serialCols: '13, 12, 11' }))['Serial']).toBe('179362');
  });

  it('a flipped corner dot breaks column 1 parity (EFF: every column odd) and is located', () => {
    const bad = flip(hand, 0, 0);
    expect(parityCheck(bad)).toEqual({ ok: false, badRows: [], badCols: [1] });
    const out = run(matrixToText(bad));
    const n = notes(out);
    expect(n[0]).toMatch(/^error: Parity FAILED \(column 1\)/);
    expect(n.some((x) => x.startsWith('success'))).toBe(false);
    expect(n[1]).toMatch(/flipping row 1, column 1 makes parity pass and reads 2007-06-23 19:41/);
    expect(kv(out)['Printed']).toBe('2007-06-23 19:41 (uncertain)');
    // The single-dot correction restores it, flagged as corrected.
    expect(kv(run(matrixToText(bad), { fixOne: true }))['Parity']).toBe(
      'OK after flipping row 1, column 1 (FAILED as read)',
    );
  });

  it.each([
    [98, 'pivot', 1998],
    [69, 'pivot', 1969],
    [68, 'pivot', 2068],
    [0, 'pivot', 2000],
    [98, '2000', 2098],
    [68, '1900', 1968],
  ] as const)('year column %i with century %s reads %i', (yy, century, year) => {
    const m = eff({ 2: 0, 5: 0, 6: 1, 7: 1, 8: yy, 10: 127 });
    expect(kv(run(matrixToText(m), { century }))['Printed']).toBe(`${year}-01-01 00:00`);
    expect(
      fullYear(yy, century === 'pivot' ? 'pivot' : Number(century) === 1900 ? 1900 : 2000),
    ).toBe(year);
  });

  it('the column table says which century rule was used', () => {
    const label = (o: Record<string, unknown>) => {
      const t = run(HAND.join('\n'), o).find((b) => b.type === 'table');
      return t?.type === 'table' ? t.label : '';
    };
    expect(label({})).toContain('year: 00-68 → 20xx, 69-99 → 19xx');
    expect(label({ century: '1900' })).toContain('year: always 19xx');
  });

  it("names DEDA's maker code in column 4 when it says Dell or Epson", () => {
    const dell = run(matrixToText(eff({ 2: 1, 4: 20, 5: 2, 6: 3, 7: 4, 8: 5, 10: 127 })));
    expect(notes(dell)).toContain(
      'info: Column 4 = 20: DEDA reads this as a Dell printer, whose serial columns carry no real serial number.',
    );
    const epson = run(matrixToText(eff({ 2: 1, 4: 3, 5: 2, 6: 3, 7: 4, 8: 5, 10: 127 })));
    expect(notes(epson).some((x) => x.includes('Epson'))).toBe(true);
    expect(notes(run(HAND.join('\n'))).some((x) => x.includes('DEDA reads'))).toBe(false);
    expect(decodeDocuColor(hand).maker).toBe('Xerox');
  });

  it('two orientations with valid but different readings: amber "ambiguous", never green', () => {
    // No separator; columns 9 and 10 hold a small month and day, so the mirrored read is valid.
    const m = encodeDocuColor({ ...SAMPLE, serial: '40000012' }, DEFAULT_MAPPING, { 9: 5, 10: 12 });
    const tries = bestOrientations(m).filter((t) => t.parityOk && t.plausible);
    expect(tries).toHaveLength(2);
    const out = run(matrixToText(m));
    const n = notes(out);
    expect(n.some((x) => x.startsWith('success'))).toBe(false);
    expect(n[0]).toMatch(
      /^warn: Parity OK, but 2 orientations pass parity with valid but different values: the reading is ambiguous/,
    );
    expect(kv(out)['Printed']).toMatch(/ \(ambiguous\)$/);
    // Forcing the orientation removes the ambiguity.
    expect(notes(run(matrixToText(m), { orientation: 'r0' }))[0]).toMatch(/^success: Parity OK/);
  });
});
