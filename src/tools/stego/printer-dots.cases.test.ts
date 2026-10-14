/**
 * Every case the independent reviewers ran against "Printer tracking dots", kept as a regression
 * test. Each page is synthetic (_printer-dots-fixtures.ts), drawn from a tile the encoder builds,
 * so the expected date and serial are known exactly.
 *
 * Two kinds of expectation, as the reviewers wrote them:
 *  - exact: a green "high confidence" verdict with exactly the encoded date and serial;
 *  - honest: never a confident wrong answer — when the verdict is green, it must be exact.
 */
import { encode as encodePng } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { prepareInput } from '../../core/prepare';
import { resultToText } from '../../core/result-text';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MAPPING,
  ORIENTATIONS,
  bestOrientations,
  decodeDocuColor,
  describeOrientation,
  encodeDocuColor,
  orient,
  type DocuFields,
  type Matrix,
  type Orientation,
} from './_docucolor';
import { detectCached } from './_printer-dots-detect';
import {
  OFF_WHITE,
  printed,
  randomFields,
  renderScan,
  rng,
  SEP,
  single,
  staggered,
  textLines,
  tiled,
  type ScanSpec,
} from './_printer-dots-fixtures';
import { renderOverlay } from './_printer-dots-overlay';
import channelReveal from './channel-reveal';
import docucolor from './docucolor';
import printerDots from './printer-dots';

// ---------- running and judging ----------

const defaults = Object.fromEntries(
  Object.entries(printerDots.options ?? {}).map(([k, spec]) => [k, spec.default]),
);
const run = (image: RgbaImage, options: Record<string, unknown> = {}) =>
  printerDots.run({ bytes: new Uint8Array(), name: 'synthetic.png', image } satisfies ImageInput, {
    ...defaults,
    ...options,
  } as never) as Output[];
const kv = (out: Output[]) =>
  Object.fromEntries(out.flatMap((o) => (o.type === 'kv' ? o.entries : [])));
const notes = (out: Output[], level?: string) =>
  out.flatMap((o) => (o.type === 'note' && (!level || o.level === level) ? [o.text] : []));

type Status = 'sure' | 'ambiguous' | 'implausible' | 'failed' | 'none';

function status(out: Output[]): Status {
  const first = out[0];
  if (first?.type !== 'note') return 'none';
  if (first.level === 'success' && first.text.startsWith('Parity OK — high confidence'))
    return 'sure';
  if (first.level === 'warn' && /different readings pass parity/.test(first.text))
    return 'ambiguous';
  if (first.level === 'warn' && first.text.startsWith('Parity OK, but the values'))
    return 'implausible';
  if (first.level === 'error' && first.text.startsWith('Parity FAILED')) return 'failed';
  return 'none';
}

/** Green, and exactly the encoded values. */
function expectExact(out: Output[], f: DocuFields, label: string) {
  const v = kv(out);
  expect(
    { status: status(out), printed: v['Printed'], serial: v['Serial'] },
    `${label}: ${out[0]?.type === 'note' ? out[0].text : ''}`,
  ).toEqual({ status: 'sure', printed: printed(f), serial: f.serial });
}

/** Never a confident wrong answer; returns the status for further checks. */
function expectHonest(out: Output[], f: DocuFields, label: string): Status {
  const s = status(out);
  if (s === 'sure') expectExact(out, f, label);
  // A success note anywhere means the verdict above was green: nothing else may be green.
  if (s !== 'sure') expect(notes(out, 'success'), label).toEqual([]);
  return s;
}

/** The candidates table of an ambiguous verdict, as "date serial" strings. */
const candidates = (out: Output[]) => {
  const t = out.find((o) => o.type === 'table' && o.label?.startsWith('Readings that pass'));
  return t?.type === 'table' ? t.rows.map((r) => `${r[0]} ${r[1]}`) : [];
};

// ---------- pages ----------

interface PageSpec extends Partial<ScanSpec> {
  width: number;
  height: number;
}

/** Staggered DocuColor tiles over a page, encoded from `f`, printed in orientation `as`. */
function page(f: DocuFields, spec: PageSpec, as: Orientation = { rotate: 0, mirror: false }) {
  const tile = orient(encodeDocuColor(f, DEFAULT_MAPPING, SEP), as);
  return renderScan({
    pitch: 12,
    origin: [6, 6],
    rotation: 0,
    noise: 2,
    depth: 40,
    radius: 1 / 6,
    seed: 1,
    dotAt: staggered(tile, 3, 2),
    ...spec,
  });
}

const F1: DocuFields = { year: 2023, month: 7, day: 19, hour: 21, minute: 46, serial: '90817263' };
const F2: DocuFields = { year: 2011, month: 2, day: 8, hour: 5, minute: 3, serial: '00316624' };

// ---------- format fidelity ----------

describe('format fidelity, through a real PNG', () => {
  // The reviewers' hand-made tile (2007-06-23 19:41, serial 40179362), checked against DEDA.
  const hand: DocuFields = {
    year: 2007,
    month: 6,
    day: 23,
    hour: 19,
    minute: 41,
    serial: '40179362',
  };
  const tile = encodeDocuColor(hand, DEFAULT_MAPPING, SEP);

  /** Encode to PNG and decode it back as the app does (exact pixels). */
  async function viaPng(img: RgbaImage): Promise<RgbaImage> {
    const bytes = encodePng({ width: img.width, height: img.height, data: img.data, channels: 4 });
    const input = (await prepareInput('image', { bytes, name: 'scan.png' })) as ImageInput;
    return input.image;
  }
  const scan = (pattern: Matrix, extra: Partial<ScanSpec> = {}) =>
    renderScan({
      width: Math.round((pattern[0]!.length + 4) * 12),
      height: Math.round((pattern.length + 4) * 12),
      pitch: 12,
      origin: [24, 24],
      rotation: 0,
      dotAt: single(pattern),
      noise: 1.5,
      depth: 45, // blue 240 -> about 195, as the reviewers drew it
      radius: 0.2,
      seed: 3,
      ...extra,
    });

  it.each([
    ['as given', { rotate: 0, mirror: false }],
    ['mirrored (parity column on the right, as DEDA draws it)', { rotate: 0, mirror: true }],
    ['turned 180°', { rotate: 180, mirror: false }],
    ['turned 90°', { rotate: 90, mirror: false }],
    ['mirrored then turned 90°', { rotate: 90, mirror: true }],
  ] as const)('the hand tile %s decodes exactly', async (label, o) => {
    expectExact(run(await viaPng(scan(orient(tile, o)))), hand, label);
  });

  it('three copies with gaps decode exactly', async () => {
    const three = (c: number, r: number) =>
      r >= 0 && r < 8 && c >= 0 && c % 17 < 15 && c < 49 && tile[r]![c % 17]!;
    const img = renderScan({
      width: 53 * 12,
      height: 12 * 12,
      pitch: 12,
      origin: [24, 24],
      rotation: 0.4,
      dotAt: three,
      noise: 1.5,
      depth: 45,
      radius: 0.2,
      seed: 4,
    });
    const out = run(await viaPng(img));
    expectExact(out, hand, '3 copies');
    expect(kv(out)['Tile copies']).toMatch(/^3 identical/);
  });

  it('a flipped corner dot (column 1 parity) is caught, never green', async () => {
    const bad = tile.map((row, i) => row.map((v, j) => (i === 0 && j === 0 ? !v : v)));
    const out = run(await viaPng(scan(bad)));
    expect(status(out)).toBe('failed');
    expect(kv(out)['Parity']).toBe('FAILED (column 1)');
    expect(notes(out, 'warn').join(' ')).toContain(
      'with row 1, column 1 flipped, parity passes and the tile reads 2007-06-23 19:41, serial 40179362',
    );
  });

  it.each([
    [98, 1998],
    [69, 1969],
    [68, 2068],
  ])('year column %i reads %i (century closest to 2018, as DEDA)', (yy, year) => {
    const f = { ...hand, year };
    const out = run(scan(encodeDocuColor(f, DEFAULT_MAPPING, SEP)));
    expectExact(out, f, `year ${yy}`);
    expect(decodeDocuColor(encodeDocuColor(f, DEFAULT_MAPPING, SEP)).columns[7]!.value).toBe(yy);
  });

  it('the century can be forced (advanced)', () => {
    const f = { ...hand, year: 1998 };
    const img = scan(encodeDocuColor(f, DEFAULT_MAPPING, SEP));
    expect(kv(run(img, { advanced: true, century: '2000' }))['Printed']).toBe('2098-06-23 19:41');
    expect(notes(run(img, { advanced: true, century: '2000' }), 'info').join(' ')).toContain(
      'Custom column mapping (century always 20xx)',
    );
  });

  it('channel reveal: blue, inverted, auto: dot cells clearly brighter than empty ones', async () => {
    const img = await viaPng(scan(tile));
    const cr = Object.fromEntries(
      Object.entries(channelReveal.options ?? {}).map(([k, s]) => [k, s.default]),
    );
    const out = channelReveal.run({ bytes: new Uint8Array(), image: img }, cr as never) as Output[];
    const pic = out.find((o) => o.type === 'image');
    if (pic?.type !== 'image') throw new Error('image expected');
    const at = (c: number, r: number) =>
      pic.image.data[((24 + 12 * r) * pic.image.width + 24 + 12 * c) * 4]!;
    const on: number[] = [];
    const off: number[] = [];
    tile.forEach((row, r) => row.forEach((v, c) => (v ? on : off).push(at(c, r))));
    expect(Math.min(...on)).toBeGreaterThan(Math.max(...off) + 100);
  });
});

// ---------- geometry ----------

describe('geometry', () => {
  it.each([
    ['baseline pitch 12, rotation 0', { width: 600, height: 400 }],
    ['rotation +8°', { width: 700, height: 500, rotation: 8 }],
    ['rotation -8°, pitch 14', { width: 800, height: 550, rotation: -8, pitch: 14 }],
    ['rotation -7°, pitch 10', { width: 640, height: 420, rotation: -7, pitch: 10, radius: 0.25 }],
    [
      'rotation -5.2°, pitch 16',
      { width: 760, height: 520, rotation: -5.2, pitch: 16, radius: 0.2 },
    ],
    [
      'rotation -3°, pitch 13, noise 3',
      { width: 700, height: 460, rotation: -3, pitch: 13, noise: 3 },
    ],
    ['rotation +3.7°, pitch 11', { width: 600, height: 420, rotation: 3.7, pitch: 11 }],
    [
      'rotation +6°, pitch 15, noise 3',
      { width: 760, height: 520, rotation: 6, pitch: 15, noise: 3 },
    ],
    [
      'pitch 6, dot radius 1 px',
      { width: 450, height: 300, pitch: 6, radius: 1 / 6, rotation: 1.5, depth: 60 },
    ],
    [
      'pitch 30, dot radius 4 px',
      { width: 1300, height: 800, pitch: 30, radius: 4 / 30, rotation: -2 },
    ],
    [
      'pitch 30, dot radius 1 px',
      { width: 1350, height: 900, pitch: 30, radius: 1 / 30, rotation: 8, depth: 80 },
    ],
    ['non-integer pitch 11.81', { width: 600, height: 400, pitch: 11.81, rotation: 0.6 }],
    [
      'anisotropic 12 × 12.5 (scanner stretch)',
      { width: 600, height: 420, pitchY: 12.5, rotation: 0.8 },
    ],
  ] as const)('%s: exact', (label, spec) => {
    expectExact(run(page(F1, { seed: label.length, ...spec })), F1, label);
  });

  it.each([
    ['rotation +12° (beyond the usual)', { width: 750, height: 550, rotation: 12 }],
    ['rotation -20°', { width: 800, height: 650, rotation: -20 }],
    [
      'pitch 8, dots nearly touching (radius 3.5 px)',
      { width: 500, height: 350, pitch: 8, radius: 3.5 / 8, rotation: 1 },
    ],
  ] as const)('%s: honest', (label, spec) => {
    expectHonest(run(page(F1, { seed: 7, ...spec })), F1, label);
  });

  it.each(ORIENTATIONS.map((o) => [describeOrientation(o), o] as const))(
    'printed %s: exact through auto orientation',
    (label, o) => {
      expectExact(
        run(page(F2, { width: 640, height: 640, rotation: 2, noise: 3, seed: 11 }, o)),
        F2,
        label,
      );
    },
  );

  it('no separator column, upside down: exact', () => {
    const tile = orient(encodeDocuColor(F2, DEFAULT_MAPPING), { rotate: 180, mirror: false });
    const img = renderScan({
      width: 640,
      height: 420,
      pitch: 12,
      origin: [6, 6],
      rotation: 2,
      dotAt: staggered(tile, 1, 1),
      noise: 2,
      depth: 40,
      radius: 1 / 6,
      seed: 12,
    });
    expectExact(run(img), F2, 'no separator');
  });

  it('a sparse tile (2000-01-01 00:00, serial 00000001, no separator): exact', () => {
    const f: DocuFields = { year: 2000, month: 1, day: 1, hour: 0, minute: 0, serial: '00000001' };
    const tile = encodeDocuColor(f, DEFAULT_MAPPING);
    const img = renderScan({
      width: 640,
      height: 420,
      pitch: 12,
      origin: [6, 6],
      rotation: 1,
      dotAt: staggered(tile, 0, 0),
      noise: 2,
      depth: 40,
      radius: 1 / 6,
      seed: 13,
    });
    expectExact(run(img), f, 'sparse');
  });

  it('many staggered tiles (period 20 × 12 cells, stagger 7, 2.5°): exact', () => {
    const tile = encodeDocuColor(F1, DEFAULT_MAPPING, SEP);
    const img = renderScan({
      width: 1400,
      height: 800,
      pitch: 12,
      origin: [6, 6],
      rotation: 2.5,
      dotAt: tiled(tile, 2, 1, 20, 7, 12),
      noise: 2,
      depth: 40,
      radius: 1 / 6,
      supersample: 1,
      seed: 14,
    });
    const out = run(img);
    expectExact(out, F1, 'many tiles');
    expect(Number(/^(\d+) identical/.exec(kv(out)['Tile copies'] ?? '')?.[1])).toBeGreaterThan(10);
  });
});

// ---------- signal quality ----------

describe('signal quality', () => {
  const base = { width: 600, height: 400, rotation: 1 };
  it.each([
    ['gaussian noise sigma 8', { noise: 8, depth: 50 }],
    ['JPEG-like (2 × 2 chroma, quantized chroma, blur 0.8)', { chromaStep: 4, blur: 0.8 }],
    [
      'JPEG-like, pitch 9, 2.3°, noise 4',
      { chromaStep: 4, blur: 0.8, pitch: 9, radius: 1.5 / 9, rotation: 2.3, noise: 4 },
    ],
    ['gaussian blur sigma 1.5', { blur: 1.5, depth: 50 }],
    ['faint dots: 12 levels of blue, noise 2', { depth: 12, noise: 2 }],
    [
      'strong saturated dots (blue −230), pitch 14, 4°',
      { depth: 230, radius: 3 / 14, pitch: 14, rotation: 4 },
    ],
  ] as const)('%s: exact', (label, spec) => {
    expectExact(run(page(F1, { seed: 21, ...base, ...spec })), F1, label);
  });

  it.each([
    ['gaussian noise sigma 14', { noise: 14, depth: 60 }],
    ['extreme noise sigma 25', { noise: 25, depth: 40 }],
    ['faint 12 + JPEG-like + noise 4', { depth: 12, noise: 4, chromaStep: 4, blur: 0.8 }],
  ] as const)('%s: honest', (label, spec) => {
    expectHonest(run(page(F1, { seed: 22, ...base, ...spec })), F1, label);
  });
});

// ---------- page content ----------

describe('page content', () => {
  const vignette =
    (w: number, h: number, depthBlue: number, strength: number) => (x: number, y: number) => {
      const d = Math.hypot((x - w / 2) / (w / 2), (y - h / 2) / (h / 2)) / Math.SQRT2;
      const v = 1 - strength * d * d;
      const [r, g, b] = OFF_WHITE;
      const tint = (depthBlue * (x / w + y / h)) / 2;
      return [r * v, g * v, (b - tint) * v] as [number, number, number];
    };

  it.each([
    ['blue tint −30 levels + 18 % vignetting', 30, 0.18],
    ['blue tint −8 levels + 18 % vignetting', 8, 0.18],
    ['blue tint −30 levels alone', 30, 0],
  ])('uneven paper (%s): exact', (label, tint, vig) => {
    const img = page(F1, {
      width: 700,
      height: 500,
      rotation: -3,
      paper: vignette(700, 500, tint, vig),
      seed: 31,
    });
    expectExact(run(img), F1, label);
  });

  it('dark text strokes over the dots (copies make up for the hidden dots): exact', () => {
    const r = rng(32);
    const img = page(F1, {
      width: 1000,
      height: 650,
      rotation: 1.2,
      strokes: textLines(r, 40, 40, 960, 400),
      seed: 32,
    });
    expectExact(run(img), F1, 'text');
  });

  it('a translucent highlighter band across the page: exact', () => {
    const img = page(F1, {
      width: 900,
      height: 600,
      rotation: 1,
      over: (x, y, [r, g, b]) => (y > 240 && y < 330 ? [r, g * 0.98, b * 0.45] : [r, g, b]),
      seed: 33,
    });
    expectExact(run(img), F1, 'highlighter');
  });

  for (const colour of [
    [255, 160, 0],
    [255, 230, 120],
  ] as const)
    it.each([10, 20, 30, 45, 60, 100])(
      `a ${colour.join(',')} patch of %i px in a corner: exact`,
      (size) => {
        const img = page(F1, {
          width: 700,
          height: 500,
          rotation: 0.5,
          over: (x, y, px) =>
            x >= 20 && x < 20 + size && y >= 20 && y < 20 + size ? [...colour] : px,
          seed: 34,
        });
        expectExact(run(img), F1, `patch ${size}`);
      },
    );

  it('a yellow banner across the top (700 × 40): exact', () => {
    const img = page(F1, {
      width: 700,
      height: 500,
      over: (_x, y, px) => (y < 40 ? [255, 230, 120] : px),
      seed: 35,
    });
    expectExact(run(img), F1, 'banner');
  });

  it('a yellow banner and a red logo (over 1 % of a 1000 × 800 page): exact', () => {
    const img = page(F1, {
      width: 1000,
      height: 800,
      rotation: 1,
      over: (x, y, px) =>
        y > 40 && y < 120 ? [255, 222, 60] : Math.hypot(x - 850, y - 650) < 70 ? [220, 30, 40] : px,
      seed: 36,
    });
    expectExact(run(img), F1, 'banner + logo');
  });

  it('one faint tile in the corner of a 1000 × 800 text page (0.3 % of the pixels): exact by default', () => {
    const tile = encodeDocuColor(F1, DEFAULT_MAPPING, SEP);
    const r = rng(37);
    const spec: ScanSpec = {
      width: 1000,
      height: 800,
      pitch: 12,
      origin: [780, 40],
      rotation: 0.8,
      dotAt: single(tile),
      noise: 1.5,
      depth: 30,
      radius: 0.22,
      strokes: textLines(r, 60, 200, 940, 760),
      seed: 37,
    };
    const img = renderScan(spec);
    expectExact(run(img), F1, 'corner tile on text');
    // The same page without the text.
    expectExact(run(renderScan({ ...spec, strokes: [] })), F1, 'corner tile alone');
  });

  it('a single tile in a corner, a light text line over its bottom row: exact', () => {
    const tile = encodeDocuColor(F2, DEFAULT_MAPPING, SEP);
    const img = renderScan({
      width: 1400,
      height: 1000,
      pitch: 12,
      origin: [40, 40],
      rotation: -0.6,
      dotAt: single(tile),
      noise: 2,
      depth: 35,
      radius: 0.2,
      strokes: [{ x: 20, y: 40 + 7 * 12 - 3, w: 120, h: 6, grey: 150 }],
      multiplyStrokes: true,
      supersample: 1,
      seed: 38,
    });
    expectExact(run(img), F2, 'text over the bottom row');
  });

  it('two of four copies damaged: the clean copies decide', () => {
    const tile = encodeDocuColor(F1, DEFAULT_MAPPING, SEP);
    const bad = tile.map((row, i) => row.map((v, j) => (i === 3 && j === 9 ? !v : v)));
    // 2 × 2 tiles with gaps; the diagonal copies miss a dot.
    const dotAt = (c: number, r: number) => {
      if (c < 0 || r < 0 || c >= 32 || r >= 20) return false;
      const tc = c % 17;
      const tr = r % 11;
      if (tc >= 15 || tr >= 8) return false;
      const diag = Math.floor(c / 17) === Math.floor(r / 11);
      return (diag ? bad : tile)[tr]![tc]!;
    };
    const img = renderScan({
      width: 36 * 12,
      height: 24 * 12,
      pitch: 12,
      origin: [24, 24],
      rotation: 1,
      dotAt,
      noise: 2,
      depth: 40,
      radius: 0.2,
      seed: 39,
    });
    const out = run(img);
    expectExact(out, F1, '2 of 4 damaged');
    expect(kv(out)['Tile copies']).toMatch(/^2 identical, 2 more with 1–3 differing dots/);
  });

  it('crop: one full tile and two halves: exact', () => {
    const tile = encodeDocuColor(F2, DEFAULT_MAPPING, SEP);
    const img = renderScan({
      width: 3 * 17 * 12,
      height: 12 * 12,
      pitch: 12,
      origin: [-8 * 12, 24],
      rotation: 0.5,
      dotAt: (c, r) => r >= 0 && r < 8 && c >= 0 && c % 17 < 15 && tile[r]![c % 17]!,
      noise: 2,
      depth: 40,
      radius: 0.2,
      seed: 40,
    });
    expectExact(run(img), F2, 'crop with halves');
  });

  it('crop cutting the only tile in half: honest, never green', () => {
    const tile = encodeDocuColor(F2, DEFAULT_MAPPING, SEP);
    const img = renderScan({
      width: 400,
      height: 220,
      pitch: 12,
      origin: [400 - 7 * 12, 40],
      rotation: 0,
      dotAt: single(tile),
      noise: 2,
      depth: 40,
      radius: 0.2,
      seed: 41,
    });
    const out = run(img);
    expect(status(out)).not.toBe('sure');
    expect(notes(out, 'success')).toEqual([]);
  });
});

// ---------- ambiguity: never a confident wrong reading ----------

describe('ambiguity', () => {
  it('tiles printed edge to edge, overflowing the page, crafted so a shifted window is valid: never confidently wrong', () => {
    const truth: DocuFields = {
      year: 2044,
      month: 6,
      day: 12,
      hour: 9,
      minute: 32,
      serial: '96572119',
    };
    // Pick column 15 so that the window one column to the left reads a valid tile as well.
    let tile: Matrix | null = null;
    for (let v = 0; v < 128 && !tile; v++) {
      const t = encodeDocuColor(truth, DEFAULT_MAPPING, { 15: v });
      const shifted = t.map((row) => [row[14]!, ...row.slice(0, 14)]);
      if (decodeDocuColor(shifted).plausible && decodeDocuColor(shifted).parity.ok) tile = t;
    }
    expect(tile).not.toBeNull();
    let ambiguous = 0;
    for (let off = 0; off < 15; off++) {
      const img = renderScan({
        width: 900,
        height: 420,
        pitch: 12,
        origin: [6, 6],
        rotation: 0.5,
        dotAt: tiled(tile!, off, 0, 15, 0),
        noise: 2,
        depth: 40,
        radius: 0.2,
        supersample: 1,
        seed: 50 + off,
      });
      const out = run(img);
      const s = expectHonest(out, truth, `offset ${off}`);
      if (s === 'ambiguous') {
        ambiguous++;
        expect(candidates(out), `offset ${off}`).toContain(`${printed(truth)} ${truth.serial}`);
        expect(kv(out)['Printed']).toMatch(/ \(ambiguous\)$/);
      }
    }
    expect(ambiguous).toBeGreaterThan(0);
  }, 60_000);

  it('30 random tiles with the separator, edge to edge and overflowing: never confidently wrong', () => {
    const r = rng(60);
    let sure = 0;
    for (let k = 0; k < 30; k++) {
      const f = randomFields(r);
      const img = renderScan({
        width: 520,
        height: 260,
        pitch: 12,
        origin: [6, 6],
        rotation: (r() - 0.5) * 2,
        dotAt: tiled(
          encodeDocuColor(f, DEFAULT_MAPPING, SEP),
          Math.floor(r() * 15),
          Math.floor(r() * 8),
          15,
          0,
        ),
        noise: 2,
        depth: 40,
        radius: 0.2,
        supersample: 1,
        seed: 60 + k,
      });
      const out = run(img);
      if (expectHonest(out, f, `tile ${k}`) === 'sure') sure++;
      else expect(candidates(out), `tile ${k}`).toContain(`${printed(f)} ${f.serial}`);
    }
    // The separator usually leaves exactly one valid alignment.
    expect(sure).toBeGreaterThan(15);
  }, 60_000);

  it('tiles edge to edge inside the page (3 × 3, period 15 × 8): honest', () => {
    const tile = encodeDocuColor(F1, DEFAULT_MAPPING, SEP);
    const dotAt = (c: number, r: number) =>
      c >= 0 && r >= 0 && c < 45 && r < 24 && tile[r % 8]![c % 15]!;
    const img = renderScan({
      width: 700,
      height: 400,
      pitch: 12,
      origin: [60, 40],
      rotation: 0.5,
      dotAt,
      noise: 2,
      depth: 40,
      radius: 0.2,
      seed: 61,
    });
    expectHonest(run(img), F1, 'contiguous inside');
  });

  it('two different tiles on one page: ambiguous, both listed, never green', () => {
    const a = encodeDocuColor(F1, DEFAULT_MAPPING, SEP);
    const b = encodeDocuColor(F2, DEFAULT_MAPPING, SEP);
    const dotAt = (c: number, r: number) => {
      if (c < 0 || r < 0 || c >= 34 || r >= 22) return false;
      const tc = c % 17;
      const tr = r % 11;
      if (tc >= 15 || tr >= 8) return false;
      return ((Math.floor(c / 17) + Math.floor(r / 11)) % 2 ? b : a)[tr]![tc]!;
    };
    const out = run(
      renderScan({
        width: 38 * 12,
        height: 26 * 12,
        pitch: 12,
        origin: [24, 24],
        rotation: 1,
        dotAt,
        noise: 2,
        depth: 40,
        radius: 0.2,
        seed: 62,
      }),
    );
    expect(status(out)).toBe('ambiguous');
    expect(notes(out, 'success')).toEqual([]);
    expect(candidates(out).sort()).toEqual(
      [`${printed(F1)} ${F1.serial}`, `${printed(F2)} ${F2.serial}`].sort(),
    );
  });

  it('a misread copy that still passes parity: outvoted 11 to 1 it is a note; 2 to 2 it is ambiguous', () => {
    const a = encodeDocuColor(F1, DEFAULT_MAPPING, SEP);
    // Four flips on a rectangle (rows 7-8 × columns 2-3) keep every parity: minute 46 -> 45.
    const b = a.map((row, i) => row.map((v, j) => (i >= 6 && j >= 1 && j <= 2 ? !v : v)));
    expect(decodeDocuColor(b).parity.ok).toBe(true);
    const fB = { ...F1, minute: decodeDocuColor(b).fields.minute };
    expect(fB.minute).not.toBe(F1.minute);
    const grid =
      (cols: number, rowsN: number, isB: (i: number, j: number) => boolean) =>
      (c: number, r: number) => {
        if (c < 0 || r < 0 || c >= cols * 17 || r >= rowsN * 11) return false;
        const tc = c % 17;
        const tr = r % 11;
        if (tc >= 15 || tr >= 8) return false;
        return (isB(Math.floor(c / 17), Math.floor(r / 11)) ? b : a)[tr]![tc]!;
      };
    const scan = (cols: number, rowsN: number, isB: (i: number, j: number) => boolean) =>
      renderScan({
        width: (cols * 17 + 3) * 12,
        height: (rowsN * 11 + 3) * 12,
        pitch: 12,
        origin: [24, 24],
        rotation: 0.6,
        dotAt: grid(cols, rowsN, isB),
        noise: 2,
        depth: 40,
        radius: 0.2,
        supersample: 1,
        seed: 64,
      });
    const many = run(scan(4, 3, (i, j) => i === 0 && j === 0));
    expectExact(many, F1, '11 to 1');
    expect(notes(many, 'info').join(' ')).toMatch(
      /^1 other reading also passes parity, but in very few windows \(e\.g\. .*: 1 window against 11\): misread copies/,
    );
    const even = run(scan(2, 2, (i, j) => (i + j) % 2 === 1));
    expect(status(even)).toBe('ambiguous');
    expect(candidates(even).sort()).toEqual(
      [`${printed(F1)} ${F1.serial}`, `${printed(fB)} ${fB.serial}`].sort(),
    );
  });

  it('unknown columns 3, 4, 9 and 15 filled with random values: exact, or ambiguous with the truth listed', () => {
    const r = rng(63);
    for (let k = 0; k < 6; k++) {
      const f = randomFields(r);
      const extras = {
        3: Math.floor(r() * 128),
        4: Math.floor(r() * 128),
        9: Math.floor(r() * 128),
        15: Math.floor(r() * 128),
        ...(k % 2 ? SEP : {}),
      };
      const turn: Orientation =
        k === 3 ? { rotate: 180, mirror: false } : { rotate: 0, mirror: false };
      const tile = orient(encodeDocuColor(f, DEFAULT_MAPPING, extras), turn);
      const out = run(
        renderScan({
          width: 640,
          height: 420,
          pitch: 12,
          origin: [6, 6],
          rotation: k === 3 ? -4 : 1,
          dotAt: staggered(tile, 2, 2),
          noise: 2,
          depth: 40,
          radius: 1 / 6,
          seed: 63 + k,
        }),
      );
      const s = expectHonest(out, f, `tile ${k}`);
      if (s !== 'sure') {
        expect(s, `tile ${k}`).toBe('ambiguous');
        expect(candidates(out), `tile ${k}`).toContain(`${printed(f)} ${f.serial}`);
      }
    }
  });
});

// ---------- nothing to read ----------

describe('nothing to read: honest, never a "Parity OK"', () => {
  const blank = (extra: Partial<ScanSpec>) =>
    renderScan({
      width: 600,
      height: 400,
      pitch: 12,
      origin: [0, 0],
      rotation: 0,
      dotAt: () => false,
      noise: 3,
      depth: 30,
      radius: 0.2,
      seed: 70,
      ...extra,
    });

  it.each([
    ['text and noise', { strokes: textLines(rng(70), 40, 40, 560, 360) }],
    ['tinted paper', { paper: () => [250, 240, 200] as [number, number, number] }],
    [
      'a highlighter stroke only',
      {
        over: (_x: number, y: number, [r, g, b]: [number, number, number]) =>
          y > 150 && y < 190
            ? ([r, g, b * 0.5] as [number, number, number])
            : ([r, g, b] as [number, number, number]),
      },
    ],
  ] as const)('%s', (_label, extra) => {
    const out = run(blank(extra));
    expect(notes(out, 'success')).toEqual([]);
    expect(status(out)).not.toBe('ambiguous');
    expect(kv(out)['Parity'] ?? 'none').not.toBe('OK');
  });

  it('a greyscale scan (the dots turned into luma) has no colour ink left', () => {
    const img = page(F1, { width: 600, height: 400, depth: 40 });
    for (let i = 0; i < img.data.length; i += 4) {
      const y = Math.round(
        0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!,
      );
      img.data[i] = y;
      img.data[i + 1] = y;
      img.data[i + 2] = y;
    }
    const out = run(img);
    expect(notes(out, 'success')).toEqual([]);
    expect(notes(out, 'error')[0]).toMatch(/^No tracking dots found/);
  });

  it.each([
    ['a random lattice, 35 % of the cells', 0.35],
    ['a random lattice, 15 % of the cells', 0.15],
  ])('%s', (_label, p) => {
    const r = rng(71);
    const cells = new Map<string, boolean>();
    const out = run(
      renderScan({
        width: 600,
        height: 400,
        pitch: 12,
        origin: [6, 6],
        rotation: 1,
        dotAt: (c, row) => {
          const key = `${c},${row}`;
          if (!cells.has(key)) cells.set(key, r() < p);
          return cells.get(key)!;
        },
        noise: 2,
        depth: 40,
        radius: 0.2,
        seed: 71,
      }),
    );
    expect(notes(out, 'success')).toEqual([]);
  });

  it('900 scattered dots, and a repeated random tile that fails parity', () => {
    const r = rng(72);
    const marks = new Uint8Array(600 * 400);
    for (let k = 0; k < 900; k++) {
      const u = Math.floor(r() * 598) + 1;
      const v = Math.floor(r() * 398) + 1;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) marks[(v + dy) * 600 + u + dx] = 1;
    }
    const scattered = renderScan({
      width: 600,
      height: 400,
      pitch: 1,
      origin: [0, 0],
      rotation: 0,
      dotAt: () => false,
      over: (x, y, px) => (marks[y * 600 + x] ? [px[0], px[1], px[2] - 40] : px),
      noise: 2,
      depth: 0,
      radius: 0,
      supersample: 1,
      seed: 72,
    });
    expect(notes(run(scattered), 'success')).toEqual([]);
    const junk = Array.from({ length: 8 }, () => Array.from({ length: 15 }, () => r() < 0.4));
    while (bestOrientations(junk).some((t) => t.parityOk)) junk[3]![4] = !junk[3]![4];
    const out = run(
      renderScan({
        width: 640,
        height: 420,
        pitch: 12,
        origin: [6, 6],
        rotation: 1,
        dotAt: staggered(junk, 0, 0),
        noise: 2,
        depth: 40,
        radius: 1 / 6,
        seed: 73,
      }),
    );
    expect(notes(out, 'success')).toEqual([]);
  });
});

// ---------- detection is independent of the picture options ----------

describe('picture options never change the reading', () => {
  async function sample(name: string) {
    const bytes = new Uint8Array(
      readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)),
    );
    return ((await prepareInput('image', { bytes, name })) as ImageInput).image;
  }

  it('gain, gamma, stretch and invert, on the shipped page and on a one-tile page', async () => {
    const shipped = await sample('printer-dots-synthetic.png');
    const one = renderScan({
      width: 400,
      height: 260,
      pitch: 12,
      origin: [100, 60],
      rotation: 1,
      dotAt: single(encodeDocuColor(F2, DEFAULT_MAPPING, SEP)),
      noise: 2,
      depth: 25,
      radius: 0.2,
      seed: 80,
    });
    const shippedF: DocuFields = {
      year: 2024,
      month: 11,
      day: 5,
      hour: 14,
      minute: 37,
      serial: '13572468',
    };
    for (const [img, f] of [
      [shipped, shippedF],
      [one, F2],
    ] as const) {
      for (const o of [
        { gain: 0.5 },
        { gain: 3 },
        { gain: 5 },
        { gamma: 0.5 },
        { gamma: 2 },
        { gamma: 3 },
        { stretch: 'auto' },
        { stretch: 'full' },
        { stretch: 'equalize' },
        { stretch: 'none' },
        { invert: false },
        { stretch: 'equalize', invert: false, gain: 4, gamma: 3 },
      ])
        expectExact(run(img, o), f, JSON.stringify(o));
    }
  });

  it('the detection is cached: picture or decoding changes reuse it (same object)', () => {
    const img = page(F1, { width: 500, height: 320 });
    const copy = { ...img, data: new Uint8ClampedArray(img.data) }; // the worker gets a copy
    const rect = { x: 0, y: 0, w: img.width, h: img.height };
    run(img, { gain: 3 });
    const a = detectCached(img, rect, 'b', true, 0).det;
    run(copy, { advanced: true, parity: 'even', zoom: 4 });
    expect(detectCached(copy, rect, 'b', true, 0).det).toBe(a);
    // A different picture is not mistaken for the cached one.
    copy.data[1000] = copy.data[1000]! ^ 1;
    expect(detectCached(copy, rect, 'b', true, 0).det).not.toBe(a);
  });
});

// ---------- manual grid options ----------

describe('manual grid options on one upside-down tile', () => {
  const tile = orient(encodeDocuColor(F2, DEFAULT_MAPPING, SEP), { rotate: 180, mirror: false });
  const img = renderScan({
    width: 21 * 13,
    height: 14 * 13,
    pitch: 13,
    origin: [3 * 13, 3 * 13],
    rotation: 2,
    dotAt: single(tile),
    noise: 2,
    depth: 35,
    radius: 0.22,
    seed: 90,
  });
  const auto = run(img);
  // The fitted values, as the "Grid fit" details report them.
  const pitch = Number(/^([\d.]+)/.exec(kv(auto)['Pitch'] ?? '')?.[1]);
  const rot = Number(/^(-?[\d.]+)/.exec(kv(auto)['Rotation'] ?? '')?.[1]);
  const [ox, oy] = (/^\((-?[\d.]+), (-?[\d.]+)\)/.exec(kv(auto)['Origin'] ?? '') ?? [])
    .slice(1)
    .map(Number);
  const grid = (o: Record<string, unknown> = {}) =>
    run(img, {
      advanced: true,
      pitchX: pitch,
      autoRotation: false,
      rotation: rot,
      autoOrigin: false,
      originX: ox,
      originY: oy,
      ...o,
    });

  it('auto, and the fitted grid typed back by hand (auto and forced orientation): exact', () => {
    expectExact(auto, F2, 'auto');
    expectExact(grid(), F2, 'by hand');
    expectExact(grid({ orientation: 'r180' }), F2, 'by hand, forced 180°');
  });

  it.each([
    ['wrong forced orientation', { orientation: 'r0' }],

    ['rotation of the wrong sign', { rotation: -2 }],
    ['origin one cell off', { originX: (ox ?? 0) + 13 }],
    ['even parity', { parity: 'even' }],
  ])('%s: honest, never green', (_label, o) => {
    const out = grid(o);
    expect(notes(out, 'success')).toEqual([]);
  });

  it('a slightly wrong pitch (13.2 for 13) reads right or fails, never a wrong green', () => {
    expectHonest(grid({ pitchX: 13.2 }), F2, 'pitch 13.2');
  });

  it('a custom column mapping is followed, and said to be custom', () => {
    const out = grid({ minuteCol: 3 });
    expect(kv(out)['Printed']).toBe(printed({ ...F2, minute: 0 }));
    expect(notes(out, 'info').join(' ')).toContain('Custom column mapping (minute 3)');
  });

  it('half-typed values never blank the output: pitch 1, tile 1 × 8, minute column 1', () => {
    for (const o of [{ pitchX: 1 }, { cols: 1 }, { minuteCol: 1 }]) {
      const out = run(img, { advanced: true, ...o });
      expect(notes(out, 'warn').length, JSON.stringify(o)).toBeGreaterThan(0);
      expectExact(out, F2, JSON.stringify(o));
    }
  });

  it('every option of the crop sample can be changed without an error', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../public/samples/printer-dots-crop.png', import.meta.url)),
    );
    const crop = ((await prepareInput('image', { bytes, name: 'c.png' })) as ImageInput).image;
    const changes: Record<string, unknown>[] = [
      { channel: 'y' },
      { channel: 'r' },
      { channel: 'luma' },
      { channel: 'a' },
      { inkOnly: false },
      { threshold: 5 },
      { threshold: 255 },
      { cropX: 10, cropY: 10, cropW: 200, cropH: 150 },
      { cropW: 5000 },
      { stretch: 'equalize' },
      { invert: false },
      { gain: 0 },
      { gamma: 10 },
      { zoom: 1 },
      { zoom: 16 },
      { advanced: true },
      { advanced: true, cols: 16 },
      { advanced: true, rows: 2 },
      { advanced: true, pitchX: 16.1 },
      { advanced: true, pitchY: 20 },
      { advanced: true, autoRotation: false, rotation: 3 },
      { advanced: true, autoOrigin: false, originX: 40, originY: 40 },
      { advanced: true, autoOrigin: false, originX: -500, originY: 9000 },
      { advanced: true, orientation: 'm90' },
      { advanced: true, dayCol: 9 },
      { advanced: true, hourCol: 2 },
      { advanced: true, serialCols: '13 12 11' },
      { advanced: true, serialCols: 'x' },
      { advanced: true, century: '1900' },
      { advanced: true, parity: 'even' },
      { advanced: true, yearCol: 15, monthCol: 15 },
    ];
    for (const o of changes) {
      const out = run(crop, o);
      const first = out[0];
      expect(first?.type, JSON.stringify(o)).toBe('note');
      expect(
        out.some((b) => b.type === 'image'),
        JSON.stringify(o),
      ).toBe(true);
    }
  });
});

// ---------- what the user sees ----------

describe('presentation', () => {
  it('a single misread dot gets a hypothesis; three do not get a fake one', () => {
    const tile = encodeDocuColor(F1, DEFAULT_MAPPING, SEP);
    const flip = (m: Matrix, cells: [number, number][]) =>
      m.map((row, i) => row.map((v, j) => (cells.some(([a, b]) => a === i && b === j) ? !v : v)));
    const scan = (m: Matrix) =>
      renderScan({
        width: 19 * 14,
        height: 12 * 14,
        pitch: 14,
        origin: [28, 28],
        rotation: 1,
        dotAt: single(m),
        noise: 2,
        depth: 30,
        radius: 0.22,
        seed: 100,
      });
    const one = run(scan(flip(tile, [[4, 6]])));
    expect(status(one)).toBe('failed');
    expect(notes(one, 'warn').join(' ')).toMatch(/hypothesis, not a reading/);
    const three = run(
      scan(
        flip(tile, [
          [2, 3],
          [4, 6],
          [6, 11],
        ]),
      ),
    );
    expect(status(three)).toBe('failed');
    expect(notes(three, 'warn').join(' ')).not.toMatch(/hypothesis/);
    // No fake date in the answer when the columns are not a date.
    const p = kv(three)['Printed'] ?? '';
    expect(p.endsWith('(guess — parity failed)')).toBe(true);
    expect(p === '— (guess — parity failed)' || /^\d{4}-\d\d-\d\d \d\d:\d\d /.test(p)).toBe(true);
  });

  it('nothing found: advice that fits the current options', () => {
    const blank = renderScan({
      width: 500,
      height: 300,
      pitch: 12,
      origin: [0, 0],
      rotation: 0,
      dotAt: () => false,
      noise: 2,
      depth: 30,
      radius: 0.2,
      strokes: textLines(rng(110), 30, 30, 470, 270),
      over: (_x, y, px) => (y < 30 ? [255, 222, 60] : px),
      seed: 110,
    });
    const err = (o: Record<string, unknown>, img = blank) => notes(run(img, o), 'error').join(' ');
    expect(err({})).toMatch(/^No tracking dots found .*set a region around the dots/);
    expect(err({ channel: 'r' })).toMatch(/only show in the Blue or Yellow channel/);
    expect(err({ threshold: 255 })).toMatch(/lower Dot threshold \(now 255\)/);
    // With text on the page, Colour ink only off finds the text; on a clean page it says why.
    const clean = renderScan({
      width: 300,
      height: 200,
      pitch: 12,
      origin: [0, 0],
      rotation: 0,
      dotAt: () => false,
      noise: 2,
      depth: 30,
      radius: 0.2,
      seed: 111,
    });
    expect(err({ inkOnly: false }, clean)).toMatch(/turn on Colour ink only/);
  });

  it('options: units in the labels, fine steps, and few options until "Manual grid" is on', () => {
    const o = printerDots.options!;
    expect(o.pitchX).toMatchObject({ type: 'number', label: 'Pitch X (px, 0 = auto)', step: 0.1 });
    expect(o.rotation).toMatchObject({ type: 'number', step: 0.1, min: -45, max: 45 });
    expect(o.zoom?.label).toBe('Zoom (0 = auto)');
    expect(o.threshold?.label).toBe('Dot threshold (0 = auto)');
    const visible = (v: Record<string, unknown>) =>
      Object.values(o).filter((spec) => !spec.showIf || spec.showIf(v)).length;
    expect(visible(defaults)).toBeLessThanOrEqual(13);
    expect(visible({ ...defaults, advanced: true })).toBeGreaterThan(20);
    expect(visible({ ...defaults, advanced: true, cols: 16 })).toBeLessThan(
      visible({ ...defaults, advanced: true }),
    );
  });

  it('the overlay numbers the tile rows and columns next to the window', () => {
    const level = new Uint8Array(200 * 120).fill(60);
    const lut = Uint8Array.from({ length: 256 }, (_, v) => v);
    const img = renderOverlay({
      display: { source: level, lut, dotsBright: true },
      rect: { x: 0, y: 0, w: 200, h: 120 },
      view: { x: 0, y: 0, w: 200, h: 120 },
      zoom: 2,
      lattice: { ox: 30, oy: 30, ax: 12, ay: 0, bx: 0, by: 12 },
      grid: { i0: -2, j0: -2, w: 18, h: 10, cells: new Uint8Array(180) },
      window: {
        x: 2,
        y: 2,
        w: 15,
        h: 8,
        parityRows: [0],
        parityCols: [0],
        badRows: [],
        badCols: [],
      },
      labels: [
        { x: 30, y: 18, text: '1' },
        { x: 18, y: 30, text: '1' },
        { x: 30 + 14 * 12, y: 18, text: '15' },
      ],
    });
    const white = (x0: number, y0: number, r: number) => {
      let n = 0;
      for (let y = y0 - r; y <= y0 + r; y++)
        for (let x = x0 - r; x <= x0 + r; x++) if (img.data[(y * img.width + x) * 4] === 255) n++;
      return n;
    };
    expect(white(60, 36, 8)).toBeGreaterThan(5); // "1" above column 1 (zoom 2)
    expect(white(36, 60, 8)).toBeGreaterThan(5); // "1" left of row 1
    expect(white(60 + 14 * 24, 36, 10)).toBeGreaterThan(10); // "15" above column 15
    expect(white(140, 140, 6)).toBe(0); // nothing inside the window
  });

  it('a picture too big for the grid keeps dark dots when Invert is off', () => {
    const pts = Array.from({ length: 12 }, (_, k) => [300 + k * 480, 150]);
    const wide = renderScan({
      width: 6200,
      height: 300,
      pitch: 1,
      origin: [0, 0],
      rotation: 0,
      dotAt: () => false,
      over: (x, y, px) =>
        pts.some(([u, v]) => Math.abs(x - u!) < 3 && Math.abs(y - v!) < 3)
          ? [px[0], px[1], px[2] - 40]
          : px,
      noise: 1,
      depth: 0,
      radius: 0,
      supersample: 1,
      seed: 120,
    });
    const out = run(wide, {
      invert: false,
      advanced: true,
      pitchX: 12,
      autoRotation: false,
      rotation: 0,
      autoOrigin: false,
      originX: 6000,
      originY: 290,
    });
    const pic = out.find((o) => o.type === 'image');
    if (pic?.type !== 'image') throw new Error('image expected');
    let dark = 0;
    for (let i = 0; i < pic.image.data.length; i += 4) if (pic.image.data[i]! < 128) dark++;
    expect(dark).toBeGreaterThan(0);
    expect(pic.label).toMatch(/grid is too fine to draw/);
  });

  it('a window too sparse to be a tile is reported as such, without a contradictory "Parity OK"', () => {
    const four = renderScan({
      width: 300,
      height: 200,
      pitch: 12,
      origin: [120, 80],
      rotation: 0,
      dotAt: (c, r) => c >= 0 && c < 2 && r >= 0 && r < 2,
      noise: 1,
      depth: 40,
      radius: 0.2,
      seed: 121,
    });
    const out = run(four, {
      advanced: true,
      parity: 'even',
      pitchX: 12,
      autoRotation: false,
      rotation: 0,
    });
    const text = resultToText(out);
    expect(notes(out, 'error').join(' ')).toMatch(/holds enough dots to be a tile/);
    expect(text).not.toMatch(/Parity FAILED in {2}/);
    expect(kv(out)['Parity']).toBeUndefined();
  });

  it('the printed bit matrix of a tile printed mirrored + 90° pipes into the matrix tool', () => {
    const o: Orientation = { rotate: 90, mirror: true };
    const img = page(F1, { width: 640, height: 640, rotation: 3, seed: 130 }, o);
    const out = run(img);
    const t = out.find((b) => b.type === 'text');
    const dcDefaults = Object.fromEntries(
      Object.entries(docucolor.options ?? {}).map(([k, s]) => [k, s.default]),
    );
    const dc = docucolor.run(t?.type === 'text' ? t.value : '', dcDefaults as never) as Output[];
    expect(resultToText(dc)).toContain(`Printed: ${printed(F1)}`);
    expect(resultToText(dc)).toContain(`Serial: ${F1.serial}`);
  });
});

// ---------- bigger pages ----------

describe('bigger pages', () => {
  it('A4 at 200 dpi (1654 × 2339, pitch 8, text): exact, in reasonable time', () => {
    const tile = encodeDocuColor(F2, DEFAULT_MAPPING, SEP);
    const img = renderScan({
      width: 1654,
      height: 2339,
      pitch: 8,
      origin: [4, 4],
      rotation: 0.7,
      dotAt: staggered(tile, 0, 0),
      noise: 2,
      depth: 40,
      radius: 0.2,
      strokes: textLines(rng(140), 120, 200, 1500, 2100),
      supersample: 1,
      seed: 140,
    });
    const t0 = performance.now();
    expectExact(run(img), F2, 'A4');
    // Generous (a slow CI runner must not flake): the budget only catches a blow-up.
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 60_000);
});
