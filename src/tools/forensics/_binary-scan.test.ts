import { readFileSync } from 'node:fs';
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { lazyFile } from '../../core/prepare';
import { concatBytes, utf8Encode } from '../../lib/bytes';
import { COPY_BUDGET, Extractor, INLINE_MAX, readRange, windows } from './_binary-stream';
import {
  carveFile,
  EntropyCollector,
  fastScan,
  findFlagsIn,
  findStringsFast,
  searchFile,
  stringsFile,
  type FlagHit,
} from './_binary-scan';
import { scan } from './carve';
import { analyse } from './entropy';
import { findStrings } from './strings';
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
  noise,
} from './_fixtures';
import { buildHiddenBin, buildSampleFat, buildSampleIso } from './_disk-fixtures';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));
const fileOf = (b: Uint8Array, name = 'x.bin') => lazyFile(new Blob([b as BlobPart]), name);
const utf16le = (s: string) => {
  const out = new Uint8Array(s.length * 2);
  [...s].forEach((c, i) => (out[i * 2] = c.charCodeAt(0)));
  return out;
};
const utf16be = (s: string) => {
  const out = new Uint8Array(s.length * 2);
  [...s].forEach((c, i) => (out[i * 2 + 1] = c.charCodeAt(0)));
  return out;
};

/** Every builder of _fixtures buried in noise: a realistic mix for the scanners. */
function mixed(): Uint8Array {
  const parts: Uint8Array[] = [noise(333, 1)];
  const files = [
    buildPng(),
    buildGif(),
    buildJpeg(),
    buildBmp(),
    buildWav(),
    buildElf64(),
    buildPe(),
    build7z(),
    buildSqlite(),
    buildPdf(),
    buildTar([['a.txt', utf8Encode('tar entry')]]),
    buildZip([{ name: 'z.txt', data: utf8Encode('zipped text '.repeat(20)) }]),
    gzipSync(utf8Encode('gzip member '.repeat(50))),
  ];
  files.forEach((f, i) => parts.push(f, noise(257 + i * 31, 10 + i)));
  return concatBytes(...parts);
}

const BUFFERS: [string, Uint8Array][] = [
  ['noise', noise(1 << 18, 5)],
  ['mixed fixtures', mixed()],
  ['binary-hidden.bin', buildHiddenBin()],
  ['ISO', buildSampleIso()],
  ['FAT12', buildSampleFat()],
  ['forensics-polyglot.png', sample('forensics-polyglot.png')],
  ['forensics-strings.bin', sample('forensics-strings.bin')],
];

describe('fastScan gives exactly the answer of Carve’s scan', () => {
  it.each(BUFFERS)('%s', (_name, b) => {
    const slow = scan(b).map((h) => [h.start, h.sig.id]);
    expect(fastScan(b).map((h) => [h.start, h.sig.id])).toEqual(slow);
  });

  it('honours the type filter and the [lo, hi) range of starts', () => {
    const b = mixed();
    const pngOnly = fastScan(b, new Set(['png'])).map((h) => h.sig.id);
    expect(pngOnly).toEqual(['png']);
    const all = fastScan(b);
    const mid = all[Math.floor(all.length / 2)]!.start;
    expect(fastScan(b, new Set(), mid, b.length).map((h) => h.start)).toEqual(
      all.filter((h) => h.start >= mid).map((h) => h.start),
    );
  });
});

describe('findStringsFast gives exactly findStrings’ answer', () => {
  const mix = new Uint8Array(100_000);
  for (let i = 0; i < mix.length; i++) {
    const r = (i * 7919 + (i >> 3) * 31) % 97;
    mix[i] = r < 40 ? 0 : r < 80 ? 0x41 + (r % 26) : r;
  }
  it.each([...BUFFERS, ['short UTF-16 / ASCII runs', mix] as [string, Uint8Array]])(
    '%s',
    (_n, b) => {
      for (const min of [2, 4, 6, 10]) expect(findStringsFast(b, min)).toEqual(findStrings(b, min));
    },
  );
});

describe('carving across window boundaries', () => {
  const png = buildPng(40, 30);
  const zip = buildZip([{ name: 'note.txt', data: utf8Encode('straddling the chunk edge') }]);

  it('finds a PNG and a ZIP that straddle chunk edges, with exact ends', async () => {
    const data = noise(20_000, 3);
    data.set(png, 4096 - 100); // crosses the first 4 KiB edge
    data.set(zip, 3 * 4096 - 10);
    const small = await carveFile(
      fileOf(data),
      { container: false, nested: false, only: new Set() },
      4096,
    );
    const big = await carveFile(fileOf(data), { container: false, nested: false, only: new Set() });
    const pick = (r: typeof small) => r.found.map((f) => [f.start, f.end, f.sig.id, f.kind]);
    expect(pick(small)).toEqual(pick(big));
    expect(pick(small)).toEqual([
      [3996, 3996 + png.length, 'png', 'structure'],
      [12278, 12278 + zip.length, 'zip', 'structure'],
    ]);
  });

  it('a signature whose magic sits far from its start (ISO 9660 at 0x8001) is found once', async () => {
    const iso = buildSampleIso();
    const data = concatBytes(noise(5000, 4), iso, noise(3000, 5));
    const r = await carveFile(
      fileOf(data),
      { container: false, nested: false, only: new Set(['iso']) },
      8192,
    );
    expect(r.found.map((f) => [f.start, f.end - f.start, f.sig.id])).toEqual([
      [5000, iso.length, 'iso'],
    ]);
  });

  it('a file longer than the look-ahead gets its end from a bigger read', async () => {
    const huge = buildZip([{ name: 'big.bin', data: noise(300_000, 6), method: 0 }]);
    const data = concatBytes(noise(1000, 7), huge, noise(1000, 8));
    const r = await carveFile(
      fileOf(data),
      { container: false, nested: false, only: new Set() },
      4096,
    );
    const z = r.found.find((f) => f.sig.id === 'zip')!;
    expect([z.start, z.end, z.kind]).toEqual([1000, 1000 + huge.length, 'structure']);
  });

  it('a gzip member longer than the look-ahead is still validated', async () => {
    const gz = gzipSync(noise(200_000, 9), { level: 0 });
    const data = concatBytes(noise(100, 10), gz, noise(100, 11));
    const r = await carveFile(
      fileOf(data),
      { container: false, nested: false, only: new Set(['gz']) },
      4096,
    );
    expect(r.found.map((f) => [f.start, f.end, f.sig.id])).toEqual([
      [100, 100 + gz.length, 'gzip'],
    ]);
  });

  it('marks a file whose size field runs past the end of the input as truncated', async () => {
    const bmp = buildBmp();
    const data = concatBytes(noise(64, 13, false), bmp.subarray(0, bmp.length - 10));
    const r = await carveFile(fileOf(data), {
      container: false,
      nested: false,
      only: new Set(['bmp']),
    });
    expect(r.found.map((f) => [f.start, f.end, f.kind, f.exact])).toEqual([
      [64, data.length, 'truncated', true],
    ]);
  });
});

describe('strings across window boundaries', () => {
  it('reports a string that straddles two chunks once, complete', async () => {
    const data = noise(30_000, 20, false);
    const text = 'this string crosses the chunk boundary';
    data.set(utf8Encode(text), 8192 - 15);
    data.set(utf16le('wide one too'), 4 * 4096 - 7);
    const r = await stringsFile(fileOf(data), 6, null, 1000, 4096);
    const got = r.rest.map((s) => [s.offset, s.encoding, s.text]);
    expect(got).toEqual([
      [8192 - 15, 'ascii', text],
      [4 * 4096 - 7, 'utf16le', 'wide one too'],
    ]);
  });

  it('a string longer than the look-ahead is reported once', async () => {
    const data = concatBytes(
      new Uint8Array(100),
      utf8Encode('A'.repeat(70_000)),
      new Uint8Array(100),
    );
    const r = await stringsFile(fileOf(data), 4, null, 10, 4096);
    expect(r.total).toBe(1);
    expect(r.rest[0]!.offset).toBe(100);
  });

  it('puts flag-like strings first and applies the filter', async () => {
    const data = concatBytes(
      noise(500, 21, false),
      utf8Encode('hello world'),
      noise(9000, 22, false),
      utf16be('flag{be_wide}'),
    );
    const r = await stringsFile(fileOf(data), 6, (s) => /flag|hello/.test(s), 10, 4096);
    expect(r.flagged.map((s) => [s.encoding, s.text])).toEqual([['utf16be', 'flag{be_wide}']]);
    expect(r.rest.map((s) => s.text)).toEqual(['hello world']);
  });
});

describe('flag-like text', () => {
  it('finds ASCII, UTF-16LE and UTF-16BE flags with their offsets', () => {
    const b = concatBytes(
      noise(100, 30, false),
      utf8Encode('xx CTF{ascii_one} '),
      utf16le('flag{le_one}'),
      noise(50, 31, false),
      utf16be('HTB{be_one}'),
    );
    const out: FlagHit[] = [];
    findFlagsIn(b, 0, b.length, 1000, out, 10);
    expect(out.map((f) => [f.offset, f.encoding, f.text])).toEqual([
      [1000 + 103, 'ascii', 'CTF{ascii_one}'],
      [1000 + 118, 'utf16le', 'flag{le_one}'],
      [1000 + 118 + 24 + 50, 'utf16be', 'HTB{be_one}'],
    ]);
  });

  it('ignores braces that are not flags, and random-looking short ones', () => {
    const out: FlagHit[] = [];
    const b = utf8Encode(
      '{} a{b} x{ y } function() { return 1; } ab{c d} jm{*d} KG{1l3} key{ok} sQr{%=i~} abc{defghijk}',
    );
    findFlagsIn(b, 0, b.length, 0, out, 10);
    // Short random-looking candidates are dropped; known prefixes and longer ones stay.
    expect(out.map((f) => f.text)).toEqual(['key{ok}', 'abc{defghijk}']);
  });

  it('drops printable bytes glued in front of a flag{ prefix', () => {
    const out: FlagHit[] = [];
    // A random byte that happens to be a letter ("F") right before the flag, in ASCII and UTF-16LE.
    const ascii = utf8Encode('\x01Fflag{streamed_through}\x02');
    const wide = new Uint8Array([...'\x01xflag{wide_one}'].flatMap((c) => [c.charCodeAt(0), 0]));
    findFlagsIn(ascii, 0, ascii.length, 0, out, 10);
    findFlagsIn(wide, 0, wide.length, 1000, out, 10);
    expect(out.map((f) => [f.offset, f.encoding, f.text])).toEqual([
      [2, 'ascii', 'flag{streamed_through}'],
      [1004, 'utf16le', 'flag{wide_one}'],
    ]);
  });
});

describe('search across window boundaries', () => {
  it('finds bytes that straddle a chunk edge, and caps the hits', async () => {
    const data = noise(20_000, 40, false);
    data.set([0xde, 0xad, 0xbe, 0xef], 4096 - 2);
    data.set([0xde, 0xad, 0xbe, 0xef], 10_000);
    const q = {
      kind: 'bytes' as const,
      needles: [{ bytes: Uint8Array.of(0xde, 0xad, 0xbe, 0xef), encoding: 'hex' }],
    };
    const r = await searchFile(fileOf(data), q, 100, 4096);
    expect(r.hits.map((h) => h.offset)).toEqual([4094, 10_000]);
    expect(r.hits[0]!.context.subarray(0, 4)).toEqual(Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
    const capped = await searchFile(
      fileOf(new Uint8Array(5000).fill(0x41)),
      { kind: 'bytes', needles: [{ bytes: utf8Encode('AA'), encoding: 'ascii' }] },
      50,
      1024,
    );
    expect(capped.hits.length).toBe(50);
    expect(capped.capped).toBe(true);
  });

  it('runs a regular expression over the bytes read as Latin-1', async () => {
    const data = concatBytes(
      noise(4090, 41, false),
      utf8Encode('key=s3cr3t;'),
      noise(100, 42, false),
    );
    const r = await searchFile(fileOf(data), { kind: 'regex', re: /key=\w+/ }, 10, 4096);
    expect(r.hits.map((h) => [h.offset, h.length])).toEqual([[4090, 10]]);
  });
});

describe('streamed entropy', () => {
  it('matches the Entropy tool on the whole buffer, whatever the chunk size', async () => {
    const b = concatBytes(new Uint8Array(5000), noise(9000, 50), utf8Encode('text '.repeat(400)));
    const ref = analyse(b, 1024);
    for (const chunk of [1000, 4096, 1 << 20]) {
      const e = new EntropyCollector(b.length, 1024);
      for await (const w of windows(fileOf(b), { chunk, overlap: 77, lead: 13 }))
        e.add(w.bytes, w.ownStart, w.ownEnd);
      expect(e.blocks).toEqual(ref.blocks);
      expect(e.overall).toBeCloseTo(ref.overall, 12);
    }
  });
});

describe('bounded reads', () => {
  it('readRange never asks for more than 8 MiB at once, and windows stay small', async () => {
    const bytes = noise(17 << 20, 60);
    const f = fileOf(bytes);
    const sizes: number[] = [];
    const read = f.read.bind(f);
    f.read = (o, l) => (sizes.push(l), read(o, l));
    const got = await readRange(f, 5, 17 << 20);
    expect(Buffer.from(got).equals(Buffer.from(bytes.subarray(5)))).toBe(true);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(8 << 20);
    sizes.length = 0;
    for await (const w of windows(f, { chunk: 1 << 20, overlap: 4096 })) {
      expect(w.bytes.length).toBeLessThanOrEqual((1 << 20) + 4096);
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual((1 << 20) + 4096);
  });
});

describe('Extractor', () => {
  it('copies small files, slices big ones for free, and stops at the limits', async () => {
    const f = fileOf(noise(3 << 20, 70));
    const x = new Extractor(3);
    await x.slice(f, 0, 10, 'small');
    await x.slice(f, 0, INLINE_MAX + 1, 'big');
    expect([x.files[0]!.data.length, x.files[0]!.blob]).toEqual([10, undefined]);
    expect([x.files[1]!.data.length, x.files[1]!.blob?.size]).toEqual([0, INLINE_MAX + 1]);
    // A slice costs nothing: a file bigger than the copy budget is still handed out.
    await x.slice(f, 0, f.size, 'whole');
    expect(x.files[2]!.blob?.size).toBe(f.size);
    await x.slice(f, 0, 1, 'fourth');
    expect([x.files.length, x.skippedCount, x.skippedCopy]).toEqual([3, 1, 0]);
    const y = new Extractor();
    let copies = 0;
    for (let i = 0; i < 100; i++) if (y.copyOk(INLINE_MAX)) copies++;
    expect(copies).toBe(COPY_BUDGET / INLINE_MAX);
    // Once the copy budget is spent, small files come out as slices too.
    await y.slice(f, 0, 10, 'small');
    expect(y.files[0]!.blob?.size).toBe(10);
  });
});
