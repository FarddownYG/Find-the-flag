import { defineTool, number, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output, RgbaImage } from '../../core/types';
import { rateInfoOf, type RateInfo } from '../../core/audio-rate';
import { toolT } from '../../i18n/tool-text';
import { drawAxes, type AxesSpec } from './_axes';
import { buildColormap, type ColormapName } from './_colormap';
import { mixToMono } from './_dsp';
import { Fft, hannWindow } from './_fft';

const T = toolT('spectrogram');

/** Never render more columns than this; long files get a larger hop instead. */
const MAX_COLUMNS = 2000;
/** Short files are stretched (whole columns repeated) up to roughly this width. */
const MIN_IMAGE_WIDTH = 800;
const MIN_ROWS = 256;
const MAX_ROWS = 1024;
/** A column stands for `hop` samples; when that is more than a window, up to this many windows
 * are taken inside it and the loudest value is kept, so short sounds in long files still show. */
const MAX_WINDOWS_PER_COLUMN = 4;
/** Shortest slice worth transforming. */
/** Fewer samples than this cannot make a single spectrogram column. */
export const MIN_SAMPLES = 64;

export interface SpectrogramParams {
  fftSize: number;
  /** 0..0.95 */
  overlap: number;
  /** Hz; <= 0 means up to Nyquist. */
  maxFreq: number;
  /** Hz; <= 0 means the lowest useful frequency (0 Hz linear, 20 Hz log). */
  minFreq: number;
  scale: 'linear' | 'log';
  /** Seconds. Only this part of the signal is analysed; missing or 0 = from the beginning. */
  startTime?: number;
  /** Seconds; missing or 0 = to the end. */
  endTime?: number;
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
  scale: 'linear' | 'log';
  sampleRate: number;
  /** Seconds covered: time of the first sample analysed and of the end of the last one. */
  time0: number;
  time1: number;
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

const fmtSeconds = (s: number) => String(Number(s.toFixed(3)));

/** STFT with a Hann window, mapped onto an image-sized frequency axis. */
export function computeSpectrogram(
  signal: Float32Array,
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
    throw new ToolError(T('error.freqRange', { max: fMax, min: fMin }));
  }

  // Time zoom: only the slice between "start" and "end" is analysed.
  const first = Math.max(0, Math.round((p.startTime ?? 0) * sampleRate));
  if (first >= signal.length) {
    throw new ToolError(
      T('error.startAfterEnd', {
        start: fmtSeconds(p.startTime ?? 0),
        duration: fmtSeconds(signal.length / sampleRate),
      }),
    );
  }
  const stop = (p.endTime ?? 0) > 0 ? Math.round((p.endTime ?? 0) * sampleRate) : signal.length;
  const end = Math.min(signal.length, stop);
  if (end - first < MIN_SAMPLES) {
    throw new ToolError(
      T('error.timeRange', {
        start: fmtSeconds(p.startTime ?? 0),
        end: fmtSeconds(p.endTime ?? 0),
      }),
    );
  }
  const x = signal.subarray(first, end);
  const len = x.length;

  // Time axis: column t is centred on sample t * hop, so the first one sits at the start time.
  // Honour the overlap, but never exceed MAX_COLUMNS columns.
  const overlap = Math.min(0.95, Math.max(0, p.overlap));
  let hop = Math.max(1, Math.round(n * (1 - overlap)));
  let frames = Math.floor((len - 1) / hop) + 1;
  if (frames > MAX_COLUMNS) {
    hop = Math.ceil((len - 1) / (MAX_COLUMNS - 1));
    frames = Math.floor((len - 1) / hop) + 1;
  }
  const windows = hop > n ? Math.min(MAX_WINDOWS_PER_COLUMN, Math.ceil(hop / n)) : 1;

  // Frequency axis: one image row per sample of the (linear or log) axis.
  const rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round((fMax - fMin) / binHz)));
  const freqAt = (t: number): number => {
    const u = Math.min(1, Math.max(0, t));
    return p.scale === 'log' ? fMin * (fMax / fMin) ** u : fMin + (fMax - fMin) * u;
  };
  const firstBin = new Int32Array(rows);
  const lastBin = new Int32Array(rows);
  const frac = new Float32Array(rows);
  const useMax = new Uint8Array(rows);
  for (let r = 0; r < rows; r++) {
    const centre = freqAt(r / (rows - 1));
    const lo = freqAt((r - 0.5) / (rows - 1));
    const hi = freqAt((r + 0.5) / (rows - 1));
    if ((hi - lo) / binHz <= 1) {
      const b = Math.min(bins - 1, centre / binHz);
      const a = Math.floor(b);
      firstBin[r] = a;
      lastBin[r] = Math.min(bins - 1, a + 1);
      frac[r] = b - a;
    } else {
      useMax[r] = 1;
      firstBin[r] = Math.max(0, Math.min(bins - 1, Math.ceil(lo / binHz)));
      lastBin[r] = Math.max(firstBin[r]!, Math.min(bins - 1, Math.floor(hi / binHz)));
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
  const colBin = new Float32Array(bins);
  const meanPow = new Float64Array(bins);
  const db = new Float32Array(frames * rows);
  let maxDb = -Infinity;
  let peakDb = -Infinity;
  let peakBin = kLo;
  let peakCentre = 0;
  let peakNeighbours: [number, number] = [0, 0];

  for (let t = 0; t < frames; t++) {
    for (let w = 0; w < windows; w++) {
      const centre = Math.round(t * hop + (w - (windows - 1) / 2) * (hop / windows));
      const start = centre - (n >> 1);
      for (let i = 0; i < n; i++) {
        const s = start + i;
        re[i] = s >= 0 && s < len ? x[s]! * win[i]! : 0;
        im[i] = 0;
      }
      fft.forward(re, im);
      for (let k = 0; k < bins; k++) {
        const pw = (re[k]! * re[k]! + im[k]! * im[k]!) * scale2;
        meanPow[k] = meanPow[k]! + pw;
        dbBin[k] = 10 * Math.log10(pw + 1e-20);
        colBin[k] = w === 0 || dbBin[k]! > colBin[k]! ? dbBin[k]! : colBin[k]!;
      }
      for (let k = kLo; k <= kHi; k++) {
        if (dbBin[k]! > peakDb) {
          peakDb = dbBin[k]!;
          peakBin = k;
          peakCentre = centre;
          peakNeighbours = [dbBin[Math.max(0, k - 1)]!, dbBin[Math.min(bins - 1, k + 1)]!];
        }
      }
    }
    const base = t * rows;
    for (let r = 0; r < rows; r++) {
      const a = firstBin[r]!;
      const b = lastBin[r]!;
      let v: number;
      if (useMax[r]) {
        v = colBin[a]!;
        for (let k = a + 1; k <= b; k++) if (colBin[k]! > v) v = colBin[k]!;
      } else {
        v = colBin[a]! * (1 - frac[r]!) + colBin[b]! * frac[r]!;
      }
      db[base + r] = v;
      if (v > maxDb) maxDb = v;
    }
  }

  let domBin = kLo;
  for (let k = kLo; k <= kHi; k++) if (meanPow[k]! > meanPow[domBin]!) domBin = k;
  const lg = (k: number) => Math.log(meanPow[Math.max(0, Math.min(bins - 1, k))]! + 1e-30);
  const domDelta = refine(lg(domBin - 1), lg(domBin), lg(domBin + 1));
  const time0 = first / sampleRate;

  return {
    frames,
    rows,
    db,
    hop,
    fftSize: n,
    binHz,
    fMin,
    fMax,
    scale: p.scale,
    sampleRate,
    time0,
    time1: end / sampleRate,
    maxDb,
    peak: {
      freq: (peakBin + refine(peakNeighbours[0], peakDb, peakNeighbours[1])) * binHz,
      time: time0 + peakCentre / sampleRate,
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

/** Image pixels per time column: short files are stretched so the picture is not tiny. */
export const columnRepeat = (frames: number): number =>
  frames >= MIN_IMAGE_WIDTH ? 1 : Math.min(16, Math.floor(MIN_IMAGE_WIDTH / frames));

/** Colour the dB matrix: time to the right, frequency upwards (row 0 at the bottom). */
export function renderSpectrogram(sp: Spectrogram, p: RenderParams): RgbaImage {
  const lut = buildColormap(p.colormap);
  const rep = columnRepeat(sp.frames);
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

/** Where time and frequency sit in the rendered picture (see drawAxes). */
export function spectrogramAxes(sp: Spectrogram): AxesSpec {
  const rep = columnRepeat(sp.frames);
  return {
    width: sp.frames * rep,
    height: sp.rows,
    columnWidth: rep,
    hopSeconds: sp.hop / sp.sampleRate,
    t0: sp.time0,
    t1: sp.time1,
    fMin: sp.fMin,
    fMax: sp.fMax,
    scale: sp.scale,
  };
}

/** The picture with its frequency axis on the left and its time axis below. */
export function drawSpectrogram(sp: Spectrogram, p: RenderParams): RgbaImage {
  return drawAxes(renderSpectrogram(sp, p), spectrogramAxes(sp));
}

/** 22050 -> "22050", 5512.5 -> "5512.5": frequencies without noise digits. */
const num = (x: number): string => String(Number(x.toFixed(1)));

/** "22050 Hz (from the file)": the rate and where it comes from. */
function describeRate(rate: number, info: RateInfo | undefined): string {
  if (!info) return `${rate} Hz`;
  if (info.originalRate && info.originalRate !== rate) {
    return T('value.rate.opus', { rate, original: info.originalRate });
  }
  return info.source === 'file'
    ? T('value.rate.file', { rate })
    : T('value.rate.decoder', { rate });
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
  // Re-run when an option changes (FFT size, zoom, colours): no need to press Run.
  live: true,
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
    startTime: number('Start (s)', 0, { min: 0, step: 0.5, hint: '0 = from the beginning' }),
    endTime: number('End (s)', 0, { min: 0, step: 0.5, hint: '0 = to the end' }),
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
      // A demo: this sample draws FLAG{SPECTRO} in a narrow band. The label and the shell's
      // demo banner keep it from being mistaken for the analysis of the user's own file.
      label: 'Demo: text drawn in a spectrogram',
      input: { sample: 'audio-spectrogram.wav' },
      options: { fftSize: '512', overlap: 90, minFreq: 1100, maxFreq: 1950 },
      expect: 'Sample rate: 8000 Hz',
    },
    {
      label: '22050 Hz sample, whole band',
      input: { sample: 'audio-spectrogram-22k.wav' },
      options: { fftSize: '1024', overlap: 90 },
      expect: 'Frequencies shown: 0 – 11025 Hz',
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
    if (!first || first.length === 0) throw new ToolError(T('error.noSamples'));
    if (o.floor <= o.ceiling) throw new ToolError(T('error.floor'));
    const notes: Output[] = [];
    let samples: Float32Array;
    let analysed: string;
    const second = audio.channels[1];
    if (o.channel === 'left') {
      samples = first;
      analysed = audio.channels.length > 1 ? T('value.left') : T('value.mono');
    } else if (o.channel === 'right') {
      samples = second ?? first;
      analysed = second ? T('value.right') : T('value.mono');
      if (!second) notes.push({ type: 'note', level: 'info', text: T('note.noRight') });
    } else if (o.channel === 'diff') {
      if (!second) {
        throw new ToolError(T('error.diffMono'));
      }
      samples = Float32Array.from(first, (v, i) => v - (second[i] ?? 0));
      analysed = T('value.diff');
    } else {
      samples = mixToMono(audio.channels);
      analysed = audio.channels.length > 1 ? T('value.mix') : T('value.mono');
    }

    const rate = audio.sampleRate;
    const nyquist = rate / 2;
    const sp = computeSpectrogram(samples, rate, {
      fftSize: Number(o.fftSize),
      overlap: o.overlap / 100,
      maxFreq: o.maxFreq,
      minFreq: o.minFreq,
      scale: o.scale,
      startTime: o.startTime,
      endTime: o.endTime,
    });
    const image = drawSpectrogram(sp, o);
    const duration = samples.length / rate;
    const silent = sp.maxDb < -150;
    const nCh = audio.channels.length;
    const win = (sp.fftSize / rate) * 1000;
    const info = rateInfoOf(audio);
    if (o.maxFreq > nyquist) {
      notes.push({
        type: 'note',
        level: 'info',
        text: T('note.maxClamped', { max: o.maxFreq, nyquist: num(nyquist) }),
      });
    }
    if (info?.source === 'decoder') {
      notes.push({ type: 'note', level: 'warn', text: T('note.rateUnknown', { rate }) });
    }

    const layout = nCh === 1 ? T('value.mono') : nCh === 2 ? T('value.stereo') : T('value.multi');
    const kv: [string, string][] = [
      [T('kv.duration'), fmtDuration(duration)],
      [T('kv.sampleRate'), describeRate(rate, info)],
      [T('kv.nyquist'), `${num(nyquist)} Hz`],
      [T('kv.channels'), `${nCh} (${layout})`],
      [T('kv.analysed'), analysed],
      [
        'FFT',
        T('value.fft', {
          size: sp.fftSize,
          window: win.toFixed(0),
          hop: sp.hop,
          columns: sp.frames,
        }),
      ],
      [T('kv.resolution'), T('value.resolution', { hz: sp.binHz.toFixed(2) })],
      [
        T('kv.freqShown'),
        T('value.freqShown', {
          min: num(sp.fMin),
          max: num(sp.fMax),
          scale: o.scale === 'log' ? T('value.log') : T('value.linear'),
        }),
      ],
      [
        T('kv.timeShown'),
        T('value.timeShown', { start: sp.time0.toFixed(2), end: sp.time1.toFixed(2) }),
      ],
    ];
    if (!silent) {
      kv.push(
        [
          T('kv.peak'),
          T('value.peak', {
            freq: fmtHz(sp.peak.freq),
            time: sp.peak.time.toFixed(2),
            db: sp.peak.db.toFixed(1),
          }),
        ],
        [T('kv.strongest'), fmtHz(sp.dominant)],
      );
    }
    const out: Output[] = [
      { type: 'image', label: T('label.image'), image, filename: 'spectrogram.png' },
      { type: 'kv', entries: kv },
      ...notes,
    ];
    if (silent) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.silent'),
      });
    }
    return out;
  },
});
