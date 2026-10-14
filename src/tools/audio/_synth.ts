/** Test-signal generators (deterministic). Used by the audio tool tests only. */
import type { AudioInput } from '../../core/types';
import { textToMorse } from './_morse';

/** Seeded PRNG (mulberry32) returning floats in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Add roughly Gaussian noise (standard deviation `sigma`) in place. */
export function addNoise(x: Float32Array, sigma: number, seed = 1): Float32Array {
  if (sigma <= 0) return x;
  const rand = prng(seed);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let k = 0; k < 6; k++) s += rand();
    x[i] = x[i]! + (s - 3) * Math.SQRT2 * sigma;
  }
  return x;
}

export function sine(seconds: number, fs: number, freq: number, amp = 0.5): Float32Array {
  const x = new Float32Array(Math.round(seconds * fs));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs);
  return x;
}

/** Raised-cosine gate: 0 outside [start, end], ramps of `ramp` seconds inside. */
function gate(t: number, start: number, end: number, ramp: number): number {
  if (t < start || t > end) return 0;
  const edge = Math.min(t - start, end - t);
  return edge >= ramp ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / ramp);
}

const ROWS = [697, 770, 852, 941];
const COLS = [1209, 1336, 1477, 1633];
const KEYPAD = ['123A', '456B', '789C', '*0#D'];

export interface DtmfSynth {
  toneMs?: number;
  gapMs?: number;
  leadMs?: number;
  amp?: number;
  /** Extra gain of the column tone relative to the row tone (twist), as a factor. */
  colGain?: number;
  noise?: number;
  seed?: number;
}

export function synthDtmf(keys: string, fs: number, o: DtmfSynth = {}): Float32Array {
  const tone = (o.toneMs ?? 70) / 1000;
  const gap = (o.gapMs ?? 70) / 1000;
  const lead = (o.leadMs ?? 200) / 1000;
  const amp = o.amp ?? 0.4;
  const colGain = o.colGain ?? 0.9;
  const total = lead * 2 + keys.length * (tone + gap);
  const x = new Float32Array(Math.round(total * fs));
  [...keys].forEach((key, n) => {
    const r = KEYPAD.findIndex((line) => line.includes(key));
    const c = KEYPAD[r]!.indexOf(key);
    const start = lead + n * (tone + gap);
    for (
      let i = Math.floor(start * fs);
      i < Math.min(x.length, Math.ceil((start + tone) * fs));
      i++
    ) {
      const t = i / fs;
      const g = gate(t, start, start + tone, 0.003);
      x[i] =
        x[i]! +
        g *
          amp *
          (Math.sin(2 * Math.PI * ROWS[r]! * t) + colGain * Math.sin(2 * Math.PI * COLS[c]! * t));
    }
  });
  return addNoise(x, o.noise ?? 0, o.seed ?? 7);
}

export interface MorseSynth {
  wpm?: number;
  tone?: number;
  amp?: number;
  noise?: number;
  seed?: number;
  rampMs?: number;
  leadSeconds?: number;
}

export function synthMorse(text: string, fs: number, o: MorseSynth = {}): Float32Array {
  const unit = 1.2 / (o.wpm ?? 15);
  const tone = o.tone ?? 700;
  const amp = o.amp ?? 0.5;
  const ramp = (o.rampMs ?? 5) / 1000;
  const lead = o.leadSeconds ?? 0.5;
  const timeline: [boolean, number][] = [];
  textToMorse(text)
    .split(' / ')
    .forEach((word, wi) => {
      if (wi) timeline.push([false, 7]);
      word.split(' ').forEach((letter, li) => {
        if (li) timeline.push([false, 3]);
        [...letter].forEach((sym, si) => {
          if (si) timeline.push([false, 1]);
          timeline.push([true, sym === '.' ? 1 : 3]);
        });
      });
    });
  const length = timeline.reduce((a, [, u]) => a + u, 0) * unit;
  const x = new Float32Array(Math.round((lead * 2 + length) * fs));
  let at = lead;
  for (const [on, units] of timeline) {
    const end = at + units * unit;
    if (on) {
      for (let i = Math.floor(at * fs); i < Math.min(x.length, Math.ceil(end * fs)); i++) {
        const t = i / fs;
        x[i] = x[i]! + amp * gate(t, at, end, ramp) * Math.sin(2 * Math.PI * tone * t);
      }
    }
    at = end;
  }
  return addNoise(x, o.noise ?? 0, o.seed ?? 11);
}

export function audioInput(
  samples: Float32Array,
  sampleRate: number,
  name = 'test.wav',
): AudioInput {
  return { bytes: new Uint8Array(0), name, sampleRate, channels: [samples] };
}

/** Default option values of a tool (what the UI starts with), plus overrides. */
export function defaults(
  tool: { options?: Record<string, { default: unknown }> },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(tool.options ?? {})) out[k] = spec.default;
  return { ...out, ...extra };
}
