import { bool, defineTool, number } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { mixToMono, quantile } from './_dsp';
import { hannWindow } from './_fft';

const ROW_HZ = [697, 770, 852, 941] as const;
const COL_HZ = [1209, 1336, 1477, 1633] as const;
const KEYPAD = ['123A', '456B', '789C', '*0#D'] as const;

/** Old mobile-phone keypad: pressing a key N times picks the Nth letter. */
const MULTITAP: Readonly<Record<string, string>> = {
  '1': '.,?!',
  '2': 'ABC',
  '3': 'DEF',
  '4': 'GHI',
  '5': 'JKL',
  '6': 'MNO',
  '7': 'PQRS',
  '8': 'TUV',
  '9': 'WXYZ',
};

export interface DtmfTone {
  key: string;
  /** Seconds. */
  start: number;
  end: number;
  rowHz: number;
  colHz: number;
}

export interface DtmfOptions {
  frameMs: number;
  /** Minimum frame level in dBFS (RMS). */
  silenceDb: number;
  /** Apply the telephone-standard twist, dominance and purity checks. */
  strict: boolean;
}

interface Candidate {
  row: number;
  col: number;
  power: number;
}

/** Detect DTMF key presses: Goertzel on the 8 tone frequencies over sliding Hann-windowed frames. */
export function detectDtmf(x: Float32Array, sampleRate: number, o: DtmfOptions): DtmfTone[] {
  const win = Math.max(64, Math.round((sampleRate * o.frameMs) / 1000));
  const hop = Math.max(1, Math.round(win / 4));
  const w = hannWindow(win);
  let sumW = 0;
  let sumW2 = 0;
  for (const v of w) {
    sumW += v;
    sumW2 += v * v;
  }
  const norm = (2 * sumW2) / (sumW * sumW); // a pure tone then has a share of 1
  const freqs = [...ROW_HZ, ...COL_HZ];
  const coeff = freqs.map((f) => 2 * Math.cos((2 * Math.PI * f) / sampleRate));
  const minPower = 10 ** (o.silenceDb / 10);
  const dominance = o.strict ? 4 : 2; // strongest row/col vs the runner-up
  const minShare = o.strict ? 0.35 : 0.12;
  const twistLo = o.strict ? -8 : -20;
  const twistHi = o.strict ? 6 : 14;

  const buf = new Float64Array(win);
  const pw = new Float64Array(8);
  const frames: (Candidate | null)[] = [];
  for (let start = 0; start + win <= x.length; start += hop) {
    let raw = 0;
    let weighted = 0;
    for (let i = 0; i < win; i++) {
      const v = x[start + i]!;
      raw += v * v;
      const wv = v * w[i]!;
      buf[i] = wv;
      weighted += wv * wv;
    }
    const power = raw / win;
    if (power < minPower || weighted <= 0) {
      frames.push(null);
      continue;
    }
    for (let f = 0; f < 8; f++) {
      const c = coeff[f]!;
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < win; i++) {
        const s = buf[i]! + c * s1 - s2;
        s2 = s1;
        s1 = s;
      }
      pw[f] = s1 * s1 + s2 * s2 - c * s1 * s2;
    }
    let row = 0;
    let col = 4;
    for (let f = 1; f < 4; f++) if (pw[f]! > pw[row]!) row = f;
    for (let f = 5; f < 8; f++) if (pw[f]! > pw[col]!) col = f;
    let rowRunner = 0;
    let colRunner = 0;
    for (let f = 0; f < 4; f++) if (f !== row && pw[f]! > rowRunner) rowRunner = pw[f]!;
    for (let f = 4; f < 8; f++) if (f !== col && pw[f]! > colRunner) colRunner = pw[f]!;
    const share = (norm * (pw[row]! + pw[col]!)) / weighted;
    const twist = 10 * Math.log10(pw[col]! / Math.max(pw[row]!, 1e-30));
    const ok =
      pw[row]! > dominance * rowRunner &&
      pw[col]! > dominance * colRunner &&
      share >= minShare &&
      twist >= twistLo &&
      twist <= twistHi;
    frames.push(ok ? { row, col: col - 4, power } : null);
  }

  // A frame that only half overlaps a key press is as loud as half a tone: keep frames that
  // are at least ~40% as loud as a typical tone frame, so edges land where the tone starts.
  const levels = frames.filter((f): f is Candidate => f !== null).map((f) => f.power);
  if (!levels.length) return [];
  const reference = quantile(levels, 0.9);
  const keys = frames.map((f) => (f && f.power >= reference * 0.4 ? KEYPAD[f.row]![f.col]! : ''));

  // Merge consecutive frames of the same key; bridge one-frame dropouts inside a key press.
  interface Run {
    key: string;
    first: number;
    last: number;
  }
  const runs: Run[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (!key) continue;
    const prev = runs[runs.length - 1];
    if (prev && prev.key === key && i - prev.last <= 2) prev.last = i;
    else runs.push({ key, first: i, last: i });
  }
  const minFrames = o.strict ? 3 : 2;
  const centre = (frame: number) => (frame * hop + win / 2) / sampleRate;
  return runs
    .filter((r) => r.last - r.first + 1 >= minFrames)
    .map((r) => {
      const row = KEYPAD.findIndex((line) => line.includes(r.key));
      const col = KEYPAD[row]!.indexOf(r.key);
      return {
        key: r.key,
        start: centre(r.first),
        end: centre(r.last),
        rowHz: ROW_HZ[row]!,
        colHz: COL_HZ[col]!,
      };
    });
}

/** Group digits by long pauses; null when the pauses are all alike. */
export function splitByPauses(tones: DtmfTone[]): string[] | null {
  if (tones.length < 3) return null;
  const gaps = tones.slice(1).map((t, i) => t.start - tones[i]!.end);
  const typical = quantile(gaps, 0.25);
  const limit = Math.max(2.5 * typical, typical + 0.25);
  if (!gaps.some((g) => g >= limit)) return null;
  const groups: string[] = [tones[0]!.key];
  gaps.forEach((g, i) => {
    if (g >= limit) groups.push(tones[i + 1]!.key);
    else groups[groups.length - 1] += tones[i + 1]!.key;
  });
  return groups;
}

/**
 * Read digits the way an old phone keypad types letters ("44 33 555 555 666" is HELLO).
 * Groups (split by pauses or spaces) are read independently; inside a group, a run of the same
 * key picks letters by how many times it was pressed. 0 is a space; * and # are kept as they are.
 */
export function multiTapText(groups: string[]): string {
  let out = '';
  for (const group of groups) {
    const runs = group.match(/(.)\1*/g) ?? [];
    for (const run of runs) {
      const key = run[0]!;
      const letters = MULTITAP[key];
      if (key === '0') out += ' '.repeat(run.length);
      else if (!letters) out += run;
      else {
        const full = Math.floor(run.length / letters.length);
        out += letters[letters.length - 1]!.repeat(full);
        const rest = run.length % letters.length;
        if (rest) out += letters[rest - 1]!;
      }
    }
  }
  return out;
}

export default defineTool({
  id: 'dtmf',
  name: 'DTMF / phone tones',
  category: 'audio',
  description:
    'Decode the keys of touch-tone dialling in a recording, and read them as phone-keypad text.',
  tags: ['dtmf', 'touch tone', 'telephone', 'dial', 'multimon-ng', 'keypad', 'multi-tap', 't9'],
  input: 'audio',
  placeholder: 'Drop a WAV file with dial tones',
  options: {
    frameMs: number('Frame (ms)', 40, {
      min: 20,
      max: 100,
      step: 5,
      hint: 'Analysis window length',
    }),
    silenceDb: number('Silence threshold (dBFS)', -50, {
      min: -100,
      max: 0,
      step: 5,
      hint: 'Frames quieter than this are ignored',
    }),
    strict: bool('Strict checks', true, {
      hint: 'Telephone-grade twist and purity tests. Turn off for noisy or distorted recordings.',
    }),
  },
  examples: [
    { label: 'Dial 0–9, *, #', input: { sample: 'audio-dtmf.wav' }, expect: '0123456789*#' },
    {
      label: 'Relaxed checks, short frames',
      input: { sample: 'audio-dtmf.wav' },
      options: { strict: false, frameMs: 30 },
      expect: '0123456789*#',
    },
  ],
  run(audio, { frameMs, silenceDb, strict }) {
    if (audio.sampleRate < 4000) {
      throw new ToolError(
        `Sample rate ${audio.sampleRate} Hz is too low for DTMF (the highest tone is 1633 Hz, so at least 4000 Hz is needed).`,
      );
    }
    const mono = mixToMono(audio.channels);
    if (mono.length < (audio.sampleRate * frameMs) / 1000) {
      throw new ToolError('The audio is shorter than one analysis frame. Use a longer file.');
    }
    const tones = detectDtmf(mono, audio.sampleRate, { frameMs, silenceDb, strict });
    if (!tones.length) {
      throw new ToolError(
        'No DTMF tones found. Lower the silence threshold, turn off "Strict checks", or check that the file really holds dial tones (try the Spectrogram: two bright lines at once).',
      );
    }
    const digits = tones.map((t) => t.key).join('');
    const groups = splitByPauses(tones);
    const out: Output[] = [
      { type: 'text', label: 'Keys pressed', value: digits },
      {
        type: 'table',
        label: 'Key presses',
        columns: [
          '#',
          'Key',
          'Start (s)',
          'Length (ms)',
          'Pause before (ms)',
          'Row Hz',
          'Column Hz',
        ],
        rows: tones.map((t, i) => [
          i + 1,
          t.key,
          t.start.toFixed(2),
          Math.round((t.end - t.start) * 1000),
          i === 0 ? '' : Math.round((t.start - tones[i - 1]!.end) * 1000),
          t.rowHz,
          t.colHz,
        ]),
      },
    ];
    if (groups) {
      out.push({ type: 'text', label: 'Keys grouped by pauses', value: groups.join(' ') });
    }
    out.push({
      type: 'text',
      label: 'Phone keypad reading (multi-tap: 2 = ABC, 22 = B …)',
      value: multiTapText(groups ?? [digits]),
    });
    return out;
  },
});
