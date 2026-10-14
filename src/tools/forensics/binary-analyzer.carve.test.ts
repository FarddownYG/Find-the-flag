/**
 * Carving, Overview identification, Strings and search of the Binary analyzer, on files built
 * here: real PNG / JPEG / GIF / ZIP / GZIP / PDF / ELF / PE structures buried in noise at
 * awkward offsets (window edges, back to back, decoys), each expected byte for byte.
 */
import { encode as encodePng } from 'fast-png';
import { gzipSync, strToU8, zipSync } from 'fflate';
import * as jpegNs from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import { concatBytes, utf8Encode } from '../../lib/bytes';
import { crc32, SIGNATURES } from '../../lib/signatures';
import { buildElf64, buildJpeg, buildPng, buildZip, noise } from './_fixtures';
import {
  content,
  fileNamed,
  filesOf,
  kv,
  notes,
  run,
  same,
  table,
  texts,
  utf16le,
} from './_binary-test-kit';

type JpegApi = Pick<typeof jpegNs, 'encode'>;
const jpeg: JpegApi =
  typeof jpegNs.encode === 'function'
    ? jpegNs
    : (jpegNs as unknown as { default: JpegApi }).default;

const nameOf = (id: string) => SIGNATURES.find((s) => s.id === id)!.name;
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const hex8 = (n: number) => n.toString(16).padStart(8, '0');

// ---------------------------------------------------------------- real files

function rgbPng(w: number, h: number, seed = 1): Uint8Array {
  return encodePng({ width: w, height: h, data: noise(w * h * 3, seed), depth: 8, channels: 3 });
}

function realJpeg(w: number, h: number, quality = 80): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([(i * 7) & 255, (i * 3) & 255, i & 255, 255], i * 4);
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, quality).data);
}

/** GIF89a 4 × 4 whose comment holds ';', the trailer byte. */
function gifWithComment(): Uint8Array {
  return Uint8Array.from([
    ...latin1('GIF89a'),
    4, 0, 4, 0, 0x80, 0, 0,
    0, 0, 0, 255, 255, 255,
    0x21, 0xfe, 9, ...latin1('a;b;c;d;e'), 0,
    0x2c, 0, 0, 0, 0, 4, 0, 4, 0, 0,
    2, 4, 0x84, 0x8f, 0xa9, 0x0b, 0,
    0x3b,
  ]); // prettier-ignore
}

/** A PDF 1.4 with a real xref table; `update` appends an incremental update. */
function realPdf(update = false): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>',
  ];
  const pad = (n: number) => String(n).padStart(10, '0');
  let s = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(s.length);
    s += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) s += `${pad(o)} 00000 n \n`;
  s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  if (update) {
    const obj = s.length;
    s += '4 0 obj\n<< /Producer (incremental update) >>\nendobj\n';
    const x2 = s.length;
    s += `xref\n4 1\n${pad(obj)} 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R /Prev ${xref} >>\nstartxref\n${x2}\n%%EOF\n`;
  }
  return latin1(s);
}

/** PE32 for i386 with two sections; the file is 0x600 bytes, the end of the last section. */
function pe32(): Uint8Array {
  const out = new Uint8Array(0x600);
  const v = new DataView(out.buffer);
  out.set(latin1('MZ'));
  v.setUint32(0x3c, 0x80, true);
  out.set(latin1('PE\0\0'), 0x80);
  v.setUint16(0x84, 0x14c, true);
  v.setUint16(0x86, 2, true);
  v.setUint16(0x94, 0xe0, true);
  v.setUint16(0x96, 0x0102, true);
  const opt = 0x98;
  v.setUint16(opt, 0x10b, true);
  v.setUint32(opt + 60, 0x200, true);
  v.setUint32(opt + 92, 16, true);
  const table = opt + 0xe0;
  out.set(latin1('.text'), table);
  v.setUint32(table + 16, 0x200, true);
  v.setUint32(table + 20, 0x200, true);
  out.set(latin1('.data'), table + 40);
  v.setUint32(table + 40 + 16, 0x200, true);
  v.setUint32(table + 40 + 20, 0x400, true);
  out.fill(0xcc, 0x200, 0x600);
  return out;
}

const zip2 = () =>
  zipSync(
    { 'readme.txt': strToU8('two entries in this zip\n'.repeat(40)), 'data.bin': noise(3000, 9) },
    { mtime: new Date('2024-01-15T12:30:00Z') },
  );
const gz = () =>
  gzipSync(strToU8('gzip member with a name\n'.repeat(200)), { filename: 'member.txt', mtime: 0 });

/** Data buried in noise at fixed offsets. */
function bury(size: number, seed: number, items: [number, Uint8Array][]): Uint8Array {
  const out = noise(size, seed);
  for (const [at, b] of items) out.set(b, at);
  return out;
}

const carvedRows = (r: ToolResult) => table(r, 'Embedded files')?.rows ?? [];
const carved = async (input: Uint8Array, opts = {}, name = 'input.bin') =>
  run(input, { view: 'carve', ...opts }, name);

// ---------------------------------------------------------------- eight formats at once

const MIXED: [number, Uint8Array, string][] = [
  [0x1001, rgbPng(16, 16), 'png'],
  [0x20003, realJpeg(24, 24), 'jpeg'],
  [0x30005, gifWithComment(), 'gif'],
  [0x40007, zip2(), 'zip'],
  [0x50009, gz(), 'gzip'],
  [0x6000b, realPdf(), 'pdf'],
  [0x7000d, buildElf64(), 'elf'],
  [0x8000f, pe32(), 'pe'],
];
const mixed = bury(
  1 << 20,
  3,
  MIXED.map(([at, b]) => [at, b]),
);

describe('carving eight formats from noise', () => {
  it('exact offsets and sizes, byte-identical files, nothing else', async () => {
    const r = await carved(mixed);
    expect(carvedRows(r).map((row) => [row[0], row[3]])).toEqual(
      MIXED.map(([at, b]) => [at, b.length]),
    );
    for (const [at, b, id] of MIXED) {
      const sig = SIGNATURES.find((s) => s.id === id)!;
      expect(same(await content(fileNamed(r, `${hex8(at)}.${sig.ext}`)), b), id).toBe(true);
    }
  });

  it('the Overview lists the same files', async () => {
    const r = await run(mixed);
    expect(carvedRows(r).map((row) => [row[0], row[2], row[3]])).toEqual(
      MIXED.map(([at, b, id]) => [at, nameOf(id), b.length]),
    );
  });

  it('"Only these types" keeps the named ones, and rejects unknown names', async () => {
    const data = bury(384 << 10, 4, [
      [0x1001, MIXED[0]![1]],
      [0x40007, MIXED[3]![1]],
      [0x50009, MIXED[4]![1]],
    ]);
    const ids = async (types: string) =>
      carvedRows(await carved(data, { types })).map((row) => row[0]);
    expect(await ids('png')).toEqual([0x1001]);
    expect(await ids('zip, gzip')).toEqual([0x40007, 0x50009]);
    expect(await ids('PNG')).toEqual([0x1001]);
    await expect(carved(data, { types: 'foo' })).rejects.toThrow(ToolError);
  });

  it('the end column says it is exclusive', async () => {
    const r = await carved(mixed);
    const t = table(r, 'Embedded files')!;
    expect(t.columns[4]).toBe('End (exclusive)');
    expect(t.rows[0]![4]).toBe(`0x${(0x1001 + MIXED[0]![1].length).toString(16)}`);
  });
});

describe('carving across window edges and inside other files', () => {
  it('files straddling the 2, 4 and 8 MiB edges, and a ZIP ending at the end of the file', async () => {
    const MiB = 1 << 20;
    const a = rgbPng(48, 40, 2);
    const b = rgbPng(64, 64, 3);
    const c = realJpeg(40, 40);
    const z = zip2();
    const size = 9 * MiB;
    const items: [number, Uint8Array][] = [
      [2 * MiB - 3001, a],
      [4 * MiB - 4, b],
      [8 * MiB - 1, c],
      [size - z.length, z],
    ];
    const data = bury(size, 41, items);
    for (const view of ['carve', 'overview']) {
      const r = await run(data, { view });
      expect(
        carvedRows(r).map((row) => [row[0], row[3]]),
        view,
      ).toEqual(items.map(([at, x]) => [at, x.length]));
    }
    const r = await carved(data);
    for (const [at, x] of items) {
      const f = filesOf(r).find((y) => y.name.startsWith(hex8(at)))!;
      expect(same(await content(f), x)).toBe(true);
    }
  }, 60_000);

  const inner = buildPng(20, 16);
  const nestedZip = zipSync({
    'readme.txt': strToU8('a zip with a png stored inside\n'.repeat(20)),
    'data/bin.dat': noise(2000, 12),
    'inner.png': [inner, { level: 0 }],
  });
  const zipAt = 0x12345;
  const data = bury(256 << 10, 13, [[zipAt, nestedZip]]);

  it('a ZIP holding a stored PNG: only the ZIP by default', async () => {
    const r = await carved(data);
    expect(carvedRows(r).map((row) => [row[0], row[3]])).toEqual([[zipAt, nestedZip.length]]);
    expect(same(await content(filesOf(r)[0]!), nestedZip)).toBe(true);
    expect(notes(r).join('\n')).toMatch(/sit inside the files above/);
  });

  it('with nested matches: the stored PNG too, and the ZIP entries are not called archives', async () => {
    const r = await carved(data, { nested: true });
    const pngAt = zipAt + Buffer.from(nestedZip).indexOf(Buffer.from(inner.subarray(0, 16)));
    const rows = carvedRows(r).map((row) => [row[0], row[2], row[3]]);
    expect(rows.slice(0, 2)).toEqual([
      [zipAt, nameOf('zip'), nestedZip.length],
      [pngAt, nameOf('png'), inner.length],
    ]);
    // Deeper still, only the zlib stream of the PNG's IDAT; no ZIP entry posing as an archive.
    expect(rows.slice(2).map((row) => row[1])).toEqual([expect.stringMatching(/^zlib stream/)]);
    expect(same(await content(filesOf(r)[1]!), inner)).toBe(true);
    expect(notes(r)).toContain(
      '2 more ZIP local headers belong to the archives above (they are their entries): they are not listed as other archives. The Archive extractor lists and extracts the entries.',
    );
  });

  it('pure noise gives no false positive', async () => {
    const r = await carved(noise(8 << 20, 0xc0ffee));
    expect(carvedRows(r)).toEqual([]);
    expect(notes(await run(noise(8 << 20, 0xc0ffee)))).toContain(
      'No embedded file signature found.',
    );
  });

  it('files bigger than a scan window keep their exact size', async () => {
    const png = rgbPng(1300, 1300, 5);
    const z = zipSync({ 'big.bin': [noise(5 << 20, 6), { level: 0 }] });
    const g = gzipSync(noise(5 << 20, 7), { level: 0, mtime: 0 });
    const items: [number, Uint8Array][] = [
      [0x100003, png],
      [0x100003 + png.length + 4099, z],
      [0x100003 + png.length + 4099 + z.length + 8191, g],
    ];
    const end = items[2]![0] + g.length + 1000;
    const r = await carved(bury(end, 8, items));
    expect(carvedRows(r).map((row) => [row[0], row[3]])).toEqual(
      items.map(([at, x]) => [at, x.length]),
    );
    for (const [at, x] of items) {
      expect(same(await content(filesOf(r).find((y) => y.name.startsWith(hex8(at)))!), x)).toBe(
        true,
      );
    }
  }, 120_000);
});

// ---------------------------------------------------------------- data after the end

describe('data after the end of a file', () => {
  const png = buildPng(12, 12);
  const payload = utf8Encode(`HIDDEN-PAYLOAD:${'x'.repeat(985)}`);

  it('a PNG with text appended: reported, extracted, and the container carves exactly', async () => {
    const file = concatBytes(png, payload);
    const r = await run(file, {}, 'pic.png');
    expect(kv(r).get('Verdict')).toBe('PNG image');
    expect(notes(r)).toContain(
      `${payload.length} bytes follow the end of the main structure, from offset ${png.length} (0x${png.length.toString(16)}): plain text. Hidden data is often appended like this.`,
    );
    const tail = filesOf(r).find((f) => f.name.includes('-after-'))!;
    expect(same(await content(tail), payload)).toBe(true);
    const c = await carved(file, { container: true }, 'pic.png');
    expect(same(await content(fileNamed(c, '00000000.png')), png)).toBe(true);
  });

  it('a PNG with a ZIP appended', async () => {
    const z = zip2();
    const file = concatBytes(png, z);
    const r = await carved(file, {}, 'pic.png');
    expect(carvedRows(r).map((row) => [row[0], row[3]])).toEqual([[png.length, z.length]]);
    expect(same(await content(filesOf(r)[0]!), z)).toBe(true);
    expect(notes(await run(file, {}, 'pic.png')).join('\n')).toContain(`: ${nameOf('zip')}.`);
  });

  it.each([
    ['jpeg', realJpeg(16, 16)],
    ['zip', zip2()],
    ['gif', gifWithComment()],
    ['gzip', gz()],
    ['pdf', realPdf()],
    ['pe', pe32()],
    ['elf', buildElf64()],
  ])('after a whole %s file, at its exact end; nothing for the clean file', async (id, b) => {
    const extra =
      id === 'pe' || id === 'elf'
        ? utf8Encode('OVERLAY!'.repeat(512))
        : utf8Encode('appended ascii '.repeat(17).slice(0, 256));
    const r = await run(concatBytes(b, extra));
    expect(notes(r).join('\n')).toContain(
      `bytes follow the end of the main structure, from offset ${b.length} (`,
    );
    const tail = filesOf(r).find((f) => f.name.includes('-after-'))!;
    expect(same(await content(tail), extra)).toBe(true);
    expect(notes(await run(b)).join('\n')).not.toContain('follow the end of the main structure');
  });
});

// ---------------------------------------------------------------- decoys and neighbours

describe('decoys, neighbours and broken ends', () => {
  it('a decoy IEND inside a private chunk does not cut the PNG', async () => {
    const base = buildPng(8, 8);
    const payload = concatBytes(
      latin1('decoy:'),
      latin1('IEND'),
      Uint8Array.of(0xae, 0x42, 0x60, 0x82),
    );
    const type = latin1('prVt');
    const chunk = concatBytes(
      Uint8Array.of(0, 0, 0, payload.length),
      type,
      payload,
      (() => {
        const c = crc32(concatBytes(type, payload));
        return Uint8Array.of(c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255);
      })(),
    );
    const png = concatBytes(base.subarray(0, 33), chunk, base.subarray(33));
    const r = await carved(bury(64 << 10, 14, [[0x777, png]]));
    expect(carvedRows(r).map((row) => [row[0], row[3]])).toEqual([[0x777, png.length]]);
  });

  it('a JPEG with an EXIF thumbnail: one JPEG, the thumbnail only with nested matches', async () => {
    const thumb = buildJpeg();
    const outer = buildJpeg(thumb);
    const data = bury(64 << 10, 15, [[0x2001, outer]]);
    expect(carvedRows(await carved(data)).map((row) => [row[0], row[3]])).toEqual([
      [0x2001, outer.length],
    ]);
    const inner = 0x2001 + Buffer.from(outer).indexOf(Buffer.from(thumb.subarray(0, 20)), 4);
    expect(carvedRows(await carved(data, { nested: true })).map((row) => [row[0], row[3]])).toEqual(
      [
        [0x2001, outer.length],
        [inner, thumb.length],
      ],
    );
  });

  it('a decoy end-of-central-directory in a stored entry, and an archive comment', async () => {
    const z = buildZip(
      [
        {
          name: 'decoy.bin',
          data: concatBytes(latin1('PK\x05\x06'), new Uint8Array(18)),
          method: 0,
        },
      ],
      'a 29-byte comment for the zip',
    );
    const r = await carved(bury(64 << 10, 16, [[0x3003, z]]));
    expect(carvedRows(r).map((row) => [row[0], row[3]])).toEqual([[0x3003, z.length]]);
  });

  it('a PDF with an incremental update ends at its second %%EOF', async () => {
    const pdf = realPdf(true);
    const r = await carved(bury(64 << 10, 17, [[0x4005, pdf]]));
    expect(carvedRows(r).map((row) => [row[0], row[3]])).toEqual([[0x4005, pdf.length]]);
  });

  it.each([100_000, 1 << 20, 3 << 20, 5 << 20])(
    'a stray %%EOF %i bytes after a PDF is not part of it',
    async (gap) => {
      const pdf = realPdf();
      const data = bury(0x1003 + pdf.length + gap + 4096, 18, [
        [0x1003, pdf],
        [0x1003 + pdf.length + gap, latin1('%%EOF\n')],
      ]);
      const r = await carved(data);
      expect(carvedRows(r)[0]!.slice(0, 4)).toEqual([0x1003, '0x1003', nameOf('pdf'), pdf.length]);
    },
    60_000,
  );

  it('a PDF, a PNG, then a stray %%EOF: both files are listed', async () => {
    const pdf = realPdf();
    const png = rgbPng(16, 16, 19);
    const data = bury(256 << 10, 19, [
      [0x1003, pdf],
      [0x2001, png],
      [0x9001, latin1('%%EOF\n')],
    ]);
    const want = [
      [0x1003, pdf.length],
      [0x2001, png.length],
    ];
    for (const opts of [{ view: 'carve' }, { view: 'overview' }]) {
      const r = await run(data, opts);
      expect(carvedRows(r).map((row) => [row[0], row[3]])).toEqual(want);
    }
    // Nested matches add what lies inside the PNG (its zlib stream), nothing else.
    const n = carvedRows(await run(data, { view: 'carve', nested: true }));
    expect(n.slice(0, 2).map((row) => [row[0], row[3]])).toEqual(want);
    expect(n.slice(2).map((row) => row[2])).toEqual([expect.stringMatching(/^zlib stream/)]);
  });

  it('a PDF followed by a PostScript file keeps its own size', async () => {
    const pdf = realPdf();
    const ps = latin1(
      '%!PS-Adobe-3.0\n%%Title: neighbour\n/Helvetica findfont 12 scalefont setfont\n72 72 moveto (hi) show\nshowpage\n%%EOF\n',
    );
    const r = await carved(
      bury(64 << 10, 20, [
        [0x1003, pdf],
        [0x3001, ps],
      ]),
    );
    expect(carvedRows(r)[0]!.slice(0, 4)).toEqual([0x1003, '0x1003', nameOf('pdf'), pdf.length]);
  });

  it('two PDFs, two ZIPs, two GIFs and two JPEGs, each on its own', async () => {
    const pdf = realPdf();
    const z = zip2();
    const gif = gifWithComment();
    const jpg = realJpeg(16, 16);
    const cases: [number, [number, Uint8Array][]][] = [
      [512 << 10, [[0x1003, pdf], [0x40005, pdf]]],
      [128 << 10, [[0x1001, z], [0x10003, z]]],
      [64 << 10, [[0x101, gif], [0x201, gif], [0x1001, jpg], [0x3001, jpg]]],
    ]; // prettier-ignore
    for (const [size, items] of cases) {
      const r = await carved(bury(size, 21, items));
      expect(carvedRows(r).map((row) => [row[0], row[3]])).toEqual(
        items.map(([at, b]) => [at, b.length]),
      );
    }
  });

  it('PNG, ZIP, GIF and JPEG back to back', async () => {
    const parts = [rgbPng(16, 16, 22), zip2(), gifWithComment(), realJpeg(16, 16)];
    const r = await carved(bury(64 << 10, 23, [[0x101, concatBytes(...parts)]]));
    let at = 0x101;
    const want = parts.map((p) => {
      const row = [at, p.length];
      at += p.length;
      return row;
    });
    expect(carvedRows(r).map((row) => [row[0], row[3]])).toEqual(want);
  });

  it('a PNG cut by the end of the file is listed as a guess', async () => {
    const png = rgbPng(32, 32, 24);
    const data = concatBytes(noise(0x501, 25), png.subarray(0, png.length >> 1));
    const r = await carved(data);
    const row = carvedRows(r)[0]!;
    expect([row[0], row[3]]).toEqual([0x501, data.length - 0x501]);
    expect(String(row[5])).toMatch(/guess|truncated/);
  });
});

// ---------------------------------------------------------------- identification

describe('identification of whole files', () => {
  it.each([
    ['a.png', buildPng(), 'PNG image'],
    ['a.jpg', realJpeg(8, 8), 'JPEG image'],
    ['a.gif', gifWithComment(), 'GIF image'],
    ['a.zip', zip2(), nameOf('zip')],
    ['a.gz', gz(), nameOf('gzip')],
    ['a.pdf', realPdf(), 'PDF document'],
    ['a.elf', buildElf64(), 'ELF executable: ELF64, LSB, x86-64, ET_DYN'],
    ['a.exe', pe32(), 'Windows PE / DOS executable (MZ): PE32, i386'],
    ['noext', buildElf64(), 'ELF executable: ELF64, LSB, x86-64, ET_DYN'],
  ])('%s', async (name, bytes, verdict) => {
    const r = await run(bytes, {}, name);
    expect(kv(r).get('Verdict')).toBe(verdict);
    expect(notes(r).join('\n')).not.toContain('does not match the content');
  });

  it('a ZIP named .png is flagged', async () => {
    const r = await run(zip2(), {}, 'wrong.png');
    expect(notes(r)).toContain(
      'The extension .png does not match the content: it looks like a .zip.',
    );
  });
});

// ---------------------------------------------------------------- strings

const MiB = 1 << 20;
const STR_SIZE = 5 * MiB + 77;
const ASCII_AT: [number, string][] = [
  [0xfff9, 'flag{ascii_at_64k}'],
  [0xffff3, 'flag{ascii_at_1m}'],
  [0x3ffff7, 'flag{ascii_at_4m}'],
  [0x30101, 'An ordinary sentence of ASCII text.'],
  [STR_SIZE - 20, 'tail_at_eof_xyz'],
];
const WIDE_AT: [number, string][] = [
  [0x1ffff5, 'flag{wide_at_2mib_boundary}'],
  [0x407fed, 'flag{wide_odd_offset}'],
  [0x30001, 'Hello wide world'],
];
const strFile = (() => {
  const b = new Uint8Array(STR_SIZE);
  for (const [at, s] of ASCII_AT) b.set(utf8Encode(s), at);
  for (const [at, s] of WIDE_AT) b.set(utf16le(s), at);
  return b;
})();
const stringRows = (r: ToolResult) => table(r, 'Readable text')!.rows;

describe('Strings', () => {
  it('ASCII and UTF-16LE strings at window edges, at their exact offsets', async () => {
    const r = await run(strFile, { view: 'strings', min: 6 });
    const rows = stringRows(r);
    for (const [at, s] of ASCII_AT)
      expect(rows, s).toContainEqual([`0x${at.toString(16)}`, 'ascii', s]);
    for (const [at, s] of WIDE_AT)
      expect(rows, s).toContainEqual([`0x${at.toString(16)}`, 'utf16le', s]);
    expect(rows).toHaveLength(ASCII_AT.length + WIDE_AT.length);
  }, 60_000);

  it('UTF-16LE between zero bytes stays UTF-16LE at its own offset', async () => {
    const b = noise(128 << 10, 26);
    b.set(
      concatBytes(new Uint8Array(2), utf16le('flag{wide_real_layout}'), new Uint8Array(2)),
      0x8000 - 2,
    );
    b.set(concatBytes(latin1('A'), utf16le('Wide after letter')), 0x9000);
    const rows = stringRows(await run(b, { view: 'strings' }));
    expect(rows).toContainEqual(['0x8000', 'utf16le', 'flag{wide_real_layout}']);
    expect(rows).toContainEqual(['0x9001', 'utf16le', 'Wide after letter']);
    const s = table(await run(b, { view: 'hex', search: 'wide_real' }), 'Matches')!;
    expect(s.rows.map((row) => [row[0], row[2]])).toContainEqual([0x8000 + 10, 'utf16le']);
  });

  it('filters by text and by regular expression', async () => {
    const wide = stringRows(await run(strFile, { view: 'strings', filter: 'WIDE' }));
    expect(wide).toHaveLength(3);
    const re = stringRows(
      await run(strFile, { view: 'strings', filter: '/flag\\{ascii_[a-z0-9_]+\\}/' }),
    );
    expect(re).toHaveLength(3);
  }, 60_000);

  it('8 MiB of random bytes: a bounded list, quickly', async () => {
    const t0 = Date.now();
    const r = await run(noise(8 * MiB, 34), { view: 'strings' });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(stringRows(r).length).toBeLessThanOrEqual(20_000);
    expect(texts(r)[0]!.length).toBeLessThanOrEqual(1 << 20);
  }, 60_000);

  it('caps what it renders: many strings, and one very long run', async () => {
    const lines = new Uint8Array(8 * MiB);
    const unit = latin1('abcdefg\n');
    for (let i = 0; i < lines.length; i += 8) lines.set(unit, i);
    const r = await run(lines, { view: 'strings' });
    expect(stringRows(r)).toHaveLength(20_000);
    expect(notes(r)[0]).toMatch(/^Showing 20000 of 1048576/);
    expect(texts(r)[0]!.length).toBeLessThanOrEqual(1 << 20);
    const long = noise(6 * MiB, 27, false);
    const run1 = concatBytes(
      Uint8Array.of(0),
      latin1(`flag{${'L'.repeat(100_000)}}`),
      Uint8Array.of(0),
    );
    long.set(run1, 0x3f3caf - 1);
    const lr = stringRows(await run(long, { view: 'strings', filter: 'LLLLLLLL' }));
    expect(lr.map((row) => row[0])).toEqual(['0x3f3caf']);
    expect(String(lr[0]![2]).length).toBeLessThanOrEqual(401);
  }, 60_000);

  it('64 KiB lines: the text block stays bounded', async () => {
    const line = new Uint8Array(64 << 10);
    for (let i = 0; i < line.length - 1; i++) line[i] = 0x41 + (i % 26);
    line[line.length - 1] = 0x0a;
    const big = new Blob(Array.from({ length: 512 }, () => new Blob([line as BlobPart])));
    const r = await run(big, { view: 'strings' });
    expect(stringRows(r)).toHaveLength(512);
    expect(texts(r)[0]!.length).toBeLessThanOrEqual(1 << 20);
    expect(resultToText(r).length).toBeLessThan(4 << 20);
  }, 60_000);
});

// ---------------------------------------------------------------- search

describe('search', () => {
  const size = 5 * MiB + 3;
  const offsets = [0x11, 0xfffe, 0x3fffff, 0x480001, size - 4];
  const data = bury(
    size,
    28,
    offsets.map((o) => [o, Uint8Array.of(0xde, 0xad, 0xbe, 0xef)]),
  );
  const hits = async (search: string, b = data) =>
    (table(await run(b, { view: 'hex', search }), 'Matches')?.rows ?? []).map((row) => [
      row[0],
      row[2],
    ]);

  it('hex bytes in every notation, across window edges', async () => {
    const want = offsets.map((o) => [o, 'hex']);
    for (const q of [
      'de ad be ef',
      'de:ad:be:ef',
      '0xdeadbeef',
      '\\xde\\xad\\xbe\\xef',
      'DEADBEEF',
    ])
      expect(await hits(q), q).toEqual(want);
  }, 60_000);

  it('bare hex digits are also looked up as text', async () => {
    const b = bury(64 << 10, 29, [
      [0x100, latin1('DEADBEEF')],
      [0x200, Uint8Array.of(0xde, 0xad, 0xbe, 0xef)],
      [0x300, Uint8Array.of(0x89)],
    ]);
    expect(await hits('DEADBEEF', b)).toEqual([
      [0x100, 'ascii'],
      [0x200, 'hex'],
    ]);
    expect((await hits('89', b)).filter(([o]) => o === 0x300)).toEqual([[0x300, 'hex']]);
  });

  it('regular expressions: exact offsets and lengths, no duplicates, g flag accepted', async () => {
    const b = bury(4 * MiB, 30, [
      [0x2003, latin1('flag{first_one}')],
      [0x1ffffa, latin1('flag{near_two_mib}')],
      [0x2ffa24, latin1(`flag{${'q'.repeat(3000)}}`)],
    ]);
    const t = table(await run(b, { view: 'hex', search: '/flag\\{[a-z_]+\\}/' }), 'Matches')!;
    expect(t.rows.map((row) => [row[0], row[3]])).toEqual([
      [0x2003, 15],
      [0x1ffffa, 18],
      [0x2ffa24, 3006],
    ]);
    const g = table(await run(b, { view: 'hex', search: '/flag\\{\\w+\\}/g' }), 'Matches')!;
    expect(g.rows.map((row) => row[0])).toEqual([0x2003, 0x1ffffa, 0x2ffa24]);
    const edge = bury(5 * MiB, 31, [[0x3ffff6, latin1('flag{straddle_4mib_regex}')]]);
    expect(await hits('/flag\\{[a-z0-9_]+\\}/', edge)).toEqual([[0x3ffff6, 'regex']]);
  }, 60_000);

  it('text is also looked up as UTF-16', async () => {
    const b = bury(4 * MiB, 32, [[0x2ffffb, utf16le('wide secret text')]]);
    expect((await hits('wide secret', b)).filter(([, e]) => e !== 'ascii')).toEqual([
      [0x2ffffb, 'utf16le'],
    ]);
  });

  it('bounded results, clear errors', async () => {
    const r = await run(new Uint8Array(8 * MiB), { view: 'hex', search: '00 00' });
    expect(table(r, 'Matches')!.rows).toHaveLength(10_000);
    expect(notes(r)).toContain('Stopped at 10000 matches.');
    await expect(run(noise(4096, 33), { view: 'hex', search: '/[unclosed/' })).rejects.toThrow(
      ToolError,
    );
    expect(notes(await run(noise(4096, 33), { view: 'hex', search: 'zz yy' }))[0]).toMatch(
      /^No match for zz yy/,
    );
  });
});

describe('degenerate inputs', () => {
  it.each([
    ['empty', new Uint8Array(0)],
    ['one byte', Uint8Array.of(0x89)],
    ['a PNG signature only', Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
  ])('%s: every view gives a result or a clear error', async (_n, b) => {
    for (const view of ['overview', 'carve', 'strings', 'hex', 'disk', 'entropy', 'numeric']) {
      try {
        const r = await run(b, { view, dtype: 'uint8' });
        expect(Array.isArray(r)).toBe(true);
      } catch (e) {
        expect(e, view).toBeInstanceOf(ToolError);
      }
    }
    if (b.length === 1) {
      expect(notes(await run(b, { view: 'carve' }))).toContain(
        'No embedded file signature in 1 byte. Try Strings (readable text) or Entropy (encrypted or compressed parts).',
      );
    }
  });
});
