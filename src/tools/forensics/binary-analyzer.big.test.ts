/**
 * Big and hostile inputs for the Binary analyzer: a 256 MiB file assembled from Blob parts
 * (nothing copied), crafted headers that used to make the carving quadratic, dense signatures,
 * long text lines. Budgets: no read above 8 MiB, bounded tables and text, near-linear time.
 */
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import { concatBytes, utf8Encode } from '../../lib/bytes';
import { SIGNATURES } from '../../lib/signatures';
import { buildIso, cookedToRaw, hiddenPng, hiddenZip } from './_disk-fixtures';
import { buildElf64, buildJpeg, buildPdf, buildPng, noise } from './_fixtures';
import {
  content,
  counted,
  filesOf,
  notes,
  run,
  same,
  table,
  tables,
  texts,
  utf16le,
} from './_binary-test-kit';

const MiB = 1 << 20;
const NOISE = new Blob([noise(MiB, 0x1234567, false) as BlobPart]);
const ZEROS = new Blob([new Uint8Array(MiB) as BlobPart]);
const TEXT = (() => {
  let s = '';
  for (let i = 0; s.length < MiB; i++)
    s += `log line ${String(i).padStart(6, '0')} status=ok user=guest\n`;
  return new Blob([utf8Encode(s.slice(0, MiB)) as BlobPart]);
})();

/** `size` bytes of Blob filler (noise, zeros, text in turn) with `inserts` spliced in. */
function sparse(size: number, inserts: [number, Uint8Array][]): Blob {
  const fill = [NOISE, ZEROS, TEXT];
  const filler = new Blob(Array.from({ length: Math.ceil(size / MiB) }, (_, i) => fill[i % 3]!));
  const parts: Blob[] = [];
  let at = 0;
  for (const [o, b] of [...inserts].sort((x, y) => x[0] - y[0])) {
    parts.push(filler.slice(at, o), new Blob([b as BlobPart]));
    at = o + b.length;
  }
  parts.push(filler.slice(at, size));
  return new Blob(parts);
}

const bounded = (r: ToolResult) => {
  for (const t of tables(r)) expect(t.rows.length).toBeLessThan(100_000);
  for (const v of texts(r)) expect(v.length).toBeLessThan(100 << 20);
  expect(resultToText(r).length).toBeLessThan(100 << 20);
};

describe('a 256 MiB file assembled from Blob parts', () => {
  const size = 256 * MiB;
  const gz = gzipSync(noise(20 * MiB, 77), { level: 1, mtime: 0 });
  const inserts: [number, Uint8Array][] = [
    [37 * MiB + 123, hiddenPng()],
    [64 * MiB - 100, hiddenZip()],
    [99 * MiB + 5, utf8Encode('flag{probe_big_ascii}')],
    [149 * MiB + 1, utf16le('flag{probe_big_wide}')],
    [179 * MiB, gz],
    [202 * MiB + 3, buildElf64()],
    [220 * MiB, buildPdf()],
    [230 * MiB + 77, buildJpeg()],
    [size - 3 * MiB + 9, buildPng(16, 16)],
  ];
  const big = sparse(size, inserts);

  it('Overview: every embedded file and both flags, reads of 8 MiB at most', async () => {
    const [f, stats] = counted(big, 'bin256.bin');
    const t0 = Date.now();
    const r = await run(f);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(stats.largest).toBeLessThanOrEqual(8 * MiB);
    const rows = table(r, 'Embedded files')!.rows;
    expect(rows.map((row) => [row[0], row[3]])).toEqual(
      inserts.filter(([, b]) => b.length > 100).map(([o, b]) => [o, b.length]),
    );
    const flags = table(r, 'Flag-like')!.rows.map((row) => [row[0], row[2], row[3]]);
    expect(flags).toEqual([
      [99 * MiB + 5, 'ascii', 'flag{probe_big_ascii}'],
      [149 * MiB + 1, 'utf16le', 'flag{probe_big_wide}'],
    ]);
    bounded(r);
  }, 180_000);

  it('the other views stay within the budgets', async () => {
    const views: [Record<string, unknown>, (r: ToolResult) => void][] = [
      [{ view: 'carve' }, (r) => expect(filesOf(r)).toHaveLength(7)],
      [{ view: 'entropy' }, (r) => expect(r.filter((o) => o.type === 'image')).toHaveLength(2)],
      [
        { view: 'strings', filter: 'flag' },
        (r) =>
          expect(table(r, 'Readable text')!.rows.map((row) => row[2])).toEqual([
            'flag{probe_big_ascii}',
            'flag{probe_big_wide}',
          ]),
      ],
      [
        { view: 'hex', search: 'flag{probe' },
        (r) =>
          expect(table(r, 'Matches')!.rows.map((row) => row[0])).toEqual([
            99 * MiB + 5,
            149 * MiB + 1,
          ]),
      ],
      [
        { view: 'hex', search: '/flag\\{[a-z_]+\\}/' },
        (r) => expect(table(r, 'Matches')!.rows.map((row) => row[0])).toEqual([99 * MiB + 5]),
      ],
      [
        { view: 'hex', offset: '-4096', length: '1m' },
        (r) =>
          expect(
            r.find((o) => o.type === 'bytes')?.type === 'bytes' &&
              r.find((o) => o.type === 'bytes'),
          ).toBeTruthy(),
      ],
      [
        { view: 'numeric', dtype: 'float32' },
        (r) => expect(notes(r)[0]).toMatch(/^Reading 4194304 values/),
      ],
      [
        { view: 'numeric', dtype: 'uint8', rows: 16384, cols: 16384 },
        (r) => expect(r.some((o) => o.type === 'image')).toBe(true),
      ],
      [{ view: 'disk' }, (r) => expect(notes(r)[0]).toMatch(/^No disk image structure found/)],
    ];
    for (const [opts, check] of views) {
      const [f, stats] = counted(big, 'bin256.bin');
      const r = await run(f, opts);
      expect(stats.largest, JSON.stringify(opts)).toBeLessThanOrEqual(8 * MiB);
      check(r);
      bounded(r);
    }
  }, 600_000);
});

describe('a 1 GiB file of Blob parts', () => {
  const size = 1 << 30;
  const big = sparse(size, [[512 * MiB, utf8Encode('flag{probe_1g}')]]);

  it('views that need a few bytes read a few bytes', async () => {
    const cases: [Record<string, unknown>, number][] = [
      [{ view: 'hex', offset: '512m', length: '64' }, 64],
      [{ view: 'numeric', dtype: 'float64', offset: '512m', count: 1000 }, 8000],
      [{ view: 'disk' }, 1 << 20],
    ];
    for (const [opts, most] of cases) {
      const [f, stats] = counted(big, 'bin1g.bin');
      const r = await run(f, opts);
      expect(stats.bytes, JSON.stringify(opts)).toBeLessThanOrEqual(most);
      bounded(r);
    }
  });
});

describe('64 MiB of noise with one PNG near the end', () => {
  it('finds the PNG, and nothing else', async () => {
    const png = buildPng(16, 16);
    const at = 0x3ffcc73;
    const data = new Blob([
      new Blob(Array.from({ length: 64 }, () => NOISE)).slice(0, at),
      new Blob([png as BlobPart]),
      NOISE.slice(0, 64 * MiB - at - png.length),
    ]);
    for (const view of ['carve', 'overview']) {
      const rows = table(await run(data, { view }), 'Embedded files')!.rows;
      expect(
        rows.map((row) => [row[0], row[3]]),
        view,
      ).toEqual([[at, png.length]]);
    }
  }, 60_000);
});

describe('raw CD sectors', () => {
  it('a PNG inside the user data is carved from the raw image as from the cooked one', async () => {
    const png = buildPng(8, 8);
    const iso = buildIso(
      [
        { path: '/README.TXT', data: utf8Encode('readme\n') },
        { path: '/PIC.PNG', data: png },
      ],
      { label: 'R' },
    );
    const raw = cookedToRaw(iso);
    for (const [bytes, name] of [
      [iso, 'r.iso'],
      [raw, 'r.bin'],
    ] as const) {
      for (const view of ['carve', 'overview']) {
        const r = await run(bytes, { view }, name);
        const rows = table(r, 'Embedded files')?.rows ?? [];
        const at = Buffer.from(bytes).indexOf(Buffer.from(png.subarray(0, 16)));
        expect(
          rows.map((row) => [row[0], row[3]]),
          `${name} ${view}`,
        ).toContainEqual([at, png.length]);
      }
    }
  });
});

describe('hostile inputs stay near-linear', () => {
  it('8 MiB of JPEG headers that never end', async () => {
    const unit = noise(1024, 5).map((x) => (x === 0xff ? 0x7f : x));
    unit.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00], 0);
    unit.set([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00], 20);
    unit[18] = 0;
    unit[19] = 0;
    const data = new Blob(Array.from({ length: 8192 }, () => new Blob([unit as BlobPart])));
    const [f, stats] = counted(data, 'jpegs.bin');
    const t0 = Date.now();
    const r = await run(f, { view: 'carve' });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(stats.bytes).toBeLessThan(3 * data.size);
    bounded(r);
  }, 60_000);

  it('16 MiB with a %PDF- header every KiB and no %%EOF', async () => {
    const unit = noise(1024, 6, false);
    unit.set(utf8Encode('%PDF-1.4\n'), 0);
    const data = new Blob(Array.from({ length: 16384 }, () => new Blob([unit as BlobPart])));
    const [f, stats] = counted(data, 'pdfs.bin');
    const t0 = Date.now();
    const r = await run(f, { view: 'carve' });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(stats.bytes).toBeLessThan(3 * data.size);
    expect(notes(r).join('\n')).toContain('Stopped at 1000 files.');
  }, 60_000);

  it('a tiny PNG every 512 bytes: tables and files stay bounded', async () => {
    const png = buildPng(1, 1);
    const unit = noise(MiB, 7, false);
    for (let o = 0; o + png.length <= MiB; o += 512) unit.set(png, o);
    const data = new Blob(Array.from({ length: 16 }, () => new Blob([unit as BlobPart])));
    for (const view of ['overview', 'carve']) {
      const [f, stats] = counted(data, 'dense.bin');
      const r = await run(f, { view });
      expect(stats.largest).toBeLessThanOrEqual(8 * MiB);
      expect(filesOf(r).length).toBeLessThanOrEqual(1001);
      bounded(r);
    }
  }, 120_000);

  it('entropy with a small block: the regions table is capped', async () => {
    const unit = concatBytes(noise(2048, 8), new Uint8Array(2048));
    const data = new Blob(Array.from({ length: 6144 }, () => new Blob([unit as BlobPart])));
    const r = await run(data, { view: 'entropy', block: 2048 });
    expect(table(r, 'High-entropy regions')!.rows).toHaveLength(1000);
    expect(notes(r)).toContain('Only the first 1000 rows are shown.');
  }, 60_000);
});

describe('the gzip check is memoised per buffer, with no buffer kept alive', () => {
  it('interleaved buffers keep their own answers', () => {
    const gzip = SIGNATURES.find((s) => s.id === 'gzip')!;
    const a = gzipSync(utf8Encode('member a '.repeat(100)), { mtime: 0 });
    const b = concatBytes(
      noise(10, 1),
      gzipSync(utf8Encode('member b '.repeat(300)), { mtime: 0 }),
    );
    expect(gzip.valid!(a, 0)).toBe(true);
    expect(gzip.valid!(b, 10)).toBe(true);
    expect(gzip.end!(a, 0)).toBe(a.length);
    expect(gzip.end!(b, 10)).toBe(b.length);
  });

  it('carved gzip members are exact, also when longer than a window', async () => {
    const g = gzipSync(noise(6 * MiB, 9), { level: 0, mtime: 0 });
    const r = await run(concatBytes(noise(100, 10), g, noise(100, 11)), { view: 'carve' });
    expect(same(await content(filesOf(r)[0]!), g)).toBe(true);
  }, 60_000);
});
