/**
 * Text of a PDF page: the page tree, the fonts (encodings, ToUnicode CMaps, widths), and an
 * interpreter for content streams that follows the text state and the graphics state far enough
 * to say where each piece of text is drawn and whether anyone can see it.
 *
 * Text that is drawn but invisible is reported with the reasons: render mode 3 (or clip only),
 * zero opacity, white fill, a tiny font size, a position outside the page, a hidden layer
 * (optional content), or a filled shape drawn over it later (a fake redaction).
 *
 * Limits of this reading, stated in the report: no glyph is drawn, so a font whose glyph order
 * does not follow its character codes can show a different text than the one extracted; and the
 * colour of the page behind the text is guessed from what was painted, not rendered.
 */
import {
  isArray,
  isDict,
  isKeyword,
  isName,
  isNum,
  isRef,
  isString,
  Lexer,
  PdfSyntaxError,
  type PdfDict,
  type PdfValue,
} from './_pdf-lex';
import type { ObjRecord, PdfDoc, XrefMap } from './_pdf-doc';
import { latin1Decode } from '../../lib/bytes';

// ---------- limits ----------

const MAX_PAGES = 50_000;
const MAX_CONTENT = 8 * 1024 * 1024;
const MAX_OPERATORS = 600_000;
const MAX_FORM_DEPTH = 8;
const MAX_RUNS = 150_000;

// ---------- types ----------

export type Box = [number, number, number, number];

export interface PageInfo {
  /** 1-based position in the page tree. */
  index: number;
  /** Object number of the page dictionary (null when it is a direct object). */
  num: number | null;
  dict: PdfDict;
  mediaBox: Box;
  cropBox: Box;
  rotate: number;
  resources: PdfDict | null;
  /** Object numbers of the content streams. */
  contents: number[];
}

export type HiddenReason =
  'render' | 'clip' | 'transparent' | 'white' | 'tiny' | 'offpage' | 'layer' | 'covered' | 'ocr';

export interface TextRun {
  text: string;
  /** The characters could not be mapped to Unicode: the text is a list of codes. */
  raw: boolean;
  x: number;
  y: number;
  /** End of the run along the baseline (same units as x). */
  x2: number;
  size: number;
  font: string;
  hidden: HiddenReason[];
}

export interface PageText {
  page: PageInfo;
  runs: TextRun[];
  notes: ('truncated' | 'budget' | 'noContent')[];
}

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** a × b: apply a first, then b (PDF row-vector convention). */
function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

const apply = (m: Mat, x: number, y: number): [number, number] => [
  x * m[0] + y * m[2] + m[4],
  x * m[1] + y * m[3] + m[5],
];

function matrixOf(v: PdfValue | undefined): Mat | null {
  if (!isArray(v) || v.items.length < 6) return null;
  const n = v.items.slice(0, 6);
  return n.every(isNum) ? (n as Mat) : null;
}

// ---------- the page tree ----------

function boxOf(doc: PdfDoc, view: XrefMap, v: PdfValue | undefined): Box | null {
  const a = doc.resolve(v, view);
  if (!isArray(a) || a.items.length < 4) return null;
  const n = a.items.slice(0, 4).map((x) => doc.resolve(x, view));
  if (!n.every(isNum)) return null;
  const [x1, y1, x2, y2] = n as [number, number, number, number];
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

const DEFAULT_BOX: Box = [0, 0, 612, 792];

/** The pages of a document, in order, as the given view sees them. */
export function collectPages(doc: PdfDoc, view: XrefMap): PageInfo[] {
  const pages: PageInfo[] = [];
  const root = doc.dictOf(doc.trailer.map.get('Root'), view);
  const top = root?.map.get('Pages');
  const seen = new Set<number>();

  interface Inherited {
    resources: PdfDict | null;
    media: Box | null;
    crop: Box | null;
    rotate: number;
  }
  const visit = (ref: PdfValue | undefined, inherited: Inherited, depth: number): void => {
    if (pages.length >= MAX_PAGES || depth > 40) return;
    let num: number | null = null;
    if (isRef(ref)) {
      if (seen.has(ref.num)) return;
      seen.add(ref.num);
      num = ref.num;
    }
    const node = doc.dictOf(ref, view);
    if (!node) return;
    const next: Inherited = {
      resources: doc.dictOf(node.map.get('Resources'), view) ?? inherited.resources,
      media: boxOf(doc, view, node.map.get('MediaBox')) ?? inherited.media,
      crop: boxOf(doc, view, node.map.get('CropBox')) ?? inherited.crop,
      rotate: numberOr(doc.resolve(node.map.get('Rotate'), view), inherited.rotate),
    };
    const kids = doc.resolve(node.map.get('Kids'), view);
    const type = node.map.get('Type');
    if (isArray(kids) && !isName(type, 'Page')) {
      for (const kid of kids.items) visit(kid, next, depth + 1);
      return;
    }
    const media = next.media ?? DEFAULT_BOX;
    pages.push({
      index: pages.length + 1,
      num,
      dict: node,
      mediaBox: media,
      cropBox: intersect(next.crop ?? media, media),
      rotate: next.rotate,
      resources: next.resources,
      contents: contentRefs(doc, view, node.map.get('Contents')),
    });
  };
  visit(top, { resources: null, media: null, crop: null, rotate: 0 }, 0);

  if (pages.length === 0) {
    // No usable page tree: any page dictionary in the file is better than none
    for (const [num] of view) {
      const d = doc.dictOf({ k: 'ref', num, gen: 0 }, view);
      if (d && isName(d.map.get('Type'), 'Page') && pages.length < MAX_PAGES) {
        const media = boxOf(doc, view, d.map.get('MediaBox')) ?? DEFAULT_BOX;
        pages.push({
          index: pages.length + 1,
          num,
          dict: d,
          mediaBox: media,
          cropBox: media,
          rotate: 0,
          resources: doc.dictOf(d.map.get('Resources'), view),
          contents: contentRefs(doc, view, d.map.get('Contents')),
        });
      }
    }
  }
  return pages;
}

const numberOr = (v: PdfValue | undefined, def: number): number => (isNum(v) ? v : def);

function intersect(a: Box, b: Box): Box {
  const out: Box = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return out[0] < out[2] && out[1] < out[3] ? out : b;
}

function contentRefs(doc: PdfDoc, view: XrefMap, v: PdfValue | undefined): number[] {
  const out: number[] = [];
  const direct = isRef(v) ? doc.resolve(v, view) : v;
  if (isArray(direct)) {
    for (const item of direct.items) if (isRef(item)) out.push(item.num);
  } else if (isRef(v)) out.push(v.num);
  return out;
}

// ---------- fonts ----------

interface CMap {
  chars: Map<number, string>;
  ranges: { lo: number; hi: number; dst: string[] | string }[];
  /** Bytes per code from the code space ranges (1 or 2), or 0 when not stated. */
  codeBytes: number;
}

interface Font {
  name: string;
  type0: boolean;
  toUnicode: CMap | null;
  /** Single-byte fonts: the character of each code. */
  table: string[] | null;
  widths: Map<number, number>;
  defaultWidth: number;
  codeBytes: number;
}

const unitsToString = (units: number[]): string => String.fromCharCode(...units);

/** ToUnicode CMap (ISO 32000-1, 9.10.3; Adobe Technical Note #5411). */
export function parseCMap(data: Uint8Array): CMap {
  const cmap: CMap = { chars: new Map(), ranges: [], codeBytes: 0 };
  const lx = new Lexer(
    data.subarray(0, Math.min(data.length, 4 * 1024 * 1024)),
    0,
    undefined,
    false,
  );
  const readCode = (v: PdfValue | undefined): { code: number; bytes: number } | null => {
    if (!isString(v) || v.b.length === 0 || v.b.length > 4) return null;
    let code = 0;
    for (const b of v.b) code = code * 256 + b;
    return { code, bytes: v.b.length };
  };
  const readText = (v: PdfValue | undefined): string | null => {
    if (!isString(v)) return null;
    const units: number[] = [];
    if (v.b.length === 1) return String.fromCharCode(v.b[0]!);
    for (let i = 0; i + 1 < v.b.length; i += 2) units.push((v.b[i]! << 8) | v.b[i + 1]!);
    return unitsToString(units);
  };
  let mode: 'bfchar' | 'bfrange' | 'space' | null = null;
  let pending: PdfValue[] = [];
  let entries = 0;
  try {
    for (;;) {
      const v = lx.readValue();
      if (v === undefined) break;
      if (isKeyword(v)) {
        switch (v.v) {
          case 'beginbfchar':
            mode = 'bfchar';
            pending = [];
            break;
          case 'beginbfrange':
            mode = 'bfrange';
            pending = [];
            break;
          case 'begincodespacerange':
            mode = 'space';
            pending = [];
            break;
          case 'endbfchar':
          case 'endbfrange':
          case 'endcodespacerange':
            mode = null;
            pending = [];
            break;
          default:
            break;
        }
        continue;
      }
      if (mode === null) continue;
      pending.push(v);
      if (++entries > 200_000) break;
      if (mode === 'bfchar' && pending.length === 2) {
        const src = readCode(pending[0]);
        const dst = readText(pending[1]);
        if (src && dst !== null) cmap.chars.set(src.code, dst);
        pending = [];
      } else if (mode === 'space' && pending.length === 2) {
        const a = readCode(pending[0]);
        if (a) cmap.codeBytes = cmap.codeBytes === 0 ? a.bytes : Math.min(cmap.codeBytes, a.bytes);
        pending = [];
      } else if (mode === 'bfrange' && pending.length === 3) {
        const lo = readCode(pending[0]);
        const hi = readCode(pending[1]);
        const third = pending[2];
        if (lo && hi && hi.code >= lo.code && hi.code - lo.code < 0x10000) {
          if (isArray(third)) {
            const dst = third.items.map((x) => readText(x) ?? '');
            cmap.ranges.push({ lo: lo.code, hi: hi.code, dst });
          } else {
            const base = readText(third);
            if (base !== null) cmap.ranges.push({ lo: lo.code, hi: hi.code, dst: base });
          }
        }
        pending = [];
      }
    }
  } catch (e) {
    if (!(e instanceof PdfSyntaxError)) throw e;
  }
  return cmap;
}

function cmapLookup(cmap: CMap, code: number): string | null {
  const direct = cmap.chars.get(code);
  if (direct !== undefined) return direct;
  for (const r of cmap.ranges) {
    if (code < r.lo || code > r.hi) continue;
    if (Array.isArray(r.dst)) return r.dst[code - r.lo] ?? null;
    if (r.dst === '') return '';
    const last = r.dst.charCodeAt(r.dst.length - 1) + (code - r.lo);
    return r.dst.slice(0, -1) + String.fromCharCode(last & 0xffff);
  }
  return null;
}

const WIN_80 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

function winAnsi(): string[] {
  const t: string[] = [];
  for (let c = 0; c < 256; c++) {
    t[c] = c >= 0x80 && c < 0xa0 ? WIN_80[c - 0x80]! : String.fromCharCode(c);
  }
  return t;
}

function macRoman(): string[] {
  const t: string[] = [];
  let high: string[] = [];
  try {
    const bytes = Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i);
    high = [...new TextDecoder('macintosh').decode(bytes)];
  } catch {
    // no Mac Roman decoder in this runtime: the high half stays Latin-1
  }
  for (let c = 0; c < 256; c++) {
    t[c] = c >= 0x80 ? (high[c - 0x80] ?? String.fromCharCode(c)) : String.fromCharCode(c);
  }
  return t;
}

const BASE_ENCODINGS: Record<string, () => string[]> = {
  WinAnsiEncoding: winAnsi,
  MacRomanEncoding: macRoman,
  StandardEncoding: winAnsi,
  MacExpertEncoding: winAnsi,
};

const ACCENTS: Record<string, string> = {
  acute: '́',
  grave: '̀',
  circumflex: '̂',
  dieresis: '̈',
  tilde: '̃',
  ring: '̊',
  cedilla: '̧',
  caron: '̌',
  macron: '̄',
  breve: '̆',
  dotaccent: '̇',
  ogonek: '̨',
  hungarumlaut: '̋',
};

const GLYPHS: Record<string, string> = {
  space: ' ',
  exclam: '!',
  quotedbl: '"',
  numbersign: '#',
  dollar: '$',
  percent: '%',
  ampersand: '&',
  quotesingle: "'",
  parenleft: '(',
  parenright: ')',
  asterisk: '*',
  plus: '+',
  comma: ',',
  hyphen: '-',
  minus: '−',
  period: '.',
  slash: '/',
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  colon: ':',
  semicolon: ';',
  less: '<',
  equal: '=',
  greater: '>',
  question: '?',
  at: '@',
  bracketleft: '[',
  backslash: '\\',
  bracketright: ']',
  asciicircum: '^',
  underscore: '_',
  grave: '`',
  braceleft: '{',
  bar: '|',
  braceright: '}',
  asciitilde: '~',
  quoteright: '’',
  quoteleft: '‘',
  quotedblleft: '“',
  quotedblright: '”',
  quotesinglbase: '‚',
  quotedblbase: '„',
  bullet: '•',
  endash: '–',
  emdash: '—',
  ellipsis: '…',
  fi: 'ﬁ',
  fl: 'ﬂ',
  ff: 'ﬀ',
  ffi: 'ﬃ',
  ffl: 'ﬄ',
  copyright: '©',
  registered: '®',
  trademark: '™',
  degree: '°',
  plusminus: '±',
  section: '§',
  paragraph: '¶',
  germandbls: 'ß',
  euro: '€',
  Euro: '€',
  sterling: '£',
  yen: '¥',
  cent: '¢',
  currency: '¤',
  brokenbar: '¦',
  guillemotleft: '«',
  guillemotright: '»',
  guilsinglleft: '‹',
  guilsinglright: '›',
  exclamdown: '¡',
  questiondown: '¿',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  oslash: 'ø',
  Oslash: 'Ø',
  dagger: '†',
  daggerdbl: '‡',
  periodcentered: '·',
  nbspace: ' ',
  nonbreakingspace: ' ',
  multiply: '×',
  divide: '÷',
  mu: 'µ',
  onehalf: '½',
  onequarter: '¼',
  threequarters: '¾',
  florin: 'ƒ',
};

/** Adobe glyph names to text: the Latin set, accents, uniXXXX and uXXXX. */
export function glyphToText(name: string): string {
  const known = GLYPHS[name];
  if (known !== undefined) return known;
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (m) return String.fromCharCode(parseInt(m[1]!, 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1]!, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  m =
    /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron|macron|breve|dotaccent|ogonek|hungarumlaut)$/.exec(
      name,
    );
  if (m) return (m[1]! + ACCENTS[m[2]!]!).normalize('NFC');
  return '';
}

function loadFont(doc: PdfDoc, view: XrefMap, dict: PdfDict, label: string): Font {
  const get = (k: string) => doc.resolve(dict.map.get(k), view);
  const subtype = isName(get('Subtype')) ? (get('Subtype') as { v: string }).v : '';
  const type0 = subtype === 'Type0';
  const base = get('BaseFont');
  const font: Font = {
    name: isName(base) ? base.v : label,
    type0,
    toUnicode: null,
    table: null,
    widths: new Map(),
    defaultWidth: type0 ? 1000 : 500,
    codeBytes: type0 ? 2 : 1,
  };
  const tu = dict.map.get('ToUnicode');
  const tuRec = isRef(tu) ? doc.getRecord(tu.num, view) : null;
  if (tuRec) {
    font.toUnicode = parseCMap(doc.decode(tuRec, 4 * 1024 * 1024).data);
    if (type0 && font.toUnicode.codeBytes === 1) font.codeBytes = 1;
  }
  if (type0) {
    const desc = doc.resolve(dict.map.get('DescendantFonts'), view);
    const first = isArray(desc) ? doc.dictOf(desc.items[0], view) : null;
    if (first) {
      const dw = doc.resolve(first.map.get('DW'), view);
      if (isNum(dw)) font.defaultWidth = dw;
      readCidWidths(doc, view, doc.resolve(first.map.get('W'), view), font.widths);
    }
    return font;
  }
  // Simple font: the encoding table, then the widths
  const encoding = get('Encoding');
  let table: string[] | null = null;
  const baseName = isName(encoding) ? encoding.v : null;
  if (baseName && BASE_ENCODINGS[baseName]) table = BASE_ENCODINGS[baseName]!();
  if (isDict(encoding)) {
    const be = doc.resolve(encoding.map.get('BaseEncoding'), view);
    table = BASE_ENCODINGS[isName(be) ? be.v : 'StandardEncoding']!();
    const diffs = doc.resolve(encoding.map.get('Differences'), view);
    if (isArray(diffs)) {
      let code = 0;
      for (const item of diffs.items) {
        const r = doc.resolve(item, view);
        if (isNum(r)) code = r;
        else if (isName(r)) {
          if (code >= 0 && code < 256) table[code] = glyphToText(r.v) || '\u0000';
          code++;
        }
      }
    }
  }
  font.table = table ?? winAnsi();
  const first = get('FirstChar');
  const widths = get('Widths');
  if (isNum(first) && isArray(widths)) {
    widths.items.forEach((w, i) => {
      const n = doc.resolve(w, view);
      if (isNum(n)) font.widths.set(first + i, n);
    });
  }
  const desc = doc.dictOf(dict.map.get('FontDescriptor'), view);
  const missing = desc ? doc.resolve(desc.map.get('MissingWidth'), view) : undefined;
  if (isNum(missing) && missing > 0) font.defaultWidth = missing;
  else if (font.widths.size > 0) font.defaultWidth = 0;
  return font;
}

function readCidWidths(
  doc: PdfDoc,
  view: XrefMap,
  w: PdfValue | undefined,
  out: Map<number, number>,
): void {
  if (!isArray(w)) return;
  const items = w.items.map((x) => doc.resolve(x, view));
  for (let i = 0; i < items.length;) {
    const first = items[i];
    const second = items[i + 1];
    if (!isNum(first)) {
      i++;
      continue;
    }
    if (isArray(second)) {
      second.items.forEach((x, j) => {
        const n = doc.resolve(x, view);
        if (isNum(n) && out.size < 100_000) out.set(first + j, n);
      });
      i += 2;
    } else if (isNum(second) && isNum(items[i + 2])) {
      const width = items[i + 2] as number;
      for (let c = first; c <= second && c - first < 0x10000 && out.size < 100_000; c++) {
        out.set(c, width);
      }
      i += 3;
    } else i++;
  }
}

/** Used when a content stream shows text with a font its resources do not define. */
const FALLBACK_FONT: Font = {
  name: '(no font)',
  type0: false,
  toUnicode: null,
  table: winAnsi(),
  widths: new Map(),
  defaultWidth: 500,
  codeBytes: 1,
};

/** The text of a string shown with a font, whether it could be mapped, and its advance in 1/1000 em. */
function decodeShown(
  font: Font,
  bytes: Uint8Array,
): { text: string; raw: boolean; width: number; spaces: number } {
  let text = '';
  let raw = false;
  let width = 0;
  let spaces = 0;
  const step = font.codeBytes;
  for (let i = 0; i < bytes.length; i += step) {
    let code = bytes[i]!;
    if (step === 2) code = (code << 8) | (bytes[i + 1] ?? 0);
    width += font.widths.get(code) ?? font.defaultWidth;
    let piece: string | null = font.toUnicode ? cmapLookup(font.toUnicode, code) : null;
    if (piece === null && font.table) piece = font.table[code] ?? null;
    if (piece === null || piece === '\u0000') {
      raw = true;
      piece = font.type0 ? `<${code.toString(16).padStart(4, '0')}>` : String.fromCharCode(code);
    }
    if (code === 32 && step === 1) spaces++;
    text += piece;
  }
  return { text, raw, width, spaces };
}

// ---------- colours, optional content ----------

interface Fill {
  /** 'gray' | 'rgb' | 'cmyk' | 'other' */
  space: 'gray' | 'rgb' | 'cmyk' | 'other';
  comps: number[];
}

const isWhite = (f: Fill): boolean =>
  (f.space === 'gray' && f.comps.length === 1 && f.comps[0]! >= 0.98) ||
  (f.space === 'rgb' && f.comps.length === 3 && f.comps.every((c) => c >= 0.98)) ||
  (f.space === 'cmyk' && f.comps.length === 4 && f.comps.every((c) => c <= 0.02));

function offLayers(doc: PdfDoc, view: XrefMap): Set<number> {
  const off = new Set<number>();
  const root = doc.dictOf(doc.trailer.map.get('Root'), view);
  const props = doc.dictOf(root?.map.get('OCProperties'), view);
  const d = doc.dictOf(props?.map.get('D'), view);
  if (!props || !d) return off;
  const base = doc.resolve(d.map.get('BaseState'), view);
  if (isName(base, 'OFF')) {
    const all = doc.resolve(props.map.get('OCGs'), view);
    if (isArray(all)) for (const g of all.items) if (isRef(g)) off.add(g.num);
    const on = doc.resolve(d.map.get('ON'), view);
    if (isArray(on)) for (const g of on.items) if (isRef(g)) off.delete(g.num);
  }
  const list = doc.resolve(d.map.get('OFF'), view);
  if (isArray(list)) for (const g of list.items) if (isRef(g)) off.add(g.num);
  return off;
}

/** Is the content tied to this optional content group or membership dictionary hidden? */
function layerHidden(
  doc: PdfDoc,
  view: XrefMap,
  off: Set<number>,
  ref: PdfValue | undefined,
): boolean {
  if (off.size === 0 || ref === undefined) return false;
  if (isRef(ref) && off.has(ref.num)) return true;
  const d = doc.dictOf(ref, view);
  if (!d || !isName(d.map.get('Type'), 'OCMD')) return false;
  const groups = d.map.get('OCGs');
  const list = isArray(doc.resolve(groups, view))
    ? (doc.resolve(groups, view) as { items: PdfValue[] }).items
    : groups === undefined
      ? []
      : [groups];
  const states = list.filter(isRef).map((g) => !off.has(g.num)); // true = on
  if (states.length === 0) return false;
  const policy = doc.resolve(d.map.get('P'), view);
  const p = isName(policy) ? policy.v : 'AnyOn';
  switch (p) {
    case 'AllOn':
      return !states.every(Boolean);
    case 'AnyOff':
      return !states.some((s) => !s);
    case 'AllOff':
      return !states.every((s) => !s);
    default:
      return !states.some(Boolean);
  }
}

// ---------- the interpreter ----------

interface GState {
  ctm: Mat;
  fill: Fill;
  alpha: number;
  font: Font | null;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  mode: number;
}

interface Painted {
  box: Box;
  /** Number of runs emitted before it was painted. */
  after: number;
}

interface Ctx {
  doc: PdfDoc;
  view: XrefMap;
  page: PageInfo;
  off: Set<number>;
  fonts: Map<PdfDict, Font>;
  runs: TextRun[];
  painted: Painted[];
  /** Areas painted with something that is not white (fills, images, shadings) so far. */
  colored: Box[];
  /** An image covering much of the page was painted (a scan). */
  bigImage: boolean;
  operators: number;
  notes: Set<'truncated' | 'budget' | 'noContent'>;
}

function newState(): GState {
  return {
    ctm: IDENTITY,
    fill: { space: 'gray', comps: [0] },
    alpha: 1,
    font: null,
    size: 0,
    tc: 0,
    tw: 0,
    th: 1,
    tl: 0,
    rise: 0,
    mode: 0,
  };
}

function interpret(
  ctx: Ctx,
  data: Uint8Array,
  resources: PdfDict | null,
  state0: GState,
  depth: number,
  seenForms: Set<number>,
): void {
  const { doc, view } = ctx;
  const lx = new Lexer(data, 0, data.length, false);
  let gs: GState = state0;
  const stack: GState[] = [];
  let tm: Mat = IDENTITY;
  let tlm: Mat = IDENTITY;
  const layers: boolean[] = [];
  let rects: Box[] = [];
  /** Bounding box of the current path, in page space. */
  let pathBox: Box | null = null;
  const extend = (x: number, y: number): void => {
    const [px, py] = apply(gs.ctm, x, y);
    pathBox = pathBox
      ? [
          Math.min(pathBox[0], px),
          Math.min(pathBox[1], py),
          Math.max(pathBox[2], px),
          Math.max(pathBox[3], py),
        ]
      : [px, py, px, py];
  };
  const paintImage = (): void => {
    const b = unitSquare();
    if (ctx.colored.length < 2000) ctx.colored.push(b);
    const [x0, y0, x1, y1] = ctx.page.cropBox;
    if ((b[2] - b[0]) * (b[3] - b[1]) >= 0.4 * (x1 - x0) * (y1 - y0)) ctx.bigImage = true;
  };
  const unitSquare = (): Box => {
    const c = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 0, 1), apply(gs.ctm, 1, 1)];
    const xs = c.map((q) => q[0]);
    const ys = c.map((q) => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  let operands: PdfValue[] = [];

  const res = (kind: string, name: string): PdfValue | undefined => {
    const group = doc.dictOf(resources?.map.get(kind), view);
    return group?.map.get(name);
  };
  const fontFor = (name: string): Font | null => {
    const dict = doc.dictOf(res('Font', name), view);
    if (!dict) return null;
    let f = ctx.fonts.get(dict);
    if (!f) {
      f = loadFont(doc, view, dict, name);
      ctx.fonts.set(dict, f);
    }
    return f;
  };
  const num = (i: number): number => {
    const v = operands[i];
    return isNum(v) ? v : 0;
  };
  const hiddenLayer = (): boolean => layers.some(Boolean);

  const setColor = (space: Fill['space'], comps: number[]) => {
    gs = { ...gs, fill: { space, comps } };
  };

  const show = (parts: (Uint8Array | number)[]): void => {
    const font = gs.font ?? FALLBACK_FONT;
    if (ctx.runs.length >= MAX_RUNS) return;
    let text = '';
    let raw = false;
    const trm0 = mul(tm, gs.ctm);
    const [x, y] = apply(trm0, 0, gs.rise);
    let advance = 0; // in text space units (before Tz)
    for (const part of parts) {
      if (typeof part === 'number') {
        const shift = (-part / 1000) * gs.size;
        advance += shift * gs.th;
        if (part < -200 && !text.endsWith(' ')) text += ' ';
        continue;
      }
      const d = decodeShown(font, part);
      text += d.text;
      raw ||= d.raw;
      const glyphs = font.codeBytes === 2 ? Math.floor(part.length / 2) : part.length;
      advance += ((d.width / 1000) * gs.size + gs.tc * glyphs + gs.tw * d.spaces) * gs.th;
    }
    const scale = Math.sqrt(Math.abs(trm0[0] * trm0[3] - trm0[1] * trm0[2]));
    const size = Math.abs(gs.size) * scale;
    const end = apply(mul([1, 0, 0, 1, advance, 0], mul(tm, gs.ctm)), 0, gs.rise);
    tm = mul([1, 0, 0, 1, advance, 0], tm);
    if (text === '') return;
    const hidden: HiddenReason[] = [];
    if (gs.mode === 3) hidden.push('render');
    else if (gs.mode === 7) hidden.push('clip');
    const fills = gs.mode === 0 || gs.mode === 2 || gs.mode === 4 || gs.mode === 6;
    if (fills && gs.alpha <= 0.02) hidden.push('transparent');
    if (fills && isWhite(gs.fill) && !onColored(ctx.colored, x, y, size)) hidden.push('white');
    if (size < 2) hidden.push('tiny');
    if (outside(ctx.page, x, y, end[0], size)) hidden.push('offpage');
    if (hiddenLayer()) hidden.push('layer');
    if (hidden.length === 1 && hidden[0] === 'render' && ctx.bigImage) hidden[0] = 'ocr';
    ctx.runs.push({ text, raw, x, y, x2: end[0], size, font: font.name, hidden });
  };

  const paint = (): void => {
    if (gs.alpha >= 0.05 && !isWhite(gs.fill) && pathBox && ctx.colored.length < 2000) {
      ctx.colored.push(pathBox);
    }
    pathBox = null;
    if (gs.alpha < 0.95) {
      rects = [];
      return;
    }
    for (const box of rects) ctx.painted.push({ box, after: ctx.runs.length });
    rects = [];
  };

  for (;;) {
    let v: PdfValue | undefined;
    try {
      v = lx.readValue();
    } catch (e) {
      if (e instanceof PdfSyntaxError) break;
      throw e;
    }
    if (v === undefined) break;
    if (!isKeyword(v)) {
      operands.push(v);
      if (operands.length > 512) operands.shift();
      continue;
    }
    if (++ctx.operators > MAX_OPERATORS) {
      ctx.notes.add('budget');
      break;
    }
    const op = v.v;
    switch (op) {
      case 'q':
        if (stack.length < 256) stack.push(gs);
        break;
      case 'Q':
        gs = stack.pop() ?? gs;
        break;
      case 'cm':
        if (operands.length >= 6) {
          const m = operands.slice(-6).map((x) => (isNum(x) ? x : 0)) as Mat;
          gs = { ...gs, ctm: mul(m, gs.ctm) };
        }
        break;
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'ET':
        break;
      case 'Tf': {
        const n = operands[operands.length - 2];
        gs = { ...gs, font: isName(n) ? fontFor(n.v) : gs.font, size: num(operands.length - 1) };
        break;
      }
      case 'Tc':
        gs = { ...gs, tc: num(operands.length - 1) };
        break;
      case 'Tw':
        gs = { ...gs, tw: num(operands.length - 1) };
        break;
      case 'Tz':
        gs = { ...gs, th: num(operands.length - 1) / 100 };
        break;
      case 'TL':
        gs = { ...gs, tl: num(operands.length - 1) };
        break;
      case 'Ts':
        gs = { ...gs, rise: num(operands.length - 1) };
        break;
      case 'Tr':
        gs = { ...gs, mode: Math.trunc(num(operands.length - 1)) };
        break;
      case 'Td':
      case 'TD': {
        const tx = num(operands.length - 2);
        const ty = num(operands.length - 1);
        if (op === 'TD') gs = { ...gs, tl: -ty };
        tlm = mul([1, 0, 0, 1, tx, ty], tlm);
        tm = tlm;
        break;
      }
      case 'Tm':
        if (operands.length >= 6) {
          const m = operands.slice(-6).map((x) => (isNum(x) ? x : 0)) as Mat;
          tm = m;
          tlm = m;
        }
        break;
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
        tm = tlm;
        break;
      case 'Tj': {
        const s = operands[operands.length - 1];
        if (isString(s)) show([s.b]);
        break;
      }
      case "'":
      case '"': {
        if (op === '"') {
          gs = { ...gs, tw: num(operands.length - 3), tc: num(operands.length - 2) };
        }
        tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
        tm = tlm;
        const s = operands[operands.length - 1];
        if (isString(s)) show([s.b]);
        break;
      }
      case 'TJ': {
        const arr = operands[operands.length - 1];
        if (isArray(arr)) {
          const parts: (Uint8Array | number)[] = [];
          for (const item of arr.items) {
            if (isString(item)) parts.push(item.b);
            else if (isNum(item)) parts.push(item);
          }
          show(parts);
        }
        break;
      }
      case 'g':
        setColor('gray', [num(operands.length - 1)]);
        break;
      case 'rg':
        setColor(
          'rgb',
          operands.slice(-3).map((x) => (isNum(x) ? x : 0)),
        );
        break;
      case 'k':
        setColor(
          'cmyk',
          operands.slice(-4).map((x) => (isNum(x) ? x : 0)),
        );
        break;
      case 'cs': {
        const n = operands[operands.length - 1];
        const space = isName(n) ? colorSpaceOf(doc, view, resources, n.v) : 'other';
        gs = {
          ...gs,
          fill: {
            space,
            comps: space === 'cmyk' ? [0, 0, 0, 1] : space === 'rgb' ? [0, 0, 0] : [0],
          },
        };
        break;
      }
      case 'sc':
      case 'scn': {
        const comps = operands.filter(isNum);
        const space = gs.fill.space;
        if (space !== 'other' && comps.length > 0) gs = { ...gs, fill: { space, comps } };
        else if (space === 'other' || comps.length === 0) {
          gs = { ...gs, fill: { space: 'other', comps } };
        }
        break;
      }
      case 'gs': {
        const n = operands[operands.length - 1];
        if (isName(n)) {
          const ext = doc.dictOf(res('ExtGState', n.v), view);
          const ca = ext ? doc.resolve(ext.map.get('ca'), view) : undefined;
          if (isNum(ca)) gs = { ...gs, alpha: ca };
        }
        break;
      }
      case 're': {
        if (operands.length >= 4) {
          const [x, y, w, h] = [
            num(operands.length - 4),
            num(operands.length - 3),
            num(operands.length - 2),
            num(operands.length - 1),
          ];
          const corners = [
            apply(gs.ctm, x, y),
            apply(gs.ctm, x + w, y),
            apply(gs.ctm, x, y + h),
            apply(gs.ctm, x + w, y + h),
          ];
          const xs = corners.map((c) => c[0]);
          const ys = corners.map((c) => c[1]);
          rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
          if (rects.length > 64) rects.shift();
          extend(x, y);
          extend(x + w, y + h);
        }
        break;
      }
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        paint();
        break;
      case 'm':
      case 'l':
        if (operands.length >= 2) extend(num(operands.length - 2), num(operands.length - 1));
        break;
      case 'c':
      case 'v':
      case 'y': {
        const pts = op === 'c' ? 3 : 2;
        for (let i = pts; i >= 1 && operands.length >= i * 2; i--) {
          extend(num(operands.length - i * 2), num(operands.length - i * 2 + 1));
        }
        break;
      }
      case 'sh':
        ctx.colored.push(ctx.page.cropBox);
        break;
      case 'n':
      case 'S':
      case 's':
        rects = [];
        pathBox = null;
        break;
      case 'BDC':
      case 'BMC': {
        let hide = false;
        if (op === 'BDC' && isName(operands[operands.length - 2], 'OC')) {
          const prop = operands[operands.length - 1];
          const target = isName(prop) ? res('Properties', prop.v) : prop;
          hide = layerHidden(doc, view, ctx.off, target);
        }
        layers.push(hide);
        break;
      }
      case 'EMC':
        layers.pop();
        break;
      case 'Do': {
        const n = operands[operands.length - 1];
        if (isName(n) && depth < MAX_FORM_DEPTH) {
          const ref = res('XObject', n.v);
          if (isRef(ref) && !seenForms.has(ref.num)) {
            const rec = doc.getRecord(ref.num, view);
            const dict = rec && isDict(rec.value) ? rec.value : null;
            if (rec && dict && isName(doc.resolve(dict.map.get('Subtype'), view), 'Image')) {
              paintImage();
            } else if (rec && dict && isName(doc.resolve(dict.map.get('Subtype'), view), 'Form')) {
              const oc = dict.map.get('OC');
              const formHidden = hiddenLayer() || layerHidden(doc, view, ctx.off, oc);
              const content = doc.decode(rec, MAX_CONTENT).data;
              const matrix = matrixOf(doc.resolve(dict.map.get('Matrix'), view)) ?? IDENTITY;
              const inner = doc.dictOf(dict.map.get('Resources'), view) ?? resources;
              const next = new Set(seenForms).add(ref.num);
              const base: GState = { ...gs, ctm: mul(matrix, gs.ctm) };
              const before = ctx.runs.length;
              interpret(ctx, content, inner, base, depth + 1, next);
              if (formHidden) {
                for (let i = before; i < ctx.runs.length; i++) ctx.runs[i]!.hidden.push('layer');
              }
            }
          }
        }
        break;
      }
      case 'BI':
        // Inline image: skip its data up to the EI that ends it
        paintImage();
        skipInlineImage(lx);
        break;
      default:
        break;
    }
    operands = [];
  }
}

function colorSpaceOf(
  doc: PdfDoc,
  view: XrefMap,
  resources: PdfDict | null,
  name: string,
): Fill['space'] {
  if (name === 'DeviceGray' || name === 'G' || name === 'CalGray') return 'gray';
  if (name === 'DeviceRGB' || name === 'RGB' || name === 'CalRGB') return 'rgb';
  if (name === 'DeviceCMYK' || name === 'CMYK') return 'cmyk';
  const group = doc.dictOf(resources?.map.get('ColorSpace'), view);
  const entry = doc.resolve(group?.map.get(name), view);
  if (isName(entry)) return colorSpaceOf(doc, view, null, entry.v);
  if (isArray(entry)) {
    const kind = doc.resolve(entry.items[0], view);
    if (isName(kind, 'CalGray')) return 'gray';
    if (isName(kind, 'CalRGB')) return 'rgb';
    if (isName(kind, 'ICCBased')) {
      const stream = doc.dictOf(entry.items[1], view);
      const n = stream ? doc.resolve(stream.map.get('N'), view) : undefined;
      return n === 1 ? 'gray' : n === 3 ? 'rgb' : n === 4 ? 'cmyk' : 'other';
    }
  }
  return 'other';
}

function skipInlineImage(lx: Lexer): void {
  const { buf } = lx;
  // key/value pairs up to ID, then binary data up to "EI" between white space
  for (;;) {
    const v = lx.readValue();
    if (v === undefined) return;
    if (isKeyword(v, 'ID')) break;
  }
  let p = lx.pos + 1;
  while (p + 2 < lx.end) {
    if (
      buf[p] === 0x45 &&
      buf[p + 1] === 0x49 &&
      (p === 0 || buf[p - 1] === 0x20 || buf[p - 1] === 0x0a || buf[p - 1] === 0x0d) &&
      (p + 2 >= lx.end || buf[p + 2] === 0x20 || buf[p + 2] === 0x0a || buf[p + 2] === 0x0d)
    ) {
      lx.pos = p + 2;
      return;
    }
    p++;
  }
  lx.pos = lx.end;
}

/** Was something not white painted where this text starts? Then white text may be on it. */
function onColored(colored: Box[], x: number, y: number, size: number): boolean {
  return colored.some((b) => x >= b[0] - 1 && x <= b[2] + 1 && y >= b[1] - 2 && y <= b[3] + size);
}

function outside(page: PageInfo, x: number, y: number, x2: number, size: number): boolean {
  const [x0, y0, x1, y1] = page.cropBox;
  const tol = 1;
  return x > x1 + tol || Math.max(x, x2) < x0 - tol || y > y1 + size || y < y0 - size;
}

// ---------- the text of a page ----------

/** Run a page's content streams and collect its text runs, with the reasons any is hidden. */
export function extractPageText(
  doc: PdfDoc,
  view: XrefMap,
  page: PageInfo,
  cache?: { fonts: Map<PdfDict, Font>; off: Set<number> },
): PageText {
  const ctx: Ctx = {
    doc,
    view,
    page,
    off: cache?.off ?? offLayers(doc, view),
    fonts: cache?.fonts ?? new Map(),
    runs: [],
    painted: [],
    colored: [],
    bigImage: false,
    operators: 0,
    notes: new Set(),
  };
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const num of page.contents) {
    const rec: ObjRecord | null = doc.getRecord(num, view);
    if (!rec || !rec.stream) continue;
    const room = MAX_CONTENT - total;
    if (room <= 0) {
      ctx.notes.add('truncated');
      break;
    }
    const out = doc.decode(rec, room);
    if (out.truncated) ctx.notes.add('truncated');
    parts.push(out.data, Uint8Array.of(0x0a));
    total += out.data.length + 1;
  }
  if (parts.length === 0) ctx.notes.add('noContent');
  const content = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    content.set(p, o);
    o += p.length;
  }
  interpret(ctx, content, page.resources, newState(), 0, new Set());
  // Shapes painted after a run cover it when they contain its whole baseline.
  for (let i = 0; i < ctx.runs.length; i++) {
    const run = ctx.runs[i]!;
    if (run.hidden.length > 0) continue;
    for (const p of ctx.painted) {
      if (p.after <= i) continue;
      const [bx0, by0, bx1, by1] = p.box;
      const lo = Math.min(run.x, run.x2);
      const hi = Math.max(run.x, run.x2);
      const tall = by1 - by0 >= 0.5 * run.size;
      if (tall && lo >= bx0 - 0.5 && hi <= bx1 + 0.5 && run.y >= by0 - 0.5 && run.y <= by1 + 0.5) {
        run.hidden.push('covered');
        break;
      }
    }
  }
  return { page, runs: ctx.runs, notes: [...ctx.notes] };
}

export function pageTextCache(doc: PdfDoc, view: XrefMap) {
  return { fonts: new Map<PdfDict, Font>(), off: offLayers(doc, view) };
}

/** Lay the visible runs of a page out as lines of text. */
export function layoutText(runs: TextRun[]): string {
  let out = '';
  let prev: TextRun | null = null;
  for (const run of runs) {
    if (prev) {
      const sameLine = Math.abs(run.y - prev.y) <= 0.4 * Math.max(run.size, prev.size, 1);
      if (!sameLine) out += '\n';
      else if (run.x - prev.x2 > 0.2 * Math.max(run.size, 1) && !out.endsWith(' ')) out += ' ';
    }
    out += run.text;
    prev = run;
  }
  return out;
}

/** Plain text of a string shown in an arbitrary content stream (no fonts): for orphan streams. */
export function rawContentText(data: Uint8Array): string {
  const lx = new Lexer(data.subarray(0, Math.min(data.length, MAX_CONTENT)), 0, undefined, false);
  let out = '';
  let operands: PdfValue[] = [];
  try {
    for (let n = 0; n < MAX_OPERATORS; n++) {
      const v = lx.readValue();
      if (v === undefined) break;
      if (!isKeyword(v)) {
        operands.push(v);
        if (operands.length > 512) operands.shift();
        continue;
      }
      if (v.v === 'Tj' || v.v === "'" || v.v === '"') {
        const s = operands[operands.length - 1];
        if (isString(s)) out += latin1Decode(s.b);
      } else if (v.v === 'TJ') {
        const a = operands[operands.length - 1];
        if (isArray(a)) {
          for (const item of a.items) {
            if (isString(item)) out += latin1Decode(item.b);
            else if (isNum(item) && item < -200) out += ' ';
          }
        }
      } else if (v.v === 'ET' || v.v === 'T*' || v.v === 'Td' || v.v === 'TD' || v.v === 'Tm') {
        if (!out.endsWith('\n')) out += '\n';
      }
      operands = [];
    }
  } catch (e) {
    if (!(e instanceof PdfSyntaxError)) throw e;
  }
  return out.trim();
}

/** Does this look like a page content stream? */
export function looksLikeContent(data: Uint8Array): boolean {
  const head = latin1Decode(data.subarray(0, Math.min(data.length, 4096)));
  return /\bBT\b/.test(head) && /\bET\b/.test(head) && /(Tj|TJ)/.test(head);
}
