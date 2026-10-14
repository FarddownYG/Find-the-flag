/**
 * Magic-byte signature database, shared by "File type" (offset 0) and "Carve" (every offset).
 * `magic` uses null as a wildcard byte.
 *
 * Carving hooks (all optional, all take the offset where the FILE starts, i.e. the match
 * position minus `offset`):
 *  - `valid`  cheap structural check that throws out false positives of short magics;
 *  - `end`    exclusive end offset of the embedded file, or null when it cannot be told.
 *    It may be larger than the buffer (truncated file); callers clamp.
 */

import { inflateSync } from 'fflate';

export interface Signature {
  id: string;
  name: string;
  ext: string;
  mime?: string;
  magic: (number | null)[];
  /** Where the magic sits relative to the file start (TAR: 257, ISO: 0x8001). */
  offset?: number;
  /**
   * Weak signatures (short / text) only identify whole files. Carving ignores them unless
   * they also have a `valid` hook strong enough to stand alone (PE, zlib).
   */
  weak?: boolean;
  /** False if the bytes at `start` match the magic but are certainly not this format. */
  valid?: (b: Uint8Array, start: number) => boolean;
  /** Exclusive end of the file that starts at `start`, from its own structure. */
  end?: (b: Uint8Array, start: number) => number | null;
  /** Short phrase telling how `end` finds the end (shown by Carve). */
  endHow?: string;
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const hex = (s: string) => s.split(' ').map((x) => (x === '??' ? null : parseInt(x, 16)));

export const SIGNATURES: Signature[] = [
  // images
  {
    id: 'png',
    name: 'PNG image',
    ext: 'png',
    mime: 'image/png',
    magic: hex('89 50 4e 47 0d 0a 1a 0a'),
    valid: pngValid,
    end: pngEnd,
    endHow: 'IEND chunk',
  },
  {
    id: 'jpeg',
    name: 'JPEG image',
    ext: 'jpg',
    mime: 'image/jpeg',
    magic: hex('ff d8 ff'),
    valid: jpegValid,
    end: jpegEnd,
    endHow: 'EOI marker (segments parsed)',
  },
  {
    id: 'gif',
    name: 'GIF image',
    ext: 'gif',
    mime: 'image/gif',
    magic: ascii('GIF8'),
    valid: gifValid,
    end: gifEnd,
    endHow: 'trailer byte (blocks parsed)',
  },
  {
    id: 'bmp',
    name: 'BMP image',
    ext: 'bmp',
    mime: 'image/bmp',
    magic: hex('42 4d ?? ?? ?? ?? 00 00 00 00'),
    valid: bmpValid,
    end: bmpEnd,
    endHow: 'size field',
  },
  {
    id: 'webp',
    name: 'WebP image',
    ext: 'webp',
    mime: 'image/webp',
    magic: [...ascii('RIFF'), null, null, null, null, ...ascii('WEBP')],
    valid: (b, s) => riffValid(b, s, ['VP8 ', 'VP8L', 'VP8X']),
    end: riffEnd,
    endHow: 'RIFF size field',
  },
  {
    id: 'tiff-le',
    name: 'TIFF image (little-endian)',
    ext: 'tif',
    mime: 'image/tiff',
    magic: hex('49 49 2a 00'),
    valid: (b, s) => tiffValid(b, s, true),
  },
  {
    id: 'tiff-be',
    name: 'TIFF image (big-endian)',
    ext: 'tif',
    mime: 'image/tiff',
    magic: hex('4d 4d 00 2a'),
    valid: (b, s) => tiffValid(b, s, false),
  },
  {
    id: 'ico',
    name: 'Windows icon',
    ext: 'ico',
    mime: 'image/x-icon',
    magic: hex('00 00 01 00'),
    weak: true,
  },
  {
    id: 'psd',
    name: 'Photoshop document',
    ext: 'psd',
    magic: ascii('8BPS'),
    valid: (b, s) => u16be(b, s + 4) === 1 && u32be(b, s + 6) === 0 && u16be(b, s + 10) === 0,
  },
  {
    id: 'heic',
    name: 'HEIC/AVIF image',
    ext: 'heic',
    magic: [null, null, null, null, ...ascii('ftypheic')],
    valid: mp4Valid,
    end: mp4End,
    endHow: 'top-level boxes',
  },
  {
    id: 'avif',
    name: 'AVIF image',
    ext: 'avif',
    magic: [null, null, null, null, ...ascii('ftypavif')],
    valid: mp4Valid,
    end: mp4End,
    endHow: 'top-level boxes',
  },
  { id: 'jxl', name: 'JPEG XL image', ext: 'jxl', magic: hex('ff 0a'), weak: true },
  {
    id: 'qoi',
    name: 'QOI image',
    ext: 'qoi',
    magic: ascii('qoif'),
    valid: (b, s) =>
      u32be(b, s + 4) > 0 &&
      u32be(b, s + 8) > 0 &&
      (b[s + 12] === 3 || b[s + 12] === 4) &&
      (b[s + 13] ?? 9) <= 1,
  },
  // documents
  {
    id: 'pdf',
    name: 'PDF document',
    ext: 'pdf',
    mime: 'application/pdf',
    magic: ascii('%PDF-'),
    valid: (b, s) => (b[s + 5] === 0x31 || b[s + 5] === 0x32) && b[s + 6] === 0x2e,
    end: pdfEnd,
    endHow: 'last %%EOF',
  },
  {
    id: 'ole',
    name: 'MS Office 97-2003 / OLE (doc, xls, msi)',
    ext: 'doc',
    magic: hex('d0 cf 11 e0 a1 b1 1a e1'),
    valid: (b, s) => u16le(b, s + 28) === 0xfffe && (b[s + 30] === 9 || b[s + 30] === 12),
  },
  {
    id: 'rtf',
    name: 'Rich Text Format',
    ext: 'rtf',
    magic: ascii('{\\rtf'),
    valid: (b, s) => (b[s + 5] ?? 0) >= 0x30 && (b[s + 5] ?? 0) <= 0x39,
  },
  {
    id: 'ps',
    name: 'PostScript',
    ext: 'ps',
    magic: ascii('%!PS'),
    valid: (b, s) => b[s + 4] === 0x2d,
  },
  {
    id: 'djvu',
    name: 'DjVu document',
    ext: 'djvu',
    magic: ascii('AT&TFORM'),
    valid: (b, s) => b[s + 12] === 0x44 && b[s + 13] === 0x6a && b[s + 14] === 0x56,
  },
  // archives / compression
  {
    id: 'zip',
    name: 'ZIP archive (also docx, xlsx, jar, apk, odt)',
    ext: 'zip',
    mime: 'application/zip',
    magic: hex('50 4b 03 04'),
    valid: zipValid,
    end: zipEnd,
    endHow: 'end-of-central-directory + comment',
  },
  {
    id: 'zip-empty',
    name: 'ZIP archive (empty)',
    ext: 'zip',
    magic: hex('50 4b 05 06'),
    weak: true,
  },
  { id: 'rar5', name: 'RAR archive v5', ext: 'rar', magic: hex('52 61 72 21 1a 07 01 00') },
  { id: 'rar4', name: 'RAR archive v4', ext: 'rar', magic: hex('52 61 72 21 1a 07 00') },
  {
    id: '7z',
    name: '7-Zip archive',
    ext: '7z',
    magic: hex('37 7a bc af 27 1c'),
    valid: sevenZipValid,
    end: sevenZipEnd,
    endHow: 'start header (next header offset + size)',
  },
  {
    id: 'gzip',
    name: 'GZIP compressed',
    ext: 'gz',
    mime: 'application/gzip',
    magic: hex('1f 8b 08'),
    valid: (b, s) => gzipScan(b, s) !== null,
    end: gzipEnd,
    endHow: 'deflate stream end + trailer',
  },
  {
    id: 'bzip2',
    name: 'BZIP2 compressed',
    ext: 'bz2',
    magic: hex('42 5a 68 ?? 31 41 59 26 53 59'),
    valid: (b, s) => (b[s + 3] ?? 0) >= 0x31 && (b[s + 3] ?? 0) <= 0x39,
    end: bzip2End,
    endHow: 'end-of-stream marker',
  },
  {
    id: 'xz',
    name: 'XZ compressed',
    ext: 'xz',
    magic: hex('fd 37 7a 58 5a 00'),
    valid: (b, s) =>
      b[s + 6] === 0 && s + 12 <= b.length && crc32(b.subarray(s + 6, s + 8)) === u32le(b, s + 8),
    end: xzEnd,
    endHow: 'stream footer',
  },
  {
    id: 'zstd',
    name: 'Zstandard compressed',
    ext: 'zst',
    magic: hex('28 b5 2f fd'),
    valid: (b, s) => s + 5 <= b.length && ((b[s + 4] ?? 0) & 0x08) === 0,
  },
  {
    id: 'lz4',
    name: 'LZ4 frame',
    ext: 'lz4',
    magic: hex('04 22 4d 18'),
    valid: (b, s) => (b[s + 4] ?? 0) >> 6 === 1 && ((b[s + 4] ?? 0) & 2) === 0,
  },
  {
    id: 'lzma',
    name: 'LZMA (legacy .lzma)',
    ext: 'lzma',
    magic: hex('5d 00 00 ?? ?? ?? ?? ?? ?? ?? ?? ?? ??'),
    weak: true,
  },
  {
    id: 'tar',
    name: 'TAR archive',
    ext: 'tar',
    offset: 257,
    magic: ascii('ustar'),
    valid: tarHeaderValid,
    end: tarEnd,
    endHow: 'two zero blocks (headers walked)',
  },
  {
    id: 'cab',
    name: 'Microsoft Cabinet',
    ext: 'cab',
    magic: ascii('MSCF'),
    valid: (b, s) =>
      u32le(b, s + 4) === 0 && u32le(b, s + 8) >= 36 && b[s + 24] === 3 && b[s + 25] === 1,
    end: (b, s) => s + u32le(b, s + 8),
    endHow: 'size field',
  },
  { id: 'arj', name: 'ARJ archive', ext: 'arj', magic: hex('60 ea'), weak: true },
  {
    id: 'cpio',
    name: 'CPIO archive',
    ext: 'cpio',
    magic: ascii('070701'),
    valid: (b, s) => /^[0-9a-fA-F]{8}$/.test(asciiAt(b, s + 6, 8)),
  },
  {
    id: 'deb',
    name: 'Debian package / ar archive',
    ext: 'deb',
    magic: ascii('!<arch>\n'),
    valid: (b, s) => b[s + 66] === 0x60 && b[s + 67] === 0x0a,
    end: arEnd,
    endHow: 'ar members walked',
  },
  {
    id: 'rpm',
    name: 'RPM package',
    ext: 'rpm',
    magic: hex('ed ab ee db'),
    valid: (b, s) => (b[s + 4] === 3 || b[s + 4] === 4) && u16be(b, s + 6) <= 1,
  },
  {
    id: 'zlib',
    name: 'zlib stream',
    ext: 'zlib',
    magic: hex('78 9c'),
    weak: true,
    valid: zlibValid,
    end: zlibEnd,
    endHow: 'deflate stream end + Adler-32',
  },
  {
    id: 'zlib-best',
    name: 'zlib stream (best compression)',
    ext: 'zlib',
    magic: hex('78 da'),
    weak: true,
    valid: zlibValid,
    end: zlibEnd,
    endHow: 'deflate stream end + Adler-32',
  },
  {
    id: 'zlib-fast',
    name: 'zlib stream (no/fast compression)',
    ext: 'zlib',
    magic: hex('78 01'),
    weak: true,
    valid: zlibValid,
    end: zlibEnd,
    endHow: 'deflate stream end + Adler-32',
  },
  {
    id: 'zlib-low',
    name: 'zlib stream (low compression)',
    ext: 'zlib',
    magic: hex('78 5e'),
    weak: true,
    valid: zlibValid,
    end: zlibEnd,
    endHow: 'deflate stream end + Adler-32',
  },
  // executables / bytecode
  {
    id: 'elf',
    name: 'ELF executable',
    ext: 'elf',
    magic: hex('7f 45 4c 46'),
    valid: (b, s) => elfEnd(b, s) !== null,
    end: elfEnd,
    endHow: 'section/program header tables',
  },
  {
    id: 'pe',
    name: 'Windows PE / DOS executable (MZ)',
    ext: 'exe',
    magic: ascii('MZ'),
    weak: true,
    valid: (b, s) => peEnd(b, s) !== null,
    end: peEnd,
    endHow: 'end of last section (+ certificate)',
  },
  {
    id: 'macho32',
    name: 'Mach-O 32-bit',
    ext: 'macho',
    magic: hex('ce fa ed fe'),
    valid: (b, s) => machoValid(b, s),
  },
  {
    id: 'macho64',
    name: 'Mach-O 64-bit',
    ext: 'macho',
    magic: hex('cf fa ed fe'),
    valid: (b, s) => machoValid(b, s),
  },
  {
    id: 'java-class',
    name: 'Java class / Mach-O fat binary',
    ext: 'class',
    magic: hex('ca fe ba be'),
    valid: (b, s) => u16be(b, s + 6) >= 45 && u16be(b, s + 6) <= 80,
  },
  {
    id: 'dex',
    name: 'Android DEX',
    ext: 'dex',
    magic: ascii('dex\n'),
    valid: (b, s) =>
      /^\d{3}$/.test(asciiAt(b, s + 4, 3)) && b[s + 7] === 0 && u32le(b, s + 36) === 0x70,
    end: (b, s) => s + u32le(b, s + 32),
    endHow: 'file_size field',
  },
  {
    id: 'wasm',
    name: 'WebAssembly module',
    ext: 'wasm',
    magic: hex('00 61 73 6d'),
    valid: (b, s) => u32le(b, s + 4) === 1,
  },
  {
    id: 'luac',
    name: 'Lua bytecode',
    ext: 'luac',
    magic: hex('1b 4c 75 61'),
    valid: (b, s) => (b[s + 4] ?? 0) >= 0x50 && (b[s + 4] ?? 0) <= 0x54,
  },
  {
    id: 'pyc',
    name: 'Python bytecode (.pyc)',
    ext: 'pyc',
    magic: hex('?? ?? 0d 0a 00 00 00 00'),
    weak: true,
  },
  { id: 'swf', name: 'Flash SWF', ext: 'swf', magic: ascii('FWS'), weak: true },
  { id: 'swf-z', name: 'Flash SWF (compressed)', ext: 'swf', magic: ascii('CWS'), weak: true },
  // audio / video
  {
    id: 'wav',
    name: 'WAV audio',
    ext: 'wav',
    mime: 'audio/wav',
    magic: [...ascii('RIFF'), null, null, null, null, ...ascii('WAVE')],
    valid: (b, s) => riffValid(b, s, ['fmt ', 'LIST', 'JUNK', 'bext', 'fact']),
    end: riffEnd,
    endHow: 'RIFF size field',
  },
  {
    id: 'avi',
    name: 'AVI video',
    ext: 'avi',
    magic: [...ascii('RIFF'), null, null, null, null, ...ascii('AVI ')],
    valid: (b, s) => riffValid(b, s, ['LIST']),
    end: riffEnd,
    endHow: 'RIFF size field',
  },
  {
    id: 'mp3-id3',
    name: 'MP3 audio (ID3 tag)',
    ext: 'mp3',
    mime: 'audio/mpeg',
    magic: ascii('ID3'),
    valid: (b, s) =>
      s + 10 <= b.length &&
      (b[s + 3] ?? 0xff) < 0xff &&
      (b[s + 4] ?? 0xff) < 0xff &&
      ((b[s + 5] ?? 0xff) & 0x0f) === 0 &&
      [6, 7, 8, 9].every((i) => (b[s + i] ?? 0x80) < 0x80),
  },
  {
    id: 'mp3',
    name: 'MP3 audio (frame sync)',
    ext: 'mp3',
    mime: 'audio/mpeg',
    magic: hex('ff fb'),
    weak: true,
  },
  {
    id: 'ogg',
    name: 'OGG container',
    ext: 'ogg',
    mime: 'audio/ogg',
    magic: ascii('OggS'),
    valid: (b, s) => b[s + 4] === 0 && ((b[s + 5] ?? 0xff) & 0xf8) === 0 && (b[s + 26] ?? 0) > 0,
    end: oggEnd,
    endHow: 'Ogg pages walked',
  },
  {
    id: 'flac',
    name: 'FLAC audio',
    ext: 'flac',
    mime: 'audio/flac',
    magic: ascii('fLaC'),
    valid: (b, s) => ((b[s + 4] ?? 0xff) & 0x7f) === 0 && u32be(b, s + 4) % 0x1000000 === 34,
  },
  {
    id: 'midi',
    name: 'MIDI',
    ext: 'mid',
    magic: ascii('MThd'),
    valid: (b, s) => u32be(b, s + 4) === 6,
  },
  {
    id: 'aiff',
    name: 'AIFF audio',
    ext: 'aiff',
    magic: [...ascii('FORM'), null, null, null, null, ...ascii('AIFF')],
    valid: (b, s) => asciiAt(b, s + 12, 4) === 'COMM',
    end: (b, s) => {
      const size = u32be(b, s + 4);
      return s + 8 + size + (size & 1);
    },
    endHow: 'FORM size field',
  },
  {
    id: 'mp4',
    name: 'MP4 / MOV / M4A',
    ext: 'mp4',
    mime: 'video/mp4',
    magic: [null, null, null, null, ...ascii('ftyp')],
    valid: mp4Valid,
    end: mp4End,
    endHow: 'top-level boxes',
  },
  {
    id: 'mkv',
    name: 'Matroska / WebM',
    ext: 'mkv',
    magic: hex('1a 45 df a3'),
    valid: (b, s) => /matroska|webm/.test(asciiAt(b, s + 4, 60)),
    end: mkvEnd,
    endHow: 'Segment size',
  },
  {
    id: 'flv',
    name: 'Flash video',
    ext: 'flv',
    magic: ascii('FLV'),
    valid: (b, s) => b[s + 3] === 1 && ((b[s + 4] ?? 0xff) & 0xfa) === 0 && u32be(b, s + 5) === 9,
  },
  // data / forensics
  {
    id: 'sqlite',
    name: 'SQLite database',
    ext: 'sqlite',
    magic: ascii('SQLite format 3\0'),
    valid: (b, s) => sqlitePageSize(b, s) !== null,
    end: sqliteEnd,
    endHow: 'page size × page count',
  },
  {
    id: 'pcap',
    name: 'PCAP capture',
    ext: 'pcap',
    magic: hex('d4 c3 b2 a1'),
    valid: (b, s) => u16le(b, s + 4) === 2 && u16le(b, s + 6) === 4,
  },
  {
    id: 'pcap-be',
    name: 'PCAP capture (big-endian)',
    ext: 'pcap',
    magic: hex('a1 b2 c3 d4'),
    valid: (b, s) => u16be(b, s + 4) === 2 && u16be(b, s + 6) === 4,
  },
  {
    id: 'pcap-ns',
    name: 'PCAP capture (nanosecond)',
    ext: 'pcap',
    magic: hex('4d 3c b2 a1'),
    valid: (b, s) => u16le(b, s + 4) === 2 && u16le(b, s + 6) === 4,
  },
  {
    id: 'pcapng',
    name: 'PCAPNG capture',
    ext: 'pcapng',
    magic: hex('0a 0d 0d 0a'),
    valid: (b, s) => {
      const bom = u32le(b, s + 8);
      return u32le(b, s + 4) >= 28 && (bom === 0x1a2b3c4d || bom === 0x4d3c2b1a);
    },
  },
  {
    id: 'regf',
    name: 'Windows registry hive',
    ext: 'dat',
    magic: ascii('regf'),
    valid: (b, s) => u32le(b, s + 20) === 1 && u32le(b, s + 24) >= 3 && u32le(b, s + 24) <= 6,
    end: (b, s) => s + 4096 + u32le(b, s + 40),
    endHow: 'hive bins size',
  },
  { id: 'evtx', name: 'Windows event log (EVTX)', ext: 'evtx', magic: ascii('ElfFile\0') },
  { id: 'lnk', name: 'Windows shortcut (LNK)', ext: 'lnk', magic: hex('4c 00 00 00 01 14 02 00') },
  {
    id: 'kdbx',
    name: 'KeePass database',
    ext: 'kdbx',
    magic: hex('03 d9 a2 9a'),
    valid: (b, s) => u32le(b, s + 4) === 0xb54bfb67 || u32le(b, s + 4) === 0xb54bfb65,
  },
  {
    id: 'luks',
    name: 'LUKS encrypted volume',
    ext: 'luks',
    magic: hex('4c 55 4b 53 ba be'),
    valid: (b, s) => u16be(b, s + 6) === 1 || u16be(b, s + 6) === 2,
  },
  {
    id: 'iso',
    name: 'ISO 9660 disk image',
    ext: 'iso',
    offset: 0x8001,
    magic: ascii('CD001'),
    valid: (b, s) => b[s + 0x8000] === 1 && b[s + 0x8006] === 1,
    end: (b, s) => {
      const size = u32le(b, s + 0x8050) * u16le(b, s + 0x8080);
      return size > 0 ? s + size : null;
    },
    endHow: 'volume size × block size',
  },
  {
    id: 'vmdk',
    name: 'VMware disk (VMDK)',
    ext: 'vmdk',
    magic: ascii('KDMV'),
    valid: (b, s) => u32le(b, s + 4) >= 1 && u32le(b, s + 4) <= 3,
  },
  {
    id: 'qcow',
    name: 'QEMU disk (qcow)',
    ext: 'qcow2',
    magic: hex('51 46 49 fb'),
    valid: (b, s) => u32be(b, s + 4) === 2 || u32be(b, s + 4) === 3,
  },
  { id: 'vhdx', name: 'Hyper-V disk (VHDX)', ext: 'vhdx', magic: ascii('vhdxfile') },
  {
    id: 'ext',
    name: 'ext2/3/4 filesystem',
    ext: 'img',
    offset: 1080,
    magic: hex('53 ef'),
    weak: true,
  },
  {
    id: 'ntfs',
    name: 'NTFS boot sector',
    ext: 'img',
    offset: 3,
    magic: ascii('NTFS    '),
    valid: (b, s) =>
      [512, 1024, 2048, 4096].includes(u16le(b, s + 11)) &&
      b[s + 510] === 0x55 &&
      b[s + 511] === 0xaa,
    end: (b, s) => {
      const sectors = u32le(b, s + 0x28) + u32le(b, s + 0x2c) * 4294967296;
      return sectors > 0 ? s + (sectors + 1) * u16le(b, s + 11) : null;
    },
    endHow: 'sector count × sector size',
  },
  { id: 'fat', name: 'FAT boot sector', ext: 'img', offset: 54, magic: ascii('FAT'), weak: true },
  {
    id: 'dsstore',
    name: 'macOS .DS_Store',
    ext: 'DS_Store',
    magic: hex('00 00 00 01 42 75 64 31'),
  },
  {
    id: 'git-pack',
    name: 'Git pack file',
    ext: 'pack',
    magic: ascii('PACK'),
    valid: (b, s) => (u32be(b, s + 4) === 2 || u32be(b, s + 4) === 3) && u32be(b, s + 8) > 0,
  },
  {
    id: 'pgp-armor',
    name: 'PGP armored block',
    ext: 'asc',
    magic: ascii('-----BEGIN PGP'),
    end: pemEnd,
    endHow: '-----END line',
  },
  {
    id: 'ssh-key',
    name: 'OpenSSH private key',
    ext: 'key',
    magic: ascii('-----BEGIN OPENSSH PRIVATE KEY'),
    end: pemEnd,
    endHow: '-----END line',
  },
  {
    id: 'pem',
    name: 'PEM block (certificate / key)',
    ext: 'pem',
    magic: ascii('-----BEGIN '),
    end: pemEnd,
    endHow: '-----END line',
  },
  {
    id: 'der',
    name: 'DER certificate / ASN.1 sequence',
    ext: 'der',
    magic: hex('30 82'),
    weak: true,
  },
  // text-ish
  { id: 'xml', name: 'XML document', ext: 'xml', magic: ascii('<?xml'), weak: true },
  { id: 'html', name: 'HTML document', ext: 'html', magic: ascii('<!DOCTYPE html'), weak: true },
  { id: 'svg', name: 'SVG image', ext: 'svg', magic: ascii('<svg'), weak: true },
  { id: 'shebang', name: 'Script (shebang)', ext: 'sh', magic: ascii('#!'), weak: true },
  { id: 'utf8-bom', name: 'UTF-8 text with BOM', ext: 'txt', magic: hex('ef bb bf'), weak: true },
  {
    id: 'utf16le-bom',
    name: 'UTF-16LE text with BOM',
    ext: 'txt',
    magic: hex('ff fe'),
    weak: true,
  },
  {
    id: 'utf16be-bom',
    name: 'UTF-16BE text with BOM',
    ext: 'txt',
    magic: hex('fe ff'),
    weak: true,
  },
];

export function matchesAt(b: Uint8Array, sig: Signature, fileStart: number): boolean {
  const at = fileStart + (sig.offset ?? 0);
  if (at < 0 || at + sig.magic.length > b.length) return false;
  for (let i = 0; i < sig.magic.length; i++) {
    const m = sig.magic[i];
    if (m !== null && m !== undefined && b[at + i] !== m) return false;
  }
  return true;
}

/** Signatures matching at the very start of the buffer, strongest (longest magic) first. */
export function identify(b: Uint8Array): Signature[] {
  return SIGNATURES.filter((s) => matchesAt(b, s, 0)).sort(
    (a, b2) => Number(!!a.weak) - Number(!!b2.weak) || b2.magic.length - a.magic.length,
  );
}

// ---------------------------------------------------------------------------------------
// Shared binary helpers
// ---------------------------------------------------------------------------------------

const u16le = (b: Uint8Array, o: number) => ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)) >>> 0;
const u16be = (b: Uint8Array, o: number) => (((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)) >>> 0;
const u32le = (b: Uint8Array, o: number) => (u16le(b, o) | (u16le(b, o + 2) << 16)) >>> 0;
const u32be = (b: Uint8Array, o: number) => ((u16be(b, o) << 16) | u16be(b, o + 2)) >>> 0;
const u64le = (b: Uint8Array, o: number) => u32le(b, o) + u32le(b, o + 4) * 4294967296;

const has = (b: Uint8Array, o: number, n: number) => o >= 0 && o + n <= b.length;

/** `n` bytes as Latin-1 text (empty when out of range). */
function asciiAt(b: Uint8Array, o: number, n: number): string {
  if (o < 0) return '';
  let s = '';
  for (let i = o; i < o + n && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

function indexOfAscii(b: Uint8Array, needle: string, from: number): number {
  const first = needle.charCodeAt(0);
  const n = needle.length;
  for (let i = from; i + n <= b.length; i++) {
    if (b[i] !== first) continue;
    let k = 1;
    while (k < n && b[i + k] === needle.charCodeAt(k)) k++;
    if (k === n) return i;
  }
  return -1;
}

const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (the one ZIP, PNG and gzip use), optionally continuing from a previous result. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** One CRC-32 step without the pre/post inversion (what ZipCrypto's key schedule needs). */
export function crc32Step(crc: number, byte: number): number {
  return (CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
}

export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let c = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    c = (c + a) % 65521;
  }
  return ((c << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------------------
// Deflate: walk a stream without producing output, to learn where it ends
// ---------------------------------------------------------------------------------------

export interface DeflateScan {
  /** Offset of the first byte after the stream. */
  end: number;
  /** Number of bytes it expands to. */
  size: number;
}

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  count: Uint16Array;
  symbol: Uint16Array;
}

/** Canonical Huffman table; null if over-subscribed or (except the 1-code case) incomplete. */
function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman | null {
  const count = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]!] = count[lengths[i]!]! + 1;
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - count[len]!;
    if (left < 0) return null;
  }
  if (left > 0 && n - count[0]! !== count[1]!) return null;
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len]! + count[len]!;
  const symbol = new Uint16Array(n);
  for (let sym = 0; sym < n; sym++) {
    const l = lengths[sym]!;
    if (l) symbol[offs[l]!++] = sym;
  }
  return { count, symbol };
}

let fixedTables: { lit: Huffman; dist: Huffman } | null = null;
function fixedHuffman(): { lit: Huffman; dist: Huffman } {
  if (!fixedTables) {
    const lens = new Uint8Array(288);
    lens.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
    // 32 five-bit codes: 30 and 31 exist in the code but are rejected when decoded
    const dl = new Uint8Array(32).fill(5);
    fixedTables = { lit: buildHuffman(lens, 288)!, dist: buildHuffman(dl, 32)! };
  }
  return fixedTables;
}

/**
 * Parse the raw deflate stream that begins at `start`, validating every block, and report
 * where it ends and how many bytes it expands to. Returns null if it is not a valid stream
 * (or is cut off before its final block). No output is produced, so it is fast and cheap.
 */
export function deflateScan(b: Uint8Array, start = 0, limit = b.length): DeflateScan | null {
  let pos = start;
  let bitBuf = 0;
  let bitCnt = 0;
  let size = 0;
  let eof = false;

  const bits = (n: number): number => {
    while (bitCnt < n) {
      if (pos >= limit) {
        eof = true;
        return 0;
      }
      bitBuf |= b[pos++]! << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const count = h.count[len]!;
      if (code - count < first) return h.symbol[index + (code - first)]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    return -1;
  };
  const codes = (lit: Huffman, dist: Huffman): boolean => {
    for (;;) {
      const sym = decode(lit);
      if (eof || sym < 0) return false;
      if (sym < 256) {
        size++;
      } else if (sym === 256) {
        return true;
      } else {
        const s = sym - 257;
        if (s >= 29) return false;
        const len = LEN_BASE[s]! + bits(LEN_EXTRA[s]!);
        const ds = decode(dist);
        if (eof || ds < 0 || ds >= 30) return false;
        const d = DIST_BASE[ds]! + bits(DIST_EXTRA[ds]!);
        if (eof || d > size) return false;
        size += len;
      }
    }
  };

  for (;;) {
    const final = bits(1);
    const type = bits(2);
    if (eof) return null;
    if (type === 0) {
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > limit) return null;
      const len = b[pos]! | (b[pos + 1]! << 8);
      if ((len ^ 0xffff) !== (b[pos + 2]! | (b[pos + 3]! << 8))) return null;
      pos += 4;
      if (pos + len > limit) return null;
      pos += len;
      size += len;
    } else if (type === 1) {
      const t = fixedHuffman();
      if (!codes(t.lit, t.dist)) return null;
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      if (eof || nlen > 286 || ndist > 30) return null;
      const cl = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) cl[CL_ORDER[i]!] = bits(3);
      const clTable = buildHuffman(cl, 19);
      if (eof || !clTable) return null;
      const lengths = new Uint8Array(nlen + ndist);
      let idx = 0;
      while (idx < nlen + ndist) {
        const sym = decode(clTable);
        if (eof || sym < 0) return null;
        if (sym < 16) {
          lengths[idx++] = sym;
        } else {
          let prev = 0;
          let rep: number;
          if (sym === 16) {
            if (idx === 0) return null;
            prev = lengths[idx - 1]!;
            rep = 3 + bits(2);
          } else if (sym === 17) {
            rep = 3 + bits(3);
          } else {
            rep = 11 + bits(7);
          }
          if (eof || idx + rep > nlen + ndist) return null;
          while (rep--) lengths[idx++] = prev;
        }
      }
      if (lengths[256] === 0) return null;
      const lit = buildHuffman(lengths.subarray(0, nlen), nlen);
      const dist = buildHuffman(lengths.subarray(nlen), ndist);
      if (!lit || !dist || !codes(lit, dist)) return null;
    } else {
      return null;
    }
    if (final) break;
  }
  return { end: pos, size };
}

// ---------------------------------------------------------------------------------------
// Per-format hooks
// ---------------------------------------------------------------------------------------

const isAlpha = (c: number | undefined) =>
  c !== undefined && ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a));

// ---- PNG ----

function pngValid(b: Uint8Array, s: number): boolean {
  return has(b, s, 33) && u32be(b, s + 8) === 13 && asciiAt(b, s + 12, 4) === 'IHDR';
}

function pngEnd(b: Uint8Array, s: number): number | null {
  let p = s + 8;
  while (p + 12 <= b.length) {
    const len = u32be(b, p);
    if (len > 0x7fffffff || !isAlpha(b[p + 4]) || !isAlpha(b[p + 5]) || !isAlpha(b[p + 6])) break;
    if (!isAlpha(b[p + 7])) break;
    const next = p + 12 + len;
    if (asciiAt(b, p + 4, 4) === 'IEND') return next <= b.length ? next : null;
    if (next > b.length) break;
    p = next;
  }
  // Chunk lengths are damaged (a classic CTF trick): fall back to the fixed IEND chunk bytes.
  const i = indexOfAscii(b, 'IEND\xae\x42\x60\x82', s + 8);
  return i >= 0 ? i + 8 : null;
}

// ---- JPEG ----

function jpegValid(b: Uint8Array, s: number): boolean {
  if (!has(b, s, 6)) return false;
  const m = b[s + 3]!;
  if (m < 0xc0 || m === 0xff || (m >= 0xd0 && m <= 0xd9)) return false;
  const len = u16be(b, s + 4);
  if (len < 2) return false;
  return !has(b, s + 4 + len, 1) || b[s + 4 + len] === 0xff;
}

function jpegEnd(b: Uint8Array, s: number): number | null {
  let p = s + 2;
  while (p + 1 < b.length) {
    if (b[p] !== 0xff) return null;
    const m = b[p + 1]!;
    if (m === 0xff) {
      p++;
      continue;
    }
    if (m === 0xd9) return p + 2;
    if (m === 0x00) return null;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      p += 2;
      continue;
    }
    if (p + 4 > b.length) return null;
    const len = u16be(b, p + 2);
    if (len < 2) return null;
    p += 2 + len;
    if (m === 0xda) {
      // Entropy-coded data: runs until a marker that is not a stuffed 0xFF00 or an RSTn.
      while (p + 1 < b.length) {
        if (b[p] === 0xff) {
          const n = b[p + 1]!;
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
            p += 2;
            continue;
          }
          if (n === 0xff) {
            p++;
            continue;
          }
          break;
        }
        p++;
      }
    }
  }
  return null;
}

// ---- GIF ----

function gifValid(b: Uint8Array, s: number): boolean {
  return (
    has(b, s, 13) &&
    (b[s + 4] === 0x37 || b[s + 4] === 0x39) &&
    b[s + 5] === 0x61 &&
    u16le(b, s + 6) > 0 &&
    u16le(b, s + 8) > 0
  );
}

/** Skip data sub-blocks starting at p; returns the offset after the terminating 0, or -1. */
function skipSubBlocks(b: Uint8Array, p: number): number {
  while (p < b.length) {
    const n = b[p]!;
    p += 1 + n;
    if (n === 0) return p;
  }
  return -1;
}

function gifEnd(b: Uint8Array, s: number): number | null {
  let p = s + 13;
  const flags = b[s + 10]!;
  if (flags & 0x80) p += 3 << ((flags & 7) + 1);
  while (p < b.length) {
    const t = b[p]!;
    if (t === 0x3b) return p + 1;
    if (t === 0x21) {
      p = skipSubBlocks(b, p + 2);
    } else if (t === 0x2c) {
      if (p + 10 > b.length) return null;
      const f = b[p + 9]!;
      p += 10;
      if (f & 0x80) p += 3 << ((f & 7) + 1);
      p = skipSubBlocks(b, p + 1);
    } else {
      return null;
    }
    if (p < 0) return null;
  }
  return null;
}

// ---- BMP ----

function bmpValid(b: Uint8Array, s: number): boolean {
  if (!has(b, s, 30)) return false;
  const size = u32le(b, s + 2);
  const dib = u32le(b, s + 14);
  const pixels = u32le(b, s + 10);
  return (
    size >= 26 &&
    [12, 40, 52, 56, 64, 108, 124].includes(dib) &&
    pixels >= 14 + dib &&
    pixels <= size
  );
}

function bmpEnd(b: Uint8Array, s: number): number | null {
  return s + u32le(b, s + 2);
}

// ---- RIFF (WAV / AVI / WebP) ----

function riffValid(b: Uint8Array, s: number, chunks: string[]): boolean {
  return has(b, s, 20) && u32le(b, s + 4) >= 12 && chunks.includes(asciiAt(b, s + 12, 4));
}

function riffEnd(b: Uint8Array, s: number): number | null {
  const size = u32le(b, s + 4);
  return s + 8 + size + (size & 1);
}

// ---- TIFF ----

function tiffValid(b: Uint8Array, s: number, little: boolean): boolean {
  if (!has(b, s, 8)) return false;
  const ifd = little ? u32le(b, s + 4) : u32be(b, s + 4);
  if (ifd < 8 || ifd > 0x4000000) return false;
  if (!has(b, s + ifd, 2)) return true;
  const entries = little ? u16le(b, s + ifd) : u16be(b, s + ifd);
  return entries >= 1 && entries <= 1000;
}

// ---- MP4 / HEIC / AVIF ----

const MP4_BOXES = new Set([
  'ftyp',
  'moov',
  'mdat',
  'free',
  'skip',
  'wide',
  'pnot',
  'uuid',
  'moof',
  'mfra',
  'sidx',
  'styp',
  'meta',
  'junk',
  'pdin',
  'prft',
]);

function mp4Valid(b: Uint8Array, s: number): boolean {
  const size = u32be(b, s);
  return has(b, s, 12) && size >= 16 && size <= 512 && size % 4 === 0;
}

function mp4End(b: Uint8Array, s: number): number | null {
  let p = s;
  let boxes = 0;
  while (has(b, p, 8)) {
    let size = u32be(b, p);
    if (!MP4_BOXES.has(asciiAt(b, p + 4, 4))) break;
    if (size === 1) {
      if (!has(b, p, 16) || u32be(b, p + 8) !== 0) break;
      size = u32be(b, p + 12);
    } else if (size === 0) {
      return b.length;
    }
    if (size < 8) break;
    p += size;
    boxes++;
  }
  return boxes >= 2 ? p : null;
}

// ---- PDF ----

function pdfEnd(b: Uint8Array, s: number): number | null {
  const next = indexOfAscii(b, '%PDF-', s + 5);
  const lastEof = (limit: number): number => {
    let last = -1;
    for (
      let i = indexOfAscii(b, '%%EOF', s);
      i >= 0 && i < limit;
      i = indexOfAscii(b, '%%EOF', i + 5)
    ) {
      last = i;
    }
    return last;
  };
  let last = lastEof(next > 0 ? next : b.length);
  if (last < 0 && next > 0) last = lastEof(b.length);
  if (last < 0) return null;
  let e = last + 5;
  if (b[e] === 0x0d) e++;
  if (b[e] === 0x0a) e++;
  return e;
}

// ---- ZIP ----

const ZIP_METHODS = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 14, 18, 19, 93, 95, 96, 97, 98, 99];

function zipValid(b: Uint8Array, s: number): boolean {
  if (!has(b, s, 30)) return false;
  const nameLen = u16le(b, s + 26);
  if (u16le(b, s + 4) > 63 || !ZIP_METHODS.includes(u16le(b, s + 8)) || nameLen === 0) return false;
  for (let i = 0; i < Math.min(nameLen, 12) && s + 30 + i < b.length; i++) {
    const c = b[s + 30 + i]!;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP_KNOWN = [ZIP_LOCAL, ZIP_CENTRAL, ZIP_EOCD, 0x06064b50, 0x07064b50, 0x05054b50];

/**
 * End of the ZIP whose first local header is at `s`: walk local headers by their sizes, then
 * the central directory, up to the end-of-central-directory record plus its comment. This
 * does not depend on the (prefix-relative) offsets stored in the archive, so it also works
 * for a ZIP appended to another file.
 */
function zipEnd(b: Uint8Array, s: number): number | null {
  let p = s;
  for (let guard = 0; guard < 2_000_000; guard++) {
    if (!has(b, p, 4)) return null;
    const sig = u32le(b, p);
    if (sig === ZIP_LOCAL) {
      if (!has(b, p, 30)) return null;
      const flags = u16le(b, p + 6);
      let csize = u32le(b, p + 18);
      const nameLen = u16le(b, p + 26);
      const extraLen = u16le(b, p + 28);
      const dataStart = p + 30 + nameLen + extraLen;
      if (dataStart > b.length) return null;
      if (csize === 0xffffffff) {
        // ZIP64: the real sizes are in extra field 0x0001 (uncompressed first, then compressed).
        for (let e = p + 30 + nameLen; e + 4 <= dataStart;) {
          const id = u16le(b, e);
          const len = u16le(b, e + 2);
          if (id === 1 && len >= 16) csize = u64le(b, e + 12);
          e += 4 + len;
        }
      }
      if (flags & 8 && csize === 0) {
        // Sizes live in a data descriptor after the data: look for the next record.
        let q = dataStart;
        let found = -1;
        for (; q + 4 <= b.length; q++) {
          if (b[q] !== 0x50 || b[q + 1] !== 0x4b) continue;
          const t = u16le(b, q + 2);
          if (t === 0x0403 || t === 0x0201 || t === 0x0807) {
            found = q;
            break;
          }
        }
        if (found < 0) return null;
        p = u32le(b, found) === 0x08074b50 ? found + 16 : found;
      } else {
        p = dataStart + csize;
        if (flags & 8) {
          // Data descriptor (with or without its signature, 32 or 64-bit sizes).
          const candidates = u32le(b, p) === 0x08074b50 ? [p + 16, p + 24] : [p + 12, p + 20, p];
          p =
            candidates.find((c) => has(b, c, 4) && ZIP_KNOWN.includes(u32le(b, c))) ??
            candidates[0]!;
        }
      }
    } else if (sig === ZIP_CENTRAL) {
      if (!has(b, p, 46)) return null;
      p += 46 + u16le(b, p + 28) + u16le(b, p + 30) + u16le(b, p + 32);
    } else if (sig === 0x06064b50) {
      p += 12 + u64le(b, p + 4);
    } else if (sig === 0x07064b50) {
      p += 20;
    } else if (sig === 0x05054b50) {
      p += 6 + u16le(b, p + 4);
    } else if (sig === ZIP_EOCD) {
      return has(b, p, 22) ? p + 22 + u16le(b, p + 20) : null;
    } else {
      return null;
    }
  }
  return null;
}

// ---- 7z ----

function sevenZipValid(b: Uint8Array, s: number): boolean {
  return has(b, s, 32) && b[s + 6] === 0 && crc32(b.subarray(s + 12, s + 32)) === u32le(b, s + 8);
}

function sevenZipEnd(b: Uint8Array, s: number): number | null {
  if (!has(b, s, 32)) return null;
  const off = u64le(b, s + 12);
  const size = u64le(b, s + 20);
  return s + 32 + off + size;
}

// ---- GZIP / zlib ----

let scanMemo: { b: Uint8Array; start: number; res: DeflateScan | null } | null = null;

/** Deflate scan of the gzip member at `s` (header sanity first); memoised for valid()+end(). */
function gzipScan(b: Uint8Array, s: number): DeflateScan | null {
  if (scanMemo && scanMemo.b === b && scanMemo.start === s) return scanMemo.res;
  let res: DeflateScan | null = null;
  if (has(b, s, 18) && b[s] === 0x1f && b[s + 1] === 0x8b && b[s + 2] === 8) {
    const flg = b[s + 3]!;
    const xfl = b[s + 8]!;
    const os = b[s + 9]!;
    if (!(flg & 0xe0) && (xfl === 0 || xfl === 2 || xfl === 4) && (os <= 13 || os === 255)) {
      let p = s + 10;
      if (flg & 4) p += 2 + u16le(b, p);
      if (flg & 8) {
        while (p < b.length && b[p] !== 0) p++;
        p++;
      }
      if (flg & 16) {
        while (p < b.length && b[p] !== 0) p++;
        p++;
      }
      if (flg & 2) p += 2;
      if (p < b.length) res = deflateScan(b, p);
    }
  }
  scanMemo = { b, start: s, res };
  return res;
}

function gzipEnd(b: Uint8Array, s: number): number | null {
  const scan = gzipScan(b, s);
  return scan ? scan.end + 8 : null;
}

function zlibScan(b: Uint8Array, s: number): DeflateScan | null {
  const cmf = b[s] ?? 0;
  const flg = b[s + 1] ?? 0;
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) {
    return null;
  }
  return deflateScan(b, s + 2);
}

function inflateRaw(data: Uint8Array): Uint8Array | null {
  try {
    return inflateSync(data);
  } catch {
    return null;
  }
}

/** A zlib stream is accepted only if its Adler-32 matches, which random data never does. */
function zlibValid(b: Uint8Array, s: number): boolean {
  const scan = zlibScan(b, s);
  if (!scan || scan.size < 4 || !has(b, scan.end, 4)) return false;
  const out = inflateRaw(b.subarray(s + 2, scan.end));
  return out !== null && adler32(out) === u32be(b, scan.end);
}

function zlibEnd(b: Uint8Array, s: number): number | null {
  const scan = zlibScan(b, s);
  return scan ? scan.end + 4 : null;
}

// ---- TAR ----

function tarOctal(b: Uint8Array, o: number, n: number): number {
  let v = 0;
  let seen = false;
  for (let i = o; i < o + n; i++) {
    const c = b[i]!;
    if (c >= 0x30 && c <= 0x37) {
      v = v * 8 + (c - 0x30);
      seen = true;
    } else if (seen || (c !== 0x20 && c !== 0)) break;
  }
  return seen ? v : 0;
}

/** True if the 512 bytes at `p` are a TAR header with a correct checksum. */
export function tarHeaderValid(b: Uint8Array, p: number): boolean {
  if (!has(b, p, 512)) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : b[p + i]!;
  return sum !== 256 && tarOctal(b, p + 148, 8) === sum;
}

const isZeroBlock = (b: Uint8Array, p: number) => {
  for (let i = 0; i < 512; i++) if (b[p + i] !== 0) return false;
  return true;
};

function tarEnd(b: Uint8Array, s: number): number | null {
  let p = s;
  let entries = 0;
  while (has(b, p, 512)) {
    if (isZeroBlock(b, p)) {
      if (!has(b, p + 512, 512) || !isZeroBlock(b, p + 512)) return p + 512;
      // GNU tar pads the archive with zeros to a whole number of 10240-byte records.
      const end = p + 1024;
      const record = s + Math.ceil((end - s) / 10240) * 10240;
      if (record > end && record <= b.length) {
        for (let i = end; i < record; i++) if (b[i] !== 0) return end;
        return record;
      }
      return end;
    }
    if (!tarHeaderValid(b, p)) break;
    const type = b[p + 156]!;
    // Hard links, symlinks, devices, directories and FIFOs carry no data blocks.
    const size = type >= 0x31 && type <= 0x36 ? 0 : tarOctal(b, p + 124, 12);
    p += 512 + Math.ceil(size / 512) * 512;
    entries++;
  }
  return entries > 0 ? p : null;
}

// ---- XZ / BZIP2 / Matroska ----

/** XZ ends with a 12-byte footer: CRC-32, backward size, the stream flags again, "YZ". */
function xzEnd(b: Uint8Array, s: number): number | null {
  for (let i = indexOfAscii(b, 'YZ', s + 22); i >= 0; i = indexOfAscii(b, 'YZ', i + 1)) {
    const footer = i - 10;
    if (b[i - 2] !== b[s + 6] || b[i - 1] !== b[s + 7]) continue;
    if (crc32(b.subarray(footer + 4, footer + 10)) === u32le(b, footer)) return i + 2;
  }
  return null;
}

const BZIP2_END_MAGIC = 0x177245385090;

/**
 * BZIP2 ends with a 48-bit marker (0x177245385090) that is not byte-aligned, then a 32-bit
 * CRC and padding to a whole byte: try all eight bit alignments.
 */
function bzip2End(b: Uint8Array, s: number): number | null {
  for (let i = s + 4; i + 7 <= b.length; i++) {
    const hi = b[i]! * 256 + b[i + 1]!;
    const lo = ((b[i + 2]! << 24) | (b[i + 3]! << 16) | (b[i + 4]! << 8) | b[i + 5]!) >>> 0;
    const window = hi * 4294967296 + lo;
    for (let k = 0; k < 8; k++) {
      const value = k === 0 ? window : (window % 2 ** (48 - k)) * 2 ** k + (b[i + 6]! >> (8 - k));
      if (value === BZIP2_END_MAGIC) return i + 10 + (k > 0 ? 1 : 0);
    }
  }
  return null;
}

/** An EBML variable-length integer; `unknown` when every value bit is set (live streams). */
function ebmlVint(
  b: Uint8Array,
  o: number,
): { len: number; value: number; unknown: boolean } | null {
  const first = b[o];
  if (!first) return null;
  let len = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    len++;
    mask >>= 1;
  }
  let value = first & (mask - 1);
  let ones = value === mask - 1;
  for (let i = 1; i < len; i++) {
    const x = b[o + i] ?? 0;
    value = value * 256 + x;
    if (x !== 0xff) ones = false;
  }
  return { len, value, unknown: ones };
}

/** EBML header element, then one Segment element whose size covers the rest of the file. */
function mkvEnd(b: Uint8Array, s: number): number | null {
  const header = ebmlVint(b, s + 4);
  if (!header || header.unknown) return null;
  const segment = s + 4 + header.len + header.value;
  if (u32be(b, segment) !== 0x18538067) return null;
  const size = ebmlVint(b, segment + 4);
  if (!size || size.unknown) return null;
  return segment + 4 + size.len + size.value;
}

// ---- ar (.deb) ----

function arEnd(b: Uint8Array, s: number): number | null {
  let p = s + 8;
  let members = 0;
  while (has(b, p, 60) && b[p + 58] === 0x60 && b[p + 59] === 0x0a) {
    const size = parseInt(asciiAt(b, p + 48, 10).trim(), 10);
    if (!Number.isFinite(size)) break;
    p += 60 + size + (size & 1);
    members++;
  }
  return members > 0 ? p : null;
}

// ---- ELF ----

function elfEnd(b: Uint8Array, s: number): number | null {
  if (!has(b, s, 52) || b[s + 6] !== 1) return null;
  const cls = b[s + 4];
  const little = b[s + 5] === 1;
  if ((cls !== 1 && cls !== 2) || (!little && b[s + 5] !== 2)) return null;
  const is64 = cls === 2;
  if (is64 && !has(b, s, 64)) return null;
  const r16 = (o: number) => (little ? u16le(b, s + o) : u16be(b, s + o));
  const r32 = (o: number) => (little ? u32le(b, s + o) : u32be(b, s + o));
  const rw = (o: number) => {
    // address/offset-sized field; 64-bit values above 2^32 are not plausible inside a buffer
    if (!is64) return r32(o);
    const lo = little ? r32(o) : r32(o + 4);
    const hi = little ? r32(o + 4) : r32(o);
    return hi === 0 ? lo : Number.POSITIVE_INFINITY;
  };
  const type = r16(16);
  if (type < 1 || type > 4) return null;
  const phoff = is64 ? rw(32) : r32(28);
  const shoff = is64 ? rw(40) : r32(32);
  const phentsize = r16(is64 ? 54 : 42);
  const phnum = r16(is64 ? 56 : 44);
  const shentsize = r16(is64 ? 58 : 46);
  const shnum = r16(is64 ? 60 : 48);
  if (
    (phnum > 0 && phentsize !== (is64 ? 56 : 32)) ||
    (shnum > 0 && shentsize !== (is64 ? 64 : 40))
  ) {
    return null;
  }
  if (phnum === 0 && shnum === 0) return null;
  let end = is64 ? 64 : 52;
  const field = (base: number, o: number) => {
    if (!is64) return little ? u32le(b, base + o) : u32be(b, base + o);
    const lo = little ? u32le(b, base + o) : u32be(b, base + o + 4);
    const hi = little ? u32le(b, base + o + 4) : u32be(b, base + o);
    return hi === 0 ? lo : Number.POSITIVE_INFINITY;
  };
  if (phnum > 0 && Number.isFinite(phoff)) {
    end = Math.max(end, phoff + phnum * phentsize);
    for (let i = 0; i < phnum; i++) {
      const ph = s + phoff + i * phentsize;
      if (!has(b, ph, phentsize)) break;
      const off = is64 ? field(ph, 8) : field(ph, 4);
      const filesz = is64 ? field(ph, 32) : field(ph, 16);
      if (Number.isFinite(off + filesz)) end = Math.max(end, off + filesz);
    }
  }
  if (shnum > 0 && Number.isFinite(shoff)) {
    end = Math.max(end, shoff + shnum * shentsize);
    for (let i = 0; i < shnum; i++) {
      const sh = s + shoff + i * shentsize;
      if (!has(b, sh, shentsize)) break;
      const shType = little ? u32le(b, sh + 4) : u32be(b, sh + 4);
      if (shType === 0 || shType === 8) continue;
      const off = is64 ? field(sh, 24) : field(sh, 16);
      const size = is64 ? field(sh, 32) : field(sh, 20);
      if (Number.isFinite(off + size)) end = Math.max(end, off + size);
    }
  }
  return Number.isFinite(end) ? s + end : null;
}

// ---- Mach-O ----

function machoValid(b: Uint8Array, s: number): boolean {
  const fileType = u32le(b, s + 12);
  const ncmds = u32le(b, s + 16);
  return has(b, s, 28) && fileType >= 1 && fileType <= 12 && ncmds >= 1 && ncmds <= 2000;
}

// ---- PE ----

function peEnd(b: Uint8Array, s: number): number | null {
  if (!has(b, s, 0x40) || b[s] !== 0x4d || b[s + 1] !== 0x5a) return null;
  const lfanew = u32le(b, s + 0x3c);
  if (lfanew < 0x40 || lfanew > 0x1000) return null;
  const pe = s + lfanew;
  if (!has(b, pe, 24 + 96) || u32le(b, pe) !== 0x4550) return null;
  const sections = u16le(b, pe + 6);
  const optSize = u16le(b, pe + 20);
  const opt = pe + 24;
  const magic = u16le(b, opt);
  if (sections === 0 || sections > 96 || (magic !== 0x10b && magic !== 0x20b)) return null;
  if (optSize < (magic === 0x10b ? 96 : 112)) return null;
  const table = opt + optSize;
  let end = Math.max(table + sections * 40 - s, u32le(b, opt + 60));
  for (let i = 0; i < sections; i++) {
    const sec = table + i * 40;
    if (!has(b, sec, 40)) break;
    const size = u32le(b, sec + 16);
    const raw = u32le(b, sec + 20);
    if (size > 0 && raw > 0) end = Math.max(end, raw + size);
  }
  // Authenticode certificate table: a file offset, sits after the last section.
  const dirs = opt + (magic === 0x10b ? 96 : 112);
  if (optSize >= dirs - opt + 40 && has(b, dirs, 40)) {
    const certOff = u32le(b, dirs + 32);
    const certSize = u32le(b, dirs + 36);
    if (certOff > 0 && certSize > 0) end = Math.max(end, certOff + certSize);
  }
  return s + end;
}

// ---- SQLite ----

function sqlitePageSize(b: Uint8Array, s: number): number | null {
  if (!has(b, s, 100)) return null;
  const raw = u16be(b, s + 16);
  const size = raw === 1 ? 65536 : raw;
  if (size < 512 || size > 65536 || (size & (size - 1)) !== 0) return null;
  return u32be(b, s + 56) <= 3 ? size : null;
}

function sqliteEnd(b: Uint8Array, s: number): number | null {
  const size = sqlitePageSize(b, s);
  const pages = u32be(b, s + 28);
  // The page count is only trustworthy when "version-valid-for" matches the change counter.
  if (size === null || pages === 0 || u32be(b, s + 24) !== u32be(b, s + 92)) return null;
  return s + size * pages;
}

// ---- Ogg ----

function oggEnd(b: Uint8Array, s: number): number | null {
  let p = s;
  let pages = 0;
  while (has(b, p, 27) && asciiAt(b, p, 4) === 'OggS') {
    const segments = b[p + 26]!;
    if (!has(b, p, 27 + segments)) break;
    let body = 0;
    for (let i = 0; i < segments; i++) body += b[p + 27 + i]!;
    p += 27 + segments + body;
    pages++;
  }
  return pages > 0 ? p : null;
}

// ---- PEM / PGP armor / OpenSSH key ----

function pemEnd(b: Uint8Array, s: number): number | null {
  const end = indexOfAscii(b, '-----END ', s);
  if (end < 0) return null;
  const close = indexOfAscii(b, '-----', end + 9);
  if (close < 0) return null;
  let e = close + 5;
  if (b[e] === 0x0d) e++;
  if (b[e] === 0x0a) e++;
  return e;
}
