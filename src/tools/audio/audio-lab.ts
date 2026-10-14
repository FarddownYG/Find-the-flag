import { defineTool, text } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { AudioInput, Output } from '../../core/types';
import { t } from '../../i18n';
import { toolT } from '../../i18n/tool-text';
import {
  compareChannels,
  encodeWav16,
  midOf,
  peakOf,
  pitchShift,
  Resampler,
  reversed,
  scaled,
  sideOf,
  timeStretch,
  toDb,
} from './_audio-lab-dsp';
import { computeSpectrogram, renderSpectrogram, type Spectrogram } from './spectrogram';

const T = toolT('audio-lab');

/** Longest result kept. */
export const MAX_SECONDS = 15 * 60;
/** Most samples kept across all channels: 240 MB as 32-bit floats, 120 MB as 16-bit WAV. */
export const MAX_SAMPLES = 60_000_000;
export const MAX_STEPS = 20;
/** "normalize" brings the loudest sample to -1 dBFS. */
const NORMALIZE_PEAK = 10 ** (-1 / 20);

export type Channel = 'left' | 'right' | 'mid' | 'side';

/** One parsed step; `text` is how it is shown back (and it parses again to the same step). */
export type Step =
  | { op: 'reverse' | 'normalize'; text: string }
  | { op: 'speed' | 'tempo' | 'stretch' | 'pitch'; value: number; text: string }
  | { op: 'channel'; channel: Channel; text: string };

const RANGES = {
  speed: [0.125, 8],
  tempo: [0.2, 5],
  stretch: [0.2, 5],
  pitch: [-24, 24],
} as const;

const OPS: Readonly<Record<string, Step['op']>> = {
  reverse: 'reverse',
  reversed: 'reverse',
  rev: 'reverse',
  backwards: 'reverse',
  backward: 'reverse',
  speed: 'speed',
  rate: 'speed',
  tempo: 'tempo',
  stretch: 'stretch',
  timestretch: 'stretch',
  pitch: 'pitch',
  channel: 'channel',
  ch: 'channel',
  normalize: 'normalize',
  normalise: 'normalize',
  norm: 'normalize',
};

const CHANNELS: Readonly<Record<string, Channel>> = {
  left: 'left',
  l: 'left',
  right: 'right',
  r: 'right',
  mid: 'mid',
  m: 'mid',
  mono: 'mid',
  sum: 'mid',
  'l+r': 'mid',
  side: 'side',
  s: 'side',
  diff: 'side',
  difference: 'side',
  'l-r': 'side',
};

/** Channel names that also work as a step on their own ("left" = "channel left"). */
const BARE_CHANNELS = new Set(['left', 'right', 'mid', 'mono', 'side']);

const fmtNum = (v: number): string => String(Number(v.toFixed(4)));
const signed = (v: number): string => (v > 0 ? `+${fmtNum(v)}` : fmtNum(v));

/** "0.5", ".5", "1/1.5", "x2", "×2", "2x", "150%" -> a positive number, or null. */
function parseFactor(s: string): number | null {
  let t = s.replace(/^[x×*]/, '').replace(/[x×]$/, '');
  let scale = 1;
  if (t.endsWith('%')) {
    scale = 0.01;
    t = t.slice(0, -1);
  }
  const m = /^(\d+(?:\.\d+)?|\.\d+)(?:\/(\d+(?:\.\d+)?|\.\d+))?$/.exec(t);
  if (!m) return null;
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (!(den > 0)) return null;
  const v = (Number(m[1]) / den) * scale;
  return Number.isFinite(v) ? v : null;
}

/** "-3", "+12", "-3.5st", "4 semitones" -> semitones, or null. */
function parseSemitones(s: string): number | null {
  const t = s.replace(/(st|semitones?|semis?)$/, '');
  if (!/^[+-]?(\d+(?:\.\d+)?|\.\d+)$/.test(t)) return null;
  return Number(t);
}

function parseStep(raw: string, n: number): Step {
  const norm = raw
    .toLowerCase()
    .replace(/[−–]/g, '-')
    .replace(/[=:()]/g, ' ')
    .trim();
  const [word = '', ...rest] = norm.split(/\s+/);
  const value = rest.join('');
  const bare = BARE_CHANNELS.has(word);
  const op = OPS[word] ?? (bare ? 'channel' : undefined);
  const step = raw.trim();
  if (!op) throw new ToolError(T('error.unknown', { n, step }));
  if (op === 'reverse' || op === 'normalize') {
    if (value) throw new ToolError(T('error.noValue', { n, step, op }));
    return { op, text: op };
  }
  if (op === 'channel') {
    if (bare && value) throw new ToolError(T('error.noValue', { n, step, op: word }));
    const name = bare ? word : value;
    if (!name) throw new ToolError(T('error.needValue', { n, step, example: 'channel left' }));
    const channel = CHANNELS[name];
    if (!channel) throw new ToolError(T('error.badChannel', { n, step }));
    return { op, channel, text: `channel ${channel}` };
  }
  const example = {
    speed: 'speed 0.5',
    tempo: 'tempo 0.5',
    stretch: 'stretch 2',
    pitch: 'pitch -3',
  }[op];
  if (!value) throw new ToolError(T('error.needValue', { n, step, example }));
  const v = op === 'pitch' ? parseSemitones(value) : parseFactor(value);
  if (v === null) {
    throw new ToolError(
      T(op === 'pitch' ? 'error.badSemitones' : 'error.badFactor', { n, step, value }),
    );
  }
  const [min, max] = RANGES[op];
  if (v < min || v > max) {
    throw new ToolError(T('error.range', { n, step, min: fmtNum(min), max: fmtNum(max) }));
  }
  return { op, value: v, text: op === 'pitch' ? `pitch ${signed(v)}` : `${op} ${value}` };
}

/**
 * Parse a chain of steps, applied left to right and separated by commas, semicolons, new lines,
 * "->", "→", "|" or "then": "reverse, speed 1/1.5, stretch 2, pitch -3, channel left".
 */
export function parseChain(src: string): Step[] {
  const parts = src
    .split(/[,;\n|→]|->|\bthen\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > MAX_STEPS) {
    throw new ToolError(T('error.tooMany', { steps: parts.length, max: MAX_STEPS }));
  }
  // "speed 0,5" splits into "speed 0" and "5": the decimal comma is the real mistake, say so.
  const lone = parts.findIndex((p) => /^[+-]?[\d.]+%?$/.test(p));
  if (lone >= 0) throw new ToolError(T('error.loneNumber', { n: lone + 1, step: parts[lone]! }));
  return parts.map((raw, i) => parseStep(raw, i + 1));
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(2).padStart(5, '0')}`;
}

function layout(count: number): string {
  if (count === 1) return T('value.mono');
  if (count === 2) return T('value.stereo');
  return T('value.multi', { count });
}

function signal(channels: Float32Array[], sampleRate: number): string {
  return T('value.signal', {
    rate: sampleRate,
    layout: layout(channels.length),
    duration: fmtDuration((channels[0]?.length ?? 0) / sampleRate),
  });
}

function effectOf(step: Step): string {
  switch (step.op) {
    case 'reverse':
      return T('effect.reverse');
    case 'normalize':
      return ''; // applyChain describes it once the gain is known
    case 'speed':
      if (step.value === 1) return T('effect.same');
      return step.value > 1
        ? T('effect.faster', { factor: fmtNum(step.value) })
        : T('effect.slower', { factor: fmtNum(step.value) });
    case 'tempo':
    case 'stretch':
      return T('effect.stretch', {
        factor: fmtNum(step.op === 'tempo' ? 1 / step.value : step.value),
      });
    case 'pitch':
      return T('effect.pitch', {
        semitones: signed(step.value),
        ratio: fmtNum(2 ** (step.value / 12)),
      });
    case 'channel':
      switch (step.channel) {
        case 'left':
          return T('effect.left');
        case 'right':
          return T('effect.right');
        case 'mid':
          return T('effect.mid');
        case 'side':
          return T('effect.side');
      }
  }
}

export interface LabResult {
  channels: Float32Array[];
  /** One row per step: [#, step, effect, duration after it]. */
  rows: (string | number)[][];
  /** The result was cut to the length or memory limit. */
  capped: boolean;
  notes: Output[];
}

/** Apply the steps in order. Never modifies the input arrays. */
export function applyChain(audio: AudioInput, steps: Step[]): LabResult {
  const fs = audio.sampleRate;
  let cur = audio.channels;
  let capped = false;
  const rows: (string | number)[][] = [];
  const notes: Output[] = [];
  const limit = (channels: number) =>
    Math.max(1, Math.min(Math.floor(MAX_SECONDS * fs), Math.floor(MAX_SAMPLES / channels)));
  /** Length of a step's result: what it would be, cut to the limits. */
  const cap = (len: number, channels: number) => {
    const lim = limit(channels);
    if (len <= lim) return Math.max(1, len);
    capped = true;
    return lim;
  };
  steps.forEach((step, i) => {
    const n = i + 1;
    const len = cur[0]!.length;
    let effect = effectOf(step);
    switch (step.op) {
      case 'reverse': {
        const out = cap(len, cur.length);
        cur = cur.map((ch) => reversed(ch, out));
        break;
      }
      case 'speed': {
        const rs = new Resampler(step.value);
        if (rs.p !== rs.q) cur = rs.processAll(cur, cap(rs.lengthFor(len), cur.length));
        else effect = T('effect.same'); // within 0.1 % of 1
        break;
      }
      case 'tempo':
      case 'stretch': {
        const factor = step.op === 'tempo' ? 1 / step.value : step.value;
        cur = timeStretch(cur, fs, cap(Math.round(len * factor), cur.length));
        break;
      }
      case 'pitch':
        cur = pitchShift(cur, fs, step.value);
        break;
      case 'channel': {
        const [l, r] = cur;
        if (!l || !r) {
          if (step.channel === 'side') {
            throw new ToolError(T('error.sideMono', { n, step: step.text }));
          }
          effect = T('effect.alreadyMono');
          break;
        }
        if (cur.length > 2) {
          notes.push({ type: 'note', level: 'info', text: T('note.multi', { n }) });
        }
        if (step.channel === 'left') cur = [l];
        else if (step.channel === 'right') cur = [r];
        else if (step.channel === 'mid') cur = [midOf(l, r)];
        else {
          if (compareChannels(l, r).identical) {
            notes.push({ type: 'note', level: 'warn', text: T('note.sideSilent', { n }) });
          }
          cur = [sideOf(l, r)];
        }
        break;
      }
      case 'normalize': {
        const peak = peakOf(cur);
        if (peak > 0) {
          const gain = NORMALIZE_PEAK / peak;
          cur = scaled(cur, gain);
          effect = T('effect.normalizeGain', { gain: signed(Number(toDb(gain).toFixed(1))) });
        } else effect = T('effect.silent');
        break;
      }
    }
    rows.push([n, step.text, effect, fmtDuration(cur[0]!.length / fs)]);
  });
  // An input longer than the limits, with no step that shortened it.
  const lim = limit(cur.length);
  if (cur[0]!.length > lim) {
    capped = true;
    cur = cur.map((ch) => ch.subarray(0, lim));
  }
  return { channels: cur, rows, capped, notes };
}

function fftSizeFor(sampleRate: number): number {
  if (sampleRate <= 12_000) return 512;
  if (sampleRate <= 24_000) return 1024;
  if (sampleRate <= 48_000) return 2048;
  return 4096;
}

/**
 * Spectrogram of what you hear, full band (0 to Nyquist): at every point the loudest of the
 * channels. A mono mix would cancel whatever is only in L − R.
 */
export function resultSpectrogram(channels: Float32Array[], sampleRate: number): Spectrogram {
  const [first, ...rest] = channels.map((ch) =>
    computeSpectrogram(ch, sampleRate, {
      fftSize: fftSizeFor(sampleRate),
      overlap: 0.75,
      maxFreq: 0,
      minFreq: 0,
      scale: 'linear',
    }),
  );
  for (const sp of rest) {
    for (let i = 0; i < first!.db.length; i++) {
      if (sp.db[i]! > first!.db[i]!) first!.db[i] = sp.db[i]!;
    }
    first!.maxDb = Math.max(first!.maxDb, sp.maxDb);
  }
  return first!;
}

const PRESETS = {
  undo: 'reverse, speed 1/1.5',
  reverse: 'reverse',
  slow: 'speed 0.5',
  fast: 'speed 2',
  stretch: 'stretch 2',
  octaveDown: 'pitch -12',
  original: '',
  left: 'channel left',
  right: 'channel right',
  side: 'channel side, normalize',
  mid: 'channel mid',
} as const;

const ADD_STEPS = [
  'reverse',
  'speed 0.5',
  'speed 2',
  'stretch 2',
  'pitch -3',
  'pitch +3',
  'normalize',
];

function presetActions(stereo: boolean): Output {
  const a = (label: string, chain: string, primary = false) => ({
    label,
    options: { chain },
    primary,
  });
  const actions = [
    a(T('preset.undo'), PRESETS.undo, true),
    a(T('preset.reverse'), PRESETS.reverse),
    a(T('preset.slow'), PRESETS.slow),
    a(T('preset.fast'), PRESETS.fast),
    a(T('preset.stretch'), PRESETS.stretch),
    a(T('preset.octaveDown'), PRESETS.octaveDown),
  ];
  if (stereo) {
    actions.push(
      a(T('preset.left'), PRESETS.left),
      a(T('preset.right'), PRESETS.right),
      a(T('preset.side'), PRESETS.side),
      a(T('preset.mid'), PRESETS.mid),
    );
  }
  actions.push(a(T('preset.original'), PRESETS.original));
  return { type: 'actions', label: T('label.presets'), actions };
}

function addStepActions(chain: string): Output {
  const base = chain
    .trim()
    .replace(/[,;|]+$/, '')
    .trim();
  return {
    type: 'actions',
    label: T('label.addStep'),
    actions: ADD_STEPS.map((s) => ({
      label: T('add.step', { step: s }),
      options: { chain: base ? `${base}, ${s}` : s },
    })),
  };
}

function baseName(name: string | undefined): string {
  const stem = (name ?? '').replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '_');
  return stem || 'audio';
}

export default defineTool({
  id: 'audio-lab',
  name: 'Audio lab',
  category: 'audio',
  description:
    'Reverse, speed up or slow down, stretch, pitch-shift and split channels, then listen to the result, download it as WAV and see its spectrogram.',
  tags: [
    'reverse audio',
    'backwards',
    'slow down',
    'speed up',
    'time stretch',
    'pitch shift',
    'audacity',
    'sox',
    'chipmunk',
    'reversed voice',
    'mid side',
    'stereo',
    'resample',
    'wsola',
  ],
  input: 'audio',
  placeholder: 'Drop a WAV file (MP3/OGG/FLAC work in browsers that can decode them)',
  options: {
    chain: text('Steps', '', {
      placeholder: 'reverse, speed 0.5, stretch 2, pitch -3, channel left',
      hint: 'Applied left to right, separated by commas: reverse · speed X (pitch follows; 1/1.5 undoes ×1.5) · stretch X (duration ×X, same pitch) · tempo X · pitch N (semitones, same duration) · channel left / right / mid / side · normalize',
    }),
  },
  examples: [
    {
      label: 'Reversed + fast voice → undo it',
      input: { sample: 'audio-lab-reversed-fast.wav' },
      options: { chain: 'reverse, speed 1/1.5' },
      expect: 'Chain applied: reverse, speed 1/1.5',
    },
    {
      label: 'Reverse only',
      input: { sample: 'audio-lab-reversed-fast.wav' },
      options: { chain: 'reverse' },
      expect: 'Duration: 1.60 s → 1.60 s (×1)',
    },
    {
      label: 'Slow down ×2, same pitch',
      input: { sample: 'audio-lab-voice.wav' },
      options: { chain: 'stretch 2' },
      expect: 'Duration: 2.40 s → 4.80 s (×2)',
    },
    {
      label: 'Voice hidden in L − R',
      input: { sample: 'audio-lab-stereo.wav' },
      options: { chain: 'channel side, normalize' },
      expect: 'Output: 16000 Hz · mono · 2.40 s',
    },
  ],
  run(audio, { chain }) {
    const first = audio.channels[0];
    if (!first || first.length === 0) throw new ToolError(T('error.noSamples'));
    const steps = parseChain(chain);
    const fs = audio.sampleRate;
    const lab = applyChain(audio, steps);
    const out = lab.channels;
    const outLen = out[0]!.length;
    const { bytes, clipped } = encodeWav16(out, fs);

    const [l, r] = audio.channels;
    let monoCheck: string;
    if (!l || !r) monoCheck = T('value.oneChannel');
    else {
      const cmp = compareChannels(l, r);
      monoCheck = cmp.identical
        ? T('value.identical')
        : T('value.different', {
            max: cmp.maxDiff.toFixed(4),
            db: toDb(cmp.maxDiff).toFixed(1),
            time: (cmp.at / fs).toFixed(2),
            differing: cmp.differing,
            total: l.length,
          });
    }
    const peak = peakOf(out);
    const inSeconds = first.length / fs;
    const outSeconds = outLen / fs;
    const kv: [string, string][] = [
      [T('kv.input'), signal(audio.channels, fs)],
      [T('kv.monoCheck'), monoCheck],
      [T('kv.chain'), steps.length ? steps.map((s) => s.text).join(', ') : T('value.noChain')],
      [T('kv.output'), signal(out, fs)],
      [
        T('kv.duration'),
        `${fmtDuration(inSeconds)} → ${fmtDuration(outSeconds)} (×${fmtNum(outSeconds / inSeconds)})`,
      ],
      [T('kv.peak'), peak > 0 ? `${toDb(peak).toFixed(1)} dBFS` : T('value.silence')],
    ];

    const notes: Output[] = [...lab.notes];
    if (!steps.length) {
      notes.push({ type: 'note', level: 'info', text: T('note.empty', { run: t('ui.tool.run') }) });
    }
    if (lab.capped) {
      notes.push({
        type: 'note',
        level: 'warn',
        text: T('note.capped', {
          duration: fmtDuration(outSeconds),
          minutes: MAX_SECONDS / 60,
          million: MAX_SAMPLES / 1e6,
        }),
      });
    }
    if (clipped) {
      notes.push({
        type: 'note',
        level: 'warn',
        text: T('note.clipped', { db: toDb(peak).toFixed(1) }),
      });
    } else if (peak > 0 && toDb(peak) < -30) {
      notes.push({
        type: 'note',
        level: 'info',
        text: T('note.quiet', { db: toDb(peak).toFixed(1) }),
      });
    }
    notes.push(
      { type: 'note', level: 'info', text: T('note.honest') },
      {
        type: 'note',
        level: 'info',
        text: T('note.related', {
          dtmf: t('tool.dtmf.name'),
          morse: t('tool.morse-audio.name'),
          sendTo: t('ui.out.sendTo'),
        }),
      },
    );

    const image = renderSpectrogram(resultSpectrogram(out, fs), {
      colormap: 'inferno',
      floor: 90,
      ceiling: 0,
    });
    const stem = baseName(audio.name);

    const result: Output[] = [
      {
        type: 'audio',
        label: T('label.result'),
        data: bytes,
        mime: 'audio/wav',
        filename: `${stem}-lab.wav`,
      },
      presetActions(audio.channels.length > 1),
      addStepActions(chain),
      { type: 'kv', entries: kv },
      ...notes,
    ];
    if (lab.rows.length) {
      result.push({
        type: 'table',
        label: T('label.steps'),
        columns: ['#', T('col.step'), T('col.effect'), T('col.duration')],
        rows: lab.rows,
      });
    }
    result.push({
      type: 'image',
      label: T('label.spectrogram', { max: Math.round(fs / 2) }),
      image,
      filename: `${stem}-lab-spectrogram.png`,
    });
    return result;
  },
});
