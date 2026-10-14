import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { lazyFile } from '../../core/prepare';
import { utf8Encode } from '../../lib/bytes';
import {
  decodeValues,
  DTYPES,
  enviIndex,
  formatValue,
  numericView,
  parseEnvi,
  preview,
  readEnviBand,
  shapes,
  stats,
  type DType,
} from './_binary-numeric';
import { buildRaster, RASTER } from './_disk-fixtures';

const fileOf = (b: Uint8Array) => lazyFile(new Blob([b as BlobPart]), 'x.bin');

/** Values written with DataView, the reference the decoder must match exactly. */
const SAMPLES: Record<DType, (number | bigint)[]> = {
  int8: [0, 1, -1, 127, -128],
  uint8: [0, 1, 255, 128],
  int16: [0, -2, 32767, -32768, 258],
  uint16: [0, 65535, 258, 1],
  int32: [0, -1, 2147483647, -2147483648, 16909060],
  uint32: [0, 4294967295, 16909060],
  int64: [0n, -1n, 9223372036854775807n, -9223372036854775808n, 72623859790382856n],
  uint64: [0n, 18446744073709551615n, 72623859790382856n],
  float32: [
    0,
    -0.5,
    3.4028234663852886e38,
    1.401298464324817e-45,
    NaN,
    Infinity,
    -Infinity,
    0.10000000149011612,
  ],
  float64: [0, Math.PI, -1e-300, NaN, Infinity, Number.MAX_VALUE],
};

function write(dtype: DType, values: (number | bigint)[], little: boolean): Uint8Array {
  const size = DTYPES[dtype];
  const b = new Uint8Array(values.length * size + (size > 1 ? 1 : 0)); // a partial element is ignored
  const v = new DataView(b.buffer);
  values.forEach((x, i) => {
    const o = i * size;
    switch (dtype) {
      case 'int8':
        return v.setInt8(o, Number(x));
      case 'uint8':
        return v.setUint8(o, Number(x));
      case 'int16':
        return v.setInt16(o, Number(x), little);
      case 'uint16':
        return v.setUint16(o, Number(x), little);
      case 'int32':
        return v.setInt32(o, Number(x), little);
      case 'uint32':
        return v.setUint32(o, Number(x), little);
      case 'int64':
        return v.setBigInt64(o, BigInt(x), little);
      case 'uint64':
        return v.setBigUint64(o, BigInt(x), little);
      case 'float32':
        return v.setFloat32(o, Number(x), little);
      case 'float64':
        return v.setFloat64(o, Number(x), little);
    }
  });
  return b;
}

describe('numeric decoding', () => {
  for (const dtype of Object.keys(DTYPES) as DType[]) {
    for (const little of [true, false]) {
      it(`${dtype} ${little ? 'little' : 'big'}-endian`, () => {
        const want = SAMPLES[dtype];
        const got = decodeValues(write(dtype, want, little), dtype, little);
        expect(got.values.length).toBe(want.length);
        if (got.big) expect([...got.big]).toEqual(want);
        else expect([...got.values]).toEqual(want.map(Number));
      });
    }
  }

  it('reading with the wrong byte order gives other values', () => {
    const b = write('uint16', [258], true);
    expect([...decodeValues(b, 'uint16', false).values]).toEqual([513]);
  });

  it('formats float32 with the shortest text that reads back the same', () => {
    expect(formatValue(Math.fround(0.1), 'float32')).toBe('0.1');
    expect(formatValue(Math.fround(1 / 3), 'float32')).toBe('0.33333334');
    expect(formatValue(NaN, 'float32')).toBe('NaN');
    expect(formatValue(-Infinity, 'float64')).toBe('-Infinity');
    expect(formatValue(42, 'int16')).toBe('42');
  });

  it('computes statistics over finite values and counts NaN / Inf', () => {
    const s = stats(Float64Array.from([1, 2, 3, NaN, Infinity, -Infinity, 0]));
    expect([s.count, s.finite, s.min, s.max, s.mean, s.nan, s.posInf, s.negInf, s.zeros]).toEqual([
      7, 4, 0, 3, 1.5, 1, 1, 1, 1,
    ]);
    expect(s.std).toBeCloseTo(Math.sqrt(1.25), 12);
  });

  it('previews a reshaped array with NaN in magenta', () => {
    const v = Float64Array.from([0, 1, 2, NaN]);
    const img = preview(v, 2, 2, stats(v));
    expect([img.width, img.height]).toEqual([2, 2]);
    expect([...img.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...img.data.subarray(8, 12)]).toEqual([255, 255, 255, 255]);
    expect([...img.data.subarray(12, 16)]).toEqual([255, 0, 255, 255]);
  });

  it('suggests shapes close to a square', () => {
    expect(shapes(3072)).toEqual([
      [48, 64],
      [32, 96],
      [24, 128],
      [16, 192],
      [12, 256],
    ]);
    expect(shapes(7919)).toEqual([]);
  });
});

describe('ENVI', () => {
  it('parses a header with multi-line values', () => {
    const h = parseEnvi(
      'ENVI\r\nsamples = 3\nlines= 2\nbands =2\ndata type = 12\nbyte order = 1\nheader offset = 8\ninterleave = bil\nband names = {\n red,\n nir }\n',
    );
    expect([
      h.samples,
      h.lines,
      h.bands,
      h.dtype,
      h.little,
      h.offset,
      h.interleave,
      h.bandNames,
    ]).toEqual([3, 2, 2, 'uint16', false, 8, 'bil', ['red', 'nir']]);
    expect(() => parseEnvi('samples = 3')).toThrow(ToolError);
    expect(() => parseEnvi('ENVI\nsamples = 3\nlines = 2\ndata type = 6\n')).toThrow(ToolError);
    expect(() => parseEnvi('ENVI\nlines = 2\ndata type = 4\n')).toThrow(/samples/);
  });

  it('reads one band of BSQ, BIL and BIP cubes', async () => {
    // value = band * 100 + line * 10 + sample, uint8, after an 4-byte header
    for (const interleave of ['bsq', 'bil', 'bip'] as const) {
      const h = {
        samples: 3,
        lines: 2,
        bands: 2,
        dataType: 1,
        dtype: 'uint8' as const,
        little: true,
        offset: 4,
        interleave,
        description: '',
        bandNames: [],
      };
      const cube = new Uint8Array(4 + 12);
      for (let b = 0; b < 2; b++)
        for (let l = 0; l < 2; l++)
          for (let s = 0; s < 3; s++) cube[enviIndex(h, b, l, s)] = b * 100 + l * 10 + s;
      const band = await readEnviBand(fileOf(cube), h, 1);
      expect([[...band.bytes], band.present]).toEqual([[100, 101, 102, 110, 111, 112], 6]);
    }
  });

  it('the raster sample: 48 × 64 float32 with one NaN', async () => {
    const { data, hdr } = buildRaster();
    const out = await numericView(fileOf(data), {
      dtype: 'uint8',
      endian: 'be',
      offset: '0',
      count: 0,
      rows: 0,
      cols: 0,
      band: 1,
      envi: { bytes: utf8Encode(hdr), name: 'binary-raster.hdr' },
    });
    const kv = out
      .filter((o) => o.type === 'kv')
      .flatMap((o) => (o.type === 'kv' ? o.entries : []));
    const map = new Map(kv);
    expect(map.get('Shape')).toBe(`${RASTER.lines} × ${RASTER.samples}`);
    expect(map.get('NaN')).toBe('1');
    expect(map.get('Data type')).toMatch(/^float32/);
    const img = out.find((o) => o.type === 'image');
    expect(img?.type === 'image' && [img.image.width, img.image.height]).toEqual([64, 48]);
  });
});

describe('numeric view without a header', () => {
  const b = write('int16', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], false);

  it('reshapes, honours the offset and caps nothing it does not have to', async () => {
    const out = await numericView(fileOf(b), {
      dtype: 'int16',
      endian: 'be',
      offset: '0x2',
      count: 0,
      rows: 0,
      cols: 4,
      band: 1,
      envi: null,
    });
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows.slice(0, 5)).toEqual([
      [0, 0, '2'],
      [0, 1, '3'],
      [0, 2, '4'],
      [0, 3, '5'],
      [1, 0, '6'],
    ]);
    const text = out.find((o) => o.type === 'text');
    expect(text?.type === 'text' && text.value).toBe('2 3 4 5\n6 7 8 9');
  });

  it('rejects an offset past the end', async () => {
    await expect(
      numericView(fileOf(b), {
        dtype: 'int16',
        endian: 'be',
        offset: '999',
        count: 0,
        rows: 0,
        cols: 0,
        band: 1,
        envi: null,
      }),
    ).rejects.toThrow(ToolError);
  });
});
