import { readFileSync } from 'node:fs';
import { deflateSync, gzipSync, strFromU8, strToU8, unzipSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { concatBytes, indexOfBytes } from '../../lib/bytes';
import { adler32, crc32, deflateScan } from '../../lib/signatures';
import carve, { carveAll, type CarveSettings } from './carve';
import {
  BZIP2,
  COMMENTED_ZIP,
  ENCRYPTED_ZIP,
  GIF_ANIMATED,
  GNU_TAR_GZ,
  JPEG_PROGRESSIVE,
  JPEG_WITH_THUMBNAIL,
  MKV_REAL,
  MP4_REAL,
  OGG_REAL,
  PAX_TAR_GZ,
  PNG_REAL,
  STREAMED_ZIP,
  WEBP_LOSSLESS,
  XZ,
} from './_realfiles';
import {
  build7z,
  buildBmp,
  buildElf64,
  buildGif,
  buildJpeg,
  buildPdf,
  buildPe,
  buildPng,
  buildSqlite,
  buildTar,
  buildWav,
  buildZip,
  be,
  le,
  noise,
} from './_fixtures';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

const base: CarveSettings = { container: false, nested: false, only: new Set() };
const run = (bytes: Uint8Array, opts: Record<string, unknown> = {}) =>
  carve.run({ bytes }, { container: false, nested: false, types: '', ...opts } as never);

/** Bury `file` between two chunks of noise; returns the buffer and the file's exact span. */
function bury(file: Uint8Array, before = 700, after = 500) {
  const head = noise(before, 11);
  const tail = noise(after, 12);
  return { data: concatBytes(head, file, tail), start: before, end: before + file.length };
}

describe('carve: the polyglot sample', () => {
  const bytes = sample('forensics-polyglot.png');
  const iend = indexOfBytes(bytes, [0x49, 0x45, 0x4e, 0x44]);

  it('finds the ZIP after IEND with its exact size', () => {
    const { found, container } = carveAll(bytes, base);
    expect(container?.sig.id).toBe('png');
    expect(container?.end).toBe(iend + 8);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ start: iend + 8, end: bytes.length, exact: true });
    expect(found[0]!.sig.id).toBe('zip');
  });

  it('carves a ZIP that unzips to the flag, named by offset', async () => {
    const out = await run(bytes);
    const files = out.find((o) => o.type === 'files');
    if (files?.type !== 'files') throw new Error('no files block');
    expect(files.files).toHaveLength(1);
    expect(files.files[0]!.name).toBe(`${(iend + 8).toString(16).padStart(8, '0')}.zip`);
    const entries = unzipSync(files.files[0]!.data);
    expect(strFromU8(entries['flag.txt']!)).toBe('flag{binwalk_found_me}');
    // the trailing-data warning is there too
    expect(out.some((o) => o.type === 'note' && /trailing data/.test(o.text))).toBe(true);
  });

  it('includes the PNG container on request, byte for byte', async () => {
    const out = await run(bytes, { container: true });
    const files = out.find((o) => o.type === 'files');
    if (files?.type !== 'files') throw new Error('no files block');
    expect(files.files.map((f) => f.name)).toEqual([
      '00000000.png',
      `${(iend + 8).toString(16).padStart(8, '0')}.zip`,
    ]);
    expect(files.files[0]!.data).toEqual(bytes.subarray(0, iend + 8));
  });
});

describe('carve: exact ends for each format', () => {
  const cases: [string, Uint8Array, string][] = [
    ['png', buildPng(), 'png'],
    ['jpeg', buildJpeg(), 'jpeg'],
    ['jpeg with an EXIF thumbnail', buildJpeg(buildJpeg()), 'jpeg'],
    ['gif', buildGif(), 'gif'],
    ['bmp', buildBmp(), 'bmp'],
    ['wav', buildWav(), 'wav'],
    ['elf', buildElf64(), 'elf'],
    ['pe', buildPe(), 'pe'],
    ['7z', build7z(), '7z'],
    ['sqlite', buildSqlite(), 'sqlite'],
    ['pdf with an incremental update', buildPdf(2), 'pdf'],
    [
      'tar',
      buildTar([
        ['a.txt', strToU8('hello')],
        ['b/c.txt', new Uint8Array(1500).fill(65)],
      ]),
      'tar',
    ],
    [
      'zip',
      buildZip([
        { name: 'a.txt', data: strToU8('aaaa'.repeat(50)) },
        { name: 'b.bin', data: noise(300, 3), method: 0 },
      ]),
      'zip',
    ],
    [
      'zip with a comment',
      buildZip(
        [{ name: 'a.txt', data: strToU8('x'.repeat(100)) }],
        'a comment that is long enough',
      ),
      'zip',
    ],
    [
      'streamed zip (data descriptors)',
      buildZip([
        { name: 'a.txt', data: strToU8('stream '.repeat(30)), streaming: true },
        { name: 'b.txt', data: strToU8('again '.repeat(30)), streaming: true },
      ]),
      'zip',
    ],
    ['gzip', gzipSync(strToU8('gzip payload '.repeat(200)), { mtime: 0 }), 'gzip'],
    ['gzip of noise', gzipSync(noise(3000, 5), { mtime: 0 }), 'gzip'],
    ['zlib', zlibSync(strToU8('zlib payload '.repeat(100))), 'zlib'],
  ];

  it.each(cases)('%s', (_name, file, id) => {
    const { data, start, end } = bury(file);
    const { found } = carveAll(data, base);
    expect(found).toHaveLength(1);
    expect(found[0]!.sig.id).toBe(id);
    expect(found[0]).toMatchObject({ start, end, exact: true, truncated: false });
    expect(data.subarray(found[0]!.start, found[0]!.end)).toEqual(file);
  });

  it('finds several different files in one buffer, in order', () => {
    const parts = [
      buildPng(),
      buildGif(),
      buildBmp(),
      buildSqlite(2),
      buildZip([{ name: 'z', data: strToU8('zz') }]),
    ];
    const pieces: Uint8Array[] = [];
    const spans: [number, number][] = [];
    let at = 0;
    for (const [i, p] of parts.entries()) {
      const pad = noise(200 + i * 17, 20 + i);
      pieces.push(pad, p);
      spans.push([at + pad.length, at + pad.length + p.length]);
      at += pad.length + p.length;
    }
    const { found } = carveAll(concatBytes(...pieces), base);
    expect(found.map((f) => [f.start, f.end])).toEqual(spans);
    expect(found.map((f) => f.sig.id)).toEqual(['png', 'gif', 'bmp', 'sqlite', 'zip']);
  });
});

describe('carve: files from real encoders', () => {
  const cases: [string, Uint8Array, string][] = [
    ['JPEG with an EXIF thumbnail (Pillow)', JPEG_WITH_THUMBNAIL, 'jpeg'],
    ['progressive JPEG (Pillow)', JPEG_PROGRESSIVE, 'jpeg'],
    ['animated GIF (Pillow)', GIF_ANIMATED, 'gif'],
    ['lossless WebP (Pillow)', WEBP_LOSSLESS, 'webp'],
    ['PNG (Pillow)', PNG_REAL, 'png'],
    ['MP4 (ffmpeg)', MP4_REAL, 'mp4'],
    ['Ogg (ffmpeg)', OGG_REAL, 'ogg'],
    ['Matroska (ffmpeg)', MKV_REAL, 'mkv'],
    ['bzip2', BZIP2, 'bzip2'],
    ['xz', XZ, 'xz'],
    ['ZIP with an archive comment (Info-ZIP)', COMMENTED_ZIP, 'zip'],
    ['streamed ZIP with data descriptors (Python)', STREAMED_ZIP, 'zip'],
    ['encrypted ZIP with a data descriptor (Info-ZIP)', ENCRYPTED_ZIP, 'zip'],
    ['tar.gz from GNU tar', GNU_TAR_GZ, 'gzip'],
    ['pax tar.gz from GNU tar', PAX_TAR_GZ, 'gzip'],
  ];
  it.each(cases)('%s: exact span, no thumbnail confusion', (_name, file, id) => {
    const { data, start, end } = bury(file);
    const { found } = carveAll(data, base);
    expect(found.map((f) => [f.sig.id, f.start, f.end, f.exact])).toEqual([[id, start, end, true]]);
  });

  it('pads a TAR to its 10240-byte record, like GNU tar does', () => {
    const tar = buildTar([['a.txt', strToU8('hello')]]);
    const padded = concatBytes(tar, new Uint8Array(10240 - tar.length));
    const { data, start, end } = bury(padded);
    const { found } = carveAll(data, base);
    expect(found[0]).toMatchObject({ start, end });
    expect(end - start).toBe(10240);
  });
});

describe('carve: awkward inputs', () => {
  it('finds a ZIP appended to a PNG, using the real EOCD even with a comment', () => {
    const png = buildPng();
    const zip = buildZip([{ name: 'flag.txt', data: strToU8('flag{x}') }], 'hidden comment');
    const { found } = carveAll(concatBytes(png, zip), base);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ start: png.length, end: png.length + zip.length });
  });

  it('keeps a ZIP stored inside another ZIP out of the list unless asked', () => {
    const inner = buildZip([{ name: 'in.txt', data: strToU8('inner') }]);
    const outer = buildZip([
      { name: 'inner.zip', data: inner, method: 0 },
      { name: 'b.txt', data: strToU8('b') },
    ]);
    const { data, start, end } = bury(outer);
    const plain = carveAll(data, base);
    expect(plain.found).toHaveLength(1);
    expect(plain.found[0]).toMatchObject({ start, end });
    expect(plain.nestedSkipped).toBeGreaterThanOrEqual(2);
    const all = carveAll(data, { ...base, nested: true });
    expect(all.found.length).toBeGreaterThan(plain.found.length);
    const innerAt = indexOfBytes(data, inner.subarray(0, 30));
    expect(all.found.find((f) => f.start === innerAt)?.end).toBe(innerAt + inner.length);
  });

  it('survives a PNG whose chunk length was tampered with by searching for IEND', () => {
    const png = buildPng(32, 32).slice();
    // Corrupt the length of the first IDAT chunk (offset 8 + 25 = 33).
    png.set([0x7f, 0xff, 0x00, 0x00], 33);
    const { data, start, end } = bury(png);
    const { found } = carveAll(data, base);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ start, end, exact: true });
  });

  it('marks a truncated file and carves up to the end of the data', () => {
    const png = buildPng(32, 32);
    const cut = png.subarray(0, png.length - 20);
    const { found } = carveAll(concatBytes(noise(100, 1), cut), base);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ start: 100, end: 100 + cut.length, exact: false });
    expect(found[0]!.how).toBe('end of file');
  });

  it('flags a BMP that declares more bytes than are there as truncated', () => {
    const bmp = buildBmp();
    const { found } = carveAll(concatBytes(noise(64, 4), bmp.subarray(0, bmp.length - 6)), base);
    expect(found[0]).toMatchObject({ truncated: true, exact: true });
  });

  it('ends a file without end() at the next signature', () => {
    const rar = Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 1, 2, 3, 4, 5, 6, 7, 8);
    const gif = buildGif();
    const { found } = carveAll(concatBytes(noise(50, 9), rar, noise(30, 10), gif), base);
    expect(found.map((f) => f.sig.id)).toEqual(['rar4', 'gif']);
    expect(found[0]!.end).toBe(found[1]!.start);
    expect(found[0]!.how).toMatch(/next signature/);
  });

  it('does not report random data as files', () => {
    expect(carveAll(noise(1 << 20, 99), base).found).toEqual([]);
    expect(
      carveAll(strToU8('PK\x03\x04 is only text here, and so is %PDF-1 and GIF89a'), base).found,
    ).toEqual([]);
  });

  it('finds a TAR by the ustar magic at offset 257 and starts at the header', () => {
    const tar = buildTar([['hello.txt', strToU8('hi')]]);
    const { data, start, end } = bury(tar);
    const { found } = carveAll(data, base);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ start, end });
  });

  it('scans 20 MB in a few seconds', () => {
    const big = noise(20 << 20, 1234);
    const zip = buildZip([{ name: 'flag.txt', data: strToU8('flag{big}') }]);
    big.set(zip, 15_000_000);
    const png = buildPng();
    big.set(png, 3_000_001);
    const t0 = performance.now();
    const { found } = carveAll(big, base);
    const ms = performance.now() - t0;
    expect(found.map((f) => [f.sig.id, f.start])).toEqual([
      ['png', 3_000_001],
      ['zip', 15_000_000],
    ]);
    expect(ms).toBeLessThan(8000);
  });
});

describe('carve tool', () => {
  it('reports a table, files and the nested note', async () => {
    const outer = buildZip([
      { name: 'a.txt', data: strToU8('a') },
      { name: 'b.txt', data: strToU8('b') },
    ]);
    const out = await run(bury(outer).data);
    expect(out.map((o) => o.type)).toEqual(['table', 'files', 'note']);
    const table = out[0]!;
    if (table.type !== 'table') throw new Error('table expected');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]![0]).toBe(700);
    expect(table.rows[0]![1]).toBe('0x2bc');
    expect(table.rows[0]![5]).toBe('end-of-central-directory + comment');
  });

  it('keeps unrecognised trailing data as a file', async () => {
    const out = await run(concatBytes(buildPng(), strToU8('flag{appended_in_plain_sight}')));
    const files = out.find((o) => o.type === 'files');
    if (files?.type !== 'files') throw new Error('files expected');
    expect(files.files).toHaveLength(1);
    expect(out.some((o) => o.type === 'table')).toBe(false);
    expect(files.files[0]!.name).toMatch(/^trailing-[0-9a-f]{8}\.bin$/);
    expect(strFromU8(files.files[0]!.data)).toBe('flag{appended_in_plain_sight}');
  });

  it('restricts by type and rejects unknown ones', async () => {
    const mixed = concatBytes(noise(100, 1), buildGif(), noise(100, 2), buildPng());
    const out = await run(mixed, { types: 'png' });
    const table = out.find((o) => o.type === 'table');
    if (table?.type !== 'table') throw new Error('table expected');
    expect(table.rows.map((r) => r[2])).toEqual(['PNG image']);
    await expect(Promise.resolve().then(() => run(mixed, { types: 'nonsense' }))).rejects.toThrow(
      ToolError,
    );
  });

  it('says so when nothing is found, and refuses empty input', async () => {
    const out = await run(noise(2000, 6));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'note', level: 'info' });
    await expect(Promise.resolve().then(() => run(new Uint8Array(0)))).rejects.toThrow(ToolError);
  });

  it('detect() suggests carving only when something is hidden', () => {
    const hit = carve.detect?.({
      text: null,
      bytes: concatBytes(buildPng(), buildZip([{ name: 'a', data: strToU8('a') }])),
    });
    expect(hit?.score).toBeGreaterThanOrEqual(0.5);
    expect(carve.detect?.({ text: null, bytes: buildPng() })).toBeNull();
    expect(carve.detect?.({ text: null, bytes: noise(5000, 77) })).toBeNull();
  });
});

describe('signatures: shared helpers', () => {
  it('crc32 and adler32 match the published check values', () => {
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926);
    expect(crc32(strToU8('6789'), crc32(strToU8('12345')))).toBe(0xcbf43926);
    expect(adler32(strToU8('Wikipedia'))).toBe(0x11e60398);
  });

  it('deflateScan finds the exact end and size of fixed, dynamic and stored streams', () => {
    const inputs = [
      strToU8('a'),
      strToU8('hello hello hello hello'),
      strToU8('The quick brown fox jumps over the lazy dog. '.repeat(500)),
      noise(5000, 3),
      concatBytes(noise(2000, 4), new Uint8Array(70_000), strToU8('tail'.repeat(1000))),
    ];
    for (const level of [0, 1, 6, 9] as const) {
      for (const input of inputs) {
        const stream = deflateSync(input, { level });
        const padded = concatBytes(noise(7, 1), stream, noise(9, 2));
        expect(deflateScan(padded, 7)).toEqual({ end: 7 + stream.length, size: input.length });
      }
    }
  });

  it('deflateScan refuses damaged or cut streams', () => {
    const stream = deflateSync(strToU8('some data that is long enough '.repeat(30)));
    expect(deflateScan(stream.subarray(0, stream.length - 3))).toBeNull();
    expect(deflateScan(Uint8Array.of(0x07, 0, 0, 0))).toBeNull(); // block type 3
    expect(deflateScan(new Uint8Array(0))).toBeNull();
  });
});

describe('carve: messages', () => {
  it('says so when the input is one archive with entries inside it', async () => {
    const zip = buildZip([
      { name: 'a.txt', data: strToU8('a') },
      { name: 'b.txt', data: strToU8('b') },
    ]);
    const out = await run(zip);
    expect(out.map((o) => o.type)).toEqual(['note', 'note']);
    expect(out[0]!.type === 'note' && out[0]!.text).toMatch(/the input is one ZIP archive/);
    expect(out[1]!.type === 'note' && out[1]!.text).toMatch(
      /1 more signature sits inside the ZIP archive that makes up the input and was skipped/,
    );
  });
});

describe('carve: more formats', () => {
  const found = (file: Uint8Array) => {
    const { data, start, end } = bury(file);
    const result = carveAll(data, base).found;
    return { result, start, end, data };
  };

  it('PEM and PGP armor end at the END line', () => {
    const pem = strToU8('-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAL\n-----END CERTIFICATE-----\n');
    const f = found(pem);
    expect(f.result.map((x) => [x.sig.id, x.start, x.end])).toEqual([['pem', f.start, f.end]]);
    const pgp = strToU8('-----BEGIN PGP MESSAGE-----\n\nhQEMA\n-----END PGP MESSAGE-----\n');
    const g = found(pgp);
    expect(g.result.map((x) => [x.sig.id, x.start, x.end])).toEqual([
      ['pgp-armor', g.start, g.end],
    ]);
  });

  it('MP4 walks its top-level boxes', () => {
    const box = (type: string, body: Uint8Array) =>
      concatBytes(be(8 + body.length, 4), strToU8(type), body);
    const mp4 = concatBytes(
      box('ftyp', concatBytes(strToU8('isom'), le(0, 4), strToU8('isomiso2mp41'))),
      box('moov', new Uint8Array(24)),
      box('mdat', noise(100, 5)),
    );
    const f = found(mp4);
    expect(f.result.map((x) => [x.sig.id, x.start, x.end])).toEqual([['mp4', f.start, f.end]]);
  });

  it('Ogg walks its pages, ar/deb its members, CAB / DEX / AIFF use their size fields', () => {
    const page = (flags: number, seq: number, body: Uint8Array) =>
      concatBytes(
        strToU8('OggS'),
        Uint8Array.of(0, flags),
        new Uint8Array(8),
        le(1, 4),
        le(seq, 4),
        le(0, 4),
        Uint8Array.of(1, body.length),
        body,
      );
    const ogg = concatBytes(
      page(2, 0, noise(30, 1)),
      page(0, 1, noise(60, 2)),
      page(4, 2, noise(10, 3)),
    );
    expect(found(ogg).result.map((x) => [x.sig.id, x.start, x.end])).toEqual([
      ['ogg', 700, 700 + ogg.length],
    ]);

    const member = (name: string, body: Uint8Array) =>
      concatBytes(
        strToU8(name.padEnd(16)),
        strToU8('0'.padEnd(12)),
        strToU8('0'.padEnd(6)),
        strToU8('0'.padEnd(6)),
        strToU8('100644'.padEnd(8)),
        strToU8(String(body.length).padEnd(10)),
        strToU8('`\n'),
        body,
        body.length % 2 ? Uint8Array.of(10) : new Uint8Array(0),
      );
    const deb = concatBytes(
      strToU8('!<arch>\n'),
      member('debian-binary', strToU8('2.0\n')),
      member('control.tar.gz', noise(33, 4)),
    );
    expect(found(deb).result.map((x) => [x.sig.id, x.end - x.start])).toEqual([
      ['deb', deb.length],
    ]);

    const cab = new Uint8Array(200);
    cab.set(strToU8('MSCF'));
    cab.set(le(200, 4), 8);
    cab.set(le(44, 4), 16);
    cab.set([3, 1], 24);
    expect(found(cab).result.map((x) => [x.sig.id, x.end - x.start])).toEqual([['cab', 200]]);

    const dex = new Uint8Array(300);
    dex.set(strToU8('dex\n035\0'));
    dex.set(le(300, 4), 32);
    dex.set(le(0x70, 4), 36);
    expect(found(dex).result.map((x) => [x.sig.id, x.end - x.start])).toEqual([['dex', 300]]);

    const aiff = concatBytes(
      strToU8('FORM'),
      be(4 + 8 + 18, 4),
      strToU8('AIFFCOMM'),
      be(18, 4),
      new Uint8Array(18),
    );
    expect(found(aiff).result.map((x) => [x.sig.id, x.end - x.start])).toEqual([
      ['aiff', aiff.length],
    ]);
  });

  it('ISO 9660 and registry hives are sized from their headers', () => {
    const iso = new Uint8Array(20 * 2048);
    iso[0x8000] = 1;
    iso.set(strToU8('CD001'), 0x8001);
    iso[0x8006] = 1;
    iso.set(le(20, 4), 0x8000 + 80);
    iso.set(le(2048, 2), 0x8000 + 128);
    const f = found(iso);
    expect(f.result.map((x) => [x.sig.id, x.start, x.end])).toEqual([['iso', f.start, f.end]]);

    const regf = new Uint8Array(4096 + 8192);
    regf.set(strToU8('regf'));
    regf.set(le(1, 4), 20);
    regf.set(le(5, 4), 24);
    regf.set(le(8192, 4), 40);
    const g = found(regf);
    expect(g.result.map((x) => [x.sig.id, x.end - x.start])).toEqual([['regf', regf.length]]);
  });

  it('JPEG, GIF and PNG do not swallow a look-alike inside noise', () => {
    // A JPEG magic whose next marker is nonsense, a GIF header with zero size, a short PNG magic.
    const fakes = concatBytes(
      Uint8Array.of(0xff, 0xd8, 0xff, 0x12, 0x00, 0x05),
      strToU8('GIF89a'),
      le(0, 4),
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3),
      noise(100, 8),
    );
    expect(carveAll(fakes, base).found).toEqual([]);
  });
});
