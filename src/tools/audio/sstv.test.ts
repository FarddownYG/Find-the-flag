/**
 * SSTV tests. The recordings in public/samples/sstv-*.wav are made by PySSTV (an encoder this
 * code never saw: see scripts/gen-samples-sstv.py for the two modes it lacks and the three places
 * where its timing was corrected to the specification) and the pictures they carry are in
 * ./sstv-ref/. Every mode is decoded and compared with its source picture pixel by pixel.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeWav } from '../../core/decode-audio';
import { decodeImageExact } from '../../core/decode-image';
import { ToolError } from '../../core/errors';
import type { AudioInput, Output, RgbaImage } from '../../core/types';
import { addNoise, audioInput, defaults } from './_synth';
import { decodeSstv, SstvFailure, type SstvOptions } from './_sstv-decode';
import { Fft } from './_fft';
import { decimationFor, demodulate, toneAt } from './_sstv-demod';
import { MODES, modeById, modeByVis, scansOf, sequencesOf } from './_sstv-modes';
import { findVisHeaders } from './_sstv-vis';
import sstv from './sstv';

const sample = (id: string) => {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../../public/samples/sstv-${id}.wav`, import.meta.url)),
  );
  const wav = decodeWav(bytes)!;
  return { samples: wav.channels[0]!, rate: wav.sampleRate };
};
const reference = (id: string): RgbaImage =>
  decodeImageExact(new Uint8Array(readFileSync(new URL(`./sstv-ref/${id}.png`, import.meta.url))))!;

/** Mean absolute error of the rows both pictures have, over R, G and B (0..255 scale). */
function mae(a: RgbaImage, b: RgbaImage): number {
  expect(a.width).toBe(b.width);
  const rows = Math.min(a.height, b.height);
  let sum = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < a.width; x++) {
      for (let c = 0; c < 3; c++) {
        sum += Math.abs(a.data[(y * a.width + x) * 4 + c]! - b.data[(y * b.width + x) * 4 + c]!);
      }
    }
  }
  return sum / (rows * a.width * 3);
}

const AUTO: SstvOptions = {
  mode: 'auto',
  slant: 'auto',
  clockPpm: 0,
  start: 0,
  transmission: 1,
  calibrate: true,
};
const decode = (x: Float32Array, rate: number, o: Partial<SstvOptions> = {}) =>
  decodeSstv(demodulate(x, rate), { ...AUTO, ...o });

/** Runs the tool itself and sorts what it returns. */
async function runTool(audio: AudioInput, extra: Record<string, unknown> = {}) {
  const out = await sstv.run(audio, defaults(sstv, extra) as never);
  const image = out.find((o) => o.type === 'image') as Extract<Output, { type: 'image' }>;
  const kv = new Map((out.find((o) => o.type === 'kv') as Extract<Output, { type: 'kv' }>).entries);
  const notes = out
    .filter((o): o is Extract<Output, { type: 'note' }> => o.type === 'note')
    .map((o) => o.text);
  return { out, image, kv, notes };
}

/** Linear-interpolation resampling to `rate` (the content stays the same, only the rate changes). */
function resample(x: Float32Array, from: number, to: number): Float32Array {
  const n = Math.floor((x.length * to) / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i * from) / to;
    const j = Math.floor(p);
    out[i] = x[j]! + (p - j) * ((x[j + 1] ?? x[j]!) - x[j]!);
  }
  return out;
}

/**
 * Shift every frequency of a recording by `hz` (single sideband: the analytic signal times a
 * complex exponential). A radio tuned a little off does exactly this.
 */
function shiftFrequencies(x: Float32Array, rate: number, hz: number): Float32Array {
  let n = 2;
  while (n < x.length) n *= 2;
  const fft = new Fft(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x);
  fft.forward(re, im);
  // Keep the positive frequencies (doubled), drop the negative ones: the analytic signal.
  for (let k = 1; k < n / 2; k++) {
    re[k] = re[k]! * 2;
    im[k] = im[k]! * 2;
  }
  for (let k = n / 2 + 1; k < n; k++) {
    re[k] = 0;
    im[k] = 0;
  }
  // Inverse transform by conjugation: ifft(X) = conj(fft(conj(X))) / n.
  for (let k = 0; k < n; k++) im[k] = -im[k]!;
  fft.forward(re, im);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const zr = re[i]! / n;
    const zi = -im[i]! / n;
    const angle = (2 * Math.PI * hz * i) / rate;
    out[i] = zr * Math.cos(angle) - zi * Math.sin(angle);
  }
  return out;
}

/** A phase-continuous sequence of (Hz, ms) tones. */
function tones(segments: [number, number][], rate: number, amp = 0.8): Float32Array {
  const total = segments.reduce((s, [, ms]) => s + ms, 0);
  const out = new Float32Array(Math.round((total * rate) / 1000));
  let phase = 0;
  let at = 0;
  let acc = 0;
  for (const [hz, ms] of segments) {
    acc += (ms * rate) / 1000;
    const end = Math.round(acc);
    for (; at < end; at++) {
      out[at] = amp * Math.sin(phase);
      phase += (2 * Math.PI * hz) / rate;
    }
  }
  return out;
}

/** The calibration header of a transmission: leader, break, leader, VIS code with parity. */
function visHeader(code: number, rate: number, badParity = false): Float32Array {
  let ones = 0;
  const bits: [number, number][] = [];
  for (let i = 0; i < 7; i++) {
    const bit = (code >> i) & 1;
    ones += bit;
    bits.push([bit ? 1100 : 1300, 30]);
  }
  const parity = (ones % 2 === 1) !== badParity;
  return tones(
    [
      [1900, 300],
      [1200, 10],
      [1900, 300],
      [1200, 30],
      ...bits,
      [parity ? 1100 : 1300, 30],
      [1200, 30],
    ],
    rate,
  );
}

const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Mean absolute error limits, with room above what each mode measures today (see the table). */
const LIMITS: Record<string, number> = {
  robot36: 13,
  robot72: 8,
  'martin-m1': 3.5,
  'martin-m2': 6,
  'scottie-s1': 3.5,
  'scottie-s2': 5,
  'scottie-dx': 1.5,
  pd90: 6,
  pd120: 7,
  pd180: 6,
  pd50: 2.5,
  pd160: 1.5,
  pd240: 1.5,
  pd290: 1.5,
};

describe('mode table', () => {
  // Transmission times and VIS codes of the specification (cross-checked against the independent
  // Rust `sstv` crate, 0.2.0, and PySSTV 0.5.9).
  const published: Record<string, [vis: number, seconds: number]> = {
    robot36: [8, 36],
    robot72: [12, 72],
    'martin-m1': [44, 114],
    'martin-m2': [40, 58],
    'scottie-s1': [60, 110],
    'scottie-s2': [56, 71],
    'scottie-dx': [76, 269],
    pd50: [93, 50],
    pd90: [99, 90],
    pd120: [95, 126],
    pd160: [98, 161],
    pd180: [96, 187],
    pd240: [97, 248],
    pd290: [94, 289],
  };

  it('lists every mode once, with the published VIS code and transmission time', () => {
    expect(MODES.map((m) => m.id).sort()).toEqual(Object.keys(published).sort());
    for (const m of MODES) {
      const [vis, seconds] = published[m.id]!;
      expect(m.vis, m.id).toBe(vis);
      expect(modeByVis(vis)?.id).toBe(m.id);
      const total = (sequencesOf(m) * m.period) / 1000;
      expect(Math.abs(total / seconds - 1), `${m.id}: ${total} s`).toBeLessThan(0.01);
    }
  });

  it('puts every scan and sync pulse inside its line', () => {
    for (const m of MODES) {
      expect(m.syncAt + m.syncMs).toBeLessThanOrEqual(m.period + 1e-9);
      for (const layout of m.scans) {
        let previousEnd = 0;
        for (const scan of layout) {
          expect(scan.start + scan.length, `${m.id} ${scan.plane}`).toBeLessThanOrEqual(
            m.period + 1e-6,
          );
          // Scans are in transmission order and do not overlap each other or the sync pulse.
          expect(scan.start).toBeGreaterThanOrEqual(previousEnd - 1e-6);
          previousEnd = scan.start + scan.length;
        }
      }
    }
    expect(scansOf(modeById('robot36')!, 0).map((s) => s.plane)).toEqual(['Y', 'Cr']);
    expect(scansOf(modeById('robot36')!, 1).map((s) => s.plane)).toEqual(['Y', 'Cb']);
  });
});

describe('demodulator', () => {
  it.each([8000, 11025, 22050, 44100, 48000, 96000])('measures a 1900 Hz tone at %i Hz', (rate) => {
    const d = demodulate(tones([[1900, 500]], rate), rate);
    const t = toneAt(d, 0.1, 0.4);
    expect(t.freq).toBeCloseTo(1900, 0);
    expect(t.coherence).toBeGreaterThan(0.99);
    expect(decimationFor(rate)).toBe(Math.max(1, Math.floor(rate / 11000)));
  });

  it('follows a change of frequency at the right instant', () => {
    const rate = 44100;
    const d = demodulate(
      tones(
        [
          [1500, 100],
          [2300, 100],
        ],
        rate,
      ),
      rate,
    );
    expect(toneAt(d, 0.02, 0.08).freq).toBeCloseTo(1500, 0);
    expect(toneAt(d, 0.12, 0.18).freq).toBeCloseTo(2300, 0);
    // A window straddling the change reads in between, weighted by time.
    const mid = toneAt(d, 0.09, 0.11).freq;
    expect(mid).toBeGreaterThan(1750);
    expect(mid).toBeLessThan(2050);
  });

  it('reads a stretch of the recording at the right time', () => {
    const rate = 11025;
    const x = tones([[1200, 1000]], rate);
    const d = demodulate(x, rate, Math.round(rate * 0.5), Math.round(rate * 0.9));
    expect(d.t0).toBeCloseTo(5513 / 11025, 9);
    expect(toneAt(d, 0.6, 0.8).freq).toBeCloseTo(1200, 0);
  });

  it('gives noise a low power next to a tone, whatever its steadiness', () => {
    const rate = 11025;
    const noise = addNoise(new Float32Array(rate), 0.02, 4);
    const tone = tones([[1700, 1000]], rate, 0.5);
    const quiet = toneAt(demodulate(noise, rate), 0.2, 0.8).power;
    const loud = toneAt(demodulate(tone, rate), 0.2, 0.8).power;
    expect(quiet).toBeLessThan(loud / 100);
  });
});

describe('VIS header', () => {
  it('reads the code of every sample', () => {
    for (const m of MODES) {
      const { samples, rate } = sample(m.id);
      const hits = findVisHeaders(demodulate(samples, rate));
      expect(hits, m.id).toHaveLength(1);
      expect(hits[0]).toMatchObject({ code: m.vis, parityOk: true });
      expect(hits[0]!.confidence).toBeGreaterThan(0.9);
      expect(Math.abs(hits[0]!.leaderHz - 1900)).toBeLessThan(2);
      expect(Math.abs(hits[0]!.lowHz - 1200)).toBeLessThan(2);
    }
  });

  it('locates the header and the first line to the millisecond', () => {
    const { samples, rate } = sample('martin-m1');
    const [hit] = findVisHeaders(demodulate(samples, rate));
    // 300 ms leader, 10 ms break, 300 ms leader, then ten 30 ms slots.
    expect(Math.abs(hit!.start - 0.61)).toBeLessThan(0.002);
    expect(Math.abs(hit!.imageStart - 0.91)).toBeLessThan(0.002);
  });

  it('reads codes the tool does not decode, and flags a wrong parity bit', () => {
    const rate = 11025;
    const all = [4, 36, 127, 0].map((code) => {
      const x = join(new Float32Array(rate / 2), visHeader(code, rate), new Float32Array(rate / 2));
      return findVisHeaders(demodulate(x, rate))[0];
    });
    expect(all.map((h) => h?.code)).toEqual([4, 36, 127, 0]);
    expect(all.every((h) => h?.parityOk)).toBe(true);
    // A bad parity bit is only believed for a code of a known mode.
    const wrong = (code: number) =>
      findVisHeaders(
        demodulate(
          join(new Float32Array(rate / 2), visHeader(code, rate, true), new Float32Array(rate / 2)),
          rate,
        ),
      );
    expect(wrong(8)[0]).toMatchObject({ code: 8, parityOk: false });
    expect(wrong(4)).toEqual([]);
  });

  it('finds several headers in one recording', () => {
    const a = sample('robot36');
    const b = sample('martin-m1');
    const x = join(a.samples, new Float32Array(a.rate * 2), b.samples);
    const hits = findVisHeaders(demodulate(x, a.rate));
    expect(hits.map((h) => h.code)).toEqual([8, 44]);
    expect(hits[1]!.start).toBeGreaterThan(a.samples.length / a.rate + 2);
  });

  it('survives a recording rate that is 8.8 % off (44.1 vs 48 kHz)', () => {
    const { samples, rate } = sample('robot36');
    const [hit] = findVisHeaders(demodulate(samples, Math.round((rate * 48) / 44.1)));
    expect(hit).toMatchObject({ code: 8, parityOk: true });
    // Labelled 8.8 % too fast: every duration looks 8.8 % shorter.
    expect(Math.abs(hit!.scale - 44.1 / 48)).toBeLessThan(0.004);
  });
});

describe('every mode, against the picture PySSTV encoded', () => {
  it.each(MODES.map((m) => [m.name, m.id] as const))('%s', (_name, id) => {
    const { samples, rate } = sample(id);
    const r = decode(samples, rate);
    const ref = reference(id);
    expect(r.mode.id).toBe(id);
    expect(r.modeSource).toBe('vis');
    expect(r.header?.code).toBe(r.mode.vis);
    expect(r.image.width).toBe(r.mode.width);
    expect(r.image.height).toBe(ref.height);
    expect(r.sequences).toBe(Math.ceil(ref.height / r.mode.rowsPerSequence));
    expect(r.syncHits).toBe(r.sequences);
    expect(Math.abs(r.ppm)).toBeLessThan(150);
    expect(r.syncStrength).toBeGreaterThan(0.85);
    expect(mae(r.image, ref)).toBeLessThan(LIMITS[id]!);
  });

  it('decodes the colours: bars, text and ramp land where they were drawn', () => {
    const { samples, rate } = sample('martin-m1');
    const { image } = decode(samples, rate);
    const px = (x: number, y: number) => [0, 1, 2].map((c) => image.data[(y * 320 + x) * 4 + c]!);
    const near = (got: number[], want: number[]) =>
      got.forEach((v, i) => expect(Math.abs(v - want[i]!)).toBeLessThan(14));
    // Bars: white, yellow, cyan, green, magenta, red, blue, black (40 px each), rows 0-3.
    const bars = [
      [255, 255, 255],
      [255, 255, 0],
      [0, 255, 255],
      [0, 255, 0],
      [255, 0, 255],
      [255, 0, 0],
      [0, 0, 255],
      [0, 0, 0],
    ];
    bars.forEach((c, i) => near(px(i * 40 + 20, 1), c));
    near(px(5, 20), [16, 24, 64]); // background
    near(px(5, 30), [0, 0, 0]); // ramp: first and last steps
    near(px(315, 30), [255, 255, 255]);
  });
});

describe('without a VIS header', () => {
  // Cut the recording at the end of the header: the first thing left is the first line.
  const headless = (id: string) => {
    const { samples, rate } = sample(id);
    const [hit] = findVisHeaders(demodulate(samples, rate));
    return { x: samples.subarray(Math.round(hit!.imageStart * rate)), rate };
  };

  it.each(
    MODES.filter((m) => m.height / m.rowsPerSequence > 8).map((m) => [m.name, m.id] as const),
  )('guesses %s from the rhythm of the sync pulses', (_name, id) => {
    const { x, rate } = headless(id);
    const r = decode(x, rate);
    expect(r.header).toBeNull();
    expect(r.mode.id).toBe(id);
    expect(r.modeSource).toBe('inferred');
    expect(r.image.height).toBe(reference(id).height);
    expect(mae(r.image, reference(id))).toBeLessThan(LIMITS[id]! * 1.1);
  });

  it('says so, and offers the neighbouring modes when the guess is not certain', async () => {
    const { x, rate } = headless('martin-m1');
    const { notes, kv, out } = await runTool(audioInput(x, rate));
    expect(notes.join(' ')).toContain('No VIS header was found');
    expect(kv.get('Identified by')).toContain('no VIS header');
    expect(out.some((o) => o.type === 'table')).toBe(false);
  });

  it('starts where the user says when the mode is chosen and the header is lost', () => {
    const { x, rate } = headless('scottie-s1');
    const lead = addNoise(new Float32Array(rate * 3), 0.02, 9);
    const r = decode(join(lead, x), rate, { mode: 'scottie-s1', start: 3 });
    expect(r.modeSource).toBe('chosen');
    expect(r.image.height).toBe(32);
    expect(mae(r.image, reference('scottie-s1'))).toBeLessThan(LIMITS['scottie-s1']! * 1.1);
  });

  it('uses the first pulse as the first line when the mode is chosen and no start is given', async () => {
    const { x, rate } = headless('pd90');
    const { notes, image } = await runTool(audioInput(x, rate), { mode: 'pd90' });
    expect(notes.join(' ')).toContain('picture starts at the first sync pulse');
    expect(mae(image.image, reference('pd90'))).toBeLessThan(LIMITS.pd90! * 1.1);
  });

  it('puts Robot 36 colours right when the first line is a B-Y line', () => {
    const { x, rate } = headless('robot36');
    const r = decode(x.subarray(Math.round(0.15 * rate)), rate);
    expect(r.mode.id).toBe('robot36');
    expect(r.parityFlipped).toBe(true);
    // The picture lost its first row: compare with rows 1.. of the source.
    const ref = reference('robot36');
    const shifted: RgbaImage = {
      width: 320,
      height: ref.height - 1,
      data: ref.data.slice(320 * 4),
    };
    expect(mae(r.image, shifted)).toBeLessThan(LIMITS.robot36! * 1.4);
  });
});

describe('a mode forced against the header', () => {
  it('says what the header said when no pulse fits the mode that was chosen', async () => {
    const { samples, rate } = sample('martin-m1');
    await expect(runTool(audioInput(samples, rate), { mode: 'martin-m2' })).rejects.toThrow(
      'The header says Martin M1, but you chose Martin M2',
    );
  });

  it('decodes with the chosen mode when it agrees with the header', async () => {
    const { samples, rate } = sample('martin-m1');
    const { kv, notes } = await runTool(audioInput(samples, rate), { mode: 'martin-m1' });
    expect(kv.get('Mode')).toBe('Martin M1');
    expect(kv.get('Identified by')).toBe('the Mode option');
    expect(notes.join(' ')).not.toContain('The header says');
  });
});

describe('slant: a recording clock that is not the sender’s', () => {
  // Re-labelling the sample rate stretches time and shifts every tone by the same ratio, which is
  // exactly what a sound card running a little fast or slow does.
  it.each([
    ['martin-m1', 1.003],
    ['martin-m1', 0.995],
    ['robot36', 1.02],
    ['scottie-s1', 0.95],
    ['pd120', 1.003],
  ] as const)('%s at x%f is straightened from the sync pulses', (id, k) => {
    const { samples, rate } = sample(id);
    const r = decode(samples, rate * k);
    const expected = (1 / k - 1) * 1e6;
    expect(Math.abs(r.ppm - expected)).toBeLessThan(250);
    expect(mae(r.image, reference(id))).toBeLessThan(LIMITS[id]! * 1.15);
    expect(r.syncHits).toBe(r.sequences);
  });

  it('an 8.8 % error (44.1 kHz read as 48 kHz) still gives a picture', () => {
    const { samples, rate } = sample('martin-m1');
    const r = decode(samples, (rate * 48) / 44.1);
    expect(mae(r.image, reference('martin-m1'))).toBeLessThan(8);
  });

  it('a manual line time replaces the automatic one', () => {
    const { samples, rate } = sample('martin-m1');
    const ref = reference('martin-m1');
    const slanted = rate * 1.003;
    const auto = decode(samples, slanted);
    const manual = decode(samples, slanted, { slant: 'manual', clockPpm: auto.ppm });
    expect(mae(manual.image, ref)).toBeLessThan(LIMITS['martin-m1']! * 1.2);
    expect(manual.ppm).toBeCloseTo(auto.ppm, -1);
    // Zero offset leaves the slant in: the lines drift away from where the pulses are.
    const none = decode(samples, slanted, { slant: 'manual', clockPpm: 0 });
    expect(mae(none.image, ref)).toBeGreaterThan(5 * mae(auto.image, ref));
  });

  it('can be switched off: tones are then taken as they are', () => {
    const { samples, rate } = sample('robot36');
    const r = decode(samples, rate * 1.02, { calibrate: false });
    expect(r.syncHz).toBe(1200);
    expect(r.gain).toBe(1);
    const calibrated = decode(samples, rate * 1.02);
    expect(mae(r.image, reference('robot36'))).toBeGreaterThan(
      mae(calibrated.image, reference('robot36')),
    );
  });

  it.each([40, -60])(
    'a tuning offset of %i Hz is measured from the sync tone and removed',
    (hz) => {
      const { samples, rate } = sample('martin-m1');
      const shifted = shiftFrequencies(samples, rate, hz);
      const r = decode(shifted, rate);
      expect(r.syncHz).toBeCloseTo(1200 + hz, 0);
      expect(Math.abs(r.ppm)).toBeLessThan(150);
      expect(mae(r.image, reference('martin-m1'))).toBeLessThan(LIMITS['martin-m1']! * 1.2);
      // Left alone, the colours slide: +40 Hz is 13 grey levels everywhere.
      const raw = decode(shifted, rate, { calibrate: false });
      expect(mae(raw.image, reference('martin-m1'))).toBeGreaterThan(8);
    },
  );
});

describe('noise and cuts', () => {
  it.each([
    ['robot36', 0.2, 35],
    ['martin-m1', 0.2, 20],
    ['pd90', 0.2, 28],
    ['scottie-s1', 0.3, 28],
    ['martin-m1', 0.5, 40],
  ] as const)('%s with noise of %f (rms, full scale 1) stays readable', (id, sigma, limit) => {
    const { samples, rate } = sample(id);
    const noisy = addNoise(Float32Array.from(samples), sigma, 11);
    const r = decode(noisy, rate);
    expect(r.mode.id).toBe(id);
    expect(mae(r.image, reference(id))).toBeLessThan(limit);
    // The noise shows in the sync quality, which the tool reports.
    expect(r.syncStrength).toBeLessThan(0.97);
  });

  it('refuses a recording that is mostly noise instead of drawing garbage', () => {
    const { samples, rate } = sample('martin-m1');
    const noisy = addNoise(Float32Array.from(samples), 1, 5);
    expect(() => decode(noisy, rate)).toThrow(SstvFailure);
    expect(() => decode(addNoise(new Float32Array(rate * 20), 0.3, 6), rate)).toThrow(SstvFailure);
    expect(() => decode(new Float32Array(rate * 20), rate)).toThrow(SstvFailure);
  });

  it('keeps the rows received when the recording is cut', async () => {
    const { samples, rate } = sample('martin-m1');
    const cut = samples.subarray(0, Math.round(samples.length * 0.6));
    const r = decode(cut, rate);
    expect(r.image.height).toBeGreaterThan(10);
    expect(r.image.height).toBeLessThan(32);
    expect(r.sequences).toBe(r.image.height);
    expect(mae(r.image, reference('martin-m1'))).toBeLessThan(LIMITS['martin-m1']!);
    const { notes, kv } = await runTool(audioInput(cut, rate));
    expect(notes.join(' ')).toMatch(/Only \d+ of 256 lines were received/);
    expect(kv.get('Lines received')).toMatch(/^\d+ of 256$/);
  });

  it('gives whole line pairs for PD, and stops at the picture height', () => {
    const { samples, rate } = sample('pd90');
    const r = decode(samples.subarray(0, Math.round(samples.length * 0.5)), rate);
    expect(r.image.height % 2).toBe(0);
    expect(r.image.height).toBe(r.sequences * 2);
  });

  it('ignores what comes before and after the picture', () => {
    const { samples, rate } = sample('robot72');
    const x = join(
      addNoise(new Float32Array(rate * 3), 0.05, 1),
      samples,
      addNoise(new Float32Array(rate * 5), 0.05, 2),
    );
    const r = decode(x, rate);
    expect(r.header?.start).toBeGreaterThan(3);
    expect(r.image.height).toBe(32);
    expect(mae(r.image, reference('robot72'))).toBeLessThan(LIMITS.robot72!);
  });

  it('shows a weak, fading line as a gap in the sync report', async () => {
    const { samples, rate } = sample('martin-m1');
    const x = Float32Array.from(samples);
    // Kill lines 10-13 (a deep fade): 446.446 ms each, starting 0.9065 s after the start.
    const from = Math.round((0.9065 + 10 * 0.446446) * rate);
    const to = Math.round((0.9065 + 14 * 0.446446) * rate);
    for (let i = from; i < to; i++) x[i] = 0;
    const { notes, kv } = await runTool(audioInput(x, rate));
    expect(kv.get('Sync pulses')).toMatch(/^2[0-9] of 32 located/);
    expect(notes.join(' ')).toContain('have no clear sync pulse');
  });
});

describe('sample rates and channels', () => {
  it.each([16000, 22050, 44100, 48000, 96000])('decodes after resampling to %i Hz', (to) => {
    const { samples, rate } = sample('martin-m1');
    const r = decode(resample(samples, rate, to), to);
    expect(r.mode.id).toBe('martin-m1');
    expect(mae(r.image, reference('martin-m1'))).toBeLessThan(LIMITS['martin-m1']! * 1.2);
  });

  it('uses the channel asked for, and mixes by default', async () => {
    const { samples, rate } = sample('robot36');
    const quiet = addNoise(new Float32Array(samples.length), 0.01, 3);
    const stereo: AudioInput = {
      bytes: new Uint8Array(0),
      name: 'stereo.wav',
      sampleRate: rate,
      channels: [quiet, samples],
    };
    for (const channel of ['mix', 'right']) {
      const { kv, image } = await runTool(stereo, { channel });
      expect(kv.get('Mode')).toBe('Robot 36');
      expect(mae(image.image, reference('robot36'))).toBeLessThan(LIMITS.robot36!);
    }
    await expect(runTool(stereo, { channel: 'left' })).rejects.toBeInstanceOf(ToolError);
    const { kv } = await runTool(stereo, { channel: 'right' });
    expect(kv.get('Channel analysed')).toBe('right');
  });
});

describe('several transmissions in one file', () => {
  const a = sample('robot36');
  const b = sample('martin-m1');
  const both = audioInput(join(a.samples, new Float32Array(a.rate * 2), b.samples), a.rate);

  it('decodes the first by default and lists both', async () => {
    const { kv, notes, out } = await runTool(both);
    expect(kv.get('Mode')).toBe('Robot 36');
    expect(notes.join(' ')).toContain('VIS headers found: 2');
    const table = out.find((o) => o.type === 'table') as Extract<Output, { type: 'table' }>;
    expect(table.rows.map((r) => r[3])).toEqual(['Robot 36', 'Martin M1']);
    expect(table.highlight).toEqual([0]);
  });

  it('decodes the one asked for', async () => {
    const { kv, image } = await runTool(both, { transmission: 2 });
    expect(kv.get('Mode')).toBe('Martin M1');
    expect(mae(image.image, reference('martin-m1'))).toBeLessThan(LIMITS['martin-m1']!);
  });

  it('says when there is no such transmission', async () => {
    await expect(runTool(both, { transmission: 3 })).rejects.toThrow(
      'VIS headers found: 2. There is no transmission #3.',
    );
  });
});

describe('unsupported and doubtful headers', () => {
  it('reads an unknown code, then guesses the mode from the sync rhythm', async () => {
    const { samples, rate } = sample('robot36');
    const [hit] = findVisHeaders(demodulate(samples, rate));
    const image = samples.subarray(Math.round(hit!.imageStart * rate));
    const x = join(new Float32Array(rate), visHeader(4, rate), image);
    const { kv, notes } = await runTool(audioInput(x, rate));
    expect(kv.get('Mode')).toBe('Robot 36');
    expect(notes.join(' ')).toContain('VIS header carries code 4, which this tool does not decode');
  });

  it('reports a wrong parity bit of a known code', async () => {
    const { samples, rate } = sample('robot36');
    const [hit] = findVisHeaders(demodulate(samples, rate));
    const image = samples.subarray(Math.round(hit!.imageStart * rate));
    const x = join(new Float32Array(rate), visHeader(8, rate, true), image);
    const { kv, notes } = await runTool(audioInput(x, rate));
    expect(kv.get('Mode')).toBe('Robot 36');
    expect(notes.join(' ')).toContain('parity bit of the VIS header is wrong');
  });

  it('fails with a sentence when nothing follows the header', async () => {
    const rate = 11025;
    const x = join(visHeader(44, rate), addNoise(new Float32Array(rate * 3), 0.05, 2));
    await expect(runTool(audioInput(x, rate))).rejects.toThrow(
      'A VIS header was found, but no regular sync pulses follow it',
    );
  });
});

describe('the tool', () => {
  it('returns the picture as an image block named after the mode, with details', async () => {
    const { samples, rate } = sample('pd120');
    const { image, kv, notes } = await runTool(audioInput(samples, rate, 'x.wav'));
    expect(image.filename).toBe('sstv-pd120.png');
    expect(image.image.width).toBe(640);
    expect(kv.get('Mode')).toBe('PD 120');
    expect(kv.get('Identified by')).toBe('VIS header 95 (0x5f) at 0.61 s');
    expect(kv.get('Picture size')).toBe('640 × 496');
    expect(kv.get('Lines received')).toBe('48 of 496');
    expect(kv.get('Line time')).toMatch(/^508\.\d\d ms \(standard 508\.48 ms, [+-]?\d+ ppm\)$/);
    expect(kv.get('Sync pulses')).toMatch(/^24 of 24 located, quality 9\d %, jitter 0\.\d\d ms$/);
    expect(kv.get('Tones')).toMatch(
      /^sync tone seen at 1200\.\d Hz \(standard 1200 Hz\), gain 1\.000$/,
    );
    expect(notes.join(' ')).toContain('Only 48 of 496 lines were received');
  });

  it('proposes a close neighbour when the line time falls between two modes', async () => {
    // Martin M1 (446 ms) on a clock 4 % off has the line time of Scottie S1 (428 ms): only the
    // length of the sync pulse tells them apart, and the other one is offered as a button.
    const { samples, rate } = sample('martin-m1');
    const [hit] = findVisHeaders(demodulate(samples, rate));
    const x = samples.subarray(Math.round(hit!.imageStart * rate));
    const { out, kv, notes } = await runTool(audioInput(x, Math.round(rate * 1.04)));
    expect(kv.get('Mode')).toBe('Martin M1');
    expect(notes.join(' ')).toContain('Other modes have a similar line time (Scottie S1)');
    const actions = out.find((o) => o.type === 'actions') as Extract<Output, { type: 'actions' }>;
    expect(actions.actions.map((a) => a.options.mode)).toEqual(['martin-m1', 'scottie-s1']);
    expect(actions.actions[0]!.primary).toBe(true);
  });

  it('refuses what cannot hold a picture', async () => {
    await expect(runTool(audioInput(new Float32Array(4000 * 3), 4000))).rejects.toThrow(
      'The sample rate is 4000 Hz',
    );
    await expect(runTool(audioInput(new Float32Array(500), 8000))).rejects.toThrow(
      'shorter than one second',
    );
    await expect(runTool(audioInput(new Float32Array(8000 * 5), 8000))).rejects.toBeInstanceOf(
      ToolError,
    );
    const { samples, rate } = sample('robot36');
    await expect(
      runTool(audioInput(samples, rate), { mode: 'robot36', start: 60 }),
    ).rejects.toThrow('is past the end of the recording');
  });

  it('keeps the last demodulation for the same samples, never for others', async () => {
    const a = sample('martin-m1');
    const b = sample('robot72');
    const audioA = audioInput(a.samples, a.rate);
    const first = await runTool(audioA);
    const manual = await runTool(audioA, { slant: 'manual', clockPpm: 0 });
    const other = await runTool(audioInput(b.samples, b.rate));
    const back = await runTool(audioA);
    expect(first.kv.get('Mode')).toBe('Martin M1');
    expect(manual.kv.get('Mode')).toBe('Martin M1');
    expect(other.kv.get('Mode')).toBe('Robot 72');
    expect(back.kv.get('Mode')).toBe('Martin M1');
    expect(mae(back.image.image, first.image.image)).toBe(0);
  });

  it('triage: suggests it for an audio file named after SSTV, and only then', () => {
    const wav = new Uint8Array(44);
    wav.set(
      [...'RIFF'].map((c) => c.charCodeAt(0)),
      0,
    );
    wav.set(
      [...'WAVE'].map((c) => c.charCodeAt(0)),
      8,
    );
    expect(sstv.detect!({ text: null, bytes: wav, name: 'robot36-challenge.wav' })).toMatchObject({
      score: 0.5,
    });
    expect(sstv.detect!({ text: null, bytes: wav, name: 'my-SSTV.wav' })).not.toBeNull();
    expect(sstv.detect!({ text: null, bytes: wav, name: 'voice.wav' })).toBeNull();
    expect(sstv.detect!({ text: null, bytes: new Uint8Array(20), name: 'sstv.txt' })).toBeNull();
  });
});

describe('input that is not SSTV', () => {
  // Trains of 1200 Hz beeps and noise are full of pulses that look like sync pulses: the search
  // has to give up quickly and say so, not hang or draw a picture.
  it.each([
    ['beeps every 25 ms', (t: number) => (t % 0.025 < 0.01 ? 1 : 0)],
    ['beeps every 100 ms', (t: number) => (t % 0.1 < 0.02 ? 1 : 0)],
    ['beeps every 150 ms', (t: number) => (t % 0.15 < 0.009 ? 1 : 0)],
  ])('%s', (_name, gate) => {
    const rate = 8000;
    const x = new Float32Array(rate * 180);
    for (let i = 0; i < x.length; i++) {
      x[i] = 0.5 * gate(i / rate) * Math.sin((2 * Math.PI * 1200 * i) / rate);
    }
    const t0 = performance.now();
    expect(() => decode(x, rate)).toThrow(SstvFailure);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('white noise of any loudness', () => {
    for (const sigma of [0.02, 0.3, 0.9]) {
      const x = addNoise(new Float32Array(8000 * 180), sigma, 4);
      expect(() => decode(x, 8000), `sigma ${sigma}`).toThrow(SstvFailure);
    }
  });
});

describe('a very long recording', () => {
  it('analyses the first ten minutes, and moves on when asked where the picture is', async () => {
    const { samples, rate } = sample('martin-m1');
    const x = new Float32Array(rate * 700);
    addNoise(x, 0.02, 8);
    x.set(samples, rate * 650);
    const audio = audioInput(x, rate);
    await expect(runTool(audio)).rejects.toBeInstanceOf(ToolError);
    const { kv, notes } = await runTool(audio, { start: 650.91 });
    expect(kv.get('Mode')).toBe('Martin M1');
    expect(kv.get('Lines received')).toBe('32 of 256');
    expect(notes.join(' ')).toContain('Only the first 10 minutes of the recording were analysed');
  });
});

describe('a long recording', () => {
  it('decodes two minutes at 44.1 kHz quickly, from a picture buried in noise', () => {
    const { samples, rate } = sample('martin-m1');
    const rate2 = 44100;
    const x = new Float32Array(120 * rate2);
    addNoise(x, 0.02, 3);
    x.set(resample(samples, rate, rate2), 40 * rate2);
    const t0 = performance.now();
    const r = decode(x, rate2);
    const seconds = (performance.now() - t0) / 1000;
    expect(r.header?.start).toBeGreaterThan(40);
    expect(r.image.height).toBe(32);
    expect(mae(r.image, reference('martin-m1'))).toBeLessThan(LIMITS['martin-m1']! * 1.2);
    expect(seconds).toBeLessThan(8);
  });
});
