import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lazyFile } from '../../core/prepare';
import { concatBytes, utf8Decode, utf8Encode } from '../../lib/bytes';
import {
  buildCue,
  cdAudioWavHeader,
  checkEdc,
  cueMode,
  detectCd,
  edc,
  msf,
  SectorReader,
} from './_cd';
import {
  buildFat12,
  buildIso,
  buildSampleFat,
  buildSampleIso,
  cookedToRaw,
  FAT_FILES,
  ISO_FILES,
  withMbr,
} from './_disk-fixtures';
import { FatVolume, hasPartitionTable, parseBpb, readPartitions, sfnChecksum } from './_fat';
import { isoFileBlob, listIso, readIsoFile, readIsoVolume } from './_iso9660';
import { noise } from './_fixtures';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));
const fileOf = (b: Uint8Array, name = 'x.bin') => lazyFile(new Blob([b as BlobPart]), name);
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

async function isoOf(bytes: Uint8Array) {
  const f = fileOf(bytes);
  const layout = detectCd(await f.read(0, 65536), f.size)!;
  const r = new SectorReader(f, layout);
  const vol = (await readIsoVolume(r))!;
  return { f, layout, r, vol, listing: await listIso(r, vol) };
}

describe('samples are what the generator writes', () => {
  it.each([
    ['disk-ftf.iso', buildSampleIso()],
    ['disk-ftf-raw.bin', cookedToRaw(buildSampleIso())],
    ['disk-ftf-fat12.img', buildSampleFat()],
  ])('%s', (name, built) => expect(same(sample(name), built)).toBe(true));
});

describe('CD layout', () => {
  it('tells cooked, raw Mode 1, raw Mode 2 and 2336-byte images apart', async () => {
    const iso = buildSampleIso();
    const cases: [Uint8Array, number, string, number][] = [
      [iso, 2048, 'cooked', 0],
      [cookedToRaw(iso), 2352, 'mode1', 16],
      [cookedToRaw(iso, 'mode2'), 2352, 'mode2form1', 24],
      [cookedToRaw(iso, '2336'), 2336, 'mode2', 8],
    ];
    for (const [bytes, size, mode, off] of cases) {
      const l = detectCd(bytes.subarray(0, 65536), bytes.length)!;
      expect([l.sectorSize, l.mode, l.dataOffset, l.iso, l.sectors, l.remainder]).toEqual([
        size,
        mode,
        off,
        true,
        31,
        0,
      ]);
    }
    expect(detectCd(noise(65536, 1), 1 << 20)).toBeNull();
  });

  it('finds the first raw sector after junk and reports its address', () => {
    const raw = concatBytes(new Uint8Array(100).fill(0x41), cookedToRaw(buildSampleIso()));
    const l = detectCd(raw.subarray(0, 65536), raw.length)!;
    expect([l.base, l.sectorSize, l.firstMsf, l.iso]).toEqual([100, 2352, '00:02:00', true]);
  });

  it('checks the EDC of raw sectors', () => {
    const raw = cookedToRaw(buildSampleIso());
    expect(checkEdc(raw, 16 * 2352)).toBe('ok');
    const bad = Uint8Array.from(raw);
    bad[16 * 2352 + 100] = bad[16 * 2352 + 100]! ^ 1;
    expect(checkEdc(bad, 16 * 2352)).toBe('bad');
    bad.fill(0, 16 * 2352 + 2064, 16 * 2352 + 2068);
    expect(checkEdc(bad, 16 * 2352)).toBe('zero');
    expect(checkEdc(cookedToRaw(buildSampleIso(), 'mode2'), 16 * 2352)).toBe('ok');
    // CRC property: running the EDC over data + its little-endian EDC leaves zero.
    const d = utf8Encode('any data at all');
    const e = edc(d, 0, d.length);
    expect(
      edc(
        concatBytes(d, Uint8Array.of(e & 255, (e >> 8) & 255, (e >> 16) & 255, e >>> 24)),
        0,
        d.length + 4,
      ),
    ).toBe(0);
  });

  it('writes a generic .cue', () => {
    expect(buildCue('game "x".bin', 'MODE1/2352')).toBe(
      'FILE "game \'x\'.bin" BINARY\r\n  TRACK 01 MODE1/2352\r\n    INDEX 01 00:00:00\r\n',
    );
    expect(msf(150)).toBe('00:02:00');
    expect(msf(4500 * 3 + 75 * 7 + 9)).toBe('03:07:09');
    const l = detectCd(buildSampleIso().subarray(0, 65536), 31 * 2048)!;
    expect(cueMode(l)).toBe('MODE1/2048');
  });

  it('wraps raw CD audio in a WAV header', () => {
    const h = cdAudioWavHeader(2352 * 10);
    const v = new DataView(h.buffer);
    expect(utf8Decode(h.subarray(0, 4))).toBe('RIFF');
    expect([
      v.getUint16(22, true),
      v.getUint32(24, true),
      v.getUint16(34, true),
      v.getUint32(40, true),
    ]).toEqual([2, 44100, 16, 23520]);
  });
});

describe('ISO 9660', () => {
  it('reads the volume descriptors of the sample', async () => {
    const { vol, listing } = await isoOf(sample('disk-ftf.iso'));
    expect([
      vol.label,
      vol.blocks,
      vol.blockSize,
      vol.created,
      vol.joliet?.level,
      vol.boot,
    ]).toEqual(['FTF_DISK', 31, 2048, '2024-01-15 12:30:00', 3, false]);
    expect(listing.names).toBe('joliet');
    expect(listing.entries.map((e) => [e.path, e.dir, e.hidden])).toEqual([
      ['/DOCS', true, false],
      ['/DOCS/HELLO.TXT', false, false],
      ['/DOCS/notes about the disk.txt', false, false],
      ['/HIDDEN.TXT', false, true],
      ['/README.TXT', false, false],
    ]);
  });

  it('extracts every file byte-exact, from the cooked and the raw image', async () => {
    const want = new Map(ISO_FILES.map((f) => [(f.longName ?? f.path).toUpperCase(), f.data]));
    for (const bytes of [sample('disk-ftf.iso'), sample('disk-ftf-raw.bin')]) {
      const { r, listing } = await isoOf(bytes);
      for (const e of listing.entries.filter((x) => !x.dir)) {
        expect(same(await readIsoFile(r, e), want.get(e.path.toUpperCase())!)).toBe(true);
      }
    }
  });

  it('de-interleaves files that span many raw sectors (cooked, Mode 1, Mode 2, 2336)', async () => {
    const big = noise(20_000, 7);
    const iso = buildIso([
      { path: '/BIG.BIN', data: big },
      { path: '/A.TXT', data: utf8Encode('a') },
    ]);
    for (const bytes of [
      iso,
      cookedToRaw(iso),
      cookedToRaw(iso, 'mode2'),
      cookedToRaw(iso, '2336'),
    ]) {
      const { r, listing } = await isoOf(bytes);
      const e = listing.entries.find((x) => x.path === '/BIG.BIN')!;
      expect(same(await readIsoFile(r, e), big)).toBe(true);
      const blob = await isoFileBlob(r, e);
      expect(same(new Uint8Array(await blob.arrayBuffer()), big)).toBe(true);
    }
  });

  it('prefers Rock Ridge names, and can fall back to plain ISO 9660 names', async () => {
    const iso = buildIso(
      [
        { path: '/SRC/MAIN_C.C', longName: '/src/main.c', data: utf8Encode('int main;') },
        { path: '/FLAG.TXT', version: 2, data: utf8Encode('second version') },
      ],
      { rockRidge: true },
    );
    const { r, vol, listing } = await isoOf(iso);
    expect(listing.names).toBe('rockridge');
    expect(listing.entries.map((e) => e.path)).toEqual(['/FLAG.TXT', '/src', '/src/main.c']);
    const plain = await listIso(r, vol, 'iso');
    expect(plain.entries.map((e) => e.path)).toEqual(['/FLAG.TXT;2', '/SRC', '/SRC/MAIN_C.C']);
  });
});

describe('FAT12', () => {
  it('reads the boot sector of the sample', () => {
    const b = parseBpb(sample('disk-ftf-fat12.img'))!;
    expect([b.type, b.label, b.oem, b.clusterSize, b.clusterCount, b.fats]).toEqual([
      'FAT12',
      'FTF_FAT12',
      'FTFTEST',
      512,
      351,
      2,
    ]);
    expect(parseBpb(noise(512, 2))).toBeNull();
  });

  it('lists files with long names, and the deleted file with its first letter recovered', async () => {
    const vol = (await FatVolume.open(fileOf(sample('disk-ftf-fat12.img'))))!;
    const { entries, label } = await vol.list();
    expect(label).toBe('FTF_FAT12');
    expect(entries.map((e) => [e.path, e.dir, e.deleted, e.status, e.firstLetter])).toEqual([
      ['/NOTE.TXT', false, false, 'ok', 'kept'],
      ['/DOCS', true, false, 'ok', 'kept'],
      ['/DOCS/README.TXT', false, false, 'ok', 'kept'],
      ['/DOCS/A long file name.txt', false, false, 'ok', 'kept'],
      ['/old-secret.txt', false, true, 'recoverable', 'recovered'],
    ]);
    for (const spec of FAT_FILES.filter((f) => f.data)) {
      const e = entries.find((x) => x.path === spec.path)!;
      expect(same(await vol.readClusters(e.clusters, e.size), spec.data!)).toBe(true);
      expect(
        same(new Uint8Array(await vol.blobOf(e.clusters, e.size).arrayBuffer()), spec.data!),
      ).toBe(true);
    }
  });

  it('a deleted 8.3 name without a long name loses its first letter; reused clusters are flagged', async () => {
    const img = buildFat12([
      { path: '/KEEP.TXT', data: utf8Encode('k'.repeat(1500)) },
      { path: '/GONE.TXT', data: utf8Encode('gone but intact'), deleted: true },
      { path: '/CLOBBERD.TXT', data: utf8Encode('x'.repeat(600)), deleted: true, cluster: 3 },
    ]);
    const { entries } = await (await FatVolume.open(fileOf(img)))!.list();
    expect(entries.map((e) => [e.path, e.status, e.firstLetter])).toEqual([
      ['/KEEP.TXT', 'ok', 'kept'],
      ['/_ONE.TXT', 'recoverable', 'unknown'],
      ['/_LOBBERD.TXT', 'overwritten', 'unknown'],
    ]);
  });

  it('finds a FAT volume inside an MBR partition', async () => {
    const disk = withMbr(buildSampleFat(), 0x01, 63);
    expect(hasPartitionTable(disk.subarray(0, 1024))).toBe(true);
    expect(hasPartitionTable(buildSampleFat().subarray(0, 1024))).toBe(false);
    const f = fileOf(disk);
    const parts = (await readPartitions(f))!;
    expect(parts.map((p) => [p.index, p.type, p.typeName, p.start, p.size, p.bootable])).toEqual([
      [1, '0x01', 'FAT12', 63 * 512, 360 * 512, true],
    ]);
    const { entries } = await (await FatVolume.open(f, parts[0]!.start))!.list();
    expect(entries.find((e) => e.deleted)?.path).toBe('/old-secret.txt');
  });

  it('finds a FAT volume inside a GPT partition', async () => {
    const vol = buildSampleFat();
    const start = 40;
    const disk = new Uint8Array(start * 512 + vol.length);
    disk.set(vol, start * 512);
    const v = new DataView(disk.buffer);
    // Protective MBR, GPT header at LBA 1, one entry at LBA 2.
    disk.set([0, 0, 2, 0, 0xee, 0, 0, 0], 446);
    v.setUint32(446 + 8, 1, true);
    v.setUint32(446 + 12, disk.length / 512 - 1, true);
    disk.set([0x55, 0xaa], 510);
    disk.set(utf8Encode('EFI PART'), 512);
    v.setUint32(512 + 72, 2, true);
    v.setUint32(512 + 80, 4, true);
    v.setUint32(512 + 84, 128, true);
    const e = 1024;
    // EBD0A0A2-B9E5-4433-87C0-68B6B72699C7 (Microsoft basic data), stored mixed-endian.
    disk.set(
      [
        0xa2, 0xa0, 0xd0, 0xeb, 0xe5, 0xb9, 0x33, 0x44, 0x87, 0xc0, 0x68, 0xb6, 0xb7, 0x26, 0x99,
        0xc7,
      ],
      e,
    );
    v.setUint32(e + 32, start, true);
    v.setUint32(e + 40, start + vol.length / 512 - 1, true);
    [...'DATA'].forEach((c, i) => v.setUint16(e + 56 + i * 2, c.charCodeAt(0), true));
    const parts = (await readPartitions(fileOf(disk)))!;
    expect(parts.map((p) => [p.scheme, p.type, p.typeName, p.start, p.size, p.name])).toEqual([
      [
        'GPT',
        'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7',
        'Microsoft basic data',
        start * 512,
        vol.length,
        'DATA',
      ],
    ]);
    const fat = (await FatVolume.open(fileOf(disk), parts[0]!.start))!;
    expect((await fat.list()).entries.length).toBe(5);
  });

  it('computes the 8.3 checksum like VFAT', () => {
    // "OLD-SE~1TXT" — the value written by the fixture is checked by the listing test above.
    expect(sfnChecksum(utf8Encode('README  TXT'))).toBe(0x73);
  });
});
