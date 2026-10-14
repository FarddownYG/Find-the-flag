import { defineTool } from '../../core/define';
import { decodeImageExact } from '../../core/decode-image';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { signatureName, toolT } from '../../i18n/tool-text';
import { formatSize, latin1Decode, printableRatio, toHex, u16be, u32be } from '../../lib/bytes';
import { identify, type Signature } from '../../lib/signatures';
import { parseGif } from './_gif';
import {
  appIdentifier,
  commentText,
  isSof,
  type JpegParse,
  parseJpeg,
  sofDescription,
} from './_jpeg';
import {
  bruteForceIhdr,
  chunkKind,
  colorTypeName,
  decodeTextChunk,
  expectedRawSize,
  type Ihdr,
  type IhdrRepair,
  idatData,
  inflatedSize,
  parsePng,
  type PngChunk,
  pngTexts,
  readIhdr,
  rowSize,
  withIhdr,
} from './_png';

const T = toolT('image-structure');

type FileEntry = { name: string; data: Uint8Array; note?: string };

const hex8 = (n: number) => n.toString(16).padStart(8, '0');
const fileSize = (b: Uint8Array) =>
  T('value.fileSize', { size: formatSize(b.length), count: b.length });
const at = (n: number) => `${n} (0x${n.toString(16)})`;
/** Chunks that carry readable data: worth a look even though they are standard. */
const TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf']);
const MAX_ROWS = 400;
const MAX_UNKNOWN_FILES = 8;

function baseName(name: string | undefined, fallback: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[^.]*$/, '');
  return stem || fallback;
}

function previewOf(b: Uint8Array, max = 48): string {
  if (!b.length) return T('value.empty');
  if (printableRatio(b.subarray(0, 256)) > 0.9) {
    const s = latin1Decode(b.subarray(0, max)).replace(/[^\x20-\x7e]/g, '·');
    return `"${s}"${b.length > max ? '…' : ''}`;
  }
  return `${toHex(b.subarray(0, 16), ' ')}${b.length > 16 ? ' …' : ''}`;
}

type TailKind =
  | { kind: 'file'; sig: Signature; ext: string }
  | { kind: 'zeros' | 'text' | 'unknown'; ext: string };

function classifyTail(tail: Uint8Array): TailKind {
  const sig = identify(tail).find((s) => !s.weak);
  if (sig) return { kind: 'file', sig, ext: sig.ext };
  if (tail.every((x) => x === 0)) return { kind: 'zeros', ext: 'bin' };
  if (printableRatio(tail.subarray(0, 512)) > 0.9) return { kind: 'text', ext: 'txt' };
  return { kind: 'unknown', ext: 'bin' };
}

/**
 * Name the kind of data glued onto the end of an image, and the file extension to give it.
 * The label is English (other tools compare it and translate it themselves).
 */
export function describeTail(tail: Uint8Array): { label: string; ext: string } {
  const t = classifyTail(tail);
  if (t.kind === 'file') return { label: t.sig.name, ext: t.ext };
  if (t.kind === 'zeros') return { label: 'zero padding', ext: t.ext };
  if (t.kind === 'text') return { label: 'plain text', ext: t.ext };
  return { label: 'unidentified data', ext: t.ext };
}

/** describeTail's label in the user's language. */
function tailText(t: TailKind): string {
  if (t.kind === 'file') return signatureName(t.sig);
  if (t.kind === 'zeros') return T('tail.zeros');
  if (t.kind === 'text') return T('tail.text');
  return T('tail.unknown');
}

function trailingOutputs(
  tail: Uint8Array,
  offset: number,
  after: string,
  stem: string,
  files: FileEntry[],
): Output[] {
  const t = classifyTail(tail);
  const label = tailText(t);
  files.push({
    name: `${stem}-after-${after}.${t.ext}`,
    data: tail,
    note: T('file.tail', { label, offset }),
  });
  const padding = t.kind === 'zeros' || tail.every((x) => x === 0x0a || x === 0x0d);
  const params = { size: formatSize(tail.length), count: tail.length, offset, label };
  return [
    {
      type: 'note',
      level: padding ? 'info' : 'warn',
      text: padding ? T('note.tailPadding', params) : T('note.tailHidden', params),
    },
  ];
}

// ---------------------------------------------------------------- PNG

function pngDetails(bytes: Uint8Array, c: PngChunk, ihdr: Ihdr | null): string {
  const d = bytes.subarray(c.dataStart, c.dataStart + c.length);
  switch (c.type) {
    case 'IHDR': {
      if (!ihdr) return '';
      const p = {
        w: ihdr.width,
        h: ihdr.height,
        depth: ihdr.bitDepth,
        colour: colorTypeName(ihdr.colorType) ?? T('detail.colourType', { type: ihdr.colorType }),
      };
      return ihdr.interlace ? T('detail.ihdrInterlaced', p) : T('detail.ihdr', p);
    }
    case 'PLTE':
      return T('value.colours', { count: Math.floor(c.length / 3) });
    case 'tIME':
      return c.length === 7
        ? `${u16be(d, 0)}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')} ${String(d[4]).padStart(2, '0')}:${String(d[5]).padStart(2, '0')}:${String(d[6]).padStart(2, '0')}`
        : '';
    case 'pHYs':
      if (c.length !== 9) return '';
      return d[8] === 1
        ? T('detail.physMetre', { x: u32be(d, 0), y: u32be(d, 4) })
        : T('detail.physUnknown', { x: u32be(d, 0), y: u32be(d, 4) });
    case 'gAMA':
      return c.length === 4 ? T('detail.gamma', { gamma: u32be(d, 0) / 100000 }) : '';
    case 'tEXt':
    case 'zTXt':
    case 'iTXt': {
      const t = decodeTextChunk(c.type, d);
      return t
        ? `${t.keyword}: ${t.text.replace(/\s+/g, ' ').slice(0, 60)}`
        : T('detail.unreadableText');
    }
    case 'eXIf':
      return T('detail.exif');
    case 'iCCP':
      return latin1Decode(d.subarray(0, Math.max(0, d.indexOf(0))));
    case 'acTL':
      return c.length === 8 ? T('detail.apng', { count: u32be(d, 0) }) : '';
    case 'IDAT':
    case 'IEND':
      return '';
    default:
      return chunkKind(c).known ? '' : previewOf(d);
  }
}

interface Group {
  chunks: PngChunk[];
}

function groupChunks(chunks: PngChunk[]): Group[] {
  const groups: Group[] = [];
  for (const c of chunks) {
    const last = groups[groups.length - 1];
    const lastChunk = last?.chunks[last.chunks.length - 1];
    if (
      last &&
      lastChunk &&
      (c.type === 'IDAT' || c.type === 'fdAT') &&
      lastChunk.type === c.type &&
      lastChunk.crcOk &&
      c.crcOk
    ) {
      last.chunks.push(c);
    } else {
      groups.push({ chunks: [c] });
    }
  }
  return groups;
}

function analysePng(bytes: Uint8Array, name: string | undefined): Output[] {
  const parsed = parsePng(bytes);
  if (!parsed) throw new ToolError(T('error.notPng'));
  const stem = baseName(name, 'image');
  const { chunks } = parsed;
  const files: FileEntry[] = [];
  const issues: string[] = [];
  const ihdrChunk = chunks.find((c) => c.type === 'IHDR');
  const ihdr = ihdrChunk && ihdrChunk.length === 13 ? readIhdr(bytes, ihdrChunk.dataStart) : null;

  const notes: Output[] = [];
  const warn = (text: string, level: 'warn' | 'error' = 'warn') => {
    issues.push(text);
    notes.push({ type: 'note', level, text });
  };

  if (!parsed.signatureOk) {
    warn(T('note.badSignature'));
  }
  if (parsed.problem) warn(parsed.problem, 'error');
  if (!ihdrChunk) warn(T('note.noIhdr'), 'error');
  else if (chunks[0] !== ihdrChunk) warn(T('note.ihdrFirst'));
  if (ihdrChunk && ihdrChunk.length !== 13) {
    warn(T('note.ihdrLength', { count: ihdrChunk.length }), 'error');
  }
  const badTypes = chunks.filter((c) => !c.validType);
  if (badTypes.length) {
    warn(T('note.badTypes', { count: badTypes.length }));
  }
  const idatIdx = chunks.map((c, i) => (c.type === 'IDAT' ? i : -1)).filter((i) => i >= 0);
  if (idatIdx.length && idatIdx[idatIdx.length - 1]! - idatIdx[0]! + 1 !== idatIdx.length) {
    warn(T('note.idatGap'));
  }
  if (!idatIdx.length && ihdrChunk) warn(T('note.noIdat'));
  if (parsed.iendEnd === null && !parsed.problem) warn(T('note.noIend'));

  // --- CRC problems and IHDR repair
  const badCrc = chunks.filter((c) => !c.crcOk);
  const otherBad = badCrc.filter((c) => c !== ihdrChunk);
  if (otherBad.length) {
    warn(
      T('note.badCrc', { count: otherBad.length, types: otherBad.map((c) => c.type).join(', ') }),
    );
  }

  const idat = idatData(bytes, chunks);
  const rawSize = idat.length && idat.length < 1 << 26 ? inflatedSize(idat) : null;
  if (idat.length && rawSize === null && idat.length < 1 << 26) {
    warn(T('note.badZlib'));
  }
  const expected = ihdr ? expectedRawSize(ihdr) : null;
  const rowBytes = ihdr ? rowSize(ihdr) : null;
  const extras: Output[] = [];

  let repair: { ihdr: Ihdr; how: string; fromCrc: boolean } | null = null;
  const candidates: (IhdrRepair & { fits: boolean })[] = [];
  if (ihdrChunk && ihdr && ihdrChunk.length === 13 && !ihdrChunk.crcOk) {
    const found = bruteForceIhdr(ihdr, ihdrChunk.crcStored);
    const rank = { height: 0, width: 1, fields: 2, both: 3 } as const;
    candidates.push(
      ...found
        .map((r) => ({ ...r, fits: rawSize !== null && expectedRawSize(r.ihdr) === rawSize }))
        .sort((a, b) => Number(b.fits) - Number(a.fits) || rank[a.kind] - rank[b.kind]),
    );
    const best = candidates[0];
    if (best) {
      repair = {
        ihdr: best.ihdr,
        fromCrc: true,
        how:
          best.kind === 'fields'
            ? T('how.crcFields')
            : best.kind === 'both'
              ? T('how.crcBoth')
              : best.kind === 'height'
                ? T('how.crcHeight')
                : T('how.crcWidth'),
      };
      warn(
        T('note.crcRepair', {
          w: best.ihdr.width,
          h: best.ihdr.height,
          fileW: ihdr.width,
          fileH: ihdr.height,
        }),
      );
    } else if (
      rawSize !== null &&
      rowBytes &&
      rawSize % rowBytes === 0 &&
      rawSize / rowBytes !== ihdr.height
    ) {
      repair = {
        ihdr: { ...ihdr, height: rawSize / rowBytes },
        fromCrc: false,
        how: T('how.fromData'),
      };
      warn(T('note.crcRows', { count: rawSize / rowBytes, height: ihdr.height }));
    } else {
      repair = { ihdr, fromCrc: false, how: T('how.crcOnly') };
      warn(T('note.crcOnly'));
    }
  } else if (
    ihdrChunk &&
    ihdr &&
    ihdrChunk.length === 13 &&
    rawSize !== null &&
    expected !== null
  ) {
    if (rawSize > expected && rowBytes && rawSize % rowBytes === 0) {
      const rows = rawSize / rowBytes;
      repair = {
        ihdr: { ...ihdr, height: rows },
        fromCrc: false,
        how: T('how.fromData'),
      };
      warn(T('note.cropped', { count: rows, height: ihdr.height }));
    } else if (rawSize > expected) {
      warn(T('note.extraData', { count: rawSize, expected }));
    } else if (rawSize < expected) {
      warn(T('note.shortData', { count: rawSize, expected }));
    }
  }

  if (repair && ihdrChunk) {
    const fixed = withIhdr(bytes, ihdrChunk, repair.ihdr);
    files.push({
      name: `${stem}-fixed.png`,
      data: fixed,
      note: `IHDR ${ihdr!.width}x${ihdr!.height} -> ${repair.ihdr.width}x${repair.ihdr.height}`,
    });
    extras.push({
      type: 'kv',
      label: T('label.repair'),
      entries: [
        [T('kv.storedSize'), `${ihdr!.width}x${ihdr!.height}`],
        [T('kv.recoveredSize'), `${repair.ihdr.width}x${repair.ihdr.height}`],
        [T('kv.method'), repair.how],
        [
          T('kv.fits'),
          rawSize === null || expectedRawSize(repair.ihdr) === null
            ? T('value.unknown')
            : expectedRawSize(repair.ihdr) === rawSize
              ? T('value.yes')
              : T('value.no'),
        ],
      ],
    });
    if (candidates.length > 1) {
      const foundBy = {
        fields: T('value.byFields'),
        height: T('value.byHeight'),
        width: T('value.byWidth'),
        both: T('value.byBoth'),
      };
      extras.push({
        type: 'table',
        label: T('label.otherSizes'),
        columns: [T('col.width'), T('col.height'), T('col.foundBy'), T('col.fits')],
        rows: candidates
          .slice(0, 10)
          .map((c) => [
            c.ihdr.width,
            c.ihdr.height,
            foundBy[c.kind],
            c.fits ? T('value.yes') : T('value.no'),
          ]),
        highlight: [0],
      });
    }
    try {
      const image = decodeImageExact(fixed);
      if (image) {
        extras.push({
          type: 'image',
          label: T('label.repaired'),
          image,
          filename: `${stem}-fixed.png`,
        });
      }
    } catch (e) {
      extras.push({
        type: 'note',
        level: 'warn',
        text: T('note.repairFail', { error: e instanceof Error ? e.message : String(e) }),
      });
    }
  }

  // --- trailing data
  const tailOutputs: Output[] = [];
  if (parsed.iendEnd !== null && parsed.iendEnd < bytes.length) {
    const tail = bytes.subarray(parsed.iendEnd);
    issues.push('data after IEND');
    tailOutputs.push(...trailingOutputs(tail, parsed.iendEnd, 'iend', stem, files));
  } else if (parsed.problem && chunks.length) {
    const last = chunks[chunks.length - 1]!;
    const from = last.offset + 12 + last.length;
    if (from < bytes.length) {
      files.push({
        name: `${stem}-unparsed.bin`,
        data: bytes.subarray(from),
        note: T('file.unparsed', { offset: from }),
      });
    }
  }

  // --- text
  const texts = pngTexts(bytes, chunks);
  const textOutputs: Output[] = texts.length
    ? [
        {
          type: 'kv',
          label: T('label.texts'),
          entries: texts.map((t) => [
            `${t.chunk}${t.keyword ? ` ${t.keyword}` : ''}${t.note ? ` (${t.note})` : ''}`,
            t.text,
          ]),
        },
      ]
    : [];

  // --- chunk table
  const rows: (string | number)[][] = [];
  const highlight: number[] = [];
  const groups = groupChunks(chunks);
  let unknownFiles = 0;
  for (const g of groups) {
    if (rows.length >= MAX_ROWS) break;
    const first = g.chunks[0]!;
    const kind = chunkKind(first);
    const many = g.chunks.length > 1;
    const total = g.chunks.reduce((n, c) => n + c.length, 0);
    const noteParts: string[] = [many ? T('value.groupOk', { count: g.chunks.length }) : ''];
    if (!many) noteParts.push(kind.known ? kind.description : kind.description.toUpperCase());
    noteParts.push(many ? '' : pngDetails(bytes, first, ihdr));
    if (!kind.known && first.validType && first.length > 0 && unknownFiles < MAX_UNKNOWN_FILES) {
      unknownFiles++;
      files.push({
        name: `${stem}-chunk-${first.type}-${first.offset}.bin`,
        data: bytes.subarray(first.dataStart, first.dataStart + first.length),
        note: T('file.chunkPayload', { kind: kind.description.toLowerCase(), type: first.type }),
      });
    }
    if (!first.crcOk || !kind.known || TEXT_CHUNKS.has(first.type)) highlight.push(rows.length);
    rows.push([
      many ? `${first.index + 1}-${first.index + g.chunks.length}` : first.index + 1,
      at(first.offset),
      many ? `${first.type} x${g.chunks.length}` : first.type,
      total,
      many ? T('value.ok') : hex8(first.crcStored),
      many ? '' : hex8(first.crcComputed),
      first.crcOk ? T('value.ok') : T('value.bad'),
      noteParts.filter(Boolean).join(' · '),
    ]);
  }
  if (groups.length > MAX_ROWS) {
    notes.push({
      type: 'note',
      level: 'info',
      text: T('note.tableCut', { max: MAX_ROWS, total: groups.length }),
    });
  }
  const unknown = chunks.filter((c) => !chunkKind(c).known);
  if (unknown.length) {
    notes.push({
      type: 'note',
      level: 'info',
      text: T('note.nonStandard', { types: [...new Set(unknown.map((c) => c.type))].join(', ') }),
    });
  }

  const kv: [string, string][] = [[T('kv.format'), 'PNG']];
  kv.push([T('kv.fileSize'), fileSize(bytes)]);
  if (ihdr) {
    kv.push(
      [T('kv.dimensions'), `${ihdr.width}x${ihdr.height}`],
      [T('kv.bitDepth'), String(ihdr.bitDepth)],
      [
        T('kv.colourType'),
        `${ihdr.colorType} (${colorTypeName(ihdr.colorType) ?? T('value.invalid')})`,
      ],
      [
        T('kv.interlace'),
        ihdr.interlace === 0
          ? T('value.none')
          : ihdr.interlace === 1
            ? 'Adam7'
            : T('value.invalidN', { n: ihdr.interlace }),
      ],
    );
  }
  kv.push([T('kv.chunks'), String(chunks.length)]);
  if (idatIdx.length) {
    const sizes = { count: idatIdx.length, compressed: formatSize(idat.length) };
    kv.push([
      T('kv.imageData'),
      rawSize !== null
        ? T('value.idatInflated', { ...sizes, inflated: formatSize(rawSize) })
        : T('value.idat', sizes),
    ]);
  }

  const head: Output[] = [];
  if (!issues.length && !unknown.length) {
    head.push({
      type: 'note',
      level: 'success',
      text: T('note.pngOk'),
    });
  }
  return [
    ...head,
    ...notes,
    { type: 'kv', label: 'PNG', entries: kv },
    ...textOutputs,
    ...extras,
    ...tailOutputs,
    {
      type: 'table',
      label: T('label.chunks'),
      columns: [
        '#',
        T('col.offset'),
        T('col.type'),
        T('col.length'),
        T('col.crcStored'),
        T('col.crcComputed'),
        'CRC',
        T('col.notes'),
      ],
      rows,
      highlight,
    },
    ...(files.length ? [{ type: 'files', label: T('label.filesRepaired'), files } as Output] : []),
  ];
}

// ---------------------------------------------------------------- JPEG

const KNOWN_APP: Record<string, () => string> = {
  JFIF: () => T('app.jfif'),
  JFXX: () => T('app.jfxx'),
  Exif: () => T('app.exif'),
  'http://ns.adobe.com/xap/1.0/': () => T('app.xmp'),
  ICC_PROFILE: () => T('app.icc'),
  MPF: () => T('app.mpf'),
  'Photoshop 3.0': () => T('app.photoshop'),
  Adobe: () => T('app.adobe'),
  Ducky: () => T('app.ducky'),
  FPXR: () => 'FlashPix',
  Meta: () => T('app.meta'),
};

function jpegDetails(
  bytes: Uint8Array,
  s: JpegParse['segments'][number],
): { text: string; odd: boolean } {
  const d = bytes.subarray(s.dataStart, s.dataStart + s.dataLength);
  if (s.marker === 0xfe)
    return { text: T('detail.comment', { text: previewOf(d, 60) }), odd: true };
  if (s.marker >= 0xe0 && s.marker <= 0xef) {
    const id = appIdentifier(bytes, s);
    const known = KNOWN_APP[id] ?? Object.entries(KNOWN_APP).find(([k]) => id.startsWith(k))?.[1];
    if (id === 'JFIF' && d.length >= 9) {
      return {
        text: T('detail.jfif', {
          version: `${d[5]}.${String(d[6]).padStart(2, '0')}`,
          x: u16be(d, 8),
          y: u16be(d, 10),
        }),
        odd: false,
      };
    }
    return known
      ? { text: `"${id}" ${known()}`, odd: false }
      : { text: T('detail.unknownApp', { id: id || previewOf(d, 20) }), odd: true };
  }
  if (isSof(s.marker) && d.length >= 6) {
    return {
      text: T('detail.sof', {
        coding: sofDescription(s.marker) ?? T('value.frame'),
        w: u16be(d, 3),
        h: u16be(d, 1),
        bits: d[0]!,
        count: d[5]!,
      }),
      odd: false,
    };
  }
  if (s.marker === 0xdb) {
    let tables = 0;
    for (let i = 0; i < d.length; i += d[i]! >> 4 ? 129 : 65) tables++;
    return { text: T('detail.dqt', { count: tables }), odd: false };
  }
  if (s.marker === 0xc4) {
    let tables = 0;
    let i = 0;
    while (i + 17 <= d.length) {
      let n = 0;
      for (let k = 1; k <= 16; k++) n += d[i + k]!;
      i += 17 + n;
      tables++;
    }
    return { text: T('detail.dht', { count: tables }), odd: false };
  }
  if (s.marker === 0xda) {
    return {
      text: T('detail.sos', { count: d[0]!, size: formatSize(s.scanLength) }),
      odd: false,
    };
  }
  if (s.marker === 0xdd && d.length >= 2)
    return { text: T('detail.dri', { n: u16be(d, 0) }), odd: false };
  return { text: '', odd: false };
}

function analyseJpeg(bytes: Uint8Array, name: string | undefined): Output[] {
  const parsed = parseJpeg(bytes);
  if (!parsed) throw new ToolError(T('error.notJpeg'));
  const stem = baseName(name, 'image');
  const out: Output[] = [];
  const files: FileEntry[] = [];
  const notes: Output[] = [];
  const issues: string[] = [];
  for (const p of parsed.problems) {
    issues.push(p);
    notes.push({ type: 'note', level: 'warn', text: p });
  }

  const rows: (string | number)[][] = [];
  const highlight: number[] = [];
  const comments: string[] = [];
  for (const s of parsed.segments) {
    const d = jpegDetails(bytes, s);
    if (s.marker === 0xfe) comments.push(commentText(bytes, s));
    if (d.odd) highlight.push(rows.length);
    if (rows.length < MAX_ROWS) {
      rows.push([
        s.index + 1,
        at(s.offset),
        `FF${s.marker.toString(16).toUpperCase().padStart(2, '0')}`,
        s.name,
        s.length,
        d.text,
      ]);
    }
  }
  const sof = parsed.segments.find((s) => isSof(s.marker));
  const sofData = sof ? bytes.subarray(sof.dataStart, sof.dataStart + sof.dataLength) : null;
  const scans = parsed.segments.filter((s) => s.marker === 0xda).length;
  const kv: [string, string][] = [
    [T('kv.format'), 'JPEG'],
    [T('kv.fileSize'), fileSize(bytes)],
  ];
  if (sof && sofData && sofData.length >= 6) {
    kv.push(
      [T('kv.dimensions'), `${u16be(sofData, 3)}x${u16be(sofData, 1)}`],
      [T('kv.encoding'), sofDescription(sof.marker) ?? `SOF${sof.marker - 0xc0}`],
      [T('kv.components'), String(sofData[5])],
    );
  } else {
    notes.push({
      type: 'note',
      level: 'warn',
      text: T('note.noSof'),
    });
  }
  kv.push([T('kv.scans'), String(scans)], [T('kv.segments'), String(parsed.segments.length)]);
  const apps = parsed.segments.filter((s) => s.marker >= 0xe0 && s.marker <= 0xef);
  if (apps.length)
    kv.push([
      T('kv.apps'),
      apps.map((s) => `${s.name} ${appIdentifier(bytes, s) || '?'}`).join(', '),
    ]);
  if (comments.length) kv.push([T('kv.comments'), String(comments.length)]);

  const tailOutputs: Output[] = [];
  if (parsed.end !== null && parsed.end < bytes.length) {
    const tail = bytes.subarray(parsed.end);
    issues.push('data after EOI');
    tailOutputs.push(...trailingOutputs(tail, parsed.end, 'eoi', stem, files));
    kv.push([T('kv.afterEoi'), T('value.bytes', { count: tail.length })]);
  }
  const commentOutputs: Output[] = comments.map((c, i) => ({
    type: 'text',
    label: T('label.jpegComment', { n: i + 1 }),
    value: c,
  }));
  if (apps.some((s) => appIdentifier(bytes, s) === 'Exif')) {
    notes.push({
      type: 'note',
      level: 'info',
      text: T('note.jpegExif'),
    });
  }
  if (!issues.length && !highlight.length) {
    out.push({
      type: 'note',
      level: 'success',
      text: T('note.jpegOk'),
    });
  }
  return [
    ...out,
    ...notes,
    { type: 'kv', label: 'JPEG', entries: kv },
    ...commentOutputs,
    ...tailOutputs,
    {
      type: 'table',
      label: T('label.segments'),
      columns: [
        '#',
        T('col.offset'),
        T('col.marker'),
        T('col.segment'),
        T('col.length'),
        T('col.details'),
      ],
      rows,
      highlight,
    },
    ...(files.length ? [{ type: 'files', label: T('label.files'), files } as Output] : []),
  ];
}

// ---------------------------------------------------------------- GIF

function analyseGif(bytes: Uint8Array, name: string | undefined): Output[] {
  const g = parseGif(bytes);
  if (!g) throw new ToolError(T('error.notGif'));
  const stem = baseName(name, 'image');
  const files: FileEntry[] = [];
  const notes: Output[] = [];
  const issues: string[] = [];
  for (const p of g.problems) {
    issues.push(p);
    notes.push({ type: 'note', level: 'warn', text: p });
  }
  const kv: [string, string][] = [
    [T('kv.format'), `GIF (${g.version})`],
    [T('kv.fileSize'), fileSize(bytes)],
    [T('kv.dimensions'), `${g.width}x${g.height}`],
    [T('kv.frames'), String(g.frames)],
    [T('kv.palette'), g.gctSize ? T('value.colours', { count: g.gctSize }) : T('value.none')],
    [T('kv.background'), String(g.background)],
  ];
  if (g.loops !== null) {
    kv.push([T('kv.loops'), g.loops === 0 ? T('value.forever') : String(g.loops)]);
  }
  if (g.transparentIndex !== null) kv.push([T('kv.transparent'), String(g.transparentIndex)]);
  if (g.delays.length > 1) {
    kv.push([T('kv.delays'), g.delays.slice(0, 80).join(' ') + (g.delays.length > 80 ? ' …' : '')]);
    if (new Set(g.delays).size > 1) {
      notes.push({
        type: 'note',
        level: 'info',
        text: T('note.delays'),
      });
    }
  }
  const highlight: number[] = [];
  const rows = g.blocks.slice(0, MAX_ROWS).map((b, i) => {
    if (
      b.kind === 'Comment' ||
      (b.kind === 'Application' && !/^(NETSCAPE|ANIMEXTS|XMP Data|ICCRGBG1)/.test(b.detail))
    ) {
      highlight.push(i);
    }
    return [i + 1, at(b.offset), b.label, b.length, b.detail];
  });
  const commentOutputs: Output[] = g.comments.map((c, i) => ({
    type: 'text',
    label: T('label.gifComment', { n: i + 1 }),
    value: c,
  }));
  g.apps.forEach((a, i) => {
    if (/^(NETSCAPE|ANIMEXTS)/.test(a.id) || !a.data.length) return;
    files.push({
      name: `${stem}-app-${a.id.trim() || i}.bin`,
      data: a.data,
      note: T('file.appPayload', { id: `${a.id}${a.auth}` }),
    });
  });
  const tailOutputs: Output[] = [];
  if (g.trailerEnd !== null && g.trailerEnd < bytes.length) {
    issues.push('data after trailer');
    tailOutputs.push(
      ...trailingOutputs(bytes.subarray(g.trailerEnd), g.trailerEnd, 'trailer', stem, files),
    );
    kv.push([T('kv.afterTrailer'), T('value.bytes', { count: bytes.length - g.trailerEnd })]);
  }
  const head: Output[] =
    !issues.length && !highlight.length
      ? [
          {
            type: 'note',
            level: 'success',
            text: T('note.gifOk'),
          },
        ]
      : [];
  return [
    ...head,
    ...notes,
    { type: 'kv', label: 'GIF', entries: kv },
    ...commentOutputs,
    ...tailOutputs,
    {
      type: 'table',
      label: T('label.blocks'),
      columns: ['#', T('col.offset'), T('col.block'), T('col.length'), T('col.details')],
      rows,
      highlight,
    },
    ...(files.length ? [{ type: 'files', label: T('label.files'), files } as Output] : []),
  ];
}

// ---------------------------------------------------------------- tool

const isPngLike = (b: Uint8Array) =>
  (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||
  (b.length > 16 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52);
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isGif = (b: Uint8Array) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;

export default defineTool({
  id: 'image-structure',
  name: 'Image structure (PNG/JPEG/GIF)',
  category: 'stego',
  description:
    'Walk the chunks, segments and blocks of a PNG, JPEG or GIF: bad CRCs, hidden text, appended files, and a repair for PNGs whose size was edited.',
  tags: [
    'pngcheck',
    'png',
    'jpeg',
    'gif',
    'chunk',
    'crc',
    'ihdr',
    'iend',
    'trailing data',
    'text chunk',
    'comment',
    'fix png',
    'height',
  ],
  input: 'bytes',
  placeholder: 'Drop a PNG, JPEG or GIF file',
  examples: [
    {
      label: 'PNG with a cropped height',
      input: { sample: 'stego-badcrc.png' },
      expect: '256x64',
    },
    {
      label: 'Text chunks (tEXt, zTXt, iTXt)',
      input: { sample: 'stego-text-chunk.png' },
      expect: 'flag{png_text_chunks}',
    },
    {
      label: 'Data after IEND',
      input: { sample: 'stego-trailing.png' },
      expect: 'stego-trailing-after-iend.zip',
    },
    {
      label: 'JPEG segments',
      input: { sample: 'stego-exif.jpg' },
      expect: 'Created by gen-samples-stego.mjs',
    },
  ],
  run({ bytes, name }) {
    if (!bytes.length) throw new ToolError(T('error.empty'));
    if (isPngLike(bytes)) return analysePng(bytes, name);
    if (isJpeg(bytes)) return analyseJpeg(bytes, name);
    if (isGif(bytes)) return analyseGif(bytes, name);
    const sig = identify(bytes).find((s) => !s.weak);
    throw new ToolError(sig ? T('error.otherSig', { name: signatureName(sig) }) : T('error.other'));
  },
  detect({ bytes }) {
    const n = bytes.length;
    if (isPngLike(bytes)) {
      const iend = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
      const clean = iend.every((v, i) => bytes[n - 8 + i] === v);
      return clean
        ? { score: 0.5, reason: T('detect.png') }
        : { score: 0.8, reason: T('detect.pngTail') };
    }
    if (isJpeg(bytes)) {
      const clean = bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
      return clean
        ? { score: 0.45, reason: T('detect.jpeg') }
        : { score: 0.75, reason: T('detect.jpegTail') };
    }
    if (isGif(bytes)) {
      return bytes[n - 1] === 0x3b
        ? { score: 0.45, reason: T('detect.gif') }
        : { score: 0.75, reason: T('detect.gifTail') };
    }
    return null;
  },
});
