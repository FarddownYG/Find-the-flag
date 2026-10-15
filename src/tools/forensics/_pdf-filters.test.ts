import { deflateSync } from 'fflate';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import { describe, expect, it } from 'vitest';
import {
  applyPredictor,
  ascii85Decode,
  asciiHexDecode,
  canonicalFilter,
  decodeFilters,
  inflateTolerant,
  lzwDecode,
  runLengthDecode,
} from './_pdf-filters';
import { fromHex, latin1Decode, latin1Encode } from '../../lib/bytes';

const text = (b: Uint8Array) => latin1Decode(b);
const LIMIT = 1 << 24;

describe('FlateDecode', () => {
  // Vectors made with Python's zlib (zlib.compress / compressobj(wbits=-15)).
  it('decodes zlib streams written by another implementation', () => {
    expect(
      text(
        inflateTolerant(fromHex('78da730b71abaecac94c8a2f4b4d2ec92faa05003454067c'), LIMIT).data,
      ),
    ).toBe('FTF{zlib_vector}');
    expect(
      text(
        inflateTolerant(
          fromHex('789c730a51d0773354303452084953d0c848cdc9c9d75408c952700d0100562906d6'),
          LIMIT,
        ).data,
      ),
    ).toBe('BT /F1 12 Tf (hello) Tj ET');
  });

  it('decodes raw deflate with no zlib header', () => {
    const out = inflateTolerant(fromHex('730b71ab2e4a2c8f4f494dcb492c49ad0500'), LIMIT);
    expect(text(out.data)).toBe('FTF{raw_deflate}');
    expect(out.error).toBeNull();
  });

  it('decodes a stream whose two header bytes were damaged', () => {
    const good = fromHex('78da730b71abaecac94c8a2f4b4d2ec92faa05003454067c');
    const bad = Uint8Array.from(good);
    bad[0] = 0x00;
    bad[1] = 0x00;
    expect(text(inflateTolerant(bad, LIMIT).data)).toBe('FTF{zlib_vector}');
  });

  it('keeps the readable beginning of a truncated stream, byte for byte', () => {
    const original = latin1Encode(
      Array.from(
        { length: 400 },
        (_, i) => `line ${i} of a content stream with FTF{cut_${i}}`,
      ).join('\n'),
    );
    const packed = deflateSync(original, { level: 6 });
    const cut = packed.subarray(0, Math.floor(packed.length * 0.6));
    const out = inflateTolerant(cut, LIMIT);
    expect(out.error).not.toBeNull();
    expect(out.data.length).toBeGreaterThan(original.length * 0.4);
    expect(text(out.data)).toBe(text(original.subarray(0, out.data.length)));
  });

  it('recovers the text before a corrupted block', () => {
    const original = latin1Encode(
      Array.from({ length: 300 }, (_, i) => `entry ${i * 7919} FTF{before_${i}}`).join('\n'),
    );
    const packed = Uint8Array.from(deflateSync(original, { level: 9 }));
    // Wreck the second half of the stream: the decoder stops with an error somewhere there.
    for (let i = Math.floor(packed.length / 2); i < packed.length - 6; i++) packed[i] = 0xff;
    const out = inflateTolerant(packed, LIMIT);
    // fflate does not check the Huffman tables, so garbage may follow: the first part is exact.
    const exact = Math.floor(original.length / 4);
    expect(text(out.data.subarray(0, exact))).toBe(text(original.subarray(0, exact)));
    expect(text(out.data).startsWith('entry 0 FTF{before_0}\nentry 7919 FTF{before_1}')).toBe(true);
  });

  it('stops a decompression bomb at the limit', () => {
    const bomb = deflateSync(new Uint8Array(60 * 1024 * 1024), { level: 9 });
    expect(bomb.length).toBeLessThan(100_000);
    const out = inflateTolerant(bomb, 1 << 20);
    expect(out.truncated).toBe(true);
    expect(out.data.length).toBe(1 << 20);
  });

  it('gives nothing, quietly, for empty or garbage input', () => {
    expect(inflateTolerant(new Uint8Array(0), LIMIT).data.length).toBe(0);
    const garbage = inflateTolerant(latin1Encode('this is not deflate data at all'), LIMIT);
    expect(garbage.data.length).toBe(0);
  });
});

describe('ASCIIHexDecode', () => {
  it('ignores white space, stops at > and pads an odd last digit (7.4.2)', () => {
    expect(text(asciiHexDecode(latin1Encode('48 65\n6C6c 6F>junk')).data)).toBe('Hello');
    expect(Array.from(asciiHexDecode(latin1Encode('901FA>')).data)).toEqual([0x90, 0x1f, 0xa0]);
    expect(asciiHexDecode(latin1Encode('4Z')).error).not.toBeNull();
  });
});

describe('ASCII85Decode', () => {
  // Vectors made with Python's base64.a85encode (adobe=True).
  const cases: [Uint8Array, string][] = [
    [latin1Encode('FTF{ascii85_ok}'), '<~7T;j(@<5pmBfItWDejb~>'],
    [latin1Encode('Man '), '<~9jqo^~>'],
    [new Uint8Array(0), '<~~>'],
    [new Uint8Array(4), '<~z~>'],
    [Uint8Array.from([0, 0, 0, 0, 97, 98, 99]), '<~z@:E^~>'],
    [latin1Encode('a'), '<~@/~>'],
    [latin1Encode('ab'), '<~@:B~>'],
    [latin1Encode('abc'), '<~@:E^~>'],
    [
      Uint8Array.from({ length: 40 }, (_, i) => i),
      `<~!!*-'"9eu7#RLhG$k3[W&.oNg'GVB"(\`=52*$$(B+<_pR,UFcb~>`,
    ],
  ];
  it.each(cases)('decodes %j', (plain, encoded) => {
    expect(Array.from(ascii85Decode(latin1Encode(encoded)).data)).toEqual(Array.from(plain));
  });

  it('works without the <~ prefix, with white space, and reports bad characters', () => {
    expect(text(ascii85Decode(latin1Encode('9jq\no^~>')).data)).toBe('Man ');
    expect(ascii85Decode(latin1Encode('9jq{o^~>')).error).not.toBeNull();
  });
});

describe('RunLengthDecode', () => {
  it('copies literal runs, repeats bytes and stops at 128 (7.4.5)', () => {
    const data = Uint8Array.from([2, 97, 98, 99, 254, 120, 0, 33, 128, 99, 99]);
    expect(text(runLengthDecode(data, LIMIT).data)).toBe('abcxxx!');
  });
  it('respects the limit', () => {
    const out = runLengthDecode(Uint8Array.from([129, 65, 129, 65, 129, 65]), 200);
    expect(out.truncated).toBe(true);
    expect(out.data.length).toBe(200);
  });
});

/** A plain LZW encoder (variable code width 9 to 12 bits, clear code when the table is full). */
function lzwEncode(data: Uint8Array, earlyChange: number): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  let width = 9;
  const put = (code: number) => {
    acc = (acc << width) | code;
    bits += width;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
    acc &= (1 << bits) - 1;
  };
  let table = new Map<string, number>();
  let next = 258;
  const reset = () => {
    table = new Map();
    next = 258;
    width = 9;
  };
  put(256);
  let current = '';
  for (const byte of data) {
    const candidate = current + String.fromCharCode(byte);
    if (candidate.length === 1 || table.has(candidate)) {
      current = candidate;
      continue;
    }
    put(current.length === 1 ? current.charCodeAt(0) : table.get(current)!);
    table.set(candidate, next++);
    if (next + earlyChange > 1 << width && width < 12) width++;
    if (next >= 4095) {
      put(256);
      reset();
    }
    current = String.fromCharCode(byte);
  }
  if (current) put(current.length === 1 ? current.charCodeAt(0) : table.get(current)!);
  put(257);
  if (bits > 0) out.push((acc << (8 - bits)) & 255);
  return Uint8Array.from(out);
}

describe('LZWDecode', () => {
  it('decodes the example of ISO 32000-1, 7.4.4.2', () => {
    // 45 45 45 45 45 65 45 45 45 66 = "-----A---B"; also decoded by pypdf's LZWDecode.
    const out = lzwDecode(fromHex('800B6050220C0C8501'), 1, LIMIT);
    expect(text(out.data)).toBe('-----A---B');
    expect(out.error).toBeNull();
  });

  it.each([1, 0])('round-trips data across code width changes (EarlyChange %i)', (early) => {
    const sample = latin1Encode(
      Array.from(
        { length: 3000 },
        (_, i) => `row ${i % 97} FTF{lzw_${i}} ${'ab'.repeat(i % 7)}`,
      ).join(';'),
    );
    const packed = lzwEncode(sample, early);
    expect(packed.length).toBeLessThan(sample.length);
    expect(text(lzwDecode(packed, early, LIMIT).data)).toBe(text(sample));
  });

  it('round-trips a long run of one byte (the KwKwK case)', () => {
    const sample = new Uint8Array(5000).fill(65);
    expect(Array.from(lzwDecode(lzwEncode(sample, 1), 1, LIMIT).data)).toEqual(Array.from(sample));
  });

  it('reports an invalid code and keeps what came before', () => {
    // 256 (clear), 65, then 400: a code beyond the table
    const bits = [256, 65, 400];
    let acc = 0;
    let n = 0;
    const out: number[] = [];
    for (const c of bits) {
      acc = (acc << 9) | c;
      n += 9;
      while (n >= 8) {
        n -= 8;
        out.push((acc >> n) & 255);
      }
      acc &= (1 << n) - 1;
    }
    if (n) out.push((acc << (8 - n)) & 255);
    const r = lzwDecode(Uint8Array.from(out), 1, LIMIT);
    expect(text(r.data)).toBe('A');
    expect(r.error).toMatch(/invalid code/);
  });
});

describe('predictors', () => {
  const columns = 5;
  const colors = 3;
  const rows = 4;
  const pixels = Uint8Array.from(
    { length: columns * colors * rows },
    (_, i) => (i * 37 + (i >> 2) * 11) & 255,
  );
  const stride = columns * colors;

  /** Encode with each PNG filter in turn (PNG spec 9.2). */
  function pngEncode(): Uint8Array {
    const out: number[] = [];
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let r = 0; r < rows; r++) {
      const tag = r % 5;
      out.push(tag);
      for (let i = 0; i < stride; i++) {
        const x = pixels[r * stride + i]!;
        const a = i >= colors ? pixels[r * stride + i - colors]! : 0;
        const b = r > 0 ? pixels[(r - 1) * stride + i]! : 0;
        const c = r > 0 && i >= colors ? pixels[(r - 1) * stride + i - colors]! : 0;
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][tag]!;
        out.push((x - pred) & 255);
      }
    }
    return Uint8Array.from(out);
  }

  it('undoes the five PNG filters, one per row', () => {
    const out = applyPredictor(
      pngEncode(),
      { Predictor: 15, Colors: colors, Columns: columns },
      LIMIT,
    );
    expect(Array.from(out)).toEqual(Array.from(pixels));
  });

  it('agrees with fast-png on the filters it writes', () => {
    const width = 17;
    const height = 9;
    const data = Uint8Array.from(
      { length: width * height * 3 },
      (_, i) => (i * 7 + (i >> 3) * 5) & 255,
    );
    const png = encodePng({ width, height, data, channels: 3, depth: 8 });
    // The IDAT payload of the PNG, inflated, is rows with a filter byte each.
    const chunks: Uint8Array[] = [];
    for (let p = 8; p < png.length;) {
      const len = new DataView(png.buffer, png.byteOffset + p).getUint32(0);
      const type = text(png.subarray(p + 4, p + 8));
      if (type === 'IDAT') chunks.push(png.subarray(p + 8, p + 8 + len));
      p += 12 + len;
    }
    const joined = Uint8Array.from(chunks.flatMap((c) => Array.from(c)));
    const filtered = inflateTolerant(joined, LIMIT).data;
    const out = applyPredictor(filtered, { Predictor: 15, Colors: 3, Columns: width }, LIMIT);
    expect(Array.from(out)).toEqual(Array.from(decodePng(png).data));
  });

  it('keeps a last partial row', () => {
    const full = pngEncode();
    const cut = full.subarray(0, full.length - 4);
    const out = applyPredictor(cut, { Predictor: 12, Colors: colors, Columns: columns }, LIMIT);
    expect(out.length).toBe(rows * stride);
    expect(Array.from(out.subarray(0, 3 * stride))).toEqual(
      Array.from(pixels.subarray(0, 3 * stride)),
    );
  });

  it('undoes the TIFF predictor on 8-bit RGB, 16-bit and 4-bit samples', () => {
    // One RGB row 10 20 30 | +1 +2 +3 | +1 +2 +3
    expect(
      Array.from(
        applyPredictor(
          Uint8Array.from([10, 20, 30, 1, 2, 3, 1, 2, 3]),
          { Predictor: 2, Colors: 3, Columns: 3 },
          LIMIT,
        ),
      ),
    ).toEqual([10, 20, 30, 11, 22, 33, 12, 24, 36]);
    expect(
      Array.from(
        applyPredictor(
          Uint8Array.from([0x01, 0x00, 0x00, 0xff]),
          { Predictor: 2, BitsPerComponent: 16, Columns: 2 },
          LIMIT,
        ),
      ),
    ).toEqual([0x01, 0x00, 0x01, 0xff]);
    // two 4-bit samples per byte: 1, +2, +3, +4 -> 1, 3, 6, 10
    expect(
      Array.from(
        applyPredictor(
          Uint8Array.from([0x12, 0x34]),
          { Predictor: 2, BitsPerComponent: 4, Columns: 4 },
          LIMIT,
        ),
      ),
    ).toEqual([0x13, 0x6a]);
  });

  it('refuses nonsense parameters', () => {
    expect(() =>
      applyPredictor(new Uint8Array(10), { Predictor: 12, Columns: 0 }, LIMIT),
    ).toThrow();
    expect(() =>
      applyPredictor(new Uint8Array(10), { Predictor: 12, BitsPerComponent: 3 }, LIMIT),
    ).toThrow();
  });
});

describe('filter chains', () => {
  it('applies the filters in order and knows the abbreviations', () => {
    const flate = deflateSync(latin1Encode('FTF{chain}'));
    const hex = latin1Encode(
      `${Array.from(flate, (b) => b.toString(16).padStart(2, '0')).join('')}>`,
    );
    const out = decodeFilters(
      hex,
      [
        { name: canonicalFilter('AHx'), params: {} },
        { name: canonicalFilter('Fl'), params: {} },
      ],
      LIMIT,
    );
    expect(text(out.data)).toBe('FTF{chain}');
    expect(out.applied).toEqual(['ASCIIHexDecode', 'FlateDecode']);
    expect(out.error).toBeNull();
  });

  it('stops at an image codec and hands its bytes back', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const out = decodeFilters(jpeg, [{ name: 'DCTDecode', params: {} }], LIMIT);
    expect(out.image).toBe('jpeg');
    expect(out.stoppedAt).toBe('DCTDecode');
    expect(Array.from(out.data)).toEqual(Array.from(jpeg));
    const both = decodeFilters(
      deflateSync(jpeg),
      [
        { name: 'FlateDecode', params: {} },
        { name: 'JPXDecode', params: {} },
      ],
      LIMIT,
    );
    expect(both.image).toBe('jpeg2000');
    expect(Array.from(both.data)).toEqual(Array.from(jpeg));
  });

  it('stops at a filter it does not know', () => {
    const out = decodeFilters(latin1Encode('abc'), [{ name: 'SomethingElse', params: {} }], LIMIT);
    expect(out.stoppedAt).toBe('SomethingElse');
    expect(out.image).toBeNull();
    expect(text(out.data)).toBe('abc');
  });

  it('applies the predictor of FlateDecode', () => {
    // 3 columns of 1 byte: a Sub row (5 +1 +1) then an Up row (+7 +1 +1)
    const rows = Uint8Array.from([1, 5, 1, 1, 2, 7, 1, 1]);
    const out = decodeFilters(
      deflateSync(rows),
      [{ name: 'FlateDecode', params: { Predictor: 11, Columns: 3 } }],
      LIMIT,
    );
    expect(Array.from(out.data)).toEqual([5, 6, 7, 12, 7, 8]);
  });
});
