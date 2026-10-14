/** Radix-2 FFT and window helpers shared by the audio tools. Pure JS, no allocation per call. */

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;
}

/** In-place complex FFT of a fixed power-of-two size (forward transform, e^-jωt). */
export class Fft {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    if (!isPowerOfTwo(size)) throw new RangeError(`FFT size must be a power of two, got ${size}.`);
    this.size = size;
    const half = size >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const a = (2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(a);
      this.sin[i] = -Math.sin(a);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** Transform `re`/`im` (both of length `size`) in place. */
  forward(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    const { rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k]!;
          const wi = sin[k]!;
          const a = i + j;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
  }
}

/** Periodic Hann window (the right choice for spectral analysis). */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
