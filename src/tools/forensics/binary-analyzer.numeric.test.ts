/**
 * Numeric view of the Binary analyzer through the tool itself: every data type in both byte
 * orders, statistics at the edges of each type, offsets and reshapes, ENVI rasters (all three
 * interleaves, truncated files, damaged headers) and the 4 Mi value cap.
 */
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { prepareInput } from '../../core/prepare';
import type { LazyFile, ToolResult } from '../../core/types';
import { concatBytes, utf8Encode } from '../../lib/bytes';
import { DTYPES, type DType } from './_binary-numeric';
import { counted, kv, notes, run, table, texts } from './_binary-test-kit';

type Num = number | bigint;

function write(dtype: DType, values: Num[], little: boolean): Uint8Array {
  const size = DTYPES[dtype];
  const b = new Uint8Array(values.length * size);
  const v = new DataView(b.buffer);
  values.forEach((x, i) => {
    const o = i * size;
    if (dtype === 'int8') v.setInt8(o, Number(x));
    else if (dtype === 'uint8') v.setUint8(o, Number(x));
    else if (dtype === 'int16') v.setInt16(o, Number(x), little);
    else if (dtype === 'uint16') v.setUint16(o, Number(x), little);
    else if (dtype === 'int32') v.setInt32(o, Number(x), little);
    else if (dtype === 'uint32') v.setUint32(o, Number(x), little);
    else if (dtype === 'int64') v.setBigInt64(o, BigInt(x), little);
    else if (dtype === 'uint64') v.setBigUint64(o, BigInt(x), little);
    else if (dtype === 'float32') v.setFloat32(o, Number(x), little);
    else v.setFloat64(o, Number(x), little);
  });
  return b;
}

const numeric = (b: Uint8Array | LazyFile, opts: Record<string, unknown> = {}) =>
  run(b, { view: 'numeric', ...opts });
const cells = (r: ToolResult) => table(r, 'First ')!.rows.map((row) => row[row.length - 1]);
const stat = (r: ToolResult, k: string) => kv(r).get(k);
const image = (r: ToolResult) => {
  const o = r.find((x) => x.type === 'image');
  if (o?.type !== 'image') throw new Error('no preview');
  return o.image;
};
const gray = (r: ToolResult) => {
  const img = image(r);
  return Array.from({ length: img.width * img.height }, (_, i) => img.data[i * 4]!);
};

describe('data types and byte orders', () => {
  const INTS: [DType, number[]][] = [
    ['int8', [-128, -1, 0, 1, 127, -77]],
    ['uint8', [0, 1, 127, 128, 255, 171]],
    ['int16', [-32768, -1, 0, 1, 32767, -12345]],
    ['uint16', [0, 1, 32768, 65535, 43981]],
    ['int32', [-2147483648, -1, 0, 1, 2147483647, -305419896]],
    ['uint32', [0, 1, 2147483648, 4294967295, 3735928559]],
  ];
  for (const [dtype, values] of INTS) {
    for (const endian of ['le', 'be'] as const) {
      it(`${dtype} ${endian}`, async () => {
        const r = await numeric(write(dtype, values, endian === 'le'), { dtype, endian });
        expect(stat(r, 'Values')).toBe(String(values.length));
        expect(cells(r)).toEqual(values.map(String));
        expect([stat(r, 'Min'), stat(r, 'Max')]).toEqual([
          String(Math.min(...values)),
          String(Math.max(...values)),
        ]);
        expect(stat(r, 'Byte order')).toMatch(endian === 'le' ? /^little/ : /^big/);
      });
    }
  }

  const BIG: [DType, bigint[], string, string][] = [
    [
      'int64',
      [-(2n ** 63n), -1n, 0n, 1n, 2n ** 63n - 1n, 2n ** 53n + 1n, -(2n ** 53n + 1n)],
      '-9223372036854775808',
      '9223372036854775807',
    ],
    ['uint64', [0n, 1n, 2n ** 63n, 2n ** 64n - 1n, 2n ** 53n + 1n], '0', '18446744073709551615'],
  ];
  for (const [dtype, values, min, max] of BIG) {
    for (const endian of ['le', 'be'] as const) {
      it(`${dtype} ${endian}: exact cells, exact min and max`, async () => {
        const r = await numeric(write(dtype, values, endian === 'le'), { dtype, endian });
        expect(cells(r)).toEqual(values.map(String));
        expect([stat(r, 'Min'), stat(r, 'Max')]).toEqual([min, max]);
      });
    }
  }

  it('float32 / float64 specials and denormals, -0 keeps its sign', async () => {
    const f32 = [
      1.5,
      -2.25,
      NaN,
      Infinity,
      -Infinity,
      0,
      -0,
      1.401298464324817e-45,
      1.1754942106924411e-38,
      3.4028234663852886e38,
      0.1,
      16777217,
      -1e-40,
    ];
    const f64 = [
      Math.PI,
      -Math.E,
      NaN,
      Infinity,
      -Infinity,
      0,
      -0,
      5e-324,
      2.225073858507201e-308,
      Number.MAX_VALUE,
      0.1,
      -1e-310,
      2 ** 53 + 1,
    ];
    for (const [dtype, values] of [
      ['float32', f32],
      ['float64', f64],
    ] as const) {
      for (const endian of ['le', 'be'] as const) {
        const r = await numeric(write(dtype, values, endian === 'le'), { dtype, endian });
        const got = cells(r).map(String);
        values.forEach((x, i) => {
          const want = dtype === 'float32' ? Math.fround(x) : x;
          if (Number.isNaN(want)) expect(got[i]).toBe('NaN');
          else {
            // float32 is printed with the shortest text that reads back as the same float32.
            const back = dtype === 'float32' ? Math.fround(Number(got[i])) : Number(got[i]);
            expect(Object.is(back, want), `${dtype} ${got[i]}`).toBe(true);
          }
        });
        expect(got[6]).toBe('-0');
        expect([stat(r, 'NaN'), stat(r, '+Inf / −Inf'), stat(r, 'Zeros')]).toEqual([
          '1',
          '1 / 1',
          '2',
        ]);
      }
    }
  });

  it('Number.MAX_VALUE stays finite in the statistics', async () => {
    const r = await numeric(write('float64', [Number.MAX_VALUE, 1, 2], true), { dtype: 'float64' });
    expect(stat(r, 'Max')).toBe('1.7976931348623157e+308');
    expect(Number.isFinite(Number(stat(r, 'Standard deviation')))).toBe(true);
    const s = await numeric(write('float64', [-Number.MAX_VALUE, 0, 5, Number.MAX_VALUE], true), {
      dtype: 'float64',
    });
    expect([stat(s, 'Min'), stat(s, 'Max')]).toEqual([
      '-1.7976931348623157e+308',
      '1.7976931348623157e+308',
    ]);
    expect(Number(stat(s, 'Standard deviation'))).toBeCloseTo(
      Number.MAX_VALUE * Math.SQRT1_2,
      -300,
    );
  });

  it('a float32 nodata sentinel: finite minimum, the preview normalised over it', async () => {
    const r = await numeric(write('float32', [-3.4028234663852886e38, 1, 2, 3], true), {
      dtype: 'float32',
      rows: 2,
      cols: 2,
    });
    expect(stat(r, 'Min')).toBe('-3.4028235e+38');
    expect(gray(r)).toEqual([0, 255, 255, 255]);
  });

  it('means and standard deviations, also with a large mean and a tiny spread', async () => {
    const i8 = await numeric(write('int8', [-128, -1, 0, 1, 127], true), { dtype: 'int8' });
    expect(stat(i8, 'Mean')).toBe('-0.2');
    const u8 = await numeric(
      Uint8Array.from({ length: 65536 }, (_, i) => i & 255),
      {
        dtype: 'uint8',
      },
    );
    expect(stat(u8, 'Mean')).toBe('127.5');
    const f = [0.1, 0.2, 0.3].map(Math.fround);
    const mean = (f[0]! + f[1]! + f[2]!) / 3;
    const std = Math.sqrt(f.reduce((a, x) => a + (x - mean) ** 2, 0) / 3);
    const f32 = await numeric(write('float32', f, true), { dtype: 'float32' });
    expect(Number(stat(f32, 'Standard deviation'))).toBeCloseTo(std, 9);
    const big = Array.from({ length: 4000 }, (_, i) => 1e9 + (i % 2));
    const r = await numeric(write('float64', big, true), { dtype: 'float64' });
    expect([stat(r, 'Mean'), stat(r, 'Standard deviation')]).toEqual(['1000000000.5', '0.5']);
  });

  it('an unknown data type passed through the API is a clear error', async () => {
    await expect(numeric(write('uint8', [1], true), { dtype: 'complex128' })).rejects.toThrow(
      ToolError,
    );
  });

  it('the input as the app prepares it, and an all-zero file', async () => {
    const f = (await prepareInput('file', {
      file: new Blob([write('float32', [1.5, -2.25], false) as BlobPart]),
      name: 'foo.bin',
    })) as LazyFile;
    expect(cells(await numeric(f, { dtype: 'float32', endian: 'be' }))).toEqual(['1.5', '-2.25']);
    const z = await numeric(new Uint8Array(1024), { dtype: 'float32' });
    expect([
      stat(z, 'Zeros'),
      stat(z, 'Min'),
      stat(z, 'Max'),
      stat(z, 'Standard deviation'),
    ]).toEqual(['256', '0', '0', '0']);
    expect(stat(z, 'Data type')).toBe('float32 (4 bytes each)');
    expect(stat(await numeric(Uint8Array.of(1), { dtype: 'uint8' }), 'Data type')).toBe(
      'uint8 (1 byte each)',
    );
  });
});

describe('offsets, counts and shapes', () => {
  const b14 = concatBytes(
    Uint8Array.of(0xa5, 0xa5, 0xa5),
    write('uint16', [1, 2, 3, 4, 43981], true),
    Uint8Array.of(77),
  );

  it('an offset that is not a multiple of the element size', async () => {
    for (const offset of ['3', '0x3', '-11']) {
      const r = await numeric(b14, { dtype: 'uint16', offset });
      expect(cells(r), offset).toEqual(['1', '2', '3', '4', '43981']);
      expect(table(r, 'First ')!.rows.map((row) => row[1])).toEqual([
        '0x3',
        '0x5',
        '0x7',
        '0x9',
        '0xb',
      ]);
      expect(notes(r)).toContain(
        'The last byte does not make a whole uint16 value: it is not read.',
      );
    }
    expect(cells(await numeric(b14, { dtype: 'uint16', offset: '1' }))[0]).toBe('42405');
    const k = new Uint8Array(2048);
    k.set([0x34, 0x12], 1024);
    expect(cells(await numeric(k, { dtype: 'uint16', offset: '1k' }))[0]).toBe('4660');
    const i32 = concatBytes(Uint8Array.of(9), write('int32', [100, -200, 300], false));
    expect(cells(await numeric(i32, { dtype: 'int32', endian: 'be', offset: '1' }))).toEqual([
      '100',
      '-200',
      '300',
    ]);
    const f64 = concatBytes(new Uint8Array(5).fill(1), write('float64', [Math.PI, -0.5], true));
    expect(cells(await numeric(f64, { dtype: 'float64', offset: '5' }))).toEqual([
      String(Math.PI),
      '-0.5',
    ]);
  });

  it('bad offsets and sizes are clear errors', async () => {
    for (const offset of [
      '100',
      '14',
      'abc',
      '0xFFFFFFFFFFFFFFFF',
      '99999999999999999999',
      '-100',
    ]) {
      await expect(numeric(b14, { dtype: 'uint8', offset }), offset).rejects.toThrow(ToolError);
    }
    await expect(numeric(new Uint8Array(3), { dtype: 'float32' })).rejects.toThrow(ToolError);
    await expect(numeric(new Uint8Array(0), { dtype: 'uint8' })).rejects.toThrow(ToolError);
  });

  it('the count option', async () => {
    const ten = Uint8Array.from({ length: 10 }, (_, i) => i);
    expect(cells(await numeric(ten, { dtype: 'uint8', count: 3 }))).toEqual(['0', '1', '2']);
    const r = await numeric(ten, { dtype: 'uint8', count: 1000 });
    expect(cells(r)).toHaveLength(10);
    expect(notes(r)).toContain(
      'Only 10 values fit between the offset and the end of the file (1000 asked).',
    );
    const twenty = Uint8Array.from({ length: 20 }, (_, i) => i);
    expect(cells(await numeric(twenty, { dtype: 'uint8', offset: '5', count: 4 }))).toEqual([
      '5',
      '6',
      '7',
      '8',
    ]);
  });

  it('an exact 3 × 4 reshape: shape, preview, table and text', async () => {
    const values = Array.from({ length: 12 }, (_, i) => i * 10);
    const r = await numeric(write('uint16', values, true), { dtype: 'uint16', rows: 3, cols: 4 });
    expect(stat(r, 'Shape')).toBe('3 × 4');
    expect([image(r).width, image(r).height]).toEqual([4, 3]);
    expect(gray(r)).toEqual(values.map((v) => Math.round((255 * v) / 110)));
    expect(table(r, 'First ')!.columns).toEqual(['Row', 'Column', 'Value']);
    expect(texts(r)[0]).toBe('0 10 20 30\n40 50 60 70\n80 90 100 110');
  });

  it('shapes that do not divide the data', async () => {
    const shape = async (n: number, rows: number, cols: number) => {
      const r = await numeric(
        write(
          'uint16',
          Array.from({ length: n }, (_, i) => i),
          true,
        ),
        {
          dtype: 'uint16',
          rows,
          cols,
        },
      );
      for (const c of cells(r)) expect(c).toMatch(/^\d+$/);
      return [stat(r, 'Shape') ?? 'flat', notes(r).find((x) => /shape|full row/i.test(x)) ?? ''];
    };
    expect(await shape(13, 3, 4)).toEqual(['3 × 4', '']);
    expect(await shape(13, 5, 0)).toEqual(['5 × 2', '']);
    expect(await shape(13, 0, 5)).toEqual(['2 × 5', '']);
    expect(await shape(12, 5, 4)).toEqual([
      '3 × 4',
      'Only 3 full rows of 4 values fit instead of 5: the shape is 3 × 4.',
    ]);
    expect(await shape(12, 2, 100)).toEqual([
      'flat',
      'The 2 × 100 shape needs more values than the 12 available: shown as a flat list.',
    ]);
    expect((await shape(12, 1, 0))[0]).toBe('1 × 12');
    expect((await shape(12, -3, 4))[0]).toBe('3 × 4');
    expect((await shape(12, 2.5, 4))[0]).toBe('2 × 4');
  });

  it('a reshape combined with an offset', async () => {
    const r = await numeric(
      write(
        'uint16',
        Array.from({ length: 40 }, (_, i) => i),
        true,
      ),
      {
        dtype: 'uint16',
        offset: '10',
        count: 6,
        rows: 2,
        cols: 3,
      },
    );
    expect(stat(r, 'Shape')).toBe('2 × 3');
    expect(cells(r)).toEqual(['5', '6', '7', '8', '9', '10']);
  });

  it('a float32 gradient raster without a header', async () => {
    const r = await numeric(
      write(
        'float32',
        Array.from({ length: 2048 }, (_, i) => i),
        true,
      ),
      {
        dtype: 'float32',
        rows: 32,
        cols: 64,
      },
    );
    expect([image(r).width, image(r).height]).toEqual([64, 32]);
    expect(gray(r)).toEqual(Array.from({ length: 2048 }, (_, i) => Math.round((255 * i) / 2047)));
  });

  it('previews with NaN, ±Inf, a constant array and all-NaN data', async () => {
    const r = await numeric(write('float32', [0, 1, 2, 3, NaN, 5, Infinity, -Infinity, 8], true), {
      dtype: 'float32',
      rows: 3,
      cols: 3,
    });
    const px = (i: number) => [...image(r).data.subarray(i * 4, i * 4 + 3)];
    expect(px(4)).toEqual([255, 0, 255]);
    expect(px(6)).toEqual([229, 160, 70]);
    expect(px(8)).toEqual([255, 255, 255]);
    expect(
      gray(await numeric(new Uint8Array(16).fill(5), { dtype: 'uint8', rows: 4, cols: 4 })),
    ).toEqual(new Array(16).fill(128));
    const nan = await numeric(write('float32', [NaN, NaN, NaN, NaN], true), {
      dtype: 'float32',
      rows: 2,
      cols: 2,
    });
    expect(stat(nan, 'Min')).toBe('NaN');
    const i64 = await numeric(write('int64', [-(2n ** 63n), 2n ** 63n - 1n, 0n, 1n], true), {
      dtype: 'int64',
      rows: 2,
      cols: 2,
    });
    expect(gray(i64)).toEqual([0, 255, 128, 128]);
  });
});

// ---------------------------------------------------------------- ENVI

const hdrOf = (fields: string) => ({ bytes: utf8Encode(`ENVI\n${fields}`), name: 'x.hdr' });

/** 64 × 32 × 2 float32 big-endian cube after 16 bytes of 0xA5. */
function cube(interleave: 'bsq' | 'bil' | 'bip'): Uint8Array {
  const [S, L, B] = [64, 32, 2];
  const out = new Uint8Array(16 + S * L * B * 4).fill(0xa5);
  const v = new DataView(out.buffer);
  const value = (b: number, x: number, y: number) =>
    b === 0 ? x + 64 * y : 1000 - 3 * x + 0.5 * y;
  for (let b = 0; b < B; b++)
    for (let y = 0; y < L; y++)
      for (let x = 0; x < S; x++) {
        const i =
          interleave === 'bsq'
            ? (b * L + y) * S + x
            : interleave === 'bil'
              ? (y * B + b) * S + x
              : (y * S + x) * B + b;
        v.setFloat32(16 + i * 4, value(b, x, y), false);
      }
  return out;
}
const cubeHdr = (interleave: string, extra = '') =>
  hdrOf(
    `description = {synthetic gradient}\nsamples = 64\nlines = 32\nbands = 2\nheader offset = 16\nfile type = ENVI Standard\ndata type = 4\ninterleave = ${interleave}\nbyte order = 1\n${extra}`,
  );

describe('ENVI rasters', () => {
  it.each(['bil', 'bsq', 'bip'] as const)('64 × 32 × 2 float32 big-endian, %s', async (il) => {
    for (const band of [1, 2]) {
      const r = await numeric(cube(il), { envi: cubeHdr(il), band });
      const vals = Array.from({ length: 2048 }, (_, i) => {
        const [x, y] = [i % 64, Math.floor(i / 64)];
        return band === 1 ? x + 64 * y : 1000 - 3 * x + 0.5 * y;
      });
      const [min, max] = [Math.min(...vals), Math.max(...vals)];
      expect([image(r).width, image(r).height]).toEqual([64, 32]);
      expect(gray(r)).toEqual(vals.map((v) => Math.round((255 * (v - min)) / (max - min))));
      expect([
        stat(r, 'Samples × lines × bands'),
        stat(r, 'Interleave'),
        stat(r, 'Band'),
        stat(r, 'Header offset'),
        stat(r, 'Byte order'),
        stat(r, 'Min'),
        stat(r, 'Max'),
      ]).toEqual([
        '64 × 32 × 2',
        il.toUpperCase(),
        String(band),
        '16',
        'big-endian',
        String(min),
        String(max),
      ]);
      expect(stat(r, 'Data type')).toMatch(/^float32/);
    }
  });

  it('the header wins over the options', async () => {
    const r = await numeric(cube('bil'), {
      envi: cubeHdr('bil'),
      dtype: 'uint8',
      endian: 'le',
      offset: '7',
      count: 10,
      rows: 2,
      cols: 1024,
    });
    expect([stat(r, 'Shape'), stat(r, 'Offset'), stat(r, 'Byte order')]).toEqual([
      '32 × 64',
      '16 (0x10)',
      'big-endian',
    ]);
    expect(stat(r, 'Data type')).toMatch(/^float32/);
  });

  it('header parsing: BOM, CRLF, braces with decoys, case and spacing, defaults', async () => {
    const text =
      '﻿ENVI\r\ndescription = {decoys: samples = 9\r\n lines = 9999\r\n bands = 7}\r\nSamples = 64\r\nlines   = 32\r\nbands=2\r\nHeader Offset = 16\r\nData Type = 4\r\nInterleave = BIL\r\nbyte order = 1\r\nmap info = {UTM, 1, 1, 0, 0, 30, 30}\r\nband names = {first, second}\r\nwavelength = {450.0, 550.0}\r\n';
    const r = await numeric(cube('bil'), {
      envi: { bytes: utf8Encode(text), name: 'x.hdr' },
      band: 2,
    });
    expect([stat(r, 'Samples × lines × bands'), stat(r, 'Band'), stat(r, 'Interleave')]).toEqual([
      '64 × 32 × 2',
      '2 (second)',
      'BIL',
    ]);
    const plain = new Uint8Array(6 * 4);
    new DataView(plain.buffer).setFloat32(0, 1.5, true);
    const d = await numeric(plain, { envi: hdrOf('samples = 3\nlines = 2\ndata type = 4\n') });
    expect([
      stat(d, 'Byte order'),
      stat(d, 'Header offset'),
      stat(d, 'Interleave'),
      cells(d)[0],
    ]).toEqual(['little-endian', '0', 'BSQ', '1.5']);
  });

  it.each([
    [1, 'uint8', [0, 255, 1, 2, 3, 4]],
    [2, 'int16', [-32768, 32767, 0, 1, -1, 2]],
    [3, 'int32', [-2147483648, 2147483647, 0, 1, -1, 2]],
    [5, 'float64', [Math.PI, -0.5, 0, 1e300, -1e-300, 2]],
    [12, 'uint16', [0, 65535, 1, 2, 3, 4]],
    [13, 'uint32', [0, 4294967295, 1, 2, 3, 4]],
    [14, 'int64', [-(2n ** 63n), 2n ** 63n - 1n, 0n, 1n, -1n, 2n]],
    [15, 'uint64', [0n, 2n ** 64n - 1n, 2n ** 53n + 1n, 1n, 2n, 3n]],
  ] as [number, DType, Num[]][])(
    'ENVI data type %i (%s), both byte orders',
    async (code, dtype, values) => {
      for (const order of [0, 1]) {
        const r = await numeric(write(dtype, values, order === 0), {
          envi: hdrOf(
            `samples = 3\nlines = 2\nbands = 1\ndata type = ${code}\nbyte order = ${order}\n`,
          ),
        });
        expect(cells(r)).toEqual(values.map(String));
        expect(stat(r, 'Data type')).toMatch(new RegExp(`^${dtype}`));
      }
    },
  );

  it.each([
    'samples = 3\nlines = 2\ndata type = 6\n',
    'samples = 3\nlines = 2\ndata type = 99\n',
    'lines = 2\ndata type = 4\n',
    'samples = 3\nlines = 2\ndata type = 4\ninterleave = xyz\n',
    'samples = 0\nlines = 2\ndata type = 4\n',
    'samples = 4000000000\nlines = 4000000000\nbands = 3\ndata type = 4\n',
  ])('an unusable header is a clear error: %j', async (fields) => {
    const t0 = Date.now();
    await expect(numeric(new Uint8Array(64), { envi: hdrOf(fields) })).rejects.toThrow(ToolError);
    expect(Date.now() - t0).toBeLessThan(2000);
    await expect(
      numeric(new Uint8Array(64), { envi: { bytes: utf8Encode('hello world'), name: 'x.hdr' } }),
    ).rejects.toThrow(ToolError);
    await expect(
      numeric(new Uint8Array(64), { envi: { bytes: new Uint8Array(0), name: 'x.hdr' } }),
    ).rejects.toThrow(ToolError);
  });

  it('a band that does not exist is a clear error', async () => {
    for (const band of [3, 0, 1.5]) {
      await expect(
        numeric(cube('bsq'), { envi: cubeHdr('bsq'), band }),
        String(band),
      ).rejects.toThrow(ToolError);
    }
  });

  it('a truncated raster: the missing values are NaN and stay out of the statistics', async () => {
    const full = cube('bil');
    const cut = full.subarray(0, 9840);
    for (const band of [1, 2]) {
      const r = await numeric(cut, { envi: cubeHdr('bil'), band });
      const present = Array.from({ length: 2048 }, (_, i) => i).filter((i) => {
        const [x, y] = [i % 64, Math.floor(i / 64)];
        return 16 + ((y * 2 + (band - 1)) * 64 + x) * 4 + 4 <= cut.length;
      });
      const missing = 2048 - present.length;
      expect(stat(r, 'Missing (past the end of the file)')).toBe(String(missing));
      expect(stat(r, 'NaN')).toBe('0');
      const vals = present.map((i) => {
        const [x, y] = [i % 64, Math.floor(i / 64)];
        return band === 1 ? x + 64 * y : 1000 - 3 * x + 0.5 * y;
      });
      expect([stat(r, 'Min'), stat(r, 'Max')]).toEqual([
        String(Math.min(...vals)),
        String(Math.max(...vals)),
      ]);
      expect(stat(r, 'Zeros')).toBe(band === 1 ? '1' : '0');
      const img = image(r);
      expect([...img.data.subarray((2048 - 1) * 4, 2048 * 4 - 1)]).toEqual([255, 0, 255]);
    }
    const past = hdrOf(
      'samples = 64\nlines = 32\nbands = 2\nheader offset = 100000\ndata type = 4\ninterleave = bil\nbyte order = 1\n',
    );
    await expect(numeric(full, { envi: past })).rejects.toThrow(
      'Offset 100000 is past the end of the file (16400 bytes).',
    );
    const extra = await numeric(concatBytes(full, new Uint8Array(100)), { envi: cubeHdr('bil') });
    expect(stat(extra, 'Missing (past the end of the file)')).toBeUndefined();
  });

  it('three interleaves across read edges: band statistics equal the reference', async () => {
    const [S, L, B] = [700, 500, 3];
    for (const il of ['bsq', 'bil', 'bip'] as const) {
      const buf = new Uint8Array(5 + S * L * B * 2);
      const v = new DataView(buf.buffer);
      for (let b = 0; b < B; b++)
        for (let y = 0; y < L; y++)
          for (let x = 0; x < S; x++) {
            const i =
              il === 'bsq'
                ? (b * L + y) * S + x
                : il === 'bil'
                  ? (y * B + b) * S + x
                  : (y * S + x) * B + b;
            v.setUint16(5 + i * 2, (1000 * b + 3 * x + 7 * y) % 65536, true);
          }
      for (const band of [1, 2, 3]) {
        const r = await numeric(buf, {
          envi: hdrOf(
            `samples = ${S}\nlines = ${L}\nbands = ${B}\nheader offset = 5\ndata type = 12\ninterleave = ${il}\n`,
          ),
          band,
        });
        let sum = 0;
        let lo = Infinity;
        let hi = -Infinity;
        for (let y = 0; y < L; y++)
          for (let x = 0; x < S; x++) {
            const val = (1000 * (band - 1) + 3 * x + 7 * y) % 65536;
            sum += val;
            lo = Math.min(lo, val);
            hi = Math.max(hi, val);
          }
        expect([stat(r, 'Min'), stat(r, 'Max')]).toEqual([String(lo), String(hi)]);
        expect(Number(stat(r, 'Mean'))).toBeCloseTo(sum / (S * L), 6);
      }
    }
  }, 60_000);

  it('hyperspectral cubes: only the selected band is read from a BSQ file', async () => {
    const [S, L, B] = [512, 512, 32];
    const buf = new Uint8Array(S * L * B);
    for (let b = 0; b < B; b++)
      for (let i = 0; i < S * L; i++) buf[b * S * L + i] = 7 * b + ((i % S) & 3);
    const [f, stats] = counted(buf, 'cube.raw');
    const r = await numeric(f, {
      envi: hdrOf(`samples = ${S}\nlines = ${L}\nbands = ${B}\ndata type = 1\ninterleave = bsq\n`),
      band: 20,
    });
    expect([stat(r, 'Min'), stat(r, 'Max')]).toEqual([String(7 * 19), String(7 * 19 + 3)]);
    expect(stats.bytes).toBe(S * L);
    const [S2, L2, B2] = [256, 256, 64];
    const bip = new Uint8Array(S2 * L2 * B2 * 2);
    const v = new DataView(bip.buffer);
    for (let p = 0; p < S2 * L2; p++)
      for (let b = 0; b < B2; b++) v.setUint16((p * B2 + b) * 2, 100 * b + ((p % S2) & 7), true);
    const r2 = await numeric(bip, {
      envi: hdrOf(
        `samples = ${S2}\nlines = ${L2}\nbands = ${B2}\ndata type = 12\ninterleave = bip\n`,
      ),
      band: 40,
    });
    expect([stat(r2, 'Min'), stat(r2, 'Max')]).toEqual(['3900', '3907']);
    const [S3, L3, B3] = [2000, 2000, 4];
    const bsq = new Uint8Array(S3 * L3 * B3);
    for (let b = 0; b < B3; b++) bsq.fill(10 * b + 1, b * S3 * L3, (b + 1) * S3 * L3);
    const r3 = await numeric(bsq, {
      envi: hdrOf(`samples = ${S3}\nlines = ${L3}\nbands = ${B3}\ndata type = 1\n`),
      band: 3,
    });
    expect([stat(r3, 'Values'), stat(r3, 'Min'), stat(r3, 'Max')]).toEqual(['4000000', '21', '21']);
    expect(table(r3, 'First ')!.rows).toHaveLength(1000);
  }, 60_000);

  it('a single band above 4 Mi values is refused clearly', async () => {
    await expect(
      numeric(new Uint8Array(3000 * 3000), {
        envi: hdrOf('samples = 3000\nlines = 3000\ndata type = 1\n'),
      }),
    ).rejects.toThrow('The raster is too big to read here (9000000 values, at most 4194304).');
  });
});

describe('the 4 Mi value cap and bounded rendering', () => {
  it('values capped with a note, a 1000-row table, statistics over every value read', async () => {
    const big = Uint8Array.from({ length: 6 << 20 }, (_, i) => i % 251);
    const r = await numeric(big, { dtype: 'uint8' });
    expect(notes(r)[0]).toBe(
      'Reading 4194304 values instead of 6291456: at most 4194304 values are read.',
    );
    expect(table(r, 'First ')!.label).toBe('First 1000 of 4194304 values');
    expect([stat(r, 'Min'), stat(r, 'Max')]).toEqual(['0', '250']);
  });

  it('a reshape bigger than the cap keeps the whole rows that fit', async () => {
    const r = await numeric(new Uint8Array(2000 * 3000), {
      dtype: 'uint8',
      rows: 2000,
      cols: 3000,
    });
    expect(stat(r, 'Shape')).toBe('1398 × 3000');
    expect(notes(r)).toContain(
      'Reading 4194304 values instead of 6000000: at most 4194304 values are read.',
    );
    expect(image(r).width).toBe(1000);
  });

  it('a few values far into a big file are read without touching the rest', async () => {
    const [f, stats] = counted(new Uint8Array(24 << 20), 'big.bin');
    const r = await numeric(f, { dtype: 'uint32', offset: '20971520', count: 5 });
    expect(cells(r)).toEqual(['0', '0', '0', '0', '0']);
    expect(stats.bytes).toBe(20);
  });

  it('a 3000 × 2 gradient previews at about 1000 pixels, monotonic, 0 to 255', async () => {
    const values = Array.from({ length: 6000 }, (_, i) => i % 3000);
    const r = await numeric(write('uint16', values, true), {
      dtype: 'uint16',
      rows: 2,
      cols: 3000,
    });
    const img = image(r);
    expect([img.width, img.height]).toEqual([1000, 1]);
    const row = gray(r);
    for (let i = 1; i < row.length; i++) expect(row[i]!).toBeGreaterThanOrEqual(row[i - 1]!);
    expect(row[0]).toBe(0);
    expect(Math.abs(row[500]! - 128)).toBeLessThanOrEqual(2);
    expect(row.at(-1)).toBeGreaterThanOrEqual(254);
  });

  it('read edges in the plain view: statistics equal the reference', async () => {
    for (const dtype of ['uint16', 'int32', 'float32', 'int64', 'float64'] as DType[]) {
      for (const junk of [0, 1, 3, 5]) {
        const size = DTYPES[dtype];
        const n = Math.floor(((6 << 20) - junk) / size);
        const values = Array.from({ length: n }, (_, i) =>
          dtype === 'int64' ? BigInt(i % 60000) : i % 60000,
        );
        const bytes = concatBytes(new Uint8Array(junk).fill(1), write(dtype, values, true));
        const r = await numeric(bytes, { dtype, offset: String(junk) });
        const count = Math.min(n, 4 << 20);
        expect(stat(r, 'Values'), `${dtype} ${junk}`).toBe(String(count));
        expect([stat(r, 'Min'), stat(r, 'Max')]).toEqual(['0', '59999']);
        let sum = 0;
        for (let i = 0; i < count; i++) sum += i % 60000;
        const mean = sum / count;
        let sq = 0;
        for (let i = 0; i < count; i++) sq += ((i % 60000) - mean) ** 2;
        expect(Number(stat(r, 'Mean')) / mean).toBeCloseTo(1, 6);
        expect(Number(stat(r, 'Standard deviation')) / Math.sqrt(sq / count)).toBeCloseTo(1, 6);
      }
    }
  }, 120_000);
});
