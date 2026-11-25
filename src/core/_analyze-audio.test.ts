import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  coverSamples,
  embedLsb,
  intBytes,
  makeWav,
  ascii,
  withLength,
} from '../tools/audio/_audio-stego-fixtures';
import { detectAudio } from './_analyze-audio';

const sample = (name: string) => new Uint8Array(readFileSync(`public/samples/${name}`));
const flags = (f: { flag?: string }[]) => f.map((x) => x.flag).filter(Boolean);

/** A made-up recording: a quiet tone with a little noise, no hidden data. */
function cleanWav(channels: number, bits: 16 | 24, seed: number, silence = 0): Uint8Array {
  const samples = coverSamples({
    frames: 12000,
    channels,
    peak: bits === 16 ? 32767 : 8388607,
    rate: 8000,
    seed,
    silence,
  });
  return makeWav({ bits, channels, rate: 8000, data: intBytes(samples, bits) });
}

describe('detectAudio on the fixtures', () => {
  it('audio-stego-lsb.wav yields a confirmed FTF{wav_lsb}', async () => {
    const f = await detectAudio(sample('audio-stego-lsb.wav'), 'audio-stego-lsb.wav');
    expect(flags(f)).toContain('FTF{wav_lsb}');
    expect(f.find((x) => x.flag)?.confidence).toBe('confirmed');
  });

  it('finds a flag written into the two low planes of one channel of a stereo file', async () => {
    const wav = embedLsb(
      cleanWav(2, 16, 5, 3000),
      { planes: [0, 1], channel: 1, bitOrder: 'lsb', step: 1, offset: 0 },
      ascii('FTF{stereo_right_two_planes}'),
    );
    expect(flags(await detectAudio(wav))).toContain('FTF{stereo_right_two_planes}');
  });

  it('finds a flag behind a length header', async () => {
    const wav = embedLsb(
      cleanWav(1, 24, 9, 2000),
      { planes: [0], channel: null, bitOrder: 'msb', step: 1, offset: 0 },
      withLength(ascii('CTF{header_24bit}')),
    );
    expect(flags(await detectAudio(wav))).toContain('CTF{header_24bit}');
  });
});

describe('detectAudio never confirms on a clean file', () => {
  it.each([
    ['mono 16-bit', cleanWav(1, 16, 1)],
    ['stereo 16-bit', cleanWav(2, 16, 2)],
    ['mono 24-bit with leading silence', cleanWav(1, 24, 3, 4000)],
    ['stereo 24-bit', cleanWav(2, 24, 4)],
  ])('%s: no confirmed finding', async (_label, wav) => {
    const f = await detectAudio(wav);
    expect(f.filter((x) => x.confidence === 'confirmed')).toEqual([]);
    expect(flags(f)).toEqual([]);
  });

  it('the shipped lab samples (no LSB payload) give no confirmed finding', async () => {
    // audio-lab-stereo.wav once matched the flag pattern by chance in a scanned stream: that must
    // stay below 'confirmed'.
    for (const name of [
      'audio-dtmf.wav',
      'audio-morse.wav',
      'audio-spectrogram.wav',
      'audio-lab-stereo.wav',
      'audio-lab-voice.wav',
      'audio-lab-reversed-fast.wav',
    ]) {
      const f = await detectAudio(sample(name), name);
      expect(f.filter((x) => x.confidence === 'confirmed')).toEqual([]);
    }
  });

  it('returns nothing for bytes that are not a PCM WAV', async () => {
    expect(await detectAudio(new Uint8Array(0))).toEqual([]);
    expect(await detectAudio(ascii('not a wav file at all, just text'))).toEqual([]);
  });
});
