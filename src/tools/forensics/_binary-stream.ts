/**
 * Bounded reads of a LazyFile for the Binary analyzer. Nothing here ever asks for the whole
 * file at once: scans walk it window by window, every read() is at most MAX_READ bytes.
 */
import { ToolError } from '../../core/errors';
import type { LazyFile } from '../../core/types';
import { toolT } from '../../i18n/tool-text';

const T = toolT('binary-analyzer');

/** Size of the part of the file each scan window owns. */
export const CHUNK = 4 << 20;
/** Largest single read() this tool issues. */
export const MAX_READ = 8 << 20;

/** Bytes [offset, offset + length) of the file, read in pieces of at most MAX_READ. */
export async function readRange(
  file: LazyFile,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const start = Math.max(0, Math.min(file.size, Math.floor(offset)));
  const end = Math.max(start, Math.min(file.size, Math.floor(offset + length)));
  if (end - start <= MAX_READ) return file.read(start, end - start);
  const out = new Uint8Array(end - start);
  for (let p = start; p < end; p += MAX_READ) {
    out.set(await file.read(p, Math.min(MAX_READ, end - p)), p - start);
  }
  return out;
}

/**
 * One scan window. `bytes[0]` is at file offset `offset`. Only matches that START in
 * [ownStart, ownEnd) belong to this window: the bytes before are look-behind (`lead`), the
 * bytes after are look-ahead (`overlap`) shared with the neighbours, so a signature or a
 * string that straddles two windows is seen whole exactly once.
 */
export interface Window {
  offset: number;
  bytes: Uint8Array;
  ownStart: number;
  ownEnd: number;
  /** The window reaches the end of the scanned range. */
  last: boolean;
  /** The window reaches the end of the file: a structure cut here is really truncated. */
  atEof: boolean;
}

export interface WindowOptions {
  chunk?: number;
  /** Look-ahead after the owned part. */
  overlap?: number;
  /** Look-behind before the owned part. */
  lead?: number;
  start?: number;
  end?: number;
}

export async function* windows(file: LazyFile, opts: WindowOptions = {}): AsyncGenerator<Window> {
  const chunk = Math.max(1, opts.chunk ?? CHUNK);
  const overlap = opts.overlap ?? 0;
  const lead = opts.lead ?? 0;
  const start = Math.max(0, opts.start ?? 0);
  const end = Math.min(file.size, opts.end ?? file.size);
  for (let pos = start; pos < end; pos += chunk) {
    const ownLen = Math.min(chunk, end - pos);
    const from = Math.max(0, pos - lead);
    const to = Math.min(file.size, pos + ownLen + overlap);
    const bytes = await readRange(file, from, to - from);
    yield {
      offset: from,
      bytes,
      ownStart: pos - from,
      ownEnd: pos - from + ownLen,
      last: pos + ownLen >= end,
      atEof: to >= file.size,
    };
  }
}

/**
 * "4096", "0x1000", "4k", "1m", "-64" (from the end). Empty → null. Throws a ToolError naming
 * the option when the text is not a number.
 */
export function parseSize(raw: string, option: string): number | null {
  const s = raw.trim().replace(/[_\s]/g, '');
  if (s === '') return null;
  const m = /^(-)?(?:0x([0-9a-f]+)|(\d+)(k|kib|kb|m|mib|mb)?)$/i.exec(s);
  if (!m) throw new ToolError(T('error.number', { option, value: raw.trim() }));
  let v = m[2] !== undefined ? parseInt(m[2], 16) : parseInt(m[3]!, 10);
  const unit = (m[4] ?? '').toLowerCase();
  if (unit.startsWith('k')) v *= 1024;
  else if (unit.startsWith('m')) v *= 1024 * 1024;
  return m[1] ? -v : v;
}

export const hex = (n: number) => `0x${n.toString(16)}`;
export const hex8 = (n: number) => n.toString(16).padStart(8, '0');

/** Base name without directories or extension ("disk" for "/a/disk.bin"). */
export function stem(name: string | undefined, fallback = 'file'): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  return base.replace(/\.[^.]*$/, '') || fallback;
}

// ---------------------------------------------------------------- extracted files

export interface FileOut {
  name: string;
  data: Uint8Array;
  blob?: Blob;
  note?: string;
}

/**
 * In-memory copies one run may make: small files copied for convenience, and the bytes taken
 * out of raw CD sectors (which must be de-interleaved). Blob slices of the input cost nothing
 * and are not counted.
 */
export const COPY_BUDGET = 64 << 20;
/** The most a run copies when asked to rebuild everything (a full 80-minute CD is ~700 MiB). */
export const COPY_MAX = 768 << 20;
/** Files up to this size are copied into memory (while the budget lasts); the rest are Blobs. */
export const INLINE_MAX = 1 << 20;

/**
 * Collects the files a view extracts: at most `maxFiles` files, and at most `copyBudget`
 * bytes copied into memory. A Blob slice of the input is free.
 */
export class Extractor {
  readonly files: FileOut[] = [];
  /** Files left out because of the file limit. */
  skippedCount = 0;
  /** Files left out because copying them would exceed the copy budget. */
  skippedCopy = 0;
  private copied = 0;

  constructor(
    readonly maxFiles = Number.POSITIVE_INFINITY,
    readonly copyBudget = COPY_BUDGET,
  ) {}

  /** Room for one more file; false (and counted) once the file limit is reached. */
  room(): boolean {
    if (this.files.length < this.maxFiles) return true;
    this.skippedCount++;
    return false;
  }

  /** Reserve `size` bytes of in-memory copies; false when that would exceed the budget. */
  copyOk(size: number): boolean {
    if (this.copied + size > this.copyBudget) return false;
    this.copied += size;
    return true;
  }

  /** Bytes [start, end) of the input: a copy when small, otherwise a Blob slice (free). */
  async slice(file: LazyFile, start: number, end: number, name: string, note?: string) {
    if (!this.room()) return;
    const size = end - start;
    if (size <= INLINE_MAX && this.copyOk(size)) {
      this.files.push({ name, data: await readRange(file, start, size), note });
    } else {
      this.files.push({ name, data: new Uint8Array(0), blob: file.blob.slice(start, end), note });
    }
  }
}
