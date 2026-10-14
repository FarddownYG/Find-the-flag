import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareInput } from '../../core/prepare';
import { ToolError } from '../../core/errors';
import type { AudioInput } from '../../core/types';
import { plotRect } from './_axes';
import { addNoise, audioInput, defaults, sine } from './_synth';
import spectrogram, { computeSpectrogram, renderSpectrogram } from './spectrogram';

const base = { fftSize: 2048, overlap: 0.75, maxFreq: 0, minFreq: 0, scale: 'linear' as const };
const render = { colormap: 'inferno' as const, floor: 90, ceiling: 0 };

async function sample(name: string): Promise<AudioInput> {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)),
  );
  return (await prepareInput('audio', { bytes, name })) as AudioInput;
}

/** dB at (time, frequency) of a linear-axis spectrogram. */
function at(sp: ReturnType<typeof computeSpectrogram>, fs: number, seconds: number, hz: number) {
  // Column t is centred on sample t * hop of the analysed slice.
  const t = Math.min(sp.frames - 1, Math.max(0, Math.round(((seconds - sp.time0) * fs) / sp.hop)));
  const r = Math.round(((hz - sp.fMin) / (sp.fMax - sp.fMin)) * (sp.rows - 1));
  return sp.db[t * sp.rows + r]!;
}

describe('computeSpectrogram', () => {
  it('finds a 1 kHz sine at 8 kHz with the right level', () => {
    const sp = computeSpectrogram(sine(2, 8000, 1000, 0.5), 8000, base);
    expect(sp.peak.freq).toBeCloseTo(1000, 0);
    expect(sp.dominant).toBeCloseTo(1000, 0);
    // A 0.5 amplitude sine is -6.02 dBFS (a little less when it falls between two bins).
    expect(sp.peak.db).toBeGreaterThan(-8);
    expect(sp.peak.db).toBeLessThan(-5.9);
  });

  it('reads 0 dB for a full-scale sine centred on a bin', () => {
    const sp = computeSpectrogram(sine(1, 8000, (8000 / 2048) * 256, 1), 8000, base);
    expect(sp.peak.db).toBeCloseTo(0, 1);
  });

  it('refines the frequency below one bin', () => {
    const sp = computeSpectrogram(sine(3, 44100, 1234.5, 0.5), 44100, base);
    expect(Math.abs(sp.peak.freq - 1234.5)).toBeLessThan(2);
  });

  it('keeps low frequencies at the bottom of the picture', () => {
    const x = sine(2, 8000, 500, 0.5);
    const sp = computeSpectrogram(x, 8000, base);
    const img = renderSpectrogram(sp, render);
    const pixel = (hz: number) => {
      const y = img.height - 1 - Math.round((hz / 4000) * (sp.rows - 1));
      return img.data[(y * img.width + (img.width >> 1)) * 4]!;
    };
    expect(pixel(500)).toBeGreaterThan(200); // bright inferno
    expect(pixel(3000)).toBeLessThan(40); // near black
    expect(sp.rows).toBe(1024);
  });

  it('supports a log axis and a limited band', () => {
    const x = sine(2, 8000, 200, 0.5);
    const sp = computeSpectrogram(x, 8000, { ...base, scale: 'log', minFreq: 50, maxFreq: 3000 });
    expect(sp.fMin).toBe(50);
    expect(sp.fMax).toBe(3000);
    expect(sp.peak.freq).toBeCloseTo(200, 0);
    // On a log axis 200 Hz sits at log(200/50)/log(3000/50) of the height.
    const row = Math.round((Math.log(200 / 50) / Math.log(3000 / 50)) * (sp.rows - 1));
    const mid = Math.floor(sp.frames / 2);
    const brightest = Array.from({ length: sp.rows }, (_, r) => sp.db[mid * sp.rows + r]!).reduce(
      (best, v, r, all) => (v > all[best]! ? r : best),
      0,
    );
    expect(Math.abs(brightest - row)).toBeLessThanOrEqual(2);
  });

  it('rejects an empty frequency band', () => {
    expect(() =>
      computeSpectrogram(sine(1, 8000, 100), 8000, { ...base, minFreq: 3000, maxFreq: 2000 }),
    ).toThrow(ToolError);
  });

  it('caps the width at 2000 columns and is fast on 3 minutes of 44.1 kHz audio', () => {
    const fs = 44100;
    const x = sine(180, fs, 3000, 0.4);
    addNoise(x, 0.01);
    const t0 = performance.now();
    const sp = computeSpectrogram(x, fs, { ...base, overlap: 0.9 });
    const img = renderSpectrogram(sp, render);
    const ms = performance.now() - t0;
    expect(sp.frames).toBeLessThanOrEqual(2000);
    expect(img.width).toBeLessThanOrEqual(2000);
    expect(ms).toBeLessThan(8000);
    expect(sp.peak.freq).toBeCloseTo(3000, -1);
  });

  it('stretches short files so the picture is not tiny', () => {
    const sp = computeSpectrogram(sine(1, 8000, 1000), 8000, { ...base, overlap: 0.5 });
    const img = renderSpectrogram(sp, render);
    expect(sp.frames).toBeLessThan(20);
    expect(img.width).toBeGreaterThanOrEqual(sp.frames * 16);
  });
});

describe('spectrogram tool', () => {
  it('draws FLAG{SPECTRO} from the sample', async () => {
    const audio = await sample('audio-spectrogram.wav');
    const opts = { ...defaults(spectrogram), fftSize: '512', overlap: 90 };
    const out = await spectrogram.run(audio, opts as never);
    const img = out.find((o) => o.type === 'image');
    // 256 rows of picture inside the margins that hold the time axis and the frequency labels.
    expect(img?.type === 'image' && plotRect(img.image.width, img.image.height).height).toBe(256);
    const kv = out.find((o) => o.type === 'kv');
    expect(kv?.type === 'kv' && kv.entries).toContainEqual([
      'Sample rate',
      '8000 Hz (from the file)',
    ]);

    // Read the picture back: the F is 5 columns wide and 7 rows tall, starting at column 2
    // of 0.09 s slots; row 0 is 1750 Hz and every row below is 75 Hz lower.
    const sp = computeSpectrogram(audio.channels[0]!, 8000, {
      fftSize: 512,
      overlap: 0.9,
      maxFreq: 0,
      minFreq: 0,
      scale: 'linear',
    });
    const F = ['#####', '#....', '#....', '####.', '#....', '#....', '#....'];
    const level = (col: number, row: number) =>
      at(sp, 8000, (2 + col + 0.5) * 0.09, 1750 - row * 75);
    const lit: number[] = [];
    const dark: number[] = [];
    F.forEach((line, row) =>
      [...line].forEach((c, col) => (c === '#' ? lit : dark).push(level(col, row))),
    );
    // Row 6 of the F is mostly dark; row 0 is a full bar: clear contrast between the two sets.
    expect(Math.min(...lit)).toBeGreaterThan(Math.max(...dark) + 20);
  });

  it('reports the peak frequency of a pure tone', async () => {
    const out = await spectrogram.run(audioInput(sine(2, 8000, 1500, 0.5), 8000), {
      ...defaults(spectrogram),
      fftSize: '1024',
    } as never);
    const kv = out.find((o) => o.type === 'kv');
    const peak = kv?.type === 'kv' ? kv.entries.find(([k]) => k === 'Peak frequency')?.[1] : '';
    expect(peak).toMatch(/^1500\.\d Hz at /);
  });

  it('handles stereo, the side channel and the grayscale maps', async () => {
    const left = sine(1, 8000, 800, 0.5);
    const right = sine(1, 8000, 2400, 0.5);
    const stereo: AudioInput = {
      bytes: new Uint8Array(0),
      sampleRate: 8000,
      channels: [left, right],
    };
    for (const channel of ['mix', 'left', 'right', 'diff']) {
      for (const colormap of ['magma', 'gray', 'gray-inv']) {
        const out = await spectrogram.run(stereo, {
          ...defaults(spectrogram),
          channel,
          colormap,
        } as never);
        expect(out[0]?.type).toBe('image');
      }
    }
    const only = await spectrogram.run(stereo, {
      ...defaults(spectrogram),
      channel: 'right',
    } as never);
    const kv = only.find((o) => o.type === 'kv');
    expect(kv?.type === 'kv' && kv.entries.find(([k]) => k === 'Peak frequency')?.[1]).toMatch(
      /^2400/,
    );
  });

  it('explains bad input', () => {
    const mono = audioInput(sine(1, 8000, 800), 8000);
    const run =
      (audio: AudioInput, extra: Record<string, unknown> = {}) =>
      () =>
        spectrogram.run(audio, { ...defaults(spectrogram), ...extra } as never);
    expect(run(mono, { channel: 'diff' })).toThrow(ToolError);
    expect(run(mono, { floor: 10, ceiling: 20 })).toThrow(ToolError);
    expect(run(audioInput(new Float32Array(0), 8000))).toThrow(/no samples/);
  });

  it('warns about silence', async () => {
    const out = await spectrogram.run(
      audioInput(new Float32Array(16000), 8000),
      defaults(spectrogram) as never,
    );
    expect(out.some((o) => o.type === 'note' && o.level === 'warn')).toBe(true);
  });
});
