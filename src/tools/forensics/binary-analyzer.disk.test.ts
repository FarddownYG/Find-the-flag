/**
 * Disk image view of the Binary analyzer, on images written to the specs by our own writers
 * (_disk-fixtures): ISO 9660 with Joliet / Rock Ridge / El Torito, raw CD sectors in every
 * layout, FAT12 / 16 / 32 with long names and deleted files, MBR / EBR / GPT. Every file the
 * listing shows must come out byte for byte.
 */
import { describe, expect, it } from 'vitest';
import { prepareInput } from '../../core/prepare';
import type { LazyFile, ToolResult } from '../../core/types';
import { concatBytes, utf8Decode, utf8Encode } from '../../lib/bytes';
import { USER } from './_cd';
import {
  buildFat,
  buildGptDisk,
  buildIso,
  buildMbrDisk,
  cookedToRaw,
  writeEbr,
  type FatGeometry,
  type FatNodeSpec,
  type IsoFileSpec,
} from './_disk-fixtures';
import { buildZip, noise } from './_fixtures';
import {
  content,
  counted,
  fileNamed,
  filesOf,
  kv,
  notes,
  repeatBlob,
  run,
  same,
  table,
  texts,
  tool,
} from './_binary-test-kit';

const text = (s: string, n: number) => utf8Encode(s.repeat(Math.ceil(n / s.length)).slice(0, n));
const listing = (r: ToolResult) => table(r, 'Files (')!;
const rowOf = (r: ToolResult, path: string) => listing(r).rows.find((row) => row[0] === path);
const disk = (input: Uint8Array | Blob | LazyFile, name = 'input.bin', opts = {}) =>
  run(input, { view: 'disk', ...opts }, name);

// ---------------------------------------------------------------- ISO-A: primary hierarchy

const MANY = Array.from({ length: 60 }, (_, i) => ({
  path: `/MANY/F${String(i).padStart(2, '0')}.TXT`,
  data: utf8Encode(`file number ${i}\n`),
}));
const ISO_A: IsoFileSpec[] = [
  { path: '/README.TXT', data: text('Find The Flag ISO-A probe. ', 100) },
  { path: '/A/MID1.TXT', data: utf8Encode('level one\n') },
  { path: '/A/B/MID2.TXT', data: utf8Encode('level two\n') },
  { path: '/A/B/C/DEEP.TXT', data: text('deep ', 3000) },
  { path: '/EXACT2K.BIN', data: noise(2048, 7) },
  { path: '/EMPTY.DAT', data: new Uint8Array(0), zeroExtent: true },
  { path: '/NOVER.TXT', data: utf8Encode('no version number\n'), version: null },
  { path: '/VER2.TXT', data: utf8Encode('second version\n'), version: 2 },
  { path: '/HIDDEN.TXT', data: utf8Encode('hidden flag bit\n'), hidden: true },
  ...MANY,
  { path: '/MULTI.BIN', data: noise(5096, 11), extents: [4096, 1000] },
  // Last in the layout: the truncation test cuts into it.
  { path: '/A/B/C/LAST.BIN', data: noise(10000, 13) },
];
const isoA = buildIso(ISO_A, { label: 'FTF_PROBE_A' });
const isoASectors = isoA.length / USER;
const shownPath = (spec: IsoFileSpec) => (spec.version === 2 ? `${spec.path};2` : spec.path);

describe('ISO 9660 primary hierarchy (ISO-A)', () => {
  it('lists every file with its exact size and extracts it byte for byte', async () => {
    const r = await disk(isoA, 'probe-a.iso');
    for (const spec of ISO_A) {
      const row = rowOf(r, shownPath(spec));
      expect(row, spec.path).toBeDefined();
      expect(row![1]).toBe(spec.data.length);
      const f = fileNamed(r, shownPath(spec).slice(1));
      expect(same(await content(f), spec.data), spec.path).toBe(true);
    }
    for (const dir of ['/A/', '/A/B/', '/A/B/C/', '/MANY/']) expect(rowOf(r, dir)).toBeDefined();
    expect(listing(r).label).toBe(`Files (${ISO_A.length}) and directories (4)`);
  });

  it('shows the hidden flag and joins a multi-extent file', async () => {
    const r = await disk(isoA, 'probe-a.iso');
    expect(rowOf(r, '/HIDDEN.TXT')![4]).toBe('hidden');
    const multi = listing(r).rows.filter((row) => row[0] === '/MULTI.BIN');
    expect(multi).toHaveLength(1);
    expect([multi[0]![1], multi[0]![4]]).toEqual([5096, '2 extents']);
  });

  it('cooked image: sector size, mode, label and a generic .cue named after the file', async () => {
    for (const name of ['probe-a.iso', 'disk.bin']) {
      const r = await disk(isoA, name);
      const info = kv(r);
      expect([
        info.get('Sector size'),
        info.get('Mode'),
        info.get('Sectors'),
        info.get('Volume label'),
      ]).toEqual(['2048', 'cooked (2048-byte user data only)', String(isoASectors), 'FTF_PROBE_A']);
      expect(texts(r)).toContain(
        `FILE "${name}" BINARY\r\n  TRACK 01 MODE1/2048\r\n    INDEX 01 00:00:00\r\n`,
      );
    }
  });

  it('a truncated image: the cut file is marked in the listing and extracted as far as it goes', async () => {
    const cut = isoA.subarray(0, (isoASectors - 3) * USER);
    const r = await disk(cut, 'cut.iso');
    expect(notes(r)).toContain(
      'The volume declares 3 more sectors than the image holds: the image is truncated.',
    );
    expect(rowOf(r, '/A/B/C/LAST.BIN')!.slice(1, 2)).toEqual([10000]);
    expect(rowOf(r, '/A/B/C/LAST.BIN')![4]).toBe('truncated: past the end of the image');
    const last = fileNamed(r, 'A/B/C/LAST.BIN');
    expect(last.note).toBe('points past the end of the image: truncated');
    expect(same(await content(last), ISO_A.at(-1)!.data.subarray(0, 4096))).toBe(true);
    for (const spec of ISO_A.slice(0, -1)) {
      expect(same(await content(fileNamed(r, shownPath(spec).slice(1))), spec.data)).toBe(true);
    }
  });

  it('data after the volume: a payload is pointed out, zero padding is called padding', async () => {
    const payload = concatBytes(
      utf8Encode('hidden payload after the volume\n'),
      noise(5 * USER - 32, 111),
    );
    const r = await disk(concatBytes(isoA, payload), 'tail.iso');
    expect(notes(r)).toContain(
      `5 sectors follow the end of the ISO 9660 volume (from sector ${isoASectors}): data that no file points to. Look at them in Hexdump or Carving.`,
    );
    const padded = concatBytes(isoA, new Uint8Array(150 * USER));
    const z = await disk(padded, 'padded.iso');
    expect(notes(z)).toContain(
      `150 sectors follow the end of the ISO 9660 volume (from sector ${isoASectors}); their user data is all zero: padding, as mastering tools and CD rips add.`,
    );
    expect(notes(z).join('\n')).not.toContain('data that no file points to');
    const o = await run(padded, {}, 'padded.iso');
    expect(notes(o)).toContain(
      `${150 * USER} bytes of zero padding follow the end of the main structure (offset ${isoA.length}, 0x${isoA.length.toString(16)}).`,
    );
    // The same padding in raw sectors: their headers are not zero, their user data is.
    const raw = cookedToRaw(padded);
    for (const res of [await disk(raw, 'padded.bin'), await run(raw, {}, 'padded.bin')]) {
      expect(notes(res)).toContain(
        `150 sectors follow the end of the ISO 9660 volume (from sector ${isoASectors}); their user data is all zero: padding, as mastering tools and CD rips add.`,
      );
      expect(notes(res).join('\n')).not.toMatch(/Hidden data is often|no file points to/);
    }
  });
});

// ---------------------------------------------------------------- ISO-J: Joliet

const LONG64 = `${'sixty-four characters long Joliet name '.repeat(2)}`.slice(0, 60) + '.txt';
const LONG100 =
  `${'a hundred characters in one Joliet file name '.repeat(3)}`.slice(0, 96) + '.txt';
const ISO_J: IsoFileSpec[] = [
  {
    path: '/LISEZMOI.TXT',
    longName: "/Lisez-moi d'abord — très important.txt",
    data: utf8Encode('Joliet keeps accents and dashes.\n'),
  },
  {
    path: '/DOSSIER/DONNEES.BIN',
    longName: '/Un dossier au nom vraiment très long pour Joliet/données ✓.bin',
    data: noise(50000, 21),
  },
  { path: '/JAPON.TXT', longName: '/日本語のファイル名.txt', data: utf8Encode('にほんご\n') },
  {
    path: '/N1/N2/N3/PROFOND.TXT',
    longName: '/Niveau 1/Niveau 2/Niveau 3/fichier profond.txt',
    data: utf8Encode('trois niveaux\n'),
  },
  { path: '/EXACT.BIN', longName: '/exactly 2048 bytes.bin', data: noise(2048, 22) },
  { path: '/EMPTY.DAT', longName: '/empty file.dat', data: new Uint8Array(0), zeroExtent: true },
  { path: '/LONG64.TXT', longName: `/${LONG64}`, data: utf8Encode('64\n'), version: null },
  { path: '/LONG100.TXT', longName: `/${LONG100}`, data: utf8Encode('100\n') },
];
const isoJ = buildIso(ISO_J, { label: 'FTF_PROBE_J', joliet: true });

async function expectJoliet(r: ToolResult) {
  expect(kv(r).get('Names from')).toBe('Joliet');
  for (const spec of ISO_J) {
    const path = spec.longName!;
    expect(rowOf(r, path)?.[1], path).toBe(spec.data.length);
    expect(same(await content(fileNamed(r, path.slice(1))), spec.data), path).toBe(true);
  }
  for (const dir of [
    '/Un dossier au nom vraiment très long pour Joliet/',
    '/Niveau 1/',
    '/Niveau 1/Niveau 2/',
    '/Niveau 1/Niveau 2/Niveau 3/',
  ])
    expect(rowOf(r, dir), dir).toBeDefined();
}

describe('Joliet and raw CD sectors (ISO-J)', () => {
  it('cooked: long Unicode names from the Joliet tree', async () => {
    await expectJoliet(await disk(isoJ, 'probe-j.iso'));
  });

  it('raw 2352 Mode 1: EDC checked, same files, generic .cue, cooked .iso identical', async () => {
    const raw = cookedToRaw(isoJ);
    const f = (await prepareInput('file', {
      file: new Blob([raw as BlobPart]),
      name: 'game.bin',
    })) as LazyFile;
    const r = await disk(f);
    const info = kv(r);
    expect([
      info.get('Sector size'),
      info.get('Mode'),
      info.get('User data at (in each sector)'),
      info.get('EDC (sector 16)'),
    ]).toEqual(['2352', 'Mode 1', '16', 'valid']);
    await expectJoliet(r);
    expect(utf8Decode(await content(fileNamed(r, 'game.cue')))).toBe(
      'FILE "game.bin" BINARY\r\n  TRACK 01 MODE1/2352\r\n    INDEX 01 00:00:00\r\n',
    );
    expect(same(await content(fileNamed(r, 'game.iso')), isoJ)).toBe(true);
  });

  it('raw 2352 Mode 2 Form 1 (XA): data at 24, MODE2/2352, cooked .iso identical', async () => {
    const r = await disk(cookedToRaw(isoJ, 'mode2'), 'game-xa.bin');
    const info = kv(r);
    expect([info.get('Mode'), info.get('User data at (in each sector)')]).toEqual([
      'Mode 2 Form 1',
      '24',
    ]);
    await expectJoliet(r);
    expect(utf8Decode(await content(fileNamed(r, 'game-xa.cue')))).toContain('TRACK 01 MODE2/2352');
    expect(same(await content(fileNamed(r, 'game-xa.iso')), isoJ)).toBe(true);
  });

  it('a modified sector 16 gives a wrong EDC, and the volume is still read', async () => {
    const raw = cookedToRaw(isoJ);
    raw[16 * 2352 + 16 + 1500] = raw[16 * 2352 + 16 + 1500]! ^ 0xff;
    const r = await disk(raw, 'edc.bin');
    expect(kv(r).get('EDC (sector 16)')).toBe('wrong: the sector was modified');
    await expectJoliet(r);
  });

  it('an image that starts 100 bytes into the file', async () => {
    const r = await disk(concatBytes(noise(100, 5), cookedToRaw(isoJ)), 'offset.bin');
    expect(kv(r).get('First sector at')).toBe('100 (0x64)');
    expect(notes(r)).toContain(
      'The first sector starts 100 bytes into the file, which a .cue cannot express: cut those bytes first.',
    );
    await expectJoliet(r);
  });

  it('an image cut in the middle of its last sector', async () => {
    const raw = cookedToRaw(concatBytes(isoJ, new Uint8Array(2 * USER)));
    const r = await disk(raw.subarray(0, raw.length - 1000), 'cut.bin');
    expect([kv(r).get('Sector size'), kv(r).get('Mode')]).toEqual(['2352', 'Mode 1']);
    expect(kv(r).get('Sectors')).toBe(`${raw.length / 2352 - 1} (+ 1352 bytes)`);
    await expectJoliet(r);
    const o = await run(raw.subarray(0, raw.length - 1000), {}, 'cut.bin');
    expect(notes(o)).toContain(
      'The last sector is cut short: only 1352 of its 2352 bytes are in the file (a truncated image).',
    );
    expect(notes(o).join('\n')).not.toContain('Hidden data is often');
  });

  it('a file name with spaces and brackets', async () => {
    const r = await disk(cookedToRaw(isoJ), 'My Game (Disc 1).bin');
    expect(utf8Decode(await content(fileNamed(r, 'My Game (Disc 1).cue')))).toContain(
      'FILE "My Game (Disc 1).bin" BINARY',
    );
    expect(filesOf(r).map((f) => f.name)).toContain('My Game (Disc 1).iso');
  });

  it('2448-byte sectors (subchannel data after each sector) are read too', async () => {
    const raw = cookedToRaw(isoJ);
    const n = raw.length / 2352;
    const sub = new Uint8Array(n * 2448);
    for (let i = 0; i < n; i++) sub.set(raw.subarray(i * 2352, (i + 1) * 2352), i * 2448);
    const r = await disk(sub, 'clone.img');
    expect([kv(r).get('Sector size'), kv(r).get('Track (.cue)')]).toEqual([
      '2448',
      'none: a .cue cannot describe this layout',
    ]);
    await expectJoliet(r);
    expect(same(await content(fileNamed(r, 'clone.iso')), isoJ)).toBe(true);
  });
});

// ---------------------------------------------------------------- BIN with audio sectors

describe('a BIN holding a data track and CD audio, without its .cue', () => {
  const iso = buildIso([{ path: '/GAME.EXE', data: noise(20000, 120) }], { label: 'MIXED' });
  const data = iso.length / USER;
  const audio = noise(100 * 2352, 121);
  const bin = concatBytes(cookedToRaw(iso), audio);

  it('finds where the data track ends: AUDIO track in the .cue, data-only .iso, audio as WAV', async () => {
    const r = await disk(bin, 'mixed.bin');
    expect(kv(r).get('Data track')).toBe(`${data} sectors, from sector 0`);
    expect(kv(r).get('Audio (no sync pattern)')).toBe(`100 sectors from sector ${data}`);
    const cue = utf8Decode(await content(fileNamed(r, 'mixed.cue')));
    expect(cue).toBe(
      `FILE "mixed.bin" BINARY\r\n  TRACK 01 MODE1/2352\r\n    INDEX 01 00:00:00\r\n  TRACK 02 AUDIO\r\n    INDEX 01 00:00:${String(data).padStart(2, '0')}\r\n`,
    );
    expect(same(await content(fileNamed(r, 'mixed.iso')), iso)).toBe(true);
    const wav = await content(fileNamed(r, 'mixed-audio.wav'));
    expect([utf8Decode(wav.subarray(0, 4)), wav.length]).toEqual(['RIFF', 44 + audio.length]);
    expect(same(wav.subarray(44), audio)).toBe(true);
    expect(same(await content(fileNamed(r, 'GAME.EXE')), noise(20000, 120))).toBe(true);
    expect(notes(r).join('\n')).not.toContain('follow the end of the ISO 9660 volume');
  });

  it('a ZIP glued after the data track is not taken for audio', async () => {
    const zip = buildZip([{ name: 'secret.txt', data: utf8Encode('flag{appended_to_the_bin}') }]);
    const glued = concatBytes(cookedToRaw(iso), zip, noise(3 * 2352, 122));
    const r = await disk(glued, 'glued.bin');
    expect(kv(r).get('Audio (no sync pattern)')).toBeUndefined();
    expect(utf8Decode(await content(fileNamed(r, 'glued.cue')))).not.toContain('AUDIO');
    const start = data * 2352;
    expect(notes(r)).toContain(
      `${glued.length - start} bytes without the sync pattern follow the data track, from offset ${start} (0x${start.toString(16)}): not CD audio but a file or text appended to the BIN (the Carving view names it). Hidden data is often appended like this.`,
    );
    const tail = await content(fileNamed(r, 'glued-after-track.bin'));
    expect(same(tail.subarray(0, zip.length), zip)).toBe(true);
    const o = await run(glued, {}, 'glued.bin');
    expect(kv(o).get('Verdict')).toBe('Raw CD image, 2352-byte sectors, Mode 1 (ISO 9660 inside)');
    expect(notes(o).join('\n')).toContain(
      `from offset ${start} (0x${start.toString(16)}): ZIP archive`,
    );
    expect(table(o, 'Embedded files')!.rows.map((row) => [row[0], row[3]])).toContainEqual([
      start,
      zip.length,
    ]);
  });

  it('zeros after the data track are padding, not audio', async () => {
    const padded = concatBytes(cookedToRaw(iso), new Uint8Array(100 * 2352));
    const r = await disk(padded, 'zeros.bin');
    expect(kv(r).get('Audio (no sync pattern)')).toBeUndefined();
    const start = data * 2352;
    expect(notes(r)).toContain(
      `${100 * 2352} bytes of zero padding follow the end of the main structure (offset ${start}, 0x${start.toString(16)}).`,
    );
    expect(notes(await run(padded, {}, 'zeros.bin')).join('\n')).toContain('bytes of zero padding');
  });

  it('the Overview says so instead of calling the audio hidden data', async () => {
    const r = await run(bin, {}, 'mixed.bin');
    expect(kv(r).get('Verdict')).toBe(
      'Raw CD image, 2352-byte sectors, Mode 1 (ISO 9660 inside), then 100 sectors of CD audio',
    );
    expect(notes(r)).toContain(
      `100 sectors after the data track (from sector ${data}) have no sync pattern: CD audio (CD-DA), most likely. The Disk image view wraps them as WAV.`,
    );
    expect(notes(r).join('\n')).not.toContain('Hidden data is often');
  });
});

// ---------------------------------------------------------------- Rock Ridge, El Torito, odd names

describe('ISO 9660 extensions and odd records', () => {
  it('Rock Ridge names win, El Torito is reported', async () => {
    const long = '/my directory/a very long rock ridge name with spaces and MixedCase.dat';
    const iso = buildIso([{ path: '/MYDIR/LONGNAME.DAT', longName: long, data: noise(3000, 40) }], {
      rockRidge: true,
      elTorito: true,
    });
    const r = await disk(iso, 'rr.iso');
    expect([kv(r).get('Rock Ridge'), kv(r).get('El Torito'), kv(r).get('Names from')]).toEqual([
      'yes',
      'yes',
      'Rock Ridge',
    ]);
    expect(rowOf(r, long)?.[1]).toBe(3000);
    expect(same(await content(fileNamed(r, long.slice(1))), noise(3000, 40))).toBe(true);
  });

  it('names without an extension lose the trailing dot', async () => {
    const r = await disk(
      buildIso([
        { path: '/NOEXT.', data: utf8Encode('a') },
        { path: '/DOTTED.', data: utf8Encode('b') },
      ]),
    );
    expect(listing(r).rows.map((row) => row[0])).toEqual(['/DOTTED', '/NOEXT']);
  });

  it('a directory pointing back at the root ends quickly, with a warning', async () => {
    const iso = buildIso([
      { path: '/LOOP/X.TXT', data: utf8Encode('x') },
      { path: '/OK.TXT', data: utf8Encode('ok') },
    ]);
    const v = new DataView(iso.buffer);
    const rootLba = v.getUint32(0x8000 + 156 + 2, true);
    const root = iso.subarray(rootLba * USER, rootLba * USER + USER);
    const at = Buffer.from(root).indexOf('LOOP');
    v.setUint32(rootLba * USER + at - 33 + 2, rootLba, true);
    v.setUint32(rootLba * USER + at - 33 + 6, rootLba, false);
    const t0 = Date.now();
    const r = await disk(iso, 'loop.iso');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(notes(r)).toContain(
      'One directory points outside the image or back up the tree: it was skipped.',
    );
    expect(rowOf(r, '/OK.TXT')).toBeDefined();
  });

  it('a Rock Ridge continuation area with absurd sizes is not followed', async () => {
    // A 23-character name makes a 28-byte NM entry: exactly the size of a CE entry, which
    // replaces it (continuation in sector 0, offset 0, 2 GiB long).
    const name = 'a'.repeat(19) + '.txt';
    const iso = buildIso([{ path: '/A.TXT', longName: `/${name}`, data: utf8Encode('a') }], {
      rockRidge: true,
    });
    const nmAt = Buffer.from(iso).indexOf(`NM\x1c\x01\x00${name}`, 0, 'latin1');
    expect(nmAt).toBeGreaterThan(0);
    const ce = new Uint8Array(28);
    ce.set([0x43, 0x45, 28, 1]);
    const cv = new DataView(ce.buffer);
    cv.setUint32(4, 0, true);
    cv.setUint32(12, 0, true);
    cv.setUint32(20, 0x7fffffff, true);
    const big = concatBytes(iso, new Uint8Array(64 << 20));
    big.set(ce, nmAt);
    const [f, stats] = counted(big, 'ce.iso');
    const r = await disk(f);
    expect(rowOf(r, '/A.TXT')).toBeDefined();
    expect(stats.bytes).toBeLessThan(16 << 20);
  });
});

// ---------------------------------------------------------------- FAT

const FLOPPY: FatGeometry = {
  type: 'FAT12',
  totalSectors: 2880,
  sectorsPerCluster: 1,
  reserved: 1,
  fats: 2,
  fatSectors: 9,
  rootEntries: 224,
  label: 'FTF12PROBE',
};
const FLOPPY_FILES: FatNodeSpec[] = [
  { path: '/A very long file name with spaces.txt', data: text('long name ', 3000) },
  { path: '/Sub Folder', dir: true },
  { path: '/Sub Folder/nested file.dat', data: noise(1500, 31), clusters: [100, 102, 104] },
  { path: '/FRAG.BIN', data: noise(1300, 32), clusters: [101, 103, 105] },
  { path: '/Sub Folder/LEVEL2/LEVEL3/DEEP.TXT', data: utf8Encode('three levels down\n') },
  { path: '/EMPTY.TXT', data: new Uint8Array(0) },
  { path: '/secret_deleted_file.txt', data: text('deleted but intact ', 700), deleted: true },
  { path: '/OLD.BIN', data: text('old data ', 400), deleted: true, clusters: [300] },
  { path: '/NEWFILE.TXT', data: text('new data on the old cluster ', 400), clusters: [300] },
  { path: '/LOWER.TXT', short: 'LOWER   TXT', ntres: 0x18, data: utf8Encode('lower case\n') },
  {
    path: '/RENAMED.TXT',
    short: 'RENAMED TXT',
    lfnName: 'Orphan Long Name.txt',
    lfnXor: 0x5a,
    data: utf8Encode('the long name no longer matches\n'),
  },
  { path: '/Good Long Name.txt', data: utf8Encode('this one matches\n') },
];
const floppy = buildFat(FLOPPY, FLOPPY_FILES);
const fatRows = (r: ToolResult) => table(r, 'Files and directories')!.rows;
const fatRow = (r: ToolResult, path: string) => fatRows(r).find((row) => row[0] === path);

describe('FAT12 floppy', () => {
  it('long names, three levels, fragmented chains, empty files: all exact', async () => {
    const r = await disk(floppy, 'floppy.img');
    expect([kv(r).get('Filesystem'), kv(r).get('Clusters')]).toEqual(['FAT12', '2847']);
    const live = FLOPPY_FILES.filter((f) => !f.dir && !f.deleted && f.path !== '/LOWER.TXT');
    for (const spec of live) {
      const path = spec.path === '/RENAMED.TXT' ? '/RENAMED.TXT' : spec.path;
      expect(fatRow(r, path)?.[1], path).toBe(spec.data!.length);
      expect(same(await content(fileNamed(r, path.slice(1))), spec.data!), path).toBe(true);
    }
    expect(fatRow(r, '/EMPTY.TXT')![5]).toBe('empty');
    expect(fileNamed(r, 'EMPTY.TXT').data.length).toBe(0);
    for (const dir of ['/Sub Folder/', '/Sub Folder/LEVEL2/', '/Sub Folder/LEVEL2/LEVEL3/'])
      expect(fatRow(r, dir), dir).toBeDefined();
  });

  it('deleted files, reused clusters, NTRes lower case, the label, orphaned long names', async () => {
    const r = await disk(floppy, 'floppy.img');
    expect(fatRow(r, '/secret_deleted_file.txt')![5]).toBe('deleted, recoverable');
    expect(
      same(await content(fileNamed(r, 'deleted/secret_deleted_file.txt')), FLOPPY_FILES[6]!.data!),
    ).toBe(true);
    expect(fatRow(r, '/_LD.BIN')![5]).toBe(
      'deleted, clusters reused (the data may belong to another file)',
    );
    expect(fatRow(r, '/lower.txt')).toBeDefined();
    expect(fatRows(r).some((row) => String(row[0]).includes('FTF12PROBE'))).toBe(false);
    expect(kv(r).get('Volume label')).toBe('FTF12PROBE');
    expect(fatRow(r, '/RENAMED.TXT')).toBeDefined();
    expect(fatRow(r, '/Orphan Long Name.txt')).toBeUndefined();
    expect(fatRow(r, '/Good Long Name.txt')).toBeDefined();
  });

  it('a FAT12 image made by mkfs.fat and mtools (independent writer)', async () => {
    const { gunzipSync } = await import('fflate');
    const { readFileSync } = await import('node:fs');
    const img = gunzipSync(
      new Uint8Array(readFileSync(new URL('./fixtures/mtools-fat12.img.gz', import.meta.url))),
    );
    const manifest = JSON.parse(
      readFileSync(new URL('./fixtures/mtools-fat12.json', import.meta.url), 'utf8'),
    ) as { path: string; sha256: string; size: number; deleted?: boolean }[];
    const r = await disk(img, 'mtools.img');
    const { createHash } = await import('node:crypto');
    for (const m of manifest) {
      const name = `${m.deleted ? 'deleted/' : ''}${m.path.slice(1)}`;
      const data = await content(fileNamed(r, name));
      expect(createHash('sha256').update(data).digest('hex'), m.path).toBe(m.sha256);
      expect(fatRow(r, m.path)?.[1], m.path).toBe(m.size);
    }
  });
});

const FAT16: FatGeometry = {
  type: 'FAT16',
  totalSectors: 32768,
  sectorsPerCluster: 4,
  reserved: 4,
  fats: 2,
  fatSectors: 32,
  rootEntries: 512,
  hidden: 2048,
  label: 'FTF16',
};
const FAT16_FILES: FatNodeSpec[] = [
  { path: '/HELLO.TXT', data: utf8Encode('hello from FAT16\n') },
  { path: '/Long Name In FAT16.txt', data: noise(5000, 41) },
  { path: '/DOCS/notes.md', data: utf8Encode('# notes\n') },
  { path: '/DOCS/ZERO.BIN', data: new Uint8Array(0) },
];

async function expectFat16(r: ToolResult) {
  for (const spec of FAT16_FILES) {
    expect(fatRow(r, spec.path)?.[1], spec.path).toBe(spec.data!.length);
    expect(same(await content(fileNamed(r, spec.path.slice(1))), spec.data!), spec.path).toBe(true);
  }
}

describe('partition tables', () => {
  it('MBR with a FAT16 partition and a Linux one', async () => {
    const vol = buildFat(FAT16, FAT16_FILES);
    const img = buildMbrDisk(
      36864,
      [
        { type: 0x06, start: 2048, count: 32768, boot: true },
        { type: 0x83, start: 34816, count: 2048 },
      ],
      [{ at: 2048, bytes: vol }],
    );
    const r = await disk(img, 'disk.img');
    expect(table(r, 'MBR partition table')!.rows.map((row) => [row[1], row[4]])).toEqual([
      ['FAT16 (0x06)', '*'],
      ['Linux (0x83)', ''],
    ]);
    expect(kv(r).get('Filesystem')).toBe('FAT16');
    await expectFat16(r);
    expect(notes(r)).toContain('Partition 2 (Linux) is not a FAT volume: not parsed here.');
    expect(kv(await run(img, {}, 'disk.img')).get('Verdict')).toBe(
      'Disk image with a partition table (MBR, 2 partitions)',
    );
  });

  it('FAT32: cluster numbers above 65535 use the high word', async () => {
    const files: FatNodeSpec[] = [
      ...Array.from({ length: 22 }, (_, i) => ({
        path: `/Long file name number ${i}.txt`,
        data: utf8Encode(`content ${i}\n`),
      })),
      {
        path: '/Big Cluster File.bin',
        data: noise(3000, 51),
        clusters: [65600, 65601, 65602, 65603, 65604, 65605],
      },
      { path: '/DEEP/LEVEL2/Level 3 dir/final.txt', data: utf8Encode('final\n') },
    ];
    const img = buildFat(
      {
        type: 'FAT32',
        totalSectors: 67064,
        sectorsPerCluster: 1,
        reserved: 32,
        fats: 2,
        fatSectors: 516,
        rootEntries: 0,
        label: 'FTF32',
      },
      files,
    );
    const r = await disk(img, 'fat32.img');
    expect([kv(r).get('Filesystem'), kv(r).get('Clusters')]).toEqual(['FAT32', '66000']);
    for (const spec of files) {
      expect(fatRow(r, spec.path)?.[1], spec.path).toBe(spec.data!.length);
      expect(same(await content(fileNamed(r, spec.path.slice(1))), spec.data!)).toBe(true);
    }
    expect(fatRow(r, '/Big Cluster File.bin')![3]).toBe(65600);
  });

  it('GPT with a FAT16 basic-data partition', async () => {
    const vol = buildFat(FAT16, [{ path: '/gpt-file.txt', data: utf8Encode('inside GPT\n') }]);
    const img = buildGptDisk(
      2048 + 32768 + 4096 + 34,
      [
        {
          type: 'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7',
          first: 2048,
          last: 2048 + 32767,
          name: 'DATA',
        },
        {
          type: '0FC63DAF-8483-4772-8E79-3D69D8477DE4',
          first: 2048 + 32768,
          last: 2048 + 32768 + 4095,
          name: 'linux',
        },
      ],
      [{ at: 2048, bytes: vol }],
    );
    const r = await disk(img, 'gpt.img');
    expect(table(r, 'GPT partition table')!.rows.map((row) => [row[1], row[5]])).toEqual([
      ['Microsoft basic data (EBD0A0A2-B9E5-4433-87C0-68B6B72699C7)', 'DATA'],
      ['Linux filesystem (0FC63DAF-8483-4772-8E79-3D69D8477DE4)', 'linux'],
    ]);
    expect(utf8Decode(await content(fileNamed(r, 'gpt-file.txt')))).toBe('inside GPT\n');
  });

  it('MBR extended partition: both logical volumes of the EBR chain', async () => {
    const one = buildFat(FLOPPY, [{ path: '/ONE.TXT', data: utf8Encode('one\n') }]);
    const two = buildFat(FLOPPY, [{ path: '/TWO.TXT', data: utf8Encode('two\n') }]);
    const img = buildMbrDisk(
      2048 + 2943 * 2 + 64,
      [{ type: 0x0f, start: 2048, count: 2943 * 2 }],
      [
        { at: 2048 + 63, bytes: one },
        { at: 2048 + 2943 + 63, bytes: two },
      ],
    );
    writeEbr(img, 2048, { type: 0x01, rel: 63, count: 2880 }, { rel: 2943, count: 2943 });
    writeEbr(img, 2048 + 2943, { type: 0x01, rel: 63, count: 2880 });
    const r = await disk(img, 'ext.img');
    expect(utf8Decode(await content(fileNamed(r, 'ONE.TXT')))).toBe('one\n');
    expect(utf8Decode(await content(fileNamed(r, 'TWO.TXT')))).toBe('two\n');
  });
});

// ---------------------------------------------------------------- not a disk

describe('files that are not disk images', () => {
  it('a plain .bin: no disk structure, and the verdict says so', async () => {
    const mystery = concatBytes(noise(50000, 61), utf8Encode('a line of text\n'), noise(49985, 62));
    expect(mystery.length).toBe(100000);
    const r = await disk(mystery, 'mystery.bin');
    expect(notes(r)[0]).toMatch(/^No disk image structure found/);
    expect(kv(await run(mystery, {}, 'mystery.bin')).get('Verdict')).toMatch(
      /^Unknown \/ raw data/,
    );
  });

  it('a stray 55 AA, a fake CD001 and a multiple of 2352 bytes of noise', async () => {
    const a = noise(8192, 71);
    a.set([0x55, 0xaa], 510);
    expect(table(await disk(a), 'MBR')).toBeUndefined();
    const b = noise(40 * 2048, 81);
    b.set([1, ...utf8Encode('CD001'), 1], 0x8000);
    const rb = await disk(b, 'fake.iso');
    expect(listing(rb)).toBeUndefined();
    expect(notes(rb)).toContain(
      'No ISO 9660 volume in this track: the cooked .iso above can still be carved, or mounted if it holds another filesystem.',
    );
    const rc = await disk(noise(30 * 2352, 91), 'noise.bin');
    expect(notes(rc)[0]).toMatch(/^No disk image structure found/);
  });
});

// ---------------------------------------------------------------- big images

describe('big disk images are read sparingly', () => {
  it('ISO + 96 MiB of zeros: the Disk view reads little, the Overview reads it once', async () => {
    const big = new Blob([isoA as BlobPart, repeatBlob(new Uint8Array(1 << 20), 96)]);
    const [f, stats] = counted(big, 'big.iso');
    const r = await disk(f);
    expect(stats.bytes).toBeLessThan(16 << 20);
    expect(stats.largest).toBeLessThanOrEqual(8 << 20);
    expect(notes(r).join('\n')).toContain(
      'every part of their user data that was checked is zero: most likely padding',
    );
    const [g, all] = counted(big, 'big.iso');
    const o = await run(g);
    expect(all.bytes).toBeLessThan(big.size * 1.2);
    expect(all.largest).toBeLessThanOrEqual(8 << 20);
    expect(notes(o).join('\n')).toContain(
      'bytes of zero padding follow the end of the main structure',
    );
  });

  it('raw image holding a 40 MiB file: copied out exactly, within the copy budget', async () => {
    const payload = noise(40 << 20, 131);
    const raw = cookedToRaw(buildIso([{ path: '/BIG.BIN', data: payload }]));
    const [f, stats] = counted(raw, 'big.bin');
    const r = await disk(f);
    expect(same(await content(fileNamed(r, 'BIG.BIN')), payload)).toBe(true);
    // The cooked .iso would take the copies past 64 MiB: offered on request only.
    expect(filesOf(r).map((x) => x.name)).not.toContain('big.iso');
    expect(notes(r).join('\n')).toContain('tick "Rebuild from raw sectors" to make it');
    expect(stats.bytes).toBeLessThan(raw.length * 1.1);
  }, 60_000);

  it('a cooked ISO declaring a 600 MiB file: offered as a free slice of the input', async () => {
    const iso = buildIso([
      { path: '/README.TXT', data: utf8Encode('readme\n') },
      { path: '/BIG.BIN', data: utf8Encode('BIGFILE-START') },
    ]);
    const size = 600 << 20;
    const v = new DataView(iso.buffer);
    const at = Buffer.from(iso).indexOf('BIG.BIN;1');
    const rec = at - 33;
    v.setUint32(rec + 10, size, true);
    v.setUint32(rec + 14, size, false);
    const blocks = 1 << 19;
    v.setUint32(0x8000 + 80, blocks, true);
    v.setUint32(0x8000 + 84, blocks, false);
    const total = new Blob([iso as BlobPart, repeatBlob(new Uint8Array(1 << 20), 1024)]);
    const [f, stats] = counted(total, 'iso1g.iso');
    const r = await disk(f);
    const bigFile = fileNamed(r, 'BIG.BIN');
    expect(bigFile.blob?.size).toBe(size);
    expect(utf8Decode(new Uint8Array(await bigFile.blob!.slice(0, 13).arrayBuffer()))).toBe(
      'BIGFILE-START',
    );
    expect(stats.bytes).toBeLessThan(32 << 20);
  });

  it('raw image over the copy budget: listed, not copied, until asked', async () => {
    const payload = repeatBlob(noise(1 << 20, 140), 70);
    const iso = buildIso([
      { path: '/HUGE.BIN', data: new Uint8Array(await payload.arrayBuffer()) },
    ]);
    const raw = cookedToRaw(iso);
    const [f, stats] = counted(raw, 'huge.bin');
    const r = await disk(f);
    expect(rowOf(r, '/HUGE.BIN')![1]).toBe(70 << 20);
    expect(filesOf(r).map((x) => x.name)).not.toContain('HUGE.BIN');
    expect(notes(r)).toContain(
      'One file was not extracted: copying it out of the raw sectors would take the copies past 64.00 MiB. Tick "Rebuild from raw sectors" to extract it.',
    );
    expect(stats.bytes).toBeLessThan(4 << 20);
    const on = await disk(raw, 'huge.bin', { rebuild: true });
    const huge = fileNamed(on, 'HUGE.BIN');
    expect(huge.blob?.size).toBe(70 << 20);
    expect(
      same(
        new Uint8Array(await huge.blob!.slice(5 << 20, 6 << 20).arrayBuffer()),
        noise(1 << 20, 140),
      ),
    ).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------- triage

describe('triage', () => {
  const detect = (bytes: Uint8Array, name?: string) =>
    tool.detect!({ text: null, bytes: bytes.subarray(0, 8 << 20), name });
  it('recognises disk images and sends them to the Disk image view', () => {
    for (const b of [isoA, cookedToRaw(isoA), cookedToRaw(isoA, 'mode2'), floppy]) {
      expect(detect(b)?.options).toEqual({ view: 'disk' });
    }
    expect(detect(noise(1 << 20, 3))?.options).toBeUndefined();
  });
});
