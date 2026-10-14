import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { prepareInput } from '../../core/prepare';
import type { AudioInput } from '../../core/types';
import { morseToText, textToMorse } from './_morse';
import { addNoise, audioInput, defaults, sine, synthMorse } from './_synth';
import morse, { analyseMorse, findDominantTone } from './morse-audio';

const decode = (x: Float32Array, fs: number, o = { tone: 0, wpm: 0 }) => analyseMorse(x, fs, o);

describe('morse table', () => {
  it('round-trips text', () => {
    const text = 'CQ CQ DE W1AW 73, K?';
    expect(morseToText(textToMorse(text))).toBe(text);
    expect(textToMorse('sos')).toBe('... --- ...');
    expect(morseToText('... --- ... / .-')).toBe('SOS A');
    expect(morseToText('......-')).toBe('?');
  });
});

describe('findDominantTone', () => {
  it('locates a keyed tone', () => {
    const x = synthMorse('PARIS PARIS', 8000, { tone: 1234, noise: 0.02 });
    const t = findDominantTone(x, 8000);
    expect(t).not.toBeNull();
    expect(Math.abs(t!.freq - 1234)).toBeLessThan(3);
    expect(t!.prominence).toBeGreaterThan(30);
  });

  it('finds nothing in white noise', () => {
    const t = findDominantTone(addNoise(new Float32Array(32000), 0.2), 8000);
    expect(t === null || t.prominence < 30).toBe(true);
  });
});

describe('analyseMorse', () => {
  it.each([
    ['SOS', 8000, 15, 700],
    ['FLAG IS MORSE', 8000, 15, 700],
    ['HELLO WORLD', 8000, 20, 600],
    ['CQ CQ DE W1AW', 44100, 12, 440],
    ['0123456789', 8000, 10, 800],
    ['THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG', 22050, 25, 1000],
    ['MESSAGE 1, STOP.', 8000, 18, 523],
  ])('decodes %s at %i Hz, %i WPM, %i Hz tone', (text, fs, wpm, tone) => {
    const r = decode(synthMorse(text, fs, { wpm, tone, noise: 0.02 }), fs);
    expect(r.text).toBe(text);
    expect(Math.abs(r.wpm - wpm)).toBeLessThan(wpm * 0.12);
    expect(r.tone).not.toBeNull();
    expect(Math.abs(r.tone! - tone)).toBeLessThan(4);
  });

  it('reports the dot/dash string with word breaks', () => {
    const r = decode(synthMorse('AB CD', 8000), 8000);
    expect(r.symbols).toBe('.- -... / -.-. -..');
    expect(r.dots).toBe(1 + 3 + 2 + 2);
    expect(r.dashes).toBe(1 + 1 + 2 + 1);
  });

  it('handles heavy noise', () => {
    const r = decode(synthMorse('FLAG IS MORSE', 8000, { noise: 0.15 }), 8000);
    expect(r.text).toBe('FLAG IS MORSE');
  });

  it('handles keying with long, soft edges', () => {
    const r = decode(synthMorse('SOS SOS', 8000, { rampMs: 12 }), 8000);
    expect(r.text).toBe('SOS SOS');
  });

  it('copes with slightly uneven hand-keyed timing', () => {
    const rand = (() => {
      let s = 3;
      return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    })();
    // Build the signal from perturbed element lengths.
    const fs = 8000;
    const unit = 0.08;
    const code = textToMorse('HAND SENT CODE');
    const pieces: [boolean, number][] = [];
    code.split(' / ').forEach((w, wi) => {
      if (wi) pieces.push([false, 7]);
      w.split(' ').forEach((l, li) => {
        if (li) pieces.push([false, 3]);
        [...l].forEach((s, si) => {
          if (si) pieces.push([false, 1]);
          pieces.push([true, s === '.' ? 1 : 3]);
        });
      });
    });
    const durations = pieces.map(([, u]) => u * unit * (0.85 + 0.3 * rand()));
    const x = new Float32Array(Math.round((durations.reduce((a, b) => a + b, 0) + 1) * fs));
    let at = 0.5;
    pieces.forEach(([on], i) => {
      const end = at + durations[i]!;
      if (on)
        for (let k = Math.round(at * fs); k < Math.round(end * fs); k++)
          x[k] = 0.5 * Math.sin((2 * Math.PI * 650 * k) / fs);
      at = end;
    });
    expect(decode(addNoise(x, 0.01), fs).text).toBe('HAND SENT CODE');
  });

  it('uses a forced speed and tone', () => {
    const x = synthMorse('EEE TTT', 8000, { wpm: 15 });
    const r = decode(x, 8000, { tone: 700, wpm: 15 });
    expect(r.text).toBe('EEE TTT');
    expect(r.tone).toBe(700);
    expect(r.wpm).toBe(15);
  });

  it('falls back to the broadband envelope when there is no tone', () => {
    const fs = 8000;
    const keyed = synthMorse('SOS', fs, { tone: 700 });
    // Replace the carrier by wide-band noise bursts with the same keying.
    const burst = addNoise(new Float32Array(keyed.length), 0.3, 5);
    const x = keyed.map((v, i) => (Math.abs(v) > 1e-4 ? burst[i]! : 0));
    const r = decode(x, fs);
    expect(r.text).toBe('SOS');
  });

  it('tells apart one-length messages (all dots)', () => {
    expect(decode(synthMorse('EEEE', 8000), 8000).text).toBe('EEEE');
    expect(decode(synthMorse('H S', 8000), 8000).text).toBe('H S');
  });
});

describe('morse-audio tool', () => {
  it('decodes the sample file', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../public/samples/audio-morse.wav', import.meta.url)),
    );
    const audio = (await prepareInput('audio', { bytes, name: 'audio-morse.wav' })) as AudioInput;
    const out = await morse.run(audio, defaults(morse) as never);
    expect(out[0]).toMatchObject({ type: 'text', value: 'FLAG IS MORSE' });
    expect(out[1]).toMatchObject({
      type: 'text',
      value: '..-. .-.. .- --. / .. ... / -- --- .-. ... .',
    });
    const kv = out.find((o) => o.type === 'kv');
    expect(kv?.type === 'kv' && kv.entries.find(([k]) => k === 'Tone')?.[1]).toMatch(
      /^69\d\.\d Hz$|^70\d\.\d Hz$/,
    );
  });

  it('rejects silence, noise and files that are too short', () => {
    const run = (x: Float32Array) => () => morse.run(audioInput(x, 8000), defaults(morse) as never);
    expect(run(new Float32Array(16000))).toThrow(ToolError);
    expect(run(new Float32Array(10))).toThrow(/too short/);
    expect(run(sine(2, 8000, 700))).toThrow(/No clear on\/off/);
  });

  it('is fast on three minutes of 44.1 kHz audio', () => {
    const x = synthMorse('CQ CQ CQ DE TEST '.repeat(40), 44100, {
      wpm: 25,
      tone: 600,
      noise: 0.01,
    });
    expect(x.length / 44100).toBeGreaterThan(150);
    const t0 = performance.now();
    const r = decode(x, 44100);
    expect(performance.now() - t0).toBeLessThan(10000);
    expect(r.text.startsWith('CQ CQ CQ DE TEST CQ CQ')).toBe(true);
  });
});
