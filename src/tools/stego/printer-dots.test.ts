import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import {
  DEFAULT_MAPPING,
  ORIENTATIONS,
  describeOrientation,
  encodeDocuColor,
  orient,
  type DocuFields,
  type Matrix,
  type Orientation,
} from './_docucolor';
import { channelRegion } from './_channel';
import { computeSignal, detectDots } from './_printer-dots-detect';
import {
  estimateBasis,
  fitLattice,
  latticeFrom,
  latticeParams,
  searchWindows,
  shapesFor,
  type CellGrid,
} from './_printer-dots-grid';
import {
  printed,
  randomFields,
  renderScan,
  rng,
  SEP,
  single,
  staggered,
  textLines,
  type ScanSpec,
} from './_printer-dots-fixtures';
import docucolor from './docucolor';
import printerDots from './printer-dots';

// ---------- running the tool ----------

const defaults = Object.fromEntries(
  Object.entries(printerDots.options ?? {}).map(([k, spec]) => [k, spec.default]),
);

const run = (image: RgbaImage, options: Record<string, unknown> = {}) => {
  const input: ImageInput = { bytes: new Uint8Array(), name: 'synthetic.png', image };
  return printerDots.run(input, { ...defaults, ...options } as never) as Output[];
};
const kv = (out: Output[]) =>
  Object.fromEntries(out.flatMap((o) => (o.type === 'kv' ? o.entries : [])));
const notes = (out: Output[], level?: string) =>
  out.flatMap((o) => (o.type === 'note' && (!level || o.level === level) ? [o.text] : []));
const textBlock = (out: Output[]) => out.find((o) => o.type === 'text');
const fit = (out: Output[]) => {
  const p = /^([\d.]+) × ([\d.]+) px/.exec(kv(out)['Pitch'] ?? '');
  const r = /^(-?[\d.]+)°/.exec(kv(out)['Rotation'] ?? '');
  return p && r ? { px: Number(p[1]), py: Number(p[2]), rot: Number(r[1]) } : null;
};
/** The manual-grid options, all given. */
const manual = (pitch: number, rotation: number, ox: number, oy: number) => ({
  advanced: true,
  pitchX: pitch,
  autoRotation: false,
  rotation,
  autoOrigin: false,
  originX: ox,
  originY: oy,
});

interface Case {
  fields: DocuFields;
  printedAs: Orientation;
  pitch: number;
  rotation: number;
  image: RgbaImage;
  layout: string;
}

/** One random scan: page (tiled, with text) or tight crop (one tile). */
function makeCase(seed: number, forceTurn?: Orientation): Case {
  const r = rng(seed);
  const fields = randomFields(r);
  const tile = encodeDocuColor(fields, DEFAULT_MAPPING, SEP);
  const printedAs = forceTurn ?? ORIENTATIONS[Math.floor(r() * 8)]!;
  const pattern = orient(tile, printedAs);
  const pitch = 8 + r() * 16;
  const rotation = (r() * 2 - 1) * 4;
  const common = {
    pitch,
    rotation,
    noise: 1.5 + r() * 2.5,
    depth: 25 + r() * 10,
    radius: 0.2 + r() * 0.08,
    seed,
  };
  if (r() < 0.5) {
    // A page region: about 1.3 periods each way, staggered tiles at a random offset, some text.
    const cells = (n: number) => Math.min(Math.round(1400 / pitch), n);
    const W = Math.round(cells(64) * pitch);
    const H = Math.round(cells(44) * pitch);
    return {
      fields,
      printedAs,
      pitch,
      rotation,
      layout: 'page',
      image: renderScan({
        ...common,
        width: W,
        height: H,
        origin: [r() * pitch, r() * pitch],
        dotAt: staggered(pattern, Math.floor(r() * 32), Math.floor(r() * 16)),
        strokes: r() < 0.5 ? textLines(r, W * 0.1, H * 0.15, W * 0.8, H * 0.5) : [],
      }),
    };
  }
  const margin = 2 + r() * 2;
  const W = Math.round((pattern[0]!.length - 1 + 2 * margin) * pitch);
  const H = Math.round((pattern.length - 1 + 2 * margin) * pitch);
  return {
    fields,
    printedAs,
    pitch,
    rotation,
    layout: 'crop',
    image: renderScan({
      ...common,
      width: W,
      height: H,
      origin: [margin * pitch, margin * pitch],
      dotAt: single(pattern),
    }),
  };
}

// ---------- the proof: round trips ----------

describe('round trip: encode → synthetic scan → printer-dots → same values', () => {
  const turned180: Orientation = { rotate: 180, mirror: false };
  const cases = Array.from({ length: 24 }, (_, k) =>
    // Every fourth case is printed upside down (the usual way a page ends up on a scanner).
    makeCase(1000 + k, k % 4 === 1 ? turned180 : undefined),
  );

  it.each(cases.map((c, k) => [k, c] as const))('case %i', (_k, c) => {
    const out = run(c.image);
    const label = `${c.layout}, pitch ${c.pitch.toFixed(2)}, rot ${c.rotation.toFixed(2)}°, printed ${describeOrientation(c.printedAs)}`;
    expect(notes(out, 'error'), label).toEqual([]);
    expect(notes(out, 'success').join(' '), label).toMatch(/^Parity OK — high confidence/);
    const v = kv(out);
    expect(v['Printed'], label).toBe(printed(c.fields));
    expect(v['Serial'], label).toBe(c.fields.serial);
    expect(v['Parity'], label).toBe('OK');
    const g = fit(out)!;
    expect(Math.abs(g.px - c.pitch) / c.pitch, label).toBeLessThan(0.01);
    expect(Math.abs(g.py - c.pitch) / c.pitch, label).toBeLessThan(0.01);
    expect(Math.abs(g.rot - c.rotation), label).toBeLessThan(0.15);
  });

  it('covers every printed orientation, both layouts and the whole pitch range', () => {
    const seen = new Set(cases.map((c) => describeOrientation(c.printedAs)));
    expect(seen.size).toBe(8);
    expect(new Set(cases.map((c) => c.layout))).toEqual(new Set(['page', 'crop']));
    expect(Math.min(...cases.map((c) => c.pitch))).toBeLessThan(10);
    expect(Math.max(...cases.map((c) => c.pitch))).toBeGreaterThan(20);
  });

  it('the bit matrix it prints decodes identically in the DocuColor matrix tool', () => {
    const c = cases[3]!;
    const block = textBlock(run(c.image));
    expect(block?.type).toBe('text');
    const text = block?.type === 'text' ? block.value : '';
    const dc = docucolor.run(
      text,
      Object.fromEntries(
        Object.entries(docucolor.options ?? {}).map(([k, s]) => [k, s.default]),
      ) as never,
    ) as Output[];
    expect(resultToText(dc)).toContain(`Printed: ${printed(c.fields)}`);
    expect(resultToText(dc)).toContain(`Serial: ${c.fields.serial}`);
  });
});

// ---------- failure modes: frank, never a confident wrong answer ----------

describe('failure modes', () => {
  const fields: DocuFields = {
    year: 2021,
    month: 6,
    day: 30,
    hour: 23,
    minute: 59,
    serial: '20251014',
  };
  const tile = encodeDocuColor(fields, DEFAULT_MAPPING, SEP);
  const crop = (pattern: Matrix, seed = 5, extra: Partial<ScanSpec> = {}) =>
    renderScan({
      width: 19 * 14,
      height: 12 * 14,
      pitch: 14,
      origin: [2 * 14, 2 * 14],
      rotation: 1.5,
      dotAt: single(pattern),
      noise: 2.5,
      depth: 30,
      radius: 0.25,
      seed,
      ...extra,
    });

  it('no dots: a clear error, no reading', () => {
    const r = rng(3);
    const blank = renderScan({
      width: 600,
      height: 400,
      pitch: 12,
      origin: [0, 0],
      rotation: 0,
      dotAt: () => false,
      noise: 3,
      depth: 30,
      radius: 0.25,
      strokes: textLines(r, 40, 40, 560, 360),
      seed: 3,
    });
    const out = run(blank);
    expect(notes(out, 'error').join(' ')).toMatch(/No tracking dots found/);
    expect(notes(out, 'success')).toEqual([]);
    expect(kv(out)['Printed']).toBeUndefined();
    // The reveal and the statistics are still shown, so the user can adjust the options.
    expect(out.some((o) => o.type === 'image')).toBe(true);
    expect(kv(out)['Dot threshold']).toMatch(/auto/);
  });

  it('a page of plain grey text gives no reading either', () => {
    const r = rng(9);
    const out = run(
      renderScan({
        width: 800,
        height: 500,
        pitch: 12,
        origin: [0, 0],
        rotation: 1,
        dotAt: () => false,
        noise: 2,
        depth: 30,
        radius: 0.25,
        strokes: textLines(r, 20, 20, 780, 480),
        seed: 9,
      }),
    );
    expect(notes(out, 'success')).toEqual([]);
    expect(kv(out)['Printed'] ?? '').not.toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  });

  it('every single corrupted dot (all 120 cells, the corner too): FAILED, labelled as a guess', () => {
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 15; col++) {
        const bad = tile.map((line, i) => line.map((v, j) => (i === row && j === col ? !v : v)));
        const out = run(crop(bad, 100 + row * 15 + col));
        const label = `flipped row ${row + 1}, column ${col + 1}`;
        expect(notes(out, 'success'), label).toEqual([]);
        expect(notes(out, 'error').join(' '), label).toMatch(
          /^Parity FAILED in .* — tried all 8 orientations; the reading is uncertain\./,
        );
        const v = kv(out);
        expect(v['Printed'], label).toMatch(/\(guess — parity failed\)$/);
        expect(v['Serial'], label).toMatch(/\(guess — parity failed\)$/);
        expect(v['Parity'], label).toMatch(/^FAILED/);
        // The single-dot hypothesis is offered as such, and it is the true reading.
        const hint = notes(out, 'warn').join(' ');
        expect(hint, label).toMatch(/hypothesis, not a reading/);
        expect(hint, label).toContain(`${printed(fields)}, serial ${fields.serial}`);
      }
    }
  }, 60_000);

  it('a parity-valid tile with impossible values does not beat a damaged real tile', () => {
    // Tile A is real but one dot is misprinted; tile B passes parity but reads month 14 (set by
    // hand, then the parity redone with the EFF rules: rows 2-8 and every column odd).
    const a = tile.map((line, i) => line.map((v, j) => (i === 4 && j === 6 ? !v : v)));
    const b = tile.map((line) => [...line]);
    for (let bit = 0; bit < 7; bit++) b[1 + bit]![6] = ((14 >> (6 - bit)) & 1) === 1;
    for (let r = 1; r < 8; r++) b[r]![0] = b[r]!.slice(1).filter(Boolean).length % 2 === 0;
    for (let c = 0; c < 15; c++) b[0]![c] = b.slice(1).filter((row) => row[c]).length % 2 === 0;
    const two = (c: number, r: number) =>
      (r >= 0 && r < 8 && c >= 0 && c < 15 && a[r]![c]!) ||
      (r >= 0 && r < 8 && c >= 20 && c < 35 && b[r]![c - 20]!);
    const out = run(
      renderScan({
        width: 40 * 14,
        height: 12 * 14,
        pitch: 14,
        origin: [2 * 14, 2 * 14],
        rotation: 0.5,
        dotAt: two,
        noise: 2,
        depth: 30,
        radius: 0.25,
        seed: 77,
      }),
    );
    expect(notes(out, 'success')).toEqual([]);
    expect(notes(out, 'error').join(' ')).toMatch(/^Parity FAILED/);
    const warns = notes(out, 'warn').join(' ');
    expect(warns).toMatch(/reads? impossible values .*grid structure, not a tile/);
    expect(warns).toContain(`${printed(fields)}, serial ${fields.serial}`);
  });

  it('a fixed grid over an empty area says so', () => {
    const blank = renderScan({
      width: 300,
      height: 200,
      pitch: 12,
      origin: [0, 0],
      rotation: 0,
      dotAt: () => false,
      noise: 1,
      depth: 30,
      radius: 0.25,
      seed: 8,
    });
    const out = run(blank, manual(12, 0, 30, 30));
    expect(notes(out, 'error').join(' ')).toMatch(
      /Every 15 × 8 window of the fitted grid is empty/,
    );
    expect(notes(out, 'success')).toEqual([]);
  });

  it('one corrupted copy among many: the clean copies decide, the bad one is reported', () => {
    const pattern = orient(tile, { rotate: 0, mirror: false });
    const good = staggered(pattern, 3, 2);
    // With that offset, page rows 6-13 form an odd band whose tile spans page columns 13-27.
    // Flip the dot at tile row 4, column 6 of that copy only.
    const dotAt = (c: number, r: number) => (c === 18 && r === 9 ? !good(c, r) : good(c, r));
    expect(good(13, 6)).toBe(pattern[0]![0]);
    expect(good(18, 9)).toBe(pattern[3]![5]);
    const out = run(
      renderScan({
        width: 70 * 12,
        height: 40 * 12,
        pitch: 12,
        origin: [6, 6],
        rotation: -2.5,
        dotAt,
        noise: 2,
        depth: 28,
        radius: 0.25,
        seed: 12,
      }),
    );
    expect(notes(out, 'success').join(' ')).toMatch(/Parity OK — high confidence/);
    expect(kv(out)['Printed']).toBe(printed(fields));
    expect(kv(out)['Tile copies']).toMatch(/\d+ identical, [1-9]\d* more with 1–3 differing dots/);
  });

  it('a wrong forced orientation is shown as forced and never as a confident reading', () => {
    const img = crop(tile);
    for (const key of ['m0', 'r180', 'm180']) {
      const out = run(img, { advanced: true, orientation: key });
      expect(notes(out, 'success'), key).toEqual([]);
      expect(kv(out)['Orientation'], key).toMatch(/\(forced\)$/);
      expect(kv(out)['Printed'], key).toMatch(/\((guess — parity failed|not plausible)\)$/);
    }
    // The right one, forced, reads as well as auto.
    expect(kv(run(img, { advanced: true, orientation: 'r0' }))['Printed']).toBe(printed(fields));
  });

  it('a wrong manual pitch fails parity instead of inventing a date', () => {
    const out = run(crop(tile), { advanced: true, pitchX: 17.5 });
    expect(notes(out, 'success')).toEqual([]);
    expect(kv(out)['Pitch']).toBe('17.50 × 17.50 px (manual)');
  });
});

// ---------- manual overrides ----------

describe('manual overrides', () => {
  const fields: DocuFields = {
    year: 2012,
    month: 12,
    day: 21,
    hour: 11,
    minute: 11,
    serial: '00042424',
  };
  const tile = encodeDocuColor(fields, DEFAULT_MAPPING, SEP);
  const P = 15;
  const img = renderScan({
    width: 21 * P,
    height: 14 * P,
    pitch: P,
    origin: [3 * P, 3 * P],
    rotation: 0,
    dotAt: single(tile),
    noise: 2,
    depth: 30,
    radius: 0.25,
    seed: 21,
  });

  it('pitch, rotation and origin are used exactly as given', () => {
    const out = run(img, manual(15, 0, 3 * P, 3 * P));
    expect(kv(out)['Printed']).toBe(printed(fields));
    expect(kv(out)['Pitch']).toBe('15.00 × 15.00 px (manual)');
    expect(kv(out)['Rotation']).toBe('0.00° (manual)');
    expect(kv(out)['Origin']).toMatch(/^\(45\.0, 45\.0\) .*\(manual\)$/);
    // With a fixed origin there is no search: one position per window shape.
    expect(kv(out)['Tile copies']).toBeUndefined();
  });

  it('a pitch given for one axis only is kept as given (the other is measured)', () => {
    const out = run(img, { advanced: true, pitchY: 15.4 });
    const g = fit(out)!;
    expect(g.py).toBe(15.4);
    expect(Math.abs(g.px - 15)).toBeLessThan(0.1);
    expect(kv(out)['Pitch']).toMatch(/× 15\.40 px \(manual\)/);
  });

  it('an origin one cell off is honoured — and therefore fails parity', () => {
    const out = run(img, manual(15, 0, 4 * P, 3 * P));
    expect(notes(out, 'success')).toEqual([]);
    expect(kv(out)['Origin']).toMatch(/^\(60\.0, 45\.0\)/);
  });

  it('origin (0, 0) can be set by hand (auto origin off)', () => {
    const out = run(img, manual(15, 0, 0, 0));
    expect(kv(out)['Origin']).toMatch(/^\(0\.0, 0\.0\) .*\(manual\)$/);
    expect(notes(out, 'success')).toEqual([]);
  });

  it('rotation is a number; out-of-range values are clamped with a warning, never an error', () => {
    const out = run(img, { advanced: true, autoRotation: false, rotation: 0 });
    expect(kv(out)['Rotation']).toBe('0.00° (manual)');
    expect(kv(out)['Printed']).toBe(printed(fields));
    const far = run(img, { advanced: true, autoRotation: false, rotation: 60 });
    expect(notes(far, 'warn').join(' ')).toMatch(/Rotation 60° is outside ±45° and was clamped/);
    expect(kv(far)['Rotation']).toBe('45.00° (manual)');
    // A half-typed number reaches the tool as NaN or 0: never a red error that blanks the output.
    expect(kv(run(img, { advanced: true, autoRotation: false, rotation: NaN }))['Rotation']).toBe(
      '0.00° (manual)',
    );
    // With Auto rotation on, the value is not used.
    expect(fit(run(img, { advanced: true, rotation: 30 }))!.rot).toBeCloseTo(0, 1);
  });

  it('a manual dot threshold is applied and reported', () => {
    const out = run(img, { threshold: 10 });
    expect(kv(out)['Dot threshold']).toBe('10 levels above the local paper (manual)');
    expect(kv(out)['Printed']).toBe(printed(fields));
  });

  it('the column mapping is honoured (minute and hour columns swapped)', () => {
    const out = run(img, { advanced: true, minuteCol: 5, hourCol: 2 });
    expect(kv(out)['Printed']).toBe('2012-12-21 11:11');
    const swapped = encodeDocuColor({ ...fields, minute: 7, hour: 19 }, DEFAULT_MAPPING, SEP);
    const img2 = renderScan({
      width: 21 * P,
      height: 14 * P,
      pitch: P,
      origin: [3 * P, 3 * P],
      rotation: 0,
      dotAt: single(swapped),
      noise: 2,
      depth: 30,
      radius: 0.25,
      seed: 22,
    });
    expect(kv(run(img2))['Printed']).toBe('2012-12-21 19:07');
    expect(kv(run(img2, { advanced: true, minuteCol: 5, hourCol: 2 }))['Printed']).toBe(
      '2012-12-21 07:19',
    );
    // Hidden options do not count: without "Manual grid and column mapping" the EFF mapping holds.
    expect(kv(run(img2, { minuteCol: 5, hourCol: 2 }))['Printed']).toBe('2012-12-21 19:07');
  });

  it('even parity is a setting, not a guess', () => {
    const even = encodeDocuColor(fields, DEFAULT_MAPPING, SEP, false);
    const img2 = renderScan({
      width: 21 * P,
      height: 14 * P,
      pitch: P,
      origin: [3 * P, 3 * P],
      rotation: 1,
      dotAt: single(even),
      noise: 2,
      depth: 30,
      radius: 0.25,
      seed: 23,
    });
    expect(notes(run(img2), 'success')).toEqual([]);
    const out = run(img2, { advanced: true, parity: 'even' });
    expect(notes(out, 'success').join(' ')).toMatch(/even number of dots/);
    expect(kv(out)['Printed']).toBe(printed(fields));
  });

  it('the region crop limits the analysis', () => {
    const out = run(img, { cropX: 2 * P, cropY: 2 * P, cropW: 17 * P, cropH: 10 * P });
    expect(kv(out)['Region']).toBe(`${17 * P}×${10 * P} px at (${2 * P}, ${2 * P}) of 315×210`);
    expect(kv(out)['Printed']).toBe(printed(fields));
    // Too small for a tile: said so.
    const tiny = run(img, { cropX: 3 * P, cropY: 3 * P, cropW: 8 * P, cropH: 5 * P });
    expect(notes(tiny, 'success')).toEqual([]);
    expect(() => run(img, { cropX: 5000 })).toThrow(ToolError);
  });

  it('reveal options: yellow channel without inversion, plain (not ink-only) channel', () => {
    expect(kv(run(img, { channel: 'y', invert: false }))['Printed']).toBe(printed(fields));
    expect(kv(run(img, { channel: 'y', invert: true }))['Printed']).toBe(printed(fields));
    expect(kv(run(img, { inkOnly: false }))['Printed']).toBe(printed(fields));
    // The red channel carries nothing: no reading.
    expect(notes(run(img, { channel: 'r' }), 'success')).toEqual([]);
  });

  it('other tile sizes show the bits without decoding (never green)', () => {
    const out = run(img, { advanced: true, cols: 10, rows: 6 });
    expect(notes(out).join(' ')).toMatch(
      /Without the DocuColor 15 × 8 layout this is structure only|No 10 × 6 window passes odd parity/,
    );
    expect(notes(out, 'success')).toEqual([]);
    expect(kv(out)['Printed']).toBeUndefined();
    expect(textBlock(out)?.type).toBe('text');
    // A half-typed size (1 on the way to 15) falls back to 15 × 8 with a warning.
    const typing = run(img, { advanced: true, cols: 1 });
    expect(notes(typing, 'warn').join(' ')).toMatch(/Tile size 1 × 8 ignored/);
    expect(kv(typing)['Printed']).toBe(printed(fields));
  });

  it('zoom: automatic about 24 px per cell, or as asked', () => {
    const pic = (out: Output[]) => {
      const o = out.find((b) => b.type === 'image');
      return o?.type === 'image' ? o.image : null;
    };
    const auto = pic(run(img))!;
    expect(auto.width).toBe(img.width * 2); // 15 px pitch → ×2 = 30 px per cell
    const z3 = pic(run(img, { zoom: 3 }))!;
    expect(z3.width).toBe(img.width * 3);
  });
});

// ---------- output layout ----------

describe('output', () => {
  const fields: DocuFields = { year: 2008, month: 3, day: 9, hour: 6, minute: 30, serial: '777' };
  const tile = encodeDocuColor(fields, DEFAULT_MAPPING, SEP);
  const img = renderScan({
    width: 20 * 12,
    height: 13 * 12,
    pitch: 12,
    origin: [30, 30],
    rotation: -1,
    dotAt: single(tile),
    noise: 2,
    depth: 30,
    radius: 0.25,
    seed: 31,
  });

  it('comes in the documented order: verdict, answer, notes, picture, details, tables', () => {
    const out = run(img);
    const kinds = out.map((o) =>
      o.type === 'note' ? `note:${o.level}` : o.type === 'kv' ? `kv:${o.label ?? ''}` : o.type,
    );
    expect(kinds).toEqual([
      'note:success',
      'kv:',
      'note:info',
      'image',
      'kv:Grid fit',
      'table',
      'table',
      'text',
      'kv:Channel statistics',
    ]);
    expect(notes(out, 'info')[0]).toBe('Processed locally — nothing uploaded.');
    expect(Object.keys(kv(out)).slice(0, 4)).toEqual([
      'Printed',
      'Serial',
      'Parity',
      'Orientation',
    ]);
    expect(kv(out)['Serial']).toBe('00000777');
    const tables = out.filter((o) => o.type === 'table');
    expect(tables[0]?.type === 'table' && tables[0].columns.slice(0, 4)).toEqual([
      'Col',
      'Field',
      'Bits',
      'Value',
    ]);
    expect(tables[1]?.type === 'table' && tables[1].rows.length).toBe(8);
  });

  it('the overlay marks dots (green rings) and the tile window (cyan lines)', () => {
    const o = run(img).find((b) => b.type === 'image');
    const image = o?.type === 'image' ? o.image : null;
    expect(image).not.toBeNull();
    let green = 0;
    let cyan = 0;
    let orange = 0;
    const d = image!.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 40 && d[i + 1] === 230 && d[i + 2] === 90) green++;
      if (d[i] === 0 && d[i + 1] === 210 && d[i + 2] === 255) cyan++;
      if (d[i] === 255 && d[i + 1] === 150 && d[i + 2] === 0) orange++;
    }
    expect(green).toBeGreaterThan(100);
    expect(cyan).toBeGreaterThan(100);
    expect(orange).toBeGreaterThan(10);
  });
});

// ---------- building blocks ----------

describe('helpers', () => {
  it('ink-only removes grey ink and keeps yellow ink', () => {
    const img: RgbaImage = {
      width: 3,
      height: 1,
      data: new Uint8ClampedArray([240, 240, 240, 255, 60, 60, 60, 255, 240, 238, 205, 255]),
    };
    const rect = { x: 0, y: 0, w: 3, h: 1 };
    expect([...channelRegion(img, 'b', rect, true)]).toEqual([255, 255, 222]);
    expect([...channelRegion(img, 'y', rect, true)]).toEqual([0, 0, 33]);
    expect([...channelRegion(img, 'b', rect, false)]).toEqual([240, 60, 205]);
    expect([...channelRegion(img, 'luma', rect, true)]).toEqual([240, 60, 235]);
  });

  it('estimates and fits an exact lattice from its points', () => {
    const truth = latticeFrom({ pitchX: 11, pitchY: 13, rotation: -3 }, 50, 40);
    const r = rng(4);
    const pts = [];
    for (let j = 0; j < 20; j++)
      for (let i = 0; i < 30; i++)
        if (r() < 0.4)
          pts.push({ x: 50 + i * truth.ax + j * truth.bx, y: 40 + i * truth.ay + j * truth.by });
    const est = estimateBasis(pts)!;
    expect(est.rotation).toBeCloseTo(-3, 0);
    const f = fitLattice(pts, latticeFrom(est, 0, 0), true);
    const p = latticeParams(f.lattice);
    expect(p.pitchX).toBeCloseTo(11, 6);
    expect(p.pitchY).toBeCloseTo(13, 6);
    expect(p.rotation).toBeCloseTo(-3, 6);
    expect(f.inliers).toBe(pts.length);
  });

  it('the window search finds a tile placed in a grid, in its orientation', () => {
    const tile = encodeDocuColor(
      { year: 2030, month: 1, day: 2, hour: 3, minute: 4, serial: '1234' },
      DEFAULT_MAPPING,
      SEP,
    );
    const placed = orient(tile, { rotate: 90, mirror: true });
    const w = 20;
    const h = 22;
    const cells = new Uint8Array(w * h);
    placed.forEach((row, y) => row.forEach((v, x) => (cells[(y + 4) * w + x + 6] = v ? 1 : 0)));
    const grid: CellGrid = { i0: 0, j0: 0, w, h, cells };
    const shapes = shapesFor(8, 15);
    const res = searchWindows(
      grid,
      shapes,
      shapes.map(() => true),
      true,
    );
    const hits = res.passing.map((hit) => ({ ...hit, o: shapes[hit.shape]!.orientation }));
    // The inverse of "mirror, then turn 90°" is itself: that is what reads the tile back.
    expect(hits).toContainEqual(
      expect.objectContaining({ x: 6, y: 4, o: { rotate: 90, mirror: true }, errors: 0 }),
    );
  });

  it('detects nothing on a flat page and reports a sane threshold', () => {
    const flat: RgbaImage = {
      width: 50,
      height: 40,
      data: new Uint8ClampedArray(50 * 40 * 4).fill(240),
    };
    const sig = computeSignal(flat, { x: 0, y: 0, w: 50, h: 40 }, 'b', true);
    const det = detectDots(sig, 0);
    expect(det.dots).toEqual([]);
    expect(det.threshold).toBeGreaterThan(0);
  });
});

// ---------- speed ----------

describe('performance', () => {
  it('3000 × 4000 scan: auto fit on a 1200 × 1200 region stays under 3 s', () => {
    const fields: DocuFields = {
      year: 2017,
      month: 9,
      day: 14,
      hour: 16,
      minute: 45,
      serial: '86420975',
    };
    const pattern = orient(encodeDocuColor(fields, DEFAULT_MAPPING, SEP), {
      rotate: 180,
      mirror: false,
    });
    const big = renderScan({
      width: 3000,
      height: 4000,
      pitch: 12,
      origin: [5, 5],
      rotation: 1.2,
      dotAt: staggered(pattern, 0, 0),
      noise: 2,
      depth: 30,
      radius: 0.25,
      supersample: 1,
      seed: 99,
    });
    const t0 = performance.now();
    const out = run(big, { cropX: 900, cropY: 1400, cropW: 1200, cropH: 1200 });
    const regionMs = performance.now() - t0;
    expect(kv(out)['Printed']).toBe(printed(fields));
    // Generous on purpose (a slow CI runner must not flake): the budget only catches a blow-up.
    expect(regionMs).toBeLessThan(3000);
  }, 60_000);
});
