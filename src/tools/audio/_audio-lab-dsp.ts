/**
 * Signal processing of the audio lab. Pure TypeScript, deterministic, no Web Audio: it runs in
 * the tool worker and in Node alike.
 *
 * - reverse: exact (samples in the opposite order);
 * - speed (pitch follows): band-limited resampling with a polyphase Kaiser-windowed sinc; when
 *   speeding up, the kernel is widened so it also low-passes below the new Nyquist (no aliasing);
 * - time-stretch (pitch kept): WSOLA, waveform-similarity overlap-add, aligned on the mono mix
 *   so every channel is cut at the same places (the stereo image stays intact);
 * - pitch shift (duration kept): time-stretch and resample by the same ratio;
 * - mid/side, channel comparison and a fast 16-bit PCM WAV encoder.
 */

// ---------- reverse ----------

/** The first `outLen` samples of `x` played backwards (= the last `outLen` samples, reversed). */
export function reversed(x: Float32Array, outLen = x.length): Float32Array {
  const n = Math.min(outLen, x.length);
  return x.slice(x.length - n).reverse();
}

// ---------- resampling ----------

/** Best fraction p/q close to v (> 0) with q <= maxDen (continued fractions). */
export function fraction(v: number, maxDen: number): [number, number] {
  let h0 = 0;
  let h1 = 1;
  let k0 = 1;
  let k1 = 0;
  let x = v;
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(x);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDen) {
      // Semiconvergent: the largest t with t * k1 + k0 <= maxDen may beat the last convergent.
      const t = Math.floor((maxDen - k0) / k1);
      const hs = t * h1 + h0;
      const ks = t * k1 + k0;
      if (ks > 0 && Math.abs(hs / ks - v) < Math.abs(h1 / k1 - v)) return [hs, ks];
      return [h1, k1];
    }
    h0 = h1;
    h1 = h2;
    k0 = k1;
    k1 = k2;
    const rest = x - a;
    if (rest < 1e-12 || Math.abs(h1 / k1 - v) <= 1e-15 * v) break;
    x = 1 / rest;
  }
  return [h1, k1];
}

/** Zeroth-order modified Bessel function (Kaiser window). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * Low-pass design: 16 zero crossings of the sinc on each side, Kaiser beta 7, -6 dB at 0.88 of
 * the (lower) Nyquist frequency. Flat (-0.3 dB) up to 0.8 of Nyquist, below -58 dB from Nyquist
 * on: 38 taps per output sample when slowing down, more when speeding up (the kernel widens).
 */
const ZEROS = 16;
const KAISER_BETA = 7;
const CUTOFF = 0.88;
/** Largest denominator of the speed ratio: one exact kernel per output phase. */
const MAX_PHASES = 1000;

/**
 * Changes speed and pitch together, like playing a tape faster or slower. Output sample j is the
 * band-limited value of the input at position j * speed. Speeding up (speed > 1) moves every
 * frequency up, so the kernel cuts below sampleRate / (2 * speed) first and nothing folds back.
 */
export class Resampler {
  /** Input samples consumed per output sample, as the exact fraction p / q. */
  readonly p: number;
  readonly q: number;
  private readonly taps: number;
  private readonly half: number;
  private readonly bank: Float32Array;

  constructor(speed: number) {
    if (!(speed > 0) || !Number.isFinite(speed)) throw new RangeError(`Bad speed ${speed}`);
    const [p, q] = fraction(speed, MAX_PHASES);
    this.p = p;
    this.q = q;
    const fc = CUTOFF * Math.min(1, q / p);
    const reach = ZEROS / fc; // kernel half-width in input samples
    const half = Math.ceil(reach);
    const taps = 2 * half;
    this.half = half;
    this.taps = taps;
    const bank = new Float32Array(q * taps);
    const i0b = besselI0(KAISER_BETA);
    for (let r = 0; r < q; r++) {
      const phase = r / q;
      let sum = 0;
      for (let m = 0; m < taps; m++) {
        const d = m - half + 1 - phase; // tap position minus the output position, in samples
        const u = d / reach;
        let v = 0;
        if (Math.abs(u) < 1) {
          const a = Math.PI * fc * d;
          const sinc = a === 0 ? 1 : Math.sin(a) / a;
          v = sinc * (besselI0(KAISER_BETA * Math.sqrt(1 - u * u)) / i0b);
        }
        bank[r * taps + m] = v;
        sum += v;
      }
      // Unity gain at DC for every phase, so no phase-dependent ripple appears.
      for (let m = 0; m < taps; m++) bank[r * taps + m] = bank[r * taps + m]! / sum;
    }
    this.bank = bank;
  }

  /** Output length that covers the whole input. */
  lengthFor(inputLength: number): number {
    return Math.round((inputLength * this.q) / this.p);
  }

  /** Resample every channel to `outLen` samples (stereo pairs share one pass over the kernel). */
  processAll(channels: Float32Array[], outLen?: number): Float32Array[] {
    const out: Float32Array[] = [];
    for (let c = 0; c < channels.length; c += 2) {
      const a = channels[c]!;
      const b = channels[c + 1];
      const len = outLen ?? this.lengthFor(a.length);
      if (b) out.push(...this.pair(a, b, len));
      else out.push(this.process(a, len));
    }
    return out;
  }

  process(x: Float32Array, outLen = this.lengthFor(x.length)): Float32Array {
    const { p, q, taps, half, bank } = this;
    const n = x.length;
    const out = new Float32Array(outLen);
    let i0 = 0; // integer part of the input position
    let r = 0; // fractional part, in 1/q
    for (let j = 0; j < outLen; j++) {
      const base = i0 - half + 1;
      const c = r * taps;
      const m0 = Math.max(0, -base);
      const m1 = Math.min(taps, n - base);
      let acc = 0;
      for (let m = m0; m < m1; m++) acc += bank[c + m]! * x[base + m]!;
      out[j] = acc;
      r += p;
      if (r >= q) {
        const step = Math.floor(r / q);
        i0 += step;
        r -= step * q;
      }
    }
    return out;
  }

  /** Two channels of the same length in one loop: each kernel value is loaded once. */
  private pair(x: Float32Array, y: Float32Array, outLen: number): [Float32Array, Float32Array] {
    const { p, q, taps, half, bank } = this;
    const n = Math.min(x.length, y.length);
    const ox = new Float32Array(outLen);
    const oy = new Float32Array(outLen);
    let i0 = 0;
    let r = 0;
    for (let j = 0; j < outLen; j++) {
      const base = i0 - half + 1;
      const c = r * taps;
      const m0 = Math.max(0, -base);
      const m1 = Math.min(taps, n - base);
      let ax = 0;
      let ay = 0;
      for (let m = m0; m < m1; m++) {
        const k = bank[c + m]!;
        ax += k * x[base + m]!;
        ay += k * y[base + m]!;
      }
      ox[j] = ax;
      oy[j] = ay;
      r += p;
      if (r >= q) {
        const step = Math.floor(r / q);
        i0 += step;
        r -= step * q;
      }
    }
    return [ox, oy];
  }
}

// ---------- time-stretch (WSOLA) ----------

export interface WsolaParams {
  /** Frame length in samples (even). Default 30 ms. */
  frame?: number;
  /** Search tolerance around the nominal position, in samples. Default 12 ms. */
  tolerance?: number;
}

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Sum of a[ia + i] * b[ib + i] for i in [0, len), samples outside the arrays being 0. */
function dot(a: Float32Array, ia: number, b: Float32Array, ib: number, len: number): number {
  const i0 = Math.max(0, -ia, -ib);
  const i1 = Math.min(len, a.length - ia, b.length - ib);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let i = i0;
  for (; i + 3 < i1; i += 4) {
    s0 += a[ia + i]! * b[ib + i]!;
    s1 += a[ia + i + 1]! * b[ib + i + 1]!;
    s2 += a[ia + i + 2]! * b[ib + i + 2]!;
    s3 += a[ia + i + 3]! * b[ib + i + 3]!;
  }
  for (; i < i1; i++) s0 += a[ia + i]! * b[ib + i]!;
  return s0 + s1 + s2 + s3;
}

const sq = (x: Float32Array, i: number) => (i >= 0 && i < x.length ? x[i]! * x[i]! : 0);

/** Box-filtered decimation by d, used for the coarse alignment search. */
function decimate(x: Float32Array, d: number): Float32Array {
  if (d === 1) return x;
  const out = new Float32Array(Math.ceil(x.length / d));
  for (let i = 0, j = 0; j < out.length; j++) {
    let s = 0;
    const end = Math.min(x.length, i + d);
    for (; i < end; i++) s += x[i]!;
    out[j] = s / d;
  }
  return out;
}

/** Normalised cross-correlation score of candidate start b against the template at c. */
function score(x: Float32Array, c: number, b: number, len: number, energy: number): number {
  // The sliding energy can drift a hair below 0 over silence: clamp before the square root.
  return dot(x, c, x, b, len) / Math.sqrt(Math.max(0, energy) + 1e-10);
}

/**
 * WSOLA frame placement: input start of every output frame. Output frame k covers
 * [(k - 1) * hop, (k - 1) * hop + frame); its input frame is searched within ±tolerance of the
 * nominal position, as the segment most similar to the natural continuation of frame k - 1.
 */
export function wsolaStarts(
  mono: Float32Array,
  sampleRate: number,
  outLen: number,
  params: WsolaParams = {},
): { starts: Int32Array; frame: number; hop: number } {
  const hop = Math.max(8, Math.round((params.frame ?? 0.03 * sampleRate) / 2));
  const frame = 2 * hop;
  const tol = Math.max(1, Math.round(params.tolerance ?? 0.012 * sampleRate));
  const n = mono.length;
  const ratio = outLen > 0 ? n / outLen : 1; // input samples per output sample
  const frames = outLen > 0 ? Math.floor((outLen - 1) / hop) + 2 : 0;
  const starts = new Int32Array(frames);
  const d = Math.max(1, Math.round(sampleRate / 4000));
  const dec = decimate(mono, d);
  // Similarity is measured on the cross-fade region (the first half of the frame).
  const decLen = Math.max(4, Math.round(hop / d));
  const fine = Math.ceil(d / 2) + 1;

  let prev = -hop;
  for (let k = 0; k < frames; k++) {
    const nominal = Math.round(k * hop * ratio) - hop;
    if (k === 0) {
      starts[0] = nominal;
      prev = nominal;
      continue;
    }
    const lo = nominal - tol;
    const hi = nominal + tol;
    const c = prev + hop; // where frame k - 1 would naturally continue
    // Coarse search on the decimated signal (normalised cross-correlation).
    const tc = Math.round(c / d);
    let bestCoarse = Math.round(nominal / d);
    let bestCoarseScore = -Infinity;
    const qLo = Math.ceil(lo / d);
    const qHi = Math.floor(hi / d);
    let e = 0;
    for (let i = 0; i < decLen; i++) e += sq(dec, qLo + i);
    for (let qd = qLo; qd <= qHi; qd++) {
      const s = score(dec, tc, qd, decLen, e);
      if (s > bestCoarseScore) {
        bestCoarseScore = s;
        bestCoarse = qd;
      }
      e += sq(dec, qd + decLen) - sq(dec, qd);
    }
    // Refinement at full resolution around the coarse winner; the natural continuation itself
    // wins ties, so a stretch of 1 is the identity.
    let best = c >= lo && c <= hi ? c : nominal;
    let bestScore = score(mono, c, best, hop, energyAt(mono, best, hop));
    const fLo = Math.max(lo, bestCoarse * d - fine);
    const fHi = Math.min(hi, bestCoarse * d + fine);
    let ef = energyAt(mono, fLo, hop);
    for (let b = fLo; b <= fHi; b++) {
      const s = score(mono, c, b, hop, ef);
      if (s > bestScore + 1e-12 * Math.abs(bestScore)) {
        bestScore = s;
        best = b;
      }
      ef += sq(mono, b + hop) - sq(mono, b);
    }
    starts[k] = best;
    prev = best;
  }
  return { starts, frame, hop };
}

function energyAt(x: Float32Array, start: number, len: number): number {
  let e = 0;
  for (let i = 0; i < len; i++) e += sq(x, start + i);
  return e;
}

/** Overlap-add frames of `x` placed by {@link wsolaStarts} (Hann, 50 %: the windows sum to 1). */
export function overlapAdd(
  x: Float32Array,
  starts: Int32Array,
  frame: number,
  hop: number,
  outLen: number,
): Float32Array {
  const out = new Float32Array(outLen);
  const w = hann(frame);
  for (let k = 0; k < starts.length; k++) {
    const o = (k - 1) * hop;
    const s = starts[k]!;
    const i0 = Math.max(0, -o, -s);
    const i1 = Math.min(frame, outLen - o, x.length - s);
    for (let i = i0; i < i1; i++) out[o + i] = out[o + i]! + w[i]! * x[s + i]!;
  }
  return out;
}

/** Average of the channels (the input itself when there is only one). */
export function mix(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first || channels.length === 1) return first ?? new Float32Array(0);
  const out = new Float32Array(first.length);
  const second = channels[1]!;
  if (channels.length === 2) {
    for (let i = 0; i < out.length; i++) out[i] = (first[i]! + second[i]!) / 2;
    return out;
  }
  const k = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] = out[i]! + ch[i]! * k;
  return out;
}

/** Change the duration to `outLen` samples without changing the pitch (WSOLA). */
export function timeStretch(
  channels: Float32Array[],
  sampleRate: number,
  outLen: number,
  params: WsolaParams = {},
): Float32Array[] {
  const first = channels[0];
  if (!first) return [];
  if (outLen === first.length) return channels;
  const { starts, frame, hop } = wsolaStarts(mix(channels), sampleRate, outLen, params);
  return channels.map((ch) => overlapAdd(ch, starts, frame, hop, outLen));
}

/**
 * Move the pitch by `semitones` and keep the duration: resample by the pitch ratio, then
 * time-stretch back to the original length (or the reverse order when lowering, so the
 * intermediate signal is never longer than the input).
 */
export function pitchShift(
  channels: Float32Array[],
  sampleRate: number,
  semitones: number,
): Float32Array[] {
  const first = channels[0];
  if (!first || semitones === 0) return channels;
  const len = first.length;
  const ratio = 2 ** (semitones / 12);
  const rs = new Resampler(ratio);
  if (ratio > 1) {
    return timeStretch(rs.processAll(channels), sampleRate, len);
  }
  const shorter = timeStretch(channels, sampleRate, Math.max(1, Math.round(len * ratio)));
  return rs.processAll(shorter, len);
}

// ---------- channels ----------

export function midOf(l: Float32Array, r: Float32Array): Float32Array {
  const out = new Float32Array(l.length);
  for (let i = 0; i < out.length; i++) out[i] = (l[i]! + r[i]!) / 2;
  return out;
}

export function sideOf(l: Float32Array, r: Float32Array): Float32Array {
  const out = new Float32Array(l.length);
  for (let i = 0; i < out.length; i++) out[i] = (l[i]! - r[i]!) / 2;
  return out;
}

export interface ChannelComparison {
  /** Every sample of L equals the same sample of R. */
  identical: boolean;
  /** Largest |L - R|. */
  maxDiff: number;
  /** Index of the first sample where |L - R| is largest. */
  at: number;
  /** Samples where L != R. */
  differing: number;
}

export function compareChannels(l: Float32Array, r: Float32Array): ChannelComparison {
  let maxDiff = 0;
  let at = 0;
  let differing = 0;
  const n = Math.min(l.length, r.length);
  for (let i = 0; i < n; i++) {
    const dv = Math.abs(l[i]! - r[i]!);
    if (dv !== 0) {
      differing++;
      if (dv > maxDiff) {
        maxDiff = dv;
        at = i;
      }
    }
  }
  differing += Math.abs(l.length - r.length);
  return { identical: differing === 0, maxDiff, at, differing };
}

// ---------- levels ----------

export function peakOf(channels: Float32Array[]): number {
  let p = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]!);
      if (a > p) p = a;
    }
  }
  return p;
}

export function scaled(channels: Float32Array[], gain: number): Float32Array[] {
  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i]! * gain;
    return out;
  });
}

export const toDb = (v: number): number => 20 * Math.log10(Math.max(v, 1e-12));

// ---------- WAV ----------

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * 16-bit PCM WAV, channels interleaved. Samples are scaled by 32768 and clamped, so a 16-bit
 * input comes back bit for bit (k / 32768 * 32768 = k). Returns how many samples went beyond
 * full scale (|v| > 1) and were clipped.
 */
export function encodeWav16(
  channels: Float32Array[],
  sampleRate: number,
): { bytes: Uint8Array; clipped: number } {
  const nch = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * nch * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, nch, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * nch * 2, true);
  view.setUint16(32, nch * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let clipped = 0;
  // Native byte order is little-endian on every platform browsers run on: write in place.
  const count = frames * nch;
  const pcm = LITTLE_ENDIAN ? new Int16Array(bytes.buffer, 44, count) : new Int16Array(count);
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c]!;
    for (let i = 0, o = c; i < frames; i++, o += nch) {
      const x = ch[i]!;
      // floor(v + 0.5) is Math.round here (x * 32768 is exact) and much faster.
      let v = Math.floor(x * 32768 + 0.5);
      if (v > 32767) {
        v = 32767;
        if (x > 1) clipped++;
      } else if (v < -32768) {
        v = -32768;
        clipped++;
      }
      pcm[o] = v;
    }
  }
  if (!LITTLE_ENDIAN) for (let o = 0; o < count; o++) view.setInt16(44 + o * 2, pcm[o]!, true);
  return { bytes, clipped };
}
