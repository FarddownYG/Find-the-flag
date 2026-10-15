/**
 * FM demodulation for SSTV: complex baseband + prefix sums of the phase-advance products.
 *
 * The recording is mixed down by 1700 Hz (the middle of the 1100-2300 Hz band), low-passed with a
 * linear-phase FIR (cut-off 1000 Hz) and decimated to about 11-22 kHz. With z[m] the complex
 * baseband, p[m] = z[m] * conj(z[m-1]) has the phase of the frequency advance per sample, and its
 * magnitude is the signal power. The sum of p over any time window therefore gives, in O(1) from
 * prefix sums, the mean frequency of that window as arg(sum): a "pulse-pair" estimate, weighted by
 * the signal power, so a quiet stretch hardly counts. A pixel, a sync pulse or a VIS bit is
 * simply a window. Band-limited noise reads as a steady tone at the middle of the band, 1700 Hz:
 * the power of a window is what tells a signal from silence.
 */

/** Centre of the mixing and the 1100-2300 Hz band, Hz. */
export const MIX_HZ = 1700;
const CUTOFF_HZ = 1000;
/** The mirror image of the band starts at 2800 Hz: the filter is done by then. */
const STOP_HZ = 2600;
/** Do not decimate below this complex rate. */
const MIN_RATE = 11000;

export interface Demod {
  /** Complex baseband rate, Hz. */
  rate: number;
  /** Time of baseband sample 0, seconds from the start of the recording. */
  t0: number;
  /** Number of baseband samples. */
  length: number;
  /** Prefix sums of p[m] (index m = 0..length-1, p[0] = 0). */
  re: Float64Array;
  im: Float64Array;
  abs: Float64Array;
}

export interface Tone {
  /** Mean frequency, Hz. */
  freq: number;
  /**
   * 0..1: how steady the frequency is across the window. Band-limited noise also scores high
   * (it is a steady 1700 Hz as far as this measure goes): use `power` to tell signal from silence.
   */
  coherence: number;
  /** Mean signal power of the window (arbitrary units, comparable within one recording). */
  power: number;
}

/** Hamming-windowed sinc low-pass, odd length, unit gain at DC. */
function lowPassTaps(rate: number): Float64Array {
  const half = Math.max(3, Math.round((1.65 * rate) / (STOP_HZ - CUTOFF_HZ)));
  const n = 2 * half + 1;
  const h = new Float64Array(n);
  const fc = CUTOFF_HZ / rate;
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const x = k - half;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (n - 1));
    h[k] = sinc * w;
    sum += h[k]!;
  }
  for (let k = 0; k < n; k++) h[k] = h[k]! / sum;
  return h;
}

/** Decimation factor for a recording at `rate` Hz. */
export const decimationFor = (rate: number): number => Math.max(1, Math.floor(rate / MIN_RATE));

/**
 * Demodulate x[from .. to) (sample indices into the recording). The first baseband sample is
 * centred on x[from], so times are exact: t = (from + m * decimation) / rate.
 */
export function demodulate(x: Float32Array, rate: number, from = 0, to = x.length): Demod {
  const d = decimationFor(rate);
  const taps = lowPassTaps(rate);
  const half = (taps.length - 1) >> 1;
  const n = Math.max(0, Math.floor((to - from - 1) / d) + 1);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const abs = new Float64Array(n);
  const step = (2 * Math.PI * MIX_HZ) / rate;
  const cs = Math.cos(step);
  const sn = Math.sin(step);
  const CHUNK = 4096;
  const mixRe = new Float64Array(CHUNK * d + taps.length);
  const mixIm = new Float64Array(CHUNK * d + taps.length);
  let prevRe = 0;
  let prevIm = 0;
  let accRe = 0;
  let accIm = 0;
  let accAbs = 0;
  for (let m0 = 0; m0 < n; m0 += CHUNK) {
    const m1 = Math.min(n, m0 + CHUNK);
    const c0 = from + m0 * d - half; // first input sample this chunk reads
    const count = (m1 - m0 - 1) * d + taps.length;
    // Mix x[c0 .. c0+count) down by MIX_HZ; the phase restarts exactly at every chunk.
    const frac = (MIX_HZ * (c0 % rate)) / rate;
    const phase = 2 * Math.PI * (frac - Math.floor(frac));
    let c = Math.cos(phase);
    let s = Math.sin(phase);
    for (let j = 0; j < count; j++) {
      const i = c0 + j;
      const v = i >= 0 && i < x.length ? x[i]! : 0;
      mixRe[j] = v * c;
      mixIm[j] = -v * s;
      const nc = c * cs - s * sn;
      s = c * sn + s * cs;
      c = nc;
    }
    for (let m = m0; m < m1; m++) {
      const base = (m - m0) * d;
      let zr = 0;
      let zi = 0;
      for (let k = 0; k < taps.length; k++) {
        const hk = taps[k]!;
        zr += hk * mixRe[base + k]!;
        zi += hk * mixIm[base + k]!;
      }
      if (m > 0) {
        const pr = zr * prevRe + zi * prevIm;
        const pi = zi * prevRe - zr * prevIm;
        accRe += pr;
        accIm += pi;
        accAbs += Math.hypot(pr, pi);
      }
      re[m] = accRe;
      im[m] = accIm;
      abs[m] = accAbs;
      prevRe = zr;
      prevIm = zi;
    }
  }
  return { rate: rate / d, t0: from / rate, length: n, re, im, abs };
}

/** Mean frequency and coherence of the window [a, b] seconds (recording time). */
export function toneAt(d: Demod, a: number, b: number): Tone {
  const last = d.length - 1;
  if (last < 1) return { freq: MIX_HZ, coherence: 0, power: 0 };
  let xa = (a - d.t0) * d.rate;
  let xb = (b - d.t0) * d.rate;
  if (xa < 0) xa = 0;
  if (xb > last) xb = last;
  if (!(xb - xa > 1e-9)) return { freq: MIX_HZ, coherence: 0, power: 0 };
  const ia = Math.min(last - 1, Math.floor(xa));
  const ib = Math.min(last - 1, Math.floor(xb));
  const fa = xa - ia;
  const fb = xb - ib;
  const re = d.re;
  const im = d.im;
  const abs = d.abs;
  const sr = re[ib]! + fb * (re[ib + 1]! - re[ib]!) - (re[ia]! + fa * (re[ia + 1]! - re[ia]!));
  const si = im[ib]! + fb * (im[ib + 1]! - im[ib]!) - (im[ia]! + fa * (im[ia + 1]! - im[ia]!));
  const sa =
    abs[ib]! + fb * (abs[ib + 1]! - abs[ib]!) - (abs[ia]! + fa * (abs[ia + 1]! - abs[ia]!));
  if (!(sa > 1e-18)) return { freq: MIX_HZ, coherence: 0, power: 0 };
  return {
    freq: MIX_HZ + (Math.atan2(si, sr) * d.rate) / (2 * Math.PI),
    coherence: Math.min(1, Math.hypot(sr, si) / sa),
    power: sa / (xb - xa),
  };
}

/** End of the demodulated stretch, seconds. */
export const endTime = (d: Demod): number => d.t0 + (d.length - 1) / d.rate;
