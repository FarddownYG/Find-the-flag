import { describe, expect, it } from 'vitest';
import { Fft, hannWindow, isPowerOfTwo } from './_fft';
import { prng, sine } from './_synth';

describe('Fft', () => {
  it('puts a sine on the right bin with the right magnitude', () => {
    const n = 1024;
    const k = 37;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = 0.5 * Math.sin((2 * Math.PI * k * i) / n);
    new Fft(n).forward(re, im);
    let best = 0;
    for (let i = 1; i < n / 2; i++) {
      if (Math.hypot(re[i]!, im[i]!) > Math.hypot(re[best]!, im[best]!)) best = i;
    }
    expect(best).toBe(k);
    expect(Math.hypot(re[k]!, im[k]!)).toBeCloseTo((0.5 * n) / 2, 6);
    expect(Math.hypot(re[k + 5]!, im[k + 5]!)).toBeLessThan(1e-9);
  });

  it('matches a naive DFT on random data', () => {
    const n = 64;
    const rand = prng(5);
    const xr = Float64Array.from({ length: n }, () => rand() - 0.5);
    const xi = Float64Array.from({ length: n }, () => rand() - 0.5);
    const re = Float64Array.from(xr);
    const im = Float64Array.from(xi);
    new Fft(n).forward(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += xr[t]! * Math.cos(a) - xi[t]! * Math.sin(a);
        si += xr[t]! * Math.sin(a) + xi[t]! * Math.cos(a);
      }
      expect(re[k]!).toBeCloseTo(sr, 9);
      expect(im[k]!).toBeCloseTo(si, 9);
    }
  });

  it('obeys Parseval and handles the smallest sizes', () => {
    const x = sine(0.05, 8000, 1000);
    const n = 256;
    const re = Float64Array.from(x.subarray(0, n));
    const im = new Float64Array(n);
    let time = 0;
    for (const v of re) time += v * v;
    new Fft(n).forward(re, im);
    let freq = 0;
    for (let i = 0; i < n; i++) freq += re[i]! ** 2 + im[i]! ** 2;
    expect(freq / n).toBeCloseTo(time, 9);
    const two = [1, 2];
    const r2 = Float64Array.from(two);
    const i2 = new Float64Array(2);
    new Fft(2).forward(r2, i2);
    expect(Array.from(r2)).toEqual([3, -1]);
  });

  it('rejects sizes that are not powers of two', () => {
    expect(() => new Fft(1000)).toThrow(RangeError);
    expect(isPowerOfTwo(2048)).toBe(true);
    expect(isPowerOfTwo(0)).toBe(false);
  });

  it('builds a periodic Hann window', () => {
    const w = hannWindow(8);
    expect(w[0]).toBeCloseTo(0, 12);
    expect(w[4]).toBeCloseTo(1, 12);
    expect(w[2]).toBeCloseTo(0.5, 12);
  });
});
