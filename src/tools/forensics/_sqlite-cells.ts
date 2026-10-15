/**
 * How a value of a result row is shown, and what is offered for the BLOBs in it: a size, a hex
 * preview and the file type its first bytes give, plus a download and, for pictures, the picture.
 */
import { formatSize, isValidUtf8, printableRatio, toHex, utf8Decode } from '../../lib/bytes';
import { identify } from '../../lib/signatures';
import { toolT, signatureName } from '../../i18n/tool-text';
import type { Output } from '../../core/types';
import type { SqlValue } from './_sqlite-engine';

const T = toolT('sqlite');

/** Longest text shown in one cell. */
export const CELL_TEXT_LIMIT = 2000;
const PREVIEW_BYTES = 12;
const HINT_BYTES = 64 * 1024;
/** All the BLOBs of a page together: each download is a copy of the bytes. */
const MAX_BLOB_TOTAL = 128 * 1024 * 1024;
/** BLOBs offered for download per page of results, and the biggest one. */
const MAX_BLOB_FILES = 25;
const MAX_BLOB_BYTES = 32 * 1024 * 1024;
const MAX_PICTURES = 6;
const MAX_PICTURE_BYTES = 4 * 1024 * 1024;

export interface BlobHint {
  /** "PNG image", "text", or null when nothing is recognised. */
  label: string | null;
  ext: string;
  mime: string | null;
}

/** What a BLOB looks like from its first bytes (the magic-byte database of the File type tool). */
export function describeBlob(bytes: Uint8Array): BlobHint {
  // Only the start is looked at: a page of results may hold hundreds of megabytes of BLOBs.
  const head = bytes.length > HINT_BYTES ? bytes.subarray(0, HINT_BYTES) : bytes;
  const sig = identify(head).find((s) => !s.weak);
  if (sig) return { label: signatureName(sig), ext: sig.ext, mime: sig.mime ?? null };
  // A cut in the middle of a UTF-8 character must not make a text file look binary.
  const text = bytes.length > HINT_BYTES ? head.subarray(0, HINT_BYTES - 3) : head;
  if (text.length > 0 && isValidUtf8(text) && printableRatio(text) > 0.9) {
    return { label: T('cell.textBlob'), ext: 'txt', mime: null };
  }
  return { label: null, ext: 'bin', mime: null };
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp']);

export function formatValue(v: SqlValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    return v.length > CELL_TEXT_LIMIT
      ? `${v.slice(0, CELL_TEXT_LIMIT)}… (${T('cell.moreChars', { chars: v.length - CELL_TEXT_LIMIT })})`
      : v;
  }
  const hint = describeBlob(v);
  const preview = toHex(v.subarray(0, PREVIEW_BYTES), ' ');
  return [
    `BLOB ${formatSize(v.length)}`,
    v.length > 0 ? preview + (v.length > PREVIEW_BYTES ? ' …' : '') : '',
    hint.label ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** True for an integer a double cannot hold exactly (sql.js reads integers as doubles). */
export const isImprecise = (v: SqlValue): boolean =>
  typeof v === 'number' && Number.isInteger(v) && Math.abs(v) >= 2 ** 53;

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'x';

export interface BlobCell {
  name: string;
  bytes: Uint8Array;
  hint: BlobHint;
}

/**
 * Downloads and pictures for the BLOB cells of a page of rows. `first` is the number of the first
 * row (1-based) so that file names say which row they came from.
 */
export function blobOutputs(
  source: string,
  columns: string[],
  rows: SqlValue[][],
  first: number,
): Output[] {
  const cells: BlobCell[] = [];
  let skipped = 0;
  let total = 0;
  rows.forEach((row, r) =>
    row.forEach((v, c) => {
      if (!(v instanceof Uint8Array) || v.length === 0) return;
      if (
        cells.length >= MAX_BLOB_FILES ||
        v.length > MAX_BLOB_BYTES ||
        total + v.length > MAX_BLOB_TOTAL
      ) {
        skipped++;
        return;
      }
      const hint = describeBlob(v);
      total += v.length;
      cells.push({
        name: `${safeName(source)}_${safeName(columns[c] ?? `col${c + 1}`)}_row${first + r}.${hint.ext}`,
        bytes: v,
        hint,
      });
    }),
  );
  if (!cells.length)
    return skipped
      ? [{ type: 'note', level: 'info', text: T('note.blobsSkipped', { skipped }) }]
      : [];
  const out: Output[] = [
    {
      type: 'files',
      label: T('label.blobs'),
      files: cells.map((c) => ({
        name: c.name,
        data: c.bytes.slice(),
        note: c.hint.label ?? undefined,
      })),
    },
  ];
  const pictures = cells.filter(
    (c) => c.hint.mime && IMAGE_MIMES.has(c.hint.mime) && c.bytes.length <= MAX_PICTURE_BYTES,
  );
  for (const p of pictures.slice(0, MAX_PICTURES)) {
    out.push({
      type: 'picture',
      label: p.name,
      data: p.bytes.slice(),
      mime: p.hint.mime!,
      filename: p.name,
    });
  }
  if (skipped) out.push({ type: 'note', level: 'info', text: T('note.blobsSkipped', { skipped }) });
  return out;
}

/** Text of a BLOB when it reads as text, for the flag search. */
export const blobText = (v: Uint8Array): string | null =>
  v.length > 0 && v.length <= 1 << 20 && printableRatio(v) > 0.8 ? utf8Decode(v) : null;
