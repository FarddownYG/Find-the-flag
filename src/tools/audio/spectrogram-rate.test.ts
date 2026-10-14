import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { probeSampleRate } from '../../core/audio-rate';
import { ToolError } from '../../core/errors';
import { prepareInput } from '../../core/prepare';
import type { AudioInput, RgbaImage } from '../../core/types';
import { frequencyToY, plotRect, timeToX } from './_axes';
import { audioInput, defaults, sine } from './_synth';
import spectrogram, {
  computeSpectrogram,
  drawSpectrogram,
  renderSpectrogram,
  spectrogramAxes,
} from './spectrogram';

const base = { fftSize: 2048, overlap: 0.75, maxFreq: 0, minFreq: 0, scale: 'linear' as const };
const render = { colormap: 'inferno' as const, floor: 90, ceiling: 0 };

/** Row (from the top of the whole picture) of the brightest pixel of the plot's middle column. */
function brightestRow(img: RgbaImage): number {
  const box = plotRect(img.width, img.height);
  let best = -1;
  let bestValue = -1;
  for (let y = box.y; y < box.y + box.height; y++) {
    const o = (y * img.width + box.x + (box.width >> 1)) * 4;
    const v = img.data[o]! + img.data[o + 1]! + img.data[o + 2]!;
    if (v > bestValue) {
      bestValue = v;
      best = y;
    }
  }
  return best;
}

describe('the default view covers 0 to Nyquist of the real sample rate', () => {
  it.each([
    [8000, 1000],
    [11025, 3000],
    [22050, 6500],
    [44100, 15000],
    [48000, 20000],
    [96000, 30000],
    [192000, 80000],
  ])('%i Hz: a %i Hz tone sits at its own height, on a linear axis', (fs, tone) => {
    const sp = computeSpectrogram(sine(1.5, fs, tone, 0.5), fs, base);
    expect(sp.fMin).toBe(0);
    expect(sp.fMax).toBe(fs / 2);
    expect(sp.sampleRate).toBe(fs);
    expect(sp.peak.freq).toBeCloseTo(tone, -1);
    const img = drawSpectrogram(sp, render);
    const expected =
      plotRect(img.width, img.height).y + Math.floor(frequencyToY(spectrogramAxes(sp), tone));
    expect(Math.abs(brightestRow(img) - expected)).toBeLessThanOrEqual(3);
  });

  it.each([
    [22050, 6500],
    [48000, 15000],
    [192000, 80000],
  ])('%i Hz: the same on a log axis (%i Hz tone)', (fs, tone) => {
    const sp = computeSpectrogram(sine(1.5, fs, tone, 0.5), fs, { ...base, scale: 'log' });
    expect(sp.fMax).toBe(fs / 2);
    expect(sp.fMin).toBeGreaterThanOrEqual(20);
    const img = drawSpectrogram(sp, render);
    const expected =
      plotRect(img.width, img.height).y + Math.floor(frequencyToY(spectrogramAxes(sp), tone));
    expect(Math.abs(brightestRow(img) - expected)).toBeLessThanOrEqual(3);
  });

  it('frequency zoom keeps the tone where the axis says it is', () => {
    const fs = 44100;
    const sp = computeSpectrogram(sine(1.5, fs, 9000, 0.5), fs, {
      ...base,
      minFreq: 8000,
      maxFreq: 10000,
    });
    expect([sp.fMin, sp.fMax]).toEqual([8000, 10000]);
    const img = drawSpectrogram(sp, render);
    const expected =
      plotRect(img.width, img.height).y + Math.floor(frequencyToY(spectrogramAxes(sp), 9000));
    expect(Math.abs(brightestRow(img) - expected)).toBeLessThanOrEqual(3);
    // A tone outside the zoomed band is not drawn.
    const out = computeSpectrogram(sine(1.5, fs, 3000, 0.5), fs, {
      ...base,
      minFreq: 8000,
      maxFreq: 10000,
    });
    expect(out.maxDb).toBeLessThan(-60);
  });

  it('puts time where the axis says it is', () => {
    const fs = 22050;
    const x = new Float32Array(3 * fs);
    x.set(sine(0.5, fs, 4000, 0.5), Math.round(1 * fs)); // a burst from 1.0 s to 1.5 s
    const sp = computeSpectrogram(x, fs, { ...base, fftSize: 1024, overlap: 0.9 });
    const axes = spectrogramAxes(sp);
    const img = drawSpectrogram(sp, render);
    const box = plotRect(img.width, img.height);
    const row = box.y + Math.floor(frequencyToY(axes, 4000));
    const lit: number[] = [];
    for (let px = 0; px < axes.width; px++) {
      const o = (row * img.width + box.x + px) * 4;
      if (img.data[o]! > 128) lit.push(px);
    }
    const seconds = (px: number) =>
      sp.time0 + ((px - axes.columnWidth / 2) / axes.columnWidth) * axes.hopSeconds;
    expect(seconds(Math.min(...lit))).toBeGreaterThan(0.93);
    expect(seconds(Math.min(...lit))).toBeLessThan(1.07);
    expect(seconds(Math.max(...lit))).toBeGreaterThan(1.43);
    expect(seconds(Math.max(...lit))).toBeLessThan(1.57);
    expect(timeToX(axes, 1)).toBeCloseTo(
      ((1 - sp.time0) / axes.hopSeconds + 0.5) * axes.columnWidth,
      6,
    );
  });
});

describe('time zoom', () => {
  const fs = 8000;
  const two = new Float32Array(2 * fs);
  two.set(sine(1, fs, 1000, 0.5), 0);
  two.set(sine(1, fs, 3000, 0.5), fs);

  it('analyses only the chosen part and reports absolute times', () => {
    const first = computeSpectrogram(two, fs, { ...base, endTime: 1 });
    expect([first.time0, first.time1]).toEqual([0, 1]);
    expect(first.peak.freq).toBeCloseTo(1000, -1);

    const second = computeSpectrogram(two, fs, { ...base, startTime: 1 });
    expect([second.time0, second.time1]).toEqual([1, 2]);
    expect(second.peak.freq).toBeCloseTo(3000, -1);
    expect(second.peak.time).toBeGreaterThanOrEqual(1);
    expect(second.peak.time).toBeLessThanOrEqual(2);

    const middle = computeSpectrogram(two, fs, { ...base, startTime: 0.5, endTime: 1.5 });
    expect([middle.time0, middle.time1]).toEqual([0.5, 1.5]);
    expect(middle.frames).toBeLessThan(first.frames * 2);
  });

  it('end 0 means the end of the file and a too-large end is clamped', () => {
    const a = computeSpectrogram(two, fs, { ...base, endTime: 0 });
    const b = computeSpectrogram(two, fs, { ...base, endTime: 99 });
    expect(a.time1).toBe(2);
    expect(b.time1).toBe(2);
  });

  it('explains an empty or backwards range', () => {
    expect(() => computeSpectrogram(two, fs, { ...base, startTime: 5 })).toThrow(ToolError);
    expect(() => computeSpectrogram(two, fs, { ...base, startTime: 1, endTime: 0.5 })).toThrow(
      /Nothing to analyse/,
    );
    expect(() => computeSpectrogram(two, fs, { ...base, startTime: 5 })).toThrow(/after the end/);
  });

  it('the tool reports the shown time range', async () => {
    const out = await spectrogram.run(audioInput(two, fs), {
      ...defaults(spectrogram),
      startTime: 1,
      endTime: 1.5,
    } as never);
    const kv = out.find((o) => o.type === 'kv');
    expect(kv?.type === 'kv' && kv.entries).toContainEqual(['Time shown', '1.00 – 1.50 s']);
    expect(kv?.type === 'kv' && kv.entries.find(([k]) => k === 'Duration')?.[1]).toBe('2.00 s');
  });
});

describe('sample rate in the report', () => {
  const kvOf = async (audio: AudioInput, extra: Record<string, unknown> = {}) => {
    const out = await spectrogram.run(audio, { ...defaults(spectrogram), ...extra } as never);
    const kv = out.find((o) => o.type === 'kv');
    return { out, entries: new Map(kv?.type === 'kv' ? kv.entries : []) };
  };

  it('shows the rate, Nyquist and the band for any rate', async () => {
    const { entries } = await kvOf({
      ...audioInput(sine(1, 22050, 5000), 22050),
      rateSource: 'file',
    } as AudioInput);
    expect(entries.get('Sample rate')).toBe('22050 Hz (from the file)');
    expect(entries.get('Nyquist')).toBe('11025 Hz');
    expect(entries.get('Frequencies shown')).toBe('0 – 11025 Hz (linear)');
    const odd = await kvOf(audioInput(sine(1, 11025, 1000), 11025));
    expect(odd.entries.get('Nyquist')).toBe('5512.5 Hz');
    expect(odd.entries.get('Sample rate')).toBe('11025 Hz');
  });

  it('says so when the decoder had to guess, and when Opus was decoded at 48000 Hz', async () => {
    const guessed = await kvOf({
      ...audioInput(sine(1, 44100, 1000), 44100),
      rateSource: 'decoder',
    } as AudioInput);
    expect(guessed.entries.get('Sample rate')).toMatch(/^44100 Hz \(browser decoder/);
    expect(guessed.out.some((o) => o.type === 'note' && o.level === 'warn')).toBe(true);

    const opus = await kvOf({
      ...audioInput(sine(1, 48000, 1000), 48000),
      rateSource: 'file',
      originalRate: 44100,
    } as AudioInput);
    expect(opus.entries.get('Sample rate')).toBe(
      '48000 Hz (Opus is always decoded at 48000 Hz; the original recording was at 44100 Hz)',
    );
  });

  it('limits a max frequency above Nyquist and says so', async () => {
    const { out, entries } = await kvOf(audioInput(sine(1, 8000, 1000), 8000), { maxFreq: 20000 });
    expect(entries.get('Frequencies shown')).toBe('0 – 4000 Hz (linear)');
    expect(out.some((o) => o.type === 'note' && /Nyquist/.test(o.text))).toBe(true);
  });
});

describe('the 22050 Hz samples', () => {
  const sampleBytes = (name: string) =>
    new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

  it('the MP3 header says 22050 Hz', () => {
    expect(probeSampleRate(sampleBytes('audio-spectrogram-22k.mp3'))).toEqual({
      format: 'mp3',
      decodeRate: 22050,
    });
  });

  it('HELLO 7KHZ is drawn between 6000 and 8000 Hz in the default full-band view', async () => {
    const audio = (await prepareInput('audio', {
      bytes: sampleBytes('audio-spectrogram-22k.wav'),
      name: 'audio-spectrogram-22k.wav',
    })) as AudioInput;
    expect(audio.sampleRate).toBe(22050);
    const opts = { ...defaults(spectrogram), fftSize: '1024', overlap: 90 };
    const out = await spectrogram.run(audio, opts as never);
    const kv = out.find((o) => o.type === 'kv');
    const entries = new Map(kv?.type === 'kv' ? kv.entries : []);
    expect(entries.get('Sample rate')).toBe('22050 Hz (from the file)');
    expect(entries.get('Frequencies shown')).toBe('0 – 11025 Hz (linear)');

    // Where the energy is: rows between 6000 and 8000 Hz carry far more than the rest.
    const sp = computeSpectrogram(audio.channels[0]!, 22050, {
      ...base,
      fftSize: 1024,
      overlap: 0.9,
    });
    const rowEnergy = (hz: number) => {
      const r = Math.round((hz / 11025) * (sp.rows - 1));
      let sum = 0;
      for (let t = 0; t < sp.frames; t++) sum += 10 ** (sp.db[t * sp.rows + r]! / 10);
      return sum;
    };
    const inBand = [6000, 6666, 7333, 8000].map(rowEnergy);
    const outside = [1000, 3000, 5000, 9000, 10500].map(rowEnergy);
    expect(Math.min(...inBand)).toBeGreaterThan(Math.max(...outside) * 100);

    // And it reads as text: every lit cell of every glyph is clearly above every dark one.
    const FONT: Record<string, string[]> = {
      H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
      E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
      L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
      O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
      ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
      '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
      K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
      Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
    };
    const level = (t: number, f: number) => {
      const row = Math.round((f / 11025) * (sp.rows - 1));
      return sp.db[Math.round(t / (sp.hop / 22050)) * sp.rows + row]!;
    };
    const lit: number[] = [];
    const dark: number[] = [];
    [...'HELLO 7KHZ'].forEach((ch, i) => {
      FONT[ch]!.forEach((line, row) =>
        [...line].forEach((c, col) => {
          const slot = 2 + i * 6 + col;
          (c === '#' ? lit : dark).push(level((slot + 0.5) * 0.05, 8000 - row * (2000 / 6)));
        }),
      );
    });
    expect(Math.min(...lit)).toBeGreaterThan(Math.max(...dark) + 10);
  });
});

describe('long files stay fast and bounded', () => {
  it('10 minutes at 44.1 kHz: at most 2000 columns, and a short burst is not missed', () => {
    const fs = 44100;
    const x = sine(600, fs, 1000, 0.01); // quiet background
    const at = Math.round(317.123 * fs);
    x.set(sine(0.05, fs, 5000, 0.5), at); // a 50 ms burst somewhere in the middle
    const t0 = performance.now();
    const sp = computeSpectrogram(x, fs, base);
    const img = drawSpectrogram(sp, render);
    const ms = performance.now() - t0;
    expect(sp.frames).toBeLessThanOrEqual(2000);
    expect(plotRect(img.width, img.height).width).toBeLessThanOrEqual(2000);
    expect(sp.fMax).toBe(22050);
    expect(sp.peak.freq).toBeCloseTo(5000, -1);
    expect(Math.abs(sp.peak.time - 317.123)).toBeLessThan(sp.hop / fs + 0.1);
    expect(ms).toBeLessThan(15_000);
  });

  it('keeps the first and last seconds visible', () => {
    const fs = 8000;
    const x = new Float32Array(120 * fs);
    x.set(sine(1, fs, 1000, 0.5), 0);
    x.set(sine(1, fs, 1000, 0.5), x.length - fs);
    const sp = computeSpectrogram(x, fs, base);
    const lit = (t: number) => sp.db[t * sp.rows + Math.round((1000 / 4000) * (sp.rows - 1))]!;
    expect(lit(0)).toBeGreaterThan(-30);
    expect(lit(sp.frames - 1)).toBeGreaterThan(-30);
  });

  it('every column count still renders into a bounded picture', () => {
    for (const seconds of [0.2, 5, 90]) {
      const sp = computeSpectrogram(sine(seconds, 16000, 2000), 16000, base);
      const img = renderSpectrogram(sp, render);
      expect(img.width).toBeLessThanOrEqual(2000);
      expect(img.height).toBe(sp.rows);
    }
  });
});
