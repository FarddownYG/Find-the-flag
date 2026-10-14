/**
 * Regression tests for the cases independent reviewers ran against the image analyzer. Every
 * input is built here from the synthetic builders: no real photo, position or challenge.
 */
import { createHash } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildFlagRegex, selectFlags } from '../../core/flags';
import { resultToText } from '../../core/result-text';
import type { FileInput, Output, RgbaImage } from '../../core/types';
import { concatBytes, fromBase64, latin1Encode, utf8Decode, utf8Encode } from '../../lib/bytes';
import { jpegDcLuma } from './_image-analyzer-dc';
import {
  app13Iptc,
  app1Exif,
  app1Xmp,
  app2Icc,
  ascii,
  bytes,
  com,
  comment,
  draw,
  gpsDms,
  iccProfile,
  iTXt,
  jpegOf,
  jpegWith,
  picture,
  PILLOW_JPEGS,
  PILLOW_SCENE,
  pngChunk,
  pngOf,
  pngWith,
  rational,
  segment,
  short,
  tEXt,
  tiff,
  undef,
  utf16,
  webpWithExif,
  xmpPacket,
  zTXt,
  type Entry,
} from './_image-analyzer-fixtures';
import { compareThumbnail, decodeJpeg, decodeMain } from './_image-analyzer-thumb';
import tool from './image-analyzer';

// ---------------------------------------------------------------- helpers

interface Result {
  out: Output[];
  findings: Map<string, string>;
  rows: string[][];
  text: string;
  warnings: string[];
  maps: Extract<Output, { type: 'map' }>[];
  kv: (label: string) => Map<string, string>;
  file: (name: string) => Uint8Array;
}

async function analyze(
  input: Uint8Array,
  opts: { compare?: FileInput | null; minLength?: number; name?: string } = {},
): Promise<Result> {
  const out = (await tool.run(
    { bytes: input, name: opts.name ?? 'probe.jpg' },
    { compare: opts.compare ?? null, minLength: opts.minLength ?? 6 },
  )) as Output[];
  const kv = (label: string) =>
    new Map(
      out.find((o) => o.type === 'kv' && o.label === label)?.type === 'kv'
        ? (out.find((o) => o.type === 'kv' && o.label === label) as Extract<Output, { type: 'kv' }>)
            .entries
        : [],
    );
  const table = out.find((o) => o.type === 'table' && o.label === 'All metadata');
  const files = out.find((o) => o.type === 'files');
  return {
    out,
    findings: kv('Findings'),
    rows: table?.type === 'table' ? table.rows.map((r) => r.map(String)) : [],
    text: resultToText(out),
    warnings: out.flatMap((o) => (o.type === 'note' && o.level === 'warn' ? [o.text] : [])),
    maps: out.filter((o): o is Extract<Output, { type: 'map' }> => o.type === 'map'),
    kv,
    file: (name) => {
      const f = files?.type === 'files' ? files.files.find((x) => x.name === name) : undefined;
      if (!f) throw new Error(`no file ${name}`);
      return f.data;
    },
  };
}

const row = (r: Result, group: string, tag: string) =>
  r.rows.find((x) => x[0] === group && x[1] === tag)?.[2];

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

const BASE = jpegOf(picture(64, 48));
/** A small JPEG carrying one EXIF APP1 built from `spec`. */
const jpegExif = (spec: Parameters<typeof tiff>[0], ...more: Uint8Array[]) =>
  jpegWith(BASE, app1Exif(tiff(spec)), ...more);

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The candidates the UI's yellow banner would show for this result. */
const banner = (r: Result) => [...selectFlags(r.text, buildFlagRegex())];

// ---------------------------------------------------------------- GPS

describe('GPS decoding', () => {
  it('c01 LE JPEG, N/E, seconds with 1e8 denominators', async () => {
    const r = await analyze(
      jpegExif({
        ifd0: [
          [0x010e, ascii('LE description FTF{le_desc}')],
          [0x010f, ascii('ProbeMake')],
          [0x0110, ascii('ProbeModel X')],
        ],
        exif: [[0xa430, ascii('Probe Owner LE')]],
        gps: [
          [0x0000, bytes([2, 3, 0, 0])],
          ...gpsDms(
            'N',
            [
              [48, 1],
              [51, 1],
              [1234567891, 100000000],
            ],
            'E',
            [
              [2, 1],
              [17, 1],
              [4019999999, 100000000],
            ],
          ),
        ],
      }),
    );
    expect(r.maps).toHaveLength(1);
    near(r.maps[0]!.lat, 48 + 51 / 60 + 12.34567891 / 3600);
    near(r.maps[0]!.lon, 2 + 17 / 60 + 40.19999999 / 3600);
    expect(r.findings.get('GPS position')).toBe('48.853429, 2.294500 (EXIF GPS IFD)');
    expect(r.findings.get('Description')).toBe('LE description FTF{le_desc} (EXIF)');
    expect(r.findings.get('Camera owner')).toBe('Probe Owner LE (EXIF)');
    expect(r.findings.get('Camera')).toBe('ProbeMake ProbeModel X');
  });

  it('c02 BE (MM) JPEG, S/W, plus an IFD1 JPEG thumbnail', async () => {
    const thumb = jpegOf(
      draw(32, 24, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? [255] : [0])),
      70,
    );
    const r = await analyze(
      jpegExif({
        le: false,
        ifd0: [
          [0x010e, ascii('BE description FTF{be_desc}')],
          [0x013b, ascii('BE Artist')],
        ],
        exif: [[0xa431, ascii('SN-BE-42')]],
        gps: gpsDms(
          'S',
          [
            [22, 1],
            [57, 1],
            [689760000, 100000000],
          ],
          'W',
          [
            [43, 1],
            [12, 1],
            [3775320000, 100000000],
          ],
        ),
        thumbnail: thumb,
      }),
    );
    expect(r.findings.get('GPS position')).toBe('-22.951916, -43.210487 (EXIF GPS IFD)');
    expect(r.findings.get('Author / artist')).toBe('BE Artist (EXIF)');
    expect(r.findings.get('Serial number')).toBe('SN-BE-42 (EXIF)');
    expect(r.findings.get('Description')).toBe('BE description FTF{be_desc} (EXIF)');
    const pic = r.out.find((o) => o.type === 'picture' && o.label === 'EXIF thumbnail');
    expect(pic?.type === 'picture' && pic.data).toEqual(thumb);
    expect(r.file('probe-exif-thumbnail.jpg')).toEqual(thumb);
  });

  it('c03 N/W with decimal minutes as rationals', async () => {
    const r = await analyze(
      jpegExif({
        gps: gpsDms(
          'N',
          [
            [40, 1],
            [413548200, 10000000],
            [0, 1],
          ],
          'W',
          [
            [74, 1],
            [267012, 100000],
            [0, 1],
          ],
        ),
      }),
    );
    expect(r.findings.get('GPS position')).toBe('40.689247, -74.044502 (EXIF GPS IFD)');
  });

  it('c04 PNG eXIf chunk, BE TIFF, S/E', async () => {
    const t = tiff({
      le: false,
      ifd0: [[0x010e, ascii('PNG eXIf description FTF{png_exif}')]],
      gps: gpsDms(
        'S',
        [
          [33, 1],
          [51, 1],
          [244224, 10000],
        ],
        'E',
        [
          [151, 1],
          [12, 1],
          [550692, 10000],
        ],
      ),
    });
    const r = await analyze(pngWith(pngOf(picture(32, 24)), pngChunk('eXIf', t)), {
      name: 'p.png',
    });
    expect(r.findings.get('GPS position')).toBe('-33.856784, 151.215297 (EXIF GPS IFD)');
    expect(r.findings.get('Description')).toBe('PNG eXIf description FTF{png_exif} (EXIF)');
  });

  it('c05 / c05b degrees only, with 3 rationals or a single (non-standard) one', async () => {
    for (const [lat, lon] of [
      [
        [
          [37774929, 1000000],
          [0, 1],
          [0, 1],
        ],
        [
          [122419416, 1000000],
          [0, 1],
          [0, 1],
        ],
      ],
      [[[37774929, 1000000]], [[122419416, 1000000]]],
    ] as [number, number][][][]) {
      const r = await analyze(jpegExif({ gps: gpsDms('N', lat!, 'W', lon!) }));
      expect(r.findings.get('GPS position')).toBe('37.774929, -122.419416 (EXIF GPS IFD)');
    }
  });

  it('c06 a missing GPSLatitudeRef is reported, not silently taken as N', async () => {
    const r = await analyze(
      jpegExif({
        gps: [
          [0x0002, rational([10, 1], [30, 1], [0, 1])],
          [0x0003, ascii('E')],
          [0x0004, rational([20, 1], [15, 1], [0, 1])],
        ],
      }),
    );
    near(r.maps[0]!.lat, 10.5);
    near(r.maps[0]!.lon, 20.25);
    expect(r.findings.get('GPS position')).toBe(
      '10.500000, 20.250000 (EXIF GPS IFD; hemisphere unknown (GPSLatitudeRef missing))',
    );
    expect(r.warnings.join('\n')).toContain(
      'GPSLatitudeRef is missing: the hemisphere is unknown, so the latitude could be -10.500000 instead of 10.500000',
    );
    const gps = r.kv('GPS details');
    expect(gps.get('Raw latitude')).toBe('10° 30′ 0″');
    expect(gps.get('Hemisphere')).toMatch(/GPSLatitudeRef is missing.*could be -10\.500000/);
  });

  it('c07 altitude below sea level', async () => {
    const r = await analyze(
      jpegExif({
        le: false,
        gps: [
          ...gpsDms(
            'N',
            [
              [31, 1],
              [33, 1],
              [324, 10],
            ],
            'E',
            [
              [35, 1],
              [28, 1],
              [2352, 100],
            ],
          ),
          [0x0005, bytes([1])],
          [0x0006, rational([43050, 100])],
        ],
      }),
    );
    expect(r.findings.get('GPS position')).toBe('31.559000, 35.473200 (EXIF GPS IFD)');
    expect(r.kv('GPS details').get('Altitude')).toBe('430.5 m below sea level');
  });

  it('c08 GPS 0/0 is an empty fix, not a place', async () => {
    const zero: [number, number][] = [
      [0, 1],
      [0, 1],
      [0, 1],
    ];
    const r = await analyze(jpegExif({ gps: gpsDms('N', zero, 'E', zero) }));
    expect(r.maps).toEqual([]);
    expect(r.findings.get('GPS')).toBe('tags hold 0, 0: no real fix, ignored');
    expect(r.warnings.join('\n')).toMatch(/empty fix .* no map/);
  });

  it('f06 out-of-range GPS (123° N, 200° E) is called invalid, not an empty fix', async () => {
    const r = await analyze(
      jpegExif({
        gps: gpsDms(
          'N',
          [
            [123, 1],
            [0, 1],
            [0, 1],
          ],
          'E',
          [
            [200, 1],
            [0, 1],
            [0, 1],
          ],
        ),
      }),
    );
    expect(r.maps).toEqual([]);
    expect(r.findings.get('GPS')).toBe('tags hold 123, 200: off the globe, invalid, ignored');
    const w = r.warnings.join('\n');
    expect(w).toContain('not a position on Earth');
    expect(w).not.toContain('empty fix');
  });

  it('c22 rationals with 2^32-1 denominators', async () => {
    const r = await analyze(
      jpegExif({
        le: false,
        gps: gpsDms(
          'S',
          [
            [12, 1],
            [34, 1],
            [4294967295, 4294967295],
          ],
          'E',
          [
            [56, 1],
            [7, 1],
            [2147483647, 4294967295],
          ],
        ),
      }),
    );
    expect(r.findings.get('GPS position')).toBe('-12.566944, 56.116806 (EXIF GPS IFD)');
  });

  it('f05 EXIF and XMP positions that disagree are both shown, with a warning', async () => {
    const xmp = app1Xmp(
      xmpPacket('', 'exif:GPSLatitude="40,41.35482N" exif:GPSLongitude="74,2.67012W"'),
    );
    const r = await analyze(
      jpegWith(
        BASE,
        app1Exif(
          tiff({
            gps: gpsDms(
              'N',
              [
                [48, 1],
                [51, 1],
                [3024, 100],
              ],
              'E',
              [
                [2, 1],
                [17, 1],
                [4020, 100],
              ],
            ),
          }),
        ),
        xmp,
      ),
    );
    expect(r.maps.map((m) => [m.label, m.lat.toFixed(6), m.lon.toFixed(6)])).toEqual([
      ['GPS position', '48.858400', '2.294500'],
      ['GPS position (XMP exif:GPSLatitude / exif:GPSLongitude)', '40.689247', '-74.044502'],
    ]);
    expect(r.findings.get('Other GPS position')).toBe(
      '40.689247, -74.044502 (XMP exif:GPSLatitude / exif:GPSLongitude): not the same place',
    );
    expect(r.warnings.join('\n')).toMatch(/more than one position.*decoy/);
  });

  it('c18 XMP-only GPS in a PNG iTXt packet', async () => {
    const packet = xmpPacket(
      '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">PNG XMP GPS</rdf:li></rdf:Alt></dc:description>',
      'exif:GPSLatitude="33,51.40704S" exif:GPSLongitude="151,12.91782E"',
    );
    const r = await analyze(pngWith(pngOf(picture(16, 16)), iTXt('XML:com.adobe.xmp', packet)), {
      name: 'x.png',
    });
    expect(r.findings.get('GPS position')).toBe(
      '-33.856784, 151.215297 (XMP exif:GPSLatitude / exif:GPSLongitude)',
    );
    expect(r.findings.get('Description')).toBe('PNG XMP GPS (XMP dc:description)');
  });

  it('c19 / c19b WebP EXIF chunk, raw TIFF and Exif-prefixed', async () => {
    const t = tiff({
      ifd0: [[0x010e, ascii('WebP EXIF FTF{webp_exif}')]],
      gps: gpsDms(
        'N',
        [
          [51, 1],
          [30, 1],
          [26244, 10000],
        ],
        'W',
        [
          [0, 1],
          [7, 1],
          [2865, 100],
        ],
      ),
    });
    for (const exif of [t, concatBytes(latin1Encode('Exif\0\0'), t)]) {
      const r = await analyze(webpWithExif(exif), { name: 'w.webp' });
      expect(r.findings.get('GPS position')).toBe('51.500729, -0.124625 (EXIF GPS IFD)');
      expect(row(r, 'File', 'Type')).toBe('WebP image');
      expect(r.findings.get('Description')).toBe('WebP EXIF FTF{webp_exif} (EXIF)');
    }
  });

  it('11 PNG tEXt + zTXt + eXIf GPS', async () => {
    const t = tiff({
      gps: gpsDms(
        'N',
        [
          [51, 1],
          [30, 1],
          [26244, 10000],
        ],
        'W',
        [
          [0, 1],
          [7, 1],
          [2865, 100],
        ],
      ),
    });
    const png = pngWith(
      pngOf(picture(64, 48)),
      tEXt('Comment', 'flag{png_text_chunk}'),
      zTXt('Secret', 'flag{png_ztxt_compressed}'),
      pngChunk('eXIf', t),
    );
    const r = await analyze(png, { name: 'x.png' });
    expect(r.findings.get('User comment')).toBe('flag{png_text_chunk} (PNG)');
    expect(r.findings.get('PNG text "Secret"')).toBe('flag{png_ztxt_compressed} (zTXt)');
    expect(r.findings.get('GPS position')).toBe('51.500729, -0.124625 (EXIF GPS IFD)');
  });

  it('12 hemispheres, owner, description and IPTC together', async () => {
    const r = await analyze(
      jpegExif({
        ifd0: [
          [0x010e, ascii('Probe description')],
          [0x013b, ascii('Probe Artist')],
          [0x010f, ascii('ProbeCam')],
          [0x0110, ascii('ProbeCam Z9')],
        ],
        exif: [[0xa430, ascii('Probe Owner')]],
        gps: gpsDms(
          'N',
          [
            [40, 1],
            [41, 1],
            [212892, 10000],
          ],
          'W',
          [
            [74, 1],
            [2, 1],
            [402072, 10000],
          ],
        ),
      }),
    );
    expect(r.findings.get('GPS position')).toBe('40.689247, -74.044502 (EXIF GPS IFD)');
    expect(r.findings.get('Camera')).toBe('ProbeCam Z9');
    expect(r.text).toContain(
      'https://www.google.com/maps/search/?api=1&query=40.689247,-74.044502',
    );
    const s = await analyze(
      jpegExif(
        {
          gps: gpsDms(
            'S',
            [
              [33, 1],
              [51, 1],
              [244224, 10000],
            ],
            'E',
            [
              [151, 1],
              [12, 1],
              [550692, 10000],
            ],
          ),
        },
        app13Iptc([
          [2, 120, 'flag{iptc_caption}'],
          [2, 80, 'Probe Byline'],
        ]),
      ),
    );
    expect(s.findings.get('GPS position')).toBe('-33.856784, 151.215297 (EXIF GPS IFD)');
    expect(s.findings.get('Description')).toBe('flag{iptc_caption} (IPTC)');
    expect(s.findings.get('Author / artist')).toBe('Probe Byline (IPTC)');
  });
});

// ---------------------------------------------------------------- EXIF text

describe('EXIF text values', () => {
  const longAscii = (tail: string) => 'Long synthetic comment. '.repeat(150) + tail;

  it('c09 / f01b a very long ASCII UserComment is shown in full on the page', async () => {
    for (const tail of [
      'END-MARKER the passphrase is correct-horse-battery',
      'TAIL FTF{tail_of_long_comment}',
    ]) {
      const value = longAscii(tail);
      const r = await analyze(jpegExif({ exif: [[0x9286, comment('ASCII', utf8Encode(value))]] }));
      expect(row(r, 'ExifIFD', 'UserComment')).toBe(value);
      const block = r.out.find(
        (o) => o.type === 'text' && o.label === 'Full value: ExifIFD UserComment',
      );
      expect(block?.type === 'text' && block.value).toBe(value);
      expect(r.findings.get('User comment')).toMatch(/^Long synthetic comment\. .*… \(EXIF\)$/);
    }
    const flagged = await analyze(
      jpegExif({
        exif: [[0x9286, comment('ASCII', utf8Encode(longAscii('TAIL FTF{tail_of_long_comment}')))]],
      }),
    );
    expect(flagged.findings.get('Flag-like strings')).toContain('FTF{tail_of_long_comment}');
  });

  it('f01 a long UNICODE UserComment is decoded and shown in full', async () => {
    const value =
      'Commentaire très long, synthétique. '.repeat(100) +
      'END-MARKER the passphrase is correct-horse-battery';
    const r = await analyze(jpegExif({ exif: [[0x9286, comment('UNICODE', utf16(value, true))]] }));
    expect(row(r, 'ExifIFD', 'UserComment')).toBe(value);
    expect(r.text).toContain('END-MARKER the passphrase is correct-horse-battery');
  });

  it('c09b / c09c UNICODE UserComment in the byte order of the TIFF block', async () => {
    const value = 'Unicode comment: été, Ωmega, 東京 FTF{ucs2_comment}';
    for (const le of [true, false]) {
      const r = await analyze(
        jpegExif({ le, exif: [[0x9286, comment('UNICODE', utf16(value, le))]] }),
      );
      expect(row(r, 'ExifIFD', 'UserComment')).toBe(value);
    }
    // Starting with a non-Latin character: no zero byte to guess the byte order from.
    const cjk = '東京タワー FTF{ucs2_no_ascii_start}';
    for (const le of [true, false]) {
      const r = await analyze(
        jpegExif({ le, exif: [[0x9286, comment('UNICODE', utf16(cjk, le))]] }),
      );
      expect(row(r, 'ExifIFD', 'UserComment')).toBe(cjk);
    }
  });

  it('c10 Windows XP* tags (UTF-16LE, surrogate pairs included)', async () => {
    const xp = (s: string) => bytes(concatBytes(utf16(s, true), new Uint8Array(2)));
    const r = await analyze(
      jpegExif({
        ifd0: [
          [0x9c9b, xp('Titre d’été — 東京タワー 🗼')],
          [0x9c9c, xp('Commentaire : FTF{xp_comment_ünïcødé} ✓')],
          [0x9c9d, xp('Auteur Fictif ß')],
          [0x9c9e, xp('mot-clé;テスト')],
          [0x9c9f, xp('Sujet ç')],
        ],
      }),
    );
    expect(r.findings.get('Title')).toBe('Titre d’été — 東京タワー 🗼 (EXIF) | Sujet ç (EXIF)');
    expect(r.findings.get('User comment')).toBe(
      'Commentaire : FTF{xp_comment_ünïcødé} ✓ (Windows)',
    );
    expect(r.findings.get('Author / artist')).toBe('Auteur Fictif ß (EXIF)');
    expect(r.findings.get('Keywords')).toBe('mot-clé;テスト (EXIF)');
    expect(row(r, 'IFD0', 'XPTitle')).toBe('Titre d’été — 東京タワー 🗼');
    expect(r.text).not.toMatch(/[\0�]/);
  });

  it('f09 an ASCII-typed tag holding binary bytes shows its real bytes', async () => {
    const r = await analyze(
      jpegExif({
        ifd0: [[0x013b, ascii(Uint8Array.from([1, 0x80, 0x9f, 0xff, 0xc3, 0xa9, 0x41, 0]))]],
      }),
    );
    expect(row(r, 'IFD0', 'Artist')).toBe('01 80 9f ff c3 a9 41');
    expect(r.findings.get('Author / artist')).toBe('01 80 9f ff c3 a9 41 (EXIF)');
  });

  it('ASCII tags: UTF-8 text decoded, printable Latin-1 kept as text', async () => {
    const r = await analyze(
      jpegExif({
        ifd0: [
          [0x010e, ascii('Légende UTF-8 été')],
          [0x013b, ascii(concatBytes(latin1Encode('Caf\xe9 Latin-1'), new Uint8Array(1)))],
        ],
      }),
    );
    expect(row(r, 'IFD0', 'ImageDescription')).toBe('Légende UTF-8 été');
    expect(row(r, 'IFD0', 'Artist')).toBe('Café Latin-1');
  });

  it('f10 / f10b MakerNote and unknown UNDEFINED/BYTE tags as exact hex', async () => {
    const payload = [0xde, 0xad, 0xbe, 0xef, 0x80, 0x00, 0xff, 0x7f, 0x46, 0x54, 0x46];
    const r = await analyze(jpegExif({ exif: [[0x927c, undef(payload)]] }));
    expect(row(r, 'ExifIFD', 'MakerNote')).toBe('de ad be ef 80 00 ff 7f 46 54 46');
    const b = await analyze(
      jpegExif({
        ifd0: [
          [0xc6f3, undef(payload)],
          [0xc6f4, bytes(payload)],
        ],
      }),
    );
    const hexes = b.rows.filter((x) => x[0] === 'IFD0').map((x) => x[2]);
    expect(hexes.filter((v) => v === 'de ad be ef 80 00 ff 7f 46 54 46')).toHaveLength(2);
    // A big MakerNote is downloadable in full.
    const big = Array.from({ length: 300 }, (_, i) => (i * 7) & 255);
    const m = await analyze(jpegExif({ exif: [[0x927c, undef(big)]] }));
    expect(Array.from(m.file('probe-makernote.bin'))).toEqual(big);
  });

  it('f11 unknown private tags in IFD0, Exif and GPS IFDs, named in hex', async () => {
    const r = await analyze(
      jpegExif({
        le: false,
        ifd0: [[0xabcd, ascii('private ifd0 value')]],
        exif: [[0xbeef, ascii('private exif value')]],
        gps: [
          ...gpsDms(
            'N',
            [
              [1, 1],
              [0, 1],
              [0, 1],
            ],
            'E',
            [
              [1, 1],
              [0, 1],
              [0, 1],
            ],
          ),
          [0x0077, ascii('private gps value')],
          [0x001b, comment('ASCII', utf8Encode('GPS processing method text'))],
        ],
      }),
    );
    expect(row(r, 'IFD0', '0xABCD')).toBe('private ifd0 value');
    expect(row(r, 'ExifIFD', '0xBEEF')).toBe('private exif value');
    expect(row(r, 'GPS', '0x0077')).toBe('private gps value');
    expect(r.kv('GPS details').get('Processing method')).toBe('GPS processing method text');
  });
});

// ---------------------------------------------------------------- damaged EXIF

describe('Damaged EXIF', () => {
  it('c15 one value outside the block: the other fields are still read', async () => {
    const t = tiff({
      ifd0: [
        [0x010e, ascii('A long description that lives in the data area '.repeat(2))],
        [0x010f, ascii('TMake')],
        [0x0112, short(1)],
        [0x011a, rational([72, 1])],
        [0x0131, ascii('Software name in the data area')],
      ],
    }).subarray(0, 8 + 2 + 12 * 3 + 2);
    const r = await analyze(
      jpegWith(BASE, app1Exif(t), com('after truncated exif FTF{com_survives}')),
    );
    expect(row(r, 'IFD0', 'Orientation')).toBe('Horizontal (normal)');
    expect(row(r, 'IFD0', 'ImageDescription')).toMatch(/^unreadable: .* outside the EXIF block$/);
    expect(r.findings.get('EXIF')).toMatch(
      /^present but damaged \(APP1 at 0x2\): IFD0 declares 5 entries but only 3 fit/,
    );
    expect(r.warnings.join('\n')).toMatch(/The EXIF block \(APP1 at 0x2\) is damaged/);
    expect(r.findings.get('JPEG comment')).toBe('after truncated exif FTF{com_survives} (COM)');
    expect(r.kv('Hashes').get('MD5')).toBe(
      md5(jpegWith(BASE, app1Exif(t), com('after truncated exif FTF{com_survives}'))),
    );
    // No raw reader message: plain words only.
    expect(r.text).not.toMatch(/Invalid TIFF value|this\.ifd0Offset|chunk size/);
  });

  it('f07 a value ending exactly past the segment is flagged, never read from outside', async () => {
    const t = tiff({
      ifd0: [
        [0x0100, short(64)],
        [0x0101, short(48)],
        [0x0112, short(6)],
        [0x0131, ascii('Software string in data area')],
      ],
    }).subarray(0, 8 + 2 + 12 * 4 + 4);
    const r = await analyze(jpegWith(BASE, app1Exif(t)));
    expect(row(r, 'IFD0', 'ImageWidth')).toBe('64');
    expect(row(r, 'IFD0', 'ImageHeight')).toBe('48');
    expect(row(r, 'IFD0', 'Orientation')).toBe('Rotate 90 CW');
    expect(row(r, 'IFD0', 'Software')).toMatch(/^unreadable: its 29 bytes would be at offset 62/);
    expect(r.findings.get('EXIF')).toMatch(
      /0x0131 \(Software\): its value \(29 bytes at offset 62\) lies outside/,
    );
    expect(r.text).not.toContain('JFIF\0');
  });

  it('c16 a file cut in the middle of its APP1 EXIF segment', async () => {
    const full = jpegExif({
      ifd0: [[0x010e, ascii('Cut description')]],
      gps: gpsDms(
        'N',
        [
          [1, 1],
          [2, 1],
          [3, 1],
        ],
        'E',
        [
          [4, 1],
          [5, 1],
          [6, 1],
        ],
      ),
    });
    const cut = full.slice(0, 2 + 4 + 6 + 8 + 2 + 12 * 2 + 5);
    const r = await analyze(cut);
    expect(r.kv('Hashes').get('MD5')).toBe(md5(cut));
    expect(r.findings.get('Structure')).toMatch(/truncated or damaged/);
    expect(r.findings.get('EXIF')).toMatch(/present but damaged/);
    expect(r.text).not.toContain('the file was stripped, or never had any');
  });

  it('16 malformed inputs: truncated JPEG, IFD0 offset 0xFFFFFFF0, FF D8 FF, empty', async () => {
    const photo = jpegExif({ ifd0: [[0x010e, ascii('Fine')]] });
    const cut = await analyze(photo.slice(0, photo.length - 500));
    expect(cut.findings.get('Structure')).toMatch(/truncated or damaged/);
    const bad = tiff({ ifd0: [[0x010e, ascii('Never read')]] });
    bad.set([0xf0, 0xff, 0xff, 0xff], 4);
    const r = await analyze(jpegWith(BASE, app1Exif(bad)));
    expect(r.findings.get('EXIF')).toBe(
      `present but damaged (APP1 at 0x2): IFD0 should start at offset 4294967280, but the EXIF block is only ${bad.length} bytes long.`,
    );
    expect(r.text).not.toMatch(/this\.ifd0Offset|byteLength/);
    const three = await analyze(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(three.findings.get('File type')).toBe(
      'JPEG, cut inside its header: only 3 bytes, nothing else to read',
    );
    expect(three.kv('Hashes').get('MD5')).toBe(md5(new Uint8Array([0xff, 0xd8, 0xff])));
    await expect(analyze(new Uint8Array())).rejects.toThrow(/Drop an image/);
  });

  it('c14 / f02 / f12 several APP1 segments: XMP, junk, EXIF and a second EXIF', async () => {
    const xmp = app1Xmp(
      xmpPacket(
        '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">XMP in first APP1</rdf:li></rdf:Alt></dc:description>',
      ),
    );
    const junk = segment(0xe1, latin1Encode('FTFJUNK\0junk app1 payload'));
    const first = app1Exif(
      tiff({
        ifd0: [[0x010e, ascii('First Exif APP1')]],
        gps: gpsDms(
          'N',
          [
            [64, 1],
            [8, 1],
            [474, 10],
          ],
          'W',
          [
            [21, 1],
            [56, 1],
            [1, 1],
          ],
        ),
      }),
    );
    const second = (desc: string, gps?: Entry[]) =>
      app1Exif(tiff({ le: false, ifd0: [[0x010e, ascii(desc)]], gps }));
    const r = await analyze(
      jpegWith(BASE, xmp, junk, first, second('Second Exif APP1 FTF{second_exif_segment}')),
    );
    expect(r.findings.get('GPS position')).toBe('64.146500, -21.933611 (EXIF GPS IFD)');
    expect(r.findings.get('Description')).toBe(
      'First Exif APP1 (EXIF) | XMP in first APP1 (XMP dc:description)',
    );
    expect(r.findings.get('Another EXIF block')).toMatch(
      /^APP1 at 0x[0-9a-f]+, ignored by most readers: ImageDescription "Second Exif APP1 FTF\{second_exif_segment\}"$/,
    );
    expect(row(r, 'EXIF #2 IFD0', 'ImageDescription')).toBe(
      'Second Exif APP1 FTF{second_exif_segment}',
    );
    expect(r.warnings.join('\n')).toMatch(/holds 2 EXIF blocks/);
    const doc = JSON.parse(utf8Decode(r.file('metadata.json'))) as {
      metadata: Record<string, Record<string, string>>;
      exifBlocks: unknown[];
    };
    expect(doc.metadata['EXIF #2 IFD0']!.ImageDescription).toBe(
      'Second Exif APP1 FTF{second_exif_segment}',
    );
    expect(doc.exifBlocks).toHaveLength(2);
    // f02: the hidden block carries another position.
    const f02 = await analyze(
      jpegWith(
        BASE,
        xmp,
        junk,
        first,
        second(
          'Hidden second segment description',
          gpsDms(
            'S',
            [
              [10, 1],
              [0, 1],
              [0, 1],
            ],
            'W',
            [
              [20, 1],
              [0, 1],
              [0, 1],
            ],
          ),
        ),
      ),
    );
    expect(f02.findings.get('Another EXIF block')).toContain('Hidden second segment description');
    expect(f02.findings.get('Other GPS position')).toBe(
      '-10.000000, -20.000000 (EXIF #2 GPS IFD): not the same place',
    );
    expect(f02.maps).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- XMP, IPTC, ICC, comments

describe('XMP, IPTC, ICC and comments', () => {
  it('c11 XMP custom namespace (attribute and element) and dc bags', async () => {
    const packet = xmpPacket(
      '<ctf:Secret>FTF{custom_namespace_token}</ctf:Secret>' +
        '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP title</rdf:li></rdf:Alt></dc:title>' +
        '<dc:subject><rdf:Bag><rdf:li>kw-one</rdf:li><rdf:li>kw-two</rdf:li></rdf:Bag></dc:subject>' +
        '<dc:creator><rdf:Seq><rdf:li>Creator One</rdf:li></rdf:Seq></dc:creator>',
      'xmlns:ctf="https://example.invalid/ns/ctf/1.0/" ctf:Hint="look FTF{xmp_attr_token}"',
    );
    const r = await analyze(jpegWith(BASE, app1Xmp(packet)));
    expect(r.findings.get('XMP ctf:Hint')).toBe('look FTF{xmp_attr_token} (XMP)');
    expect(r.findings.get('XMP ctf:Secret')).toBe('FTF{custom_namespace_token} (XMP)');
    expect(r.findings.get('Keywords')).toBe('kw-one, kw-two (XMP dc:subject)');
    expect(r.findings.get('Author / artist')).toBe('Creator One (XMP dc:creator)');
    expect(r.findings.get('Title')).toBe('XMP title (XMP dc:title)');
    expect(row(r, 'XMP', 'ctf:Secret')).toBe('FTF{custom_namespace_token}');
  });

  it('c11 / f03 rdf:Alt with several languages is flat text, x-default first', async () => {
    const alt = (items: [string, string][]) =>
      `<rdf:Alt>${items.map(([l, v]) => `<rdf:li xml:lang="${l}">${v}</rdf:li>`).join('')}</rdf:Alt>`;
    const r = await analyze(
      jpegWith(
        BASE,
        app1Xmp(
          xmpPacket(
            `<dc:description>${alt([
              ['fr-FR', 'Description française FTF{xmp_alt_fr}'],
              ['x-default', 'XMP default description'],
            ])}</dc:description><dc:rights>${alt([
              ['x-default', 'Default rights'],
              ['de-DE', 'Deutsche Rechte'],
            ])}</dc:rights>`,
          ),
        ),
      ),
    );
    expect(row(r, 'XMP', 'dc:description')).toBe(
      'XMP default description | [fr-FR] Description française FTF{xmp_alt_fr}',
    );
    expect(r.findings.get('Copyright')).toBe(
      'Default rights | [de-DE] Deutsche Rechte (XMP dc:rights)',
    );
    expect(r.text).not.toContain('"lang"');
  });

  it('09 a flag only in XMP: JPEG APP1, custom-namespace attribute, PNG iTXt', async () => {
    const a = await analyze(
      jpegWith(
        BASE,
        app1Xmp(
          xmpPacket(
            '<xmp:CreatorTool>Probe Tool</xmp:CreatorTool><dc:description><rdf:Alt><rdf:li xml:lang="x-default">flag{only_in_xmp}</rdf:li></rdf:Alt></dc:description>',
          ),
        ),
      ),
    );
    expect(a.findings.get('Description')).toBe('flag{only_in_xmp} (XMP dc:description)');
    expect(a.findings.get('Flag-like strings')).toContain('flag{only_in_xmp}');
    const b = await analyze(
      jpegWith(
        BASE,
        app1Xmp(
          xmpPacket(
            '',
            'xmlns:ctf="https://example.invalid/ctf/" ctf:Secret="flag{xmp_custom_ns}"',
          ),
        ),
      ),
    );
    expect(b.findings.get('XMP ctf:Secret')).toBe('flag{xmp_custom_ns} (XMP)');
    const c = await analyze(
      pngWith(
        pngOf(picture(16, 16)),
        iTXt(
          'XML:com.adobe.xmp',
          xmpPacket(
            '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">flag{png_itxt_xmp}</rdf:li></rdf:Alt></dc:title>',
          ),
        ),
      ),
      { name: 'x.png' },
    );
    expect(c.findings.get('Title')).toBe('flag{png_itxt_xmp} (XMP dc:title)');
  });

  it('c12 IPTC with CodedCharacterSet UTF-8 (1:90 = ESC % G)', async () => {
    const r = await analyze(
      jpegWith(
        BASE,
        app13Iptc([
          [1, 90, Uint8Array.from([0x1b, 0x25, 0x47])],
          [2, 0, Uint8Array.from([0, 4])],
          [2, 120, 'Légende IPTC synthétique FTF{iptc_caption}'],
          [2, 25, 'alpha'],
          [2, 25, 'bêta'],
          [2, 25, 'gamma'],
          [2, 80, 'Probe Byline'],
          [2, 90, 'Ville'],
          [2, 101, 'Pays'],
          [2, 105, 'Titre IPTC'],
          [2, 40, 'Special FTF{iptc_instructions}'],
          [2, 116, '© Probe'],
        ]),
      ),
    );
    expect(r.findings.get('Description')).toBe('Légende IPTC synthétique FTF{iptc_caption} (IPTC)');
    expect(r.findings.get('Keywords')).toBe('alpha, bêta, gamma (IPTC)');
    expect(r.findings.get('Author / artist')).toBe('Probe Byline (IPTC)');
    expect(r.findings.get('Place names')).toBe('Ville (IPTC) | Pays (IPTC)');
    expect(r.findings.get('Title')).toBe('Titre IPTC (IPTC)');
    expect(r.findings.get('Instructions')).toBe('Special FTF{iptc_instructions} (IPTC)');
    expect(r.findings.get('Copyright')).toBe('© Probe (IPTC)');
    expect(row(r, 'IPTC', 'CodedCharacterSet')).toBe('UTF-8 (ESC % G)');
  });

  it('f04 / f04b IPTC without 1:90: valid UTF-8 detected, Latin-1 kept', async () => {
    const utf8 = await analyze(jpegWith(BASE, app13Iptc([[2, 120, 'Légende sans 1:90']])));
    expect(utf8.findings.get('Description')).toBe('Légende sans 1:90 (IPTC)');
    const latin1 = await analyze(
      jpegWith(BASE, app13Iptc([[2, 120, latin1Encode('Légende latin-1')]])),
    );
    expect(latin1.findings.get('Description')).toBe('Légende latin-1 (IPTC)');
  });

  it('c13 two JPEG COM segments, UTF-8', async () => {
    const r = await analyze(
      jpegWith(BASE, com('First COM: FTF{com_one}'), com('Second COM — ünïcode FTF{com_two}')),
    );
    expect(r.findings.get('JPEG comment')).toBe(
      'First COM: FTF{com_one} (COM) | Second COM — ünïcode FTF{com_two} (COM)',
    );
  });

  it('08 a flag in a JPEG comment', async () => {
    const r = await analyze(jpegWith(BASE, com('flag{in_the_jpeg_comment}')));
    expect(r.findings.get('JPEG comment')).toBe('flag{in_the_jpeg_comment} (COM)');
    expect(r.findings.get('Flag-like strings')).toBe('flag{in_the_jpeg_comment}');
  });

  it('c17 PNG tEXt / zTXt / iTXt, plain, compressed and with a language', async () => {
    const png = pngWith(
      pngOf(picture(16, 16)),
      tEXt('Comment', latin1Encode('Café latin1 FTF{text_chunk}')),
      tEXt('flag', 'FTF{custom_keyword}'),
      zTXt('Description', 'Compressed description FTF{ztxt_chunk}'),
      iTXt('Title', 'Titre : été 東京 FTF{itxt_plain}', { lang: 'fr', translated: 'Titre' }),
      iTXt('Secret', 'Compressed iTXt FTF{itxt_compressed}', { compress: true }),
      tEXt('Author', 'PNG Author'),
    );
    const r = await analyze(png, { name: 'x.png' });
    expect(r.findings.get('User comment')).toBe('Café latin1 FTF{text_chunk} (PNG)');
    expect(r.findings.get('PNG text "flag"')).toBe('FTF{custom_keyword} (tEXt)');
    expect(r.findings.get('Description')).toBe('Compressed description FTF{ztxt_chunk} (PNG)');
    expect(r.findings.get('Title')).toBe('Titre : été 東京 FTF{itxt_plain} (language fr) (PNG)');
    expect(r.findings.get('PNG text "Secret"')).toBe('Compressed iTXt FTF{itxt_compressed} (iTXt)');
    expect(r.findings.get('Author / artist')).toBe('PNG Author (PNG)');
  });

  it('two PNG text chunks with the same keyword are both kept, in Findings and the JSON', async () => {
    const r = await analyze(
      pngWith(pngOf(picture(16, 16)), tEXt('Secret', 'part one'), tEXt('Secret', 'part two')),
      { name: 'x.png' },
    );
    expect(r.findings.get('PNG text "Secret"')).toBe('part one (tEXt) | part two (tEXt)');
    const doc = JSON.parse(utf8Decode(r.file('metadata.json'))) as {
      findings: Record<string, string>;
    };
    expect(doc.findings['PNG text "Secret"']).toBe('part one (tEXt) | part two (tEXt)');
  });

  it('c20 ICC profile text (not a standard profile) reaches Findings; a zero date is "not set"', async () => {
    const r = await analyze(
      jpegWith(BASE, app2Icc(iccProfile('FTF synthetic ICC FTF{icc_desc}', 'ICC copyright text'))),
    );
    expect(row(r, 'ICC', 'ProfileDescription')).toBe('FTF synthetic ICC FTF{icc_desc}');
    expect(row(r, 'ICC', 'ProfileCopyright')).toBe('ICC copyright text');
    expect(row(r, 'ICC', 'ProfileDateTime')).toBe('not set (all zeros)');
    expect(r.findings.get('ICC profile text')).toBe(
      'FTF synthetic ICC FTF{icc_desc} (ICC) | ICC copyright text (ICC)',
    );
    expect(r.findings.has('Nothing unusual found')).toBe(false);
    const srgb = await analyze(
      jpegWith(BASE, app2Icc(iccProfile('sRGB IEC61966-2.1', 'Copyright'))),
    );
    expect(srgb.findings.has('ICC profile text')).toBe(false);
  });

  it('21 a Base64 metadata value gets decoded', async () => {
    const r = await analyze(jpegExif({ ifd0: [[0x010e, ascii('ZmxhZ3tiNjRfaW5fZXhpZn0=')]] }));
    expect(r.findings.get('Encoded text')).toBe(
      'Description (IFD0 ImageDescription) is Base64 for "flag{b64_in_exif}"',
    );
    expect(r.findings.get('Flag-like strings')).toBe('flag{b64_in_exif}');
    const hex = await analyze(jpegExif({ ifd0: [[0x013b, ascii('666c61677b6865787d')]] }));
    expect(hex.findings.get('Encoded text')).toBe(
      'Author / artist (IFD0 Artist) is hex for "flag{hex}"',
    );
    const plain = await analyze(jpegExif({ ifd0: [[0x010e, ascii('Synthetic description')]] }));
    expect(plain.findings.has('Encoded text')).toBe(false);
  });
});

// ---------------------------------------------------------------- hashes and comparison

describe('Hashes and comparison', () => {
  const photo = jpegWith(BASE, com('hash me'));

  it('c21 hashes equal node:crypto', async () => {
    const h = (await analyze(photo)).kv('Hashes');
    expect(h.get('MD5')).toBe(md5(photo));
    expect(h.get('SHA-1')).toBe(sha1(photo));
    expect(h.get('SHA-256')).toBe(sha256(photo));
  });

  it('13 two identical files: the verdict is the first finding', async () => {
    const r = await analyze(photo, { compare: { bytes: photo.slice(), name: 'copy.jpg' } });
    expect([...r.findings][0]).toEqual([
      'Comparison',
      'identical to copy.jpg (same MD5, SHA-1 and SHA-256)',
    ]);
    expect(r.kv('Comparison').get('Verdict')).toBe('Identical files (same MD5/SHA-1/SHA-256)');
    expect(r.kv('Comparison').get('MD5 (other file)')).toBe(md5(photo));
  });

  it('14 one byte changed, and one byte longer', async () => {
    const edited = photo.slice();
    edited[300]! ^= 1;
    const r = await analyze(photo, { compare: { bytes: edited, name: 'edited.jpg' } });
    expect(r.findings.get('Comparison')).toBe(
      'different from edited.jpg: first difference at offset 300 (0x12c)',
    );
    expect(r.kv('Comparison').get('First difference')).toMatch(/^offset 300 \(0x12c\): 0x/);
    const longer = concatBytes(photo, utf8Encode('X'));
    const l = await analyze(photo, { compare: { bytes: longer, name: 'longer.jpg' } });
    expect(l.kv('Comparison').get('Size difference')).toBe('+1 byte (the other file is longer)');
    expect(l.findings.get('Comparison')).toBe(
      `different from longer.jpg: first difference at offset ${photo.length} (0x${photo.length.toString(16)}), sizes differ by 1 byte, the shorter one is the start of the longer one`,
    );
  });

  it('15 a non-image binary: hashes, strings and flag still work', async () => {
    const b = new Uint8Array(4096);
    for (let i = 0; i < b.length; i++) b[i] = Math.imul(i, 2654435761) >>> 24;
    b.set([0x7f, 0x45, 0x4c, 0x46], 0);
    b.set(utf8Encode('/lib64/ld-linux-x86-64.so.2\0'), 512);
    b.set(utf8Encode('Enter password:\0flag{non_image_binary}\0'), 2048);
    const r = await analyze(b, { name: 'a.out' });
    expect(r.kv('Hashes').get('SHA-256')).toBe(sha256(b));
    expect(r.findings.get('File type')).toMatch(/not an image/);
    expect(r.findings.get('Flag-like strings')).toBe('flag{non_image_binary}');
    expect(r.text).toContain('/lib64/ld-linux-x86-64.so.2');
  });
});

// ---------------------------------------------------------------- thumbnails

describe('EXIF thumbnail', () => {
  const scene = (w: number, h: number) =>
    draw(w, h, (x, y) => [(x * 255) / w, (y * 255) / h, 128 + 60 * Math.sin(x / 15)]);
  const sample = (img: RgbaImage, w: number, h: number) =>
    draw(w, h, (x, y) => {
      const sx = Math.floor(((x + 0.5) * img.width) / w);
      const sy = Math.floor(((y + 0.5) * img.height) / h);
      const i = (sy * img.width + sx) * 4;
      return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
    });
  const withThumb = (main: Uint8Array, thumb: Uint8Array) =>
    jpegWith(main, app1Exif(tiff({ ifd0: [[0x010e, ascii('innocent')]], thumbnail: thumb })));
  const verdict = (r: Result) => r.kv('Thumbnail check').get('Verdict');

  it('01 a thumbnail showing another picture is flagged, extracted byte-exact, shown apart', async () => {
    const thumb = jpegOf(
      draw(80, 60, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? [255, 0, 0] : [0, 0, 255])),
      80,
    );
    const r = await analyze(withThumb(jpegOf(scene(320, 240), 90), thumb));
    expect(r.findings.get('Thumbnail')).toMatch(/^differs from the main image/);
    expect(verdict(r)).toBe('a different picture');
    const pics = r.out.filter((o) => o.type === 'picture');
    expect(pics.map((p) => p.label)).toEqual(['Main image', 'EXIF thumbnail']);
    expect(r.file('probe-exif-thumbnail.jpg')).toEqual(thumb);
    // The warning sits right under Findings.
    expect(r.out[2]).toEqual({
      type: 'note',
      level: 'warn',
      text: 'The EXIF thumbnail does not match the main image — it may show the original picture.',
    });
  });

  it('02 a thumbnail made from the main image is not flagged (several sizes and qualities)', async () => {
    const s = scene(320, 240);
    const a = await analyze(withThumb(jpegOf(s, 90), jpegOf(sample(s, 80, 60), 90)));
    expect(verdict(a)).toBe('same picture');
    expect(a.findings.has('Thumbnail')).toBe(false);
    const big = scene(640, 480);
    const b = await analyze(withThumb(jpegOf(big, 85), jpegOf(sample(big, 160, 120), 50)));
    expect(verdict(b)).toBe('same picture');
  });

  it('03 edge cases: flat, text on white, inverted, mirrored, grayscale', () => {
    const decoded = (img: RgbaImage) => decodeJpeg(jpegOf(img, 75));
    const white = draw(320, 240, () => [255]);
    expect(compareThumbnail(white, decoded(draw(80, 60, () => [255]))).verdict).toBe('match');
    const text = draw(80, 60, (x, y) =>
      y > 25 && y < 35 && x > 10 && x < 70 && x % 6 < 3 ? [0] : [255],
    );
    // Flagged either way: a different picture, or the same one with an edited area.
    const flagged = (c: ReturnType<typeof compareThumbnail>) =>
      c.verdict !== 'match' || c.editedRegion !== null || c.rotation !== 0;
    expect(flagged(compareThumbnail(white, decoded(text)))).toBe(true);
    const s = scene(320, 240);
    const small = sample(s, 80, 60);
    const inverted = draw(80, 60, (x, y) => {
      const i = (y * 80 + x) * 4;
      return [255 - small.data[i]!, 255 - small.data[i + 1]!, 255 - small.data[i + 2]!];
    });
    // A negative of a plain gradient is the gradient turned 180°: flagged as rotated at least.
    const inv = compareThumbnail(s, decoded(inverted));
    expect(inv.verdict !== 'match' || inv.rotation !== 0).toBe(true);
    const busy = picture(320, 240);
    const mirrored = sample(
      draw(320, 240, (x, y) => {
        const i = (y * 320 + (319 - x)) * 4;
        return [busy.data[i]!, busy.data[i + 1]!, busy.data[i + 2]!];
      }),
      80,
      60,
    );
    expect(flagged(compareThumbnail(busy, decoded(mirrored)))).toBe(true);
    const busySmall = sample(busy, 80, 60);
    const busyInverted = draw(80, 60, (x, y) => {
      const i = (y * 80 + x) * 4;
      return [255 - busySmall.data[i]!, 255 - busySmall.data[i + 1]!, 255 - busySmall.data[i + 2]!];
    });
    expect(compareThumbnail(busy, decoded(busyInverted)).verdict).toBe('different');
    const gray = draw(320, 240, (x, y) => {
      const i = (y * 320 + x) * 4;
      const l = 0.299 * busy.data[i]! + 0.587 * busy.data[i + 1]! + 0.114 * busy.data[i + 2]!;
      return [l];
    });
    expect(compareThumbnail(gray, decoded(sample(busy, 80, 60))).verdict).toBe('match');
  });

  it('02 / 03 libjpeg progressive and grayscale main images with a colour thumbnail are not flagged', async () => {
    const thumb = jpegOf(
      draw(36, 20, (x, y) => PILLOW_SCENE(x * 2 + 0.5, y * 2 + 0.5)),
      90,
    );
    for (const name of ['progressive420', 'grayProgressive', 'restart420']) {
      const r = await analyze(withThumb(fromBase64(PILLOW_JPEGS[name]!), thumb));
      expect(verdict(r)).toBe('same picture');
    }
  });

  it('03 a CMYK (Adobe) main image with a matching RGB thumbnail is not flagged', async () => {
    const cmyk = fromBase64(PILLOW_JPEGS.cmyk!);
    const thumb = jpegOf(
      draw(36, 20, (x, y) => PILLOW_SCENE(x * 2 + 0.5, y * 2 + 0.5)),
      90,
    );
    const r = await analyze(withThumb(cmyk, thumb));
    expect(verdict(r)).toBe('same picture');
  });

  it('05 another JPEG appended, main image carrying an EXIF thumbnail (FFD9 trap)', async () => {
    const s = scene(320, 240);
    const main = withThumb(jpegOf(s, 85), jpegOf(sample(s, 80, 60), 80));
    const extra = jpegOf(picture(64, 64), 80);
    const r = await analyze(concatBytes(main, extra));
    const emb = r.out.find((o) => o.type === 'table' && o.label === 'Embedded files');
    expect(emb?.type === 'table' && emb.rows.map((x) => x.slice(0, 3))).toEqual([
      [`${main.length} (0x${main.length.toString(16)})`, 'JPEG image', `${extra.length} bytes`],
    ]);
    expect(r.file(`${main.length.toString(16).padStart(8, '0')}.jpg`)).toEqual(extra);
    const control = await analyze(main);
    expect(control.findings.has('Embedded files')).toBe(false);
    expect(control.findings.has('Data after the end')).toBe(false);
  });

  it('strings inside the EXIF thumbnail are labelled as such and listed after real metadata', async () => {
    const s = scene(320, 240);
    const thumb = jpegOf(sample(s, 80, 60), 80);
    const photo = jpegWith(withThumb(jpegOf(s, 85), thumb), com('A real comment string'));
    let at = -1;
    for (let i = 0; i < photo.length && at < 0; i++) {
      if (thumb.every((x, k) => photo[i + k] === x)) at = i;
    }
    expect(at).toBeGreaterThan(0);
    const r = await analyze(photo, { minLength: 4 });
    const table = r.out.find((o) => o.type === 'table' && o.label === 'Strings');
    const rows = table?.type === 'table' ? table.rows.map((x) => x.map(String)) : [];
    const inThumb = rows.filter((x) => {
      const off = Number.parseInt(x[0]!, 16);
      return off >= at && off < at + thumb.length;
    });
    for (const x of inThumb) {
      expect(x[1]).toBe('EXIF thumbnail');
      expect(x[3]!.length).toBeGreaterThanOrEqual(20);
    }
    const where = rows.map((x) => x[1]);
    expect(where.indexOf('COM (comment)')).toBeGreaterThanOrEqual(0);
    if (inThumb.length)
      expect(where.indexOf('EXIF thumbnail')).toBeGreaterThan(where.indexOf('COM (comment)'));
    expect(
      r.out.some(
        (o) => o.type === 'note' && /short strings? inside the compressed image data/.test(o.text),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------- appended data

describe('Data after the end', () => {
  const photo = jpegOf(scene320());
  function scene320() {
    return draw(320, 240, (x, y) => [x % 256, y % 256, 128]);
  }

  it('04 a ZIP appended after FFD9, extractable byte-exact, download right under the warnings', async () => {
    const zip = zipSync(
      { 'secret/flag.txt': utf8Encode('flag{zip_after_ffd9}') },
      { mtime: new Date(2024, 0, 1) },
    );
    const r = await analyze(concatBytes(photo, zip));
    expect(r.findings.get('Data after the end')).toBe(
      `${zip.length} bytes at offset ${photo.length} (0x${photo.length.toString(16)}): ZIP archive`,
    );
    const carved = r.file(`${photo.length.toString(16).padStart(8, '0')}.zip`);
    expect(carved).toEqual(zip);
    expect(utf8Decode(unzipSync(carved)['secret/flag.txt']!)).toBe('flag{zip_after_ffd9}');
    // Stored ZIP: the entry name is glued to the content, the flag must come out whole.
    const stored = zipSync(
      { 'secret/flag.txt': utf8Encode('flag{zip_after_ffd9}') },
      { level: 0, mtime: new Date(2024, 0, 1) },
    );
    const s = await analyze(concatBytes(photo, stored));
    expect(s.findings.get('Flag-like strings')).toBe('flag{zip_after_ffd9}');
    const filesAt = r.out.findIndex((o) => o.type === 'files');
    const mapOrHashes = r.out.findIndex((o) => o.type === 'kv' && o.label === 'Hashes');
    expect(filesAt).toBeLessThan(mapOrHashes);
  });

  it('06 text appended after FFD9, and FF D9 inside a COM segment is not the end', async () => {
    const tail = utf8Encode('\nflag{text_after_the_end}\n');
    const r = await analyze(concatBytes(photo, tail));
    expect(r.file('probe-after-end.txt')).toEqual(tail);
    expect(r.findings.get('Flag-like strings')).toBe('flag{text_after_the_end}');
    const trap = jpegWith(
      photo,
      com(
        concatBytes(
          utf8Encode('trap '),
          Uint8Array.from([0xff, 0xd9]),
          utf8Encode(' still inside the comment'),
        ),
      ),
    );
    expect((await analyze(trap)).findings.has('Data after the end')).toBe(false);
    const withTail = await analyze(
      concatBytes(trap, utf8Encode('flag{real_tail_after_ffd9_trap}')),
    );
    expect(withTail.findings.get('Data after the end')).toBe(
      `31 bytes at offset ${trap.length} (0x${trap.length.toString(16)}): plain text`,
    );
    expect(withTail.findings.get('Flag-like strings')).toContain('flag{real_tail_after_ffd9_trap}');
  });

  it('07 PNG with text + ZIP after IEND, PNG + PNG, GIF + text', async () => {
    const png = pngOf(picture(64, 48));
    const zip = zipSync(
      { 'a.txt': utf8Encode('flag{zip_in_png_tail}') },
      { level: 0, mtime: new Date(2024, 0, 1) },
    );
    const tail = concatBytes(utf8Encode('flag{png_after_iend}'), zip);
    const r = await analyze(concatBytes(png, tail), { name: 'x.png' });
    expect(r.findings.get('Data after the end')).toMatch(
      new RegExp(`^${tail.length} bytes at offset ${png.length} `),
    );
    expect(r.findings.get('Flag-like strings')).toContain('flag{png_after_iend}');
    expect(r.findings.get('Flag-like strings')).toContain('flag{zip_in_png_tail}');
    expect(r.file('x-after-end.bin')).toEqual(tail);
    const zipAt = png.length + 20;
    expect(r.file(`${zipAt.toString(16).padStart(8, '0')}.zip`)).toEqual(zip);
    const second = pngOf(picture(16, 16));
    const pp = await analyze(concatBytes(pngOf(picture(32, 32)), second), { name: 'pp.png' });
    expect(pp.findings.get('Embedded files')).toMatch(/^1: PNG image at 0x/);
    const gif = Uint8Array.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x21,
      0xf9, 4, 1, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b,
    ]);
    const g = await analyze(concatBytes(gif, utf8Encode('flag{after_gif_trailer}')), {
      name: 'g.gif',
    });
    expect(g.findings.get('Data after the end')).toMatch(/^23 bytes at offset/);
    expect(g.findings.get('Flag-like strings')).toBe('flag{after_gif_trailer}');
  });

  it('10 flags only visible through strings: APP9 text, APP10 UTF-16LE', async () => {
    const r = await analyze(
      jpegWith(
        photo,
        segment(0xe9, utf8Encode('PROBEDATA\0flag{only_in_strings_app9}\0')),
        segment(0xea, utf16('flag{utf16_wide}', true)),
      ),
    );
    expect(r.findings.get('Flag-like strings')).toBe(
      'flag{only_in_strings_app9}, flag{utf16_wide}',
    );
  });
});

// ---------------------------------------------------------------- flags

describe('Flag-like strings', () => {
  it('19 common flag formats are reported exactly as written', async () => {
    const flags = [
      'picoCTF{pico_style}',
      'DUCTF{du_style}',
      'TFCCTF{tfc}',
      'rootme{rm_style}',
      'RM{rm2}',
      'FLAG{upper}',
      'ctf_2024{year}',
      'HackTheBox{long_prefix}',
      'flag{nested{brace}}',
    ];
    const r = await analyze(jpegWith(BASE, ...flags.map((f) => com(`note: ${f} end`))));
    const reported = r.findings.get('Flag-like strings')!;
    expect(reported).toBe(`${flags.slice(0, 5).join(', ')}, +4 more`);
    const doc = JSON.parse(utf8Decode(r.file('metadata.json'))) as { flagLikeStrings: string[] };
    expect(doc.flagLikeStrings).toEqual(flags);
    expect(banner(r)).not.toContain('CTF{pico_style}');
  });

  it('18 an ordinary large photo with a matching thumbnail: no false flag anywhere', async () => {
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 255;
    const w = 1280;
    const h = 960;
    const noisy = draw(w, h, (x, y) => [
      100 + 80 * Math.sin(x / 50) + (rnd() - 128) / 4,
      100 + 80 * Math.sin(y / 40) + (rnd() - 128) / 4,
      128 + (rnd() - 128) / 2,
    ]);
    const main = jpegOf(noisy, 95);
    const thumb = jpegOf(
      draw(160, 120, (x, y) => {
        const i = ((y * 8 + 4) * w + x * 8 + 4) * 4;
        return [noisy.data[i]!, noisy.data[i + 1]!, noisy.data[i + 2]!];
      }),
      75,
    );
    const r = await analyze(jpegWith(main, app1Exif(tiff({ ifd0: [], thumbnail: thumb }))));
    expect(r.findings.has('Flag-like strings')).toBe(false);
    expect(banner(r)).toEqual([]);
    expect(r.kv('Thumbnail check').get('Verdict')).toBe('same picture');
  }, 30000);
});

// ---------------------------------------------------------------- decoding speed

describe('Main image decoding', () => {
  it('reads block averages from the DC coefficients of every kind of JPEG', () => {
    for (const name of ['progressive420', 'restart420', 'grayProgressive', 'baseline422']) {
      const b = fromBase64(PILLOW_JPEGS[name]!);
      const grid = jpegDcLuma(b)!;
      const full = decodeJpeg(b);
      expect([grid.cols, grid.rows]).toEqual([9, 5]);
      for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
          let sum = 0;
          let n = 0;
          for (let y = r * 8; y < Math.min(full.height, r * 8 + 8); y++) {
            for (let x = c * 8; x < Math.min(full.width, c * 8 + 8); x++) {
              const i = (y * full.width + x) * 4;
              sum += 0.299 * full.data[i]! + 0.587 * full.data[i + 1]! + 0.114 * full.data[i + 2]!;
              n++;
            }
          }
          expect(Math.abs(grid.v[r * grid.cols + c]! - sum / n)).toBeLessThan(1.5);
        }
      }
    }
    expect(jpegDcLuma(fromBase64(PILLOW_JPEGS.cmyk!))).toBeNull();
  });

  it('17 a multi-megapixel photo with a thumbnail is analysed quickly', async () => {
    const w = 2400;
    const h = 1800;
    const img = draw(w, h, (x, y) => [
      128 + 100 * Math.sin(x / 90),
      (y * 255) / h,
      ((x ^ y) & 63) + 96,
    ]);
    const main = jpegOf(img, 90);
    const thumb = jpegOf(
      draw(160, 120, (x, y) => {
        const i = ((y * 15 + 7) * w + x * 15 + 7) * 4;
        return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
      }),
      75,
    );
    const photo = jpegWith(main, app1Exif(tiff({ ifd0: [], thumbnail: thumb })));
    const t0 = performance.now();
    const r = await analyze(photo);
    const ms = performance.now() - t0;
    expect(r.kv('Thumbnail check').get('Verdict')).toBe('same picture');
    // The check reads 8x8 block averages, not pixels: a full decode is what made 12 MP slow.
    const grid = decodeMain(photo);
    expect(grid && !('data' in grid) && [grid.cols, grid.rows]).toEqual([300, 225]);
    expect(ms).toBeLessThan(1500);
  }, 60000);
});

// ---------------------------------------------------------------- reading order

describe('Reading order', () => {
  it('20 privacy note, Findings, then the warnings, then the evidence', async () => {
    const r = await analyze(
      jpegExif({
        gps: gpsDms(
          'N',
          [
            [0, 1],
            [0, 1],
            [0, 1],
          ],
          'E',
          [
            [0, 1],
            [0, 1],
            [0, 1],
          ],
        ),
      }),
    );
    expect(r.out[0]).toMatchObject({ type: 'note', level: 'info' });
    expect(r.out[1]).toMatchObject({ type: 'kv', label: 'Findings' });
    expect(r.out[2]).toMatchObject({ type: 'note', level: 'warn' });
  });

  it('long values do not get cut in the table the filter box searches', async () => {
    const long = `${'x'.repeat(500)} needle-at-the-end`;
    const r = await analyze(jpegExif({ ifd0: [[0x010e, ascii(long)]] }));
    expect(row(r, 'IFD0', 'ImageDescription')).toBe(long);
  });
});
