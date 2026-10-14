import { inflateSync } from 'fflate';
import { bool, defineTool, text } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import {
  formatSize,
  isValidUtf8,
  latin1Encode,
  printableRatio,
  toHex,
  u16le,
  u32be,
  u32le,
  utf8Decode,
  utf8Encode,
} from '../../lib/bytes';
import { adler32, crc32, deflateScan, tarHeaderValid } from '../../lib/signatures';
import { parseTar, tarModified, type TarEntry } from './_tar';
import {
  describeExtra,
  dosDateTime,
  extractZipEntry,
  extraModified,
  MAX_OUTPUT,
  METHOD_NAMES,
  parseZip,
  type Extracted,
  type ZipEntry,
  type ZipInfo,
} from './_zip';

const MAX_DEPTH = 6;
/** Total extracted bytes we are willing to hold (a zip bomb guard). */
const MAX_TOTAL = MAX_OUTPUT;
const MAX_PREVIEWS = 30;

type Row = (string | number)[];
type Kind = 'zip' | 'zip-embedded' | 'gzip' | 'tar' | 'zlib' | 'deflate';

interface OutFile {
  name: string;
  data: Uint8Array;
  note?: string;
}

interface Acc {
  rows: Row[];
  files: OutFile[];
  notes: { level: 'info' | 'warn' | 'error' | 'success'; text: string }[];
  previews: { name: string; text: string }[];
  hints: string[];
  bytes: number;
  stopped: boolean;
}

interface Ctx {
  passwords: Uint8Array[];
  recursive: boolean;
  acc: Acc;
}

type Summary = [string, string][];

// ---------- recognising archives ----------

const UNSUPPORTED: [string, (b: Uint8Array) => boolean][] = [
  ['7-Zip archive', (b) => b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf],
  ['RAR archive', (b) => b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21],
  ['BZIP2 stream', (b) => b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68 && (b[3] ?? 0) >= 0x31],
  ['XZ stream', (b) => b[0] === 0xfd && b[1] === 0x37 && b[2] === 0x7a && b[3] === 0x58],
  ['Zstandard stream', (b) => b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd],
  ['Microsoft Cabinet', (b) => b[0] === 0x4d && b[1] === 0x53 && b[2] === 0x43 && b[3] === 0x46],
  ['ar / deb archive', (b) => b[0] === 0x21 && b[1] === 0x3c && b[2] === 0x61 && b[3] === 0x72],
];

const UNSUPPORTED_HELP: Record<string, string> = {
  '7-Zip archive': '7z x file.7z',
  'RAR archive': 'unrar x file.rar',
  'BZIP2 stream': 'bunzip2 file.bz2',
  'XZ stream': 'unxz file.xz',
  'Zstandard stream': 'unzstd file.zst',
  'Microsoft Cabinet': 'cabextract file.cab',
  'ar / deb archive': 'ar x file.deb',
};

function unsupportedName(b: Uint8Array): string | null {
  return UNSUPPORTED.find(([, test]) => test(b))?.[0] ?? null;
}

function zlibHeaderOk(b: Uint8Array): boolean {
  return (
    b.length >= 6 && (b[0]! & 0x0f) === 8 && b[0]! >> 4 <= 7 && ((b[0]! << 8) | b[1]!) % 31 === 0
  );
}

/**
 * What kind of archive or compressed stream this is, if any. `nested` means we are looking at
 * a file taken out of another archive: only unambiguous magics count then.
 */
export function sniff(b: Uint8Array, nested = false): Kind | null {
  if (b.length < 4) return null;
  if (u32le(b, 0) === 0x04034b50 || u32le(b, 0) === 0x06054b50) return 'zip';
  if (b[0] === 0x1f && b[1] === 0x8b && b[2] === 8) return 'gzip';
  if (tarHeaderValid(b, 0)) return 'tar';
  if (zlibHeaderOk(b)) {
    const scan = deflateScan(b, 2);
    if (scan && scan.end + 4 <= b.length && adler32Matches(b, scan.end)) return 'zlib';
  }
  if (!nested) {
    // A ZIP behind other data (an image with a ZIP glued on) is opened by its end record.
    const zip = parseZip(b);
    if (zip && zip.start > 0) return 'zip-embedded';
    const raw = deflateScan(b, 0);
    if (raw && raw.size > 0 && raw.end >= b.length - 8) return 'deflate';
  }
  return null;
}

function adler32Matches(b: Uint8Array, end: number): boolean {
  try {
    return adler32(inflateSync(b.subarray(2, end))) === u32be(b, end);
  } catch {
    return false;
  }
}

// ---------- names and previews ----------

/** A name that is safe to show and to download: no drive letters, no ../, no control characters. */
export function safeName(path: string): { name: string; unsafe: boolean } {
  const parts = path.split(/[\\/]+/);
  const unsafe = /^([\\/]|[a-zA-Z]:)/.test(path) || parts.includes('..');
  const clean = parts
    .filter((p, i) => p !== '' && p !== '.' && p !== '..' && !(i === 0 && /^[a-zA-Z]:$/.test(p)))
    .map((p) =>
      [...p].map((ch) => (ch.charCodeAt(0) < 0x20 || ch === '\u007f' ? '?' : ch)).join(''),
    );
  return { name: clean.join('/') || 'unnamed', unsafe };
}

const hex8 = (n: number) => n.toString(16).padStart(8, '0');

function isTextual(b: Uint8Array): boolean {
  return b.length > 0 && b.length <= 200_000 && isValidUtf8(b) && printableRatio(b) > 0.9;
}

function note(ctx: Ctx, prefix: string, level: Acc['notes'][number]['level'], msg: string): void {
  ctx.acc.notes.push({ level, text: prefix ? `${prefix.replace(/\/$/, '')}: ${msg}` : msg });
}

/** Keep an extracted file: list it, preview text, and deal with archives inside it. */
function addFile(
  ctx: Ctx,
  path: string,
  data: Uint8Array,
  depth: number,
  extraNote?: string,
): string | null {
  const acc = ctx.acc;
  if (acc.bytes + data.length > MAX_TOTAL) {
    if (!acc.stopped) {
      acc.stopped = true;
      note(
        ctx,
        '',
        'warn',
        `Stopped extracting after ${formatSize(MAX_TOTAL)}: the archive expands to more than this tool keeps in memory.`,
      );
    }
    return null;
  }
  acc.bytes += data.length;
  const { name, unsafe } = safeName(path);
  const inner = sniff(data, true);
  const unsupported = inner ? null : unsupportedName(data);
  const notes: string[] = [];
  if (extraNote) notes.push(extraNote);
  if (unsafe)
    notes.push('path goes outside the folder (../ or absolute): shown as-is, extracted nowhere');
  if (inner) notes.push('another archive: send it to Archive extractor');
  if (unsupported) notes.push(`${unsupported}: not supported here`);
  // A view of the input would drag the whole input along when the result crosses a worker.
  const own = data.byteLength === data.buffer.byteLength ? data : data.slice();
  acc.files.push({ name, data: own, note: notes.join(' · ') || undefined });
  if (isTextual(data) && acc.previews.length < MAX_PREVIEWS) {
    acc.previews.push({ name, text: utf8Decode(data.subarray(0, 4000)) });
  }
  if (inner) {
    if (ctx.recursive && depth < MAX_DEPTH) {
      try {
        unpackAny(ctx, data, `${path}/`, depth + 1, path.split('/').pop());
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        note(ctx, path, 'warn', `could not be opened as an archive: ${e.message}`);
      }
    } else {
      acc.hints.push(
        `"${path}" contains another archive: send it to Archive extractor (or turn on "Unpack nested archives").`,
      );
    }
  } else if (unsupported) {
    acc.hints.push(
      `"${path}" is a ${unsupported}, which the browser cannot unpack yet. Try: ${UNSUPPORTED_HELP[unsupported]}`,
    );
  }
  return name;
}

// ---------- ZIP ----------

function aesLabel(e: ZipEntry): string {
  const bits =
    e.aes?.strength === 1 ? 128 : e.aes?.strength === 2 ? 192 : e.aes?.strength === 3 ? 256 : 0;
  return bits ? `AES-${bits}` : 'AES';
}

/** Try each candidate password (UTF-8 first, then Latin-1 for non-ASCII ones). */
function extractWith(b: Uint8Array, e: ZipEntry, ctx: Ctx): Extracted {
  if (!e.encrypted || e.aes || ctx.passwords.length === 0) return extractZipEntry(b, e, null);
  let last: Extracted | null = null;
  for (const pw of ctx.passwords) {
    last = extractZipEntry(b, e, pw);
    if (last.data) return last;
  }
  return last ?? extractZipEntry(b, e, null);
}

function zipSummary(info: ZipInfo, b: Uint8Array): Summary {
  const files = info.entries.filter((e) => e.kind === 'file').length;
  const dirs = info.entries.filter((e) => e.kind === 'dir').length;
  const packed = info.entries.reduce((n, e) => n + e.csize, 0);
  const unpacked = info.entries.reduce((n, e) => n + e.usize, 0);
  const out: Summary = [
    ['Format', `ZIP archive${info.zip64 ? ' (zip64)' : ''}`],
    [
      'Entries',
      `${info.entries.length} (${files} file${files === 1 ? '' : 's'}, ${dirs} folder${dirs === 1 ? '' : 's'})`,
    ],
    ['Size', `${formatSize(packed)} packed, ${formatSize(unpacked)} unpacked`],
  ];
  if (info.comment) out.push(['Archive comment', info.comment]);
  if (info.start > 0) {
    out.push([
      'ZIP starts at',
      `offset ${info.start} (0x${info.start.toString(16)}): ${info.start} bytes of other data come first`,
    ]);
  }
  if (info.centralDirectory === 'missing') {
    out.push(['Central directory', 'missing: entries were recovered from the local headers']);
  }
  if (b.length > info.end) {
    out.push([
      'After the archive',
      `${b.length - info.end} more bytes from offset ${info.end} (0x${info.end.toString(16)})`,
    ]);
  }
  return out;
}

function unpackZip(ctx: Ctx, b: Uint8Array, prefix: string, depth: number): Summary {
  const info = parseZip(b);
  if (!info)
    throw new ToolError(
      'No ZIP structure found: neither an end-of-central-directory record nor a local file header.',
    );
  const acc = ctx.acc;
  let locked = 0;
  let wrong = 0;
  let aes = 0;
  for (const e of info.entries) {
    const notes = [...e.notes];
    const shown = `${prefix}${e.name}`;
    const { unsafe } = safeName(e.name);
    if (unsafe) notes.push('unsafe path (../ or absolute): shown only, nothing is written');
    if (e.nameFrom === 'unicode-extra') notes.push('name from the Unicode Path extra field');
    let data: Uint8Array | null = null;
    let enc = 'no';
    if (e.aes) enc = aesLabel(e);
    else if (e.encrypted) enc = 'ZipCrypto';
    let crcCell = e.dataStart < 0 && e.crc === 0 ? '-' : hex8(e.crc);
    if (e.kind !== 'dir' && !acc.stopped) {
      const r = extractWith(b, e, ctx);
      if (r.problem) {
        notes.push(r.problem);
        if (e.aes) aes++;
        else if (e.encrypted && ctx.passwords.length === 0) locked++;
        else if (e.encrypted) wrong++;
      } else if (r.data) {
        data = r.data;
        if (r.decrypted) enc = 'ZipCrypto (decrypted)';
        if (r.crcOk) crcCell += ' ok';
        if (r.note) notes.push(r.note);
      }
    }
    const ex = describeExtra(e.extra, e.extraJunk);
    if (ex) notes.push(`extra: ${ex}`);
    if (e.kind === 'symlink' && data) notes.push(`links to ${utf8Decode(data)}`);
    acc.rows.push([
      `${shown}${e.kind === 'dir' && !shown.endsWith('/') ? '/' : ''}`,
      e.usize,
      e.csize,
      e.method === 99 && e.aes
        ? `AES + ${METHOD_NAMES[e.aes.method] ?? e.aes.method}`
        : (METHOD_NAMES[e.method] ?? `#${e.method}`),
      crcCell,
      enc,
      extraModified(e.extra) ?? dosDateTime(e.dosDate, e.dosTime),
      e.comment,
      notes.join('; '),
    ]);
    if (data && e.kind === 'file') addFile(ctx, `${prefix}${e.name}`, data, depth);
  }
  for (const g of info.gaps.slice(0, 5)) {
    note(
      ctx,
      prefix,
      'warn',
      `${g.size} bytes at offset ${g.offset} (0x${g.offset.toString(16)}) ${g.where} belong to no entry: hidden data? Look at them with Hexdump (start ${g.offset}, length ${g.size}).`,
    );
  }
  if (locked > 0) {
    note(
      ctx,
      prefix,
      'warn',
      `${locked} encrypted entr${locked === 1 ? 'y' : 'ies'} (ZipCrypto). Type the password in the options to decrypt. Look for it in other files, the archive comment or the challenge text.`,
    );
  }
  if (wrong > 0) {
    note(
      ctx,
      prefix,
      'error',
      `Wrong password: ${wrong} encrypted entr${wrong === 1 ? 'y' : 'ies'} could not be decrypted.`,
    );
  }
  if (aes > 0) {
    note(
      ctx,
      prefix,
      'warn',
      `${aes} entr${aes === 1 ? 'y uses' : 'ies use'} WinZip AES encryption, which is not supported yet. Use 7-Zip: 7z x -p<password> file.zip`,
    );
  }
  if (info.entries.length === 0) note(ctx, prefix, 'info', 'The archive has no entries.');
  return zipSummary(info, b);
}

// ---------- TAR ----------

function tarKindLabel(e: TarEntry): string {
  switch (e.kind) {
    case 'file':
      return 'file';
    case 'dir':
      return 'folder';
    case 'symlink':
      return 'symlink';
    case 'hardlink':
      return 'hard link';
    default:
      return `type ${JSON.stringify(e.typeflag)}`;
  }
}

function unpackTar(
  ctx: Ctx,
  b: Uint8Array,
  prefix: string,
  depth: number,
  format: string,
): Summary {
  const info = parseTar(b);
  if (!info)
    throw new ToolError('Not a TAR archive: the first 512-byte header has a wrong checksum.');
  let files = 0;
  let dirs = 0;
  for (const e of info.entries) {
    const notes = [...e.notes];
    const { unsafe } = safeName(e.name);
    if (unsafe) notes.push('unsafe path (../ or absolute): shown only, nothing is written');
    if (e.kind === 'symlink' || e.kind === 'hardlink') notes.push(`-> ${e.link}`);
    notes.push(`${tarKindLabel(e)} ${e.mode} ${e.owner}`);
    ctx.acc.rows.push([
      `${prefix}${e.name}`,
      e.size,
      '-',
      'stored (tar)',
      e.kind === 'file' ? hex8(crc32(e.data)) : '-',
      '-',
      tarModified(e.mtime),
      '',
      notes.join('; '),
    ]);
    if (e.kind === 'dir') dirs++;
    if (e.kind === 'file') {
      files++;
      addFile(ctx, `${prefix}${e.name}`, e.data, depth);
    }
  }
  if (info.stopped) note(ctx, prefix, 'warn', `Reading stopped early: ${info.stopped}.`);
  if (b.length > info.end && !info.stopped) {
    note(
      ctx,
      prefix,
      'info',
      `${b.length - info.end} bytes follow the end of the TAR (offset ${info.end}): padding, or hidden data.`,
    );
  }
  return [
    ['Format', format],
    [
      'Entries',
      `${info.entries.length} (${files} file${files === 1 ? '' : 's'}, ${dirs} folder${dirs === 1 ? '' : 's'})`,
    ],
  ];
}

// ---------- GZIP / zlib / raw deflate ----------

const GZIP_OS: Record<number, string> = {
  0: 'FAT',
  3: 'Unix',
  7: 'Macintosh',
  11: 'NTFS',
  255: 'unknown',
};

interface GzipMember {
  name: string | null;
  comment: string | null;
  mtime: number;
  os: number;
  data: Uint8Array;
  crcOk: boolean;
  sizeOk: boolean;
  end: number;
}

function readGzipMember(b: Uint8Array, s: number): GzipMember | null {
  if (b[s] !== 0x1f || b[s + 1] !== 0x8b || b[s + 2] !== 8 || s + 18 > b.length) return null;
  const flg = b[s + 3]!;
  let p = s + 10;
  const zstr = () => {
    const from = p;
    while (p < b.length && b[p] !== 0) p++;
    const v = utf8Decode(b.subarray(from, p));
    p++;
    return v;
  };
  if (flg & 4) p += 2 + u16le(b, p);
  const name = flg & 8 ? zstr() : null;
  const comment = flg & 16 ? zstr() : null;
  if (flg & 2) p += 2;
  const scan = deflateScan(b, p);
  if (!scan || scan.end + 8 > b.length) return null;
  if (scan.size > MAX_TOTAL) {
    throw new ToolError(
      `This GZIP expands to ${formatSize(scan.size)}, more than the browser can hold here. Use gunzip on your machine.`,
    );
  }
  let data: Uint8Array;
  try {
    data = inflateSync(b.subarray(p, scan.end));
  } catch {
    return null;
  }
  return {
    name,
    comment,
    mtime: u32le(b, s + 4),
    os: b[s + 9]!,
    data,
    crcOk: crc32(data) === u32le(b, scan.end),
    sizeOk: data.length >>> 0 === u32le(b, scan.end + 4),
    end: scan.end + 8,
  };
}

function unpackGzip(ctx: Ctx, b: Uint8Array, prefix: string, depth: number, name: string): Summary {
  const members: GzipMember[] = [];
  let p = 0;
  for (let m = readGzipMember(b, p); m; m = readGzipMember(b, p)) {
    members.push(m);
    p = m.end;
  }
  if (members.length === 0) {
    throw new ToolError(
      'The GZIP header is fine but the data inside is damaged or cut off, so nothing could be decompressed.',
    );
  }
  const first = members[0]!;
  const data = members.length === 1 ? first.data : concat(members.map((m) => m.data));
  const out: Summary = [
    ['Format', members.length > 1 ? `GZIP (${members.length} members)` : 'GZIP'],
  ];
  if (first.name) out.push(['Original name', first.name]);
  if (first.comment) out.push(['Comment', first.comment]);
  if (first.mtime)
    out.push([
      'Modified',
      `${new Date(first.mtime * 1000).toISOString().slice(0, 19).replace('T', ' ')}Z`,
    ]);
  out.push(['Made on', GZIP_OS[first.os] ?? `OS ${first.os}`]);
  out.push(['Size', `${formatSize(p)} packed, ${formatSize(data.length)} unpacked`]);
  if (members.some((m) => !m.crcOk || !m.sizeOk)) {
    note(
      ctx,
      prefix,
      'warn',
      'The CRC-32 or size in the GZIP trailer does not match the data: it was damaged or modified.',
    );
  }
  if (b.length > p) {
    note(
      ctx,
      prefix,
      'warn',
      `${b.length - p} bytes follow the GZIP stream (offset ${p}, 0x${p.toString(16)}): trailing data. Look at it with Hexdump or Carve.`,
    );
  }
  // A .tar.gz: show the tar's entries instead of one opaque file.
  if (tarHeaderValid(data, 0)) {
    const tar = unpackTar(ctx, data, prefix, depth, 'TAR.GZ (tar inside gzip)');
    return [...tar.slice(0, 1), ...out.filter(([k]) => k !== 'Format'), ...tar.slice(1)];
  }
  const inner = first.name ?? name;
  ctx.acc.rows.push([
    `${prefix}${inner}`,
    data.length,
    p,
    'deflate (gzip)',
    first.crcOk ? `${hex8(crc32(data))} ok` : hex8(crc32(data)),
    'no',
    first.mtime ? new Date(first.mtime * 1000).toISOString().slice(0, 19).replace('T', ' ') : '-',
    first.comment ?? '',
    '',
  ]);
  addFile(ctx, `${prefix}${inner}`, data, depth);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

function unpackZlib(ctx: Ctx, b: Uint8Array, prefix: string, depth: number, name: string): Summary {
  const scan = zlibHeaderOk(b) ? deflateScan(b, 2) : null;
  if (!scan) throw new ToolError('Not a valid zlib stream (header or deflate data is wrong).');
  if (scan.size > MAX_TOTAL)
    throw new ToolError(
      `This stream expands to ${formatSize(scan.size)}, more than the browser can hold here.`,
    );
  let data: Uint8Array;
  try {
    data = inflateSync(b.subarray(2, scan.end));
  } catch {
    throw new ToolError('The zlib data is damaged and cannot be decompressed.');
  }
  const ok = scan.end + 4 <= b.length && adler32(data) === u32be(b, scan.end);
  const end = Math.min(b.length, scan.end + 4);
  if (!ok)
    note(
      ctx,
      prefix,
      'warn',
      'The Adler-32 checksum at the end does not match: the data was damaged or modified.',
    );
  if (b.length > end)
    note(
      ctx,
      prefix,
      'warn',
      `${b.length - end} bytes follow the zlib stream (offset ${end}): trailing data.`,
    );
  ctx.acc.rows.push([
    `${prefix}${name}`,
    data.length,
    end,
    'deflate (zlib)',
    hex8(crc32(data)),
    'no',
    '-',
    '',
    ok ? 'Adler-32 ok' : 'Adler-32 mismatch',
  ]);
  addFile(ctx, `${prefix}${name}`, data, depth);
  return [
    ['Format', 'zlib stream'],
    ['Size', `${formatSize(end)} packed, ${formatSize(data.length)} unpacked`],
  ];
}

function unpackDeflate(
  ctx: Ctx,
  b: Uint8Array,
  prefix: string,
  depth: number,
  name: string,
): Summary {
  const scan = deflateScan(b, 0);
  if (!scan) throw new ToolError('Not a valid raw deflate stream.');
  if (scan.size > MAX_TOTAL)
    throw new ToolError(
      `This stream expands to ${formatSize(scan.size)}, more than the browser can hold here.`,
    );
  const data = inflateSync(b.subarray(0, scan.end));
  if (b.length > scan.end)
    note(
      ctx,
      prefix,
      'warn',
      `${b.length - scan.end} bytes follow the deflate stream (offset ${scan.end}): trailing data.`,
    );
  ctx.acc.rows.push([
    `${prefix}${name}`,
    data.length,
    scan.end,
    'deflate (raw)',
    hex8(crc32(data)),
    'no',
    '-',
    '',
    '',
  ]);
  addFile(ctx, `${prefix}${name}`, data, depth);
  return [
    ['Format', 'raw deflate stream (no header)'],
    ['Size', `${formatSize(scan.end)} packed, ${formatSize(data.length)} unpacked`],
  ];
}

// ---------- dispatch ----------

function unpackAny(
  ctx: Ctx,
  b: Uint8Array,
  prefix: string,
  depth: number,
  name = 'data',
): Summary | null {
  const kind = sniff(b, depth > 0);
  if (!kind) return null;
  const base = name.replace(/\.(gz|tgz|z|zlib)$/i, '') || 'data';
  switch (kind) {
    case 'zip':
    case 'zip-embedded':
      return unpackZip(ctx, b, prefix, depth);
    case 'tar':
      return unpackTar(ctx, b, prefix, depth, 'TAR archive');
    case 'gzip':
      return unpackGzip(ctx, b, prefix, depth, base);
    case 'zlib':
      return unpackZlib(ctx, b, prefix, depth, base);
    case 'deflate':
      return unpackDeflate(ctx, b, prefix, depth, base);
  }
}

function passwordCandidates(raw: string): Uint8Array[] {
  if (raw === '') return [];
  const utf8 = utf8Encode(raw);
  // Old tools hash the password in the system code page: try Latin-1 too when it differs.
  const latin = [...raw].some((ch) => ch.charCodeAt(0) > 0x7f) ? latin1Encode(raw) : null;
  return latin && toHex(latin) !== toHex(utf8) ? [utf8, latin] : [utf8];
}

export default defineTool({
  id: 'archive',
  name: 'Archive extractor',
  category: 'forensics',
  description:
    'Open ZIP, GZIP, TAR, TAR.GZ, zlib and raw deflate: list entries, show hidden details, extract, and decrypt ZipCrypto with a password.',
  tags: [
    'unzip',
    'gunzip',
    'tar',
    'zip',
    'gzip',
    'extract',
    'zlib',
    'inflate',
    'password',
    'zipcrypto',
    'zip -P',
  ],
  input: 'bytes',
  placeholder: 'Drop an archive: .zip .gz .tar .tgz .zlib (or any file with a ZIP behind it)',
  options: {
    password: text('Password', '', {
      placeholder: 'only for password-protected ZIP entries',
      hint: 'Traditional ZIP encryption (ZipCrypto). Use it for files you are entitled to open.',
    }),
    recursive: bool('Unpack nested archives', true, {
      hint: 'Keep going into archives found inside archives (up to 6 levels).',
    }),
  },
  examples: [
    {
      label: 'ZIP hidden behind a PNG',
      input: { sample: 'forensics-polyglot.png' },
      expect: 'flag{binwalk_found_me}',
    },
    {
      label: 'Archives inside archives',
      input: { sample: 'forensics-nested.zip' },
      expect: 'flag{matryoshka_archive}',
    },
    {
      label: 'Same, one level at a time',
      input: { sample: 'forensics-nested.zip' },
      options: { recursive: false },
      expect: 'contains another archive',
    },
    {
      label: 'Password-protected ZIP: locked',
      input: { sample: 'forensics-zipcrypto.zip' },
      expect: 'encrypted with ZipCrypto',
    },
    {
      label: 'Password-protected ZIP: with the password',
      input: { sample: 'forensics-zipcrypto.zip' },
      options: { password: 'infected' },
      expect: 'flag{zip_crypto}',
    },
    {
      label: 'GZIP from hex',
      input: {
        hex: '1f8b08000000000002ff4bcb494caf4e2fcdabca2c882fcf2fca2eaee50200c686e06e13000000',
      },
      expect: 'flag{gunzip_works}',
    },
    {
      label: 'zlib stream from hex',
      input: { hex: '789c4bcb494cafaecac94c8a2f2e294a4dccad0500402c072f' },
      expect: 'flag{zlib_stream}',
    },
  ],
  run({ bytes, name }, { password, recursive }) {
    if (bytes.length === 0) throw new ToolError('The input is empty: drop an archive.');
    const ctx: Ctx = {
      passwords: passwordCandidates(password),
      recursive,
      acc: { rows: [], files: [], notes: [], previews: [], hints: [], bytes: 0, stopped: false },
    };
    const label = name ? name.split(/[\\/]/).pop()! : 'data';
    const summary = unpackAny(ctx, bytes, '', 0, label);
    if (!summary) {
      const other = unsupportedName(bytes);
      if (other) {
        throw new ToolError(
          `This is a ${other}, which this tool cannot open yet. Extract it on your machine: ${UNSUPPORTED_HELP[other]}`,
        );
      }
      throw new ToolError(
        'Not a ZIP, GZIP, TAR, zlib or deflate stream. If it is something glued inside another file, try Carve embedded files; to see what it is, try File type.',
      );
    }
    const { acc } = ctx;
    const out: Output[] = [{ type: 'kv', label: 'Archive', entries: summary }];
    for (const n of acc.notes) out.push({ type: 'note', level: n.level, text: n.text });
    if (acc.rows.length > 0) {
      out.push({
        type: 'table',
        label: 'Contents',
        columns: [
          'Name',
          'Size',
          'Packed',
          'Method',
          'CRC-32',
          'Encrypted',
          'Modified',
          'Comment',
          'Notes',
        ],
        rows: acc.rows,
      });
    }
    if (acc.previews.length > 0) {
      let budget = 60_000;
      const blocks: string[] = [];
      for (const p of acc.previews) {
        if (budget <= 0) break;
        const body = p.text.slice(0, budget);
        budget -= body.length;
        blocks.push(acc.previews.length > 1 ? `=== ${p.name} ===\n${body}` : body);
      }
      out.push({
        type: 'text',
        label: acc.previews.length === 1 ? `Content of ${acc.previews[0]!.name}` : 'Text files',
        value: blocks.join('\n\n'),
      });
    }
    if (acc.files.length > 0)
      out.push({ type: 'files', label: 'Extracted files', files: acc.files });
    for (const h of acc.hints) out.push({ type: 'note', level: 'info', text: h });
    return out;
  },
  detect({ bytes }) {
    const kind = sniff(bytes);
    if (kind === 'zip' || kind === 'gzip')
      return { score: 0.9, reason: kind === 'zip' ? 'ZIP archive' : 'GZIP stream' };
    if (kind === 'tar') return { score: 0.85, reason: 'TAR archive' };
    if (kind === 'zip-embedded')
      return { score: 0.7, reason: 'A ZIP archive is attached after other data' };
    if (kind === 'zlib') return { score: 0.6, reason: 'zlib stream' };
    return null;
  },
});
