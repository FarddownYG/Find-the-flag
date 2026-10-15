/**
 * What the barcode tools show for a scan (pure): a summary table when there are several codes,
 * the picture with numbered boxes, then for every code its facts, its text and its raw bytes.
 */
import type { Output, RgbaImage } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { toHex } from '../../lib/bytes';
import { drawBoxes } from './_barcode-draw';
import { hitSize, isLinear, type BarcodeHit, type BarcodeScan, type Effort } from './_barcode-scan';

const T = toolT('barcode');

/** How many codes get their own block of facts; the table lists more. */
const MAX_DETAILED = 12;
const MAX_LISTED = 60;
const RAW_HEX_BYTES = 32;

/** zxing-cpp's names for the formats (proper names, shown the same in every language). */
const FORMAT_NAMES: Record<string, string> = {
  Codabar: 'Codabar',
  Code39: 'Code 39',
  Code39Std: 'Code 39',
  Code39Ext: 'Code 39 Extended',
  Code32: 'Code 32',
  PZN: 'PZN',
  Code93: 'Code 93',
  Code128: 'Code 128',
  ITF: 'ITF',
  ITF14: 'ITF-14',
  DataBar: 'DataBar',
  DataBarOmni: 'DataBar Omnidirectional',
  DataBarStk: 'DataBar Stacked',
  DataBarStkOmni: 'DataBar Stacked Omnidirectional',
  DataBarLtd: 'DataBar Limited',
  DataBarExp: 'DataBar Expanded',
  DataBarExpStk: 'DataBar Expanded Stacked',
  EANUPC: 'EAN/UPC',
  EAN13: 'EAN-13',
  EAN8: 'EAN-8',
  EAN5: 'EAN-5',
  EAN2: 'EAN-2',
  ISBN: 'ISBN',
  UPCA: 'UPC-A',
  UPCE: 'UPC-E',
  Telepen: 'Telepen',
  TelepenAlpha: 'Telepen Alpha',
  TelepenNumeric: 'Telepen Numeric',
  DXFilmEdge: 'DX Film Edge',
  PDF417: 'PDF417',
  CompactPDF417: 'Compact PDF417',
  MicroPDF417: 'MicroPDF417',
  Aztec: 'Aztec',
  AztecCode: 'Aztec',
  AztecRune: 'Aztec Rune',
  QRCode: 'QR Code',
  QRCodeModel1: 'QR Code Model 1',
  QRCodeModel2: 'QR Code',
  MicroQRCode: 'Micro QR Code',
  RMQRCode: 'rMQR Code',
  DataMatrix: 'Data Matrix',
  MaxiCode: 'MaxiCode',
};

export const formatName = (format: string): string => FORMAT_NAMES[format] ?? format;

/** Control characters other than tab, newline and carriage return. */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f) return true;
  }
  return false;
}

function hasControlBytes(bytes: Uint8Array): boolean {
  return bytes.some((b) => (b < 0x20 && b !== 9 && b !== 10 && b !== 13) || b === 0x7f);
}

/** The text the reader gave reads as text (no control characters, no replacement characters). */
function isReadable(hit: BarcodeHit): boolean {
  return hit.text.length > 0 && !hasControlChars(hit.text) && !hit.text.includes('�');
}

function centreOf(hit: BarcodeHit): { x: number; y: number } {
  return {
    x: Math.round(hit.corners.reduce((s, c) => s + c.x, 0) / 4),
    y: Math.round(hit.corners.reduce((s, c) => s + c.y, 0) / 4),
  };
}

function positionText(hit: BarcodeHit): string {
  const [tl, tr, , bl] = hit.corners;
  const c = centreOf(hit);
  return T('value.position', {
    x: c.x,
    y: c.y,
    w: Math.round(Math.hypot(tr.x - tl.x, tr.y - tl.y)),
    h: Math.round(Math.hypot(bl.x - tl.x, bl.y - tl.y)),
  });
}

/** zxing-cpp's error names in words. */
function errorText(error: string): string {
  if (error === 'ChecksumError') return T('value.errorChecksum');
  if (error === 'FormatError') return T('value.errorFormat');
  return error || '?';
}

function contentText(hit: BarcodeHit): string {
  const kinds: Record<string, string> = {
    Text: T('value.content.text'),
    Binary: T('value.content.binary'),
    Mixed: T('value.content.mixed'),
    GS1: T('value.content.gs1'),
    ISO15434: T('value.content.iso15434'),
    UnknownECI: T('value.content.unknownEci'),
  };
  return T('value.contentBytes', {
    kind: kinds[hit.contentType] ?? hit.contentType,
    count: hit.bytes.length,
  });
}

function orientationText(hit: BarcodeHit): string {
  const parts: string[] = [];
  if (hit.rotation) {
    parts.push(T(hit.rotationApprox ? 'value.turnedAbout' : 'value.turned', { deg: hit.rotation }));
  }
  if (hit.isMirrored) parts.push(T('value.mirrored'));
  if (hit.isInverted) parts.push(T('value.lightOnDark'));
  return parts.length ? parts.join(', ') : T('value.upright');
}

const KNOWN_EXTRA = new Set([
  'DataMask',
  'ECLevel',
  'EanAddOn',
  'UPCE',
  'UEC',
  'Version',
  'ReaderInit',
]);

function qrModules(version: string): number | null {
  return /^\d+$/.test(version) ? 17 + 4 * Number(version) : null;
}

function detailEntries(hit: BarcodeHit, synthetic: boolean): [string, string][] {
  const e: [string, string][] = [];
  const dims = isLinear(hit.format) ? T('value.linear') : T('value.matrix');
  e.push([T('kv.format'), `${formatName(hit.format)} (${dims})`]);
  if (!hit.isValid) e.push([T('kv.status'), T('value.invalid', { error: errorText(hit.error) })]);
  e.push([T('kv.content'), contentText(hit)]);
  e.push([T('kv.raw'), rawHex(hit.bytes)]);
  if (hit.ecLevel) e.push([T('kv.errorCorrection'), hit.ecLevel]);
  const spare = hit.extra.UEC;
  if (typeof spare === 'number' && !isLinear(hit.format)) {
    e.push([T('kv.spare'), `${Math.round(spare * 100)}%`]);
  }
  const version = hit.extra.Version;
  if (typeof version === 'string' && version) {
    const modules = hit.symbology === 'QRCode' ? qrModules(version) : null;
    e.push([T('kv.version'), modules ? T('value.versionModules', { version, modules }) : version]);
  }
  if (typeof hit.extra.DataMask === 'number') {
    e.push([T('kv.dataMask'), String(hit.extra.DataMask)]);
  }
  if (hit.format === 'EAN13' && hit.text.startsWith('0') && hit.text.length === 13) {
    e.push([T('kv.upca'), hit.text.slice(1)]);
  }
  if (typeof hit.extra.UPCE === 'string') e.push([T('kv.upce'), hit.extra.UPCE]);
  if (typeof hit.extra.EanAddOn === 'string' && hit.extra.EanAddOn) {
    e.push([T('kv.addOn'), hit.extra.EanAddOn]);
  }
  if ((hit.format === 'EAN13' || hit.format === 'EAN8') && hit.isValid) {
    e.push([T('kv.checkDigit'), T('value.checkDigit', { digit: hit.text.slice(-1) })]);
  }
  if (hit.symbologyIdentifier) e.push([T('kv.symbologyId'), hit.symbologyIdentifier]);
  if (hit.hasECI) e.push([T('kv.eci'), T('value.eci')]);
  if (hit.sequenceSize >= 0) {
    const part =
      hit.sequenceSize > 0
        ? T('value.sequence', { index: hit.sequenceIndex + 1, size: hit.sequenceSize })
        : T('value.sequenceOpen', { index: hit.sequenceIndex + 1 });
    e.push([T('kv.sequence'), hit.sequenceId ? `${part}, id ${hit.sequenceId}` : part]);
  }
  if (!synthetic && isLinear(hit.format) && hit.lineCount > 0) {
    e.push([T('kv.lines'), T('value.lines', { count: hit.lineCount })]);
  }
  const other = Object.entries(hit.extra)
    .filter(([k, v]) => !KNOWN_EXTRA.has(k) && (typeof v === 'string' || typeof v === 'number'))
    .map(([k, v]) => `${k} = ${String(v)}`);
  if (other.length) e.push([T('kv.other'), other.join('; ')]);
  // For a code drawn from text there is no picture to point at: say only what is not plain.
  if (!synthetic || hit.rotation || hit.isMirrored || hit.isInverted) {
    e.push([T('kv.orientation'), orientationText(hit)]);
  }
  if (!synthetic || hit.how !== T('how.asIs')) e.push([T('kv.readAfter'), hit.how]);
  if (!synthetic) e.push([T('kv.position'), positionText(hit)]);
  return e;
}

function rawHex(bytes: Uint8Array): string {
  if (!bytes.length) return '-';
  const shown = toHex(bytes.subarray(0, RAW_HEX_BYTES), ' ');
  return bytes.length > RAW_HEX_BYTES ? `${shown} …` : shown;
}

function cell(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

function detailBlocks(
  hit: BarcodeHit,
  tag: string,
  index: number,
  many: boolean,
  synthetic: boolean,
): Output[] {
  const out: Output[] = [];
  out.push({ type: 'kv', label: T('label.code', { tag }), entries: detailEntries(hit, synthetic) });
  if (!hit.isValid) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.invalid', { error: errorText(hit.error) }),
    });
  }
  if (hit.sequenceSize >= 0 && hit.sequenceSize !== 1) {
    out.push({ type: 'note', level: 'info', text: T('note.sequence') });
  }
  // Text only if the reader's text reads as text and the bytes are not binary data in disguise
  // (for a payload typed as binary, the text view would be a string of <NUL><SOH>... escapes).
  const rawKind = ['Binary', 'Mixed', 'UnknownECI'].includes(hit.contentType);
  const textual = isReadable(hit) && !(rawKind && hasControlBytes(hit.bytes));
  if (textual) out.push({ type: 'text', label: T('label.decoded', { tag }), value: hit.text });
  if ((rawKind || !textual) && hit.bytes.length) {
    if (!textual) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.binary', { hex: toHex(hit.bytes.subarray(0, 16), ' ') }),
      });
    }
    out.push({
      type: 'bytes',
      label: T('label.raw', { tag }),
      value: hit.bytes,
      filename: `barcode-data${many ? `-${index + 1}` : ''}.bin`,
    });
    if (!textual && hit.text) {
      out.push({ type: 'text', label: T('label.textView', { tag }), value: hit.text });
    }
  }
  return out;
}

export interface ReportOptions {
  effort: Effort;
  /** Draw boxes on the picture. */
  boxes: boolean;
  /** The invalid codes were asked for: list them like the others. */
  showInvalid: boolean;
  /** The picture was drawn from text (no real picture to point at: no position, no box). */
  synthetic: boolean;
  /** QR codes are in play: point to the other QR decoder when nothing was found. */
  mentionQr: boolean;
}

/** The blocks to show for a scan of `image` (the original pixels, for the boxes). */
export function reportScan(scan: BarcodeScan, image: RgbaImage, opts: ReportOptions): Output[] {
  const out: Output[] = [];
  const shown = opts.showInvalid ? [...scan.hits, ...scan.invalid] : scan.hits;
  if (!shown.length) {
    if (scan.invalid.length) {
      const list = scan.invalid
        .slice(0, 5)
        .map((h) => `${formatName(h.format)} ${h.text}: ${errorText(h.error)}`)
        .join('; ');
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.invalidSeen', { count: scan.invalid.length, list }),
      });
    }
    out.push({
      type: 'note',
      level: 'warn',
      text: opts.effort === 'quick' ? T('note.noneQuick') : T('note.none', { count: scan.tried }),
    });
    if (scan.limited) out.push({ type: 'note', level: 'info', text: T('note.limited') });
    if (opts.mentionQr) out.push({ type: 'note', level: 'info', text: T('note.tryQr') });
    return out;
  }

  const many = shown.length > 1;
  if (many) {
    out.push({ type: 'note', level: 'info', text: T('note.count', { count: shown.length }) });
    out.push({
      type: 'table',
      label: T('label.summary'),
      columns: [
        T('col.number'),
        T('col.format'),
        T('col.data'),
        ...(opts.synthetic ? [] : [T('col.position')]),
      ],
      rows: shown.slice(0, MAX_LISTED).map((h, i) => {
        const c = centreOf(h);
        return [
          i + 1,
          formatName(h.format),
          isReadable(h) ? cell(h.text) : `0x ${rawHex(h.bytes.subarray(0, 12))}`,
          ...(opts.synthetic ? [] : [`(${c.x}, ${c.y}), ${Math.round(hitSize(h))} px`]),
        ];
      }),
    });
    if (shown.length > MAX_LISTED) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.tooMany', { shown: MAX_LISTED, count: shown.length }),
      });
    }
  }

  const picture = (): Output | null => {
    if (!opts.boxes) return null;
    const { image: drawn } = drawBoxes(
      image,
      shown.map((h) => ({ corners: h.corners })),
    );
    return {
      type: 'image',
      label: T('label.picture'),
      image: drawn,
      filename: 'barcode-boxes.png',
    };
  };
  const pic = picture();
  if (many && pic) out.push(pic);

  shown.slice(0, MAX_DETAILED).forEach((hit, i) => {
    out.push(...detailBlocks(hit, many ? ` ${i + 1}` : '', i, many, opts.synthetic));
  });
  if (shown.length > MAX_DETAILED) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.detailLimit', { shown: MAX_DETAILED, count: shown.length }),
    });
  }
  if (!many && pic) out.push(pic);
  if (scan.limited) out.push({ type: 'note', level: 'info', text: T('note.limited') });
  return out;
}
