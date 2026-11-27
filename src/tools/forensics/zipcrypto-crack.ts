/**
 * ZipCrypto cracker — the Biham-Kocher known-plaintext attack on traditional PKWARE encryption.
 *
 * For archives the user is entitled to open (CTF, forensics on their own files). ZipCrypto is a weak
 * stream cipher whose whole archive shares one internal key state. With at least 12 contiguous bytes
 * of known plaintext of one entry's *compressed* stream, that state is recovered (heavy search in
 * WebAssembly, off the UI thread, cancellable) and every entry is decrypted — the password is never
 * needed. WinZip AES (method 99 / extra 0x9901) is a different, strong scheme: it is detected and
 * refused, never attacked.
 */
import { inflateSync, zipSync } from 'fflate';
import { bool, defineTool, file, number } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { FileInput, Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { isValidUtf8, printableRatio, utf8Decode } from '../../lib/bytes';
import { crc32, deflateScan } from '../../lib/signatures';
import {
  decryptFromState,
  type KeyState,
  recoverBaseKeys,
  ZIPCRYPTO_HEADER,
} from './_zipcrypto-attack';
import { getRecoverKeys } from './_zipcrypto-wasm';
import { METHOD_NAMES, parseZip, type ZipEntry, type ZipInfo } from './_zip';

const T = toolT('zipcrypto-crack');

/** A warning is shown below this many known bytes: the search is slower and may be ambiguous. */
const COMFORTABLE = 40;
const MAX_OUTPUT = 256 * 1024 * 1024;

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

interface Exploitable {
  entry: ZipEntry;
  /** The stored bytes: 12-byte header followed by the encrypted compressed data. */
  cipher: Uint8Array;
}

/** ZipCrypto entries we can actually attack: encrypted, not AES, with a long enough body. */
function exploitable(info: ZipInfo, b: Uint8Array): Exploitable[] {
  const out: Exploitable[] = [];
  for (const e of info.entries) {
    if (!e.encrypted || e.aes || e.dataStart < 0) continue;
    if (e.method !== 0 && e.method !== 8) continue;
    const cipher = b.subarray(e.dataStart, Math.min(b.length, e.dataStart + e.csize));
    if (cipher.length < ZIPCRYPTO_HEADER + 12) continue;
    out.push({ entry: e, cipher });
  }
  return out;
}

/** The raw compressed stream of a plaintext-archive entry (its deflate bytes, or stored bytes). */
function compressedStream(b: Uint8Array, e: ZipEntry): Uint8Array | null {
  if (e.dataStart < 0 || e.encrypted) return null;
  return b.subarray(e.dataStart, Math.min(b.length, e.dataStart + e.csize));
}

/** The decompressed bytes of a plaintext-archive entry (for matching the target CRC, and STORED). */
function decompress(b: Uint8Array, e: ZipEntry): Uint8Array | null {
  const raw = compressedStream(b, e);
  if (!raw) return null;
  if (e.method === 0) return raw;
  if (e.method !== 8) return null;
  const scan = deflateScan(raw, 0);
  if (!scan || scan.size > MAX_OUTPUT) return null;
  try {
    return inflateSync(raw.subarray(0, scan.end));
  } catch {
    return null;
  }
}

interface Known {
  /** The entry we attack. */
  target: Exploitable;
  /** The known plaintext of its compressed stream, starting `offset` bytes in. */
  plaintext: Uint8Array;
  offset: number;
  /** How the plaintext was obtained, for the trace. */
  source: string;
}

/**
 * Work out the known plaintext of the compressed stream of one exploitable entry, from either a
 * plaintext archive (needed for DEFLATE) or a known file (STORED, confirmed by CRC first). Throws a
 * user error that explains exactly what is missing or wrong.
 */
function findKnown(
  targets: Exploitable[],
  knownFile: FileInput | null,
  archive: FileInput | null,
  offset: number,
): Known {
  const byCrc = (crc: number) => targets.find((t) => t.entry.crc === crc);

  if (archive) {
    const info = parseZip(archive.bytes);
    if (!info) throw new ToolError(T('error.archiveNotZip'));
    for (const pe of info.entries) {
      if (pe.kind !== 'file' || pe.encrypted) continue;
      const plain = decompress(archive.bytes, pe);
      if (!plain) continue;
      const target = byCrc(crc32(plain));
      if (!target) continue;
      // DEFLATE target: the known plaintext is the *compressed* stream, which must come from an
      // entry compressed the same way. STORED target: the decompressed bytes are the plaintext.
      if (target.entry.method === 8) {
        const stream = pe.method === 8 ? compressedStream(archive.bytes, pe) : null;
        if (!stream) {
          throw new ToolError(T('error.archiveNotDeflate', { name: target.entry.name }));
        }
        return {
          target,
          plaintext: stream,
          offset: 0,
          source: T('source.archive', { name: pe.name }),
        };
      }
      return {
        target,
        plaintext: plain,
        offset: 0,
        source: T('source.archive', { name: pe.name }),
      };
    }
    throw new ToolError(T('error.archiveNoMatch'));
  }

  if (knownFile) {
    const crc = crc32(knownFile.bytes);
    const target = byCrc(crc);
    if (!target) throw new ToolError(T('error.crcNoMatch', { crc: hex8(crc) }));
    if (target.entry.method === 8) {
      throw new ToolError(T('error.needArchive', { name: target.entry.name }));
    }
    return {
      target,
      plaintext: knownFile.bytes,
      offset,
      source: T('source.known', { name: knownFile.name ?? 'file', crc: hex8(crc) }),
    };
  }

  throw new ToolError(T('error.noPlaintext'));
}

interface Decrypted {
  name: string;
  data: Uint8Array;
  crcOk: boolean;
  problem: string | null;
}

/** Decrypt one entry from the recovered base keys (and inflate it if it is DEFLATE). */
function decryptEntry(base: KeyState, b: Uint8Array, e: ZipEntry): Decrypted {
  const cipher = b.subarray(e.dataStart, Math.min(b.length, e.dataStart + e.csize));
  const { data: body } = decryptFromState(base, cipher);
  let data = body;
  if (e.method === 8) {
    const scan = deflateScan(body, 0);
    if (!scan || scan.size > MAX_OUTPUT) {
      return { name: e.name, data: new Uint8Array(0), crcOk: false, problem: T('entry.inflate') };
    }
    try {
      data = inflateSync(body.subarray(0, scan.end));
    } catch {
      return { name: e.name, data: new Uint8Array(0), crcOk: false, problem: T('entry.inflate') };
    }
  } else if (e.method !== 0) {
    return {
      name: e.name,
      data: new Uint8Array(0),
      crcOk: false,
      problem: T('entry.method', { method: METHOD_NAMES[e.method] ?? `#${e.method}` }),
    };
  }
  const crcOk = crc32(data) === e.crc;
  return { name: e.name, data, crcOk, problem: null };
}

/** The 12-byte header's last byte is a check value; it rules out wrong keys before the CRC. */
function headerLooksRight(base: KeyState, cipher: Uint8Array, e: ZipEntry): boolean {
  const { header } = decryptFromState(base, cipher.subarray(0, ZIPCRYPTO_HEADER));
  const last = header[ZIPCRYPTO_HEADER - 1];
  const fromCrc = (e.crc >>> 24) & 0xff;
  const fromTime = (e.dosTime >>> 8) & 0xff;
  return e.hasDescriptor ? last === fromCrc || last === fromTime : last === fromCrc;
}

function isTextual(b: Uint8Array): boolean {
  return b.length > 0 && b.length <= 200_000 && isValidUtf8(b) && printableRatio(b) > 0.9;
}

/** A line like "password: hunter2" in a decrypted text file — chained archives hide these. */
function passwordHint(text: string): string | null {
  const m = text.match(/\b(pass(?:word|phrase)?|pwd|mot de passe|code|key)\s*[:=]\s*(\S.{0,60})/i);
  return m ? m[0].trim() : null;
}

function entryStatus(e: ZipEntry): string {
  if (e.aes) return T('status.aes');
  if (!e.encrypted) return T('status.plain');
  if (e.dataStart < 0) return T('status.noData');
  if (e.method !== 0 && e.method !== 8) return T('status.method');
  if (e.csize < ZIPCRYPTO_HEADER + 12) return T('status.tooShort');
  return T('status.exploitable');
}

export default defineTool({
  id: 'zipcrypto-crack',
  name: 'ZipCrypto cracker (known plaintext)',
  category: 'forensics',
  description:
    'Recover a ZipCrypto archive’s keys from known plaintext (Biham-Kocher) and decrypt every entry, without the password. For your own files; WinZip AES is detected and refused.',
  tags: [
    'bkcrack',
    'zipcrypto',
    'known plaintext',
    'pkzip',
    'biham',
    'kocher',
    'zip password',
    'plaintext attack',
  ],
  input: 'bytes',
  placeholder: 'Drop the encrypted ZIP (traditional ZipCrypto)',
  options: {
    known: file('Known plaintext file', 'bytes', {
      hint: 'A file you believe is inside (for STORED entries). Its CRC-32 is checked against the archive first — a match confirms the plaintext before any cracking.',
    }),
    plaintextArchive: file('Plaintext archive (for DEFLATE)', 'bytes', {
      hint: 'For DEFLATE entries the known plaintext is the compressed stream. Zip the known file locally with the same tool/level (e.g. `zip -6 known.zip known.txt`) and drop that archive here.',
    }),
    offset: number('Known-plaintext offset', 0, {
      min: 0,
      hint: 'Bytes into the compressed stream where the known plaintext begins (0 = the start).',
    }),
    reEmit: bool('Offer a decrypted ZIP', true, {
      hint: 'Repackage every decrypted entry into a new, password-free ZIP for download.',
    }),
  },
  // The examples stay to the fast paths (AES detection and the how-to guidance); the actual
  // key recovery is a heavy search proven in zipcrypto-crack.test.ts, not run on every example pass.
  examples: [
    {
      label: 'WinZip AES: detected and refused',
      input: { sample: 'zipcrack-aes.zip' },
      expect: 'AES',
    },
    {
      label: 'Encrypted ZIP: how to supply the known plaintext',
      input: { sample: 'zipcrack-stored.zip' },
      expect: 'CRC first',
    },
  ],
  async run({ bytes, name }, { known, plaintextArchive, offset, reEmit }) {
    if (bytes.length === 0) throw new ToolError(T('error.empty'));
    const info = parseZip(bytes);
    if (!info) throw new ToolError(T('error.notZip'));

    const out: Output[] = [];
    const rows = info.entries.map((e) => [
      e.name,
      e.usize,
      e.csize,
      e.method === 99 ? 'AES' : (METHOD_NAMES[e.method] ?? `#${e.method}`),
      e.aes ? 'AES' : e.encrypted ? 'ZipCrypto' : T('value.no'),
      hex8(e.crc),
      entryStatus(e),
    ]);
    out.push({
      type: 'table',
      label: T('label.entries'),
      columns: [
        T('col.name'),
        T('col.size'),
        T('col.packed'),
        T('col.method'),
        T('col.encryption'),
        T('col.crc'),
        T('col.status'),
      ],
      rows,
    });

    const aesCount = info.entries.filter((e) => e.aes).length;
    if (aesCount > 0)
      out.push({ type: 'note', level: 'warn', text: T('note.aes', { count: aesCount }) });

    const targets = exploitable(info, bytes);
    if (targets.length === 0) {
      out.push({
        type: 'note',
        level: aesCount > 0 ? 'error' : 'info',
        text: aesCount > 0 ? T('note.onlyAes') : T('note.nothing'),
      });
      return out;
    }

    // Need known plaintext. With none, explain the three ways to supply it and stop (no error).
    if (!known && !plaintextArchive) {
      out.push({ type: 'note', level: 'info', text: T('help.intro', { count: targets.length }) });
      out.push({ type: 'note', level: 'info', text: T('help.crc') });
      out.push({ type: 'note', level: 'info', text: T('help.stored') });
      out.push({ type: 'note', level: 'info', text: T('help.deflate') });
      return out;
    }

    // The known plaintext must be at least 12 contiguous bytes (checked before the CRC match, so an
    // obviously-too-short file gets the clear "need 12 bytes" answer rather than a CRC mismatch).
    if (known && known.bytes.length < 12)
      throw new ToolError(T('error.tooFew', { count: known.bytes.length }));

    const found = findKnown(targets, known, plaintextArchive, Math.max(0, Math.floor(offset)));
    const usable = found.plaintext.subarray(
      found.offset,
      found.target.cipher.length - ZIPCRYPTO_HEADER,
    );
    if (usable.length < 12) throw new ToolError(T('error.tooFew', { count: usable.length }));
    if (usable.length < COMFORTABLE) {
      out.push({ type: 'note', level: 'warn', text: T('note.short', { count: usable.length }) });
    }

    const recover = await getRecoverKeys();
    const result = recoverBaseKeys(recover, found.target.cipher, usable, found.offset);
    if (!result || !headerLooksRight(result.base, found.target.cipher, found.target.entry)) {
      throw new ToolError(T('error.noKeys'));
    }
    const { base } = result;

    // Decrypt every ZipCrypto entry from the shared base keys.
    const decrypted: Decrypted[] = [];
    for (const e of info.entries) {
      if (!e.encrypted || e.aes || e.dataStart < 0) continue;
      decrypted.push(decryptEntry(base, bytes, e));
    }
    const ok = decrypted.filter((d) => !d.problem);
    const good = ok.filter((d) => d.crcOk).length;

    out.push({
      type: 'note',
      level: 'success',
      text: T('note.cracked', { good, total: decrypted.length }),
    });
    out.push({
      type: 'kv',
      label: T('label.keys'),
      entries: [
        [T('kv.method'), found.source],
        [T('kv.offset'), String(found.offset)],
        [T('kv.length'), String(usable.length)],
        [T('kv.key0'), hex8(base.k0)],
        [T('kv.key1'), hex8(base.k1)],
        [T('kv.key2'), hex8(base.k2)],
      ],
    });

    // Trace: the steps anyone can redo by hand.
    out.push({
      type: 'text',
      label: T('label.trace'),
      value: T('trace.body', {
        name: found.target.entry.name,
        offset: found.offset,
        length: usable.length,
        k0: hex8(base.k0),
        k1: hex8(base.k1),
        k2: hex8(base.k2),
      }),
    });

    // Previews + password hints.
    const previews: string[] = [];
    for (const d of ok) {
      if (isTextual(d.data)) {
        const text = utf8Decode(d.data.subarray(0, 4000));
        const hint = passwordHint(text);
        if (hint)
          out.push({
            type: 'note',
            level: 'info',
            text: T('note.password', { name: d.name, hint }),
          });
        previews.push(ok.length > 1 ? `=== ${d.name} ===\n${text}` : text);
      }
    }
    if (previews.length > 0) {
      out.push({ type: 'text', label: T('label.preview'), value: previews.join('\n\n') });
    }

    // Downloadable decrypted files, and a re-emitted password-free ZIP.
    const files = ok.map((d) => ({
      name: d.name,
      data: d.data.byteLength === d.data.buffer.byteLength ? d.data : d.data.slice(),
      note: d.crcOk ? T('file.crcOk') : T('file.crcBad'),
    }));
    if (reEmit && ok.length > 0) {
      const map: Record<string, Uint8Array> = {};
      for (const d of ok) map[d.name] = d.data;
      const base2 = (name ? name.split(/[\\/]/).pop()! : 'archive').replace(/\.zip$/i, '');
      try {
        files.unshift({
          name: `${base2}-decrypted.zip`,
          data: zipSync(map),
          note: T('file.rezip'),
        });
      } catch {
        /* a name fflate rejects: skip the re-emitted zip, keep the individual files */
      }
    }
    if (files.length > 0) out.push({ type: 'files', label: T('label.files'), files });

    const failed = decrypted.filter((d) => d.problem);
    for (const d of failed) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.entryFailed', { name: d.name, problem: d.problem! }),
      });
    }
    return out;
  },
  detect({ bytes }) {
    const info = parseZip(bytes);
    if (!info) return null;
    const hasZipCrypto = info.entries.some((e) => e.encrypted && !e.aes);
    if (hasZipCrypto) return { score: 0.75, reason: T('detect.zipcrypto') };
    return null;
  },
});
