import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { prepareInput } from '../../core/prepare';
import type { AudioInput } from '../../core/types';
import { addNoise, audioInput, defaults, sine, synthDtmf } from './_synth';
import dtmf, { detectDtmf, multiTapText, splitByPauses } from './dtmf';

const strict = { frameMs: 40, silenceDb: -50, strict: true };
const digits = (x: Float32Array, fs: number, o = strict) =>
  detectDtmf(x, fs, o)
    .map((t) => t.key)
    .join('');

describe('detectDtmf', () => {
  it('decodes every key of the keypad, including A-D', () => {
    expect(digits(synthDtmf('123A456B789C*0#D', 8000), 8000)).toBe('123A456B789C*0#D');
  });

  it.each([
    [8000, 70, 70],
    [8000, 50, 50],
    [8000, 100, 100],
    [44100, 70, 70],
    [44100, 45, 45],
    [16000, 60, 40],
  ])('decodes at %i Hz with %i ms tones and %i ms gaps', (fs, toneMs, gapMs) => {
    const keys = '5551234567890#*';
    expect(digits(synthDtmf(keys, fs, { toneMs, gapMs }), fs)).toBe(keys);
  });

  it('keeps repeated digits apart', () => {
    expect(digits(synthDtmf('1122334455', 8000), 8000)).toBe('1122334455');
  });

  it('survives noise and a mains hum', () => {
    const keys = '8675309#';
    const x = synthDtmf(keys, 8000, { noise: 0.06 });
    const hum = sine(x.length / 8000, 8000, 50, 0.15);
    for (let i = 0; i < x.length; i++) x[i] = x[i]! + hum[i]!;
    expect(digits(x, 8000)).toBe(keys);
  });

  it('accepts a realistic twist (column tone weaker than row tone)', () => {
    expect(digits(synthDtmf('4815162342', 8000, { colGain: 0.5 }), 8000)).toBe('4815162342');
  });

  it('measures start and length of each key press', () => {
    const tones = detectDtmf(
      synthDtmf('123', 8000, { toneMs: 100, gapMs: 100, leadMs: 300 }),
      8000,
      strict,
    );
    expect(tones).toHaveLength(3);
    tones.forEach((t, i) => {
      expect(Math.abs(t.start - (0.3 + i * 0.2))).toBeLessThan(0.03);
      expect(Math.abs(t.end - t.start - 0.1)).toBeLessThan(0.03);
    });
    expect(tones[0]).toMatchObject({ key: '1', rowHz: 697, colHz: 1209 });
  });

  it('ignores a single steady tone, speech-like noise and silence', () => {
    expect(digits(sine(2, 8000, 697, 0.5), 8000)).toBe('');
    expect(digits(addNoise(new Float32Array(16000), 0.2), 8000)).toBe('');
    expect(digits(new Float32Array(16000), 8000)).toBe('');
    // 697 Hz + 770 Hz are two rows, not a key.
    const two = sine(1, 8000, 697, 0.3);
    const other = sine(1, 8000, 770, 0.3);
    expect(
      digits(
        two.map((v, i) => v + other[i]!),
        8000,
      ),
    ).toBe('');
  });

  it('can be relaxed for poor recordings', () => {
    const x = synthDtmf('2580', 8000, { noise: 0.25 });
    expect(digits(x, 8000, { frameMs: 40, silenceDb: -50, strict: false })).toBe('2580');
  });
});

describe('multi-tap reading', () => {
  it('reads pause-separated groups as letters', () => {
    expect(multiTapText(['44', '33', '555', '555', '666'])).toBe('HELLO');
  });

  it('splits a run of the same key by letter size when there are no pauses', () => {
    expect(multiTapText(['4433555555666'])).toBe('HELLO');
    expect(multiTapText(['7777'])).toBe('S');
    expect(multiTapText(['77777'])).toBe('SP');
  });

  it('uses 0 as a space and keeps * and #', () => {
    expect(multiTapText(['44', '0', '444', '#'])).toBe('H I#');
  });
});

describe('splitByPauses', () => {
  const tone = (key: string, start: number) => ({
    key,
    start,
    end: start + 0.1,
    rowHz: 0,
    colHz: 0,
  });
  it('groups digits at long pauses only', () => {
    const t = [tone('4', 0), tone('4', 0.2), tone('3', 1.5), tone('3', 1.7), tone('5', 3)];
    expect(splitByPauses(t)).toEqual(['44', '33', '5']);
    expect(
      splitByPauses([tone('1', 0), tone('2', 0.2), tone('3', 0.4), tone('4', 0.6)]),
    ).toBeNull();
  });
});

describe('dtmf tool', () => {
  it('decodes the sample file exactly', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../public/samples/audio-dtmf.wav', import.meta.url)),
    );
    const audio = (await prepareInput('audio', { bytes, name: 'audio-dtmf.wav' })) as AudioInput;
    const out = await dtmf.run(audio, defaults(dtmf) as never);
    const keys = out.find((o) => o.type === 'text' && o.label === 'Keys pressed');
    expect(keys?.type === 'text' && keys.value).toBe('0123456789*#');
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows).toHaveLength(12);
    expect(table?.type === 'table' && table.rows[1]?.[4]).toBeGreaterThan(40);
  });

  it('gives the multi-tap reading as a second text block', async () => {
    const x = synthDtmf('44 33 555 555 666'.replace(/ /g, ''), 8000);
    const out = await dtmf.run(audioInput(x, 8000), defaults(dtmf) as never);
    const texts = out.filter((o) => o.type === 'text');
    expect(texts.at(-1)?.type === 'text' && texts.at(-1)).toMatchObject({ value: 'HELLO' });
  });

  it('shows pause groups and uses them for the reading', async () => {
    // 44 [pause] 33 [pause] 555 [pause] 555 [pause] 666 with 80 ms between presses
    const parts = ['44', '33', '555', '555', '666'].map((g) => synthDtmf(g, 8000, { leadMs: 0 }));
    const silence = new Float32Array(Math.round(8000 * 0.9));
    const total = parts.reduce((a, p) => a + p.length + silence.length, 0);
    const x = new Float32Array(total);
    let at = 0;
    for (const p of parts) {
      x.set(p, at);
      at += p.length + silence.length;
    }
    const out = await dtmf.run(audioInput(x, 8000), defaults(dtmf) as never);
    const grouped = out.find((o) => o.type === 'text' && o.label === 'Keys grouped by pauses');
    expect(grouped?.type === 'text' && grouped.value).toBe('44 33 555 555 666');
    expect(out.at(-1)).toMatchObject({ value: 'HELLO' });
  });

  it('explains what to do when nothing is found or the file cannot work', () => {
    const run = (audio: AudioInput) => () => dtmf.run(audio, defaults(dtmf) as never);
    expect(run(audioInput(sine(1, 8000, 440), 8000))).toThrow(ToolError);
    expect(run(audioInput(sine(1, 2000, 440), 2000))).toThrow(/too low/);
    expect(run(audioInput(new Float32Array(10), 8000))).toThrow(/shorter than one/);
  });

  it('is fast on three minutes of 44.1 kHz audio', () => {
    const x = addNoise(
      synthDtmf('0123456789'.repeat(90), 44100, { toneMs: 100, gapMs: 100 }),
      0.02,
    );
    expect(x.length / 44100).toBeGreaterThan(170);
    const t0 = performance.now();
    const keys = digits(x, 44100);
    expect(performance.now() - t0).toBeLessThan(10000);
    expect(keys).toBe('0123456789'.repeat(90));
  });
});
