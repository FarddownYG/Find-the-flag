import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decode } from 'fast-png';
import { ToolError } from '../../core/errors';
import { defaultOptions } from '../../core/registry';
import { prepareInput } from '../../core/prepare';
import { resultToText } from '../../core/result-text';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import {
  capacityGroups,
  changeStats,
  type EmdChannel,
  type EmdParams,
  type EmdTraversal,
  embedDigits,
  emdValue,
  readDigits,
} from './_emd-core';
import { embedMessage, type EmdOptions, stegoPng } from './_emd-run';
import {
  assess,
  bigDigits,
  bytesToDigits,
  charDigits,
  type Convention,
  digitsToBytes,
  fixedDigits,
  minimalDigits,
  printableChance,
} from './_emd-text';
import emd from './emd';

// ---------- helpers ----------

/** Small deterministic generator (xorshift32). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

function noiseImage(w: number, h: number, seed = 5, alpha = 255): RgbaImage {
  const next = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? alpha : next() & 0xff;
  return { width: w, height: h, data };
}

/** Pixels drawn from a small set (for instance only 0 and 255). */
function pickImage(w: number, h: number, values: number[], seed = 9): RgbaImage {
  const next = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++)
    data[i] = i % 4 === 3 ? 255 : values[next() % values.length]!;
  return { width: w, height: h, data };
}

const asInput = (image: RgbaImage, bytes: Uint8Array = new Uint8Array(0)): ImageInput => ({
  bytes,
  image,
});
const params = (over: Partial<EmdParams> = {}): EmdParams => ({
  n: 2,
  channel: 'r',
  traversal: 'horizontal',
  offset: 0,
  ...over,
});
const FIXED_MSD: Convention = { grouping: 'fixed', order: 'msd' };

const baseOptions = defaultOptions(emd as never) as unknown as EmdOptions;
const run = (
  image: RgbaImage,
  over: Partial<EmdOptions> = {},
  bytes: Uint8Array = new Uint8Array(0),
) => emd.run(asInput(image, bytes), { ...baseOptions, ...over } as never) as Output[];
const text = (out: Output[], label: string) => {
  const o = out.find((x) => x.type === 'text' && x.label === label);
  if (o?.type !== 'text') throw new Error(`no text block "${label}"`);
  return o.value;
};
const kv = (out: Output[], key: string) => {
  for (const o of out) {
    if (o.type !== 'kv') continue;
    const e = o.entries.find(([k]) => k === key);
    if (e) return e[1];
  }
  throw new Error(`no kv "${key}"`);
};
const table = (out: Output[], label: string) => {
  const o = out.find((x) => x.type === 'table' && x.label === label);
  if (o?.type !== 'table') throw new Error(`no table "${label}"`);
  return o;
};

const sample = async (name: string) => {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)),
  );
  return (await prepareInput('image', { bytes, name })) as ImageInput;
};

// ---------- the extraction function ----------

describe('emdValue', () => {
  it('is (1*g1 + 2*g2 + ... + n*gn) mod (2n+1) for several n', () => {
    expect(emdValue([7])).toBe(1); // n = 1, base 3
    expect(emdValue([255])).toBe(0);
    expect(emdValue([3, 4])).toBe(1); // 3 + 8 = 11 mod 5
    expect(emdValue([0, 0])).toBe(0);
    expect(emdValue([1, 2, 3])).toBe(0); // 1 + 4 + 9 = 14 mod 7
    expect(emdValue([255, 0, 128, 7])).toBe(1); // 255 + 384 + 28 = 667 mod 9
    expect(emdValue([1, 1, 1, 1, 1])).toBe(4); // 15 mod 11
    expect(emdValue([200, 100, 50, 25, 12, 6, 3, 1])).toBe(
      emdValue([200, 100, 50, 25, 12, 6, 3, 1], 8),
    );
  });

  it('is what readDigits computes, pixels taken n by n along X', () => {
    // A 6x1 image, red channel 3,4 | 5,6 | 7,8, base 5.
    const data = new Uint8ClampedArray(6 * 4);
    [3, 4, 5, 6, 7, 8].forEach((v, i) => (data[i * 4] = v));
    const digits = readDigits({ width: 6, height: 1, data }, params());
    expect(Array.from(digits)).toEqual([(3 + 8) % 5, (5 + 12) % 5, (7 + 16) % 5]);
  });
});

// ---------- the embedding rule ----------

describe('embedding one group', () => {
  /** One group of n values as an n x 1 image, red channel. */
  const groupImage = (values: number[]): RgbaImage => {
    const data = new Uint8ClampedArray(values.length * 4);
    values.forEach((v, i) => {
      data[i * 4] = v;
      data[i * 4 + 3] = 255;
    });
    return { width: values.length, height: 1, data };
  };
  const redOf = (img: RgbaImage) => Array.from({ length: img.width }, (_, i) => img.data[i * 4]!);

  it('moves at most one value, by exactly 1, in the direction EMD prescribes (n = 1..8)', () => {
    const next = rng(77);
    for (let n = 1; n <= 8; n++) {
      const base = 2 * n + 1;
      for (let trial = 0; trial < 60; trial++) {
        const g = Array.from({ length: n }, () => 2 + (next() % 252)); // away from 0 and 255
        for (let d = 0; d < base; d++) {
          const before = groupImage(g);
          const after = embedDigits(before, params({ n }), Uint8Array.of(d));
          const now = redOf(after);
          expect(emdValue(now)).toBe(d);
          const diff = now.map((v, i) => v - g[i]!);
          const moved = diff.filter((x) => x !== 0);
          const s = (((d - emdValue(g)) % base) + base) % base;
          if (s === 0) expect(moved).toEqual([]);
          else {
            expect(moved).toHaveLength(1);
            // s <= n: g_s + 1; else g_(2n+1-s) - 1
            const idx = s <= n ? s - 1 : base - s - 1;
            expect(diff[idx]).toBe(s <= n ? 1 : -1);
          }
        }
      }
    }
  });

  it('writes every digit exactly when values sit at 0 and 255 (saturation, n = 1..4)', () => {
    let fallbacks = 0;
    for (let n = 1; n <= 4; n++) {
      const base = 2 * n + 1;
      const palette = [0, 1, 254, 255];
      const groups = palette.length ** n;
      for (let m = 0; m < groups; m++) {
        const g: number[] = [];
        for (let j = 0, x = m; j < n; j++, x = Math.floor(x / palette.length)) {
          g.push(palette[x % palette.length]!);
        }
        for (let d = 0; d < base; d++) {
          const after = redOf(embedDigits(groupImage(g), params({ n }), Uint8Array.of(d)));
          expect(emdValue(after), `n=${n} g=${g} d=${d}`).toBe(d);
          after.forEach((v) => {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(255);
          });
          const moved = after.filter((v, i) => v !== g[i]);
          if (moved.length > 1 || after.some((v, i) => Math.abs(v - g[i]!) > 1)) fallbacks++;
        }
      }
    }
    expect(fallbacks).toBeGreaterThan(0); // the fallback really ran
  });

  it('writes every digit into an all-black and an all-white group, whatever n', () => {
    for (let n = 1; n <= 8; n++) {
      for (const v of [0, 255]) {
        for (let d = 0; d < 2 * n + 1; d++) {
          const after = redOf(
            embedDigits(groupImage(Array(n).fill(v)), params({ n }), Uint8Array.of(d)),
          );
          expect(emdValue(after)).toBe(d);
        }
      }
    }
  });
});

// ---------- the digit conventions ----------

describe('digit conventions', () => {
  const asString = (d: Uint8Array) => Array.from(d).join('');

  it('writes "HELLO_EMD" in base 5 as the hand-computed digits', () => {
    // Fixed, most significant first: 4 digits per byte.
    //   H = 72  = 0*125 + 2*25 + 4*5 + 2 -> 0242      E = 69 = 0*125 + 2*25 + 3*5 + 4 -> 0234
    //   L = 76  = 0*125 + 3*25 + 0*5 + 1 -> 0301      O = 79 -> 0304     _ = 95 -> 0340
    //   M = 77  -> 0302                               D = 68 -> 0233
    const expected = '0242 0234 0301 0301 0304 0340 0234 0302 0233'.replace(/ /g, '');
    expect(asString(bytesToDigits(utf8Encode('HELLO_EMD'), 5, FIXED_MSD))).toBe(expected);
  });

  it('puts the same digits into the sample image', async () => {
    const { image } = await sample('emd-hello.png');
    const digits = readDigits(image, params(), 36);
    expect(asString(digits)).toBe('0242023403010301030403400234030202330'.slice(0, 36));
    expect(utf8Decode(digitsToBytes(digits, 5, FIXED_MSD, 9)!)).toBe('HELLO_EMD');
  });

  it('knows the digits per character: ceil(8 / log2 base) and the minimal ASCII count', () => {
    for (let n = 1; n <= 8; n++) {
      const base = 2 * n + 1;
      expect(fixedDigits(base)).toBe(Math.ceil(8 / Math.log2(base)));
      expect(base ** (minimalDigits(base) - 1)).toBeLessThan(123);
      expect(base ** minimalDigits(base)).toBeGreaterThanOrEqual(123);
    }
    expect(charDigits('fixed', 5)).toBe(4);
    expect(charDigits('minimal', 5)).toBe(3); // 5^3 = 125 covers 0..124
    expect(charDigits('bignum', 5)).toBeNull();
  });

  // "Hi!" = 72 105 33
  const HI = utf8Encode('Hi!');
  const cases: [string, Convention, string][] = [
    ['fixed, most significant first', { grouping: 'fixed', order: 'msd' }, '024204100113'],
    ['fixed, least significant first', { grouping: 'fixed', order: 'lsd' }, '242001403110'],
    ['minimal, most significant first', { grouping: 'minimal', order: 'msd' }, '242410113'],
    ['minimal, least significant first', { grouping: 'minimal', order: 'lsd' }, '242014311'],
    // 72*65536 + 105*256 + 33 = 4745505 = 02203324010 in base 5 on 11 digits (5^11 >= 256^3)
    [
      'one number, first digit most significant',
      { grouping: 'bignum', order: 'msd' },
      '02203324010',
    ],
    [
      'one number, first digit least significant',
      { grouping: 'bignum', order: 'lsd' },
      '01042330220',
    ],
  ];
  it.each(cases)('%s', (_name, conv, digits) => {
    expect(asString(bytesToDigits(HI, 5, conv))).toBe(digits);
    const back = digitsToBytes(Uint8Array.from(digits, Number), 5, conv, 3);
    expect(utf8Decode(back!)).toBe('Hi!');
    // without a length limit the same digits give the same bytes (a one-number reading drops leading zeros)
    expect(utf8Decode(digitsToBytes(Uint8Array.from(digits, Number), 5, conv, 0)!)).toBe('Hi!');
  });

  it('gives back every byte value with the fixed and one-number conventions, every base', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (let n = 1; n <= 8; n++) {
      for (const grouping of ['fixed', 'bignum'] as const) {
        for (const order of ['msd', 'lsd'] as const) {
          const conv = { grouping, order };
          const digits = bytesToDigits(all, 2 * n + 1, conv);
          expect(Array.from(digitsToBytes(digits, 2 * n + 1, conv, 256)!)).toEqual(Array.from(all));
        }
      }
    }
  });

  it('keeps leading zero bytes when the length is known', () => {
    const msg = Uint8Array.of(0, 0, 65, 66);
    const conv: Convention = { grouping: 'bignum', order: 'msd' };
    const digits = bytesToDigits(msg, 5, conv);
    expect(Array.from(digitsToBytes(digits, 5, conv, 4)!)).toEqual([0, 0, 65, 66]);
    expect(Array.from(digitsToBytes(digits, 5, conv, 0)!)).toEqual([65, 66]);
  });

  it('refuses a byte the minimal convention cannot hold, saying what it reaches', () => {
    const conv: Convention = { grouping: 'minimal', order: 'msd' };
    expect(() => bytesToDigits(utf8Encode('}'), 5, conv)).toThrow(
      /Byte 125 needs more than 3 digits/,
    );
    expect(() => bytesToDigits(utf8Encode('z{'), 5, conv)).not.toThrow(); // up to 124 is fine
    expect(bigDigits(5, 3)).toBe(11);
  });

  it('turns a digit group worth more than a byte into 0xFF instead of wrapping', () => {
    // 4 digits in base 5 reach 624; 4444 = 624
    const out = digitsToBytes(Uint8Array.of(4, 4, 4, 4, 0, 0, 0, 1), 5, FIXED_MSD, 0)!;
    expect(Array.from(out)).toEqual([255, 1]);
  });

  it('judges a reading against chance: base 5 minimal digits look printable by luck', () => {
    expect(printableChance('minimal', 5)).toBeGreaterThan(0.7);
    expect(printableChance('fixed', 5)).toBeLessThan(0.2);
    const letters = utf8Encode('The quick brown fox jumps over the lazy dog');
    const fixed = assess(letters, printableChance('fixed', 5));
    const minimal = assess(letters, printableChance('minimal', 5));
    expect(fixed.evidence).toBeGreaterThan(minimal.evidence);
    expect(assess(new Uint8Array(40), 0.2).evidence).toBe(0);
    expect(assess(new Uint8Array(40).fill(65), 0.2).evidence).toBe(0); // a flat run says nothing
  });
});

// ---------- round trips ----------

describe('embed then extract is exact', () => {
  const lettersMessage = (len: number, seed: number) => {
    const next = rng(seed);
    return Uint8Array.from({ length: len }, () => 32 + (next() % 91)); // 32..122
  };
  const binaryMessage = (len: number, seed: number) => {
    const next = rng(seed);
    return Uint8Array.from({ length: len }, () => next() & 0xff);
  };
  const combos: [EmdChannel, EmdTraversal][] = [
    ...(['r', 'g', 'b', 'luma', 'avg'] as const).flatMap((c) =>
      (['horizontal', 'vertical'] as const).map((t) => [c, t] as [EmdChannel, EmdTraversal]),
    ),
    ['r', 'raw'],
  ];
  const conventions: Convention[] = (['fixed', 'minimal', 'bignum'] as const).flatMap((grouping) =>
    (['msd', 'lsd'] as const).map((order) => ({ grouping, order })),
  );

  it.each(combos)(
    'channel %s, traversal %s: n = 1..4, offsets, every convention',
    (channel, traversal) => {
      const img = noiseImage(48, 36, 11);
      for (let n = 1; n <= 4; n++) {
        for (const offset of [0, 7, 101]) {
          for (const conv of conventions) {
            const msg = lettersMessage(24, n * 1000 + offset);
            const p = params({ n, channel, traversal, offset });
            const { stego, digits } = embedMessage(img, p, conv, msg);
            const back = digitsToBytes(
              readDigits(stego, p, digits.length),
              2 * n + 1,
              conv,
              msg.length,
            );
            expect(
              Array.from(back!),
              `n=${n} offset=${offset} ${conv.grouping}/${conv.order}`,
            ).toEqual(Array.from(msg));
            // nothing before the offset is touched
            const touched = changeStats(img, stego);
            expect(touched.pixels).toBeGreaterThan(0);
            if (traversal === 'horizontal') {
              for (let i = 0; i < offset * 4; i++) expect(stego.data[i]).toBe(img.data[i]);
            }
          }
        }
      }
    },
  );

  it('carries any byte (binary messages) with the fixed convention, all bases', () => {
    const img = noiseImage(64, 64, 3);
    for (let n = 1; n <= 8; n++) {
      const msg = binaryMessage(60, n);
      const p = params({ n });
      const { stego, digits } = embedMessage(img, p, FIXED_MSD, msg);
      expect(
        Array.from(digitsToBytes(readDigits(stego, p, digits.length), 2 * n + 1, FIXED_MSD, 60)!),
      ).toEqual(Array.from(msg));
    }
  });

  it('is exact on pure black, pure white, and extreme-only images, for every channel', () => {
    const covers: RgbaImage[] = [
      pickImage(40, 30, [0]),
      pickImage(40, 30, [255]),
      pickImage(40, 30, [0, 255], 4),
      pickImage(40, 30, [0, 1, 254, 255], 8),
    ];
    for (const cover of covers) {
      for (const [channel, traversal] of combos) {
        for (let n = 1; n <= 4; n++) {
          const msg = binaryMessage(20, n + 40);
          const p = params({ n, channel, traversal });
          const { stego, digits } = embedMessage(cover, p, FIXED_MSD, msg);
          const back = digitsToBytes(readDigits(stego, p, digits.length), 2 * n + 1, FIXED_MSD, 20);
          expect(Array.from(back!), `${channel}/${traversal} n=${n}`).toEqual(Array.from(msg));
        }
      }
    }
  });

  it('changes at most one value per group, by 1, away from saturation (red channel)', () => {
    const img = pickImage(
      60,
      40,
      Array.from({ length: 250 }, (_, i) => i + 3),
      21,
    );
    const msg = lettersMessage(100, 5);
    const { stego, digits } = embedMessage(img, params({ n: 3 }), FIXED_MSD, msg);
    for (let g = 0; g < digits.length; g++) {
      let moved = 0;
      for (let j = 0; j < 3; j++) {
        const i = (g * 3 + j) * 4;
        const d = stego.data[i]! - img.data[i]!;
        if (d) {
          moved++;
          expect(Math.abs(d)).toBe(1);
        }
      }
      expect(moved).toBeLessThanOrEqual(1);
    }
    expect(changeStats(img, stego).maxChange).toBe(1);
    // untouched channels
    for (let i = 0; i < img.data.length; i += 4) {
      expect(stego.data[i + 1]).toBe(img.data[i + 1]);
      expect(stego.data[i + 2]).toBe(img.data[i + 2]);
      expect(stego.data[i + 3]).toBe(img.data[i + 3]);
    }
  });

  it('keeps a grey image grey when it embeds in luma or average', () => {
    const grey = new Uint8ClampedArray(30 * 30 * 4);
    const next = rng(2);
    for (let i = 0; i < 900; i++) {
      const v = next() & 0xff;
      grey.set([v, v, v, 255], i * 4);
    }
    const img = { width: 30, height: 30, data: grey };
    for (const channel of ['luma', 'avg'] as const) {
      const { stego } = embedMessage(img, params({ channel }), FIXED_MSD, utf8Encode('grey ok'));
      for (let i = 0; i < 900; i++) {
        expect(stego.data[i * 4]).toBe(stego.data[i * 4 + 1]);
        expect(stego.data[i * 4]).toBe(stego.data[i * 4 + 2]);
      }
    }
  });

  it('never touches alpha in raw order, so the stream layout is stable', () => {
    // one pixel is not fully opaque: the raw stream then has 4 bytes per pixel
    const img = noiseImage(20, 20, 6);
    img.data[3] = 254;
    const msg = utf8Encode('raw rgba');
    const p = params({ traversal: 'raw' });
    const { stego, digits } = embedMessage(img, p, FIXED_MSD, msg);
    for (let i = 3; i < img.data.length; i += 4) expect(stego.data[i]).toBe(img.data[i]);
    expect(utf8Decode(digitsToBytes(readDigits(stego, p, digits.length), 5, FIXED_MSD, 8)!)).toBe(
      'raw rgba',
    );
    expect(capacityGroups(img, p)).toBe(Math.floor((400 * 4) / 2));
    expect(capacityGroups(noiseImage(20, 20), p)).toBe(Math.floor((400 * 3) / 2));
  });

  it('the PNG the tool offers decodes to exactly the stego pixels', () => {
    const img = noiseImage(30, 20, 14);
    const { stego } = embedMessage(img, params(), FIXED_MSD, utf8Encode('png'));
    const png = decode(stegoPng(stego));
    expect(png.channels).toBe(3);
    for (let i = 0; i < 600; i++) {
      for (let c = 0; c < 3; c++) expect(png.data[i * 3 + c]).toBe(stego.data[i * 4 + c]);
    }
  });
});

// ---------- the tool ----------

describe('emd tool, extract', () => {
  it('reads HELLO_EMD from the sample and shows the base-5 digit stream', async () => {
    const { image, bytes } = await sample('emd-hello.png');
    const out = run(image, { length: 9 }, bytes);
    expect(text(out, 'Message (selected convention)')).toBe('HELLO_EMD');
    expect(text(out, 'Raw digits (base 5)')).toBe('0242 0234 0301 0301 0304 0340 0234 0302 0233');
    expect(kv(out, 'Groups read')).toBe('36 (one digit each)');
    expect(kv(out, 'Digits per character')).toMatch(/^4 /);
    expect(kv(out, 'Base')).toBe('5 (2n+1 with n = 2)');
    expect(kv(out, 'Channel')).toBe('Red');
    const files = out.find((o) => o.type === 'files');
    expect(files?.type === 'files' && files.files.map((f) => f.name)).toEqual([
      'emd-digits.txt',
      'emd-message.bin',
    ]);
  });

  it('defaults to the classic setting: n = 2, red, horizontal, 892 characters', async () => {
    expect(baseOptions).toMatchObject({
      n: '2',
      channel: 'r',
      traversal: 'horizontal',
      offset: 0,
      length: 892,
      grouping: 'fixed',
      order: 'msd',
    });
    // An 892-character message in a 100x100 cover is read back whole with the defaults.
    const next = rng(31);
    const message = Array.from({ length: 892 }, () => String.fromCharCode(32 + (next() % 91))).join(
      '',
    );
    const { stego } = embedMessage(
      noiseImage(100, 100, 8),
      params(),
      FIXED_MSD,
      utf8Encode(message),
    );
    const out = run(stego);
    expect(text(out, 'Message (selected convention)')).toBe(message);
    expect(kv(out, 'Characters')).toBe('892');
    expect(kv(out, 'Groups read')).toBe('3568 (one digit each)');
    const shown = text(out, 'Raw digits (base 5)');
    expect(shown.split(' ')[0]).toBe(
      Array.from(bytesToDigits(utf8Encode(message.slice(0, 1)), 5, FIXED_MSD)).join(''),
    );
    // 3568 digits do not fit the page: the start is shown, the whole stream is in the file
    expect(out.some((o) => o.type === 'note' && /first 2400 of 3568/.test(o.text))).toBe(true);
    const files = out.find((o) => o.type === 'files');
    const digitsFile = files?.type === 'files' ? files.files[0]! : null;
    expect(utf8Decode(digitsFile!.data)).toHaveLength(3568);
  });

  it('"all" reads every group the image holds', async () => {
    const { image, bytes } = await sample('emd-hello.png');
    const out = run(image, { length: 0 }, bytes);
    const message = text(out, 'Message (selected convention)');
    expect(message.startsWith('HELLO_EMD')).toBe(true);
    expect(message).toHaveLength(Math.floor(capacityGroups(image, params()) / 4));
    expect(kv(out, 'Readable from the start')).toMatch(/^9 of /);
  });

  it('says so when the image holds fewer characters than asked', () => {
    const out = run(noiseImage(10, 10, 1), { length: 892 });
    expect(kv(out, 'Characters')).toBe('12 (asked for 892, the image holds no more)');
  });

  it('Auto finds the channel and traversal, and ranks every reading', async () => {
    const { image, bytes } = await sample('emd-hello.png');
    const out = run(image, { channel: 'auto', length: 9 }, bytes);
    expect(text(out, 'Message (selected convention)')).toBe('HELLO_EMD');
    const rank = table(out, 'Auto guess: every channel and traversal');
    expect(rank.rows).toHaveLength(11);
    expect(rank.rows[0]!.slice(0, 2)).toEqual(['Red', 'Horizontal (row by row)']);
    expect(rank.rows[0]![5]).toBe('HELLO_EMD');
    expect(rank.highlight).toEqual([0]);
    expect(resultToText(out)).toMatch(/Auto is a guess/);

    // another place: green channel, column by column, with an offset
    const p = params({ channel: 'g', traversal: 'vertical', offset: 25 });
    const { stego } = embedMessage(noiseImage(50, 50, 4), p, FIXED_MSD, utf8Encode('FIND_ME_AUTO'));
    const found = run(stego, { channel: 'auto', offset: 25, length: 12 });
    expect(text(found, 'Message (selected convention)')).toBe('FIND_ME_AUTO');
    expect(table(found, 'Auto guess: every channel and traversal').rows[0]!.slice(0, 2)).toEqual([
      'Green',
      'Vertical (column by column)',
    ]);
    expect(kv(found, 'Start offset')).toBe('25 pixels');
  });

  it('Auto says plainly when nothing looks like text', () => {
    const out = run(noiseImage(60, 60, 99), { channel: 'auto', length: 40 });
    expect(
      out.some((o) => o.type === 'note' && /None of the readings looks like text/.test(o.text)),
    ).toBe(true);
  });

  it('ranks the conventions, highlights the best, and proposes it when it is not the selected one', () => {
    const conv: Convention = { grouping: 'minimal', order: 'lsd' };
    const { stego } = embedMessage(
      noiseImage(64, 64, 2),
      params(),
      conv,
      utf8Encode('three digits per letter'),
    );
    const out = run(stego, { length: 23 }); // read with the default (fixed, msd)
    const rank = table(out, 'Digit-to-text conventions tried');
    expect(rank.rows).toHaveLength(6);
    expect(rank.rows[0]![0]).toBe('Minimal digits (3), LSD first');
    expect(rank.rows[0]![4]).toBe('three digits per letter');
    // a long reading shows its first 7 bytes and a dash of ellipsis: cells stay on one line
    expect(rank.rows[0]![5]).toBe(
      Array.from(utf8Encode('three digits per letter'), (b) => b.toString(16).padStart(2, '0'))
        .join(' ')
        .slice(0, 7 * 3 - 1) + ' …',
    );
    expect(rank.highlight).toEqual([0]);
    const actions = out.find((o) => o.type === 'actions');
    expect(actions?.type === 'actions' && actions.actions[0]!.options).toEqual({
      grouping: 'minimal',
      order: 'lsd',
    });
    // selecting it makes it the main result
    const picked = run(stego, { length: 23, grouping: 'minimal', order: 'lsd' });
    expect(text(picked, 'Message (selected convention)')).toBe('three digits per letter');
    expect(picked.some((o) => o.type === 'actions')).toBe(false);
    expect(resultToText(out)).toMatch(/does not solve every EMD variant/);
  });

  it('reads a whole-stream number message too, and skips it when the stream is huge', () => {
    const conv: Convention = { grouping: 'bignum', order: 'msd' };
    const { stego } = embedMessage(
      noiseImage(64, 64, 2),
      params(),
      conv,
      utf8Encode('one big number'),
    );
    const out = run(stego, { length: 14, grouping: 'bignum' });
    expect(text(out, 'Message (selected convention)')).toBe('one big number');
    expect(table(out, 'Digit-to-text conventions tried').rows[0]![0]).toBe(
      'One big number, MSD first',
    );
    const huge = run(noiseImage(400, 400, 1), { length: 0 });
    expect(table(huge, 'Digit-to-text conventions tried').rows).toHaveLength(4);
    expect(resultToText(huge)).toMatch(/big-number rows are left out/);
    expect(() => run(noiseImage(400, 400, 1), { length: 0, grouping: 'bignum' })).toThrow(
      ToolError,
    );
  });

  it('works for every group size and shows the base next to it', () => {
    for (let n = 1; n <= 8; n++) {
      const p = params({ n, channel: 'b' });
      const { stego } = embedMessage(noiseImage(80, 80, n), p, FIXED_MSD, utf8Encode('size'));
      const out = run(stego, { n: String(n), channel: 'b', length: 4 });
      expect(text(out, 'Message (selected convention)')).toBe('size');
      expect(kv(out, 'Base')).toBe(`${2 * n + 1} (2n+1 with n = ${n})`);
      expect(text(out, `Raw digits (base ${2 * n + 1})`)).toMatch(/^[0-9a-g ]+$/);
    }
  });

  it('treats "minimal" as "fixed" where both need the same digits (n = 3: 3 digits either way)', () => {
    const p = params({ n: 3 });
    const { stego } = embedMessage(noiseImage(60, 60, 4), p, FIXED_MSD, utf8Encode('same reading'));
    const out = run(stego, { n: '3', length: 12, grouping: 'minimal' });
    expect(text(out, 'Message (selected convention)')).toBe('same reading');
    expect(table(out, 'Digit-to-text conventions tried').rows).toHaveLength(4);
  });

  it('warns about lossy files and errors clearly on bad settings', () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0);
    expect(resultToText(run(noiseImage(20, 20), {}, jpeg))).toMatch(
      /does not look like a PNG or BMP/,
    );
    expect(
      resultToText(run(noiseImage(20, 20), {}, Uint8Array.of(0x89, 0x50, 0x4e, 0x47))),
    ).not.toMatch(/does not look like a PNG/);
    const img = noiseImage(10, 10);
    expect(() => run(img, { offset: 500 })).toThrow(/Nothing to read/);
    expect(() => run(img, { offset: -1 })).toThrow(/Start offset/);
    expect(() => run(img, { length: 1.5 })).toThrow(/Message length/);
    expect(() => run(img, { n: '9' })).toThrow(/Group size n/);
  });
});

describe('emd tool, embed', () => {
  it('embeds into a cover and proves the round trip', async () => {
    const { image } = await sample('emd-cover.png');
    const out = run(image, { mode: 'embed', message: 'HELLO_EMD' });
    expect(out[0]).toEqual({
      type: 'note',
      level: 'success',
      text: "Round trip: OK, extracted 'HELLO_EMD'",
    });
    expect(kv(out, 'Digits written')).toBe('36 digits for 9 bytes');
    expect(kv(out, 'Groups used')).toBe('36 of 16384');
    expect(kv(out, 'Largest change')).toBe('±1');
    expect(kv(out, 'Pixels changed')).toMatch(/^\d+ of 32768 \(\d+\.\d\d%\)$/);
    expect(kv(out, 'PSNR')).toMatch(/^\d+\.\d\d dB$/);
    expect(text(out, 'Digits written (base 5)')).toBe(
      '0242 0234 0301 0301 0304 0340 0234 0302 0233',
    );
    const files = out.find((o) => o.type === 'files');
    const png = files?.type === 'files' ? files.files[0]! : null;
    expect(png?.name).toBe('emd-stego.png');
    // the downloadable PNG is the sample, byte for byte: the tool and the generator agree
    const hello = new Uint8Array(
      readFileSync(new URL('../../../public/samples/emd-hello.png', import.meta.url)),
    );
    expect(Array.from(png!.data)).toEqual(Array.from(hello));
    const image2 = out.find((o) => o.type === 'image');
    expect(image2?.type === 'image' && image2.image.width).toBe(256);
  });

  it('embeds with the options chosen, and the extractor reads the result back with them', () => {
    const cover = noiseImage(90, 70, 12);
    const out = run(cover, {
      mode: 'embed',
      message: 'héllo, wörld',
      n: '3',
      channel: 'luma',
      traversal: 'vertical',
      offset: 40,
      grouping: 'minimal',
      order: 'lsd',
    });
    // 'é' is 195 169 in UTF-8: too big for 3 digits in base 7? 7^3 = 343 covers it
    expect(out[0]!.type === 'note' && out[0]!.level).toBe('success');
    const files = out.find((o) => o.type === 'files');
    expect(files?.type).toBe('files');
  });

  it('reports the saturation fallback instead of hiding it', () => {
    const out = run(pickImage(30, 30, [0, 255], 3), { mode: 'embed', message: 'dark and bright' });
    expect(out[0]!.type === 'note' && out[0]!.level).toBe('success');
    expect(Number(kv(out, 'Largest change').slice(1))).toBeGreaterThan(1);
    expect(resultToText(out)).toMatch(/needed a change larger than ±1/);
  });

  it('fails with the groups needed against the groups available', () => {
    const cover = noiseImage(10, 10, 1); // 100 pixels = 50 groups; 13 bytes need 52
    expect(() => run(cover, { mode: 'embed', message: 'x'.repeat(13) })).toThrow(
      /needs 52 groups but only 50 are available after offset 0/,
    );
    expect(run(cover, { mode: 'embed', message: 'x'.repeat(12) })[0]!.type).toBe('note');
    // the offset eats into the room: 100 - 4 pixels still give 48 groups, 100 - 6 only 47
    expect(run(cover, { mode: 'embed', message: 'x'.repeat(12), offset: 4 })[0]!.type).toBe('note');
    expect(() => run(cover, { mode: 'embed', message: 'x'.repeat(12), offset: 6 })).toThrow(
      /needs 48 groups but only 47 are available after offset 6/,
    );
  });

  it('rejects an empty message, Auto, and a byte the convention cannot hold', () => {
    const cover = noiseImage(40, 40, 1);
    expect(() => run(cover, { mode: 'embed', message: '' })).toThrow(/Type the message/);
    expect(() => run(cover, { mode: 'embed', message: 'a', channel: 'auto' })).toThrow(
      /Auto only guesses/,
    );
    expect(() => run(cover, { mode: 'embed', message: 'a}', grouping: 'minimal' })).toThrow(
      /Byte 125 needs more than 3 digits/,
    );
  });

  it('survives its own output: embed in the tool, save the PNG, open it, extract', async () => {
    const cover = noiseImage(64, 48, 17);
    const out = run(cover, { mode: 'embed', message: 'through a PNG file', channel: 'g' });
    const files = out.find((o) => o.type === 'files');
    const bytes = files?.type === 'files' ? files.files[0]!.data : new Uint8Array();
    const opened = (await prepareInput('image', { bytes })) as ImageInput;
    const back = run(opened.image, { channel: 'g', length: 18 }, bytes);
    expect(text(back, 'Message (selected convention)')).toBe('through a PNG file');
  });
});

// ---------- speed ----------

describe('speed', () => {
  it('embeds and reads 100 000 characters in a 2000 x 2000 image within the budget', () => {
    const img = noiseImage(2000, 2000, 123);
    const next = rng(5);
    const msg = Uint8Array.from({ length: 100_000 }, () => 32 + (next() % 91));
    const t0 = performance.now();
    const { stego, digits } = embedMessage(img, params(), FIXED_MSD, msg);
    const back = digitsToBytes(
      readDigits(stego, params(), digits.length),
      5,
      FIXED_MSD,
      msg.length,
    )!;
    const ms = performance.now() - t0;
    expect(Array.from(back.subarray(0, 50))).toEqual(Array.from(msg.subarray(0, 50)));
    expect(back.length).toBe(msg.length);
    expect(ms).toBeLessThan(5000);
  });

  it('runs the tool in "all" mode on 2000 x 2000 pixels, and Auto on a large image', () => {
    const img = noiseImage(2000, 2000, 7);
    let t0 = performance.now();
    const all = run(img, { length: 0 });
    const allMs = performance.now() - t0;
    expect(text(all, 'Raw digits (base 5)').length).toBeLessThan(3000);
    expect(kv(all, 'Groups read')).toBe('2000000 (one digit each)');
    expect(allMs).toBeLessThan(6000);
    t0 = performance.now();
    run(img, { channel: 'auto', length: 0 });
    expect(performance.now() - t0).toBeLessThan(15_000);
  });

  it('embeds in the luma channel of a 1000 x 1000 image within the budget', () => {
    const img = noiseImage(1000, 1000, 8);
    const msg = utf8Encode('luma '.repeat(2000));
    const t0 = performance.now();
    const { stego, digits } = embedMessage(img, params({ channel: 'luma' }), FIXED_MSD, msg);
    const back = digitsToBytes(
      readDigits(stego, params({ channel: 'luma' }), digits.length),
      5,
      FIXED_MSD,
      msg.length,
    )!;
    expect(utf8Decode(back)).toBe(utf8Decode(msg));
    expect(performance.now() - t0).toBeLessThan(6000);
  });
});
