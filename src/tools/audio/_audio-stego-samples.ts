/**
 * The audio steganography sample files (public/samples/audio-stego-*), made by
 * scripts/gen-samples-audio-stego.mjs and checked by the tool's tests. Made-up messages only.
 */
import { zipSync, strToU8 } from 'fflate';
import { concatBytes } from '../../lib/bytes';
import {
  ascii,
  coverSamples,
  embedLsb,
  id3Apic,
  id3Comm,
  id3Tag,
  id3Text,
  id3v1,
  intBytes,
  makeWav,
  mp3Frame,
  textPng,
  withLength,
  xingFrame,
} from './_audio-stego-fixtures';

export const FLAGS = {
  lsb: 'FTF{wav_lsb}',
  chunk: 'FTF{extra_chunk}',
  after: 'FTF{after_data}',
  comment: 'FTF{id3_comment}',
  png: 'FTF{PNG_IN_WAV}',
  cover: 'FTF{COVER}',
} as const;

/** 16-bit mono, "FTF{wav_lsb}" behind a 32-bit big-endian length in the low bit of every sample. */
export function lsbWav(): Uint8Array {
  const samples = coverSamples({
    frames: 12000,
    channels: 1,
    peak: 32767,
    rate: 8000,
    seed: 11,
    silence: 4000,
  });
  const wav = makeWav({
    bits: 16,
    channels: 1,
    rate: 8000,
    data: intBytes(samples, 16),
  });
  return embedLsb(
    wav,
    { planes: [0], channel: null, bitOrder: 'msb', step: 1, offset: 0 },
    withLength(ascii(FLAGS.lsb)),
  );
}

/** The picture hidden in the PNG sample: the flag, drawn. */
export const hiddenPng = (): Uint8Array => textPng(FLAGS.png, 2);

/** 24-bit stereo, a PNG in the two low bits of the left channel only (no length header). */
export function pngWav(): Uint8Array {
  const samples = coverSamples({
    frames: 8000,
    channels: 2,
    peak: 8388607,
    rate: 8000,
    seed: 23,
    silence: 4000,
  });
  const wav = makeWav({ bits: 24, channels: 2, rate: 8000, data: intBytes(samples, 24) });
  return embedLsb(
    wav,
    { planes: [0, 1], channel: 0, bitOrder: 'msb', step: 1, offset: 0 },
    hiddenPng(),
  );
}

/** A ZIP holding "flag.txt", glued after the audio. */
export function hiddenZip(): Uint8Array {
  return zipSync({ 'flag.txt': [strToU8(FLAGS.after), { mtime: Date.UTC(2020, 0, 1), level: 6 }] });
}

/** 16-bit mono with an extra "ftfx" chunk before the audio and a ZIP after the last chunk. */
export function chunkWav(): Uint8Array {
  const samples = coverSamples({
    frames: 8000,
    channels: 1,
    peak: 32767,
    rate: 8000,
    seed: 31,
  });
  return makeWav({
    bits: 16,
    channels: 1,
    rate: 8000,
    data: intBytes(samples, 16),
    before: [{ id: 'ftfx', body: ascii(FLAGS.chunk) }],
    trailing: hiddenZip(),
  });
}

/** The cover picture of the MP3 sample. */
export const coverPng = (): Uint8Array => textPng(FLAGS.cover, 2);

/** ID3v2.3 with a comment holding a flag and a cover picture, a Xing header, silent frames. */
export function id3Mp3(): Uint8Array {
  const tag = id3Tag(3, [
    id3Text(3, 'TIT2', 'Silent test', 0),
    id3Text(3, 'TPE1', 'Find The Flag', 0),
    id3Comm(3, FLAGS.comment, '', 0),
    id3Apic(3, 'image/png', 3, 'cover', coverPng()),
  ]);
  const frames = 12;
  const audio = concatBytes(
    xingFrame({ frames, bytes: (frames + 1) * 417 }),
    ...Array.from({ length: frames }, () => mp3Frame()),
  );
  return concatBytes(
    tag,
    audio,
    id3v1({ title: 'Silent test', artist: 'Find The Flag', year: '2026' }),
  );
}

export function buildSamples(): Record<string, Uint8Array> {
  return {
    'audio-stego-lsb.wav': lsbWav(),
    'audio-stego-png.wav': pngWav(),
    'audio-stego-chunk.wav': chunkWav(),
    'audio-stego-id3.mp3': id3Mp3(),
  };
}
