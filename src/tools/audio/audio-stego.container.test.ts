import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, latin1Decode, toBase64, u32le } from '../../lib/bytes';
import {
  ascii,
  flacFile,
  flacPicture,
  flacStreamInfo,
  id3Apic,
  id3Comm,
  id3Frame,
  id3Geob,
  id3Priv,
  id3String,
  id3Tag,
  id3Text,
  id3v1,
  intBytes,
  makeAiff,
  makeWav,
  mp3Frame,
  oggOpus,
  oggPackets,
  oggPage,
  oggVorbis,
  randomBytes,
  riffChunk,
  textPng,
  u16,
  u32,
  utf8,
  vorbisComment,
  xingFrame,
} from './_audio-stego-fixtures';
import type { Analysis } from './_audio-stego-found';
import { analyzeMp3 } from './_audio-stego-mp3';
import { hasId3v2, parseId3v1, parseId3v2, skipId3v2 } from './_audio-stego-id3';
import { analyzeChunks } from './_audio-stego-riff';
import { readPcm, walkChunks } from './_audio-stego-pcm';
import {
  analyzeFlac,
  analyzeOgg,
  oggCrc,
  parsePictureBlock,
  parseVorbisComment,
} from './_audio-stego-xiph';

const wavInfo = (b: Uint8Array): Analysis => {
  const file = walkChunks(b)!;
  return analyzeChunks(b, file, readPcm(b, file));
};

const meta = (a: Analysis, name: string) => a.meta.find((m) => m.name === name)?.value;
const payloadOf = (a: Analysis, name: RegExp) => a.payloads.find((p) => name.test(p.name));
const notes = (a: Analysis, level?: string) =>
  a.notes.filter((n) => !level || n.level === level).map((n) => n.text);
const noRawKeys = (a: Analysis) => {
  const all = JSON.stringify([
    a.summary,
    a.rows,
    a.meta,
    a.notes,
    a.payloads.map((p) => [p.where, p.name]),
  ]);
  expect(all).not.toContain('tool.audio-stego.');
};

const audio = (frames = 100) =>
  intBytes(
    Array.from({ length: frames }, (_, i) => Math.round(Math.sin(i / 5) * 8000)),
    16,
  );

describe('WAV chunks', () => {
  const base = { bits: 16 as const, channels: 1, rate: 8000, data: audio() };

  it('a plain WAV has nothing to report', () => {
    const a = wavInfo(makeWav(base));
    expect(a.payloads).toEqual([]);
    expect(a.notes).toEqual([]);
    expect(a.rows.map((r) => r.name)).toEqual(['fmt', 'data']);
    expect(a.summary.map(([, v]) => v).join(' ')).toContain('PCM 16-bit, mono, 8000 Hz');
    noRawKeys(a);
  });

  it('an unknown chunk is a payload, with its type', () => {
    const png = textPng('FTF{PNG_IN_WAV}', 1);
    const a = wavInfo(
      makeWav({
        ...base,
        before: [
          { id: 'ftfx', body: ascii('FTF{extra_chunk}') },
          { id: 'zzzz', body: png },
        ],
      }),
    );
    expect(payloadOf(a, /ftfx/)!.data).toEqual(ascii('FTF{extra_chunk}'));
    expect(payloadOf(a, /zzzz/)!.data).toEqual(png);
    expect(a.rows.find((r) => r.name === 'ftfx')!.what).toContain('hidden data?');
    expect(notes(a, 'warn').some((n) => n.includes('"ftfx"'))).toBe(true);
    noRawKeys(a);
  });

  it('data after the data chunk and after the last chunk, and the RIFF size', () => {
    const tail = ascii('PK\u0003\u0004 hidden after the audio');
    const a = wavInfo(makeWav({ ...base, trailing: tail }));
    expect(payloadOf(a, /after-data/)!.data).toEqual(tail);
    expect(notes(a).join('\n')).toContain(
      `but it has ${a.rows.at(-1)!.offset + tail.length} bytes: ${tail.length} bytes lie beyond the announced end`,
    );
    // a chunk after the data: not a payload unless it is unknown; RIFF size shorter than the file
    const after = wavInfo(
      makeWav({ ...base, after: [{ id: 'ftfy', body: ascii('late chunk') }], riffSize: 'audio' }),
    );
    expect(payloadOf(after, /ftfy/)).toBeDefined();
    expect(after.rows.find((r) => r.name === 'ftfy')!.what).toContain(
      'lies after the end announced',
    );
    expect(notes(after).join('\n')).toContain('RIFF size field says');
  });

  it('a RIFF size larger than the file (cut short, or streamed)', () => {
    const wav = makeWav({ ...base, riffSize: 5000 });
    expect(notes(wavInfo(wav)).join('\n')).toContain(
      'RIFF size field says 5008 bytes but the file has',
    );
  });

  it('a data chunk that announces more than the file holds', () => {
    const wav = makeWav(base);
    const cut = wav.subarray(0, wav.length - 31);
    const a = wavInfo(cut);
    expect(notes(a).join('\n')).toContain(
      'The audio chunk announces 200 bytes but only 169 are in the file',
    );
  });

  it('bytes that do not make a whole sample frame at the end of the audio', () => {
    const a = wavInfo(
      makeWav({
        ...base,
        bits: 16,
        channels: 2,
        data: concatBytes(audio(40), Uint8Array.of(0x46, 0x54, 0x46)),
      }),
    );
    expect(notes(a).join('\n')).toContain(
      '3 bytes that do not make a whole sample frame (4 bytes)',
    );
    expect(payloadOf(a, /partial-frame/)!.data).toEqual(ascii('FTF'));
    // zero bytes there are padding, not a payload
    const zero = wavInfo(
      makeWav({ ...base, bits: 16, channels: 2, data: concatBytes(audio(40), new Uint8Array(3)) }),
    );
    expect(zero.payloads).toEqual([]);
  });

  it('padding chunks: empty ones are fine, full ones are payloads', () => {
    const clean = wavInfo(
      makeWav({
        ...base,
        before: [
          { id: 'JUNK', body: new Uint8Array(28) },
          { id: 'PAD ', body: new Uint8Array(4) },
        ],
      }),
    );
    expect(clean.payloads).toEqual([]);
    const dirty = wavInfo(
      makeWav({ ...base, before: [{ id: 'JUNK', body: ascii('FTF{in_junk_chunk}\0\0') }] }),
    );
    expect(payloadOf(dirty, /JUNK/)!.data).toEqual(ascii('FTF{in_junk_chunk}\0\0'));
  });

  it('LIST/INFO fields and the bext chunk are read', () => {
    const info = concatBytes(
      ascii('INFO'),
      riffChunk('INAM', ascii('Night train\0')),
      riffChunk('ICMT', ascii('FTF{info_comment}\0')),
      riffChunk('ISFT', ascii('Find The Flag\0')),
    );
    const bext = new Uint8Array(602 + 20);
    bext.set(ascii('A description with FTF{in_bext}'), 0);
    bext.set(ascii('The originator'), 256);
    bext.set(ascii('A=PCM,F=8000'), 602);
    const a = wavInfo(
      makeWav({
        ...base,
        before: [
          { id: 'LIST', body: info },
          { id: 'bext', body: bext },
        ],
      }),
    );
    expect(meta(a, 'INAM')).toBe('Night train');
    expect(meta(a, 'ICMT')).toBe('FTF{info_comment}');
    expect(a.meta.find((m) => m.source === 'LIST/INFO' && m.name === 'ISFT')?.value).toBe(
      'Find The Flag',
    );
    expect(meta(a, 'description')).toContain('FTF{in_bext}');
    expect(meta(a, 'originator')).toBe('The originator');
    expect(meta(a, 'coding history')).toBe('A=PCM,F=8000');
    expect(a.payloads).toEqual([]);
    expect(a.rows.find((r) => r.name === 'LIST')!.what).toContain('INFO');
    noRawKeys(a);
  });

  it('data after the INFO entries inside a LIST chunk', () => {
    const info = concatBytes(
      ascii('INFO'),
      riffChunk('INAM', ascii('Title\0')),
      ascii('hidden bytes in the list'),
    );
    const a = wavInfo(makeWav({ ...base, before: [{ id: 'LIST', body: info }] }));
    expect(payloadOf(a, /list-extra/)!.data).toEqual(ascii('hidden bytes in the list'));
  });

  it('an ID3 tag in an "id3 " chunk', () => {
    const tag = id3Tag(3, [
      id3Text(3, 'TIT2', 'In a chunk', 0),
      id3Comm(3, 'FTF{id3_in_wav}', '', 0),
    ]);
    const a = wavInfo(makeWav({ ...base, before: [{ id: 'id3 ', body: tag }] }));
    expect(meta(a, 'TIT2')).toBe('In a chunk');
    expect(meta(a, 'COMM(eng)')).toBe('FTF{id3_in_wav}');
    expect(a.payloads).toEqual([]);
  });

  it('a second data chunk, and a pad byte that is not zero', () => {
    const second = wavInfo(
      makeWav({ ...base, after: [{ id: 'data', body: ascii('the other audio') }] }),
    );
    expect(notes(second).join('\n')).toContain('A second audio chunk (data)');
    expect(payloadOf(second, /data-2/)).toBeDefined();
    const odd = makeWav({ ...base, before: [{ id: 'ftfx', body: ascii('abc') }] });
    odd[36 + 8 + 3] = 0x5a; // the pad byte after the 3-byte chunk
    const a = wavInfo(odd);
    expect(notes(a).join('\n')).toContain('The pad byte after chunk "ftfx" is 0x5a');
  });

  it('a WAV in a codec without a sample layout still gets its container checks', () => {
    const wav = makeWav({ ...base, trailing: ascii('trailing words here') });
    wav[20] = 0x11;
    const a = wavInfo(wav);
    expect(a.summary.map(([, v]) => v).join(' ')).toContain('IMA ADPCM (0x0011)');
    expect(payloadOf(a, /after-data/)).toBeDefined();
  });
});

describe('AIFF chunks', () => {
  it('reads text chunks and comments, finds an APPL chunk and trailing data', () => {
    const comt = concatBytes(
      u16(1, true),
      u32(0, true),
      u16(0, true),
      u16(15, true),
      ascii('FTF{aiff_comt}\0'),
    );
    const aiff = makeAiff({
      bits: 16,
      channels: 1,
      rate: 8000,
      frames: 20,
      data: audio(20),
      extra: [
        { id: 'NAME', body: ascii('A name') },
        { id: 'AUTH', body: ascii('An author') },
        { id: 'ANNO', body: ascii('FTF{aiff_anno}') },
        { id: 'COMT', body: comt },
        { id: 'APPL', body: ascii('stoc hidden application data') },
      ],
      trailing: ascii('after the FORM'),
    });
    const file = walkChunks(aiff)!;
    const a = analyzeChunks(aiff, file, readPcm(aiff, file));
    expect(a.format).toBe('AIFF');
    expect(meta(a, 'NAME')).toBe('A name');
    expect(meta(a, 'ANNO')).toBe('FTF{aiff_anno}');
    expect(a.meta.find((m) => m.source === 'AIFF COMT')?.value).toBe('FTF{aiff_comt}');
    expect(payloadOf(a, /APPL/)!.data).toEqual(ascii('stoc hidden application data'));
    expect(payloadOf(a, /trailing/)!.data).toEqual(ascii('after the FORM'));
    expect(notes(a).join('\n')).toContain('FORM size field says the file ends at byte');
    noRawKeys(a);
  });

  it('bytes the SSND chunk skips between its header and the samples', () => {
    const aiff = makeAiff({
      bits: 16,
      channels: 1,
      rate: 8000,
      frames: 4,
      data: concatBytes(ascii('FTF{ssnd_off}'), intBytes([1, 2, 3, 4], 16, true)),
    });
    const at = latin1Decode(aiff).indexOf('SSND');
    aiff.set(u32(13, true), at + 8); // the offset field
    const file = walkChunks(aiff)!;
    const pcm = readPcm(aiff, file);
    const a = analyzeChunks(aiff, file, pcm);
    expect(payloadOf(a, /ssnd-offset/)!.data).toEqual(ascii('FTF{ssnd_off}'));
  });
});

describe('ID3v2', () => {
  const png = textPng('FTF{COVER}', 1);

  it('v2.3: text in Latin-1, UTF-16 and UTF-8, TXXX, COMM, APIC, GEOB, PRIV', () => {
    const tag = id3Tag(3, [
      id3Text(3, 'TIT2', 'Plain title', 0),
      id3Text(3, 'TPE1', 'Zoë — 日本', 1),
      id3Text(3, 'TALB', 'Álbum ünïcode', 3),
      id3Frame(
        3,
        'TXXX',
        concatBytes(Uint8Array.of(0), id3String('secret', 0, true), id3String('FTF{in_txxx}', 0)),
      ),
      id3Comm(3, 'FTF{id3_comment}', 'short', 0),
      id3Apic(3, 'image/png', 3, 'front', png),
      id3Geob(3, 'text/plain', 'note.txt', 'a file', ascii('FTF{in_geob}')),
      id3Priv(3, 'com.example', ascii('FTF{in_priv}')),
      id3Frame(
        3,
        'WXXX',
        concatBytes(Uint8Array.of(0), id3String('home', 0, true), ascii('https://example.org/x')),
      ),
    ]);
    const a = parseId3v2(tag, 0)!;
    expect(meta(a, 'TIT2')).toBe('Plain title');
    expect(meta(a, 'TPE1')).toBe('Zoë — 日本');
    expect(meta(a, 'TALB')).toBe('Álbum ünïcode');
    expect(meta(a, 'TXXX:secret')).toBe('FTF{in_txxx}');
    expect(meta(a, 'COMM(eng):short')).toBe('FTF{id3_comment}');
    expect(meta(a, 'WXXX:home')).toBe('https://example.org/x');
    expect(meta(a, 'APIC')).toContain('image/png · front cover · front');
    expect(a.payloads.find((p) => p.name.startsWith('id3-cover'))!.data).toEqual(png);
    expect(a.payloads.find((p) => p.name === 'note.txt')!.data).toEqual(ascii('FTF{in_geob}'));
    expect(a.payloads.find((p) => p.name.startsWith('id3-priv'))!.data).toEqual(
      ascii('FTF{in_priv}'),
    );
    expect(a.rows[0]).toMatchObject({ offset: 0, name: 'ID3v2.3', size: tag.length });
    noRawKeys(a);
  });

  it('v2.4 (synchsafe sizes, UTF-8) and v2.2 (3-byte ids)', () => {
    const v4 = parseId3v2(
      id3Tag(
        4,
        [
          id3Text(4, 'TIT2', 'Titre', 3),
          id3Comm(4, 'FTF{v24_comment}', '', 3),
          id3Apic(4, 'image/png', 4, '', png),
        ],
        { padding: 20 },
      ),
      0,
    )!;
    expect(meta(v4, 'TIT2')).toBe('Titre');
    expect(meta(v4, 'COMM(eng)')).toBe('FTF{v24_comment}');
    expect(meta(v4, 'APIC')).toContain('back cover');
    expect(v4.payloads[0]!.data).toEqual(png);
    expect(v4.rows[0]!.what).toContain('20 bytes of padding');
    const v2 = parseId3v2(
      id3Tag(2, [
        id3Text(2, 'TT2', 'Old title', 0),
        id3Comm(2, 'FTF{v22_comment}', '', 0),
        id3Apic(2, 'image/png', 3, '', png),
      ]),
      0,
    )!;
    expect(meta(v2, 'TT2')).toBe('Old title');
    expect(meta(v2, 'COM(eng)')).toBe('FTF{v22_comment}');
    expect(v2.payloads[0]!.data).toEqual(png);
    expect(v2.payloads[0]!.name).toBe('id3-cover.png');
  });

  it('reads a tag written with unsynchronisation', () => {
    const body = ascii('FTF{needs_unsync}');
    const frames = [
      id3Frame(
        3,
        'PRIV',
        concatBytes(ascii('owner\0'), Uint8Array.of(0xff, 0xfb, 0xff, 0x00, 0xff), body),
      ),
    ];
    const a = parseId3v2(id3Tag(3, frames, { unsync: true }), 0)!;
    expect(a.payloads[0]!.data).toEqual(
      concatBytes(Uint8Array.of(0xff, 0xfb, 0xff, 0x00, 0xff), body),
    );
  });

  it('padding: zeros are fine, anything else is a payload; frames outside the standard are payloads', () => {
    const clean = parseId3v2(id3Tag(3, [id3Text(3, 'TIT2', 'x', 0)], { padding: 40 }), 0)!;
    expect(clean.payloads).toEqual([]);
    expect(clean.notes).toEqual([]);
    const hidden = concatBytes(
      new Uint8Array(6),
      ascii('FTF{hidden_in_padding}'),
      new Uint8Array(4),
    );
    const dirty = parseId3v2(id3Tag(3, [id3Text(3, 'TIT2', 'x', 0)], { padding: hidden }), 0)!;
    expect(dirty.payloads[0]!.data).toEqual(hidden);
    expect(
      dirty.notes.some((n) => n.level === 'warn' && n.text.includes('padding of the ID3v2.3 tag')),
    ).toBe(true);
    const custom = parseId3v2(id3Tag(3, [id3Frame(3, 'ZZZZ', ascii('FTF{custom_frame}'))]), 0)!;
    expect(custom.payloads[0]!.data).toEqual(ascii('FTF{custom_frame}'));
    expect(custom.payloads[0]!.where).toContain('non-standard');
  });

  it('a damaged tag is read as far as it goes, with a note', () => {
    const tag = id3Tag(3, [id3Text(3, 'TIT2', 'fine', 0), id3Frame(3, 'TALB', ascii('abcdefgh'))]);
    const cut = tag.slice();
    cut.set(u32(5000, true), 10 + 15 + 4); // the second frame announces 5000 bytes
    const a = parseId3v2(cut.subarray(0, cut.length), 0)!;
    expect(meta(a, 'TIT2')).toBe('fine');
    expect(a.notes[0]!.text).toContain('announces 5000 bytes');
    const bad = id3Tag(3, [id3Text(3, 'TIT2', 'fine', 0), ascii('??xx\0\0\0\0\0\0')]);
    expect(parseId3v2(bad, 0)!.notes[0]!.text).toContain('is not valid');
  });

  it('knows where tags are and where they end', () => {
    const tag = id3Tag(3, [id3Text(3, 'TIT2', 'a', 0)]);
    const file = concatBytes(tag, tag, ascii('after'));
    expect(hasId3v2(file, 0)).toBe(true);
    expect(skipId3v2(file)).toBe(tag.length * 2);
    expect(hasId3v2(ascii('ID3 plain text'), 0)).toBe(false);
    expect(skipId3v2(ascii('no tag'))).toBe(0);
  });

  it('ID3v1, v1.1 and the TAG+ extension', () => {
    const v1 = parseId3v1(
      id3v1({
        title: 'Song',
        artist: 'Band',
        album: 'Disc',
        year: '1999',
        comment: 'FTF{v1_comment}',
        genre: 17,
      }),
      0,
    )!;
    expect(meta(v1, 'title')).toBe('Song');
    expect(meta(v1, 'comment')).toBe('FTF{v1_comment}');
    expect(meta(v1, 'genre')).toBe('Rock (17)');
    expect(v1.rows[0]!.name).toBe('ID3v1');
    const v11 = parseId3v1(id3v1({ title: 'Song', comment: 'a comment', track: 7 }), 0)!;
    expect(meta(v11, 'track')).toBe('7');
    expect(v11.rows[0]!.name).toBe('ID3v1.1');
    const plus = new Uint8Array(227);
    plus.set(ascii('TAG+'), 0);
    plus.set(ascii('A long title that does not fit in thirty bytes'), 4);
    const both = concatBytes(plus, id3v1({ title: 'A long title that does' }));
    const a = parseId3v1(both, 227)!;
    expect(meta(a, 'title (TAG+)')).toBe('A long title that does not fit in thirty bytes');
    expect(a.rows[0]).toMatchObject({ offset: 0, name: 'ID3v1 + TAG+', size: 355 });
    expect(parseId3v1(ascii('not a tag'), 0)).toBeNull();
  });
});

describe('MP3 frames', () => {
  const frames = (n: number) => Array.from({ length: n }, () => mp3Frame());

  it('a clean file: frames walked, no payload, nothing in the notes', () => {
    const a = analyzeMp3(concatBytes(...frames(10)));
    expect(a.payloads).toEqual([]);
    expect(a.notes).toEqual([]);
    expect(a.summary.map(([, v]) => v)).toEqual([
      'MP3 · MPEG-1 Layer III (MP3)'.replace('MP3 · ', ''),
      '44100 Hz, stereo, 128 kbit/s',
      '10 frames, 0.26 s',
    ]);
    expect(a.rows.map((r) => [r.name, r.offset, r.size])).toEqual([['MPEG audio frames', 0, 4170]]);
    noRawKeys(a);
  });

  it('variable bitrate, padding bit and a mono file', () => {
    const a = analyzeMp3(
      concatBytes(
        mp3Frame({ kbps: 64 }),
        mp3Frame({ kbps: 128, padding: true }),
        mp3Frame({ kbps: 192 }),
        mp3Frame({ kbps: 64 }),
        mp3Frame({ kbps: 128 }),
      ),
    );
    expect(a.summary[1]![1]).toBe('44100 Hz, stereo, 64–192 (VBR) kbit/s');
    expect(a.notes).toEqual([]);
    const mono = analyzeMp3(
      concatBytes(...Array.from({ length: 5 }, () => mp3Frame({ mono: true }))),
    );
    expect(mono.summary[1]![1]).toContain('mono');
  });

  it('junk between the tag and the first frame, and zero padding there', () => {
    const tag = id3Tag(3, [id3Text(3, 'TIT2', 'x', 0)]);
    const junk = ascii('FTF{before_first_frame}');
    const a = analyzeMp3(concatBytes(tag, junk, ...frames(6)));
    expect(a.payloads[0]!.data).toEqual(junk);
    expect(a.payloads[0]!.where).toBe('before the first frame');
    expect(a.rows.map((r) => r.name)).toContain('Before the first frame');
    const zeros = analyzeMp3(concatBytes(tag, new Uint8Array(33), ...frames(6)));
    expect(zeros.payloads).toEqual([]);
    expect(zeros.notes[0]!.level).toBe('info');
  });

  it('data between two frames', () => {
    const hidden = ascii('FTF{between_the_frames}');
    const file = concatBytes(...frames(5), hidden, ...frames(5));
    const a = analyzeMp3(file);
    expect(a.payloads).toHaveLength(1);
    expect(a.payloads[0]!.data).toEqual(hidden);
    expect(a.payloads[0]!.offset).toBe(5 * 417);
    expect(a.rows.find((r) => r.name === 'MPEG audio frames')!.what).toBe(
      '10 frames, 1 gaps between frames',
    );
    expect(a.summary[2]![1]).toBe('10 frames, 0.26 s');
    // data that itself holds 0xFF bytes and what looks like a header does not fool the walk
    const stray = Uint8Array.of(0xff, 0xfb, 0xf0, 0x00, 1, 2, 3, 4, 5, 0xff, 0xff);
    const t = analyzeMp3(concatBytes(...frames(4), stray, ...frames(4)));
    expect(t.payloads[0]!.data).toEqual(stray);
    expect(t.summary[2]![1]).toBe('8 frames, 0.21 s');
  });

  it('data after the last frame, before an ID3v1 tag', () => {
    const hidden = ascii('FTF{after_the_last_frame}');
    const v1 = id3v1({ title: 'T', comment: 'c' });
    const a = analyzeMp3(concatBytes(...frames(6), hidden, v1));
    expect(a.payloads[0]!.data).toEqual(hidden);
    expect(a.payloads[0]!.where).toBe('after the last frame');
    expect(meta(a, 'title')).toBe('T');
    expect(a.rows.map((r) => r.name)).toEqual([
      'MPEG audio frames',
      'After the last frame',
      'ID3v1',
    ]);
    // a second ID3v2 tag glued after the frames is read, not reported as junk
    const late = id3Tag(3, [id3Text(3, 'TIT2', 'Late tag', 0)]);
    const b = analyzeMp3(concatBytes(...frames(6), late));
    expect(meta(b, 'TIT2')).toBe('Late tag');
    expect(b.payloads).toEqual([]);
    // zeros after the last frame are padding
    const z = analyzeMp3(concatBytes(...frames(6), new Uint8Array(77)));
    expect(z.payloads).toEqual([]);
    expect(z.notes[0]!.text).toContain('Only zero bytes after the last frame');
  });

  it('a file cut inside its last frame', () => {
    const file = concatBytes(...frames(6));
    const a = analyzeMp3(file.subarray(0, file.length - 100));
    expect(a.notes.map((n) => n.text)).toEqual([
      'The last frame is cut short by 100 bytes (the file ends inside it).',
    ]);
    expect(a.payloads).toEqual([]);
  });

  it('Xing / Info header, the LAME encoder string, and a frame count that does not match', () => {
    const file = concatBytes(
      xingFrame({ frames: 8, bytes: 9 * 417, vbr: true, encoder: 'LAME3.99r' }),
      ...frames(8),
    );
    const a = analyzeMp3(file);
    expect(a.meta.map((m) => [m.name, m.value])).toEqual([
      ['Header', 'Xing (variable bitrate)'],
      ['Frames', '8'],
      ['Bytes', '3753'],
      ['Encoder', 'LAME3.99r'],
    ]);
    expect(a.notes).toEqual([]);
    const cut = analyzeMp3(concatBytes(xingFrame({ frames: 50, bytes: 51 * 417 }), ...frames(8)));
    expect(cut.notes[0]!.text).toBe(
      'The Xing / Info header announces 50 frames but 8 were found: audio was cut or added after the file was encoded.',
    );
    expect(
      analyzeMp3(
        concatBytes(
          xingFrame({ frames: 8, bytes: 0, mono: true }),
          ...frames(8).map(() => mp3Frame({ mono: true })),
        ),
      ).meta.length,
    ).toBeGreaterThan(0);
  });

  it('nothing that looks like MPEG audio', () => {
    const a = analyzeMp3(randomBytes(3000, 4));
    expect(a.notes[0]!.text).toContain('No MPEG audio frames found');
    expect(
      analyzeMp3(concatBytes(id3Tag(3, [id3Text(3, 'TIT2', 'only a tag', 0)]))).notes[0]!.level,
    ).toBe('warn');
  });
});

describe('FLAC', () => {
  const png = textPng('FTF{COVER}', 1);

  it('metadata blocks: STREAMINFO, VORBIS_COMMENT, PICTURE, APPLICATION, PADDING', () => {
    const file = flacFile(
      [
        { type: 0, body: flacStreamInfo(44100, 2, 16, 441000) },
        {
          type: 4,
          body: vorbisComment('reference libFLAC', [
            'TITLE=Song',
            'COMMENT=FTF{flac_comment}',
            'ARTIST=Band',
          ]),
        },
        { type: 6, body: flacPicture('image/png', 'cover', png) },
        { type: 2, body: concatBytes(ascii('ftfa'), ascii('FTF{flac_app}')) },
        { type: 1, body: new Uint8Array(32) },
      ],
      Uint8Array.of(0xff, 0xf8, 0x69, 0x18, 0, 0, 0, 0),
    );
    const a = analyzeFlac(file);
    expect(a.summary[0]![1]).toBe('FLAC, 44100 Hz, 16-bit, channels: 2, 10.00 s');
    expect(meta(a, 'COMMENT')).toBe('FTF{flac_comment}');
    expect(meta(a, 'vendor')).toBe('reference libFLAC');
    expect(a.payloads.find((p) => p.name.startsWith('flac-picture'))!.data).toEqual(png);
    expect(a.payloads.find((p) => p.name.includes('application'))!.data).toEqual(
      ascii('FTF{flac_app}'),
    );
    expect(a.payloads).toHaveLength(2);
    expect(a.rows.map((r) => r.name)).toEqual([
      'STREAMINFO',
      'VORBIS_COMMENT',
      'PICTURE',
      'APPLICATION',
      'PADDING',
      'Audio frames',
    ]);
    noRawKeys(a);
  });

  it('padding that is not empty, a reserved block, extra bytes after the comments, junk before the audio', () => {
    const dirty = concatBytes(new Uint8Array(10), ascii('FTF{in_flac_padding}'), new Uint8Array(6));
    const comment = concatBytes(vorbisComment('v', ['A=b']), ascii('FTF{after_comments}'));
    const file = flacFile(
      [
        { type: 0, body: flacStreamInfo(8000, 1, 16, 8000) },
        { type: 4, body: comment },
        { type: 1, body: dirty },
        { type: 40, body: ascii('FTF{reserved_block}') },
      ],
      concatBytes(
        ascii('FTF{junk_before_audio}'),
        Uint8Array.of(0xff, 0xf8, 0x69, 0x18, 0, 0, 0, 0),
      ),
    );
    const a = analyzeFlac(file);
    const wheres = a.payloads.map((p) => [p.where, latin1Decode(p.data)]);
    expect(wheres).toContainEqual(['in the FLAC padding', latin1Decode(dirty)]);
    expect(wheres).toContainEqual([
      'after the comments in the comment header',
      'FTF{after_comments}',
    ]);
    expect(wheres).toContainEqual([
      'in a reserved FLAC metadata block (type 40)',
      'FTF{reserved_block}',
    ]);
    expect(wheres).toContainEqual([
      'between the metadata and the first FLAC frame',
      'FTF{junk_before_audio}',
    ]);
  });

  it('an ID3v2 tag before the marker, and files that are not FLAC or are cut', () => {
    const tag = id3Tag(3, [id3Text(3, 'TIT2', 'Tagged flac', 0)]);
    const a = analyzeFlac(
      concatBytes(tag, flacFile([{ type: 0, body: flacStreamInfo(8000, 1, 16, 8000) }])),
    );
    expect(meta(a, 'TIT2')).toBe('Tagged flac');
    expect(a.notes.map((n) => n.text)).toEqual([
      'The file ends after the metadata: there are no audio frames.',
    ]);
    expect(analyzeFlac(ascii('nothing here')).notes[0]!.text).toContain('No "fLaC" marker');
    const cut = flacFile([
      { type: 0, body: flacStreamInfo(8000, 1, 16, 8000) },
      { type: 4, body: vorbisComment('v', []) },
    ]).slice(0, 50);
    expect(analyzeFlac(cut).notes.some((n) => n.text.includes('ends inside the metadata'))).toBe(
      true,
    );
  });

  it('parsePictureBlock and parseVorbisComment on their own', () => {
    expect(parsePictureBlock(flacPicture('image/png', 'd', png, 4))).toMatchObject({
      type: 4,
      mime: 'image/png',
      desc: 'd',
    });
    expect(parsePictureBlock(flacPicture('image/png', 'd', png))!.data).toEqual(png);
    expect(parsePictureBlock(new Uint8Array(40))).toBeNull();
    const vc = parseVorbisComment(vorbisComment('vendor', ['A=1', 'B=2']), 0)!;
    expect(vc).toMatchObject({ vendor: 'vendor', comments: ['A=1', 'B=2'] });
    expect(parseVorbisComment(new Uint8Array(4), 0)).toBeNull();
    expect(
      parseVorbisComment(concatBytes(u32(0), u32(2), u32(900), ascii('x')), 0)!.comments,
    ).toEqual([]);
  });
});

describe('Ogg', () => {
  const png = textPng('FTF{COVER}', 1);

  it('Vorbis: codec, comments, pages', () => {
    const a = analyzeOgg(
      oggVorbis('Xiph.Org libVorbis', ['TITLE=Song', 'COMMENT=FTF{ogg_comment}']),
    );
    expect(a.summary.map(([, v]) => v)).toEqual([
      'Vorbis, 44100 Hz, channels: 2',
      '3 (streams: 1), 0.09 s',
    ]);
    expect(a.format).toBe('Ogg Vorbis');
    expect(a.lossless).toBe(false);
    expect(meta(a, 'COMMENT')).toBe('FTF{ogg_comment}');
    expect(a.meta[0]).toMatchObject({
      source: 'Vorbis comment',
      name: 'vendor',
      value: 'Xiph.Org libVorbis',
    });
    expect(a.payloads).toEqual([]);
    expect(a.notes).toEqual([]);
    noRawKeys(a);
  });

  it('Opus tags', () => {
    const a = analyzeOgg(oggOpus('libopus 1.3', ['ARTIST=Band', 'NOTE=FTF{opus_note}']));
    expect(a.summary[0]![1]).toBe('Opus, 44100 Hz, channels: 2');
    expect(meta(a, 'NOTE')).toBe('FTF{opus_note}');
    expect(a.meta[0]!.source).toBe('Opus comment');
    expect(a.notes).toEqual([]);
  });

  it('a cover in METADATA_BLOCK_PICTURE, even when the comment spans many pages', () => {
    const big = concatBytes(png, randomBytes(70_000, 12));
    const block = toBase64(flacPicture('image/png', 'art', big));
    const a = analyzeOgg(oggVorbis('v', ['TITLE=x', `METADATA_BLOCK_PICTURE=${block}`]));
    expect(a.payloads).toHaveLength(1);
    expect(a.payloads[0]!.data).toEqual(big);
    expect(a.payloads[0]!.name).toBe('cover.png');
    expect(meta(a, 'METADATA_BLOCK_PICTURE')).toContain('image/png');
    expect(a.notes).toEqual([]);
    const count = Number(/^(\d+) \(/.exec(a.summary[1]![1])![1]);
    expect(count).toBeGreaterThanOrEqual(4); // the picture does not fit one page
  });

  it('data after the comments in the comment packet', () => {
    const id = oggVorbis('v', ['A=b']);
    // rebuild the comment packet with extra bytes after the framing bit
    const comment = concatBytes(
      Uint8Array.of(3),
      ascii('vorbis'),
      vorbisComment('v', ['A=b'], true),
      ascii('FTF{extra_in_packet}'),
    );
    const setup = concatBytes(Uint8Array.of(5), ascii('vorbis'), new Uint8Array(20));
    const head = oggVorbis('v', []).subarray(0, 58); // the first page
    const pages = oggPackets({ serial: 7, seq: 1, packets: [comment, setup] });
    const file = concatBytes(
      head.subarray(0, head.length),
      pages.bytes,
      oggPage({ serial: 7, seq: pages.next, packets: [new Uint8Array(10)], flags: 4 }),
    );
    const a = analyzeOgg(file);
    expect(a.payloads[0]!.data).toEqual(ascii('FTF{extra_in_packet}'));
    expect(a.payloads[0]!.where).toBe('after the comments in the comment header');
    expect(id.length).toBeGreaterThan(0);
  });

  it('data between two pages and after the last one', () => {
    const clean = oggVorbis('v', ['A=b']);
    const first = 58; // the identification page: 27 + 1 + 30 bytes
    const gap = ascii('FTF{between_pages}');
    const between = concatBytes(clean.subarray(0, first), gap, clean.subarray(first));
    const a = analyzeOgg(between);
    expect(a.payloads).toHaveLength(1);
    expect(a.payloads[0]!.data).toEqual(gap);
    expect(a.payloads[0]!.where).toBe('between two Ogg pages');
    const tail = ascii('FTF{after_last_page}');
    const b = analyzeOgg(concatBytes(clean, tail));
    expect(b.payloads[0]!.data).toEqual(tail);
    expect(b.payloads[0]!.where).toBe('after the last Ogg page');
    // a tail shorter than a page header is found too
    expect(analyzeOgg(concatBytes(clean, ascii('abc'))).payloads[0]!.data).toEqual(ascii('abc'));
  });

  it('a page edited after it was written has a wrong checksum', () => {
    const file = oggVorbis('vendor', ['TITLE=original title']).slice();
    const at = latin1Decode(file).indexOf('original');
    file.set(ascii('modified'), at);
    const a = analyzeOgg(file);
    expect(a.notes[0]!.text).toContain('1 pages have a wrong checksum');
    expect(meta(a, 'TITLE')).toBe('modified title');
  });

  it('computes the Ogg checksum of a page', () => {
    // The first page of a stream written by libvorbis (through ffmpeg): the checksum libogg
    // stored must be the one computed here.
    const page = fromHex(
      '4f67675300020000000000000000435ca8e50000000013f74206011e01766f726269730000000001401f00000000000080570000000000009901',
    );
    expect(page).toHaveLength(58);
    expect(oggCrc(page)).toBe(u32le(page, 22));
    // plain CRC-32, polynomial 0x04C11DB7, not reflected, initial value 0, no final xor
    expect(oggCrc(ascii('123456789'))).toBe(0x89a1897f);
  });

  it('not an Ogg file', () => {
    expect(
      analyzeOgg(ascii('OggS but not really an ogg file at all, just text')).notes[0]!.text,
    ).toBe('No valid Ogg page found.');
    expect(utf8('x').length + u16(1).length).toBe(3);
  });
});
