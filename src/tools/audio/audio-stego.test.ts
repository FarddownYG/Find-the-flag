import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { lazyFile } from '../../core/prepare';
import { setLocale } from '../../i18n';
import { resultToText } from '../../core/result-text';
import type { Output, OptionSpec } from '../../core/types';
import { concatBytes, latin1Decode, toBase64 } from '../../lib/bytes';
import {
  ascii,
  coverSamples,
  embedLsb,
  flacFile,
  flacPicture,
  flacStreamInfo,
  id3Comm,
  id3Tag,
  id3v1,
  intBytes,
  makeAiff,
  makeWav,
  mp3Frame,
  oggVorbis,
  prng,
  randomBytes,
  textPng,
  vorbisComment,
  withLength,
} from './_audio-stego-fixtures';
import { isNoPcm, readPcm, walkChunks, type LsbSpec } from './_audio-stego-pcm';
import {
  buildSamples,
  chunkWav,
  FLAGS,
  hiddenPng,
  hiddenZip,
  id3Mp3,
  lsbWav,
  pngWav,
} from './_audio-stego-samples';
import tool, { MAX_FILE } from './audio-stego';

type Options = Record<string, unknown>;
const specs: Record<string, OptionSpec> = tool.options ?? {};
const defaults = (): Options =>
  Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, s.default]));
const run = (bytes: Uint8Array, options: Options = {}, name = 'test.bin'): Promise<Output[]> =>
  Promise.resolve(
    tool.run(lazyFile(new Blob([bytes as BlobPart]), name), { ...defaults(), ...options } as never),
  );

const byType = <T extends Output['type']>(out: Output[], type: T) =>
  out.filter((o): o is Extract<Output, { type: T }> => o.type === type);
const bytesBlock = (out: Output[], label?: RegExp) =>
  byType(out, 'bytes').find((o) => !label || label.test(o.label ?? ''))!.value;
const files = (out: Output[]) => byType(out, 'files').flatMap((f) => f.files);
const notes = (out: Output[], level?: string) =>
  byType(out, 'note')
    .filter((n) => !level || n.level === level)
    .map((n) => n.text);
const table = (out: Output[], label: RegExp) =>
  byType(out, 'table').find((t) => label.test(t.label ?? ''))!;

describe('the shipped samples', () => {
  const sample = (name: string) =>
    new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

  it('are the ones the builders make (run scripts/gen-samples-audio-stego.mjs after changing them)', () => {
    for (const [name, bytes] of Object.entries(buildSamples())) {
      expect(sample(name), name).toEqual(bytes);
    }
  });

  it('WAV: "FTF{wav_lsb}" behind a length, found in the low bit, exactly', async () => {
    const out = await run(sample('audio-stego-lsb.wav'));
    expect(latin1Decode(bytesBlock(out, /Best hit/))).toBe('FTF{wav_lsb}');
    const hits = table(out, /LSB scan/);
    expect(hits.rows).toHaveLength(1);
    expect(hits.rows[0]![0]).toBe('the only channel, bit 0, MSB first');
    expect(hits.rows[0]![1]).toBe('Flag · 32-bit BE length (12 bytes) · “FTF{wav_lsb}”');
    expect(notes(out, 'success')[0]).toContain('Best hit');
    expect(byType(out, 'image')).toHaveLength(1);
    // the plot has the green mark where the bits come from
    expect(resultToText(out)).toContain('FTF{wav_lsb}');
  });

  it('WAV: a PNG in the 2 low bits of the left channel only, exactly', async () => {
    const out = await run(sample('audio-stego-png.wav'));
    expect(bytesBlock(out, /Best hit/)).toEqual(hiddenPng());
    // the extracted file is a picture the page can show
    const pic = byType(out, 'picture')[0]!;
    expect(pic.data).toEqual(hiddenPng());
    expect(pic.mime).toBe('image/png');
    const hits = table(out, /LSB scan/);
    expect(hits.rows[0]![0]).toBe('left channel, bits 0,1, MSB first');
    expect(hits.rows[0]![1]).toBe('File: PNG image');
    // nothing else reads as something: the right channel and the other planes are noise or silence
    expect(hits.rows).toHaveLength(1);
  });

  it('WAV: the extra "ftfx" chunk and the ZIP after the last chunk', async () => {
    const out = await run(sample('audio-stego-chunk.wav'));
    const list = files(out);
    expect(list.map((f) => f.name)).toEqual(['chunk-ftfx.bin', 'wav-after-data.bin']);
    expect(latin1Decode(list[0]!.data)).toBe(FLAGS.chunk);
    expect(list[1]!.data).toEqual(hiddenZip());
    expect(list[1]!.note).toContain('ZIP archive');
    expect(list[0]!.note).toContain(`“${FLAGS.chunk}”`);
    expect(notes(out, 'warn').join('\n')).toContain('RIFF size field says the file ends at byte');
    expect(byType(out, 'text')[0]!.value).toBe(FLAGS.chunk);
    expect(table(out, /Structure/).rows).toContainEqual([
      '36 (0x24)',
      'ftfx',
      '24 B · Not a chunk of the WAV / AIFF format: hidden data?',
    ]);
  });

  it('MP3: the comment, the cover picture, the tags and the Xing header', async () => {
    const out = await run(sample('audio-stego-id3.mp3'));
    const tags = table(out, /Tags and metadata/);
    expect(tags.rows).toContainEqual(['ID3v2', 'COMM(eng)', FLAGS.comment]);
    expect(tags.rows).toContainEqual(['ID3v1', 'title', 'Silent test']);
    expect(tags.rows.map((r) => r[0])).toContain('Xing / Info');
    const pic = byType(out, 'picture')[0]!;
    expect(pic.data).toEqual(textPng(FLAGS.cover, 2));
    expect(pic.mime).toBe('image/png');
    expect(files(out)[0]!.data).toEqual(pic.data);
    expect(byType(out, 'image')).toHaveLength(0); // no sample bits to plot
    expect(notes(out, 'warn')[0]).toContain('MP3 is a lossy format');
  });

  it('the picture hidden in the sample really is the flag, drawn', () => {
    expect(hiddenPng()[1]).toBe(0x50);
    expect(lsbWav()).toHaveLength(24044);
    expect(pngWav()).toHaveLength(48044);
    expect(chunkWav().length).toBeGreaterThan(16000);
    expect(id3Mp3().length).toBe(5981);
  });
});

describe('manual mode', () => {
  const wav = pngWav();

  it('reads exactly what the options say', async () => {
    const out = await run(wav, {
      mode: 'manual',
      planes: '0,1',
      channels: 'left',
      header: 'none',
      limit: 473,
    });
    expect(bytesBlock(out, /Extracted/)).toEqual(hiddenPng());
    const kv = byType(out, 'kv').find((k) => k.label === 'Extraction')!;
    expect(Object.fromEntries(kv.entries)).toMatchObject({
      Channels: 'left channel',
      'Bit planes': 'bits 0,1',
      'Bit order': 'MSB first',
      'Bytes extracted': '473 of 2000',
    });
    expect(notes(out, 'success')[0]).toContain('PNG image');
    expect(notes(out).join('\n')).toContain('Switch to Auto scan');
    expect(byType(out, 'image')).toHaveLength(1);
  });

  it('"each" gives every channel its own extraction', async () => {
    const out = await run(wav, {
      mode: 'manual',
      planes: '0,1',
      channels: 'each',
      header: 'none',
      limit: 32,
    });
    const blocks = byType(out, 'bytes');
    expect(blocks.map((b) => b.label)).toEqual([
      'Extracted bytes (left channel)',
      'Extracted bytes (right channel)',
    ]);
    expect(blocks[0]!.value.subarray(0, 4)).toEqual(Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
    expect(blocks[1]!.value[0]).not.toBe(0x89);
  });

  it('start sample, step, unit, bit order and skip all reach the extraction', async () => {
    const file = embedLsb(
      makeWav({
        bits: 16,
        channels: 1,
        rate: 8000,
        data: intBytes(
          coverSamples({ frames: 6000, channels: 1, peak: 30000, rate: 8000, seed: 3 }),
          16,
        ),
      }),
      { planes: [0], channel: null, bitOrder: 'lsb', step: 3, offset: 100 },
      concatBytes(Uint8Array.of(9, 9), ascii('FTF{all_options}')),
    );
    const out = await run(file, {
      mode: 'manual',
      bitOrder: 'lsb',
      step: 3,
      offset: 100,
      skip: 2,
      header: 'none',
      limit: 16,
    });
    expect(latin1Decode(bytesBlock(out, /Extracted/))).toBe('FTF{all_options}');
    expect(notes(out).join('\n')).toContain('The extracted data is readable text.');
    const kv = Object.fromEntries(byType(out, 'kv').find((k) => k.label === 'Extraction')!.entries);
    expect(kv.Samples).toBe('start 100, step 3');
    const bytewise = embedLsb(
      makeWav({ bits: 16, channels: 2, rate: 8000, data: randomBytes(4000, 2) }),
      { planes: [0], unit: 'byte', channel: null, bitOrder: 'msb', step: 1, offset: 0 },
      ascii('FTF{python_wave}'),
    );
    const b = await run(bytewise, { mode: 'manual', unit: 'byte', header: 'none', limit: 16 });
    expect(latin1Decode(bytesBlock(b, /Extracted/))).toBe('FTF{python_wave}');
    expect(Object.fromEntries(byType(b, 'kv')[1]!.entries).Channels ?? '').toBeDefined();
    expect(byType(b, 'kv').find((k) => k.label === 'Extraction')!.entries[0]![1]).toBe(
      'every byte of the audio data',
    );
  });

  it('applies a length header, and says so', async () => {
    const file = lsbWav();
    const out = await run(file, { mode: 'manual', header: 'auto' });
    expect(latin1Decode(bytesBlock(out, /Extracted/))).toBe(FLAGS.lsb);
    expect(notes(out).join('\n')).toContain('Length header found: 32-bit BE length (12 bytes)');
    const raw = await run(file, { mode: 'manual', header: 'none', limit: 16 });
    expect(bytesBlock(raw, /Extracted/)).toHaveLength(16);
    expect(notes(raw).join('\n')).not.toContain('Length header found');
  });

  it('reads multi-channel files and the byte order of AIFF', async () => {
    const six = embedLsb(
      makeWav({ bits: 24, channels: 6, rate: 8000, data: randomBytes(6 * 3 * 500, 7) }),
      { planes: [0], channel: 4, bitOrder: 'msb', step: 1, offset: 0 },
      ascii('FTF{fifth_channel}'),
    );
    const out = await run(six, { mode: 'manual', channel: 5, header: 'none', limit: 18 });
    expect(latin1Decode(bytesBlock(out, /Extracted/))).toBe('FTF{fifth_channel}');
    const aiff = embedLsb(
      makeAiff({ bits: 16, channels: 2, rate: 22050, frames: 400, data: randomBytes(1600, 9) }),
      { planes: [0, 1], channel: 1, bitOrder: 'lsb', step: 1, offset: 0 },
      ascii('FTF{aiff_right}'),
    );
    const a = await run(aiff, {
      mode: 'manual',
      planes: '0-1',
      channels: 'right',
      bitOrder: 'lsb',
      header: 'none',
      limit: 15,
    });
    expect(latin1Decode(bytesBlock(a, /Extracted/))).toBe('FTF{aiff_right}');
    const auto = await run(aiff);
    expect(table(auto, /LSB scan/).rows[0]![0]).toBe('right channel, bits 0,1, LSB first');
  });

  it('round trip with random settings, through the tool', async () => {
    const rand = prng(99);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
    for (let trial = 0; trial < 40; trial++) {
      const channels = pick([1, 2, 3]);
      const bits = pick([8, 16, 24, 32] as const);
      const file = makeWav({
        bits,
        channels,
        rate: 8000,
        data: randomBytes(1500 * channels * (bits / 8), trial + 3),
      });
      const planeCount = 1 + Math.floor(rand() * 4);
      const planes = Array.from({ length: planeCount }, (_, i) => i);
      const spec: LsbSpec = {
        planes,
        unit: bits > 8 && rand() < 0.3 ? 'byte' : 'sample',
        channel: rand() < 0.5 ? null : Math.floor(rand() * channels),
        bitOrder: pick(['msb', 'lsb'] as const),
        step: 1 + Math.floor(rand() * 2),
        offset: Math.floor(rand() * 10),
      };
      if (spec.unit === 'byte') spec.channel = null;
      const payload = randomBytes(5 + Math.floor(rand() * 40), trial + 500);
      const marked = embedLsb(file, spec, payload);
      const options: Options = {
        mode: 'manual',
        unit: spec.unit,
        planes: planes.join(','),
        channels:
          spec.channel === null
            ? 'all'
            : spec.channel === 0
              ? 'left'
              : spec.channel === 1
                ? 'right'
                : 'all',
        channel: spec.channel !== null && spec.channel >= 2 ? spec.channel + 1 : 0,
        bitOrder: spec.bitOrder,
        step: spec.step,
        offset: spec.offset,
        header: 'none',
        limit: payload.length,
      };
      const out = await run(marked, options);
      expect(bytesBlock(out, /Extracted/), JSON.stringify(spec)).toEqual(payload);
    }
  });

  it('the "use these settings" buttons reproduce the hit, option by option', async () => {
    const auto = await run(pngWav());
    const actions = byType(auto, 'actions')[0]!;
    expect(actions.actions).toHaveLength(1);
    expect(actions.actions[0]).toMatchObject({ label: 'Use these settings', primary: true });
    const options = actions.actions[0]!.options;
    for (const [key, value] of Object.entries(options)) {
      const spec = specs[key];
      expect(spec, key).toBeDefined();
      if (spec!.type === 'select') expect(spec!.choices.map((c) => c.value)).toContain(value);
    }
    const manual = await run(pngWav(), options);
    expect(bytesBlock(manual, /Extracted/).subarray(0, 473)).toEqual(hiddenPng());
    expect(notes(manual, 'success')[0]).toContain('PNG image');
  });

  it('refuses settings that make no sense, saying what to change', async () => {
    const bad = async (options: Options, message: string) => {
      await expect(run(wav, { mode: 'manual', ...options })).rejects.toThrow(message);
    };
    await bad({ planes: '0-4' }, 'Read 1 to 4 bit planes per sample (5 given)');
    await bad({ planes: '9' }, 'Bit 9 does not exist');
    await bad({ planes: 'a' }, 'Bad bit list');
    await bad({ step: 0 }, '"Sample step" must be a whole number, 1 or more');
    await bad({ step: 1.5 }, '"Sample step" must be');
    await bad({ offset: -1 }, '"Start sample" must be');
    await bad({ skip: -3 }, '"Skip bytes" must be');
    await bad({ limit: 2.5 }, '"Max bytes" must be');
    await bad({ channel: 3 }, 'Channel number must be 0 (use the choice above) or between 1 and 2');
    await bad({ skip: 100_000 }, 'Nothing left to read');
    const mono = lsbWav();
    await expect(run(mono, { mode: 'manual', channels: 'right' })).rejects.toThrow(
      'This file has one channel',
    );
  });
});

describe('auto scan: what it is honest about', () => {
  it('a WAV with nothing in it says so, and names what it cannot decode', async () => {
    const wav = makeWav({
      bits: 16,
      channels: 2,
      rate: 8000,
      data: intBytes(
        coverSamples({ frames: 4000, channels: 2, peak: 30000, rate: 8000, seed: 1 }),
        16,
      ),
    });
    const out = await run(wav);
    const all = notes(out).join('\n');
    expect(all).toContain('Scanned 32 combinations');
    expect(all).toContain('Nothing readable in the usual layouts');
    expect(all).toContain('DeepSound, SilentEye, Steghide');
    expect(all).toContain('this tool does not decode them');
    expect(all).toContain('Nothing found by these checks');
    expect(byType(out, 'actions')).toHaveLength(0);
    expect(files(out)).toEqual([]);
  });

  it('a silent stretch where the low bits wake up is pointed out on the plot', async () => {
    const samples = coverSamples({
      frames: 12000,
      channels: 1,
      peak: 30000,
      rate: 8000,
      seed: 4,
      silence: 5000,
    });
    const out = await run(
      makeWav({ bits: 16, channels: 1, rate: 8000, data: intBytes(samples, 16) }),
    );
    expect(notes(out).join('\n')).toMatch(
      /lowest bit plane of the only channel is flat \(digital silence\) until sample 50\d\d \(0\.6\d s\)/,
    );
    expect(notes(out).join('\n')).toContain(
      'combinations, starting just before that sample, were tried too',
    );
  });

  it('data that starts inside digital silence is found, and the button starts at the right sample', async () => {
    const flag = ascii('FTF{after_the_silence}');
    for (const [channels, channel, header] of [
      [1, null, true],
      [1, null, false],
      [2, 1, true],
      [2, null, false],
    ] as const) {
      const cover = coverSamples({
        frames: 9000,
        channels,
        peak: 30000,
        rate: 8000,
        seed: 21,
        silence: 5000,
      });
      const file = makeWav({ bits: 16, channels, rate: 8000, data: intBytes(cover, 16) });
      const start = 1234;
      const spec: LsbSpec = {
        planes: [0],
        channel,
        bitOrder: 'msb',
        step: 1,
        offset: channel === null ? start * channels : start,
      };
      const marked = embedLsb(file, spec, header ? withLength(flag) : flag);
      const out = await run(marked);
      const hits = table(out, /LSB scan/);
      expect(hits.rows[0]![1]).toContain('Flag');
      expect(hits.rows[0]![0]).toContain(`from sample ${spec.offset}`);
      expect(latin1Decode(bytesBlock(out, /Best hit/)).startsWith('FTF{after_the_silence}')).toBe(
        true,
      );
      expect(notes(out).join('\n')).toContain(
        'combinations, starting just before that sample, were tried too',
      );
      const action = byType(out, 'actions')[0]!.actions[0]!;
      expect(action.options).toMatchObject({ mode: 'manual', offset: spec.offset });
      const manual = await run(marked, action.options);
      expect(
        latin1Decode(bytesBlock(manual, /Extracted/)).startsWith('FTF{after_the_silence}'),
      ).toBe(true);
    }
  });

  it('does not look around a silence when the start of the file already gave something', async () => {
    const out = await run(lsbWav());
    expect(notes(out).join('\n')).not.toContain('start positions just before it');
  });

  it('a lossy file: no LSB scan, and why', async () => {
    const out = await run(id3Mp3());
    expect(notes(out, 'warn')[0]).toContain('MP3 is a lossy format');
    expect(notes(out, 'warn')[0]).toContain('do not survive it');
    expect(notes(out).join('\n')).not.toContain('Scanned');
    const manual = await run(id3Mp3(), { mode: 'manual', planes: '0' });
    expect(notes(manual, 'warn')[0]).toContain('lossy format');
    const ogg = await run(oggVorbis('v', ['A=b']));
    expect(notes(ogg, 'warn')[0]).toContain('Ogg Vorbis is a lossy format');
  });

  it('FLAC is lossless but not decoded here', async () => {
    const flac = flacFile([
      { type: 0, body: flacStreamInfo(8000, 1, 16, 8000) },
      { type: 4, body: vorbisComment('v', ['COMMENT=FTF{flac_meta}']) },
    ]);
    const out = await run(flac);
    expect(notes(out, 'warn')[0]).toContain('FLAC is lossless');
    expect(notes(out, 'warn')[0]).toContain('does not decode FLAC');
    expect(resultToText(out)).toContain('FTF{flac_meta}');
  });

  it('a WAV in a codec without sample bits', async () => {
    const wav = makeWav({
      bits: 16,
      channels: 1,
      rate: 8000,
      data: new Uint8Array(100),
      trailing: ascii('FTF{tail_of_adpcm}'),
    });
    wav[20] = 0x11;
    const out = await run(wav);
    expect(notes(out, 'warn')[0]).toBe(
      'No sample bits to read: IMA ADPCM (0x0011). The low-bit scan needs PCM samples (WAV or AIFF).',
    );
    expect(files(out)[0]!.data).toEqual(ascii('FTF{tail_of_adpcm}'));
  });

  it('the best hit is a file: it comes out cut at the end of the file', async () => {
    const png = hiddenPng();
    const cover = makeWav({
      bits: 16,
      channels: 1,
      rate: 8000,
      data: intBytes(
        coverSamples({ frames: 8000, channels: 1, peak: 30000, rate: 8000, seed: 6 }),
        16,
      ),
    });
    const marked = embedLsb(
      cover,
      { planes: [0, 1], channel: null, bitOrder: 'msb', step: 1, offset: 0 },
      png,
    );
    const out = await run(marked);
    const best = byType(out, 'bytes')[0]!;
    expect(best.filename).toBe('audio-lsb.png');
    expect(best.value).toEqual(png);
  });

  it('a length-prefixed payload of any kind comes out at its exact length', async () => {
    const zip = hiddenZip();
    const cover = makeWav({
      bits: 24,
      channels: 2,
      rate: 8000,
      data: intBytes(
        coverSamples({ frames: 6000, channels: 2, peak: 8000000, rate: 8000, seed: 8 }),
        24,
      ),
    });
    const marked = embedLsb(
      cover,
      { planes: [0], channel: 1, bitOrder: 'lsb', step: 1, offset: 0 },
      withLength(zip, { little: true }),
    );
    const out = await run(marked);
    expect(byType(out, 'bytes')[0]!.value).toEqual(zip);
    expect(byType(out, 'bytes')[0]!.filename).toBe('audio-lsb.zip');
    expect(table(out, /LSB scan/).rows[0]![1]).toContain('32-bit LE length');
  });
});

describe('errors', () => {
  it('says what is wrong with the file, not just that it failed', async () => {
    await expect(run(new Uint8Array(0))).rejects.toThrow('The file is empty.');
    await expect(run(ascii('just some text, nothing like audio'))).rejects.toThrow(
      'This is not a WAV, AIFF, MP3, FLAC or Ogg file',
    );
    await expect(
      run(concatBytes(ascii('RIFF'), Uint8Array.of(8, 0, 0, 0), ascii('AVI LIST'))),
    ).rejects.toThrow('RIFF file but not a WAV');
    await expect(run(randomBytes(500, 1))).rejects.toThrow('not a WAV, AIFF, MP3, FLAC or Ogg');
  });

  it('refuses a file too big to be read whole, without reading it', async () => {
    const huge = {
      name: 'huge.wav',
      size: MAX_FILE + 1,
      blob: new Blob([]),
      read: () => Promise.reject(new Error('must not be read')),
    };
    await expect(Promise.resolve(tool.run(huge, defaults() as never))).rejects.toThrow(
      'too big for this tool',
    );
  });

  it('a WAV that stops before its audio does not crash', async () => {
    const header = makeWav({ bits: 16, channels: 1, rate: 8000, data: new Uint8Array(0) });
    const out = await run(header);
    expect(byType(out, 'kv')[0]!.entries.some(([, v]) => v.includes('PCM 16-bit'))).toBe(true);
    const cut = makeWav({ bits: 16, channels: 1, rate: 8000, data: randomBytes(10, 1) }).subarray(
      0,
      40,
    );
    await run(cut);
    const noData = makeWav({ bits: 16, channels: 1, rate: 8000, data: new Uint8Array(8) }).subarray(
      0,
      36,
    );
    expect(notes(await run(noData), 'warn')[0]).toContain('no audio data chunk');
  });
});

describe('triage', () => {
  const detect = (bytes: Uint8Array) => tool.detect!({ text: null, bytes });
  it('recognises the audio formats it reads, and a size field that is too small', () => {
    expect(detect(lsbWav())).toMatchObject({ score: 0.55 });
    expect(detect(chunkWav())).toMatchObject({ score: 0.8 });
    expect(detect(id3Mp3())).toMatchObject({ score: 0.45 });
    expect(detect(concatBytes(...Array.from({ length: 4 }, () => mp3Frame())))).toMatchObject({
      score: 0.45,
    });
    expect(detect(oggVorbis('v', []))).toMatchObject({ score: 0.45 });
    expect(detect(flacFile([{ type: 0, body: flacStreamInfo(8000, 1, 16, 1) }]))).toMatchObject({
      score: 0.45,
    });
    expect(
      detect(makeAiff({ bits: 16, channels: 1, rate: 8000, frames: 1, data: new Uint8Array(2) })),
    ).toMatchObject({ score: 0.55 });
  });
  it('is quiet about everything else', () => {
    expect(detect(ascii('hello world'))).toBeNull();
    expect(detect(randomBytes(2000, 1))).toBeNull();
    expect(detect(textPng('FTF{PNG_IN_WAV}', 1))).toBeNull();
    expect(detect(new Uint8Array(0))).toBeNull();
  });
});

describe('every message is worded', () => {
  const all: Uint8Array[] = [
    lsbWav(),
    pngWav(),
    chunkWav(),
    id3Mp3(),
    oggVorbis(
      'v',
      [
        'A=b',
        `METADATA_BLOCK_PICTURE=${toBase64(flacPicture('image/png', 'c', textPng('FTF{COVER}', 1)))}`,
      ],
      ascii('tail bytes'),
    ),
    flacFile(
      [
        { type: 0, body: flacStreamInfo(8000, 1, 16, 8000) },
        { type: 6, body: flacPicture('image/png', 'c', textPng('FTF{COVER}', 1)) },
        { type: 1, body: concatBytes(ascii('x'), new Uint8Array(9)) },
      ],
      Uint8Array.of(0xff, 0xf8, 0x69, 0x18, 0, 0, 0, 0),
    ),
    concatBytes(
      id3Tag(3, [id3Comm(3, 'c', '', 0)], { padding: ascii('hidden') }),
      ...Array.from({ length: 5 }, () => mp3Frame()),
      ascii('tail'),
      id3v1({ title: 't' }),
    ),
    makeAiff({
      bits: 16,
      channels: 2,
      rate: 44100,
      frames: 100,
      data: randomBytes(400, 1),
      extra: [{ id: 'APPL', body: ascii('data') }],
      trailing: ascii('tail'),
    }),
    makeWav({
      bits: 32,
      float: true,
      channels: 3,
      rate: 8000,
      data: randomBytes(3 * 4 * 100, 1),
      before: [{ id: 'JUNK', body: ascii('abcd') }],
    }),
  ];
  const optionSets: Options[] = [
    {},
    { mode: 'manual' },
    { mode: 'manual', channels: 'each', planes: '0-2', header: 'be' },
  ];

  const worded = async (bytes: Uint8Array) => {
    for (const options of optionSets) {
      const out = await run(bytes, options).catch((e: Error) => [
        { type: 'note', level: 'error', text: e.message } as Output,
      ]);
      const text = JSON.stringify(
        out.map((o) =>
          o.type === 'image' || o.type === 'picture' ? o.type : o.type === 'bytes' ? o.label : o,
        ),
        (_k, v) => (v instanceof Uint8Array ? undefined : v),
      );
      expect(text).not.toContain('tool.');
      expect(text).not.toMatch(
        /\{(count|where|offset|size|what|name|id|type|settings|format|bits|rate|channels|seconds)\}/,
      );
    }
  };

  it.each(all.map((b, i) => [i, b] as const))('file %i, in the three modes', async (_i, bytes) => {
    await worded(bytes);
  });

  afterAll(() => setLocale('en'));

  it.each(['fr', 'ru', 'zh', 'hi'] as const)('and in %s', async (locale) => {
    await setLocale(locale);
    for (const bytes of all) await worded(bytes);
    const out = await run(lsbWav());
    // the tool speaks the language: no English sentence of the tool is left
    expect(resultToText(out)).not.toContain('Best hit');
    expect(resultToText(out)).toContain('FTF{wav_lsb}');
    await setLocale('en');
  });
});

describe('big files', () => {
  it('a 24 MiB stereo WAV is read, scanned and plotted in a few seconds', async () => {
    const frames = 4_000_000;
    const data = new Uint8Array(frames * 4);
    const rand = prng(5);
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.floor(rand() * 60000) - 30000;
      data[i] = v & 0xff;
      data[i + 1] = (v >> 8) & 0xff;
      data[i + 2] = (v >> 3) & 0xff;
      data[i + 3] = (v >> 11) & 0xff;
    }
    const wav = embedLsb(
      makeWav({ bits: 16, channels: 2, rate: 44100, data }),
      { planes: [0], channel: 0, bitOrder: 'msb', step: 1, offset: 0 },
      withLength(ascii('FTF{big_file}')),
    );
    const t0 = Date.now();
    const out = await run(wav);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(latin1Decode(bytesBlock(out, /Best hit/))).toBe('FTF{big_file}');
    const image = byType(out, 'image')[0]!.image;
    expect(image.width).toBeLessThanOrEqual(1000);
    expect(isNoPcm(readPcm(wav, walkChunks(wav)!))).toBe(false);
  });
});
