/**
 * Magic-byte signature database, shared by "File type" (offset 0) and "Carve" (every offset).
 * `magic` uses null as a wildcard byte. `end` (optional) returns the exclusive end offset of
 * the embedded file starting at `start`, used for precise carving.
 */

export interface Signature {
  id: string;
  name: string;
  ext: string;
  mime?: string;
  magic: (number | null)[];
  /** Where the magic sits relative to the file start (TAR: 257, ISO: 0x8001). */
  offset?: number;
  /** Weak signatures (short / text) are only used for whole-file identification, not carving. */
  weak?: boolean;
  end?: (b: Uint8Array, start: number) => number | null;
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
  },
  { id: 'jpeg', name: 'JPEG image', ext: 'jpg', mime: 'image/jpeg', magic: hex('ff d8 ff') },
  { id: 'gif', name: 'GIF image', ext: 'gif', mime: 'image/gif', magic: ascii('GIF8') },
  {
    id: 'bmp',
    name: 'BMP image',
    ext: 'bmp',
    mime: 'image/bmp',
    magic: hex('42 4d ?? ?? ?? ?? 00 00 00 00'),
  },
  {
    id: 'webp',
    name: 'WebP image',
    ext: 'webp',
    mime: 'image/webp',
    magic: [...ascii('RIFF'), null, null, null, null, ...ascii('WEBP')],
  },
  {
    id: 'tiff-le',
    name: 'TIFF image (little-endian)',
    ext: 'tif',
    mime: 'image/tiff',
    magic: hex('49 49 2a 00'),
  },
  {
    id: 'tiff-be',
    name: 'TIFF image (big-endian)',
    ext: 'tif',
    mime: 'image/tiff',
    magic: hex('4d 4d 00 2a'),
  },
  {
    id: 'ico',
    name: 'Windows icon',
    ext: 'ico',
    mime: 'image/x-icon',
    magic: hex('00 00 01 00'),
    weak: true,
  },
  { id: 'psd', name: 'Photoshop document', ext: 'psd', magic: ascii('8BPS') },
  {
    id: 'heic',
    name: 'HEIC/AVIF image',
    ext: 'heic',
    magic: [null, null, null, null, ...ascii('ftypheic')],
  },
  {
    id: 'avif',
    name: 'AVIF image',
    ext: 'avif',
    magic: [null, null, null, null, ...ascii('ftypavif')],
  },
  { id: 'jxl', name: 'JPEG XL image', ext: 'jxl', magic: hex('ff 0a'), weak: true },
  { id: 'qoi', name: 'QOI image', ext: 'qoi', magic: ascii('qoif') },
  // documents
  { id: 'pdf', name: 'PDF document', ext: 'pdf', mime: 'application/pdf', magic: ascii('%PDF-') },
  {
    id: 'ole',
    name: 'MS Office 97-2003 / OLE (doc, xls, msi)',
    ext: 'doc',
    magic: hex('d0 cf 11 e0 a1 b1 1a e1'),
  },
  { id: 'rtf', name: 'Rich Text Format', ext: 'rtf', magic: ascii('{\\rtf') },
  { id: 'ps', name: 'PostScript', ext: 'ps', magic: ascii('%!PS') },
  { id: 'djvu', name: 'DjVu document', ext: 'djvu', magic: ascii('AT&TFORM') },
  // archives / compression
  {
    id: 'zip',
    name: 'ZIP archive (also docx, xlsx, jar, apk, odt)',
    ext: 'zip',
    mime: 'application/zip',
    magic: hex('50 4b 03 04'),
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
  { id: '7z', name: '7-Zip archive', ext: '7z', magic: hex('37 7a bc af 27 1c') },
  {
    id: 'gzip',
    name: 'GZIP compressed',
    ext: 'gz',
    mime: 'application/gzip',
    magic: hex('1f 8b 08'),
  },
  {
    id: 'bzip2',
    name: 'BZIP2 compressed',
    ext: 'bz2',
    magic: hex('42 5a 68 ?? 31 41 59 26 53 59'),
  },
  { id: 'xz', name: 'XZ compressed', ext: 'xz', magic: hex('fd 37 7a 58 5a 00') },
  { id: 'zstd', name: 'Zstandard compressed', ext: 'zst', magic: hex('28 b5 2f fd') },
  { id: 'lz4', name: 'LZ4 frame', ext: 'lz4', magic: hex('04 22 4d 18') },
  {
    id: 'lzma',
    name: 'LZMA (legacy .lzma)',
    ext: 'lzma',
    magic: hex('5d 00 00 ?? ?? ?? ?? ?? ?? ?? ?? ?? ??'),
    weak: true,
  },
  { id: 'tar', name: 'TAR archive', ext: 'tar', offset: 257, magic: ascii('ustar') },
  { id: 'cab', name: 'Microsoft Cabinet', ext: 'cab', magic: ascii('MSCF') },
  { id: 'arj', name: 'ARJ archive', ext: 'arj', magic: hex('60 ea'), weak: true },
  { id: 'cpio', name: 'CPIO archive', ext: 'cpio', magic: ascii('070701') },
  { id: 'deb', name: 'Debian package / ar archive', ext: 'deb', magic: ascii('!<arch>\n') },
  { id: 'rpm', name: 'RPM package', ext: 'rpm', magic: hex('ed ab ee db') },
  { id: 'zlib', name: 'zlib stream', ext: 'zlib', magic: hex('78 9c'), weak: true },
  // executables / bytecode
  { id: 'elf', name: 'ELF executable', ext: 'elf', magic: hex('7f 45 4c 46') },
  {
    id: 'pe',
    name: 'Windows PE / DOS executable (MZ)',
    ext: 'exe',
    magic: ascii('MZ'),
    weak: true,
  },
  { id: 'macho32', name: 'Mach-O 32-bit', ext: 'macho', magic: hex('ce fa ed fe') },
  { id: 'macho64', name: 'Mach-O 64-bit', ext: 'macho', magic: hex('cf fa ed fe') },
  {
    id: 'java-class',
    name: 'Java class / Mach-O fat binary',
    ext: 'class',
    magic: hex('ca fe ba be'),
  },
  { id: 'dex', name: 'Android DEX', ext: 'dex', magic: ascii('dex\n') },
  { id: 'wasm', name: 'WebAssembly module', ext: 'wasm', magic: hex('00 61 73 6d') },
  { id: 'luac', name: 'Lua bytecode', ext: 'luac', magic: hex('1b 4c 75 61') },
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
  },
  {
    id: 'avi',
    name: 'AVI video',
    ext: 'avi',
    magic: [...ascii('RIFF'), null, null, null, null, ...ascii('AVI ')],
  },
  {
    id: 'mp3-id3',
    name: 'MP3 audio (ID3 tag)',
    ext: 'mp3',
    mime: 'audio/mpeg',
    magic: ascii('ID3'),
  },
  {
    id: 'mp3',
    name: 'MP3 audio (frame sync)',
    ext: 'mp3',
    mime: 'audio/mpeg',
    magic: hex('ff fb'),
    weak: true,
  },
  { id: 'ogg', name: 'OGG container', ext: 'ogg', mime: 'audio/ogg', magic: ascii('OggS') },
  { id: 'flac', name: 'FLAC audio', ext: 'flac', mime: 'audio/flac', magic: ascii('fLaC') },
  { id: 'midi', name: 'MIDI', ext: 'mid', magic: ascii('MThd') },
  {
    id: 'aiff',
    name: 'AIFF audio',
    ext: 'aiff',
    magic: [...ascii('FORM'), null, null, null, null, ...ascii('AIFF')],
  },
  {
    id: 'mp4',
    name: 'MP4 / MOV / M4A',
    ext: 'mp4',
    mime: 'video/mp4',
    magic: [null, null, null, null, ...ascii('ftyp')],
  },
  { id: 'mkv', name: 'Matroska / WebM', ext: 'mkv', magic: hex('1a 45 df a3') },
  { id: 'flv', name: 'Flash video', ext: 'flv', magic: ascii('FLV') },
  // data / forensics
  { id: 'sqlite', name: 'SQLite database', ext: 'sqlite', magic: ascii('SQLite format 3\0') },
  { id: 'pcap', name: 'PCAP capture', ext: 'pcap', magic: hex('d4 c3 b2 a1') },
  { id: 'pcap-be', name: 'PCAP capture (big-endian)', ext: 'pcap', magic: hex('a1 b2 c3 d4') },
  { id: 'pcap-ns', name: 'PCAP capture (nanosecond)', ext: 'pcap', magic: hex('4d 3c b2 a1') },
  { id: 'pcapng', name: 'PCAPNG capture', ext: 'pcapng', magic: hex('0a 0d 0d 0a') },
  { id: 'regf', name: 'Windows registry hive', ext: 'dat', magic: ascii('regf') },
  { id: 'evtx', name: 'Windows event log (EVTX)', ext: 'evtx', magic: ascii('ElfFile\0') },
  { id: 'lnk', name: 'Windows shortcut (LNK)', ext: 'lnk', magic: hex('4c 00 00 00 01 14 02 00') },
  { id: 'kdbx', name: 'KeePass database', ext: 'kdbx', magic: hex('03 d9 a2 9a') },
  { id: 'luks', name: 'LUKS encrypted volume', ext: 'luks', magic: hex('4c 55 4b 53 ba be') },
  { id: 'iso', name: 'ISO 9660 disk image', ext: 'iso', offset: 0x8001, magic: ascii('CD001') },
  { id: 'vmdk', name: 'VMware disk (VMDK)', ext: 'vmdk', magic: ascii('KDMV') },
  { id: 'qcow', name: 'QEMU disk (qcow)', ext: 'qcow2', magic: hex('51 46 49 fb') },
  { id: 'vhdx', name: 'Hyper-V disk (VHDX)', ext: 'vhdx', magic: ascii('vhdxfile') },
  {
    id: 'ext',
    name: 'ext2/3/4 filesystem',
    ext: 'img',
    offset: 1080,
    magic: hex('53 ef'),
    weak: true,
  },
  { id: 'ntfs', name: 'NTFS boot sector', ext: 'img', offset: 3, magic: ascii('NTFS    ') },
  { id: 'fat', name: 'FAT boot sector', ext: 'img', offset: 54, magic: ascii('FAT'), weak: true },
  {
    id: 'dsstore',
    name: 'macOS .DS_Store',
    ext: 'DS_Store',
    magic: hex('00 00 00 01 42 75 64 31'),
  },
  { id: 'git-pack', name: 'Git pack file', ext: 'pack', magic: ascii('PACK') },
  { id: 'pgp-armor', name: 'PGP armored block', ext: 'asc', magic: ascii('-----BEGIN PGP') },
  {
    id: 'ssh-key',
    name: 'OpenSSH private key',
    ext: 'key',
    magic: ascii('-----BEGIN OPENSSH PRIVATE KEY'),
  },
  { id: 'pem', name: 'PEM block (certificate / key)', ext: 'pem', magic: ascii('-----BEGIN ') },
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
