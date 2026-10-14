import { defineTool, number } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { kmeans1d, median, mixToMono, round } from './_dsp';
import { Fft, hannWindow } from './_fft';
import { morseToText } from './_morse';

const T = toolT('morse-audio');

/** Two clusters count as separate (dot/dash, letter/word gap) when their centres differ by this much. */
const SPLIT_RATIO = 1.8;
/** Envelope resolution: roughly this many seconds per block. */
const BLOCK_SECONDS = 0.005;

export interface ToneSearch {
  freq: number;
  /** Peak power divided by the median power of the searched band. */
  prominence: number;
}

/** Loudest narrow-band component of the file (the keyed carrier), averaged over many frames. */
export function findDominantTone(x: Float32Array, sampleRate: number): ToneSearch | null {
  let n = 4096;
  while (n > 256 && n > x.length) n >>= 1;
  if (x.length < n) return null;
  const fft = new Fft(n);
  const win = hannWindow(n);
  const bins = n / 2 + 1;
  const binHz = sampleRate / n;
  const frames = Math.min(128, Math.max(1, Math.floor((x.length - n) / (n / 2)) + 1));
  const power = new Float64Array(bins);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let f = 0; f < frames; f++) {
    const start = frames === 1 ? 0 : Math.round((f * (x.length - n)) / (frames - 1));
    for (let i = 0; i < n; i++) {
      re[i] = x[start + i]! * win[i]!;
      im[i] = 0;
    }
    fft.forward(re, im);
    for (let k = 0; k < bins; k++) power[k] = power[k]! + re[k]! * re[k]! + im[k]! * im[k]!;
  }
  const kMin = Math.max(2, Math.ceil(150 / binHz));
  const kMax = Math.min(bins - 2, Math.floor(Math.min(sampleRate / 2 - 100, 6000) / binHz));
  if (kMax <= kMin + 4) return null;
  let peak = kMin;
  for (let k = kMin; k <= kMax; k++) if (power[k]! > power[peak]!) peak = k;
  if (power[peak]! <= 0) return null;
  const band = Array.from(power.subarray(kMin, kMax + 1));
  const prominence = power[peak]! / Math.max(median(band), 1e-30);
  const lg = (k: number) => Math.log(power[k]! + 1e-30);
  const l = lg(peak - 1);
  const c = lg(peak);
  const r = lg(peak + 1);
  const d = l - 2 * c + r;
  const delta = d === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d));
  return { freq: (peak + delta) * binHz, prominence };
}

/** Amplitude envelope: I/Q demodulation at `tone`, or rectify-and-smooth when `tone` is null. */
function envelope(
  x: Float32Array,
  sampleRate: number,
  tone: number | null,
): { env: Float64Array; rate: number } {
  if (tone === null) {
    const block = Math.max(8, Math.round(sampleRate * BLOCK_SECONDS));
    const nb = Math.floor(x.length / block);
    let mean = 0;
    for (let i = 0; i < x.length; i++) mean += x[i]!;
    mean /= Math.max(1, x.length);
    const env = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      let s = 0;
      for (let i = b * block; i < (b + 1) * block; i++) s += Math.abs(x[i]! - mean);
      env[b] = s / block;
    }
    return { env, rate: sampleRate / block };
  }
  // A whole number of carrier periods per block keeps the 2f ripple out of the envelope.
  const periods = Math.max(2, Math.round(BLOCK_SECONDS * tone));
  const block = Math.max(8, Math.round((periods * sampleRate) / tone));
  const nb = Math.floor(x.length / block);
  const w = (2 * Math.PI * tone) / sampleRate;
  const cr = Math.cos(w);
  const sr = Math.sin(w);
  const env = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    const start = b * block;
    let c = Math.cos(w * start);
    let s = Math.sin(w * start);
    let si = 0;
    let sq = 0;
    for (let i = 0; i < block; i++) {
      const v = x[start + i]!;
      si += v * c;
      sq += v * s;
      const nc = c * cr - s * sr;
      s = s * cr + c * sr;
      c = nc;
    }
    env[b] = (2 * Math.hypot(si, sq)) / block;
  }
  return { env, rate: sampleRate / block };
}

interface Run {
  on: boolean;
  n: number;
}

/** Split the envelope into on/off with a threshold halfway between the two level clusters. */
function keyingRuns(env: Float64Array): Run[] {
  let max = 0;
  for (const v of env) if (v > max) max = v;
  if (max <= 0 || env.length < 4) throw new ToolError(T('error.silent'));
  const floor = max * 0.01;
  const logs = Array.from(env, (v) => Math.log(Math.max(v, floor)));
  const km = kmeans1d(logs, 2);
  const [c0, c1] = km.centers;
  if (c1 === undefined || c0 === undefined || c1 - c0 < Math.log(3)) {
    throw new ToolError(T('error.noKeying'));
  }
  const low: number[] = [];
  const high: number[] = [];
  env.forEach((v, i) => (km.labels[i] === 0 ? low : high).push(v));
  const threshold = (median(low) + median(high)) / 2;

  let runs: Run[] = [];
  for (const v of env) {
    const on = v > threshold;
    const last = runs[runs.length - 1];
    if (last && last.on === on) last.n++;
    else runs.push({ on, n: 1 });
  }
  // Absorb glitches shorter than ~12 ms into their neighbours.
  const minLen = Math.max(2, Math.round(0.012 / BLOCK_SECONDS));
  for (;;) {
    let shortest = -1;
    runs.forEach((r, i) => {
      if (r.n < minLen && (shortest < 0 || r.n < runs[shortest]!.n)) shortest = i;
    });
    if (shortest < 0 || runs.length === 1) break;
    const run = runs[shortest]!;
    const from = Math.max(0, shortest - 1);
    const to = Math.min(runs.length - 1, shortest + 1);
    const total = runs.slice(from, to + 1).reduce((a, r) => a + r.n, 0);
    runs.splice(from, to - from + 1, { on: !run.on, n: total });
  }
  while (runs[0] && !runs[0].on) runs = runs.slice(1);
  while (runs.length && !runs[runs.length - 1]!.on) runs = runs.slice(0, -1);
  return runs;
}

function twoClusters(values: number[]): { lo: number; hi: number; split: boolean } {
  if (values.length < 2) return { lo: values[0] ?? 0, hi: values[0] ?? 0, split: false };
  const km = kmeans1d(values, 2);
  const lo = km.centers[0]!;
  const hi = km.centers[1]!;
  return {
    lo,
    hi,
    split: lo > 0 && km.counts[0]! > 0 && km.counts[1]! > 0 && hi / lo >= SPLIT_RATIO,
  };
}

export interface MorseAnalysis {
  /** Carrier in Hz, or null when the broadband envelope was used. */
  tone: number | null;
  /** Seconds per dot. */
  unit: number;
  wpm: number;
  dots: number;
  dashes: number;
  /** "... --- ... / ..." */
  symbols: string;
  text: string;
}

/** Decode keyed Morse from mono samples. `tone` 0 = auto-detect, `wpm` 0 = measure from the audio. */
export function analyseMorse(
  x: Float32Array,
  sampleRate: number,
  opts: { tone: number; wpm: number },
): MorseAnalysis {
  let tone: number | null = null;
  if (opts.tone > 0) tone = opts.tone;
  else {
    const found = findDominantTone(x, sampleRate);
    if (found && found.prominence >= 30) tone = found.freq;
  }
  if (tone !== null && tone >= sampleRate / 2) {
    throw new ToolError(T('error.nyquist', { tone, nyquist: sampleRate / 2 }));
  }
  const { env, rate } = envelope(x, sampleRate, tone);
  const runs = keyingRuns(env);
  const onD = runs.filter((r) => r.on).map((r) => r.n / rate);
  const offD = runs.filter((r) => !r.on).map((r) => r.n / rate);
  if (!onD.length) throw new ToolError(T('error.noBeeps'));

  // Dot length (the "unit") and the dot/dash boundary.
  let unit: number;
  let dashThreshold: number;
  if (opts.wpm > 0) {
    unit = 1.2 / opts.wpm;
    dashThreshold = 2 * unit;
  } else {
    const on = twoClusters(onD);
    if (on.split) {
      unit = (on.lo + on.hi / 3) / 2;
      dashThreshold = (on.lo + on.hi) / 2;
    } else {
      const m = median(onD);
      // One length only: dashes if it is much longer than the shortest pause, otherwise dots.
      const gaps = twoClusters(offD);
      const shortGap = offD.length ? (gaps.split ? gaps.lo : median(offD)) : m;
      const dashesOnly = offD.length > 0 && m / shortGap >= 2.2;
      unit = dashesOnly ? m / 3 : m;
      dashThreshold = 2 * unit;
    }
  }
  const letterThreshold = 2 * unit;
  let wordThreshold = 5 * unit;
  const longGaps = offD.filter((g) => g >= letterThreshold);
  if (longGaps.length >= 2) {
    const c = twoClusters(longGaps);
    if (c.split) wordThreshold = (c.lo + c.hi) / 2;
  }

  const words: string[][] = [[]];
  let current = '';
  let dots = 0;
  let dashes = 0;
  const flush = () => {
    if (current) words[words.length - 1]!.push(current);
    current = '';
  };
  for (const run of runs) {
    const d = run.n / rate;
    if (run.on) {
      if (d < dashThreshold) {
        current += '.';
        dots++;
      } else {
        current += '-';
        dashes++;
      }
    } else if (d >= letterThreshold) {
      flush();
      if (d >= wordThreshold) words.push([]);
    }
  }
  flush();
  const symbols = words
    .filter((w) => w.length)
    .map((w) => w.join(' '))
    .join(' / ');
  return {
    tone,
    unit,
    wpm: round(1.2 / unit, 1),
    dots,
    dashes,
    symbols,
    text: morseToText(symbols),
  };
}

export default defineTool({
  id: 'morse-audio',
  name: 'Morse from audio',
  category: 'audio',
  description:
    'Decode beeps (Morse code) in a recording: finds the pitch, the speed and the letters.',
  tags: ['morse', 'cw', 'beeps', 'telegraph', 'dit dah', 'dot dash', 'wpm'],
  input: 'audio',
  placeholder: 'Drop a WAV file with Morse beeps',
  options: {
    tone: number('Tone frequency (Hz)', 0, {
      min: 0,
      max: 20000,
      hint: '0 = detect automatically',
    }),
    wpm: number('Speed (WPM)', 0, { min: 0, max: 100, hint: '0 = measure from the audio' }),
  },
  examples: [
    {
      label: 'Morse at 700 Hz',
      input: { sample: 'audio-morse.wav' },
      expect: 'FLAG IS MORSE',
    },
    {
      label: 'Forced pitch and speed',
      input: { sample: 'audio-morse.wav' },
      options: { tone: 700, wpm: 15 },
      expect: '..-. .-.. .- --.',
    },
  ],
  run(audio, { tone, wpm }) {
    const mono = mixToMono(audio.channels);
    if (mono.length < audio.sampleRate * 0.1) {
      throw new ToolError(T('error.short'));
    }
    const r = analyseMorse(mono, audio.sampleRate, { tone, wpm });
    const out: Output[] = [
      { type: 'text', label: T('label.text'), value: r.text },
      { type: 'text', label: T('label.symbols'), value: r.symbols },
      {
        type: 'kv',
        entries: [
          [T('kv.tone'), r.tone === null ? T('value.noTone') : `${r.tone.toFixed(1)} Hz`],
          [T('kv.speed'), T('value.speed', { wpm: r.wpm })],
          [T('kv.dot'), `${(r.unit * 1000).toFixed(0)} ms`],
          [T('kv.beeps'), T('value.beeps', { dots: r.dots, dashes: r.dashes })],
        ],
      },
    ];
    if (r.text.includes('?')) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.invalid'),
      });
    }
    return out;
  },
});
