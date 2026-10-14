/**
 * TAR reading for the Archive tool: ustar, GNU long names (L/K), pax headers (x), old v7 tars.
 * Names are text only, nothing is written anywhere.
 */
import { toolT } from '../../i18n/tool-text';
import { utf8Decode } from '../../lib/bytes';
import { tarHeaderValid } from '../../lib/signatures';

const T = toolT('archive');

export interface TarEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';
  typeflag: string;
  size: number;
  /** Permission bits as octal text, e.g. "0644". */
  mode: string;
  uid: number;
  gid: number;
  owner: string;
  mtime: number;
  link: string;
  data: Uint8Array;
  /** Offset of this entry's header in the input. */
  offset: number;
  notes: string[];
}

export interface TarInfo {
  entries: TarEntry[];
  /** Offset just after the last entry (and the end-of-archive zero blocks, if present). */
  end: number;
  /** Why parsing stopped before the end (a header that does not check out), if it did. */
  stopped: string | null;
}

const has = (b: Uint8Array, o: number, n: number) => o >= 0 && o + n <= b.length;

function cstr(b: Uint8Array, o: number, n: number): string {
  let e = o;
  while (e < o + n && e < b.length && b[e] !== 0) e++;
  return utf8Decode(b.subarray(o, e));
}

function octal(b: Uint8Array, o: number, n: number): number {
  // GNU tar stores huge sizes in base-256 with the top bit of the first byte set.
  if ((b[o]! & 0x80) !== 0) {
    let v = b[o]! & 0x7f;
    for (let i = 1; i < n; i++) v = v * 256 + b[o + i]!;
    return v;
  }
  const s = cstr(b, o, n).trim();
  return /^[0-7]+$/.test(s) ? parseInt(s, 8) : 0;
}

/** pax extended header: records "<len> <key>=<value>\n". */
function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (p < data.length) {
    let sp = p;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    const len = parseInt(utf8Decode(data.subarray(p, sp)), 10);
    if (!Number.isFinite(len) || len <= sp - p + 1 || p + len > data.length) break;
    const record = utf8Decode(data.subarray(sp + 1, p + len)).replace(/\n$/, '');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    p += len;
  }
  return out;
}

const isZero = (b: Uint8Array, p: number) => {
  for (let i = 0; i < 512; i++) if (b[p + i] !== 0) return false;
  return true;
};

/** Parse a TAR that starts at offset 0. Null if the first header is not a valid TAR header. */
export function parseTar(b: Uint8Array): TarInfo | null {
  if (!tarHeaderValid(b, 0)) return null;
  const entries: TarEntry[] = [];
  let p = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  let stopped: string | null = null;
  while (has(b, p, 512)) {
    if (isZero(b, p)) {
      p += 512;
      if (has(b, p, 512) && isZero(b, p)) p += 512;
      break;
    }
    if (!tarHeaderValid(b, p)) {
      stopped = T('tar.badHeader', { offset: p });
      break;
    }
    const typeflag = b[p + 156] === 0 ? '0' : String.fromCharCode(b[p + 156]!);
    let size = octal(b, p + 124, 12);
    if (pax.size && /^\d+$/.test(pax.size)) size = parseInt(pax.size, 10);
    const dataStart = p + 512;
    const carriesData = !(typeflag >= '1' && typeflag <= '6');
    const data = b.subarray(dataStart, Math.min(b.length, dataStart + (carriesData ? size : 0)));
    const next = dataStart + (carriesData ? Math.ceil(size / 512) * 512 : 0);
    if (typeflag === 'L') {
      longName = cstr(data, 0, data.length);
      p = next;
      continue;
    }
    if (typeflag === 'K') {
      longLink = cstr(data, 0, data.length);
      p = next;
      continue;
    }
    if (typeflag === 'x') {
      pax = { ...pax, ...parsePax(data) };
      p = next;
      continue;
    }
    if (typeflag === 'g') {
      p = next;
      continue;
    }
    let name = cstr(b, p, 100);
    if (cstr(b, p + 257, 5) === 'ustar') {
      const prefix = cstr(b, p + 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    name = pax.path ?? longName ?? name;
    const notes: string[] = [];
    if (carriesData && dataStart + size > b.length) notes.push(T('tar.cutOff'));
    const mtimeRaw = pax.mtime ? Math.floor(parseFloat(pax.mtime)) : octal(b, p + 136, 12);
    entries.push({
      name,
      kind:
        typeflag === '5'
          ? 'dir'
          : typeflag === '2'
            ? 'symlink'
            : typeflag === '1'
              ? 'hardlink'
              : typeflag === '0' || typeflag === '7'
                ? 'file'
                : 'other',
      typeflag,
      size,
      mode: octal(b, p + 100, 8)
        .toString(8)
        .padStart(4, '0'),
      uid: octal(b, p + 108, 8),
      gid: octal(b, p + 116, 8),
      owner: `${cstr(b, p + 265, 32) || octal(b, p + 108, 8)}/${cstr(b, p + 297, 32) || octal(b, p + 116, 8)}`,
      mtime: mtimeRaw,
      link: pax.linkpath ?? longLink ?? cstr(b, p + 157, 100),
      data,
      offset: p,
      notes,
    });
    longName = null;
    longLink = null;
    pax = {};
    p = next;
  }
  return { entries, end: Math.min(p, b.length), stopped };
}

export function tarModified(mtime: number): string {
  if (!mtime) return '-';
  return new Date(mtime * 1000).toISOString().slice(0, 19).replace('T', ' ') + 'Z';
}
