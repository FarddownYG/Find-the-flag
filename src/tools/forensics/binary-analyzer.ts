import { bool, defineTool, file, number, select, text, toggle } from '../../core/define';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { identify } from '../../lib/signatures';
import { hexView, stringsView } from './_binary-hex';
import { HEAD } from './_binary-identify';
import { diskView } from './_binary-disk';
import { DTYPES, numericView, type DType } from './_binary-numeric';
import { carveView, entropyView, overviewView } from './_binary-overview';
import { detectCd } from './_cd';
import { hasPartitionTable, parseBpb } from './_fat';
import { shannon } from './entropy';

const T = toolT('binary-analyzer');

const isView = (v: Record<string, unknown>, ...views: string[]) => views.includes(String(v.view));
const DTYPE_CHOICES = Object.keys(DTYPES) as DType[];

export default defineTool({
  id: 'binary-analyzer',
  name: 'Binary analyzer (.bin, disk images, unknown files)',
  category: 'forensics',
  description:
    'Identify an unknown binary or disk image (a BIN without its CUE, ISO, FAT), carve the files hidden in it, list and extract the files of the disk, or read it as numbers. Big files are read in pieces.',
  tags: [
    'bin',
    'cue',
    'bin/cue',
    'iso',
    'iso9660',
    'disk image',
    'cd image',
    'raw',
    'img',
    'fat',
    'fat12',
    'mbr',
    'deleted files',
    'binwalk',
    'foremost',
    'unknown file',
    'numpy fromfile',
    'envi',
  ],
  input: 'file',
  // Switching views re-runs at once; a run still in progress is cancelled (the worker is
  // replaced), so typing in Search or Filter never queues whole-file scans.
  live: true,
  placeholder:
    'Drop a .bin, .iso, .img or any unknown file: it is read in pieces and never leaves the browser.',
  options: {
    view: select(
      'View',
      [
        { value: 'overview', label: 'Overview' },
        { value: 'hex', label: 'Hexdump' },
        { value: 'strings', label: 'Strings' },
        { value: 'carve', label: 'Carving' },
        { value: 'disk', label: 'Disk image' },
        { value: 'numeric', label: 'Numeric' },
        { value: 'entropy', label: 'Entropy' },
      ],
      'overview',
    ),
    offset: text('Offset', '0', {
      placeholder: '0, 0x8000, 32k, -512 (from the end)',
      showIf: (v) => isView(v, 'hex', 'numeric'),
    }),
    length: text('Length', '4096', {
      placeholder: '4096, 0x1000, 64k (1 MiB at most)',
      showIf: (v) => isView(v, 'hex'),
    }),
    search: text('Search', '', {
      placeholder: 'flag   ·   de ad be ef   ·   /CTF\\{.*?\\}/',
      hint: 'Text (also looked up as UTF-16), hex bytes (de ad be ef, 0xdeadbeef, \\xde\\xad; bare hex digits are looked up both as text and as bytes), or /regex/. Searches the whole file.',
      showIf: (v) => isView(v, 'hex'),
    }),
    min: number('Minimum length', 6, { min: 2, max: 200, showIf: (v) => isView(v, 'strings') }),
    filter: text('Filter', '', {
      placeholder: 'password   or   /key=\\w+/',
      hint: 'Plain text matches ignoring case; /…/ is a regular expression.',
      showIf: (v) => isView(v, 'strings'),
    }),
    container: bool('Include the container', false, {
      hint: 'Also extract the file that starts at offset 0.',
      showIf: (v) => isView(v, 'carve'),
    }),
    nested: bool('Include nested matches', false, {
      hint: 'Also list files found inside other recognised files (e.g. a PNG stored in a ZIP).',
      showIf: (v) => isView(v, 'carve'),
    }),
    types: text('Only these types', '', {
      placeholder: 'png, zip, gz … (empty = everything)',
      showIf: (v) => isView(v, 'carve'),
    }),
    rebuild: bool('Rebuild from raw sectors', false, {
      hint: 'Raw (2352-byte) CD images: copy every file and the cooked .iso out of the sectors, even beyond 64 MiB. Slower, and uses as much memory as the data.',
      showIf: (v) => isView(v, 'disk'),
    }),
    dtype: select(
      'Data type',
      DTYPE_CHOICES.map((d) => ({ value: d, label: d })),
      'float32',
      { showIf: (v) => isView(v, 'numeric') },
    ),
    endian: toggle(
      'Byte order',
      [
        { value: 'le', label: 'Little-endian' },
        { value: 'be', label: 'Big-endian' },
      ],
      'le',
      { showIf: (v) => isView(v, 'numeric') },
    ),
    count: number('Values', 0, {
      min: 0,
      hint: '0 = as many as fit (4 Mi values at most).',
      showIf: (v) => isView(v, 'numeric'),
    }),
    rows: number('Rows', 0, {
      min: 0,
      hint: '0 = no reshape.',
      showIf: (v) => isView(v, 'numeric'),
    }),
    cols: number('Columns', 0, { min: 0, showIf: (v) => isView(v, 'numeric') }),
    envi: file('ENVI .hdr', 'bytes', {
      hint: 'Optional header of an ENVI raster: sets the type, byte order, offset and shape.',
      showIf: (v) => isView(v, 'numeric'),
    }),
    band: number('Band', 1, { min: 1, showIf: (v) => isView(v, 'numeric') }),
    block: number('Block size (bytes)', 0, {
      min: 0,
      hint: '0 = automatic (about 256 blocks).',
      showIf: (v) => isView(v, 'entropy'),
    }),
    threshold: number('High-entropy threshold', 7.5, {
      min: 1,
      max: 8,
      step: 0.1,
      showIf: (v) => isView(v, 'entropy'),
    }),
  },
  examples: [
    {
      label: 'What is this .bin?',
      input: { sample: 'binary-hidden.bin' },
      expect: 'encrypted or compressed',
    },
    {
      label: 'Carve the PNG and the ZIP hidden in a .bin',
      input: { sample: 'binary-hidden.bin' },
      options: { view: 'carve' },
      expect: '00009000.zip',
    },
    {
      label: 'Raw CD image without its .cue',
      input: { sample: 'disk-ftf-raw.bin' },
      expect: 'Raw CD image, 2352-byte sectors, Mode 1',
    },
    {
      label: 'Rebuild the .cue of a raw BIN',
      input: { sample: 'disk-ftf-raw.bin' },
      options: { view: 'disk' },
      expect: 'TRACK 01 MODE1/2352',
    },
    {
      label: 'Files of an ISO 9660 image',
      input: { sample: 'disk-ftf.iso' },
      options: { view: 'disk' },
      expect: '/README.TXT',
    },
    {
      label: 'FAT12 image with a deleted file',
      input: { sample: 'disk-ftf-fat12.img' },
      options: { view: 'disk' },
      expect: '/old-secret.txt',
    },
    {
      label: 'Volume descriptor in hex',
      input: { sample: 'disk-ftf.iso' },
      options: { view: 'hex', offset: '0x8000', length: '64' },
      expect: '.CD001.',
    },
    {
      label: 'Search a .bin for UTF-16 text',
      input: { sample: 'binary-hidden.bin' },
      options: { view: 'hex', search: 'wide text' },
      expect: 'utf16le',
    },
    {
      label: 'Strings of a .bin',
      input: { sample: 'binary-hidden.bin' },
      options: { view: 'strings' },
      expect: 'flag{carved_from_the_noise}',
    },
    {
      label: 'ENVI float32 raster as numbers',
      input: { sample: 'binary-raster.bin' },
      options: { view: 'numeric', envi: { sample: 'binary-raster.hdr' } },
      expect: '48 × 64',
    },
    {
      label: 'Entropy per block',
      input: { sample: 'binary-hidden.bin' },
      options: { view: 'entropy' },
      expect: '256 / 256',
    },
  ],
  run(input, o): Promise<Output[]> {
    switch (o.view) {
      case 'hex':
        return hexView(input, o);
      case 'strings':
        return stringsView(input, o);
      case 'carve':
        return carveView(input, o);
      case 'disk':
        return diskView(input, o);
      case 'numeric':
        return numericView(input, o);
      case 'entropy':
        return entropyView(input, o);
      default:
        return overviewView(input);
    }
  },
  detect({ text: sample, bytes, name }) {
    if (bytes.length < 512) return null;
    const head = bytes.subarray(0, HEAD);
    const cd = detectCd(head, bytes.length);
    if (cd) {
      return {
        score: 0.8,
        options: { view: 'disk' },
        reason: cd.sectorSize === 2048 ? T('detect.iso') : T('detect.raw', { size: cd.sectorSize }),
      };
    }
    if (parseBpb(head)) return { score: 0.75, options: { view: 'disk' }, reason: T('detect.fat') };
    if (hasPartitionTable(head)) {
      return { score: 0.75, options: { view: 'disk' }, reason: T('detect.partitions') };
    }
    if (sample !== null) return null;
    if (identify(head).some((s) => !s.weak)) return null;
    const window = bytes.subarray(0, 1 << 20);
    const counts = new Uint32Array(256);
    for (const b of window) counts[b]!++;
    const entropy = shannon(counts, window.length);
    if (entropy >= 7.2)
      return { score: 0.65, reason: T('detect.random', { entropy: entropy.toFixed(2) }) };
    if (/\.(bin|img|raw|dat|dump|dd)$/i.test(name ?? ''))
      return { score: 0.6, reason: T('detect.unknown') };
    return null;
  },
});
