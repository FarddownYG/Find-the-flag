import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { lazyFile } from '../../core/prepare';
import { defaultOptions } from '../../core/registry';
import { resultToText } from '../../core/result-text';
import type { AnyTool, LazyFile, Output, ToolResult } from '../../core/types';
import { concatBytes, utf8Decode, utf8Encode } from '../../lib/bytes';
import tool from './binary-analyzer';
import {
  buildHiddenBin,
  buildIso,
  buildRaster,
  buildSampleFat,
  buildSampleIso,
  cookedToRaw,
  FAT_FILES,
  HIDDEN,
  hiddenPng,
  hiddenZip,
  ISO_FILES,
  withMbr,
} from './_disk-fixtures';
import { buildPng, noise } from './_fixtures';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));
const fileOf = (b: Uint8Array | Blob, name = 'input.bin') =>
  lazyFile(b instanceof Blob ? b : new Blob([b as BlobPart]), name);
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

type Opts = Record<string, unknown>;
async function run(
  input: Uint8Array | LazyFile,
  opts: Opts = {},
  name = 'input.bin',
): Promise<ToolResult> {
  const f = input instanceof Uint8Array ? fileOf(input, name) : input;
  return tool.run(f, { ...defaultOptions(tool as unknown as AnyTool), ...opts } as never);
}
const text = (r: ToolResult) => resultToText(r);
const kv = (r: ToolResult) => new Map(r.flatMap((o) => (o.type === 'kv' ? o.entries : [])));
const filesOf = (r: ToolResult) => r.flatMap((o) => (o.type === 'files' ? o.files : []));
const tables = (r: ToolResult) =>
  r.filter((o): o is Extract<Output, { type: 'table' }> => o.type === 'table');
async function content(f: { data: Uint8Array; blob?: Blob }): Promise<Uint8Array> {
  return f.blob ? new Uint8Array(await f.blob.arrayBuffer()) : f.data;
}

describe('the samples are reproducible', () => {
  it('binary-hidden.bin is what the generator writes, with the files at their offsets', () => {
    const b = sample('binary-hidden.bin');
    expect(same(b, buildHiddenBin())).toBe(true);
    expect(same(b.subarray(HIDDEN.pngAt, HIDDEN.pngAt + hiddenPng().length), hiddenPng())).toBe(
      true,
    );
    expect(same(b.subarray(HIDDEN.zipAt, HIDDEN.zipAt + hiddenZip().length), hiddenZip())).toBe(
      true,
    );
  });

  it('the raster sample and its header', () => {
    const { data, hdr } = buildRaster();
    expect(same(sample('binary-raster.bin'), data)).toBe(true);
    expect(utf8Decode(sample('binary-raster.hdr'))).toBe(hdr);
  });
});

describe('Overview', () => {
  it('a .bin of noise with a PNG and a ZIP inside', async () => {
    const r = await run(sample('binary-hidden.bin'), {}, 'binary-hidden.bin');
    const info = kv(r);
    expect(info.get('Verdict')).toMatch(
      /^Unknown \/ raw data, entropy 8\.00 → encrypted or compressed$/,
    );
    expect(info.get('MD5')).toMatch(/^[0-9a-f]{32}$/);
    expect(info.get('SHA-256')).toMatch(/^[0-9a-f]{64}$/);
    const embedded = tables(r).find((t) => t.label?.startsWith('Embedded files'))!;
    expect(embedded.rows.map((row) => [row[0], row[2]])).toEqual([
      [HIDDEN.pngAt, 'PNG image'],
      [HIDDEN.zipAt, 'ZIP archive (also docx, xlsx, jar, apk, odt)'],
    ]);
    const flags = tables(r).find((t) => t.label?.startsWith('Flag-like'))!;
    expect(flags.rows).toEqual([
      [HIDDEN.textAt + 37, '0x6025', 'ascii', 'flag{carved_from_the_noise}'],
    ]);
    expect(text(r)).toContain('the Carving view extracts them');
  });

  it('a raw BIN: verdict, sector layout and hints, no bogus ISO echo', async () => {
    const r = await run(sample('disk-ftf-raw.bin'), {}, 'disk-ftf-raw.bin');
    const info = kv(r);
    expect(info.get('Verdict')).toBe('Raw CD image, 2352-byte sectors, Mode 1 (ISO 9660 inside)');
    expect(info.get('Track (.cue)')).toBe('MODE1/2352');
    expect(info.get('Volume label')).toBe('FTF_DISK');
    expect(text(r)).toContain('No embedded file signature found.');
    expect(text(r)).toContain('rebuilds a generic one');
  });

  it('ISO, FAT, MBR and text verdicts', async () => {
    expect(kv(await run(sample('disk-ftf.iso'))).get('Verdict')).toBe(
      'ISO 9660 CD image (2048-byte sectors)',
    );
    expect(kv(await run(sample('disk-ftf-fat12.img'))).get('Verdict')).toBe(
      'FAT12 filesystem image',
    );
    expect(kv(await run(withMbr(buildSampleFat()))).get('Verdict')).toBe(
      'Disk image with a partition table (MBR, one partition)',
    );
    expect(kv(await run(utf8Encode('just some text\n'.repeat(50)))).get('Verdict')).toBe(
      'Text (no binary structure)',
    );
    expect(kv(await run(new Uint8Array(4096))).get('Verdict')).toMatch(/^Mostly zero bytes/);
    const elf = sample('forensics-polyglot.png');
    expect(kv(await run(elf)).get('Verdict')).toBe('PNG image');
  });

  it('flags data after the end of the main structure and extracts it', async () => {
    const payload = utf8Encode('appended secret: flag{after_the_volume}\n');
    const iso = buildSampleIso();
    const r = await run(concatBytes(iso, payload), {}, 'with-tail.iso');
    expect(text(r)).toContain(
      `${payload.length} bytes follow the end of the main structure, from offset ${iso.length}`,
    );
    const tail = filesOf(r).find((f) => f.name.includes('-after-'))!;
    expect(utf8Decode(await content(tail))).toBe(utf8Decode(payload));
    expect(tables(r).find((t) => t.label?.startsWith('Flag-like'))!.rows[0]![3]).toBe(
      'flag{after_the_volume}',
    );
  });

  it('suggests the Numeric view for raw structured data, and spots CD audio sizes', async () => {
    const pcm = new Uint8Array(2352 * 100);
    const v = new DataView(pcm.buffer);
    for (let i = 0; i < pcm.length / 2; i++)
      v.setInt16(i * 2, Math.round(8000 * Math.sin(i / 20)), true);
    const r = await run(pcm, {}, 'track02.bin');
    expect(text(r)).toContain('try the Numeric view');
    expect(text(r)).toContain('CD audio track (CD-DA)');
  });
});

describe('Carving', () => {
  it('extracts the PNG and the ZIP byte for byte, and the ZIP holds note.txt', async () => {
    const r = await run(sample('binary-hidden.bin'), { view: 'carve' });
    const files = filesOf(r);
    expect(files.map((f) => f.name)).toEqual(['00003000.png', '00009000.zip']);
    expect(same(await content(files[0]!), hiddenPng())).toBe(true);
    const zip = await content(files[1]!);
    expect(same(zip, hiddenZip())).toBe(true);
    expect(strFromU8(unzipSync(zip)['note.txt']!)).toBe('carved from the middle');
  });

  it('honours "Only these types", the container option, and rejects unknown types', async () => {
    const only = await run(sample('binary-hidden.bin'), { view: 'carve', types: 'zip' });
    expect(filesOf(only).map((f) => f.name)).toEqual(['00009000.zip']);
    const png = buildPng(8, 8);
    const withZip = concatBytes(png, hiddenZip());
    const r = await run(withZip, { view: 'carve', container: true });
    expect(filesOf(r).map((f) => f.name)).toEqual([
      '00000000.png',
      `${png.length.toString(16).padStart(8, '0')}.zip`,
    ]);
    expect(text(await run(withZip, { view: 'carve' }))).toContain('PNG image at offset 0 ends at');
    await expect(run(withZip, { view: 'carve', types: 'png, nope' })).rejects.toThrow(ToolError);
  });

  it('looks inside a cooked ISO and warns about raw sectors', async () => {
    const iso = buildIso([{ path: '/PIC.PNG', data: hiddenPng() }]);
    const r = await run(iso, { view: 'carve' });
    const png = filesOf(r).find((f) => f.name.endsWith('.png'))!;
    expect(same(await content(png), hiddenPng())).toBe(true);
    expect(text(await run(cookedToRaw(iso), { view: 'carve' }))).toContain(
      'interleaved with sector headers',
    );
  });
});

describe('Disk image', () => {
  it('ISO 9660: lists the files and extracts them byte-exact', async () => {
    const r = await run(sample('disk-ftf.iso'), { view: 'disk' }, 'disk-ftf.iso');
    const listing = tables(r).find((t) => t.label?.startsWith('Files ('))!;
    expect(listing.rows.map((row) => row[0])).toEqual([
      '/DOCS/',
      '/DOCS/HELLO.TXT',
      '/DOCS/notes about the disk.txt',
      '/HIDDEN.TXT',
      '/README.TXT',
    ]);
    expect(listing.rows.find((row) => row[0] === '/HIDDEN.TXT')![4]).toBe('hidden');
    const files = filesOf(r);
    for (const spec of ISO_FILES) {
      const name = (spec.longName ?? spec.path).replace(/^\//, '');
      const f = files.find((x) => x.name === name)!;
      expect(same(await content(f), spec.data)).toBe(true);
    }
    expect(utf8Decode(await content(files.find((f) => f.name === 'disk-ftf.cue')!))).toBe(
      'FILE "disk-ftf.iso" BINARY\r\n  TRACK 01 MODE1/2048\r\n    INDEX 01 00:00:00\r\n',
    );
  });

  it('raw BIN: rebuilt .cue, the cooked .iso identical to the original, files byte-exact', async () => {
    const r = await run(sample('disk-ftf-raw.bin'), { view: 'disk' }, 'disk-ftf-raw.bin');
    const info = kv(r);
    expect([
      info.get('Sector size'),
      info.get('Mode'),
      info.get('Track (.cue)'),
      info.get('EDC (sector 16)'),
    ]).toEqual(['2352', 'Mode 1', 'MODE1/2352', 'valid']);
    const files = filesOf(r);
    const cue =
      'FILE "disk-ftf-raw.bin" BINARY\r\n  TRACK 01 MODE1/2352\r\n    INDEX 01 00:00:00\r\n';
    expect(utf8Decode(await content(files.find((f) => f.name === 'disk-ftf-raw.cue')!))).toBe(cue);
    expect(r.some((o) => o.type === 'text' && o.value === cue)).toBe(true);
    const cooked = await content(files.find((f) => f.name === 'disk-ftf-raw.iso')!);
    expect(same(cooked, sample('disk-ftf.iso'))).toBe(true);
    expect(
      same(await content(files.find((f) => f.name === 'README.TXT')!), ISO_FILES[0]!.data),
    ).toBe(true);
  });

  it('Mode 2 and 2336-byte images give the same files', async () => {
    const big = noise(9000, 3);
    const iso = buildIso([{ path: '/BIG.BIN', data: big }]);
    for (const [bytes, mode] of [
      [cookedToRaw(iso, 'mode2'), 'MODE2/2352'],
      [cookedToRaw(iso, '2336'), 'MODE2/2336'],
    ] as const) {
      const r = await run(bytes, { view: 'disk' });
      expect(kv(r).get('Track (.cue)')).toBe(mode);
      expect(same(await content(filesOf(r).find((f) => f.name === 'BIG.BIN')!), big)).toBe(true);
    }
  });

  it('a file bigger than the in-memory limit comes out of a raw image as a Blob, byte-exact', async () => {
    const big = noise(1_500_000, 8);
    const r = await run(cookedToRaw(buildIso([{ path: '/HUGE.BIN', data: big }])), {
      view: 'disk',
    });
    const f = filesOf(r).find((x) => x.name === 'HUGE.BIN')!;
    expect(f.blob).toBeInstanceOf(Blob);
    expect(f.data.length).toBe(0);
    expect(same(await content(f), big)).toBe(true);
  });

  it('reports sectors after the end of the ISO volume', async () => {
    const raw = concatBytes(
      cookedToRaw(buildSampleIso()),
      cookedToRaw(utf8Encode('hidden after the volume'.padEnd(2048))),
    );
    expect(text(await run(raw, { view: 'disk' }))).toContain(
      'One sector follows the end of the ISO 9660 volume (sector 31)',
    );
  });

  it('FAT12: the deleted file is listed and recovered intact', async () => {
    const r = await run(sample('disk-ftf-fat12.img'), { view: 'disk' });
    const listing = tables(r)[0]!;
    const del = listing.rows.find((row) => row[0] === '/old-secret.txt')!;
    expect(del[5]).toBe('deleted, recoverable');
    expect(listing.highlight).toEqual([listing.rows.indexOf(del)]);
    const files = filesOf(r);
    const spec = FAT_FILES.find((f) => f.deleted)!;
    expect(
      same(await content(files.find((f) => f.name === 'deleted/old-secret.txt')!), spec.data!),
    ).toBe(true);
    expect(
      same(
        await content(files.find((f) => f.name === 'DOCS/A long file name.txt')!),
        FAT_FILES[3]!.data!,
      ),
    ).toBe(true);
    expect(text(r)).toContain('One deleted entry');
  });

  it('FAT inside an MBR partition', async () => {
    const r = await run(withMbr(buildSampleFat()), { view: 'disk' });
    expect(tables(r)[0]!.rows[0]).toEqual([
      1,
      'FAT12 (0x01)',
      '32256 (0x7e00)',
      '180.0 KiB',
      '*',
      '',
    ]);
    expect(text(r)).toContain('Partition 1: FAT12 volume');
    expect(filesOf(r).map((f) => f.name)).toContain('deleted/old-secret.txt');
  });

  it('wraps CD audio as WAV, and says when there is no disk structure', async () => {
    const pcm = noise(2352 * 80, 4).map((x) => x & 0x0f);
    const r = await run(pcm, { view: 'disk' }, 'track.bin');
    const wav = await content(filesOf(r)[0]!);
    expect(utf8Decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(wav.length).toBe(44 + pcm.length);
    expect(text(await run(noise(5000, 5), { view: 'disk' }))).toContain(
      'No disk image structure found',
    );
  });
});

describe('Hexdump and search', () => {
  it('dumps a window and searches the whole file', async () => {
    const r = await run(sample('disk-ftf.iso'), { view: 'hex', offset: '0x8000', length: '32' });
    const dump = r.find((o) => o.type === 'text')!;
    expect(dump.type === 'text' && dump.value.split('\n')[0]).toBe(
      '00008000: 0143 4430 3031 0100 2020 2020 2020 2020  .CD001..        ',
    );
    const bytes = r.find((o) => o.type === 'bytes')!;
    expect(bytes.type === 'bytes' && bytes.value.length).toBe(32);
    const s = await run(sample('binary-hidden.bin'), { view: 'hex', search: 'wide text' });
    expect(tables(s)[0]!.rows.map((row) => [row[0], row[2]])).toEqual([[HIDDEN.wideAt, 'utf16le']]);
    const h = await run(sample('binary-hidden.bin'), { view: 'hex', search: '50 4b 05 06' });
    expect(tables(h)[0]!.rows.length).toBe(1);
    const re = await run(sample('binary-hidden.bin'), { view: 'hex', search: '/flag\\{\\w+\\}/' });
    expect(tables(re)[0]!.rows[0]![0]).toBe(HIDDEN.textAt + 37);
  });

  it('negative offsets count from the end; bad numbers and regexes are clear errors', async () => {
    const b = sample('binary-hidden.bin');
    const r = await run(b, { view: 'hex', offset: '-16', length: '64' });
    const bytes = r.find((o) => o.type === 'bytes')!;
    expect(bytes.type === 'bytes' && same(bytes.value, b.subarray(b.length - 16))).toBe(true);
    await expect(run(b, { view: 'hex', offset: 'abc' })).rejects.toThrow(/is not a number/);
    await expect(run(b, { view: 'hex', offset: '0x999999' })).rejects.toThrow(ToolError);
    await expect(run(b, { view: 'hex', search: '/(/' })).rejects.toThrow(/regular expression/);
    expect(text(await run(b, { view: 'hex', length: '2m' }))).toContain(
      'Length limited to 1.00 MiB',
    );
    await expect(run(new Uint8Array(0))).rejects.toThrow('The file is empty.');
  });
});

describe('Strings, Numeric and Entropy', () => {
  it('strings: flag-like first, UTF-16 found, filter applied', async () => {
    const r = await run(sample('binary-hidden.bin'), { view: 'strings' });
    const t = tables(r)[0]!;
    expect(t.rows[0]).toEqual(['0x6025', 'ascii', 'flag{carved_from_the_noise}']);
    expect(t.rows).toContainEqual(['0x6800', 'utf16le', 'wide text hides here']);
    const f = await run(sample('binary-hidden.bin'), { view: 'strings', filter: '/hides/' });
    expect(tables(f)[0]!.rows).toEqual([['0x6800', 'utf16le', 'wide text hides here']]);
  });

  it('numeric: the ENVI raster sample', async () => {
    const hdr = { bytes: sample('binary-raster.hdr'), name: 'binary-raster.hdr' };
    const r = await run(sample('binary-raster.bin'), { view: 'numeric', envi: hdr });
    const info = kv(r);
    expect([info.get('Shape'), info.get('Data type'), info.get('NaN'), info.get('Band')]).toEqual([
      '48 × 64',
      'float32 (4 bytes each)',
      '1',
      '1 (ramp with a ring)',
    ]);
    await expect(
      run(sample('binary-raster.bin'), { view: 'numeric', envi: hdr, band: 2 }),
    ).rejects.toThrow('Band 2 does not exist: the header declares a single band.');
  });

  it('numeric: plain reading with a reshape, and shape hints', async () => {
    const r = await run(sample('binary-raster.bin'), {
      view: 'numeric',
      dtype: 'float32',
      rows: 48,
      cols: 64,
    });
    const img = r.find((o) => o.type === 'image')!;
    expect(img.type === 'image' && [img.image.width, img.image.height]).toEqual([64, 48]);
    const n = await run(sample('binary-raster.bin'), { view: 'numeric', dtype: 'float32' });
    expect(text(n)).toContain('Possible shapes (rows × columns): 48 × 64');
  });

  it('entropy: chart, regions, histogram', async () => {
    const data = concatBytes(new Uint8Array(64 * 1024), noise(64 * 1024, 6));
    const r = await run(data, { view: 'entropy', block: 4096 });
    expect(kv(r).get('Block size (blocks)')).toBe('4096 (32)');
    const regions = tables(r)[0]!;
    expect(regions.rows).toEqual([
      ['0x10000', '0x20000', 65536, expect.any(String), expect.any(String)],
    ]);
    expect(r.filter((o) => o.type === 'image').length).toBe(2);
    await expect(run(data, { view: 'entropy', block: 1 })).rejects.toThrow(ToolError);
  });
});

describe('triage', () => {
  const detect = (bytes: Uint8Array, name?: string) => tool.detect!({ text: null, bytes, name });
  it('recognises disk images and unknown binaries', () => {
    expect(detect(sample('disk-ftf.iso'))).toMatchObject({ score: 0.8, options: { view: 'disk' } });
    expect(detect(sample('disk-ftf-raw.bin'))).toMatchObject({
      score: 0.8,
      reason: 'Raw CD image (2352-byte sectors)',
    });
    expect(detect(sample('disk-ftf-fat12.img'))).toMatchObject({
      score: 0.75,
      reason: 'FAT boot sector',
    });
    expect(detect(withMbr(buildSampleFat()))).toMatchObject({ score: 0.75 });
    expect(detect(sample('binary-hidden.bin'))!.score).toBe(0.65);
    expect(detect(new Uint8Array(4096), 'dump.bin')!.score).toBe(0.6);
    expect(detect(sample('forensics-polyglot.png'))).toBeNull();
    expect(
      tool.detect!({
        text: 'hello world '.repeat(100),
        bytes: utf8Encode('hello world '.repeat(100)),
      }),
    ).toBeNull();
  });
});

describe('big files are streamed', () => {
  it('a 256 MiB file: Overview without any read above 8 MiB, every repeat of the PNG found', async () => {
    // One 4 MiB unit = the end of a PNG, noise, the start of the PNG; repeated (by reference,
    // never copied), every PNG straddles the edge between two scan windows.
    const png = hiddenPng();
    const unit = new Blob([
      concatBytes(
        png.subarray(150),
        noise((4 << 20) - png.length, 77),
        png.subarray(0, 150),
      ) as BlobPart,
    ]);
    const big = new Blob(Array.from({ length: 64 }, () => unit));
    expect(big.size).toBe(256 << 20);
    const f = fileOf(big, 'big.bin');
    const sizes: number[] = [];
    const read = f.read.bind(f);
    f.read = (o, l) => (sizes.push(l), read(o, l));
    const t0 = Date.now();
    const r = await run(f);
    const ms = Date.now() - t0;
    expect(Math.max(...sizes)).toBeLessThanOrEqual(8 << 20);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThan(big.size * 1.1);
    const embedded = tables(r).find((t) => t.label?.startsWith('Embedded files'))!;
    expect(embedded.label).toBe('Embedded files (64)');
    // 63 whole PNGs across window edges, and one cut by the end of the file (the Overview
    // table shows 50 of them).
    expect(embedded.rows.map((row) => [row[0], row[3], row[4]])).toEqual(
      Array.from({ length: 50 }, (_, i) => [(i + 1) * (4 << 20) - 150, png.length, 'IEND chunk']),
    );
    expect(text(r)).toContain('14 more in the Carving view.');
    expect(ms).toBeLessThan(30_000);
    const carved = filesOf(await run(f, { view: 'carve' }));
    expect(carved.length).toBe(64);
    expect(same(await content(carved[10]!), png)).toBe(true);
    expect(carved[63]!.note).toContain('end of file');
    expect(Math.max(...sizes)).toBeLessThanOrEqual(8 << 20);
  }, 120_000);
});
