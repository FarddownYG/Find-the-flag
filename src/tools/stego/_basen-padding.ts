/**
 * Hidden bits in the padding of base64 / base32 lines ("base-N padding steganography").
 *
 * A base64 symbol carries 6 bits and a base32 symbol 5, but the bytes behind a line are a
 * multiple of 8 bits, so the last symbol of a padded line has a few bits no byte needs. A normal
 * encoder writes zeros there; a decoder ignores them, so they can hold anything. The count follows
 * from the number of "=" (this table is the contract of the tool and of its tests):
 *
 *   base64:  "="  -> 2 bits   "==" -> 4 bits   no "=" -> 0
 *   base32:  "======" -> 2    "====" -> 4      "===" -> 1     "=" -> 3     no "=" -> 0
 *
 * Reading: per line, the real bytes are the first 8 * bytes bits; the trailing bits of the last
 * symbol are hidden payload. They are concatenated (most significant bit first) over all lines
 * and grouped into bytes; fewer than 8 bits left over are reported apart.
 *
 * Everything here is linear in the size of the text: one pass to split and classify the lines
 * (character class table, no regular expression), one pass to decode them.
 */
import { latin1Decode, utf8Encode } from '../../lib/bytes';

export type Base = 'base64' | 'base32';
export type BaseChoice = 'auto' | Base;

/** Hidden bits per line by number of "=": the unused bits of the last symbol. */
export const HIDDEN_BITS: Record<Base, Readonly<Record<number, number>>> = {
  base64: { 0: 0, 1: 2, 2: 4 },
  base32: { 0: 0, 1: 3, 3: 1, 4: 4, 6: 2 },
};

/** Rows of the per-padding table, in display order. */
export const PADDING_TYPES: readonly { base: Base; pad: number }[] = [
  { base: 'base64', pad: 0 },
  { base: 'base64', pad: 1 },
  { base: 'base64', pad: 2 },
  { base: 'base32', pad: 0 },
  { base: 'base32', pad: 1 },
  { base: 'base32', pad: 3 },
  { base: 'base32', pad: 4 },
  { base: 'base32', pad: 6 },
];
const TYPE_INDEX: Record<Base, Record<number, number>> = {
  base64: { 0: 0, 1: 1, 2: 2 },
  base32: { 0: 3, 1: 4, 3: 5, 4: 6, 6: 7 },
};

// ---------- character classes ----------

const UP = 1; // A-Z
const LO = 2; // a-z
const D27 = 4; // 2-7
const D0189 = 8; // 0 1 8 9
const PS = 16; // + /
const US = 32; // - _
const EQ = 64; // =
const OTHER = 128;

const CLASS = new Uint8Array(128).fill(OTHER);
const B64 = new Int8Array(128).fill(-1); // standard and URL-safe alphabets together
const B32 = new Int8Array(128).fill(-1); // upper and lower case
for (let i = 0; i < 26; i++) {
  CLASS[65 + i] = UP;
  CLASS[97 + i] = LO;
  B64[65 + i] = i;
  B64[97 + i] = 26 + i;
  B32[65 + i] = i;
  B32[97 + i] = i;
}
for (let d = 0; d < 10; d++) {
  CLASS[48 + d] = d >= 2 && d <= 7 ? D27 : D0189;
  B64[48 + d] = 52 + d;
  if (d >= 2 && d <= 7) B32[48 + d] = 26 + d - 2;
}
CLASS[43] = PS; // +
CLASS[47] = PS; // /
CLASS[45] = US; // -
CLASS[95] = US; // _
CLASS[61] = EQ; // =
B64[43] = B64[45] = 62;
B64[47] = B64[95] = 63;

const isSpace = (c: number) =>
  c === 32 || c === 9 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff;

/** Does a body of `n` symbols followed by `pad` "=" make a well-formed base64 line? */
function consistent64(n: number, pad: number): boolean {
  switch (pad) {
    case 0:
      return n % 4 !== 1;
    case 1:
      return n % 4 === 3;
    case 2:
      return n % 4 === 2;
    default:
      return false;
  }
}

function consistent32(n: number, pad: number): boolean {
  const r = n % 8;
  switch (pad) {
    case 0:
      return r === 0 || r === 2 || r === 4 || r === 5 || r === 7;
    case 1:
      return r === 7;
    case 3:
      return r === 5;
    case 4:
      return r === 4;
    case 6:
      return r === 2;
    default:
      return false;
  }
}

// ---------- growable byte / bit sinks ----------

class ByteSink {
  private buf = new Uint8Array(1024);
  length = 0;
  push(b: number): void {
    if (this.length === this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.length++] = b;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Bits (most significant first) grouped into bytes as they arrive. */
class BitSink {
  private out = new ByteSink();
  private acc = 0;
  private nbits = 0;
  total = 0;
  push(value: number, count: number): void {
    this.acc = (this.acc << count) | value;
    this.nbits += count;
    this.total += count;
    if (this.nbits >= 8) {
      this.nbits -= 8;
      this.out.push((this.acc >> this.nbits) & 0xff);
      this.acc &= (1 << this.nbits) - 1;
    }
  }
  bytes(): Uint8Array {
    return this.out.bytes();
  }
  get tailBits(): number {
    return this.nbits;
  }
  get tailValue(): number {
    return this.acc;
  }
}

// ---------- reading ----------

export interface TypeStat {
  base: Base;
  pad: number;
  /** Hidden bits one line of this type carries. */
  hidden: number;
  lines: number;
  /** Lines whose hidden bits are not all zero. */
  nonzero: number;
}

export interface SkippedLine {
  /** 1-based line number in the input. */
  line: number;
  /** The start of the line, cut for display. */
  text: string;
}

export interface Analysis {
  /** Lines with something on them (not counting blank lines). */
  lines: number;
  blank: number;
  /** Lines read as base64 or base32. */
  used: number;
  skipped: number;
  skippedSamples: SkippedLine[];
  perBase: Record<Base, number>;
  types: TypeStat[];
  /** Total hidden bits. */
  bits: number;
  /** Lines that carry hidden bits (those with "="). */
  carrying: number;
  /** Lines whose hidden bits are not all zero (an ordinary encoder writes zeros). */
  nonzero: number;
  /** The hidden bits grouped into bytes. */
  payload: Uint8Array;
  /** Bits that do not fill a last byte, and their value. */
  tailBits: number;
  tailValue: number;
  /** The ordinary decoding of the lines, concatenated. */
  visible: Uint8Array;
}

const SAMPLE_MAX = 5;
const SAMPLE_WIDTH = 60;

interface Scan {
  starts: number[];
  ends: number[];
  /** End of the symbols (before the "="). */
  bodyEnds: number[];
  pads: number[];
  /** Bit 0: valid base64, bit 1: valid base32, 0: neither. */
  kinds: number[];
  masks: number[];
  lineNos: number[];
  blank: number;
}

/** Split into lines (LF, CRLF or CR), trim, and classify each by its characters and padding. */
function scan(text: string): Scan {
  const sc: Scan = {
    starts: [],
    ends: [],
    bodyEnds: [],
    pads: [],
    kinds: [],
    masks: [],
    lineNos: [],
    blank: 0,
  };
  const n = text.length;
  let i = 0;
  let lineNo = 0;
  while (i < n) {
    let j = i;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 10 || c === 13) break;
      j++;
    }
    lineNo++;
    let s = i;
    let e = j;
    while (s < e && isSpace(text.charCodeAt(s))) s++;
    while (e > s && isSpace(text.charCodeAt(e - 1))) e--;
    if (s === e) {
      sc.blank++;
    } else {
      let pad = 0;
      while (e - 1 - pad >= s && text.charCodeAt(e - 1 - pad) === 61) pad++;
      const be = e - pad;
      let mask = 0;
      for (let q = s; q < be; q++) {
        const c = text.charCodeAt(q);
        mask |= c < 128 ? CLASS[c]! : OTHER;
      }
      const nb = be - s;
      let kind = 0;
      if (nb >= 2 && (mask & (OTHER | EQ)) === 0) {
        if (!(mask & PS && mask & US) && consistent64(nb, pad)) kind |= 1;
        if (
          (mask & (D0189 | PS | US)) === 0 &&
          !(mask & UP && mask & LO) &&
          consistent32(nb, pad)
        ) {
          kind |= 2;
        }
      }
      sc.starts.push(s);
      sc.ends.push(e);
      sc.bodyEnds.push(be);
      sc.pads.push(pad);
      sc.kinds.push(kind);
      sc.masks.push(mask);
      sc.lineNos.push(lineNo);
    }
    i = j + (j + 1 < n && text.charCodeAt(j) === 13 && text.charCodeAt(j + 1) === 10 ? 2 : 1);
  }
  return sc;
}

/**
 * Read the padding bits of every base64 / base32 line of `text`.
 *
 * With 'auto' each line is read by its own alphabet and padding: "==" can only be base64, "===",
 * "====" and "======" only base32, mixed case or + / - _ 0 1 8 9 only base64. A line both could
 * explain (a single "=" on an upper-case line of the right length, or no "=" at all) follows the
 * majority of the unambiguous lines, and without any a line of capitals and 2-7 (8 characters or
 * more, "=" included) is base32.
 */
export function analyze(text: string, choice: BaseChoice = 'auto'): Analysis {
  const sc = scan(text);
  let only64 = 0;
  let only32 = 0;
  for (const k of sc.kinds) {
    if (k === 1) only64++;
    else if (k === 2) only32++;
  }

  const types: TypeStat[] = PADDING_TYPES.map((p) => ({
    ...p,
    hidden: HIDDEN_BITS[p.base][p.pad] ?? 0,
    lines: 0,
    nonzero: 0,
  }));
  const perBase: Record<Base, number> = { base64: 0, base32: 0 };
  const hiddenBits = new BitSink();
  const visible = new ByteSink();
  const samples: SkippedLine[] = [];
  let used = 0;
  let skipped = 0;
  let carrying = 0;
  let nonzero = 0;

  for (let k = 0; k < sc.kinds.length; k++) {
    const kind = sc.kinds[k]!;
    const s = sc.starts[k]!;
    const be = sc.bodyEnds[k]!;
    const pad = sc.pads[k]!;
    let base: Base | null = null;
    if (kind !== 0) {
      if (choice === 'base64') base = kind & 1 ? 'base64' : null;
      else if (choice === 'base32') base = kind & 2 ? 'base32' : null;
      else if (kind === 1) base = 'base64';
      else if (kind === 2) base = 'base32';
      else if (only64 !== only32) base = only64 > only32 ? 'base64' : 'base32';
      else {
        const m = sc.masks[k]!;
        base = m & UP && !(m & LO) && sc.ends[k]! - s >= 8 ? 'base32' : 'base64';
      }
    }
    if (base === null) {
      skipped++;
      if (samples.length < SAMPLE_MAX) {
        const e = sc.ends[k]!;
        const cut = e - s > SAMPLE_WIDTH;
        samples.push({
          line: sc.lineNos[k]!,
          text: text.slice(s, cut ? s + SAMPLE_WIDTH : e) + (cut ? '…' : ''),
        });
      }
      continue;
    }

    used++;
    perBase[base]++;
    const stat = types[TYPE_INDEX[base][pad]!]!;
    stat.lines++;
    let acc = 0;
    let bits = 0;
    if (base === 'base64') {
      for (let q = s; q < be; q++) {
        acc = (acc << 6) | B64[text.charCodeAt(q)]!;
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          visible.push((acc >> bits) & 0xff);
          acc &= (1 << bits) - 1;
        }
      }
    } else {
      for (let q = s; q < be; q++) {
        acc = (acc << 5) | B32[text.charCodeAt(q)]!;
        bits += 5;
        if (bits >= 8) {
          bits -= 8;
          visible.push((acc >> bits) & 0xff);
          acc &= (1 << bits) - 1;
        }
      }
    }
    if (stat.hidden > 0) {
      const value = acc & ((1 << stat.hidden) - 1);
      hiddenBits.push(value, stat.hidden);
      carrying++;
      if (value !== 0) {
        nonzero++;
        stat.nonzero++;
      }
    }
  }

  return {
    lines: sc.kinds.length,
    blank: sc.blank,
    used,
    skipped,
    skippedSamples: samples,
    perBase,
    types,
    bits: hiddenBits.total,
    carrying,
    nonzero,
    payload: hiddenBits.bytes(),
    tailBits: hiddenBits.tailBits,
    tailValue: hiddenBits.tailValue,
    visible: visible.bytes(),
  };
}

/** The bits that do not fill a byte, as "0" and "1" ('' when there are none). */
export const tailString = (a: Analysis): string =>
  a.tailBits ? a.tailValue.toString(2).padStart(a.tailBits, '0') : '';

/** `bytes` without its trailing zero bytes (the unused padding of a cover that was too long). */
export function trimZeros(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

// ---------- layers ----------

/** The hidden payload as the text of the next layer; null when there is nothing to read. */
export function payloadText(a: Analysis): string | null {
  const bytes = trimZeros(a.payload);
  return bytes.length ? latin1Decode(bytes) : null;
}

const isAsciiText = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13)) return false;
  }
  return true;
};

/**
 * Is this text base64 / base32 lines with padding, i.e. worth reading as another layer? Printable
 * ASCII only, at least 80 % of its lines readable, and at least one padded line (otherwise it
 * has no padding bits and a short word such as "Test" would pass for base64).
 */
export function looksLikeBaseN(text: string, choice: BaseChoice): Analysis | null {
  if (text.length < 4 || !isAsciiText(text)) return null;
  const a = analyze(text, choice);
  if (a.lines === 0 || a.used * 5 < a.lines * 4 || a.carrying === 0) return null;
  return a;
}

export interface Layer {
  /** 1 for the input itself, 2 for the hidden payload of layer 1, and so on. */
  index: number;
  analysis: Analysis;
}

/**
 * - noBits: the last layer hides nothing (no padding bits, or fewer than a byte)
 * - notBase: its payload exists but is not base64 / base32 lines: end of the chain
 * - limit: its payload looks like base64 / base32 again but the layer limit was reached
 */
export type Stop = 'noBits' | 'notBase' | 'limit';

export interface Chain {
  layers: Layer[];
  stop: Stop;
  /** Set when a layer before `start` had no payload: there is no layer `start`. */
  emptyAt?: number;
}

/**
 * Read layer `start` (1 = the input itself; 2 = the hidden payload of layer 1 taken as the
 * input...) and keep going for up to `levels` layers while the hidden payload itself looks like
 * base64 / base32 lines with padding.
 */
export function followLayers(
  text: string,
  choice: BaseChoice,
  levels: number,
  start: number,
): Chain {
  let current = analyze(text, choice);
  for (let k = 1; k < start; k++) {
    const next = payloadText(current);
    if (next === null) return { layers: [], stop: 'noBits', emptyAt: k };
    current = analyze(next, choice);
  }
  const layers: Layer[] = [];
  let stop: Stop = 'noBits';
  for (let n = 0; n < levels; n++) {
    layers.push({ index: start + n, analysis: current });
    const next = payloadText(current);
    if (next === null) {
      stop = 'noBits';
      break;
    }
    const nextAnalysis = looksLikeBaseN(next, choice);
    if (!nextAnalysis) {
      stop = 'notBase';
      break;
    }
    if (n === levels - 1) {
      stop = 'limit';
      break;
    }
    current = nextAnalysis;
  }
  return { layers, stop };
}

// ---------- writing ----------

const ALPHABET: Record<Base, string> = {
  base64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  base32: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
};
const SYMBOL_BITS: Record<Base, number> = { base64: 6, base32: 5 };
const GROUP: Record<Base, number> = { base64: 4, base32: 8 };

/** Padding bits a line of `length` bytes can carry (0 when it fills its last symbol). */
export function lineCapacity(length: number, base: Base): number {
  const sb = SYMBOL_BITS[base];
  return (sb - ((8 * length) % sb)) % sb;
}

/** Encode `bytes` with `hidden` (its low `bits` bits) written into the padding bits. */
export function encodeLine(bytes: Uint8Array, base: Base, hidden: number, bits: number): string {
  const abc = ALPHABET[base];
  const sb = SYMBOL_BITS[base];
  const mask = (1 << sb) - 1;
  let out = '';
  let acc = 0;
  let nb = 0;
  let symbols = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    nb += 8;
    while (nb >= sb) {
      out += abc[(acc >> (nb - sb)) & mask];
      nb -= sb;
      symbols++;
    }
    acc &= (1 << nb) - 1;
  }
  if (nb > 0) {
    // The symbol holds nb data bits; the other sb - nb are the padding bits (bits === sb - nb).
    out += abc[((acc << (sb - nb)) | (hidden & ((1 << bits) - 1))) & mask];
    symbols++;
  }
  const group = GROUP[base];
  while (symbols % group) {
    out += '=';
    symbols++;
  }
  return out;
}

/**
 * A generated cover line: "line 0001" plus the spaces and the newline that make its length carry
 * the most padding bits (4) in this encoding. Its ordinary decoding reads as a plain list.
 */
export function coverLine(index: number, base: Base): Uint8Array {
  const m = base === 'base64' ? 3 : 5;
  const target = base === 'base64' ? 1 : 2;
  const stem = `line ${String(index + 1).padStart(4, '0')}`;
  const spaces = (((target - (stem.length + 1)) % m) + m) % m;
  return utf8Encode(`${stem}${' '.repeat(spaces)}\n`);
}

export interface HideRequest {
  base: Base;
  message: Uint8Array;
  /** Plain-text cover lines (not encoded yet). Empty: the cover is generated. */
  cover: string[];
  /** The cover lines are used this many times in a row. */
  repeat: number;
}

export interface Hidden {
  ok: true;
  /** The base64 / base32 lines, one per row. */
  text: string;
  lines: number;
  /** Lines that carry padding bits. */
  carrying: number;
  /** Padding bits of all the lines. */
  capacity: number;
  /** Bits of the message. */
  used: number;
  generated: boolean;
}

export interface TooSmall {
  ok: false;
  /** Bits the message needs. */
  needed: number;
  /** Bits the cover lines carry. */
  have: number;
  lines: number;
  /** Bits one pass over the cover carries (0: none of its lines has padding). */
  perPass: number;
  /** Passes over the cover the message would need. */
  passes: number;
}

/** Hide the bits of `message` (MSB first) in the padding bits of the cover lines, in order. */
export function hide(req: HideRequest): Hidden | TooSmall {
  const { base, message } = req;
  const needed = message.length * 8;
  const generated = req.cover.length === 0;
  let covers: Uint8Array[];
  let passes = 1;
  if (generated) {
    covers = Array.from({ length: Math.ceil(needed / 4) }, (_, i) => coverLine(i, base));
  } else {
    covers = req.cover.map((l) => utf8Encode(l));
    passes = Math.max(1, Math.floor(req.repeat));
  }
  let perPass = 0;
  for (const c of covers) perPass += lineCapacity(c.length, base);
  const capacity = perPass * passes;
  if (capacity < needed) {
    return {
      ok: false,
      needed,
      have: capacity,
      lines: covers.length * passes,
      perPass,
      passes: perPass > 0 ? Math.ceil(needed / perPass) : 0,
    };
  }

  const lines: string[] = [];
  let pos = 0;
  let carrying = 0;
  for (let r = 0; r < passes; r++) {
    for (const c of covers) {
      const cap = lineCapacity(c.length, base);
      let value = 0;
      if (cap > 0) {
        carrying++;
        for (let i = 0; i < cap; i++, pos++) {
          const bit = pos < needed ? (message[pos >> 3]! >> (7 - (pos & 7))) & 1 : 0;
          value = (value << 1) | bit;
        }
      }
      lines.push(encodeLine(c, base, value, cap));
    }
  }
  return {
    ok: true,
    text: lines.join('\n'),
    lines: lines.length,
    carrying,
    capacity,
    used: needed,
    generated,
  };
}

/** Does reading `text` back give exactly `message`, followed by nothing but zero bits? */
export function roundTrips(text: string, base: Base, message: Uint8Array): boolean {
  const a = analyze(text, base);
  if (a.bits < message.length * 8) return false;
  for (let i = 0; i < message.length; i++) if (a.payload[i] !== message[i]) return false;
  for (let i = message.length; i < a.payload.length; i++) if (a.payload[i] !== 0) return false;
  return a.tailValue === 0;
}
