/**
 * What the container checks hand back: table rows, tag values, payloads (bytes found where
 * audio should be, each with what it looks like) and notes, plus the text helpers they share.
 */
import { signatureName, toolT } from '../../i18n/tool-text';
import { isValidUtf8, latin1Decode, printableRatio, utf8Decode } from '../../lib/bytes';
import { scan as scanForFiles } from '../forensics/carve';
import { strongSignature } from '../stego/_lsb-classify';

const T = toolT('audio-stego');

/** A part of the file, for the structure table. */
export interface Row {
  offset: number;
  /** "fmt", "ID3v2.3", "MPEG frames"... */
  name: string;
  /** Bytes, or null when it has no size of its own. */
  size: number | null;
  what: string;
}

/** A tag, comment or header field. */
export interface Meta {
  /** Where it comes from: "LIST/INFO", "ID3v2 TXXX", "Vorbis comment"... */
  source: string;
  name: string;
  value: string;
}

/** Bytes found where audio should be. */
export interface Payload {
  /** Where it was found, in words: 'RIFF chunk "ftfx"'. */
  where: string;
  offset: number;
  data: Uint8Array;
  /** File name for the download. */
  name: string;
}

export interface Note {
  level: 'info' | 'warn' | 'success';
  text: string;
}

export interface Analysis {
  /** Short name of the container: "WAV", "AIFF", "MP3", "FLAC", "Ogg Vorbis". */
  format: string;
  /** The audio is stored without loss (FLAC): sample bits survive, but are not decoded here. */
  lossless: boolean;
  summary: [string, string][];
  rows: Row[];
  meta: Meta[];
  payloads: Payload[];
  notes: Note[];
}

export const emptyAnalysis = (format: string, lossless = false): Analysis => ({
  format,
  lossless,
  summary: [],
  rows: [],
  meta: [],
  payloads: [],
  notes: [],
});

/** Add `from` to `into`, as is. */
export function merge(into: Analysis, from: Partial<Analysis>): void {
  into.summary.push(...(from.summary ?? []));
  into.rows.push(...(from.rows ?? []));
  into.meta.push(...(from.meta ?? []));
  into.payloads.push(...(from.payloads ?? []));
  into.notes.push(...(from.notes ?? []));
}

// ---------- text ----------

/** Offsets as people paste them into a hex viewer: 1234 (0x4d2). */
export const at = (n: number): string => `${n} (0x${n.toString(16)})`;

/** UTF-8 when the bytes are valid UTF-8, else one character per byte. */
export function bytesToText(b: Uint8Array): string {
  return isValidUtf8(b) ? utf8Decode(b) : latin1Decode(b);
}

/** Control characters shown as a dot, long text cut. */
export function oneLine(s: string, max = 160): string {
  const clean = s.replace(/\p{Cc}+/gu, '·');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** A text up to the first NUL, without trailing NULs and spaces. */
export function cString(b: Uint8Array): string {
  const end = b.indexOf(0);
  return bytesToText(end < 0 ? b : b.subarray(0, end)).trimEnd();
}

export const fourCC = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);

export const isZero = (b: Uint8Array): boolean => {
  for (const x of b) if (x !== 0) return false;
  return true;
};

/**
 * Bytes found where there should be none: a payload and a warning, or just an info line when
 * they are all zeros (padding). `p.where` is a phrase that reads after "N bytes": "after the
 * last frame".
 */
export function addBlob(out: Analysis, p: Payload): void {
  const params = { count: p.data.length, where: p.where, offset: at(p.offset) };
  if (isZero(p.data)) out.notes.push({ level: 'info', text: T('blob.zeros', params) });
  else {
    out.payloads.push(p);
    out.notes.push({ level: 'warn', text: T('blob.data', params) });
  }
}

// ---------- what a payload is ----------

export interface Described {
  /** In words: "ZIP archive", "Text", "Contains a PNG image at offset 12". */
  label: string;
  ext: string;
  /** MIME type when it is a picture the page can show. */
  image: string | null;
  text: boolean;
}

const SCAN_LIMIT = 1024 * 1024;

/** "ZIP archive (also docx, xlsx...)" -> "ZIP archive" for running text. */
const shortName = (sig: { id: string; name: string }): string =>
  signatureName(sig).replace(/\s*[(（].*$/, '');

function entropy(b: Uint8Array): number {
  const counts = new Uint32Array(256);
  for (const x of b) counts[x]!++;
  let h = 0;
  for (const c of counts) if (c) h -= (c / b.length) * Math.log2(c / b.length);
  return h;
}

/** File type of a payload: magic bytes first, then readable text, a file inside it, randomness. */
export function describePayload(data: Uint8Array): Described {
  const sig = strongSignature(data);
  if (sig) {
    const mime = sig.mime && /^image\/(png|jpeg|gif|bmp|webp)$/.test(sig.mime) ? sig.mime : null;
    return { label: shortName(sig), ext: sig.ext, image: mime, text: false };
  }
  const head = data.subarray(0, 4096);
  if (head.length && printableRatio(head) >= 0.9) {
    return { label: T('payload.text'), ext: 'txt', image: null, text: true };
  }
  const inner = scanForFiles(data.subarray(0, SCAN_LIMIT)).find((h) => h.start > 0 && !h.sig.weak);
  if (inner) {
    return {
      label: T('payload.contains', { name: shortName(inner.sig), offset: inner.start }),
      ext: 'bin',
      image: null,
      text: false,
    };
  }
  if (data.length >= 64) {
    const e = entropy(data.subarray(0, 65536));
    if (e >= 7.5) {
      return {
        label: T('payload.random', { bits: e.toFixed(2) }),
        ext: 'bin',
        image: null,
        text: false,
      };
    }
  }
  return { label: T('payload.binary'), ext: 'bin', image: null, text: false };
}

/** A name that is safe to offer as a download. */
export function safeName(s: string, fallback: string): string {
  const clean = s
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 48);
  return clean || fallback;
}
