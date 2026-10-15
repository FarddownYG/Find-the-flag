import { describe, expect, it } from 'vitest';
import { concatBytes, latin1Decode } from '../../lib/bytes';
import {
  ascii,
  coverSamples,
  embedLsb,
  extendedBytes,
  floatBytes,
  intBytes,
  makeAiff,
  makeWav,
  prng,
  randomBytes,
  withLength,
} from './_audio-stego-fixtures';
import {
  extended80,
  extractLsb,
  findOnset,
  frameOf,
  isNoPcm,
  lsbCapacity,
  planeStats,
  readPcm,
  sampleWalk,
  walkChunks,
  type LsbSpec,
  type PcmLayout,
} from './_audio-stego-pcm';
import { extractManual, judgeStream, pickHeader, scanLsb, weakHeader } from './_audio-stego-lsb';

function layoutOf(file: Uint8Array): PcmLayout {
  const chunks = walkChunks(file);
  expect(chunks).not.toBeNull();
  const pcm = readPcm(file, chunks!);
  if (isNoPcm(pcm)) throw new Error(`not PCM: ${pcm.why}`);
  return pcm;
}

const spec = (o: Partial<LsbSpec> = {}): LsbSpec => ({
  planes: [0],
  channel: null,
  bitOrder: 'msb',
  step: 1,
  offset: 0,
  ...o,
});

describe('walkChunks', () => {
  const wav = makeWav({
    bits: 16,
    channels: 1,
    rate: 8000,
    data: new Uint8Array(40),
    before: [{ id: 'ftfx', body: ascii('abc') }],
  });

  it('lists the chunks of a WAV with their sizes and the odd-size pad byte', () => {
    const file = walkChunks(wav)!;
    expect(file.kind).toBe('wav');
    expect(file.form).toBe('WAVE');
    expect(file.chunks.map((c) => [c.id, c.size])).toEqual([
      ['fmt ', 16],
      ['ftfx', 3],
      ['data', 40],
    ]);
    expect(file.stop).toBe(wav.length);
    expect(file.declaredEnd).toBe(wav.length);
  });

  it('does not take trailing text for a chunk', () => {
    for (const tail of [
      'FTF{after_data}',
      'Some secret text',
      'abcd1234',
      '\x00\x01\x02\x03\x04\x05\x06\x07',
    ]) {
      const file = walkChunks(concatBytes(wav, ascii(tail)))!;
      expect(file.chunks).toHaveLength(3);
      expect(file.stop).toBe(wav.length);
    }
  });

  it('accepts a data chunk that runs past the end of the file (truncated recording)', () => {
    const cut = wav.subarray(0, wav.length - 10);
    const file = walkChunks(cut)!;
    const data = file.chunks.find((c) => c.id === 'data')!;
    expect(data.truncated).toBe(true);
    expect(data.end).toBe(cut.length);
    expect(file.stop).toBe(cut.length);
  });

  it('stops at another chunk that runs past the end', () => {
    const tail = concatBytes(ascii('LIST'), Uint8Array.of(0xff, 0xff, 0, 0));
    const file = walkChunks(concatBytes(wav, tail))!;
    expect(file.chunks).toHaveLength(3);
    expect(file.stop).toBe(wav.length);
  });

  it('reads AIFF with big-endian sizes', () => {
    const aiff = makeAiff({
      bits: 16,
      channels: 2,
      rate: 44100,
      frames: 3,
      data: new Uint8Array(12),
    });
    const file = walkChunks(aiff)!;
    expect(file.kind).toBe('aiff');
    expect(file.chunks.map((c) => c.id)).toEqual(['COMM', 'SSND']);
  });

  it('is null for anything else', () => {
    expect(walkChunks(ascii('RIFF....AVI LIST'))).toBeNull();
    expect(walkChunks(new Uint8Array(5))).toBeNull();
    expect(walkChunks(ascii('plain text file here'))).toBeNull();
  });
});

describe('sample layouts', () => {
  it.each([
    [8, 1],
    [16, 1],
    [16, 2],
    [24, 2],
    [32, 2],
    [16, 6],
  ] as const)('WAV PCM %i-bit, %i channels', (bits, channels) => {
    const frames = 50;
    const frameSize = channels * (bits / 8);
    const wav = makeWav({
      bits,
      channels,
      rate: 22050,
      data: new Uint8Array(frames * frameSize + frameSize - 1),
    });
    const p = layoutOf(wav);
    expect(p).toMatchObject({
      container: 'wav',
      sample: 'int',
      bits,
      bytes: bits / 8,
      channels,
      rate: 22050,
      frames,
      leftover: frameSize - 1,
      bigEndian: false,
    });
  });

  it.each([32, 64] as const)('WAV IEEE float %i-bit', (bits) => {
    const wav = makeWav({
      bits,
      float: true,
      channels: 2,
      rate: 48000,
      data: new Uint8Array(bits === 32 ? 80 : 160),
    });
    expect(layoutOf(wav)).toMatchObject({ sample: 'float', bytes: bits / 8, frames: 10 });
  });

  it('WAVE_FORMAT_EXTENSIBLE with a PCM sub-format', () => {
    const fmt = new Uint8Array(40);
    fmt.set([0xfe, 0xff, 2, 0], 0); // tag, channels
    fmt.set([0x40, 0x1f, 0, 0], 4); // 8000 Hz
    fmt.set([32, 0], 12);
    fmt.set([24, 0], 14);
    fmt.set([22, 0, 24, 0], 16);
    fmt.set([1, 0], 24); // sub-format: PCM
    const wav = concatBytes(
      ascii('RIFF'),
      Uint8Array.of(0, 0, 0, 0),
      ascii('WAVEfmt '),
      Uint8Array.of(40, 0, 0, 0),
      fmt,
      ascii('data'),
      Uint8Array.of(12, 0, 0, 0),
      new Uint8Array(12),
    );
    expect(layoutOf(wav)).toMatchObject({ sample: 'int', bits: 24, channels: 2, frames: 2 });
  });

  it('says why a WAV has no sample layout', () => {
    const adpcm = makeWav({ bits: 16, channels: 1, rate: 8000, data: new Uint8Array(8) });
    adpcm[20] = 0x11; // IMA ADPCM
    const chunks = walkChunks(adpcm)!;
    expect(readPcm(adpcm, chunks)).toEqual({ why: 'codec', codec: 'IMA ADPCM (0x0011)' });
    const fmtOnly = makeWav({ bits: 16, channels: 1, rate: 8000, data: new Uint8Array(8) }).slice(
      0,
      36,
    );
    expect(readPcm(fmtOnly, walkChunks(fmtOnly)!)).toMatchObject({ why: 'noData' });
    const empty = concatBytes(ascii('RIFF'), Uint8Array.of(4, 0, 0, 0), ascii('WAVE'));
    expect(readPcm(empty, walkChunks(empty)!)).toMatchObject({ why: 'noFmt' });
    const twelve = makeWav({ bits: 16, channels: 0, rate: 8000, data: new Uint8Array(8) });
    expect(readPcm(twelve, walkChunks(twelve)!)).toMatchObject({ why: 'layout' });
  });

  it.each([
    [8, 1],
    [16, 2],
    [24, 1],
    [32, 2],
  ] as const)('AIFF %i-bit, %i channels (big-endian)', (bits, channels) => {
    const frames = 10;
    const aiff = makeAiff({
      bits,
      channels,
      rate: 44100,
      frames,
      data: new Uint8Array(frames * channels * (bits / 8)),
    });
    expect(layoutOf(aiff)).toMatchObject({
      container: 'aiff',
      bits,
      channels,
      rate: 44100,
      frames,
      bigEndian: true,
    });
  });

  it('AIFF-C: sowt is little-endian PCM, an unknown compression is not PCM', () => {
    const sowt = makeAiff({
      bits: 16,
      channels: 1,
      rate: 8000,
      frames: 4,
      data: new Uint8Array(8),
      aifc: 'sowt',
    });
    expect(layoutOf(sowt)).toMatchObject({ bigEndian: false, bits: 16 });
    const none = makeAiff({
      bits: 16,
      channels: 1,
      rate: 8000,
      frames: 4,
      data: new Uint8Array(8),
      aifc: 'NONE',
    });
    expect(layoutOf(none)).toMatchObject({ bigEndian: true });
    const ima = makeAiff({
      bits: 16,
      channels: 1,
      rate: 8000,
      frames: 4,
      data: new Uint8Array(8),
      aifc: 'sowt',
    });
    ima.set(ascii('ima4'), latin1Decode(ima).indexOf('sowt'));
    expect(readPcm(ima, walkChunks(ima)!)).toEqual({ why: 'codec', codec: 'AIFF-C ima4' });
  });

  it('decodes the 80-bit extended sample rate', () => {
    for (const rate of [8000, 11025, 22050, 44100, 48000, 88200, 96000, 192000]) {
      expect(extended80(extendedBytes(rate), 0)).toBe(rate);
    }
  });
});

describe('extractLsb: what it reads', () => {
  it('reads the low bit of 16-bit mono samples, MSB first (0x41 = "A")', () => {
    // low bits 0 1 0 0 0 0 0 1, with noise in the higher bits
    const values = [200, -7, 1000, 12, -300, 18, 22, 5];
    const wav = makeWav({ bits: 16, channels: 1, rate: 8000, data: intBytes(values, 16) });
    const p = layoutOf(wav);
    expect([...extractLsb(wav, p, spec())]).toEqual([0x41]);
    expect([...extractLsb(wav, p, spec({ bitOrder: 'lsb' }))]).toEqual([0x82]);
  });

  it('two planes: MSB first reads the higher plane first, LSB first the lower', () => {
    // samples with (bit1 bit0) = 10 01 10 11 -> message bits 1 0 0 1 1 0 1 1 = 0x9b
    const values = [0b10, 0b01, 0b10, 0b11];
    const wav = makeWav({ bits: 16, channels: 1, rate: 8000, data: intBytes(values, 16) });
    const p = layoutOf(wav);
    expect([...extractLsb(wav, p, spec({ planes: [0, 1] }))]).toEqual([0b10011011]);
    // LSB first: each sample gives bit0 then bit1; byte filled from its bottom:
    // bits 0 1, 1 0, 0 1, 1 1 -> bit n of the byte = n-th message bit = 0b11_01_10_01... computed below
    const bits = [0, 1, 1, 0, 0, 1, 1, 1];
    const expected = bits.reduce((acc, b, i) => acc | (b << i), 0);
    expect([...extractLsb(wav, p, spec({ planes: [0, 1], bitOrder: 'lsb' }))]).toEqual([expected]);
  });

  it('reads the low byte of a sample: first byte in a WAV, last byte in an AIFF', () => {
    const values = [0x0100, 0x0100, 0x0100, 0x0100, 0x0100, 0x0100, 0x0100, 0x0100];
    const wav = makeWav({ bits: 16, channels: 1, rate: 8000, data: intBytes(values, 16) });
    const aiff = makeAiff({
      bits: 16,
      channels: 1,
      rate: 8000,
      frames: 8,
      data: intBytes(values, 16, true),
    });
    expect([...extractLsb(wav, layoutOf(wav), spec())]).toEqual([0]);
    expect([...extractLsb(aiff, layoutOf(aiff), spec())]).toEqual([0]);
    // The byte view reads the high byte too: its low bit is 1 (little- and big-endian files differ in order).
    const bytesWav = extractLsb(wav, layoutOf(wav), spec({ unit: 'byte' }));
    expect([...bytesWav]).toEqual([0b01010101, 0b01010101]);
    const bytesAiff = extractLsb(aiff, layoutOf(aiff), spec({ unit: 'byte' }));
    expect([...bytesAiff]).toEqual([0b10101010, 0b10101010]);
  });

  it('reads the low bit of 8-bit unsigned, 24-bit and 32-bit integer samples', () => {
    const odd = [1, 3, 5, 7, 9, 11, 13, 15];
    for (const bits of [8, 24, 32] as const) {
      const wav = makeWav({ bits, channels: 1, rate: 8000, data: intBytes(odd, bits) });
      expect([...extractLsb(wav, layoutOf(wav), spec())]).toEqual([0xff]);
      const even = makeWav({
        bits,
        channels: 1,
        rate: 8000,
        data: intBytes(
          odd.map((v) => v - 1),
          bits,
        ),
      });
      expect([...extractLsb(even, layoutOf(even), spec())]).toEqual([0]);
    }
  });

  it('reads the low mantissa bits of float samples (32 and 64-bit, WAV and AIFF-C)', () => {
    const values = [0.5, -0.25, 0.125, 0.3, -0.7, 0.01, 0.9, -0.33];
    for (const bits of [32, 64] as const) {
      const wav = makeWav({
        bits,
        float: true,
        channels: 1,
        rate: 8000,
        data: floatBytes(values, bits),
      });
      const p = layoutOf(wav);
      const marked = embedLsb(wav, spec(), Uint8Array.of(0xa5));
      expect([...extractLsb(marked, p, spec())]).toEqual([0xa5]);
      // the value hardly moves: the lowest mantissa bit is below any audible change
      const dv = new DataView(marked.buffer);
      const first = bits === 32 ? dv.getFloat32(p.start, true) : dv.getFloat64(p.start, true);
      expect(Math.abs(first - values[0]!)).toBeLessThan(1e-6);
    }
    const fl32 = makeAiff({
      bits: 32,
      channels: 1,
      rate: 8000,
      frames: 8,
      data: floatBytes(values, 32, true),
      aifc: 'NONE',
    });
    fl32.set(ascii('fl32'), latin1Decode(fl32).indexOf('NONE'));
    const p = layoutOf(fl32);
    expect(p).toMatchObject({ sample: 'float', bits: 32, bigEndian: true });
    const marked = embedLsb(fl32, spec(), Uint8Array.of(0x3c));
    expect([...extractLsb(marked, p, spec())]).toEqual([0x3c]);
  });

  it('selects channels, step and start sample', () => {
    // stereo: left low bits 1,0,1,0..., right low bits all 1
    const frames = 64;
    const values: number[] = [];
    for (let f = 0; f < frames; f++) values.push(f % 2 === 0 ? 1 : 0, 1);
    const wav = makeWav({ bits: 16, channels: 2, rate: 8000, data: intBytes(values, 16) });
    const p = layoutOf(wav);
    expect([...extractLsb(wav, p, spec({ channel: 0 }), 2)]).toEqual([0xaa, 0xaa]);
    expect([...extractLsb(wav, p, spec({ channel: 1 }), 2)]).toEqual([0xff, 0xff]);
    // interleaved L R L R: 1 1 0 1 1 1 0 1 -> 0xdd
    expect([...extractLsb(wav, p, spec(), 1)]).toEqual([0xdd]);
    // every 2nd sample of the interleaved stream is the left channel
    expect([...extractLsb(wav, p, spec({ step: 2 }), 2)]).toEqual([0xaa, 0xaa]);
    // start at sample 1: the stream begins with the right channel
    expect([...extractLsb(wav, p, spec({ offset: 1, step: 2 }), 2)]).toEqual([0xff, 0xff]);
    expect(lsbCapacity(p, spec({ channel: 0 }))).toBe(8);
    expect(lsbCapacity(p, spec())).toBe(16);
    expect(lsbCapacity(p, spec({ planes: [0, 1, 2, 3], channel: 1 }))).toBe(32);
    expect(lsbCapacity(p, spec({ unit: 'byte' }))).toBe(32);
    expect(lsbCapacity(p, spec({ offset: 10_000 }))).toBe(0);
  });

  it('knows the frame an extraction sits in', () => {
    const wav = makeWav({ bits: 16, channels: 2, rate: 8000, data: new Uint8Array(400) });
    const p = layoutOf(wav);
    expect(frameOf(p, spec(), 0)).toBe(0);
    expect(frameOf(p, spec(), 10)).toBe(5);
    expect(frameOf(p, spec({ channel: 1 }), 10)).toBe(10);
    expect(frameOf(p, spec({ unit: 'byte' }), 8)).toBe(2);
    expect(frameOf(p, spec({ offset: 4, step: 2, channel: 0 }), 3)).toBe(10);
  });

  it('keeps whole bytes only and never reads past the data', () => {
    const wav = makeWav({ bits: 16, channels: 1, rate: 8000, data: new Uint8Array(2 * 20) });
    const p = layoutOf(wav);
    expect(extractLsb(wav, p, spec())).toHaveLength(2);
    expect(extractLsb(wav, p, spec({ planes: [0, 1, 2] }))).toHaveLength(7);
    expect(extractLsb(wav, p, spec(), 1)).toHaveLength(1);
    expect(sampleWalk(p, spec()).count).toBe(20);
  });
});

describe('embedLsb and extractLsb: round trips', () => {
  it('give the payload back for random settings and change nothing else', () => {
    const rand = prng(2024);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
    for (let trial = 0; trial < 300; trial++) {
      const container = pick(['wav', 'aiff'] as const);
      const bits = pick([8, 16, 24, 32] as const);
      const float = bits === 32 && container === 'wav' && rand() < 0.3;
      const channels = pick([1, 2, 3, 4]);
      const frames = 200;
      const raw = float
        ? floatBytes(
            Array.from({ length: frames * channels }, () => rand() * 2 - 1),
            32,
          )
        : randomBytes(frames * channels * (bits / 8), trial + 1);
      const file =
        container === 'wav'
          ? makeWav({ bits, float, channels, rate: 8000, data: raw })
          : makeAiff({ bits: bits as 8 | 16 | 24 | 32, channels, rate: 8000, frames, data: raw });
      const p = layoutOf(file);
      const count = 1 + Math.floor(rand() * 4);
      const planes = [...new Set(Array.from({ length: count }, () => Math.floor(rand() * 8)))].sort(
        (a, b) => a - b,
      );
      const s: LsbSpec = {
        planes,
        unit: rand() < 0.25 ? 'byte' : 'sample',
        channel: rand() < 0.5 ? null : Math.floor(rand() * channels),
        bitOrder: pick(['msb', 'lsb'] as const),
        step: 1 + Math.floor(rand() * 3),
        offset: Math.floor(rand() * 20),
      };
      const capacity = lsbCapacity(p, s);
      if (capacity < 1) continue;
      const payload = randomBytes(1 + Math.floor(rand() * Math.min(capacity, 60)), trial + 1000);
      const marked = embedLsb(file, s, payload);
      expect([...extractLsb(marked, p, s, payload.length)]).toEqual([...payload]);
      // only the chosen bits of the chosen bytes may differ
      const walk = sampleWalk(p, s);
      const mask = planes.reduce((m, pl) => m | (1 << pl), 0);
      const touched = new Set<number>();
      for (let k = 0; k < walk.count; k++) touched.add(walk.first + k * walk.stride);
      for (let i = 0; i < file.length; i++) {
        const diff = file[i]! ^ marked[i]!;
        if (diff === 0) continue;
        expect(touched.has(i)).toBe(true);
        expect(diff & ~mask).toBe(0);
      }
    }
  });

  it('refuses a payload that does not fit', () => {
    const wav = makeWav({ bits: 16, channels: 1, rate: 8000, data: new Uint8Array(40) });
    expect(() => embedLsb(wav, spec(), new Uint8Array(3))).toThrow('payload too big');
  });
});

describe('length headers', () => {
  const stream = (payload: string, o: { little?: boolean; bits?: boolean } = {}) =>
    concatBytes(withLength(ascii(payload), o), randomBytes(200, 5));

  it('finds a 32-bit length in either byte order, counting bytes or bits', () => {
    const text = 'FTF{header_found} and more words';
    for (const little of [false, true]) {
      for (const bits of [false, true]) {
        const s = stream(text, { little, bits });
        const h = pickHeader(s, s.length)!;
        expect(h.header).toEqual({ little, unit: bits ? 'bits' : 'bytes', length: text.length });
        expect(h.hit.kind).toBe('flag');
      }
    }
  });

  it('is not fooled by noise, zeros or a length that does not fit', () => {
    let found = 0;
    for (let seed = 1; seed <= 300; seed++) {
      if (pickHeader(randomBytes(8192, seed), 8192)) found++;
    }
    expect(found).toBe(0);
    expect(pickHeader(new Uint8Array(500), 500)).toBeNull();
    const big = withLength(ascii('FTF{too_long_for_it}'), {});
    big.set([0, 0, 1, 1], 0); // 257: too long as bytes, not a whole number of bytes as bits
    expect(pickHeader(concatBytes(big, new Uint8Array(40)), 60)).toBeNull();
  });

  it('a length whose payload reads as nothing is only a weak header', () => {
    const s = concatBytes(Uint8Array.of(0, 0, 0, 64), randomBytes(100, 9));
    expect(pickHeader(s, 104)).toBeNull();
    expect(weakHeader(s, 104)).toMatchObject({ length: 64, little: false });
  });

  it('judgeStream: header modes', () => {
    const s = stream('FTF{modes}');
    expect(judgeStream(s, 400, 'auto').header?.length).toBe(10);
    expect(judgeStream(s, 400, 'none').header).toBeNull();
    expect(judgeStream(s, 400, 'be').header?.length).toBe(10);
    expect(judgeStream(s, 400, 'le').header).toBeNull(); // 0x0a000000 does not fit
    expect(judgeStream(s, 400, 'auto').payload).toEqual(ascii('FTF{modes}'));
  });
});

describe('scanLsb', () => {
  const cover = (frames: number, channels: number, bits: 16 | 24, seed: number, silence = 0) =>
    makeWav({
      bits,
      channels,
      rate: 8000,
      data: intBytes(
        coverSamples({ frames, channels, peak: 2 ** (bits - 1) - 1, rate: 8000, seed, silence }),
        bits,
      ),
    });

  it('finds a flag in every setting the scan tries (and ranks it first)', () => {
    const flag = ascii('FTF{round_trip_flag}');
    const rand = prng(77);
    let n = 0;
    for (const channels of [1, 2]) {
      for (const bits of [16, 24] as const) {
        const file = cover(6000, channels, bits, 3 + channels + bits);
        const p = layoutOf(file);
        const chs: (number | null)[] = channels === 1 ? [null] : [null, 0, 1];
        for (const channel of chs) {
          for (const planes of [[0], [0, 1], [0, 1, 2], [0, 1, 2, 3]]) {
            for (const bitOrder of ['msb', 'lsb'] as const) {
              for (const unit of ['sample', 'byte'] as const) {
                for (const header of [false, true]) {
                  if (unit === 'byte' && channel !== null) continue;
                  const s: LsbSpec = { planes, unit, channel, bitOrder, step: 1, offset: 0 };
                  const payload = header
                    ? withLength(flag, { little: rand() < 0.5, bits: rand() < 0.3 })
                    : flag;
                  const marked = embedLsb(file, s, payload);
                  const { hits } = scanLsb(marked, p);
                  const best = hits[0]!;
                  n++;
                  expect(best.finding.hit?.kind).toBe('flag');
                  expect(best.finding.payload.subarray(0, flag.length)).toEqual(flag);
                  expect(best.spec).toMatchObject({ planes, bitOrder, channel });
                  expect(best.spec.unit ?? 'sample').toBe(unit);
                  expect(!!best.finding.header).toBe(header);
                }
              }
            }
          }
        }
      }
    }
    expect(n).toBe(192);
  });

  it('finds nothing in sound or silence', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const file = cover(
        5000,
        (seed % 2) + 1,
        seed % 3 === 0 ? 24 : 16,
        seed,
        seed % 4 === 0 ? 2000 : 0,
      );
      expect(scanLsb(file, layoutOf(file)).hits).toEqual([]);
    }
    const silent = makeWav({ bits: 16, channels: 2, rate: 8000, data: new Uint8Array(4000) });
    expect(scanLsb(silent, layoutOf(silent)).hits).toEqual([]);
  });

  it('ranks a file over readable text over noise-like hits', () => {
    const file = cover(6000, 1, 16, 4);
    const png = Uint8Array.of(
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
      0,
      0,
      13,
      0x49,
      0x48,
      0x44,
      0x52,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      8,
      2,
      0,
      0,
      0,
    );
    const marked = embedLsb(file, spec(), png);
    const best = scanLsb(marked, layoutOf(marked)).hits[0]!;
    expect(best.finding.hit?.kind).toBe('file');
    const text = embedLsb(
      file,
      spec(),
      ascii('Meet me at the old bridge at midnight and bring the documents'),
    );
    expect(scanLsb(text, layoutOf(text)).hits[0]!.finding.hit?.kind).toMatch(/text|inner/);
  });

  it('counts the combinations it tries', () => {
    const mono = layoutOf(cover(100, 1, 16, 1));
    const stereo = layoutOf(cover(100, 2, 16, 1));
    expect(scanLsb(cover(100, 1, 16, 1), mono).tried).toBe(8 + 8);
    expect(scanLsb(cover(100, 2, 16, 1), stereo).tried).toBe(24 + 8);
    const eight = makeWav({ bits: 8, channels: 1, rate: 8000, data: new Uint8Array(100) });
    expect(scanLsb(eight, layoutOf(eight)).tried).toBe(8);
  });
});

describe('extractManual', () => {
  const file = (() => {
    const base = makeWav({
      bits: 16,
      channels: 1,
      rate: 8000,
      data: intBytes(
        coverSamples({ frames: 4000, channels: 1, peak: 30000, rate: 8000, seed: 8 }),
        16,
      ),
    });
    return embedLsb(base, spec(), withLength(ascii('FTF{manual_header}')));
  })();
  const p = layoutOf(file);

  it('uses a plausible length header and stops at the announced size', () => {
    const x = extractManual(file, p, spec(), { header: 'auto', skip: 0, limit: 0 });
    expect(x.header).toMatchObject({ length: 18, little: false });
    expect(latin1Decode(x.bytes)).toBe('FTF{manual_header}');
    expect(x.capacity).toBe(500);
  });

  it('the raw stream with no header, limited, or after skipping bytes', () => {
    const raw = extractManual(file, p, spec(), { header: 'none', skip: 0, limit: 22 });
    expect(raw.header).toBeNull();
    expect(raw.bytes).toHaveLength(22);
    expect(latin1Decode(raw.bytes.subarray(4))).toBe('FTF{manual_header}');
    const skipped = extractManual(file, p, spec(), { header: 'none', skip: 4, limit: 18 });
    expect(latin1Decode(skipped.bytes)).toBe('FTF{manual_header}');
    // skipping and then finding the header works on the data after the skipped bytes
    const padded = embedLsb(
      file,
      spec(),
      concatBytes(Uint8Array.of(1, 2, 3), withLength(ascii('FTF{after_skip}'))),
    );
    const x = extractManual(padded, p, spec(), { header: 'auto', skip: 3, limit: 0 });
    expect(latin1Decode(x.bytes)).toBe('FTF{after_skip}');
  });

  it('forces a byte order, and reports a weak header it did not use', () => {
    const forced = extractManual(file, p, spec(), { header: 'be', skip: 0, limit: 0 });
    expect(forced.bytes).toHaveLength(18);
    const noise = embedLsb(
      file,
      spec(),
      concatBytes(Uint8Array.of(0, 0, 0, 40), randomBytes(60, 3)),
    );
    const weak = extractManual(noise, p, spec(), { header: 'auto', skip: 0, limit: 0 });
    expect(weak.header).toBeNull();
    expect(weak.weak).toMatchObject({ length: 40 });
  });

  it('reads at most as many bytes as the file can hold', () => {
    const x = extractManual(file, p, spec({ planes: [0, 1, 2, 3] }), {
      header: 'none',
      skip: 0,
      limit: 0,
    });
    expect(x.bytes).toHaveLength(2000);
    expect(x.capped).toBe(false);
  });
});

describe('planeStats and findOnset', () => {
  it('measures the share of ones per plane and window', () => {
    // left: low bit alternates 0 1 (ratio .5), plane 1 constant 1; right: all zero
    const frames = 640;
    const values: number[] = [];
    for (let f = 0; f < frames; f++) values.push((f % 2) | 2, 0);
    const wav = makeWav({ bits: 16, channels: 2, rate: 8000, data: intBytes(values, 16) });
    const s = planeStats(wav, layoutOf(wav));
    expect(s.channels).toBe(2);
    expect(s.columns).toBe(20);
    expect(s.windowFrames).toBe(32);
    expect([...s.ratios[0]![0]!].every((r) => r === 0.5)).toBe(true);
    expect([...s.ratios[0]![1]!].every((r) => r === 1)).toBe(true);
    expect([...s.ratios[0]![2]!].every((r) => r === 0)).toBe(true);
    expect([...s.ratios[1]![0]!].every((r) => r === 0)).toBe(true);
  });

  it('caps the channels it analyses and the columns it draws', () => {
    const wav = makeWav({
      bits: 16,
      channels: 6,
      rate: 8000,
      data: new Uint8Array(6 * 2 * 100_000),
    });
    const s = planeStats(wav, layoutOf(wav));
    expect(s.channels).toBe(4);
    expect(s.columns).toBeLessThanOrEqual(600);
    expect(s.columns).toBeGreaterThan(590);
  });

  it('finds where a silent plane wakes up', () => {
    const frames = 8000;
    const samples = coverSamples({
      frames,
      channels: 1,
      peak: 30000,
      rate: 8000,
      seed: 5,
      silence: 3000,
    });
    const wav = makeWav({ bits: 16, channels: 1, rate: 8000, data: intBytes(samples, 16) });
    const onset = findOnset(planeStats(wav, layoutOf(wav)))!;
    expect(onset.channel).toBe(0);
    expect(onset.frame).toBeGreaterThanOrEqual(2900);
    expect(onset.frame).toBeLessThanOrEqual(3100);
    const sound = makeWav({
      bits: 16,
      channels: 1,
      rate: 8000,
      data: intBytes(coverSamples({ frames, channels: 1, peak: 30000, rate: 8000, seed: 6 }), 16),
    });
    expect(findOnset(planeStats(sound, layoutOf(sound)))).toBeNull();
    const silent = makeWav({ bits: 16, channels: 1, rate: 8000, data: new Uint8Array(2 * frames) });
    expect(findOnset(planeStats(silent, layoutOf(silent)))).toBeNull();
  });
});
