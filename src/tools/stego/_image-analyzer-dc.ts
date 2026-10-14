/**
 * Average luminance of every 8x8 block of a JPEG, read from the DC coefficients only: no inverse
 * DCT, no colour conversion, no upsampling. That is all the thumbnail check needs (it averages
 * the picture down to a 32-cell grid anyway), at a fraction of the cost of a full decode of a
 * 12-megapixel photo. Baseline, extended and progressive Huffman JPEGs with 1 or 3 components;
 * anything else returns null and the caller decodes the whole picture instead.
 */

export interface LumaGrid {
  /** Size of the picture in pixels. */
  width: number;
  height: number;
  /** Size of the grid: one cell per 8x8 block of the luminance plane. */
  cols: number;
  rows: number;
  /** Mean luminance (0-255) of each block, row by row. */
  v: Float64Array;
}

interface Huffman {
  /** 9-bit lookahead: (code length << 8) | symbol, 0 when the code is longer. */
  fast: Uint16Array;
  maxcode: Int32Array;
  valptr: Int32Array;
  mincode: Int32Array;
  symbols: Uint8Array;
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
}

const FAST_BITS = 9;

function buildHuffman(counts: Uint8Array, symbols: Uint8Array): Huffman {
  const fast = new Uint16Array(1 << FAST_BITS);
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const n = counts[len - 1]!;
    valptr[len] = k;
    mincode[len] = code;
    for (let i = 0; i < n; i++, k++, code++) {
      if (len <= FAST_BITS) {
        const shift = FAST_BITS - len;
        for (let j = 0; j < 1 << shift; j++) fast[(code << shift) | j] = (len << 8) | symbols[k]!;
      }
    }
    maxcode[len] = n ? code - 1 : -1;
    code <<= 1;
  }
  return { fast, maxcode, valptr, mincode, symbols };
}

class BitReader {
  private buf = 0;
  private bits = 0;
  private marker = false;
  constructor(
    private readonly b: Uint8Array,
    public pos: number,
  ) {}

  private fill(): void {
    while (this.bits <= 24) {
      let byte = 0;
      if (!this.marker && this.pos < this.b.length) {
        byte = this.b[this.pos]!;
        if (byte === 0xff) {
          if (this.b[this.pos + 1] === 0) this.pos += 2;
          else {
            this.marker = true;
            byte = 0;
          }
        } else this.pos++;
      }
      this.buf = ((this.buf << 8) | byte) >>> 0;
      this.bits += 8;
    }
  }

  /** Symbol of the next Huffman code, or -1 for a code that is not in the table. */
  decode(h: Huffman): number {
    this.fill();
    const look = h.fast[(this.buf >>> (this.bits - FAST_BITS)) & ((1 << FAST_BITS) - 1)]!;
    if (look) {
      this.bits -= look >> 8;
      return look & 0xff;
    }
    for (let len = FAST_BITS + 1; len <= 16; len++) {
      const code = (this.buf >>> (this.bits - len)) & ((1 << len) - 1);
      if (code <= h.maxcode[len]!) {
        this.bits -= len;
        return h.symbols[h.valptr[len]! + code - h.mincode[len]!]!;
      }
    }
    return -1;
  }

  /** Next `n` bits (0..16) as a signed DCT value (JPEG's EXTEND). */
  receive(n: number): number {
    if (!n) return 0;
    this.fill();
    const v = (this.buf >>> (this.bits - n)) & ((1 << n) - 1);
    this.bits -= n;
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  }

  skip(n: number): void {
    if (!n) return;
    this.fill();
    this.bits -= n;
  }

  /** Skip to just after the next RSTn marker and start a fresh bit stream. */
  restart(): void {
    const b = this.b;
    let p = this.pos;
    while (p + 1 < b.length && !(b[p] === 0xff && b[p + 1]! >= 0xd0 && b[p + 1]! <= 0xd7)) p++;
    this.pos = Math.min(b.length, p + 2);
    this.buf = 0;
    this.bits = 0;
    this.marker = false;
  }
}

export function jpegDcLuma(b: Uint8Array): LumaGrid | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const q: number[] = [];
  const dc: Huffman[] = [];
  const ac: Huffman[] = [];
  let comps: Component[] = [];
  let width = 0;
  let height = 0;
  let progressive = false;
  let restartInterval = 0;
  let adobeTransform = -1;
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) return null;
    const marker = b[off + 1]!;
    if (marker === 0xff) {
      off++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    if (marker === 0xd9) return null;
    const len = (b[off + 2]! << 8) | b[off + 3]!;
    const start = off + 4;
    const end = off + 2 + len;
    if (len < 2 || end > b.length) return null;
    const d = b.subarray(start, end);
    if (marker === 0xdb) {
      for (let p = 0; p < d.length;) {
        const pq = d[p]! >> 4;
        q[d[p]! & 15] = pq ? (d[p + 1]! << 8) | d[p + 2]! : d[p + 1]!;
        p += pq ? 129 : 65;
      }
    } else if (marker === 0xc4) {
      for (let p = 0; p + 17 <= d.length;) {
        const counts = d.subarray(p + 1, p + 17);
        const n = counts.reduce((s, x) => s + x, 0);
        if (p + 17 + n > d.length) return null;
        const table = buildHuffman(counts, d.subarray(p + 17, p + 17 + n));
        (d[p]! >> 4 ? ac : dc)[d[p]! & 15] = table;
        p += 17 + n;
      }
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (d[0] !== 8 || d.length < 6) return null;
      progressive = marker === 0xc2;
      height = (d[1]! << 8) | d[2]!;
      width = (d[3]! << 8) | d[4]!;
      comps = [];
      for (let i = 0; i < d[5]!; i++) {
        const c = d.subarray(6 + i * 3, 9 + i * 3);
        if (c.length < 3) return null;
        comps.push({ id: c[0]!, h: c[1]! >> 4 || 1, v: c[1]! & 15 || 1, tq: c[2]! & 3 });
      }
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
      return null; // lossless, hierarchical or arithmetic-coded
    } else if (marker === 0xdd) {
      restartInterval = (d[0]! << 8) | d[1]!;
    } else if (
      marker === 0xee &&
      d.length >= 12 &&
      String.fromCharCode(...d.subarray(0, 5)) === 'Adobe'
    ) {
      adobeTransform = d[11]!;
    } else if (marker === 0xda) {
      // CMYK/YCCK and RGB JPEGs have no luminance component.
      if (!width || !height || !(comps.length === 1 || comps.length === 3)) return null;
      if (comps.length === 3 && adobeTransform === 0) return null;
      const grid = decodeScan(b, end, d, {
        comps,
        width,
        height,
        q,
        dc,
        ac,
        progressive,
        restartInterval,
      });
      if (grid !== 'next') return grid;
      // A progressive scan that does not hold the luminance DC: skip its entropy data.
      let p = end;
      while (
        p + 1 < b.length &&
        !(b[p] === 0xff && b[p + 1] !== 0 && (b[p + 1]! < 0xd0 || b[p + 1]! > 0xd7))
      ) {
        p++;
      }
      off = p;
      continue;
    }
    off = end;
  }
  return null;
}

interface Frame {
  comps: Component[];
  width: number;
  height: number;
  q: number[];
  dc: Huffman[];
  ac: Huffman[];
  progressive: boolean;
  restartInterval: number;
}

function decodeScan(
  b: Uint8Array,
  dataStart: number,
  header: Uint8Array,
  f: Frame,
): LumaGrid | null | 'next' {
  const ns = header[0]!;
  const scan: {
    comp: Component;
    index: number;
    dc: Huffman | undefined;
    ac: Huffman | undefined;
  }[] = [];
  for (let i = 0; i < ns; i++) {
    const id = header[1 + i * 2]!;
    const t = header[2 + i * 2]!;
    const index = f.comps.findIndex((c) => c.id === id);
    if (index < 0) return null;
    scan.push({ comp: f.comps[index]!, index, dc: f.dc[t >> 4], ac: f.ac[t & 15] });
  }
  const ss = header[1 + ns * 2]!;
  const se = header[2 + ns * 2]!;
  const ah = header[3 + ns * 2]! >> 4;
  const al = header[3 + ns * 2]! & 15;
  const lumaInScan = scan.some((s) => s.index === 0);
  // Progressive: only the first DC scan of the luminance is useful; refinements add one bit.
  if (f.progressive && (ss !== 0 || ah !== 0 || !lumaInScan)) return 'next';
  if (!lumaInScan) return 'next';
  if (scan.some((s) => !s.dc || (!f.progressive && !s.ac))) return null;
  const y = f.comps[0]!;
  const q0 = f.q[y.tq];
  if (q0 === undefined) return null;

  const hmax = Math.max(...f.comps.map((c) => c.h));
  const vmax = Math.max(...f.comps.map((c) => c.v));
  const mcusX = Math.ceil(f.width / (8 * hmax));
  const mcusY = Math.ceil(f.height / (8 * vmax));
  const cols = Math.ceil(Math.ceil((f.width * y.h) / hmax) / 8);
  const rows = Math.ceil(Math.ceil((f.height * y.v) / vmax) / 8);
  const v = new Float64Array(cols * rows);
  const r = new BitReader(b, dataStart);
  const preds = new Int32Array(ns);
  const skipAc = !f.progressive && se > 0;

  const block = (s: (typeof scan)[number], k: number, row: number, col: number): boolean => {
    const t = r.decode(s.dc!);
    if (t < 0 || t > 16) return false;
    preds[k] = preds[k]! + r.receive(t);
    if (skipAc) {
      for (let i = 1; i <= 63;) {
        const rs = r.decode(s.ac!);
        if (rs < 0) return false;
        const run = rs >> 4;
        const size = rs & 15;
        if (size) {
          r.skip(size);
          i += run + 1;
        } else if (run === 15) i += 16;
        else break;
      }
    }
    if (s.index === 0 && row < rows && col < cols) {
      const level = ((preds[k]! << al) * q0) / 8 + 128;
      v[row * cols + col] = level < 0 ? 0 : level > 255 ? 255 : level;
    }
    return true;
  };

  let mcu = 0;
  const restartIfDue = () => {
    if (f.restartInterval && mcu > 0 && mcu % f.restartInterval === 0) {
      r.restart();
      preds.fill(0);
    }
  };
  if (ns === 1) {
    // Non-interleaved: the component's own blocks in raster order, no MCU padding.
    const s = scan[0]!;
    const bw = Math.ceil(Math.ceil((f.width * s.comp.h) / hmax) / 8);
    const bh = Math.ceil(Math.ceil((f.height * s.comp.v) / vmax) / 8);
    for (let row = 0; row < bh; row++) {
      for (let col = 0; col < bw; col++, mcu++) {
        restartIfDue();
        if (!block(s, 0, row, col)) return null;
      }
    }
  } else {
    for (let my = 0; my < mcusY; my++) {
      for (let mx = 0; mx < mcusX; mx++, mcu++) {
        restartIfDue();
        for (let k = 0; k < ns; k++) {
          const s = scan[k]!;
          for (let by = 0; by < s.comp.v; by++) {
            for (let bx = 0; bx < s.comp.h; bx++) {
              if (!block(s, k, my * s.comp.v + by, mx * s.comp.h + bx)) return null;
            }
          }
        }
      }
    }
  }
  return { width: f.width, height: f.height, cols, rows, v };
}
