/**
 * Barcode scan: the zxing-cpp reader (zxing-wasm) plus the help hard pictures need.
 *
 * The reader already turns the picture by 90 degrees and reads 2D codes printed light on dark.
 * What it does not do is handled here, one "pass" at a time: 1D codes and PDF417 / MaxiCode
 * printed light on dark (inverted picture), pictures that are only a code (pure mode), a missing
 * quiet zone (margin), uneven or weak contrast (greyscale threshold, global histogram), tiny or
 * huge pictures (enlarged, reduced) and codes tilted far enough that no scan line crosses them
 * whole (turned a few degrees at a time). Every hit says which pass found it.
 */
import type { ReaderOptions, ReadInputBarcodeFormat, ReadResult } from 'zxing-wasm/reader';
import { ToolError } from '../../core/errors';
import type { RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { loadReader } from './_barcode-wasm';
import {
  addMargin,
  borderLevel,
  compose,
  grayToRgba,
  hasAlpha,
  identity,
  invert,
  median3,
  otsu,
  rotate,
  shrink,
  speckleShare,
  threshold,
  toGray,
  traceBars,
  upscale,
  type Gray,
  type Point,
  type ToOriginal,
} from './_barcode-prep';

const T = toolT('barcode');

export type FormatChoice =
  | 'all'
  | 'linear'
  | 'matrix'
  | 'code128'
  | 'code39'
  | 'code93'
  | 'codabar'
  | 'itf'
  | 'eanupc'
  | 'databar'
  | 'qr'
  | 'datamatrix'
  | 'aztec'
  | 'pdf417'
  | 'maxicode';

/** Which zxing formats each choice stands for ([] = all of them). */
export const FORMAT_FILTERS: Record<FormatChoice, ReadInputBarcodeFormat[]> = {
  all: [],
  linear: ['AllLinear'],
  matrix: ['AllMatrix'],
  code128: ['Code128'],
  code39: ['Code39'],
  code93: ['Code93'],
  codabar: ['Codabar'],
  itf: ['ITF'],
  eanupc: ['EANUPC'],
  databar: ['DataBar'],
  qr: ['QRCode'],
  datamatrix: ['DataMatrix'],
  aztec: ['Aztec'],
  pdf417: ['PDF417'],
  maxicode: ['MaxiCode'],
};

/** smart: stop at the first pass that reads something; quick: one pass; full: every pass. */
export type Effort = 'smart' | 'quick' | 'full';

export interface ScanOptions {
  formats: FormatChoice;
  effort: Effort;
  /** Read the +2 / +5 add-on of EAN and UPC codes. */
  addOns: boolean;
  /** Check the optional check digit of Code 39 and ITF. */
  checksum: boolean;
  /** Also list codes that were seen but fail their own check (wrong check digit...). */
  invalid: boolean;
}

export const DEFAULT_SCAN: ScanOptions = {
  formats: 'all',
  effort: 'smart',
  addOns: true,
  checksum: false,
  invalid: false,
};

const LINEAR = new Set([
  'Codabar',
  'Code39',
  'Code39Std',
  'Code39Ext',
  'Code32',
  'PZN',
  'Code93',
  'Code128',
  'ITF',
  'ITF14',
  'DataBar',
  'DataBarOmni',
  'DataBarStk',
  'DataBarStkOmni',
  'DataBarLtd',
  'DataBarExp',
  'DataBarExpStk',
  'EANUPC',
  'EAN13',
  'EAN8',
  'EAN5',
  'EAN2',
  'ISBN',
  'UPCA',
  'UPCE',
  'Telepen',
  'TelepenAlpha',
  'TelepenNumeric',
  'DXFilmEdge',
]);

/** 1D (linear) formats; the others are 2D. */
export const isLinear = (format: string): boolean => LINEAR.has(format);

export interface BarcodeHit {
  /** zxing's name of the format: "Code128", "EAN13", "DataMatrix"... */
  format: string;
  /** Family of the format: "EANUPC" for EAN-13, "QRCode" for Micro QR... */
  symbology: string;
  text: string;
  bytes: Uint8Array;
  /** Text, Binary, Mixed, GS1, ISO15434 or UnknownECI. */
  contentType: string;
  hasECI: boolean;
  isValid: boolean;
  /** What failed, for a code that is not valid. */
  error: string;
  /** Corners in the pixels of the original picture: top left, top right, bottom right, bottom left. */
  corners: [Point, Point, Point, Point];
  /** Clockwise degrees the code is turned in the original picture (0..359). */
  rotation: number;
  /** Good to about 10 degrees only: a 1D code read after the picture was turned a few degrees. */
  rotationApprox: boolean;
  isMirrored: boolean;
  /** Light modules on a dark background. */
  isInverted: boolean;
  ecLevel: string;
  /** zxing's `extra` object (version, data mask, add-on, spare error correction...). */
  extra: Record<string, unknown>;
  symbologyIdentifier: string;
  sequenceSize: number;
  sequenceIndex: number;
  sequenceId: string;
  lineCount: number;
  /** How the picture had to be prepared: "as is", "colours inverted"... */
  how: string;
}

export interface BarcodeScan {
  hits: BarcodeHit[];
  /** Codes seen but failing their check (only filled when asked for, or when nothing else was read). */
  invalid: BarcodeHit[];
  /** Reader runs made. */
  tried: number;
  /** The work limit was reached before every pass had run. */
  limited: boolean;
}

interface Prepared {
  gray: Gray;
  toOriginal: ToOriginal;
}

interface Pass {
  steps: string[];
  prepare: () => Prepared;
  reader?: Partial<ReaderOptions>;
  /** Degrees the picture is turned by in this pass (to give a code's angle in the original). */
  tilt?: number;
}

/** Work limit (pixels summed over the passes): keeps a huge noisy picture from running for minutes. */
const PIXEL_BUDGET = 90_000_000;
/** The first passes read a picture of at most this many pixels (a bigger one is reduced). */
const FIRST_PIXELS = 16_000_000;
/** Pure mode is for pictures that are only a code: those are small. */
const PURE_PIXELS = 4_000_000;
/** Passes after the first work on a picture of at most this many pixels. */
const WORK_PIXELS = 2_500_000;
/** Tilt passes work on at most this many pixels. */
const TILT_PIXELS = 1_600_000;
const TILTS = [10, -10, 20, -20, 30, -30, 40, -40];
const THRESHOLDS = [64, 128, 192];
/** A picture with more than this share of isolated specks gets a median filter. */
const SPECKLE_SHARE = 0.0005;
/** ... and from this share the tilted passes use the filtered picture instead of the original. */
const TILT_DENOISE_SHARE = 0.002;

function readerOptions(opts: ScanOptions, extra: Partial<ReaderOptions>): ReaderOptions {
  return {
    formats: FORMAT_FILTERS[opts.formats],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    eanAddOnSymbol: opts.addOns ? 'Read' : 'Ignore',
    validateOptionalChecksum: opts.checksum,
    // Human-readable text: GS1 data as "(01)...", control characters shown as symbols.
    textMode: 'HRI',
    ...extra,
  };
}

function parseExtra(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toHit(r: ReadResult, seen: Prepared, tilt: number, how: string): BarcodeHit {
  const p = r.position;
  const outline = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft];
  let box: readonly Point[] = outline;
  let slant = 0;
  let sure = true;
  if (LINEAR.has(r.format)) {
    // A 1D code is boxed to the full height of its bars, not just the scan lines that agreed,
    // and its lean (the reader only knows 0 / 90 / 180 / 270) comes from following the bars.
    const traced = traceBars(seen.gray, outline);
    box = traced.corners;
    slant = traced.slant;
    sure = traced.sure;
  }
  const corners: BarcodeHit['corners'] = [
    seen.toOriginal(box[0]!),
    seen.toOriginal(box[1]!),
    seen.toOriginal(box[2]!),
    seen.toOriginal(box[3]!),
  ];
  return {
    format: r.format,
    symbology: r.symbology,
    text: r.text,
    bytes: new Uint8Array(r.bytes),
    contentType: r.contentType,
    hasECI: r.hasECI,
    isValid: r.isValid,
    // zxing-cpp adds where in its source the error came from ("ChecksumError @ file.cpp:289").
    error: r.error.split(' @ ')[0] ?? '',
    corners,
    // The code sits at r.rotation in the picture that was read; that picture was turned by `tilt`.
    rotation: (((Math.round(r.rotation + slant - tilt) % 360) + 360) % 360) % 360,
    rotationApprox: !sure && tilt !== 0,
    isMirrored: r.isMirrored,
    isInverted: r.isInverted,
    ecLevel: r.ecLevel,
    extra: parseExtra(r.extra),
    symbologyIdentifier: r.symbologyIdentifier,
    sequenceSize: r.sequenceSize,
    sequenceIndex: r.sequenceIndex,
    sequenceId: r.sequenceId,
    lineCount: r.lineCount,
    how,
  };
}

const centre = (h: BarcodeHit): Point => ({
  x: h.corners.reduce((s, c) => s + c.x, 0) / 4,
  y: h.corners.reduce((s, c) => s + c.y, 0) / 4,
});

/** Longest side of the code's outline. */
export function hitSize(h: BarcodeHit): number {
  const [tl, tr, br, bl] = h.corners;
  return Math.max(
    Math.hypot(tr.x - tl.x, tr.y - tl.y),
    Math.hypot(bl.x - tl.x, bl.y - tl.y),
    Math.hypot(br.x - tr.x, br.y - tr.y),
  );
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

/** The same code seen by two passes: same format and bytes, in the same place. */
function sameCode(a: BarcodeHit, b: BarcodeHit): boolean {
  if (a.format !== b.format || hex(a.bytes) !== hex(b.bytes)) return false;
  const ca = centre(a);
  const cb = centre(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y) < 0.5 * Math.max(hitSize(a), hitSize(b));
}

function* passes(img: RgbaImage, base: Gray): Generator<Pass> {
  const pixels = base.width * base.height;
  // A picture whose border is dark is light-on-dark (a white-on-black code, or a dark photo
  // background): after the first passes it is turned the right way round once, for all of them.
  const flip = borderLevel(base) < 128;
  const polarity = flip ? [T('how.inverted')] : [];
  let normCache: Gray | null = null;
  const norm = (): Gray => (normCache ??= flip ? invert(base) : base);
  // Working copy for the passes after the first: big pictures are brought down to a workable size.
  let k = 1;
  while (pixels / (k * k) > WORK_PIXELS) k++;
  const shrunk = k > 1 ? [T('how.shrunk', { factor: k })] : [];
  let workCache: Prepared | null = null;
  const work = (): Prepared => {
    workCache ??= k > 1 ? shrink(norm(), k) : { gray: norm(), toOriginal: identity };
    return workCache;
  };
  const level = (): number => borderLevel(work().gray);
  /** A prepared picture with the quiet-zone margin the code may lack. */
  const framed = (g: Gray, map: ToOriginal, fill: number): Prepared => {
    const m = Math.max(12, Math.round(Math.min(g.width, g.height) * 0.1));
    const out = addMargin(g, m, fill);
    return { gray: out.gray, toOriginal: compose(map, out.toOriginal) };
  };

  // The first passes read the picture at full size, unless it is far too big to be worth it.
  let k0 = 1;
  while (pixels / (k0 * k0) > FIRST_PIXELS) k0++;
  const first = k0 > 1 ? [T('how.shrunk', { factor: k0 })] : [];
  const atFirstSize = (g: Gray): Prepared =>
    k0 > 1 ? shrink(g, k0) : { gray: g, toOriginal: identity };

  yield { steps: [...first, T('how.asIs')], prepare: () => atFirstSize(base) };

  if (hasAlpha(img)) {
    // Light on transparent: laid on black it is light on dark, so it is turned the right way round.
    const onBlack = toGray(img, 0);
    const dark = borderLevel(onBlack) < 128;
    yield {
      steps: [...first, T('how.flatBlack'), ...(dark ? [T('how.inverted')] : [])],
      prepare: () => atFirstSize(dark ? invert(onBlack) : onBlack),
    };
  }

  // The other way round at the working size. The reader turns 2D codes light-on-dark by itself,
  // but not 1D codes, PDF417 or MaxiCode, which need the picture turned for them.
  if (!flip || k > 1) {
    yield {
      steps: [...shrunk, ...(flip ? [] : [T('how.inverted')])],
      prepare: () => {
        const w = flip ? shrink(base, k) : work();
        return flip ? w : { gray: invert(w.gray), toOriginal: w.toOriginal };
      },
      reader: { tryInvert: false },
    };
  }

  if (pixels <= PURE_PIXELS) {
    yield {
      steps: [T('how.pure')],
      prepare: () => ({ gray: base, toOriginal: identity }),
      reader: { isPure: true },
    };
    if (flip) {
      yield {
        steps: [...polarity, T('how.pure')],
        prepare: () => ({ gray: norm(), toOriginal: identity }),
        reader: { isPure: true },
      };
    }
  }

  yield {
    steps: [...shrunk, ...polarity, T('how.margin')],
    prepare: () => {
      const w = work();
      return framed(w.gray, w.toOriginal, level());
    },
  };

  // Speckle (salt and pepper) breaks every scan line: a median filter takes it out.
  const noisy = (g: Gray, share: number): boolean =>
    Math.min(g.width, g.height) >= 160 && speckleShare(g) > share;
  if (noisy(work().gray, SPECKLE_SHARE)) {
    yield {
      steps: [...shrunk, ...polarity, T('how.denoised')],
      prepare: () => {
        const w = work();
        return { gray: median3(w.gray), toOriginal: w.toOriginal };
      },
    };
  }

  let otsuCache: number | null = null;
  const otsuAt = (): number => (otsuCache ??= otsu(work().gray));
  yield {
    steps: [...shrunk, ...polarity, T('how.otsu', { t: otsuAt() })],
    prepare: () => {
      const w = work();
      const bin = threshold(w.gray, otsuAt());
      return framed(bin, w.toOriginal, level() < otsuAt() ? 0 : 255);
    },
  };

  yield {
    steps: [...shrunk, ...polarity, T('how.histogram')],
    prepare: () => work(),
    reader: { binarizer: 'GlobalHistogram' },
  };

  for (const t of THRESHOLDS) {
    if (Math.abs(t - otsuAt()) <= 12) continue;
    yield {
      steps: [...shrunk, ...polarity, T('how.threshold', { t })],
      prepare: () => {
        const w = work();
        const bin = threshold(w.gray, t);
        return framed(bin, w.toOriginal, level() < t ? 0 : 255);
      },
    };
  }

  // Tiny pictures: bigger modules help the reader; huge ones: averaging removes grain.
  const side = Math.max(base.width, base.height);
  if (side <= 640) {
    for (const f of [2, 3, 4]) {
      if (side * f > 1800) break;
      yield {
        steps: [...polarity, T('how.enlarged', { factor: f }), T('how.margin')],
        prepare: () => {
          const up = upscale(norm(), f);
          return framed(up.gray, up.toOriginal, borderLevel(norm()));
        },
      };
    }
  } else if (k === 1 && side > 1000) {
    for (const f of [2, 3]) {
      yield {
        steps: [...polarity, T('how.shrunk', { factor: f }), T('how.margin')],
        prepare: () => {
          const small = shrink(norm(), f);
          return framed(small.gray, small.toOriginal, borderLevel(norm()));
        },
      };
    }
  }

  // Tilted 1D codes: no scan line crosses the whole code, so turn the picture a few degrees.
  let tk = 1;
  while (pixels / (tk * tk) > TILT_PIXELS) tk++;
  let tiltCache: { small: Prepared; clean: boolean } | null = null;
  const tiltSource = () => {
    if (!tiltCache) {
      const small = tk > 1 ? shrink(norm(), tk) : { gray: norm(), toOriginal: identity };
      const clean = noisy(small.gray, TILT_DENOISE_SHARE);
      tiltCache = {
        small: clean ? { ...small, gray: median3(small.gray) } : small,
        clean,
      };
    }
    return tiltCache;
  };
  const source = tiltSource();
  for (const deg of TILTS) {
    yield {
      steps: [
        ...polarity,
        ...(tk > 1 ? [T('how.shrunk', { factor: tk })] : []),
        ...(source.clean ? [T('how.denoised')] : []),
        T('how.tilt', { deg }),
      ],
      tilt: deg,
      prepare: () => {
        const { small } = source;
        const turned = rotate(small.gray, deg, borderLevel(small.gray));
        return { gray: turned.gray, toOriginal: compose(small.toOriginal, turned.toOriginal) };
      },
    };
  }
}

/** The reader, or a sentence saying it could not be loaded (the user can retry). */
async function engine(): ReturnType<typeof loadReader> {
  try {
    return await loadReader();
  } catch {
    throw new ToolError(T('error.engine'));
  }
}

/** Hand the reader a grey picture (it wants RGBA with the grey value in every channel). */
async function readGray(g: Gray, options: ReaderOptions): Promise<ReadResult[]> {
  const { readBarcodes } = await engine();
  // The reader tells its input apart by shape ({ data, width, height }), so a plain object does;
  // the DOM ImageData type just asks for more fields than it looks at.
  const pixels = grayToRgba(g) as unknown as ImageData;
  return readBarcodes(pixels, options);
}

/**
 * Look for barcodes, preparing the picture in progressively more drastic ways. In "smart" mode
 * the first pass that reads anything ends the search; "full" runs every pass and merges what they
 * find; "quick" is the first pass only.
 */
export async function scanBarcodes(
  img: RgbaImage,
  opts: ScanOptions = DEFAULT_SCAN,
): Promise<BarcodeScan> {
  const base = toGray(img, 255);
  const hits: BarcodeHit[] = [];
  let tried = 0;
  let limited = false;
  let budget = PIXEL_BUDGET;
  let more = true;

  for (const pass of passes(img, base)) {
    if (!more) break;
    const prepared = pass.prepare();
    budget -= prepared.gray.width * prepared.gray.height;
    if (budget < 0 && tried > 0) {
      limited = true;
      break;
    }
    tried++;
    const results = await readGray(prepared.gray, readerOptions(opts, pass.reader ?? {}));
    const tilt = pass.tilt ?? 0;
    const how = pass.steps.join(', ');
    let found = false;
    for (const r of results) {
      if (!r.isValid) continue;
      const hit = toHit(r, prepared, tilt, how);
      if (!hits.some((h) => sameCode(h, hit))) hits.push(hit);
      found = true;
    }
    if (opts.effort === 'quick') more = false;
    else if (opts.effort === 'smart' && found) more = false;
  }

  // Something that looks like a code but fails its own check (a wrong check digit, say).
  let invalid: BarcodeHit[] = [];
  if (!hits.length || opts.invalid) {
    const results = await readGray(
      base,
      readerOptions(opts, { returnErrors: true, tryInvert: true }),
    );
    tried++;
    invalid = results
      .filter((r) => !r.isValid)
      .map((r) => toHit(r, { gray: base, toOriginal: identity }, 0, T('how.asIs')))
      .filter((h) => !hits.some((v) => sameCode(v, h)));
  }
  return { hits, invalid, tried, limited };
}
