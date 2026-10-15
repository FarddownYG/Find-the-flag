// EMD core (Exploiting Modification Direction). No dependency, no DOM.
//
// Ported unchanged from the reference implementation: only the formatting, a few `!` for
// noUncheckedIndexedAccess and the comments (now English) differ. Error messages are the
// reference's own; the tool checks the same conditions first and shows translated errors.

export interface Gray {
  data: Uint8Array | Uint8ClampedArray; // 1 byte per pixel, row by row
  width: number;
  height: number;
}

export interface EmdParams {
  n: number; // pixels per group; every group carries 1 digit in base m = 2n+1
  k: number; // digits (base m) per character
  length: number; // number of characters in the message
  weights: 'asc' | 'desc'; // f = 1*g1 + ... + n*gn (asc) or n*g1 + ... + 1*gn (desc)
  digitOrder: 'msb' | 'lsb'; // most significant digit first, or the reverse
  scan: 'row' | 'col'; // row by row (x axis first) or column by column
  offset: number; // pixels to skip at the start of the scan
}

export const DEFAULTS: EmdParams = {
  n: 2,
  k: 3,
  length: 892,
  weights: 'asc',
  digitOrder: 'msb',
  scan: 'row',
  offset: 0,
};

/** Flattens the image in the chosen scan order. */
export function flatten(img: Gray, scan: 'row' | 'col'): Uint8Array {
  const { data, width: w, height: h } = img;
  if (scan === 'row') return Uint8Array.from(data);
  const out = new Uint8Array(w * h);
  let i = 0;
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) out[i++] = data[y * w + x]!;
  return out;
}

function weightOf(j: number, n: number, weights: 'asc' | 'desc'): number {
  return weights === 'asc' ? j + 1 : n - j;
}

/** One digit (0..2n) per group of n pixels: f = sum(w_j * g_j) mod (2n+1). */
export function extractDigits(
  pixels: Uint8Array,
  n: number,
  weights: 'asc' | 'desc',
  offset: number,
  count: number,
): number[] {
  const m = 2 * n + 1;
  const digits: number[] = [];
  for (let g = 0; g < count; g++) {
    const base = offset + g * n;
    if (base + n > pixels.length) break; // not enough pixels left
    let f = 0;
    for (let j = 0; j < n; j++) f += weightOf(j, n, weights) * pixels[base + j]!;
    digits.push(f % m);
  }
  return digits;
}

/** Groups k digits into a character code. */
export function digitsToCodes(
  digits: number[],
  m: number,
  k: number,
  order: 'msb' | 'lsb',
  length: number,
): number[] {
  const codes: number[] = [];
  for (let c = 0; c < length; c++) {
    const chunk = digits.slice(c * k, c * k + k);
    if (chunk.length < k) break;
    if (order === 'lsb') chunk.reverse();
    codes.push(chunk.reduce((acc, d) => acc * m + d, 0));
  }
  return codes;
}

export function codesToText(codes: number[]): string {
  return codes.map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '·')).join('');
}

export interface DecodeResult {
  text: string;
  printable: number; // ratio 0..1 of printable ASCII characters
  readable: number; // ratio 0..1 of "text" characters (letters, digits, space, common punctuation)
}

const READABLE = /[A-Za-z0-9 .,;:'!?()\-_{}/]/;

export function decodeEmd(img: Gray, p: EmdParams = DEFAULTS): DecodeResult {
  const m = 2 * p.n + 1;
  const px = flatten(img, p.scan);
  const digits = extractDigits(px, p.n, p.weights, p.offset, p.length * p.k);
  const codes = digitsToCodes(digits, m, p.k, p.digitOrder, p.length);
  const text = codesToText(codes);
  const total = Math.max(codes.length, 1);
  const printable = codes.filter((c) => c >= 32 && c < 127).length / total;
  const readable = [...text].filter((ch) => READABLE.test(ch)).length / total;
  return { text, printable, readable };
}

export interface Candidate {
  params: EmdParams;
  result: DecodeResult;
}

/** Tries every plausible variant, ranked by decreasing readability. */
export function autoSearch(img: Gray, n: number, length: number, kMax = 8): Candidate[] {
  const out: Candidate[] = [];
  for (const scan of ['row', 'col'] as const)
    for (const weights of ['asc', 'desc'] as const)
      for (const digitOrder of ['msb', 'lsb'] as const)
        for (let k = 1; k <= kMax; k++) {
          const params: EmdParams = { n, k, length, weights, digitOrder, scan, offset: 0 };
          out.push({ params, result: decodeEmd(img, params) });
        }
  return out.sort((a, b) => b.result.readable - a.result.readable);
}

/**
 * Encoder (to test the tool with a round trip, or to build a CTF).
 * Modifies `img.data` in place. Returns the number of groups that could not be adjusted
 * (pixel already at 0 or 255: the +/-1 would leave the range).
 */
export function encodeEmd(img: Gray, text: string, p: EmdParams = DEFAULTS): number {
  const m = 2 * p.n + 1;
  const px = flatten(img, p.scan); // copy
  const digits: number[] = [];
  for (const ch of text) {
    let v = ch.charCodeAt(0);
    if (v >= m ** p.k) throw new Error(`caractere ${JSON.stringify(ch)} (${v}) >= ${m}^${p.k}`);
    const d: number[] = [];
    for (let i = 0; i < p.k; i++) {
      d.push(v % m);
      v = Math.floor(v / m);
    }
    digits.push(...(p.digitOrder === 'msb' ? d.reverse() : d));
  }
  if (p.offset + digits.length * p.n > px.length) throw new Error('image trop petite');
  let overflow = 0;
  digits.forEach((want, g) => {
    const base = p.offset + g * p.n;
    let f = 0;
    for (let j = 0; j < p.n; j++) f += weightOf(j, p.n, p.weights) * px[base + j]!;
    const s = (((want - f) % m) + m) % m; // shift of f to apply
    if (s === 0) return;
    // s in 1..n: +1 on the pixel of weight s; s in n+1..2n: -1 on the pixel of weight m-s
    const w = s <= p.n ? s : m - s;
    const delta = s <= p.n ? 1 : -1;
    const j = p.weights === 'asc' ? w - 1 : p.n - w;
    const nv = px[base + j]! + delta;
    if (nv < 0 || nv > 255) overflow++;
    else px[base + j] = nv;
  });
  // write back in the image's original order
  if (p.scan === 'row') img.data.set(px);
  else {
    let i = 0;
    for (let x = 0; x < img.width; x++)
      for (let y = 0; y < img.height; y++) img.data[y * img.width + x] = px[i++]!;
  }
  return overflow;
}

/**
 * Canvas -> grayscale. Browser only.
 * colorSpaceConversion:'none': otherwise the browser may recolour the image (ICC profile)
 * and change the pixel values, which destroys the message.
 */
export async function fileToGray(
  file: Blob,
  channel: 'gray' | 'r' | 'g' | 'b' = 'gray',
): Promise<Gray> {
  const bmp = await createImageBitmap(file, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const data = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0; i < data.length; i++) {
    const r = rgba[4 * i]!,
      g = rgba[4 * i + 1]!,
      b = rgba[4 * i + 2]!;
    data[i] =
      channel === 'r'
        ? r
        : channel === 'g'
          ? g
          : channel === 'b'
            ? b
            : Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { data, width: bmp.width, height: bmp.height };
}
