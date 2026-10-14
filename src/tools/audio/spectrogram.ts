import { defineTool, number, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import { buildColormap, type ColormapName } from './_colormap';
import { mixToMono } from './_dsp';
import { Fft, hannWindow } from './_fft';

/** Never render more columns than this; long files get a larger hop instead. */
const MAX_COLUMNS = 2000;
/** Short files are stretched (whole columns repeated) up to roughly this width. */
const MIN_IMAGE_WIDTH = 800;
const MIN_ROWS = 256;
const MAX_ROWS = 1024;

export interface SpectrogramParams {
  fftSize: number;
  /** 0..0.95 */
  overlap: number;
  /** Hz; <= 0 means up to Nyquist. */
  maxFreq: number;
  /** Hz; <= 0 means the lowest useful frequency (0 Hz linear, 20 Hz log). */
  minFreq: number;
  scale: 'linear' | 'log';
}

export interface Spectrogram {
  /** Time columns. */
  frames: number;
  /** Frequency rows, row 0 = lowest frequency. */
  rows: number;
  /** frames * rows decibel values (relative to a full-scale sine = 0 dB), frame-major. */
  db: Float32Array;
  hop: number;
  fftSize: number;
  binHz: number;
  fMin: number;
  fMax: number;
  /** Loudest value shown in the picture. */
  maxDb: number;
  peak: { freq: number; time: number; db: number };
  /** Frequency carrying the most energy over the whole file. */
  dominant: number;
}

/** Parabolic interpolation around bin `k` of a magnitude-like (dB) array. */
function refine(l: number, c: number, r: number): number {
  const d = l - 2 * c + r;
  return d === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d));
}

/** STFT with a Hann window, mapped onto an image-sized frequency axis. */
export function computeSpectrogram(
  x: Float32Array,
  sampleRate: number,
  p: SpectrogramParams,
): Spectrogram {
  const n = p.fftSize;
  const nyquist = sampleRate / 2;
  const binHz = sampleRate / n;
  const bins = n / 2 + 1;
  const fMax = Math.min(p.maxFreq > 0 ? p.maxFreq : nyquist, nyquist);
  const fMin = p.minFreq > 0 ? p.minFreq : p.scale === 'log' ? Math.max(20, binHz) : 0;
  if (fMax <= fMin) {
    throw new ToolError(
      `Max frequency (${fMax} Hz) must be above min frequency (${fMin} Hz). Raise "Max frequency" or lower "Min frequency".`,
    );
  }

  // Time axis: honour the overlap, but never exceed MAX_COLUMNS columns.
  const len = x.length;
  const overlap = Math.min(0.95, Math.max(0, p.overlap));
  let hop = Math.max(1, Math.round(n * (1 - overlap)));
  let frames = len > n ? Math.ceil((len - n) / hop) + 1 : 1;
  if (frames > MAX_COLUMNS) {
    hop = Math.ceil((len - n) / (MAX_COLUMNS - 1));
    frames = Math.ceil((len - n) / hop) + 1;
  }

  // Frequency axis: one image row per sample of the (linear or log) axis.
  const rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round((fMax - fMin) / binHz)));
  const freqAt = (t: number): number => {
    const u = Math.min(1, Math.max(0, t));
    return p.scale === 'log' ? fMin * (fMax / fMin) ** u : fMin + (fMax - fMin) * u;
  };
  const first = new Int32Array(rows);
  const last = new Int32Array(rows);
  const frac = new Float32Array(rows);
  const useMax = new Uint8Array(rows);
  for (let r = 0; r < rows; r++) {
    const centre = freqAt(r / (rows - 1));
    const lo = freqAt((r - 0.5) / (rows - 1));
    const hi = freqAt((r + 0.5) / (rows - 1));
    if ((hi - lo) / binHz <= 1) {
      const b = Math.min(bins - 1, centre / binHz);
      const a = Math.floor(b);
      first[r] = a;
      last[r] = Math.min(bins - 1, a + 1);
      frac[r] = b - a;
    } else {
      useMax[r] = 1;
      first[r] = Math.max(0, Math.min(bins - 1, Math.ceil(lo / binHz)));
      last[r] = Math.max(first[r]!, Math.min(bins - 1, Math.floor(hi / binHz)));
    }
  }
  const kLo = Math.max(0, Math.floor(fMin / binHz));
  const kHi = Math.min(bins - 1, Math.ceil(fMax / binHz));

  const fft = new Fft(n);
  const win = hannWindow(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) wsum += win[i]!;
  const scale2 = (2 / wsum) ** 2; // a full-scale sine reads 0 dB
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const dbBin = new Float32Array(bins);
  const meanPow = new Float64Array(bins);
  const db = new Float32Array(frames * rows);
  let maxDb = -Infinity;
  let peakDb = -Infinity;
  let peakBin = kLo;
  let peakFrame = 0;
  let peakNeighbours: [number, number] = [0, 0];

  for (let t = 0; t < frames; t++) {
    const start = t * hop;
    for (let i = 0; i < n; i++) {
      const s = start + i;
      re[i] = s < len ? x[s]! * win[i]! : 0;
      im[i] = 0;
    }
    fft.forward(re, im);
    for (let k = 0; k < bins; k++) {
      const pw = (re[k]! * re[k]! + im[k]! * im[k]!) * scale2;
      meanPow[k] = meanPow[k]! + pw;
      dbBin[k] = 10 * Math.log10(pw + 1e-20);
    }
    for (let k = kLo; k <= kHi; k++) {
      if (dbBin[k]! > peakDb) {
        peakDb = dbBin[k]!;
        peakBin = k;
        peakFrame = t;
        peakNeighbours = [dbBin[Math.max(0, k - 1)]!, dbBin[Math.min(bins - 1, k + 1)]!];
      }
    }
    const base = t * rows;
    for (let r = 0; r < rows; r++) {
      const a = first[r]!;
      const b = last[r]!;
      let v: number;
      if (useMax[r]) {
        v = dbBin[a]!;
        for (let k = a + 1; k <= b; k++) if (dbBin[k]! > v) v = dbBin[k]!;
      } else {
        v = dbBin[a]! * (1 - frac[r]!) + dbBin[b]! * frac[r]!;
      }
      db[base + r] = v;
      if (v > maxDb) maxDb = v;
    }
  }

  let domBin = kLo;
  for (let k = kLo; k <= kHi; k++) if (meanPow[k]! > meanPow[domBin]!) domBin = k;
  const lg = (k: number) => Math.log(meanPow[Math.max(0, Math.min(bins - 1, k))]! + 1e-30);
  const domDelta = refine(lg(domBin - 1), lg(domBin), lg(domBin + 1));

  return {
    frames,
    rows,
    db,
    hop,
    fftSize: n,
    binHz,
    fMin,
    fMax,
    maxDb,
    peak: {
      freq: (peakBin + refine(peakNeighbours[0], peakDb, peakNeighbours[1])) * binHz,
      time: (peakFrame * hop + n / 2) / sampleRate,
      db: peakDb,
    },
    dominant: (domBin + domDelta) * binHz,
  };
}

export interface RenderParams {
  colormap: ColormapName;
  /** Dynamic range shown, in dB below the loudest value. */
  floor: number;
  /** Values this far below the loudest are already drawn at full brightness. */
  ceiling: number;
}

/** Colour the dB matrix: time to the right, frequency upwards (row 0 at the bottom). */
export function renderSpectrogram(sp: Spectrogram, p: RenderParams): RgbaImage {
  const lut = buildColormap(p.colormap);
  const rep =
    sp.frames >= MIN_IMAGE_WIDTH ? 1 : Math.min(16, Math.floor(MIN_IMAGE_WIDTH / sp.frames));
  const width = sp.frames * rep;
  const height = sp.rows;
  const data = new Uint8ClampedArray(width * height * 4);
  const lowest = sp.maxDb - p.floor;
  const span = Math.max(1e-6, p.floor - p.ceiling);
  for (let t = 0; t < sp.frames; t++) {
    for (let r = 0; r < sp.rows; r++) {
      const v = Math.min(1, Math.max(0, (sp.db[t * sp.rows + r]! - lowest) / span));
      const c = Math.round(v * 255) * 3;
      const y = height - 1 - r;
      for (let k = 0; k < rep; k++) {
        const o = (y * width + t * rep + k) * 4;
        data[o] = lut[c]!;
        data[o + 1] = lut[c + 1]!;
        data[o + 2] = lut[c + 2]!;
        data[o + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

const fmtHz = (f: number) => `${f.toFixed(f >= 100 ? 1 : 2)} Hz`;

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(2).padStart(5, '0')} (${seconds.toFixed(1)} s)`;
}

export default defineTool({
  id: 'spectrogram',
  name: 'Spectrogram',
  category: 'audio',
  description:
    'Draw an audio file as a spectrogram to reveal text or pictures hidden in the sound.',
  tags: [
    'sonic visualiser',
    'audacity',
    'fft',
    'stft',
    'frequency',
    'waveform',
    'audio steganography',
  ],
  input: 'audio',
  placeholder: 'Drop a WAV file (MP3/OGG/FLAC work in browsers that can decode them)',
  options: {
    fftSize: select('FFT size', ['256', '512', '1024', '2048', '4096', '8192'], '2048', {
      hint: 'Small = sharp in time, large = sharp in frequency',
    }),
    overlap: number('Overlap %', 75, { min: 0, max: 95, step: 5 }),
    channel: toggle('Channel', [
      { value: 'mix', label: 'Mix' },
      { value: 'left', label: 'Left' },
      { value: 'right', label: 'Right' },
      { value: 'diff', label: 'L − R' },
    ]),
    scale: toggle('Frequency axis', [
      { value: 'linear', label: 'Linear' },
      { value: 'log', label: 'Log' },
    ]),
    colormap: select(
      'Colours',
      [
        { value: 'inferno', label: 'Inferno' },
        { value: 'magma', label: 'Magma' },
        { value: 'gray', label: 'Grayscale' },
        { value: 'gray-inv', label: 'Grayscale (inverted)' },
      ],
      'inferno',
    ),
    maxFreq: number('Max frequency (Hz)', 0, { min: 0, step: 100, hint: '0 = up to Nyquist' }),
    minFreq: number('Min frequency (Hz)', 0, { min: 0, step: 100, hint: '0 = from the bottom' }),
    floor: number('Floor (dB below peak)', 90, {
      min: 10,
      max: 200,
      step: 5,
      hint: 'Anything quieter is black. Lower it to hide noise.',
    }),
    ceiling: number('Ceiling (dB below peak)', 0, {
      min: 0,
      max: 150,
      step: 5,
      hint: 'Raise it to saturate loud parts and boost contrast.',
    }),
  },
  examples: [
    {
      label: 'Text in the spectrogram',
      input: { sample: 'audio-spectrogram.wav' },
      options: { fftSize: '512', overlap: 90, minFreq: 1100, maxFreq: 1950 },
      expect: 'Sample rate: 8000 Hz',
    },
    {
      label: 'Phone tones, magma',
      input: { sample: 'audio-dtmf.wav' },
      options: { fftSize: '1024', colormap: 'magma', maxFreq: 2000 },
      expect: 'Sample rate: 8000 Hz',
    },
    {
      label: 'Morse, log axis',
      input: { sample: 'audio-morse.wav' },
      options: { scale: 'log', colormap: 'gray-inv' },
      expect: 'Channels: 1 (mono)',
    },
  ],
  run(audio, o) {
    const first = audio.channels[0];
    if (!first || first.length === 0) throw new ToolError('The audio file contains no samples.');
    if (o.floor <= o.ceiling) {
      throw new ToolError(
        '"Floor" must be larger than "Ceiling". Raise the floor or lower the ceiling.',
      );
    }
    const notes: Output[] = [];
    let samples: Float32Array;
    let analysed: string;
    const second = audio.channels[1];
    if (o.channel === 'left') {
      samples = first;
      analysed = audio.channels.length > 1 ? 'left' : 'mono';
    } else if (o.channel === 'right') {
      samples = second ?? first;
      analysed = second ? 'right' : 'mono';
      if (!second)
        notes.push({
          type: 'note',
          level: 'info',
          text: 'Mono file: there is no right channel, showing the only one.',
        });
    } else if (o.channel === 'diff') {
      if (!second) {
        throw new ToolError('"L − R" needs a stereo file. Choose Mix or Left for mono audio.');
      }
      samples = Float32Array.from(first, (v, i) => v - (second[i] ?? 0));
      analysed = 'left − right';
    } else {
      samples = mixToMono(audio.channels);
      analysed = audio.channels.length > 1 ? 'mix of all channels' : 'mono';
    }

    const sp = computeSpectrogram(samples, audio.sampleRate, {
      fftSize: Number(o.fftSize),
      overlap: o.overlap / 100,
      maxFreq: o.maxFreq,
      minFreq: o.minFreq,
      scale: o.scale,
    });
    const image = renderSpectrogram(sp, o);
    const duration = samples.length / audio.sampleRate;
    const silent = sp.maxDb < -150;
    const nCh = audio.channels.length;
    const win = (sp.fftSize / audio.sampleRate) * 1000;

    const kv: [string, string][] = [
      ['Duration', fmtDuration(duration)],
      ['Sample rate', `${audio.sampleRate} Hz`],
      ['Channels', `${nCh} (${nCh === 1 ? 'mono' : nCh === 2 ? 'stereo' : 'multichannel'})`],
      ['Analysed', analysed],
      [
        'FFT',
        `${sp.fftSize} samples (${win.toFixed(0)} ms window), hop ${sp.hop}, ${sp.frames} columns`,
      ],
      ['Resolution', `${sp.binHz.toFixed(2)} Hz per bin`],
      [
        'Axes',
        `left to right 0–${duration.toFixed(2)} s; bottom to top ${sp.fMin.toFixed(0)}–${sp.fMax.toFixed(0)} Hz (${o.scale})`,
      ],
    ];
    if (!silent) {
      kv.push(
        [
          'Peak frequency',
          `${fmtHz(sp.peak.freq)} at ${sp.peak.time.toFixed(2)} s (${sp.peak.db.toFixed(1)} dBFS)`,
        ],
        ['Strongest on average', fmtHz(sp.dominant)],
      );
    }
    const out: Output[] = [
      { type: 'image', label: 'Spectrogram', image, filename: 'spectrogram.png' },
      { type: 'kv', entries: kv },
      ...notes,
    ];
    if (silent) {
      out.push({
        type: 'note',
        level: 'warn',
        text: 'The audio is silent: there is nothing to draw.',
      });
    }
    return out;
  },
});
