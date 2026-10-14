import { describe, expect, it } from 'vitest';
import { concatBytes } from '../lib/bytes';
import {
  MAX_CONTEXT_RATE,
  MIN_CONTEXT_RATE,
  probeSampleRate,
  rateInfoOf,
  usableContextRate,
} from './audio-rate';

const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const u32le = (n: number) =>
  Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24]);
const u32be = (n: number) =>
  Uint8Array.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16be = (n: number) => Uint8Array.from([n >>> 8, n & 255]);
const zeros = (n: number) => new Uint8Array(n);
const bytes = (...parts: (Uint8Array | number[])[]) =>
  concatBytes(...parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p))));

// ---------- MPEG audio ----------

/** Standard frame-length formula, written out independently of the implementation. */
function mpegFrame(
  version: 3 | 2 | 0,
  layer: 1 | 2 | 3,
  rateIdx: number,
  kbps: number,
  bitrateIdx: number,
) {
  const rates = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const rate = rates[version][rateIdx]!;
  const layerBits = 4 - layer;
  const header = [
    0xff,
    0xe0 | (version << 3) | (layerBits << 1) | 1, // no CRC
    (bitrateIdx << 4) | (rateIdx << 2), // no padding
    0x00,
  ];
  const samples = layer === 1 ? 384 : layer === 3 && version !== 3 ? 576 : 1152;
  const length =
    layer === 1
      ? Math.floor(((samples / 8 / 4) * (kbps * 1000)) / rate) * 4
      : Math.floor(((samples / 8) * (kbps * 1000)) / rate);
  return bytes(header, zeros(length - 4));
}

const mp3 = (version: 3 | 2 | 0, rateIdx: number, kbps: number, bitrateIdx: number, n = 4) =>
  concatBytes(...Array.from({ length: n }, () => mpegFrame(version, 3, rateIdx, kbps, bitrateIdx)));

function id3(size: number, payload: Uint8Array = zeros(size)): Uint8Array {
  const synchsafe = [(size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127];
  return bytes(ascii('ID3'), [3, 0, 0], synchsafe, payload);
}

describe('probeSampleRate: MP3', () => {
  it.each([
    [3, 0, 44100, 128, 9],
    [3, 1, 48000, 128, 9],
    [3, 2, 32000, 128, 9],
    [2, 0, 22050, 64, 8],
    [2, 1, 24000, 64, 8],
    [2, 2, 16000, 32, 4],
    [0, 0, 11025, 32, 4],
    [0, 1, 12000, 32, 4],
    [0, 2, 8000, 16, 2],
  ] as const)(
    'MPEG version %i, rate index %i = %i Hz',
    (version, rateIdx, rate, kbps, bitrateIdx) => {
      const probe = probeSampleRate(mp3(version, rateIdx, kbps, bitrateIdx));
      expect(probe).toEqual({ format: 'mp3', decodeRate: rate });
    },
  );

  it('skips an ID3v2 tag even when it contains something that looks like a frame', () => {
    // A tag whose payload holds a lone 44100 Hz header (no frame follows it).
    const decoy = bytes([0xff, 0xfb, 0x90, 0x00], zeros(60));
    const file = bytes(id3(64, bytes(decoy, zeros(0)).subarray(0, 64)), mp3(2, 0, 64, 8));
    expect(probeSampleRate(file)?.decodeRate).toBe(22050);
  });

  it('skips stacked ID3v2 tags', () => {
    const file = bytes(id3(20), id3(300), mp3(2, 1, 64, 8));
    expect(probeSampleRate(file)?.decodeRate).toBe(24000);
  });

  it('ignores a stray sync pattern that is not followed by another frame', () => {
    const noise = bytes([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8], zeros(40));
    const file = bytes(noise, mp3(2, 0, 64, 8));
    expect(probeSampleRate(file)?.decodeRate).toBe(22050);
  });

  it('accepts a file that is a single frame', () => {
    expect(probeSampleRate(mp3(3, 0, 128, 9, 1))?.decodeRate).toBe(44100);
  });

  it('reads Layer II too', () => {
    expect(probeSampleRate(bytes(mpegFrame(3, 2, 1, 128, 8), mpegFrame(3, 2, 1, 128, 8)))).toEqual({
      format: 'mp3',
      decodeRate: 48000,
    });
  });

  it('rejects reserved fields', () => {
    // Rate index 3 and bitrate index 15 are invalid.
    const badRate = bytes([0xff, 0xfb, 0x9c, 0x00], zeros(500));
    const badBitrate = bytes([0xff, 0xfb, 0xf0, 0x00], zeros(500));
    expect(probeSampleRate(badRate)).toBeNull();
    expect(probeSampleRate(badBitrate)).toBeNull();
  });
});

// ---------- AAC ADTS ----------

function adts(rateIdx: number, n = 3, length = 40): Uint8Array {
  const frame = bytes(
    [
      0xff,
      0xf1,
      (1 << 6) | (rateIdx << 2),
      0x40 | (length >> 11),
      (length >> 3) & 255,
      ((length & 7) << 5) | 0x1f,
      0xfc,
    ],
    zeros(length - 7),
  );
  return concatBytes(...Array.from({ length: n }, () => frame));
}

describe('probeSampleRate: AAC (ADTS)', () => {
  it.each([
    [3, 48000],
    [4, 44100],
    [7, 22050],
    [8, 16000],
    [11, 8000],
    [12, 7350],
  ])('index %i = %i Hz', (idx, rate) => {
    expect(probeSampleRate(adts(idx))).toEqual({ format: 'aac', decodeRate: rate });
  });

  it('is not confused with MP3 (the layer bits differ)', () => {
    expect(probeSampleRate(adts(4))?.format).toBe('aac');
    expect(probeSampleRate(mp3(3, 0, 128, 9))?.format).toBe('mp3');
  });
});

// ---------- FLAC ----------

function streamInfo(rate: number): Uint8Array {
  const b = zeros(34);
  b[10] = (rate >> 12) & 255;
  b[11] = (rate >> 4) & 255;
  b[12] = ((rate & 15) << 4) | (1 << 1); // 2 channels, then the top bit of bits-per-sample
  return b;
}
const flac = (rate: number) => bytes(ascii('fLaC'), [0x80, 0, 0, 34], streamInfo(rate), zeros(64));

describe('probeSampleRate: FLAC', () => {
  it.each([8000, 22050, 44100, 48000, 96000, 192000, 655350])('%i Hz (20-bit field)', (rate) => {
    expect(probeSampleRate(flac(rate))).toEqual({ format: 'flac', decodeRate: rate });
  });

  it('skips a leading ID3v2 tag', () => {
    expect(probeSampleRate(bytes(id3(40), flac(32000)))?.decodeRate).toBe(32000);
  });

  it('needs STREAMINFO first', () => {
    const wrong = bytes(ascii('fLaC'), [0x84, 0, 0, 34], streamInfo(44100));
    expect(probeSampleRate(wrong)).toBeNull();
  });
});

// ---------- Ogg ----------

function oggPage(packet: Uint8Array): Uint8Array {
  return bytes(
    ascii('OggS'),
    [0, 2], // version, beginning of stream
    zeros(8), // granule position
    u32le(1), // serial
    u32le(0), // sequence
    u32le(0), // CRC (not checked)
    [1, packet.length],
    packet,
  );
}
const vorbisId = (rate: number) =>
  bytes(
    [1],
    ascii('vorbis'),
    u32le(0),
    [2],
    u32le(rate),
    u32le(0),
    u32le(128000),
    u32le(0),
    [0xb8, 1],
  );
const opusHead = (inputRate: number) =>
  bytes(ascii('OpusHead'), [1, 2], [0x38, 0x01], u32le(inputRate), [0, 0, 0]);

describe('probeSampleRate: Ogg', () => {
  it('reads the Vorbis identification header', () => {
    expect(probeSampleRate(oggPage(vorbisId(32000)))).toEqual({
      format: 'vorbis',
      decodeRate: 32000,
    });
    expect(probeSampleRate(oggPage(vorbisId(11025)))?.decodeRate).toBe(11025);
  });

  it('decodes Opus at 48000 Hz and reports the original input rate', () => {
    expect(probeSampleRate(oggPage(opusHead(44100)))).toEqual({
      format: 'opus',
      decodeRate: 48000,
      originalRate: 44100,
    });
    expect(probeSampleRate(oggPage(opusHead(8000)))?.originalRate).toBe(8000);
  });

  it('has no original rate when OpusHead says 0 (unspecified)', () => {
    expect(probeSampleRate(oggPage(opusHead(0)))).toEqual({ format: 'opus', decodeRate: 48000 });
  });

  it('reads the STREAMINFO of Ogg FLAC', () => {
    const packet = bytes(
      [0x7f],
      ascii('FLAC'),
      [1, 0],
      u16be(1),
      ascii('fLaC'),
      [0x80, 0, 0, 34],
      streamInfo(24000),
    );
    expect(probeSampleRate(oggPage(packet))).toEqual({ format: 'flac', decodeRate: 24000 });
  });

  it('gives up on codecs it does not know', () => {
    expect(probeSampleRate(oggPage(bytes(ascii('Speex   '), zeros(60))))).toBeNull();
  });
});

// ---------- WebM ----------

describe('probeSampleRate: WebM', () => {
  const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x80];
  it('finds OpusHead in the codec private data', () => {
    const file = bytes(ebml, zeros(200), ascii('A_OPUS'), zeros(30), opusHead(16000), zeros(100));
    expect(probeSampleRate(file)).toEqual({
      format: 'opus',
      decodeRate: 48000,
      originalRate: 16000,
    });
  });

  it('finds the Vorbis identification header', () => {
    const file = bytes(
      ebml,
      zeros(100),
      ascii('A_VORBIS'),
      [2, 30, 40],
      vorbisId(44100),
      zeros(100),
    );
    expect(probeSampleRate(file)).toEqual({ format: 'vorbis', decodeRate: 44100 });
  });
});

// ---------- MP4 / M4A ----------

const box = (type: string, ...payload: (Uint8Array | number[])[]) => {
  const body = bytes(...payload);
  return bytes(u32be(8 + body.length), ascii(type), body);
};

/** Bit string ("0101...") to bytes, zero padded. */
function bits(s: string): Uint8Array {
  const padded = s.padEnd(Math.ceil(s.length / 8) * 8, '0');
  return Uint8Array.from({ length: padded.length / 8 }, (_, i) =>
    parseInt(padded.slice(i * 8, i * 8 + 8), 2),
  );
}
const bin = (n: number, width: number) => n.toString(2).padStart(width, '0');

/** AudioSpecificConfig: AOT, rate index (or explicit rate), channels [, SBR extension rate]. */
function asc(aot: number, rateIdx: number, explicit?: number, sbrIdx?: number): Uint8Array {
  let s =
    bin(aot, 5) + bin(explicit ? 15 : rateIdx, 4) + (explicit ? bin(explicit, 24) : '') + bin(2, 4);
  if (sbrIdx !== undefined) s += bin(sbrIdx, 4);
  return bits(s);
}

function esds(config: Uint8Array): Uint8Array {
  const dsi = bytes([0x05, config.length], config);
  const dcd = bytes(
    [0x04, 13 + dsi.length, 0x40, 0x15],
    zeros(3),
    u32be(128000),
    u32be(128000),
    dsi,
  );
  const es = bytes([0x03, 3 + dcd.length + 3, 0, 1, 0], dcd, [0x06, 0x01, 0x02]);
  return box('esds', zeros(4), es);
}

function audioEntry(type: string, fixedRate: number, ...children: Uint8Array[]): Uint8Array {
  return box(
    type,
    zeros(6),
    u16be(1), // data reference index
    u16be(0),
    u16be(0),
    zeros(4), // version, revision, vendor
    u16be(2),
    u16be(16),
    u16be(0),
    u16be(0), // channels, sample size, compression id, packet size
    u32be((fixedRate * 65536) >>> 0), // 16.16 sample rate
    ...children,
  );
}

function track(handler: 'soun' | 'vide', timescale: number, entry: Uint8Array): Uint8Array {
  const mdhd = box('mdhd', zeros(4), zeros(8), u32be(timescale), u32be(0), zeros(4));
  const hdlr = box('hdlr', zeros(8), ascii(handler), zeros(13));
  const stsd = box('stsd', zeros(4), u32be(1), entry);
  return box('trak', box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd))));
}

const mp4 = (...tracks: Uint8Array[]) =>
  bytes(
    box('ftyp', ascii('M4A '), zeros(4), ascii('M4A mp42isom')),
    box('mdat', zeros(32)),
    box('moov', ...tracks),
  );

describe('probeSampleRate: MP4 / M4A', () => {
  it('reads the AAC AudioSpecificConfig of the esds box', () => {
    const file = mp4(track('soun', 22050, audioEntry('mp4a', 22050, esds(asc(2, 7)))));
    expect(probeSampleRate(file)).toEqual({ format: 'mp4', decodeRate: 22050 });
  });

  it('prefers the explicit SBR output rate (HE-AAC) over the core rate', () => {
    const file = mp4(
      track('soun', 24000, audioEntry('mp4a', 24000, esds(asc(5, 6, undefined, 3)))),
    );
    expect(probeSampleRate(file)?.decodeRate).toBe(48000);
  });

  it('reads an explicit 24-bit rate and ignores a 16.16 field that overflowed', () => {
    const file = mp4(track('soun', 1000, audioEntry('mp4a', 0, esds(asc(2, 0, 88200)))));
    expect(probeSampleRate(file)?.decodeRate).toBe(88200);
  });

  it('falls back to the sample entry rate, then to the media timescale', () => {
    expect(probeSampleRate(mp4(track('soun', 8000, audioEntry('alac', 44100))))?.decodeRate).toBe(
      44100,
    );
    expect(probeSampleRate(mp4(track('soun', 32000, audioEntry('alac', 0))))?.decodeRate).toBe(
      32000,
    );
  });

  it('skips a video track and finds the audio one', () => {
    const video = track('vide', 90000, box('avc1', zeros(78)));
    const audio = track('soun', 16000, audioEntry('mp4a', 16000, esds(asc(2, 8))));
    expect(probeSampleRate(mp4(video, audio))?.decodeRate).toBe(16000);
  });

  it('decodes Opus-in-MP4 at 48000 Hz and reports the input rate', () => {
    const dOps = box('dOps', [0, 2], [0x38, 0x01], u32be(44100), zeros(3));
    const file = mp4(track('soun', 48000, audioEntry('Opus', 48000, dOps)));
    expect(probeSampleRate(file)).toEqual({
      format: 'opus',
      decodeRate: 48000,
      originalRate: 44100,
    });
  });

  it('copes with a moov box after a large mdat and a 64-bit box size', () => {
    const big = bytes(u32be(1), ascii('mdat'), u32be(0), u32be(16 + 100), zeros(100));
    const file = bytes(
      box('ftyp', ascii('M4A '), zeros(4)),
      big,
      box('moov', track('soun', 44100, audioEntry('mp4a', 44100))),
    );
    expect(probeSampleRate(file)?.decodeRate).toBe(44100);
  });
});

// ---------- not audio / not probed ----------

describe('probeSampleRate: nothing to read', () => {
  it('returns null for unknown data, WAV and tiny input', () => {
    expect(probeSampleRate(new Uint8Array(0))).toBeNull();
    expect(probeSampleRate(ascii('hello, this is a text file with no audio in it'))).toBeNull();
    expect(
      probeSampleRate(bytes(ascii('RIFF'), u32le(36), ascii('WAVEfmt '), zeros(64))),
    ).toBeNull();
    expect(probeSampleRate(zeros(5000))).toBeNull();
  });

  it('survives truncated headers of every kind', () => {
    for (const file of [flac(44100), oggPage(vorbisId(44100)), mp3(3, 0, 128, 9, 1), adts(4, 1)]) {
      for (let n = 0; n < Math.min(80, file.length); n++) {
        expect(() => probeSampleRate(file.subarray(0, n))).not.toThrow();
      }
    }
    const m4a = mp4(track('soun', 44100, audioEntry('mp4a', 44100, esds(asc(2, 4)))));
    for (let n = 0; n < m4a.length; n += 3)
      expect(() => probeSampleRate(m4a.subarray(0, n))).not.toThrow();
  });
});

describe('context rates', () => {
  it('accepts the range Web Audio supports', () => {
    expect(usableContextRate(8000)).toBe(true);
    expect(usableContextRate(MIN_CONTEXT_RATE)).toBe(true);
    expect(usableContextRate(MAX_CONTEXT_RATE)).toBe(true);
    expect(usableContextRate(2999)).toBe(false);
    expect(usableContextRate(768001)).toBe(false);
    expect(usableContextRate(44100.5)).toBe(false);
    expect(usableContextRate(0)).toBe(false);
  });

  it('reads back what the decoder recorded', () => {
    expect(rateInfoOf({ sampleRate: 1 })).toBeUndefined();
    expect(rateInfoOf({ rateSource: 'file' })).toEqual({ source: 'file' });
    expect(rateInfoOf({ rateSource: 'decoder', originalRate: 44100 })).toEqual({
      source: 'decoder',
      originalRate: 44100,
    });
    expect(rateInfoOf({ rateSource: 'other' })).toBeUndefined();
  });
});
