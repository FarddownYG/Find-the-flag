import { describe, expect, it } from 'vitest';
import { concatBytes } from '../lib/bytes';
import { decodeWav, wavCodecError } from './decode-audio';
import { probeSampleRate } from './audio-rate';
import { audioFile, decodeAudioFile, prepareInput } from './prepare';
import { alawToLinear, codecHex, mulawToLinear, scanWav } from './wav';

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

describe('G.711 (A-law, µ-law)', () => {
  // Reference values: ITU-T G.711 as implemented by Sun's g711.c (and ffmpeg's pcm_alaw/mulaw).
  it.each([
    ['d5', 8],
    ['55', -8],
    ['ff', 848],
    ['7f', -848],
    ['80', 5504],
    ['00', -5504],
    ['aa', 32256],
    ['2a', -32256],
  ])('A-law 0x%s -> %i', (hex, linear) => {
    expect(alawToLinear(parseInt(hex, 16))).toBe(linear);
  });

  it.each([
    ['ff', 0],
    ['7f', 0],
    ['d5', 716],
    ['55', -716],
    ['aa', 5372],
    ['2a', -5372],
    ['80', 32124],
    ['00', -32124],
  ])('µ-law 0x%s -> %i', (hex, linear) => {
    expect(mulawToLinear(parseInt(hex, 16))).toBe(linear);
  });

  it('is symmetric around the sign bit and covers the 16-bit range', () => {
    for (let c = 0; c < 256; c++) {
      expect(alawToLinear(c ^ 0x80)).toBe(-alawToLinear(c));
      // µ-law has two zeros (0x7F and 0xFF), so its negation is exact for every code.
      expect(mulawToLinear(c ^ 0x80) + mulawToLinear(c)).toBe(0);
    }
    const a = Array.from({ length: 256 }, (_, c) => alawToLinear(c));
    const u = Array.from({ length: 256 }, (_, c) => mulawToLinear(c));
    expect(new Set(a).size).toBe(256);
    expect(new Set(u).size).toBe(255); // +0 and -0 are one value
    expect(Math.max(...a.map(Math.abs))).toBe(32256);
    expect(Math.max(...u.map(Math.abs))).toBe(32124);
  });

  it('decodes A-law and µ-law WAV files exactly in JavaScript', () => {
    const alaw = decodeWav(
      wav({ codec: 6, channels: 1, rate: 8000, bits: 8, data: Uint8Array.of(0xd5, 0x55, 0xaa) }),
    );
    expect(alaw?.sampleRate).toBe(8000);
    expect(alaw?.rateSource).toBe('file');
    expect([...alaw!.channels[0]!]).toEqual([8 / 32768, -8 / 32768, 32256 / 32768]);

    const mulaw = decodeWav(
      wav({
        codec: 7,
        channels: 2,
        rate: 11025,
        bits: 8,
        data: Uint8Array.of(0x80, 0, 0xff, 0x7f),
      }),
    );
    expect(mulaw?.channels.map((c) => [...c])).toEqual([
      [32124 / 32768, 0],
      [-32124 / 32768, 0],
    ]);
    // Extensible header with the A-law sub-format.
    const ext = decodeWav(
      wav({
        codec: 6,
        channels: 1,
        rate: 8000,
        bits: 8,
        data: Uint8Array.of(0x2a),
        extensible: true,
      }),
    );
    expect([...ext!.channels[0]!]).toEqual([-32256 / 32768]);
  });
});

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

describe('WAV codecs left to the browser', () => {
  const ima = wav({ codec: 0x11, channels: 2, rate: 22050, bits: 4, data: new Uint8Array(2048) });
  const mp3 = wav({ codec: 0x55, channels: 1, rate: 22050, bits: 0, data: new Uint8Array(512) });

  it('are detected, not decoded as PCM', () => {
    expect(decodeWav(ima)).toBeNull();
    expect(decodeWav(mp3)).toBeNull();
    expect(codecHex(0x11)).toBe('0x0011');
  });

  it('name the codec when nothing can decode them', () => {
    expect(wavCodecError(ima)?.message).toMatch(
      /^WAV codec 0x0011 \(IMA ADPCM\) is not supported by this browser\. /,
    );
    expect(wavCodecError(mp3)?.message).toMatch(/^WAV codec 0x0055 \(MP3\) is not supported/);
    const odd = wav({ codec: 0x4242, channels: 1, rate: 8000, bits: 8, data: new Uint8Array(8) });
    expect(wavCodecError(odd)?.message).toMatch(/^WAV codec 0x4242 is not supported/);
    expect(wavCodecError(ascii('ID3 and not a wav'))).toBeNull();
  });

  it('give the browser decoder the rate of the "fmt " chunk', () => {
    expect(probeSampleRate(mp3)).toEqual({ format: 'wav', decodeRate: 22050 });
    expect(probeSampleRate(ima.subarray(0, 60))).toEqual({ format: 'wav', decodeRate: 22050 });
  });

  it('fail with that message where there is no browser decoder (Node)', async () => {
    await expect(prepareInput('audio', { bytes: ima, name: 'x.wav' })).rejects.toThrow(
      /WAV codec 0x0011 \(IMA ADPCM\)/,
    );
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
    const ima = wav({ codec: 0x11, channels: 1, rate: 8000, bits: 4, data: new Uint8Array(256) });
    expect(await decodeAudioFile(audioFile(new Blob([ima as BlobPart])))).toBeNull();
    const mp3ish = Uint8Array.of(0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64);
    expect(await decodeAudioFile(audioFile(new Blob([mp3ish as BlobPart])))).toBeNull();
    await expect(decodeAudioFile(audioFile(new Blob([])))).rejects.toThrow(
      'Drop or open an audio file.',
    );
  });
});
