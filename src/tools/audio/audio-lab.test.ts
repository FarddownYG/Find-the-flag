import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeWav } from '../../core/decode-audio';
import { ToolError } from '../../core/errors';
import { prepareInput } from '../../core/prepare';
import { resultToText } from '../../core/result-text';
import type { AudioInput, Output } from '../../core/types';
import {
  compareChannels,
  encodeWav16,
  fraction,
  midOf,
  pitchShift,
  Resampler,
  reversed,
  sideOf,
  timeStretch,
} from './_audio-lab-dsp';
import { defaults, sine } from './_synth';
import lab, {
  applyChain,
  MAX_SAMPLES,
  MAX_SECONDS,
  parseChain,
  resultSpectrogram,
} from './audio-lab';
import { computeSpectrogram } from './spectrogram';

async function sample(name: string): Promise<AudioInput> {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)),
  );
  return (await prepareInput('audio', { bytes, name })) as AudioInput;
}

const input = (channels: Float32Array[], sampleRate: number): AudioInput => ({
  bytes: new Uint8Array(0),
  name: 'test.wav',
  sampleRate,
  channels,
});

async function run(audio: AudioInput, chain: string): Promise<Output[]> {
  return lab.run(audio, defaults(lab, { chain }) as never);
}

function block<K extends Output['type']>(out: Output[], type: K): Extract<Output, { type: K }> {
  const b = out.find((o) => o.type === type);
  if (!b) throw new Error(`no ${type} block`);
  return b as Extract<Output, { type: K }>;
}

const kv = (out: Output[]) => Object.fromEntries(block(out, 'kv').entries);

/** Best normalised cross-correlation of a and b over lags in [-maxLag, maxLag]. */
function bestCorrelation(a: Float32Array, b: Float32Array, maxLag: number): number {
  let best = -1;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = Math.max(0, -lag); i < a.length && i + lag < b.length; i++) {
      const x = a[i]!;
      const y = b[i + lag]!;
      ab += x * y;
      aa += x * x;
      bb += y * y;
    }
    best = Math.max(best, ab / Math.sqrt(aa * bb));
  }
  return best;
}

/** Frequency carrying the most energy (spectrogram over the whole signal). */
function dominant(x: Float32Array, fs: number): number {
  return computeSpectrogram(x, fs, {
    fftSize: 8192,
    overlap: 0.5,
    maxFreq: 0,
    minFreq: 0,
    scale: 'linear',
  }).dominant;
}

/** Energy of x at `hz` relative to its total energy, in dB (Goertzel-like single bin). */
function bandDb(x: Float32Array, fs: number, hz: number): number {
  let re = 0;
  let im = 0;
  let total = 0;
  for (let i = 0; i < x.length; i++) {
    re += x[i]! * Math.cos((2 * Math.PI * hz * i) / fs);
    im -= x[i]! * Math.sin((2 * Math.PI * hz * i) / fs);
    total += x[i]! * x[i]!;
  }
  return 10 * Math.log10(((re * re + im * im) * 2) / x.length / Math.max(total, 1e-30));
}

describe('the self-made challenge: a reversed voice sped up x1.5 (ffmpeg)', () => {
  it('"reverse, speed 1/1.5" gives back the source voice', async () => {
    const voice = await sample('audio-lab-voice.wav');
    const challenge = await sample('audio-lab-reversed-fast.wav');
    const { channels } = applyChain(challenge, parseChain('reverse, speed 1/1.5'));
    const restored = channels[0]!;
    const source = voice.channels[0]!;
    expect(Math.abs(restored.length - source.length) / source.length).toBeLessThan(0.01);
    expect(bestCorrelation(source, restored, 40)).toBeGreaterThan(0.95);
    // The challenge itself sounds nothing like the voice.
    expect(bestCorrelation(source, challenge.channels[0]!, 40)).toBeLessThan(0.3);
  });

  it('offers the undo as a one-click preset and shows the chain and durations', async () => {
    const out = await run(await sample('audio-lab-reversed-fast.wav'), '');
    const presets = out.find((o) => o.type === 'actions' && o.label === 'Presets');
    const undo = presets?.type === 'actions' ? presets.actions[0] : undefined;
    expect(undo).toEqual({
      label: 'Undo a reversed + ×1.5 voice',
      options: { chain: 'reverse, speed 1/1.5' },
      primary: true,
    });
    const after = await run(
      await sample('audio-lab-reversed-fast.wav'),
      undo!.options.chain as string,
    );
    const k = kv(after);
    expect(k['Chain applied']).toBe('reverse, speed 1/1.5');
    expect(k['Duration']).toBe('1.60 s → 2.40 s (×1.5)');
    expect(k['Output']).toBe('22050 Hz · mono · 2.40 s');
    expect(block(after, 'table').rows).toEqual([
      [1, 'reverse', 'Played backwards (exact)', '1.60 s'],
      [2, 'speed 1/1.5', 'Slower and lower, ×0.6667 (resampled)', '2.40 s'],
    ]);
  });

  it('returns a playable 16-bit WAV of the result and its spectrogram up to Nyquist', async () => {
    const out = await run(await sample('audio-lab-reversed-fast.wav'), 'reverse, speed 1/1.5');
    const audio = block(out, 'audio');
    expect(audio.filename).toBe('audio-lab-reversed-fast-lab.wav');
    const wav = decodeWav(audio.data as Uint8Array);
    expect(wav?.sampleRate).toBe(22050);
    expect(wav?.channels.length).toBe(1);
    expect(Math.abs(wav!.channels[0]!.length / 22050 - 2.4)).toBeLessThan(0.01);
    expect(block(out, 'image').label).toBe('Spectrogram of the result (0 – 11025 Hz)');
    expect(resultToText(out)).toMatch(
      /\[audio audio\/wav audio-lab-reversed-fast-lab\.wav, \d+ bytes\]/,
    );
  });

  it('says plainly that it does not transcribe speech, and points to DTMF and Morse', async () => {
    const text = resultToText(await run(await sample('audio-lab-voice.wav'), 'reverse'));
    expect(text).toContain('No speech recognition here');
    expect(text).toContain('DTMF / phone tones');
    expect(text).toContain('Morse from audio');
  });
});

describe('reverse', () => {
  it('is exact, down to the WAV bytes', async () => {
    const voice = await sample('audio-lab-voice.wav');
    const x = voice.channels[0]!;
    const once = reversed(x);
    expect(reversed(once)).toEqual(x);
    // 16-bit in, 16-bit out: the samples come back bit for bit, in the opposite order.
    const src = new Int16Array(voice.bytes.buffer.slice(44));
    const out = new Int16Array(encodeWav16([once], 22050).bytes.buffer.slice(44));
    expect(Array.from(out)).toEqual(Array.from(src).reverse());
  });

  it('never modifies the input arrays', () => {
    const x = sine(0.2, 8000, 440);
    const copy = x.slice();
    applyChain(input([x], 8000), parseChain('reverse, speed 2, stretch 1.5, pitch 3, normalize'));
    expect(x).toEqual(copy);
  });
});

describe('speed (resampling, pitch follows)', () => {
  it('doubles the pitch and halves the duration at x2, and the reverse at x0.5', () => {
    const fs = 22050;
    const tone = sine(2, fs, 440, 0.5);
    const up = new Resampler(2).process(tone);
    expect(up.length).toBe(tone.length / 2);
    expect(dominant(up, fs)).toBeCloseTo(880, -0.5);
    const down = new Resampler(0.5).process(tone);
    expect(down.length).toBe(tone.length * 2);
    expect(dominant(down, fs)).toBeCloseTo(220, -0.5);
  });

  it('filters what would fold back above Nyquist when speeding up', () => {
    const fs = 22050;
    // 8 kHz x2 = 16 kHz, above the 11025 Hz Nyquist: it must vanish, not alias to 6050 Hz.
    const mixx = sine(1, fs, 8000, 0.5).map(
      (v, i) => v + 0.5 * Math.sin((2 * Math.PI * 1000 * i) / fs),
    );
    const up = new Resampler(2).process(mixx);
    expect(bandDb(up, fs, 2000)).toBeGreaterThan(-4); // the 1 kHz tone, now at 2 kHz
    expect(bandDb(up, fs, fs - 16000)).toBeLessThan(-55); // where the alias would land
  });

  it('keeps a tone below the cut-off at the same level (passband)', () => {
    const fs = 44100;
    const tone = sine(1, fs, 3000, 0.5);
    const slow = new Resampler(1 / 1.5).process(tone);
    let peak = 0;
    for (let i = 2000; i < slow.length - 2000; i++) peak = Math.max(peak, Math.abs(slow[i]!));
    expect(peak).toBeGreaterThan(0.49);
    expect(peak).toBeLessThan(0.51);
  });

  it('turns speeds into exact fractions', () => {
    expect(fraction(1 / 1.5, 1000)).toEqual([2, 3]);
    expect(fraction(0.5, 1000)).toEqual([1, 2]);
    expect(fraction(8, 1000)).toEqual([8, 1]);
    const [p, q] = fraction(2 ** (-3 / 12), 1000);
    expect(Math.abs(p / q - 2 ** (-3 / 12))).toBeLessThan(2e-5); // 0.0004 semitone
  });
});

describe('stretch (WSOLA, pitch kept) and pitch shift (duration kept)', () => {
  const fs = 22050;
  const tone = sine(1, fs, 440, 0.5);

  it('stretch x2 doubles the duration and keeps 440 Hz at 440 Hz', () => {
    const [out] = timeStretch([tone], fs, tone.length * 2);
    expect(out!.length).toBe(tone.length * 2);
    expect(Math.abs(dominant(out!, fs) - 440)).toBeLessThan(2);
    // No dropouts: a steady tone stays steady (WSOLA aligns the frames on the waveform).
    let lo = Infinity;
    let hi = 0;
    for (let s = 2000; s + 1000 < out!.length - 2000; s += 1000) {
      let e = 0;
      for (let i = s; i < s + 1000; i++) e += out![i]! ** 2;
      lo = Math.min(lo, e);
      hi = Math.max(hi, e);
    }
    expect(lo / hi).toBeGreaterThan(0.9);
  });

  it('stretch 0.5 halves the duration, same pitch; stretch 1 is the identity', () => {
    const [half] = timeStretch([tone], fs, tone.length / 2);
    expect(half!.length).toBe(tone.length / 2);
    expect(Math.abs(dominant(half!, fs) - 440)).toBeLessThan(2);
    expect(timeStretch([tone], fs, tone.length)[0]).toBe(tone);
  });

  it('cuts every channel at the same places (the stereo image survives)', () => {
    const r = tone.map((v) => -v);
    const [l2, r2] = timeStretch([tone, r], fs, Math.round(tone.length * 1.7));
    let worst = 0;
    for (let i = 0; i < l2!.length; i++) worst = Math.max(worst, Math.abs(r2![i]! + l2![i]!));
    expect(worst).toBe(0);
  });

  it('pitch +12 doubles the frequency, pitch -5 lowers it, the duration stays', () => {
    const [up] = pitchShift([tone], fs, 12);
    expect(up!.length).toBe(tone.length);
    expect(Math.abs(dominant(up!, fs) - 880)).toBeLessThan(4);
    const [down] = pitchShift([tone], fs, -5);
    expect(down!.length).toBe(tone.length);
    expect(Math.abs(dominant(down!, fs) - 440 * 2 ** (-5 / 12))).toBeLessThan(2);
  });

  it('tempo X is stretch 1/X', async () => {
    const out = await run(input([tone], fs), 'tempo 0.5');
    expect(kv(out)['Duration']).toBe('1.00 s → 2.00 s (×2)');
  });
});

describe('channels', () => {
  const l = Float32Array.from([0.5, -0.25, 1, 0]);
  const r = Float32Array.from([0.25, -0.25, -1, 0.5]);

  it('mid = (L + R) / 2 and side = (L − R) / 2', () => {
    expect(Array.from(midOf(l, r))).toEqual([0.375, -0.25, 0, 0.25]);
    expect(Array.from(sideOf(l, r))).toEqual([0.125, 0, 1, -0.25]);
  });

  it('left, right, mid and side steps pick or combine the channels', () => {
    const audio = input([l, r], 8000);
    expect(applyChain(audio, parseChain('channel left')).channels).toEqual([l]);
    expect(applyChain(audio, parseChain('right')).channels).toEqual([r]);
    expect(applyChain(audio, parseChain('channel l+r')).channels).toEqual([midOf(l, r)]);
    expect(applyChain(audio, parseChain('channel L−R')).channels).toEqual([sideOf(l, r)]);
  });

  it('detects a mono file in a stereo container exactly, else reports max |L − R|', async () => {
    const same = await run(input([l, l.slice()], 8000), '');
    expect(kv(same)['Mono check']).toBe('Mono: L = R exactly (the same sound on both channels)');
    expect(compareChannels(l, r)).toEqual({ identical: false, maxDiff: 2, at: 2, differing: 3 });
    const diff = await run(input([l, r], 8000), '');
    expect(kv(diff)['Mono check']).toBe(
      'Stereo: L ≠ R, max |L − R| = 2.0000 (6.0 dBFS) at 0.00 s; differing samples: 3 of 4',
    );
    expect(kv(await run(input([l], 8000), ''))['Mono check']).toBe('Mono: one channel');
  });

  it('finds the voice hidden in L − R of the stereo sample', async () => {
    const stereo = await sample('audio-lab-stereo.wav');
    const voice = await sample('audio-lab-voice.wav');
    const [side] = applyChain(stereo, parseChain('channel side')).channels;
    const [mid] = applyChain(stereo, parseChain('channel mid')).channels;
    // The voice is all in the side, the hum (110 Hz and harmonics) all in the middle.
    const voice16 = new Resampler(22050 / 16000).process(voice.channels[0]!);
    expect(bestCorrelation(voice16, side!, 20)).toBeGreaterThan(0.95);
    expect(Math.abs(bestCorrelation(voice16, mid!, 20))).toBeLessThan(0.1);
    expect(bandDb(mid!, 16000, 110)).toBeGreaterThan(-4);
    const out = await run(stereo, 'channel side, normalize');
    expect(kv(out)['Output peak']).toBe('-1.0 dBFS');
    expect(kv(out)['Mono check']).toMatch(/^Stereo: L ≠ R/);
  });

  it('draws what is only in L − R, which a mono mix would cancel', async () => {
    const [l, r] = (await sample('audio-lab-stereo.wav')).channels;
    /** Loudest point above 500 Hz (the voice; the hum stops at 220 Hz). */
    const voiceDb = (channels: Float32Array[]) => {
      const sp = resultSpectrogram(channels, 16000);
      const from = Math.ceil((500 / 8000) * (sp.rows - 1));
      let best = -Infinity;
      for (let f = 0; f < sp.frames; f++) {
        for (let k = from; k < sp.rows; k++) best = Math.max(best, sp.db[f * sp.rows + k]!);
      }
      return best;
    };
    expect(voiceDb([l!, r!]) - voiceDb([midOf(l!, r!)])).toBeGreaterThan(20);
  });

  it('warns when L − R of identical channels is silence', async () => {
    const x = sine(0.1, 8000, 440);
    const out = await run(input([x, x.slice()], 8000), 'channel side');
    expect(resultToText(out)).toContain('Step 1: L − R is pure silence');
  });
});

describe('WAV encoding', () => {
  it('round-trips 16-bit samples exactly and interleaves stereo', () => {
    const l = Float32Array.from([0, 1 / 32768, -1, 32767 / 32768]);
    const r = Float32Array.from([-0.5, 0.5, 0.25, -0.25]);
    const { bytes, clipped } = encodeWav16([l, r], 44100);
    expect(bytes.length).toBe(44 + 4 * 2 * 2);
    expect(clipped).toBe(0);
    const back = decodeWav(bytes);
    expect(back?.sampleRate).toBe(44100);
    expect(back?.channels).toEqual([l, r]);
  });

  it('clips beyond full scale and says so', async () => {
    const x = Float32Array.from([0.5, 1.5, -2, 1]);
    expect(encodeWav16([x], 8000).clipped).toBe(2);
    const out = await run(input([sine(0.1, 8000, 440, 0.9)], 8000), 'pitch 0');
    expect(resultToText(out)).not.toContain('clipped');
  });
});

describe('the chain', () => {
  it('accepts several spellings', () => {
    const steps = parseChain('Reverse -> speed x1.5 → stretch=2; pitch(+3) | tempo 150% then norm');
    expect(steps.map((s) => s.text)).toEqual([
      'reverse',
      'speed x1.5',
      'stretch 2',
      'pitch +3',
      'tempo 150%',
      'normalize',
    ]);
    expect(parseChain('speed 1 / 1.5')[0]).toMatchObject({ op: 'speed', value: 1 / 1.5 });
    expect(parseChain('pitch -3.5st')[0]).toMatchObject({ op: 'pitch', value: -3.5 });
    expect(parseChain('  ,, ')).toEqual([]);
  });

  it.each([
    ['revers', 'Step 1 “revers” is not a known transform'],
    ['reverse, speed', 'Step 2 “speed”: give a value, for example “speed 0.5”'],
    ['speed fast', 'Step 1 “speed fast”: “fast” is not a number'],
    ['speed 0', 'Step 1 “speed 0”: the value must be between 0.125 and 8'],
    ['stretch 9', 'Step 1 “stretch 9”: the value must be between 0.2 and 5'],
    ['pitch +30', 'Step 1 “pitch +30”: the value must be between -24 and 24'],
    ['pitch up', 'Step 1 “pitch up”: “up” is not a number of semitones'],
    ['reverse 2', 'Step 1 “reverse 2”: reverse takes no value'],
    ['channel middle', 'Step 1 “channel middle”: the channel must be left, right, mid or side'],
    ['speed 0,5', 'Step 2 “5” is a number on its own'],
    [Array(21).fill('reverse').join(', '), 'The chain has 21 steps; at most 20 are allowed.'],
  ])('rejects %s with a clear message', (chain, message) => {
    let err: unknown;
    try {
      parseChain(chain);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toContain(message);
  });

  it('refuses L − R on a single channel', async () => {
    await expect(run(input([sine(0.1, 8000, 440)], 8000), 'channel side')).rejects.toThrow(
      'Step 1 “channel side”: the sound has only one channel at this point',
    );
    await expect(
      run(input([sine(0.1, 8000, 440), sine(0.1, 8000, 220)], 8000), 'channel left, side'),
    ).rejects.toThrow('Step 2');
  });

  it('refuses an empty file', async () => {
    await expect(run(input([new Float32Array(0)], 8000), 'reverse')).rejects.toThrow(
      'The file contains no audio samples.',
    );
  });

  it('adds a step to the current chain in one click', async () => {
    const out = await run(input([sine(0.1, 8000, 440)], 8000), 'reverse,');
    const add = out.find((o) => o.type === 'actions' && o.label === 'Add a step');
    expect(add?.type === 'actions' && add.actions.map((a) => a.options.chain)).toContain(
      'reverse, stretch 2',
    );
  });
});

describe('limits and speed', () => {
  it('caps the result at 15 minutes and says so', async () => {
    const fs = 8000;
    const long = new Float32Array(fs * (MAX_SECONDS + 30));
    long[0] = 0.5;
    const out = await run(input([long], fs), '');
    const wav = decodeWav(block(out, 'audio').data as Uint8Array);
    expect(wav!.channels[0]!.length).toBe(fs * MAX_SECONDS);
    expect(resultToText(out)).toContain('Result cut at 15:00.00');
    // Slowing down a long file stops at the limit too (the work is bounded, not just the WAV).
    const slow = applyChain(input([long.subarray(0, fs * 600)], fs), parseChain('speed 0.5'));
    expect(slow.capped).toBe(true);
    expect(slow.channels[0]!.length).toBe(fs * MAX_SECONDS);
    expect(MAX_SAMPLES).toBe(60_000_000);
  });

  it('processes a minute of 44.1 kHz stereo within budget', () => {
    const fs = 44100;
    const l = sine(60, fs, 440, 0.3);
    const r = sine(60, fs, 660, 0.3);
    const t0 = performance.now();
    const { channels } = applyChain(
      input([l, r], fs),
      parseChain('reverse, speed 1/1.5, stretch 1.25, pitch -2'),
    );
    encodeWav16(channels, fs);
    const ms = performance.now() - t0;
    expect(channels[0]!.length).toBe(Math.round(Math.round(l.length * 1.5) * 1.25));
    expect(ms).toBeLessThan(20_000); // about 2 s on a laptop
  });
});
