import { defineTool } from '../../core/define';
import { decodeImageExact } from '../../core/decode-image';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { formatSize, latin1Decode, printableRatio, toHex, u16be, u32be } from '../../lib/bytes';
import { identify } from '../../lib/signatures';
import { parseGif } from './_gif';
import {
  appIdentifier,
  commentText,
  isSof,
  type JpegParse,
  parseJpeg,
  SOF_DESCRIPTIONS,
} from './_jpeg';
import {
  bruteForceIhdr,
  chunkKind,
  COLOR_TYPE_NAMES,
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

type FileEntry = { name: string; data: Uint8Array; note?: string };

const hex8 = (n: number) => n.toString(16).padStart(8, '0');
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
  if (!b.length) return '(empty)';
  if (printableRatio(b.subarray(0, 256)) > 0.9) {
    const s = latin1Decode(b.subarray(0, max)).replace(/[^\x20-\x7e]/g, '·');
    return `"${s}"${b.length > max ? '…' : ''}`;
  }
  return `${toHex(b.subarray(0, 16), ' ')}${b.length > 16 ? ' …' : ''}`;
}

/** Name the kind of data glued onto the end of an image, and the file extension to give it. */
export function describeTail(tail: Uint8Array): { label: string; ext: string } {
  const sig = identify(tail).find((s) => !s.weak);
  if (sig) return { label: sig.name, ext: sig.ext };
  if (tail.every((x) => x === 0)) return { label: 'zero padding', ext: 'bin' };
  if (printableRatio(tail.subarray(0, 512)) > 0.9) return { label: 'plain text', ext: 'txt' };
  return { label: 'unidentified data', ext: 'bin' };
}

function trailingOutputs(
  tail: Uint8Array,
  offset: number,
  after: string,
  stem: string,
  files: FileEntry[],
): Output[] {
  const { label, ext } = describeTail(tail);
  files.push({
    name: `${stem}-after-${after}.${ext}`,
    data: tail,
    note: `${label}, from offset ${offset}`,
  });
  const padding = label === 'zero padding' || tail.every((x) => x === 0x0a || x === 0x0d);
  return [
    {
      type: 'note',
      level: padding ? 'info' : 'warn',
      text: `${formatSize(tail.length)} (${tail.length} bytes) follow the end of the image at offset ${offset}: ${label}. ${padding ? 'Only padding.' : 'Hidden data is often appended like this; it is extracted below.'}`,
    },
  ];
}

// ---------------------------------------------------------------- PNG

function pngDetails(bytes: Uint8Array, c: PngChunk, ihdr: Ihdr | null): string {
  const d = bytes.subarray(c.dataStart, c.dataStart + c.length);
  switch (c.type) {
    case 'IHDR':
      return ihdr
        ? `${ihdr.width}x${ihdr.height}, ${ihdr.bitDepth}-bit ${COLOR_TYPE_NAMES[ihdr.colorType] ?? `colour type ${ihdr.colorType}`}${ihdr.interlace ? ', interlaced' : ''}`
        : '';
    case 'PLTE':
      return `${Math.floor(c.length / 3)} colours`;
    case 'tIME':
      return c.length === 7
        ? `${u16be(d, 0)}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')} ${String(d[4]).padStart(2, '0')}:${String(d[5]).padStart(2, '0')}:${String(d[6]).padStart(2, '0')}`
        : '';
    case 'pHYs':
      return c.length === 9
        ? `${u32be(d, 0)} x ${u32be(d, 4)} pixels per ${d[8] === 1 ? 'metre' : 'unknown unit'}`
        : '';
    case 'gAMA':
      return c.length === 4 ? `gamma ${u32be(d, 0) / 100000}` : '';
    case 'tEXt':
    case 'zTXt':
    case 'iTXt': {
      const t = decodeTextChunk(c.type, d);
      return t
        ? `${t.keyword}: ${t.text.replace(/\s+/g, ' ').slice(0, 60)}`
        : 'unreadable text chunk';
    }
    case 'eXIf':
      return 'EXIF data (open it in the EXIF / metadata tool)';
    case 'iCCP':
      return latin1Decode(d.subarray(0, Math.max(0, d.indexOf(0))));
    case 'acTL':
      return c.length === 8 ? `animated PNG, ${u32be(d, 0)} frames` : '';
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
  if (!parsed) throw new ToolError('Not a PNG file.');
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
    warn(
      'The 8-byte PNG signature is damaged (expected 89 50 4E 47 0D 0A 1A 0A). Fix it in a hex editor; the chunks below were still read.',
    );
  }
  if (parsed.problem) warn(parsed.problem, 'error');
  if (!ihdrChunk) warn('There is no IHDR chunk.', 'error');
  else if (chunks[0] !== ihdrChunk) warn('IHDR must be the first chunk.');
  if (ihdrChunk && ihdrChunk.length !== 13) {
    warn(`IHDR is ${ihdrChunk.length} bytes long; it must be exactly 13.`, 'error');
  }
  const badTypes = chunks.filter((c) => !c.validType);
  if (badTypes.length) {
    warn(
      `${badTypes.length} chunk(s) have an invalid type name (must be 4 ASCII letters), which usually means a corrupted length field before it.`,
    );
  }
  const idatIdx = chunks.map((c, i) => (c.type === 'IDAT' ? i : -1)).filter((i) => i >= 0);
  if (idatIdx.length && idatIdx[idatIdx.length - 1]! - idatIdx[0]! + 1 !== idatIdx.length) {
    warn('IDAT chunks are not consecutive: something is stored between the image data chunks.');
  }
  if (!idatIdx.length && ihdrChunk) warn('There is no IDAT chunk: the file has no image data.');
  if (parsed.iendEnd === null && !parsed.problem)
    warn('There is no IEND chunk: the file is truncated.');

  // --- CRC problems and IHDR repair
  const badCrc = chunks.filter((c) => !c.crcOk);
  const otherBad = badCrc.filter((c) => c !== ihdrChunk);
  if (otherBad.length) {
    warn(
      `${otherBad.length} chunk(s) have a wrong CRC: ${otherBad.map((c) => c.type).join(', ')}. Either the data was edited or the CRC bytes were damaged.`,
    );
  }

  const idat = idatData(bytes, chunks);
  const rawSize = idat.length && idat.length < 1 << 26 ? inflatedSize(idat) : null;
  if (idat.length && rawSize === null && idat.length < 1 << 26) {
    warn('The image data (IDAT) is not a valid zlib stream: it is damaged or tampered with.');
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
        how: `brute force on the stored CRC (${best.kind === 'fields' ? 'other header fields' : best.kind === 'both' ? 'width and height' : best.kind})`,
      };
      warn(
        `The IHDR chunk CRC is wrong, so the header was edited. Only ${best.ihdr.width}x${best.ihdr.height} reproduces the stored CRC (the file says ${ihdr.width}x${ihdr.height}). A repaired PNG is below.`,
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
        how: 'height taken from the amount of image data, CRC recomputed',
      };
      warn(
        `The IHDR chunk CRC is wrong and no size reproduces it, but the image data holds ${rawSize / rowBytes} rows (the header says ${ihdr.height}). A repaired PNG is below.`,
      );
    } else {
      repair = { ihdr, fromCrc: false, how: 'CRC recomputed, size unchanged' };
      warn(
        'The IHDR chunk CRC is wrong but no other size fits it, and the image data matches the header. Probably only the CRC bytes are damaged; a PNG with a recomputed CRC is below.',
      );
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
        how: 'height taken from the amount of image data, CRC recomputed',
      };
      warn(
        `The image data holds ${rows} rows but the header says ${ihdr.height}: the picture was cropped by editing IHDR (with a recomputed CRC). A repaired PNG is below.`,
      );
    } else if (rawSize > expected) {
      warn(
        `The image data inflates to ${rawSize} bytes but the header only accounts for ${expected}: extra data is hidden after the pixels.`,
      );
    } else if (rawSize < expected) {
      warn(
        `The image data inflates to ${rawSize} bytes but the header promises ${expected}: the file is truncated or the header is wrong.`,
      );
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
      label: 'IHDR repair',
      entries: [
        ['Stored size', `${ihdr!.width}x${ihdr!.height}`],
        ['Recovered size', `${repair.ihdr.width}x${repair.ihdr.height}`],
        ['Method', repair.how],
        [
          'Fits the image data',
          rawSize === null || expectedRawSize(repair.ihdr) === null
            ? 'unknown'
            : expectedRawSize(repair.ihdr) === rawSize
              ? 'yes'
              : 'no',
        ],
      ],
    });
    if (candidates.length > 1) {
      extras.push({
        type: 'table',
        label: 'Other sizes with the same CRC',
        columns: ['Width', 'Height', 'Found by', 'Fits the image data'],
        rows: candidates
          .slice(0, 10)
          .map((c) => [c.ihdr.width, c.ihdr.height, c.kind, c.fits ? 'yes' : 'no']),
        highlight: [0],
      });
    }
    try {
      const image = decodeImageExact(fixed);
      if (image) {
        extras.push({
          type: 'image',
          label: 'Repaired image',
          image,
          filename: `${stem}-fixed.png`,
        });
      }
    } catch (e) {
      extras.push({
        type: 'note',
        level: 'warn',
        text: `The repaired PNG does not decode: ${e instanceof Error ? e.message : String(e)}`,
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
        note: `bytes that could not be read as chunks, from offset ${from}`,
      });
    }
  }

  // --- text
  const texts = pngTexts(bytes, chunks);
  const textOutputs: Output[] = texts.length
    ? [
        {
          type: 'kv',
          label: 'Text chunks',
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
    const noteParts: string[] = [many ? `${g.chunks.length} chunks, all CRCs OK` : ''];
    if (!many) noteParts.push(kind.known ? kind.description : kind.description.toUpperCase());
    noteParts.push(many ? '' : pngDetails(bytes, first, ihdr));
    if (!kind.known && first.validType && first.length > 0 && unknownFiles < MAX_UNKNOWN_FILES) {
      unknownFiles++;
      files.push({
        name: `${stem}-chunk-${first.type}-${first.offset}.bin`,
        data: bytes.subarray(first.dataStart, first.dataStart + first.length),
        note: `payload of the ${kind.description.toLowerCase()} "${first.type}"`,
      });
    }
    if (!first.crcOk || !kind.known || TEXT_CHUNKS.has(first.type)) highlight.push(rows.length);
    rows.push([
      many ? `${first.index + 1}-${first.index + g.chunks.length}` : first.index + 1,
      at(first.offset),
      many ? `${first.type} x${g.chunks.length}` : first.type,
      total,
      many ? 'OK' : hex8(first.crcStored),
      many ? '' : hex8(first.crcComputed),
      first.crcOk ? 'OK' : 'BAD',
      noteParts.filter(Boolean).join(' · '),
    ]);
  }
  if (groups.length > MAX_ROWS) {
    notes.push({
      type: 'note',
      level: 'info',
      text: `Chunk table cut at ${MAX_ROWS} rows (${groups.length} total).`,
    });
  }
  const unknown = chunks.filter((c) => !chunkKind(c).known);
  if (unknown.length) {
    notes.push({
      type: 'note',
      level: 'info',
      text: `Non-standard chunk(s): ${[...new Set(unknown.map((c) => c.type))].join(', ')}. Their payloads are extracted below; custom chunks are a common hiding place.`,
    });
  }

  const kv: [string, string][] = [['Format', 'PNG']];
  kv.push(['File size', `${formatSize(bytes.length)} (${bytes.length} bytes)`]);
  if (ihdr) {
    kv.push(
      ['Dimensions', `${ihdr.width}x${ihdr.height}`],
      ['Bit depth', String(ihdr.bitDepth)],
      ['Colour type', `${ihdr.colorType} (${COLOR_TYPE_NAMES[ihdr.colorType] ?? 'invalid'})`],
      [
        'Interlace',
        ihdr.interlace === 0
          ? 'none'
          : ihdr.interlace === 1
            ? 'Adam7'
            : `invalid (${ihdr.interlace})`,
      ],
    );
  }
  kv.push(['Chunks', String(chunks.length)]);
  if (idatIdx.length) {
    kv.push([
      'Image data',
      `${idatIdx.length} IDAT chunk(s), ${formatSize(idat.length)} compressed${rawSize !== null ? `, ${formatSize(rawSize)} inflated` : ''}`,
    ]);
  }

  const head: Output[] = [];
  if (!issues.length && !unknown.length) {
    head.push({
      type: 'note',
      level: 'success',
      text: 'The PNG structure is sound: every CRC matches, IEND is the last chunk and nothing is appended.',
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
      label: 'Chunks',
      columns: ['#', 'Offset', 'Type', 'Length', 'CRC stored', 'CRC computed', 'CRC', 'Notes'],
      rows,
      highlight,
    },
    ...(files.length
      ? [{ type: 'files', label: 'Extracted and repaired files', files } as Output]
      : []),
  ];
}

// ---------------------------------------------------------------- JPEG

const KNOWN_APP: Record<string, string> = {
  JFIF: 'JFIF header',
  JFXX: 'JFIF extension (thumbnail)',
  Exif: 'EXIF metadata (open it in the EXIF / metadata tool)',
  'http://ns.adobe.com/xap/1.0/': 'XMP metadata',
  ICC_PROFILE: 'ICC colour profile',
  MPF: 'Multi-picture format (extra images)',
  'Photoshop 3.0': 'Photoshop resources (IPTC, thumbnails)',
  Adobe: 'Adobe colour transform',
  Ducky: 'Photoshop "Save for Web" quality',
  FPXR: 'FlashPix',
  Meta: 'Kodak metadata',
};

function jpegDetails(
  bytes: Uint8Array,
  s: JpegParse['segments'][number],
): { text: string; odd: boolean } {
  const d = bytes.subarray(s.dataStart, s.dataStart + s.dataLength);
  if (s.marker === 0xfe) return { text: `comment: ${previewOf(d, 60)}`, odd: true };
  if (s.marker >= 0xe0 && s.marker <= 0xef) {
    const id = appIdentifier(bytes, s);
    const known = KNOWN_APP[id] ?? Object.entries(KNOWN_APP).find(([k]) => id.startsWith(k))?.[1];
    if (id === 'JFIF' && d.length >= 9) {
      return {
        text: `JFIF ${d[5]}.${String(d[6]).padStart(2, '0')}, density ${u16be(d, 8)}x${u16be(d, 10)}`,
        odd: false,
      };
    }
    return known
      ? { text: `"${id}" ${known}`, odd: false }
      : { text: `unknown application data "${id || previewOf(d, 20)}"`, odd: true };
  }
  if (isSof(s.marker) && d.length >= 6) {
    return {
      text: `${SOF_DESCRIPTIONS[s.marker] ?? 'frame'}, ${u16be(d, 3)}x${u16be(d, 1)}, ${d[0]}-bit, ${d[5]} component(s)`,
      odd: false,
    };
  }
  if (s.marker === 0xdb) {
    let tables = 0;
    for (let i = 0; i < d.length; i += d[i]! >> 4 ? 129 : 65) tables++;
    return { text: `${tables} quantisation table(s)`, odd: false };
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
    return { text: `${tables} Huffman table(s)`, odd: false };
  }
  if (s.marker === 0xda) {
    return {
      text: `${d[0]} component(s), ${formatSize(s.scanLength)} of compressed data`,
      odd: false,
    };
  }
  if (s.marker === 0xdd && d.length >= 2)
    return { text: `restart interval ${u16be(d, 0)}`, odd: false };
  return { text: '', odd: false };
}

function analyseJpeg(bytes: Uint8Array, name: string | undefined): Output[] {
  const parsed = parseJpeg(bytes);
  if (!parsed) throw new ToolError('Not a JPEG file (it must start with FF D8).');
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
    ['Format', 'JPEG'],
    ['File size', `${formatSize(bytes.length)} (${bytes.length} bytes)`],
  ];
  if (sof && sofData && sofData.length >= 6) {
    kv.push(
      ['Dimensions', `${u16be(sofData, 3)}x${u16be(sofData, 1)}`],
      ['Encoding', SOF_DESCRIPTIONS[sof.marker] ?? `SOF${sof.marker - 0xc0}`],
      ['Components', String(sofData[5])],
    );
  } else {
    notes.push({
      type: 'note',
      level: 'warn',
      text: 'No start-of-frame segment: the image header is missing.',
    });
  }
  kv.push(['Scans', String(scans)], ['Segments', String(parsed.segments.length)]);
  const apps = parsed.segments.filter((s) => s.marker >= 0xe0 && s.marker <= 0xef);
  if (apps.length)
    kv.push([
      'Application segments',
      apps.map((s) => `${s.name} ${appIdentifier(bytes, s) || '?'}`).join(', '),
    ]);
  if (comments.length) kv.push(['Comments', String(comments.length)]);

  const tailOutputs: Output[] = [];
  if (parsed.end !== null && parsed.end < bytes.length) {
    const tail = bytes.subarray(parsed.end);
    issues.push('data after EOI');
    tailOutputs.push(...trailingOutputs(tail, parsed.end, 'eoi', stem, files));
    kv.push(['Data after FFD9', `${tail.length} bytes`]);
  }
  const commentOutputs: Output[] = comments.map((c, i) => ({
    type: 'text',
    label: `JPEG comment ${i + 1}`,
    value: c,
  }));
  if (apps.some((s) => appIdentifier(bytes, s) === 'Exif')) {
    notes.push({
      type: 'note',
      level: 'info',
      text: 'This JPEG carries EXIF data: open the EXIF / metadata tool for the tags, GPS position and embedded thumbnail.',
    });
  }
  if (!issues.length && !highlight.length) {
    out.push({
      type: 'note',
      level: 'success',
      text: 'The JPEG structure is sound and nothing is appended after the end-of-image marker.',
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
      label: 'Segments',
      columns: ['#', 'Offset', 'Marker', 'Segment', 'Length', 'Details'],
      rows,
      highlight,
    },
    ...(files.length ? [{ type: 'files', label: 'Extracted files', files } as Output] : []),
  ];
}

// ---------------------------------------------------------------- GIF

function analyseGif(bytes: Uint8Array, name: string | undefined): Output[] {
  const g = parseGif(bytes);
  if (!g) throw new ToolError('Not a GIF file.');
  const stem = baseName(name, 'image');
  const files: FileEntry[] = [];
  const notes: Output[] = [];
  const issues: string[] = [];
  for (const p of g.problems) {
    issues.push(p);
    notes.push({ type: 'note', level: 'warn', text: p });
  }
  const kv: [string, string][] = [
    ['Format', `GIF (${g.version})`],
    ['File size', `${formatSize(bytes.length)} (${bytes.length} bytes)`],
    ['Dimensions', `${g.width}x${g.height}`],
    ['Frames', String(g.frames)],
    ['Global palette', g.gctSize ? `${g.gctSize} colours` : 'none'],
    ['Background index', String(g.background)],
  ];
  if (g.loops !== null) kv.push(['Loop count', g.loops === 0 ? 'forever' : String(g.loops)]);
  if (g.transparentIndex !== null) kv.push(['Transparent index', String(g.transparentIndex)]);
  if (g.delays.length > 1) {
    kv.push([
      'Frame delays (1/100 s)',
      g.delays.slice(0, 80).join(' ') + (g.delays.length > 80 ? ' …' : ''),
    ]);
    if (new Set(g.delays).size > 1) {
      notes.push({
        type: 'note',
        level: 'info',
        text: 'The frame delays are not all equal. Delays are sometimes used to carry data (binary, Morse or ASCII codes); read them in the list above.',
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
    return [i + 1, at(b.offset), b.kind, b.length, b.detail];
  });
  const commentOutputs: Output[] = g.comments.map((c, i) => ({
    type: 'text',
    label: `GIF comment ${i + 1}`,
    value: c,
  }));
  g.apps.forEach((a, i) => {
    if (/^(NETSCAPE|ANIMEXTS)/.test(a.id) || !a.data.length) return;
    files.push({
      name: `${stem}-app-${a.id.trim() || i}.bin`,
      data: a.data,
      note: `payload of the application extension "${a.id}${a.auth}"`,
    });
  });
  const tailOutputs: Output[] = [];
  if (g.trailerEnd !== null && g.trailerEnd < bytes.length) {
    issues.push('data after trailer');
    tailOutputs.push(
      ...trailingOutputs(bytes.subarray(g.trailerEnd), g.trailerEnd, 'trailer', stem, files),
    );
    kv.push(['Data after trailer', `${bytes.length - g.trailerEnd} bytes`]);
  }
  const head: Output[] =
    !issues.length && !highlight.length
      ? [
          {
            type: 'note',
            level: 'success',
            text: 'The GIF structure is sound and nothing is appended after the trailer.',
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
      label: 'Blocks',
      columns: ['#', 'Offset', 'Block', 'Length', 'Details'],
      rows,
      highlight,
    },
    ...(files.length ? [{ type: 'files', label: 'Extracted files', files } as Output] : []),
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
    if (!bytes.length) throw new ToolError('Drop a PNG, JPEG or GIF file.');
    if (isPngLike(bytes)) return analysePng(bytes, name);
    if (isJpeg(bytes)) return analyseJpeg(bytes, name);
    if (isGif(bytes)) return analyseGif(bytes, name);
    const sig = identify(bytes).find((s) => !s.weak);
    throw new ToolError(
      `${sig ? `This looks like ${sig.name}, but this` : 'This'} tool reads the structure of PNG, JPEG and GIF files only. Use "File type" or "Carve" for other formats.`,
    );
  },
  detect({ bytes }) {
    const n = bytes.length;
    if (isPngLike(bytes)) {
      const iend = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
      const clean = iend.every((v, i) => bytes[n - 8 + i] === v);
      return clean
        ? { score: 0.5, reason: 'PNG: check chunks and CRCs' }
        : { score: 0.8, reason: 'PNG that does not end with IEND (appended data or damage)' };
    }
    if (isJpeg(bytes)) {
      const clean = bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
      return clean
        ? { score: 0.45, reason: 'JPEG: list segments and comments' }
        : { score: 0.75, reason: 'JPEG that does not end with FFD9 (appended data or damage)' };
    }
    if (isGif(bytes)) {
      return bytes[n - 1] === 0x3b
        ? { score: 0.45, reason: 'GIF: list blocks and comments' }
        : { score: 0.75, reason: 'GIF that does not end with its trailer' };
    }
    return null;
  },
});
