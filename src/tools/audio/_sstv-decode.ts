/**
 * SSTV decoder: VIS header -> mode, sync pulses -> line positions (with slant correction),
 * tones -> pixel values -> picture. Works on a `Demod` (see _sstv-demod.ts).
 */
import type { RgbaImage } from '../../core/types';
import { median } from './_dsp';
import { endTime, toneAt, type Demod } from './_sstv-demod';
import {
  FREQ_BLACK,
  FREQ_SYNC,
  FREQ_WHITE,
  MODES,
  modeById,
  modeByVis,
  scansOf,
  sequencesOf,
  syncCentre,
  type Plane,
  type SstvMode,
} from './_sstv-modes';
import { findProgression, findSyncPulses, refineSync } from './_sstv-sync';
import { findVisHeaders, type VisHit } from './_sstv-vis';

export interface SstvOptions {
  /** 'auto' (VIS header, else the sync pulse rhythm) or a mode id. */
  mode: string;
  /** 'auto' fits the line time to the sync pulses; 'manual' uses `clockPpm` only. */
  slant: 'auto' | 'manual';
  /** Manual line-time correction: the line time is the nominal one times (1 + ppm / 1e6). */
  clockPpm: number;
  /** Seconds where the picture starts (end of the VIS header); 0 = from the header / the pulses. */
  start: number;
  /** Which VIS header to decode (1 = first). */
  transmission: number;
  /** Re-centre the tones on the measured 1200 Hz sync (and the 1900 Hz leader, when present). */
  calibrate: boolean;
}

export type SstvFailureCode =
  | 'noSync'
  | 'noMode'
  | 'unknownMode'
  | 'modeMismatch'
  | 'noLines'
  | 'noTransmission'
  | 'startBeyond';

/** A reason for failing that the tool turns into a translated message. */
export class SstvFailure extends Error {
  constructor(
    readonly code: SstvFailureCode,
    readonly params: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

export interface SstvResult {
  mode: SstvMode;
  /** How the mode was chosen: the VIS header, the option, or the line time of the sync pulses. */
  modeSource: 'vis' | 'chosen' | 'inferred';
  /** Other modes with a similar line time (inferred modes only). */
  alternatives: SstvMode[];
  /** The header the picture follows, and every header found. */
  header: VisHit | null;
  headers: VisHit[];
  /** The rows that were received. */
  image: RgbaImage;
  sequences: number;
  expectedSequences: number;
  /** Measured time between sync pulses, seconds, and its difference from the mode's, ppm. */
  period: number;
  ppm: number;
  /** Sequences whose sync pulse was located, how well (0..1), and the spread of position, ms. */
  syncHits: number;
  syncStrength: number;
  jitterMs: number;
  /** Tone correction: the sync tone was seen at `syncHz` instead of 1200 Hz; frequency gain. */
  syncHz: number;
  gain: number;
  /** Robot 36: the colour-difference order had to be swapped. */
  parityFlipped: boolean;
  /** Time of the start of the first line, seconds. */
  pictureStart: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Least-squares line y = a + b x. */
function linear(xs: readonly number[], ys: readonly number[]): { a: number; b: number } {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
    sxx += xs[i]! * xs[i]!;
    sxy += xs[i]! * ys[i]!;
  }
  const den = n * sxx - sx * sx;
  const b = den === 0 ? 0 : (n * sxy - sx * sy) / den;
  return { a: (sy - b * sx) / n, b };
}

interface Fit {
  a: number;
  b: number;
  /** Which input points the fit kept. */
  kept: boolean[];
  /** RMS distance of the kept points from the line. */
  rms: number;
}

/** Fit a line, dropping points far from it (a few passes). */
function robustLine(xs: number[], ys: number[]): Fit {
  let kept = xs.map(() => true);
  let fit = linear(xs, ys);
  const residuals = () => xs.map((x, i) => ys[i]! - (fit.a + fit.b * x));
  for (let pass = 0; pass < 4; pass++) {
    const res = residuals();
    const use = res.filter((_, i) => kept[i]);
    const centre = median(use);
    const sigma = 1.4826 * median(use.map((r) => Math.abs(r - centre)));
    const limit = Math.max(0.0005, 3 * sigma);
    const next = res.map((r) => Math.abs(r - centre) <= limit);
    if (next.filter(Boolean).length < Math.min(3, xs.length)) break;
    kept = next;
    fit = linear(
      xs.filter((_, i) => kept[i]),
      ys.filter((_, i) => kept[i]),
    );
  }
  const res = residuals().filter((_, i) => kept[i]);
  const rms = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / Math.max(1, res.length));
  return { ...fit, kept, rms };
}

/** Linear resampling of one scan to the picture width (identity when equal). */
function toWidth(src: Float32Array, width: number): Float32Array {
  if (src.length === width) return src;
  const out = new Float32Array(width);
  const k = src.length / width;
  for (let x = 0; x < width; x++) {
    const p = clamp((x + 0.5) * k - 0.5, 0, src.length - 1);
    const i = Math.floor(p);
    const j = Math.min(src.length - 1, i + 1);
    out[x] = src[i]! + (p - i) * (src[j]! - src[i]!);
  }
  return out;
}

/** Y, R-Y, B-Y to RGB (the JPEG / Robot paper constants: R = Y + 1.402 (Cr - 128)...). */
function yccToRgb(y: number, cr: number, cb: number): [number, number, number] {
  const r = y + 1.402 * (cr - 128);
  const g = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
  const b = y + 1.772 * (cb - 128);
  return [clamp(Math.round(r), 0, 255), clamp(Math.round(g), 0, 255), clamp(Math.round(b), 0, 255)];
}

/** The header to follow, from the `transmission` and `start` options. */
function pickHeader(headers: VisHit[], o: SstvOptions): VisHit | null {
  if (o.start > 0) return headers.find((h) => Math.abs(h.imageStart - o.start) < 1.5) ?? null;
  if (!headers.length) return null;
  if (o.transmission > headers.length) {
    throw new SstvFailure('noTransmission', { n: o.transmission, count: headers.length });
  }
  return headers[o.transmission - 1]!;
}

/** Pixel windows touching the ends of a scan are smeared by the tone next to the scan. */
function trimEdges(scan: Float32Array, pixelMs: number): void {
  const e = clamp(Math.round(0.6 / pixelMs), 1, 4);
  const n = scan.length;
  if (n < 2 * e + 2) return;
  for (let i = 0; i < e; i++) {
    scan[i] = scan[e]!;
    scan[n - 1 - i] = scan[n - 1 - e]!;
  }
}

export function decodeSstv(d: Demod, o: SstvOptions): SstvResult {
  const endT = endTime(d);
  const headers = findVisHeaders(d);
  const header = pickHeader(headers, o);

  // ---- the mode, when the header or the user says
  const chosen = o.mode === 'auto' ? undefined : modeById(o.mode);
  let mode: SstvMode | null = chosen ?? (header ? (modeByVis(header.code) ?? null) : null);
  let modeSource: SstvResult['modeSource'] = chosen ? 'chosen' : 'vis';

  // ---- sync pulses and their rhythm
  const known = o.start > 0 ? o.start : header ? header.imageStart : null;
  if (known !== null && known >= endT - 0.05) throw new SstvFailure('startBeyond', { s: known });
  const scale0 = header ? header.scale : 1;
  const lowHz0 = header ? header.lowHz : FREQ_SYNC;
  const horizon =
    mode && known !== null
      ? known + (sequencesOf(mode) + 2) * (mode.period / 1000) * scale0 * 1.04 + 0.5
      : endT;
  const pulses = findSyncPulses(d, known !== null ? known - 0.01 : d.t0, horizon, lowHz0);
  let tMin = 0.135;
  let tMax = 1.2;
  if (mode) {
    const tol = header ? 0.02 : 0.1;
    tMin = (mode.period / 1000) * scale0 * (1 - tol);
    tMax = (mode.period / 1000) * scale0 * (1 + tol);
  }
  const chain = findProgression(pulses, tMin, tMax);
  if (!chain) {
    const said = header ? modeByVis(header.code) : undefined;
    if (chosen && said && said.id !== chosen.id) {
      throw new SstvFailure('modeMismatch', { vis: said.name, chosen: chosen.name });
    }
    throw new SstvFailure('noSync', { vis: header ? 1 : 0 });
  }
  const chainTimes = chain.members.map((m) => pulses[m]!.time);
  const chainFit = linear(chain.lines, chainTimes);

  let alternatives: SstvMode[] = [];
  if (!mode) {
    // The line time says most; the pulse length (4.9, 9 or 20 ms) settles close calls.
    const width = median(chain.members.map((m) => pulses[m]!.width));
    const ranked = MODES.map((m) => {
      const timing = Math.abs(Math.log(chainFit.b / (m.period / 1000)));
      return { mode: m, timing, err: timing + 0.08 * Math.abs(Math.log(width / m.syncMs)) };
    }).sort((a, b) => a.err - b.err);
    const top = ranked[0]!;
    // Without a mode from the header the rhythm alone must be convincing: a long run, with few
    // pulses missing.
    const span = chain.lines[chain.lines.length - 1]! - chain.lines[0]! + 1;
    if (chain.members.length < 6 || chain.members.length < 0.5 * span) {
      throw new SstvFailure('noSync', { vis: header ? 1 : 0 });
    }
    if (top.timing > 0.08) {
      throw new SstvFailure(header ? 'unknownMode' : 'noMode', {
        period: Math.round(chainFit.b * 1000),
        code: header ? header.code : 0,
      });
    }
    mode = top.mode;
    modeSource = 'inferred';
    alternatives = ranked
      .slice(1)
      .filter((c) => c.err < Math.max(0.03, top.err + 0.015))
      .map((c) => c.mode);
  }

  // ---- number the pulses: line 0 is the one at the picture start
  const nominal = mode.period / 1000;
  const sequences = sequencesOf(mode);
  const centreOffset = syncCentre(mode) / 1000;
  const firstCentre = known !== null ? known + centreOffset * (chainFit.b / nominal) : null;
  const numbered = chain.members
    .map((m, i) => ({
      line:
        firstCentre !== null
          ? Math.round((pulses[m]!.time - firstCentre) / chainFit.b)
          : chain.lines[i]! - chain.lines[0]!,
      time: pulses[m]!.time,
    }))
    .filter((n) => n.line >= 0 && n.line < sequences + 5);
  if (numbered.length < 3) throw new SstvFailure('noSync', { vis: header ? 1 : 0 });
  const manual = o.slant === 'manual';
  let period = manual ? nominal * (1 + o.clockPpm / 1e6) : chainFit.b;
  let c0: number;
  if (manual) {
    c0 = median(numbered.slice(0, 12).map((n) => n.time - n.line * period));
  } else {
    c0 = linear(
      numbered.map((n) => n.line),
      numbered.map((n) => n.time),
    ).a;
  }
  const lineStartOf = (c: number, p: number, k: number) => c + k * p - centreOffset * (p / nominal);
  // A last line cut short by a few ms (the end of a file) is still read.
  const available = (c: number, p: number) =>
    clamp(Math.floor((endT + 0.005 - lineStartOf(c, p, 0)) / p), 0, sequences);

  // ---- locate every pulse precisely, fit the line time
  let count = available(c0, period);
  if (count < 1) throw new SstvFailure('noLines');
  let hits: { line: number; time: number; strength: number }[] = [];
  // What a sync pulse sounds like here, so that silence and noise between transmissions are not
  // mistaken for one.
  const pulseHalf = Math.max(0.001, 0.0004 * mode.syncMs);
  const floor =
    0.1 *
    median(
      chainTimes.map((t) => toneAt(d, t - pulseHalf, t + pulseHalf).power).filter((v) => v > 0),
    );
  // A line also has a picture after its pulse: a train of beeps in silence is not SSTV.
  const firstScan = scansOf(mode, 0)[0]!;
  const lastScan = scansOf(mode, 0).at(-1)!;
  const locate = () => {
    hits = [];
    for (let k = 0; k < count; k++) {
      const r = refineSync(d, c0 + k * period, mode.syncMs, lowHz0, 0.0035, floor);
      if (!r) continue;
      const start = lineStartOf(c0, period, k);
      const rho = period / nominal;
      const video = toneAt(
        d,
        start + (firstScan.start / 1000) * rho,
        start + ((lastScan.start + lastScan.length) / 1000) * rho,
      );
      // Video is never below black (1500 Hz): a picture that averages at the sync tone is not one.
      if (video.power >= floor && video.freq > lowHz0 + 200) {
        hits.push({ line: k, time: r.time, strength: r.strength });
      }
    }
  };
  locate();
  let jitter = 0;
  if (!manual && hits.length >= 3) {
    for (let pass = 0; pass < 2; pass++) {
      const fit = robustLine(
        hits.map((h) => h.line),
        hits.map((h) => h.time),
      );
      c0 = fit.a;
      period = fit.b;
      jitter = fit.rms * 1000;
      hits = hits.filter((_, i) => fit.kept[i]);
      if (pass === 0) {
        count = available(c0, period);
        if (count < 1) throw new SstvFailure('noLines');
        locate();
      }
    }
  } else if (hits.length) {
    c0 += median(hits.map((h) => h.time - (c0 + period * h.line)));
  }
  if (!manual) {
    // The picture ends where the pulses stop: after that it is noise or another signal. A lone
    // pulse-like blip in the noise does not extend it.
    let last = -1;
    hits.forEach((h, i) => {
      if (i > 0 && h.line - hits[i - 1]!.line <= 4) last = h.line;
    });
    if (last < 0) throw new SstvFailure('noSync', { vis: header ? 1 : 0 });
    count = Math.min(count, last + 1);
    hits = hits.filter((h) => h.line < count);
  } else {
    count = presentLines(d, count, (k) => lineStartOf(c0, period, k), period);
  }
  const rho = period / nominal;

  // Per-line position: the fit plus the local (median of +-4 lines) drift the pulses show.
  const starts = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    let corr = 0;
    if (!manual) {
      const near = hits
        .filter((h) => Math.abs(h.line - k) <= 4)
        .map((h) => h.time - (c0 + period * h.line));
      if (near.length >= 3) corr = median(near);
    }
    starts[k] = lineStartOf(c0 + corr, period, k);
  }

  // ---- tone calibration
  const halfSync = Math.max(0.0012, 0.0003 * mode.syncMs);
  const syncTones = hits
    .map((h) => toneAt(d, h.time - halfSync, h.time + halfSync))
    .filter((t) => t.power > 0)
    .map((t) => t.freq);
  let syncHz = FREQ_SYNC;
  let gain = 1;
  if (o.calibrate) {
    syncHz = syncTones.length >= 3 ? median(syncTones) : header ? header.lowHz : FREQ_SYNC;
    if (header && header.leaderHz - header.lowHz > 300) {
      gain = clamp(700 / (header.leaderHz - header.lowHz), 0.88, 1.14);
    } else if (Math.abs(rho - 1) > 0.002) {
      gain = clamp(rho, 0.88, 1.14);
    }
  }
  const freqOf = (f: number) => FREQ_SYNC + (f - syncHz) * gain;
  const level = (f: number) =>
    clamp(((freqOf(f) - FREQ_BLACK) / (FREQ_WHITE - FREQ_BLACK)) * 255, 0, 255);

  // ---- Robot 36: which lines carry R-Y (1500 Hz separator) and which B-Y (2300 Hz)?
  let flipped = false;
  if (mode.id === 'robot36') {
    let agree = 0;
    let differ = 0;
    for (let k = 0; k < count; k++) {
      const t = toneAt(d, starts[k]! + 0.1005 * rho, starts[k]! + 0.1035 * rho);
      if (!(t.power > 0)) continue;
      if (freqOf(t.freq) > 1900 === (k % 2 === 1)) agree++;
      else differ++;
    }
    flipped = differ > agree;
  }

  // ---- read the pixels
  const planesOf: Partial<Record<Plane, Float32Array>>[] = [];
  for (let k = 0; k < count; k++) {
    const planes: Partial<Record<Plane, Float32Array>> = {};
    for (const scan of scansOf(mode, k + (flipped ? 1 : 0))) {
      const out = new Float32Array(scan.pixels);
      const pixelMs = scan.length / scan.pixels;
      const base = starts[k]! + (scan.start / 1000) * rho;
      for (let x = 0; x < scan.pixels; x++) {
        const a = base + ((x * pixelMs) / 1000) * rho;
        out[x] = level(toneAt(d, a, a + (pixelMs / 1000) * rho).freq);
      }
      trimEdges(out, pixelMs);
      planes[scan.plane] = out;
    }
    planesOf.push(planes);
  }

  // ---- assemble the picture
  const width = mode.width;
  const rowCount = Math.min(mode.height, count * mode.rowsPerSequence);
  const data = new Uint8ClampedArray(width * rowCount * 4);
  const put = (row: number, x: number, r: number, g: number, b: number) => {
    const i = (row * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  const neutral = new Float32Array(width).fill(128);
  const plane = (k: number, p: Plane): Float32Array | undefined => {
    const v = planesOf[k]?.[p];
    return v ? toWidth(v, width) : undefined;
  };
  for (let k = 0; k < count; k++) {
    if (mode.colour === 'rgb') {
      const r = plane(k, 'R')!;
      const g = plane(k, 'G')!;
      const b = plane(k, 'B')!;
      for (let x = 0; x < width; x++) put(k, x, r[x]!, g[x]!, b[x]!);
      continue;
    }
    // Colour-difference scans: this sequence's own, else the partner line's (Robot 36).
    const cr = plane(k, 'Cr') ?? plane(k + 1, 'Cr') ?? plane(k - 1, 'Cr') ?? neutral;
    const cb = plane(k, 'Cb') ?? plane(k + 1, 'Cb') ?? plane(k - 1, 'Cb') ?? neutral;
    const rows: [number, Float32Array | undefined][] = [[k * mode.rowsPerSequence, plane(k, 'Y')]];
    if (mode.rowsPerSequence === 2) rows.push([k * 2 + 1, plane(k, 'Y2')]);
    for (const [row, y] of rows) {
      if (row >= rowCount || !y) continue;
      for (let x = 0; x < width; x++) {
        const [r, g, b] = yccToRgb(y[x]!, cr[x]!, cb[x]!);
        put(row, x, r, g, b);
      }
    }
  }

  return {
    mode,
    modeSource,
    alternatives,
    header,
    headers,
    image: { width, height: rowCount, data },
    sequences: count,
    expectedSequences: sequences,
    period,
    ppm: (period / nominal - 1) * 1e6,
    syncHits: hits.length,
    syncStrength: hits.length ? hits.reduce((s, h) => s + h.strength, 0) / hits.length : 0,
    jitterMs: jitter,
    syncHz,
    gain,
    parityFlipped: flipped,
    pictureStart: starts[0] ?? d.t0,
  };
}

/**
 * Lines up to the last one whose signal is not silence, for a line time set by hand (no pulses
 * to follow): a line counts when its power is above a tenth of the first lines' median.
 */
function presentLines(
  d: Demod,
  count: number,
  startOf: (k: number) => number,
  period: number,
): number {
  const power = (k: number) => toneAt(d, startOf(k), startOf(k) + period).power;
  const reference = median(Array.from({ length: Math.min(8, count) }, (_, k) => power(k)));
  let last = 0;
  for (let k = 0; k < count; k++) if (power(k) >= 0.1 * reference) last = k;
  return last + 1;
}
