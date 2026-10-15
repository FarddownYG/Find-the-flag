import { describe, expect, it } from 'vitest';
import { concatBytes } from '../lib/bytes';
import { decodeWav } from './decode-audio';
import { audioFile, decodeAudioFile } from './prepare';
import { scanWav } from './wav';

const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const u16 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255]);
const u32 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24]);
const chunk = (id: string, body: Uint8Array) =>
  concatBytes(ascii(id), u32(body.length), body, new Uint8Array(body.length & 1));

interface WavSpec {
  codec: number;
  channels: number;
  rate: number;
  bits: number;
  data: Uint8Array;
  /** Write a WAVE_FORMAT_EXTENSIBLE header whose sub-format is `codec`. */
  extensible?: boolean;
  /** Chunks before "fmt " / between "fmt " and "data". */
  before?: Uint8Array;
  between?: Uint8Array;
}

/** A WAV file written from the RIFF spec, independently of the parser under test. */
function wav(s: WavSpec): Uint8Array {
  const align = Math.max(1, (s.channels * s.bits) >> 3);
  const common = concatBytes(
    u16(s.extensible ? 0xfffe : s.codec),
    u16(s.channels),
    u32(s.rate),
    u32(s.rate * align),
    u16(align),
    u16(s.bits),
  );
  const fmt = s.extensible
    ? concatBytes(common, u16(22), u16(s.bits), u32(0), u16(s.codec), new Uint8Array(14))
    : common;
  const body = concatBytes(
    ascii('WAVE'),
    s.before ?? new Uint8Array(0),
    chunk('fmt ', fmt),
    s.between ?? new Uint8Array(0),
    chunk('data', s.data),
  );
  return concatBytes(ascii('RIFF'), u32(body.length), body);
}

describe('PCM and float decoding', () => {
  /** Interleaved values -> bytes, and the floats any correct decoder must produce. */
  function pcm(bits: number, float: boolean, channels: number, frames: number) {
    const per = bits / 8;
    const bytes = new Uint8Array(frames * channels * per);
    const dv = new DataView(bytes.buffer);
    const expected = Array.from({ length: channels }, () => new Float32Array(frames));
    let seed = 7;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const r = seed / 2 ** 32; // [0, 1)
        const o = (i * channels + c) * per;
        let v: number;
        if (float) {
          v = r * 2 - 1;
          if (per === 4) dv.setFloat32(o, v, true);
          else dv.setFloat64(o, v, true);
        } else if (per === 1) {
          const s = Math.floor(r * 256);
          bytes[o] = s;
          v = (s - 128) / 128;
        } else {
          const max = 2 ** (bits - 1);
          const s = Math.floor(r * 2 * max) - max;
          for (let k = 0; k < per; k++) bytes[o + k] = (s >> (8 * k)) & 255;
          v = s / max;
        }
        expected[c]![i] = v;
      }
    }
    return { bytes, expected };
  }

  it.each([
    [8, false, 1],
    [16, false, 2],
    [16, false, 3],
    [24, false, 2],
    [32, false, 1],
    [32, true, 2],
    [64, true, 1],
  ])('%i-bit (float: %s), %i channel(s)', (bits, float, channels) => {
    const { bytes, expected } = pcm(bits, float, channels, 301);
    const spec = { codec: float ? 3 : 1, channels, rate: 44100, bits, data: bytes };
    const plain = decodeWav(wav(spec));
    expect(plain?.channels).toEqual(expected);
    // A 2-byte chunk before "data" leaves the samples unaligned for 32/64-bit typed views.
    const junk = chunk('JUNK', Uint8Array.of(1, 2));
    expect(decodeWav(wav({ ...spec, between: junk }))?.channels).toEqual(expected);
    expect(decodeWav(wav({ ...spec, extensible: true }))?.channels).toEqual(expected);
  });

  it('decodes a data view that does not start at offset 0 of its buffer', () => {
    const { bytes, expected } = pcm(16, false, 2, 50);
    const file = wav({ codec: 1, channels: 2, rate: 8000, bits: 16, data: bytes });
    const shifted = new Uint8Array(file.length + 3);
    shifted.set(file, 3);
    expect(decodeWav(shifted.subarray(3))?.channels).toEqual(expected);
  });

  it('keeps the old errors for broken files', () => {
    const fmt = chunk('fmt ', new Uint8Array(16));
    const riff = (body: Uint8Array) =>
      concatBytes(ascii('RIFF'), u32(body.length + 4), ascii('WAVE'), body);
    expect(() => decodeWav(riff(concatBytes(chunk('data', new Uint8Array(4)), fmt)))).toThrow(
      'WAV "data" chunk before "fmt " chunk.',
    );
    expect(() => decodeWav(riff(fmt))).toThrow('WAV file has no "data" chunk.');
    expect(() =>
      decodeWav(wav({ codec: 1, channels: 1, rate: 8000, bits: 12, data: new Uint8Array(6) })),
    ).toThrow('Unsupported WAV layout (12 bits, 1 channels).');
    expect(decodeWav(ascii('not a wav file at all'))).toBeNull();
  });

  it('never throws while scanning a truncated file', () => {
    const file = wav({ codec: 1, channels: 2, rate: 8000, bits: 16, data: new Uint8Array(40) });
    for (let n = 0; n <= file.length; n++) {
      expect(() => scanWav(file.subarray(0, n))).not.toThrow();
    }
    expect(scanWav(file.subarray(0, 40))?.fmt?.rate).toBe(8000);
  });
});

describe('decoding an audio file in the worker', () => {
  const pcm16 = wav({
    codec: 1,
    channels: 2,
    rate: 16000,
    bits: 16,
    data: Uint8Array.of(0, 0x40, 0, 0xc0, 0xff, 0x7f, 0, 0x80),
  });

  it('reads the Blob and decodes WAV there, bytes included', async () => {
    const audio = await decodeAudioFile(audioFile(new Blob([pcm16 as BlobPart]), 'a.wav'));
    expect(audio?.sampleRate).toBe(16000);
    expect(audio?.name).toBe('a.wav');
    expect(audio?.bytes).toEqual(pcm16);
    expect(audio?.channels.map((c) => [...c])).toEqual([
      [0.5, 32767 / 32768],
      [-0.5, -1],
    ]);
  });

  it('hands to the page what only the browser can decode', async () => {
    const mp3ish = Uint8Array.of(0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64);
    expect(await decodeAudioFile(audioFile(new Blob([mp3ish as BlobPart])))).toBeNull();
    await expect(decodeAudioFile(audioFile(new Blob([])))).rejects.toThrow(
      'Drop or open an audio file.',
    );
  });
});
