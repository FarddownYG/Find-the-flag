import { bool, defineTool, number, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { AudioInput, Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { mixToMono } from './_dsp';
import { decodeSstv, SstvFailure, type SstvOptions, type SstvResult } from './_sstv-decode';
import { demodulate, type Demod } from './_sstv-demod';
import { MODES, modeByVis } from './_sstv-modes';
import type { VisHit } from './_sstv-vis';

const T = toolT('sstv');

/** SSTV tones top out at 2300 Hz and the filters need room above them. */
const MIN_RATE = 6000;
/** Longest stretch demodulated at once: 10 minutes (a whole picture is 4.5 minutes at most). */
const MAX_SECONDS = 600;

/**
 * The last demodulation of each decoded recording, kept while the recording itself is alive (the
 * worker holds the decoded samples between runs and drops them when the file is replaced, which
 * frees this too): changing an option (mode, slant...) then skips the heavy filtering.
 */
const demodulations = new WeakMap<Float32Array, { key: string; demod: Demod }>();

function demodulated(audio: AudioInput, channel: string, from: number, length: number): Demod {
  const first = audio.channels[0]!;
  const key = `${channel}/${from}/${length}`;
  const kept = demodulations.get(first);
  if (kept?.key === key) return kept.demod;
  const second = audio.channels[1];
  const mono =
    channel === 'left' || audio.channels.length === 1
      ? first
      : channel === 'right'
        ? (second ?? first)
        : mixToMono(audio.channels);
  const demod = demodulate(mono, audio.sampleRate, from, from + length);
  demodulations.set(first, { key, demod });
  return demod;
}

const fixed = (v: number, digits: number) => v.toFixed(digits);

const visLabel = (h: VisHit) => `${h.code} (0x${h.code.toString(16).padStart(2, '0')})`;

function channelName(channel: string): string {
  if (channel === 'left') return T('value.left');
  if (channel === 'right') return T('value.right');
  if (channel === 'mix') return T('value.mix');
  return T('value.mono');
}

function failure(f: SstvFailure): ToolError {
  switch (f.code) {
    case 'noSync':
      if (f.params.vis) return new ToolError(T('error.noSyncVis'));
      return new ToolError(T('error.noSync'));
    case 'noMode':
      return new ToolError(T('error.noMode', { period: f.params.period ?? 0 }));
    case 'unknownMode':
      return new ToolError(
        T('error.unknownMode', { code: f.params.code ?? 0, period: f.params.period ?? 0 }),
      );
    case 'modeMismatch':
      return new ToolError(
        T('error.modeMismatch', { vis: f.params.vis ?? '', chosen: f.params.chosen ?? '' }),
      );
    case 'noLines':
      return new ToolError(T('error.noLines'));
    case 'noTransmission':
      return new ToolError(
        T('error.noTransmission', { n: f.params.n ?? 0, count: f.params.count ?? 0 }),
      );
    case 'startBeyond':
      return new ToolError(T('error.startBeyond', { s: fixed(Number(f.params.s ?? 0), 2) }));
  }
}

function summary(r: SstvResult, channel: string, o: SstvOptions): [string, string][] {
  const rows = r.image.height;
  const total = r.mode.height;
  const identified =
    r.modeSource === 'vis' && r.header
      ? T('how.vis', { vis: visLabel(r.header), s: fixed(r.header.start, 2) })
      : r.modeSource === 'chosen'
        ? T('how.chosen')
        : T('how.inferred', { ms: fixed(r.period * 1000, 1) });
  const nominal = r.mode.period;
  const sign = r.ppm > 0 ? '+' : '';
  const entries: [string, string][] = [
    [T('kv.mode'), r.mode.name],
    [T('kv.how'), identified],
    [T('kv.size'), `${r.image.width} × ${total}`],
    [T('kv.lines'), T('value.lines', { got: rows, total })],
    [T('kv.start'), `${fixed(Math.max(0, r.pictureStart), 3)} s`],
    [
      T('kv.lineTime'),
      T('value.lineTime', {
        ms: fixed(r.period * 1000, 2),
        nominal: Number(nominal.toFixed(3)),
        ppm: `${sign}${Math.round(r.ppm)}`,
      }),
    ],
    [
      T('kv.sync'),
      T('value.sync', {
        found: r.syncHits,
        total: r.sequences,
        quality: Math.round(100 * r.syncStrength),
        jitter: fixed(r.jitterMs, 2),
      }),
    ],
  ];
  if (o.calibrate) {
    entries.push([
      T('kv.tones'),
      T('value.tones', { hz: fixed(r.syncHz, 1), gain: fixed(r.gain, 3) }),
    ]);
  }
  entries.push([T('kv.channel'), channelName(channel)]);
  return entries;
}

function notes(r: SstvResult, o: SstvOptions, cut: boolean): Output[] {
  const out: Output[] = [];
  const add = (level: 'info' | 'warn', key: string, params?: Record<string, string | number>) =>
    out.push({ type: 'note', level, text: T(key, params) });
  const header = r.header;
  const knownHeader = header ? modeByVis(header.code) : undefined;
  if (!header) {
    if (r.modeSource === 'chosen') add('warn', 'note.noVisChosen');
    else add('warn', 'note.noVis', { ms: fixed(r.period * 1000, 1), mode: r.mode.name });
  } else {
    if (!knownHeader && r.modeSource !== 'chosen') {
      add('warn', 'note.unknownVis', { code: header.code, mode: r.mode.name });
    }
    if (!header.parityOk) add('warn', 'note.parity', { code: header.code });
    if (r.modeSource === 'chosen' && knownHeader && knownHeader.id !== r.mode.id) {
      add('warn', 'note.visMismatch', { vis: knownHeader.name, chosen: r.mode.name });
    }
  }
  if (r.modeSource === 'inferred' && r.alternatives.length) {
    add('warn', 'note.alternatives', { modes: r.alternatives.map((m) => m.name).join(', ') });
  }
  if (r.image.height < r.mode.height) {
    add('info', 'note.partial', { got: r.image.height, total: r.mode.height });
  }
  const missing = r.sequences - r.syncHits;
  if (o.slant === 'manual') {
    add('info', 'note.manual', { ppm: Math.round(o.clockPpm) });
  } else if (r.syncHits >= 3 && missing > Math.max(1, 0.1 * r.sequences)) {
    add('warn', 'note.weakSync', { missing, count: r.sequences });
  }
  if (r.syncHits >= 3 && r.syncStrength < 0.6) {
    add('warn', 'note.noisy', { quality: Math.round(100 * r.syncStrength) });
  }
  if (o.slant === 'auto' && Math.abs(r.ppm) > 300) {
    add('info', 'note.slant', { ppm: `${r.ppm > 0 ? '+' : ''}${Math.round(r.ppm)}` });
  }
  if (r.parityFlipped) add('info', 'note.parityFlipped');
  if (r.headers.length > 1 && o.start <= 0) {
    add('info', 'note.several', { count: r.headers.length, n: o.transmission });
  }
  if (cut) add('info', 'note.cut', { minutes: Math.round(MAX_SECONDS / 60) });
  return out;
}

export default defineTool({
  id: 'sstv',
  name: 'SSTV (slow-scan TV)',
  category: 'audio',
  description:
    'Decode a slow-scan television recording (Robot, Martin, Scottie, PD) from WAV, MP3, FLAC or Ogg into the picture it carries.',
  tags: [
    'sstv',
    'slow scan',
    'slowscan',
    'slow-scan television',
    'qsstv',
    'rx-sstv',
    'mmsstv',
    'slowrx',
    'ham radio',
    'radio picture',
    'robot36',
    'martin',
    'scottie',
    'vis code',
  ],
  input: 'audio',
  live: true,
  placeholder: 'Drop a recording of an SSTV transmission (WAV, MP3, FLAC or Ogg)',
  options: {
    mode: select(
      'Mode',
      [
        { value: 'auto', label: 'Automatic (VIS header)' },
        ...MODES.map((m) => ({ value: m.id, label: m.name })),
      ],
      'auto',
      { hint: 'Force a mode when the VIS header is missing or wrong' },
    ),
    channel: toggle('Channel', [
      { value: 'mix', label: 'Mix' },
      { value: 'left', label: 'Left' },
      { value: 'right', label: 'Right' },
    ]),
    start: number('Picture starts at (s)', 0, {
      min: 0,
      step: 0.1,
      hint: '0 = right after the VIS header, or at the first sync pulse when there is none',
    }),
    transmission: number('Transmission #', 1, {
      min: 1,
      max: 99,
      step: 1,
      hint: 'Which VIS header to decode when the recording holds several pictures',
    }),
    slant: toggle('Line time', [
      { value: 'auto', label: 'Follow the sync pulses' },
      { value: 'manual', label: 'Set by hand' },
    ]),
    clockPpm: number('Clock offset (ppm)', 0, {
      min: -100000,
      max: 100000,
      step: 100,
      hint: 'Line time = nominal × (1 + ppm / 1 000 000). A slanted picture needs a different value; the automatic result is shown in the Line time row.',
      showIf: (v) => v.slant === 'manual',
    }),
    calibrate: bool('Re-centre the tones', true, {
      hint: 'Measure the 1200 Hz sync tone and the 1900 Hz leader, and correct a tuning or clock offset',
    }),
  },
  examples: [
    {
      label: 'Robot 36 (with VOX tones)',
      input: { sample: 'sstv-robot36.wav' },
      expect: 'Mode: Robot 36',
    },
    {
      label: 'Robot 72',
      input: { sample: 'sstv-robot72.wav' },
      expect: 'Mode: Robot 72',
    },
    {
      label: 'Martin M1',
      input: { sample: 'sstv-martin-m1.wav' },
      expect: 'Mode: Martin M1',
    },
    {
      label: 'Scottie S1',
      input: { sample: 'sstv-scottie-s1.wav' },
      expect: 'Mode: Scottie S1',
    },
    {
      label: 'PD 90',
      input: { sample: 'sstv-pd90.wav' },
      expect: 'Mode: PD 90',
    },
    {
      label: 'PD 120, 640 pixels wide',
      input: { sample: 'sstv-pd120.wav' },
      expect: 'Mode: PD 120',
    },
  ],
  detect({ name, bytes }) {
    if (
      !name ||
      !/sstv|slow[ _-]?scan|robot[ _-]?(36|72)|scottie|martin[ _-]?m[12]|pd[ _-]?(50|90|120|160|180|240|290)\b/i.test(
        name,
      )
    ) {
      return null;
    }
    const riff = bytes.length > 12 && String.fromCharCode(...bytes.subarray(8, 12)) === 'WAVE';
    const other =
      bytes.length > 4 &&
      ['ID3', 'OggS', 'fLaC'].some(
        (m) => String.fromCharCode(...bytes.subarray(0, m.length)) === m,
      );
    return riff || other ? { score: 0.5, reason: T('detect.name') } : null;
  },
  run(audio, o) {
    const rate = audio.sampleRate;
    const first = audio.channels[0];
    if (rate < MIN_RATE) throw new ToolError(T('error.lowRate', { rate }));
    if (!first || first.length < rate) throw new ToolError(T('error.short'));
    const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
    const options: SstvOptions = {
      mode: o.mode,
      slant: o.slant,
      clockPpm: finite(o.clockPpm, 0),
      start: Math.max(0, finite(o.start, 0)),
      transmission: Math.max(1, Math.round(finite(o.transmission, 1))),
      calibrate: o.calibrate,
    };
    // A long recording is analysed in a window; asking for a late start moves the window there.
    const from =
      first.length > MAX_SECONDS * rate && options.start > 3
        ? Math.floor((options.start - 3) * rate)
        : 0;
    const length = Math.min(first.length - from, MAX_SECONDS * rate);
    const channel = audio.channels.length > 1 ? o.channel : 'mono';
    const demod = demodulated(audio, channel, from, length);
    let result: SstvResult;
    try {
      result = decodeSstv(demod, options);
    } catch (e) {
      throw e instanceof SstvFailure ? failure(e) : e;
    }
    const out: Output[] = [
      {
        type: 'image',
        label: T('label.picture'),
        image: result.image,
        filename: `sstv-${result.mode.id}.png`,
      },
      { type: 'kv', label: T('label.details'), entries: summary(result, channel, options) },
    ];
    out.push(...notes(result, options, from > 0 || length < first.length));
    if (result.headers.length > 1) {
      out.push({
        type: 'table',
        label: T('label.headers'),
        columns: [T('col.n'), T('col.time'), T('col.vis'), T('col.mode')],
        rows: result.headers.map((h, i) => [
          i + 1,
          fixed(h.start, 2),
          visLabel(h),
          modeByVis(h.code)?.name ?? T('value.unsupported'),
        ]),
        highlight: result.header ? [result.headers.indexOf(result.header)] : [],
      });
    }
    if (result.modeSource === 'inferred' && result.alternatives.length) {
      out.push({
        type: 'actions',
        label: T('label.tryMode'),
        actions: [result.mode, ...result.alternatives].map((m, i) => ({
          label: m.name,
          options: { mode: m.id },
          primary: i === 0,
        })),
      });
    }
    return out;
  },
});
