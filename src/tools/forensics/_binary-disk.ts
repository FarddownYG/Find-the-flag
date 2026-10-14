/**
 * Disk image view of the Binary analyzer: CD images (cooked ISO or raw BIN without its .cue)
 * with their ISO 9660 file tree, and FAT12/16/32 volumes (whole image or inside an MBR / GPT
 * partition) with deleted files.
 *
 * Nothing big is copied unless asked: files of a cooked image or a FAT volume are Blob slices
 * of the input (free), while taking files out of raw 2352-byte sectors means copying their
 * user data; that stays within COPY_BUDGET unless "Rebuild from raw sectors" is ticked.
 */
import { ToolError } from '../../core/errors';
import type { LazyFile, Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { formatSize, utf8Encode } from '../../lib/bytes';
import {
  COPY_BUDGET,
  COPY_MAX,
  Extractor,
  hex,
  INLINE_MAX,
  readRange,
  stem,
  type FileOut,
} from './_binary-stream';
import { identifyFile, maybeCdAudio, modeName, type Identity } from './_binary-identify';
import {
  buildCue,
  cdAudioWavHeader,
  checkEdc,
  cueMode,
  isRawLayout,
  msf,
  SectorReader,
  USER,
  zeroSectors,
  type CdLayout,
  type CueTrack,
} from './_cd';
import { FatVolume, type FatEntry } from './_fat';
import { isoFileBlob, listIso, readIsoFile, type IsoEntry, type IsoVolume } from './_iso9660';

const T = toolT('binary-analyzer');

const MAX_FILES = 500;
const MAX_ROWS = 5000;

export interface DiskOptions {
  /** Copy files and the cooked .iso out of raw sectors beyond COPY_BUDGET (up to COPY_MAX). */
  rebuild: boolean;
}

export async function diskView(file: LazyFile, o: DiskOptions): Promise<Output[]> {
  if (file.size === 0) throw new ToolError(T('error.empty'));
  const id = await identifyFile(file);
  if (id.cd) return cdSection(file, id, id.cd, o.rebuild);
  if (id.bpb) {
    const vol = await FatVolume.open(file, 0);
    if (vol) {
      const x = new Extractor(MAX_FILES);
      const out = await fatSection(vol, T('label.fatVolume', { type: vol.bpb.type }), x);
      return [...out, ...capNotes(x, false)];
    }
  }
  if (id.partitions) return partitionSection(file, id);
  if (id.fs) return [{ type: 'note', level: 'info', text: T('note.fsNotParsed', { fs: id.fs }) }];
  if (maybeCdAudio(id, file.size)) {
    const name = `${stem(file.name, 'track')}.wav`;
    return [
      { type: 'note', level: 'info', text: T('note.cdAudio', { sectors: file.size / 2352 }) },
      {
        type: 'files',
        label: T('label.cdAudio'),
        files: [
          {
            name,
            data: new Uint8Array(0),
            blob: new Blob([cdAudioWavHeader(file.size) as BlobPart, file.blob]),
            note: T('note.cdAudioFile'),
          },
        ],
      },
    ];
  }
  return [{ type: 'note', level: 'info', text: T('note.noDisk') }];
}

/** Notes for the files an Extractor left out. */
function capNotes(x: Extractor, rebuild: boolean): Output[] {
  const out: Output[] = [];
  if (x.skippedCount) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.extractCapFiles', { count: x.skippedCount, files: x.maxFiles }),
    });
  }
  if (x.skippedCopy) {
    out.push({
      type: 'note',
      level: 'warn',
      text: rebuild
        ? T('note.copyCapRebuild', { count: x.skippedCopy, max: formatSize(x.copyBudget) })
        : T('note.copyCap', { count: x.skippedCopy, max: formatSize(x.copyBudget) }),
    });
  }
  return out;
}

// ---------------------------------------------------------------- CD / ISO 9660

const edcText = (raw: Uint8Array) => {
  const state = checkEdc(raw, 0);
  if (state === 'ok') return T('value.edcOk');
  if (state === 'zero') return T('value.edcZero');
  if (state === 'bad') return T('value.edcBad');
  return T('value.edcNone');
};

async function cdSection(
  file: LazyFile,
  id: Identity,
  l: CdLayout,
  rebuild: boolean,
): Promise<Output[]> {
  const reader = new SectorReader(file, l);
  const raw = l.sectorSize !== USER;
  const after = id.afterData;
  const audio = after?.kind === 'audio' ? after.sectors : 0;
  const layout: [string, string][] = [
    [T('kv.sectorSize'), String(l.sectorSize)],
    [T('kv.mode'), l.sectorSize === 2048 ? T('value.cooked') : modeName(l)],
    [T('kv.dataOffset'), String(l.dataOffset)],
    [T('kv.cueTrack'), cueMode(l) ?? T('value.noCue')],
    [
      T('kv.sectors'),
      l.remainder
        ? T('value.sectorsRest', { count: l.remainder, sectors: l.sectors })
        : String(l.sectors),
    ],
  ];
  if (after) layout.push([T('kv.dataTrack'), T('value.dataTrack', { count: l.dataSectors })]);
  if (audio > 0)
    layout.push([T('kv.audioTrack'), T('value.audioTrack', { count: audio, from: l.dataSectors })]);
  if (l.base) layout.push([T('kv.base'), `${l.base} (${hex(l.base)})`]);
  if (l.firstMsf) layout.push([T('kv.firstMsf'), l.firstMsf]);
  if (isRawLayout(l)) {
    layout.push([T('kv.edc'), edcText(await readRange(file, l.base + 16 * l.sectorSize, 2352))]);
  }
  if (l.sectorSize === 2448) layout.push([T('kv.subchannel'), T('value.subchannel')]);
  const out: Output[] = [{ type: 'kv', label: T('label.cdLayout'), entries: layout }];

  // The files of the volume come first in the copy budget: they are what people want.
  const x = new Extractor(MAX_FILES, rebuild && raw ? COPY_MAX : COPY_BUDGET);
  const iso = id.iso ? await isoSection(reader, id.iso, l, x) : null;

  const name = (file.name ?? (raw ? 'disk.bin' : 'disk.iso')).split(/[\\/]/).pop()!;
  const extra: FileOut[] = [];
  const mode = cueMode(l);
  if (mode) {
    let startFrame = 0;
    if (l.base && isRawLayout(l) && l.base % l.sectorSize === 0) startFrame = l.base / l.sectorSize;
    else if (l.base)
      out.push({ type: 'note', level: 'warn', text: T('note.cueBase', { base: l.base }) });
    const tracks: CueTrack[] = [{ mode, frame: startFrame }];
    if (audio > 0) tracks.push({ mode: 'AUDIO', frame: startFrame + l.dataSectors });
    const cue = buildCue(name, tracks);
    out.push({ type: 'text', label: T('label.cue'), value: cue });
    out.push({
      type: 'note',
      level: 'info',
      text:
        audio > 0
          ? T('note.cueAudio', { count: audio, index: msf(startFrame + l.dataSectors) })
          : T('note.cueGeneric'),
    });
    extra.push({
      name: `${stem(name, 'disk')}.cue`,
      data: utf8Encode(cue),
      note: audio > 0 ? T('note.cueFileAudio') : T('note.cueFile'),
    });
  } else {
    out.push({ type: 'note', level: 'info', text: T('note.cue2448') });
  }
  if (raw) {
    const bytes = l.dataSectors * USER;
    if (x.copyOk(bytes)) {
      extra.push({
        name: `${stem(name, 'disk')}.iso`,
        data: new Uint8Array(0),
        blob: await reader.blob(0, bytes),
        note: T('note.cookedFile', { sectors: l.dataSectors }),
      });
    } else {
      out.push({
        type: 'note',
        level: rebuild ? 'warn' : 'info',
        text: rebuild
          ? T('note.cookedTooBig', { size: formatSize(bytes), max: formatSize(COPY_MAX) })
          : T('note.cookedSkipped', { size: formatSize(bytes), max: formatSize(COPY_BUDGET) }),
      });
    }
  }
  if (audio > 0 && l.sectorSize === 2352) {
    // CD audio needs no copy: a WAV header in front of a slice of the input.
    const from = l.base + l.dataSectors * 2352;
    const size = audio * 2352;
    extra.push({
      name: `${stem(name, 'disk')}-audio.wav`,
      data: new Uint8Array(0),
      blob: new Blob([cdAudioWavHeader(size) as BlobPart, file.blob.slice(from, from + size)]),
      note: T('note.audioFile', { count: audio, from: l.dataSectors }),
    });
  }
  if (extra.length) out.push({ type: 'files', label: T('label.cueFiles'), files: extra });
  if (after && after.kind !== 'audio') {
    // Not audio: zeros, or a file glued onto the BIN after its data track.
    const count = file.size - after.start;
    const where = { count, offset: after.start, hex: hex(after.start) };
    if (after.kind === 'zeros') {
      out.push({ type: 'note', level: 'info', text: T('note.trailingPadding', where) });
    } else {
      const tail = new Extractor();
      const label = T('tail.afterTrack');
      const tailName = `${stem(name, 'disk')}-after-track.bin`;
      await tail.slice(file, after.start, file.size, tailName, label);
      out.push(
        { type: 'note', level: 'warn', text: T('note.afterTrack', where) },
        { type: 'files', label: T('label.trailingFile'), files: tail.files },
      );
    }
  }

  if (!iso) {
    out.push({ type: 'note', level: 'warn', text: T('note.noIso') });
    return [...out, ...capNotes(x, rebuild)];
  }
  return [...out, ...iso, ...capNotes(x, rebuild)];
}

/** Whether every extent of `e` lies inside the image. */
const inside = (e: IsoEntry, blocks: number) =>
  e.extents.every((x) => x.lba + Math.ceil(x.size / USER) <= blocks);

async function isoSection(
  r: SectorReader,
  vol: IsoVolume,
  l: CdLayout,
  x: Extractor,
): Promise<Output[]> {
  const out: Output[] = [];
  const listing = await listIso(r, vol);
  const info: [string, string][] = [
    [T('kv.volumeLabel'), vol.label || '-'],
    [
      T('kv.volumeSize'),
      `${vol.blocks} × ${vol.blockSize} = ${formatSize(vol.blocks * vol.blockSize)}`,
    ],
  ];
  if (vol.systemId) info.push([T('kv.systemId'), vol.systemId]);
  if (vol.publisher) info.push([T('kv.publisher'), vol.publisher]);
  if (vol.preparer) info.push([T('kv.preparer'), vol.preparer]);
  if (vol.application) info.push([T('kv.application'), vol.application]);
  if (vol.created) info.push([T('kv.created'), vol.created]);
  if (vol.modified) info.push([T('kv.modified'), vol.modified]);
  info.push(
    ['Joliet', vol.joliet ? T('value.jolietLevel', { level: vol.joliet.level }) : T('value.no')],
    ['Rock Ridge', listing.names === 'rockridge' ? T('value.yes') : T('value.no')],
    ['El Torito', vol.boot ? T('value.yes') : T('value.no')],
    [
      T('kv.names'),
      listing.names === 'rockridge'
        ? 'Rock Ridge'
        : listing.names === 'joliet'
          ? 'Joliet'
          : 'ISO 9660',
    ],
  );
  out.push({ type: 'kv', label: T('label.isoVolume'), entries: info });
  if (vol.blockSize !== USER)
    out.push({ type: 'note', level: 'warn', text: T('note.blockSize', { size: vol.blockSize }) });
  if (vol.blocks < r.blocks) {
    // Sectors no file points to: hidden data, or just the padding mastering tools add.
    const count = r.blocks - vol.blocks;
    const state = await zeroSectors(r, vol.blocks, r.blocks);
    out.push({
      type: 'note',
      level: state === 'data' ? 'warn' : 'info',
      text:
        state === 'zero'
          ? T('note.afterVolumeZeros', { count, lba: vol.blocks })
          : state === 'sampled'
            ? T('note.afterVolumeSampled', { count, lba: vol.blocks })
            : T('note.afterVolume', { count, lba: vol.blocks }),
    });
  } else if (vol.blocks > r.blocks) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.volumeTruncated', { count: vol.blocks - r.blocks }),
    });
  }
  const files = listing.entries.filter((e) => !e.dir);
  const shown = listing.entries.slice(0, MAX_ROWS);
  out.push({
    type: 'table',
    label: T('label.isoFiles', {
      count: files.length,
      dirs: listing.entries.length - files.length,
    }),
    columns: [T('col.path'), T('col.size'), T('col.date'), T('col.lba'), T('col.flags')],
    rows: shown.map((e) => [
      e.dir ? `${e.path}/` : e.path,
      e.dir ? '' : e.size,
      e.date,
      e.lba,
      [
        e.dir ? T('flag.dir') : '',
        e.hidden ? T('flag.hidden') : '',
        e.extents.length > 1 ? T('flag.extents', { count: e.extents.length }) : '',
        e.dir || inside(e, r.blocks) ? '' : T('flag.truncated'),
      ]
        .filter(Boolean)
        .join(', '),
    ]),
    highlight: shown.flatMap((e, i) => (e.hidden ? [i] : [])),
  });
  if (listing.entries.length > MAX_ROWS)
    out.push({ type: 'note', level: 'info', text: T('note.rowsCapped', { count: MAX_ROWS }) });
  if (listing.capped) out.push({ type: 'note', level: 'warn', text: T('note.entriesCapped') });
  if (listing.badDirs)
    out.push({ type: 'note', level: 'warn', text: T('note.badDirs', { count: listing.badDirs }) });
  const start = x.files.length;
  for (const e of files) {
    if (!x.room()) continue;
    const name = e.path.replace(/^\//, '');
    const note = inside(e, r.blocks) ? undefined : T('note.fileOutside');
    if (l.sectorSize === USER) {
      // A cooked image is sliced for free.
      x.files.push({ name, data: new Uint8Array(0), blob: await isoFileBlob(r, e), note });
      continue;
    }
    // Raw sectors must be copied to drop their headers: that counts against the budget.
    const size = e.extents.reduce(
      (n, ext) => n + Math.max(0, Math.min(ext.size, (r.blocks - ext.lba) * USER)),
      0,
    );
    if (!x.copyOk(size)) {
      x.skippedCopy++;
      continue;
    }
    x.files.push(
      size <= INLINE_MAX
        ? { name, data: await readIsoFile(r, e), note }
        : { name, data: new Uint8Array(0), blob: await isoFileBlob(r, e), note },
    );
  }
  const mine = x.files.slice(start);
  if (mine.length) out.push({ type: 'files', label: T('label.isoExtracted'), files: mine });
  return out;
}

// ---------------------------------------------------------------- FAT

const attrText = (a: number) =>
  [
    [0x01, 'R'],
    [0x02, 'H'],
    [0x04, 'S'],
    [0x08, 'V'],
    [0x10, 'D'],
    [0x20, 'A'],
  ]
    .filter(([bit]) => a & (bit as number))
    .map(([, c]) => c)
    .join('');

function statusText(e: FatEntry): string {
  if (!e.deleted) return e.status === 'empty' ? T('status.empty') : T('status.ok');
  switch (e.status) {
    case 'recoverable':
      return T('status.recoverable');
    case 'overwritten':
      return T('status.overwritten');
    case 'lost':
      return T('status.lost');
    case 'empty':
      return T('status.deletedEmpty');
    default:
      return T('status.deleted');
  }
}

async function fatSection(vol: FatVolume, title: string, x: Extractor): Promise<Output[]> {
  const b = vol.bpb;
  const { entries, label, capped } = await vol.list();
  const deleted = entries.filter((e) => e.deleted);
  const out: Output[] = [
    {
      type: 'kv',
      label: title,
      entries: [
        [T('kv.fatType'), b.type],
        [T('kv.volumeLabel'), label || b.label || '-'],
        [T('kv.oem'), b.oem || '-'],
        ...(b.serial ? ([[T('kv.serial'), b.serial]] as [string, string][]) : []),
        [T('kv.offset'), `${vol.offset} (${hex(vol.offset)})`],
        [T('kv.bytesPerSector'), String(b.bytesPerSector)],
        [T('kv.clusterSize'), `${b.clusterSize} (${b.sectorsPerCluster} × ${b.bytesPerSector})`],
        [T('kv.clusters'), String(b.clusterCount)],
        [T('kv.volumeSize'), formatSize(b.totalSectors * b.bytesPerSector)],
        [T('kv.fats'), String(b.fats)],
      ],
    },
  ];
  const shown = entries.slice(0, MAX_ROWS);
  out.push({
    type: 'table',
    label: T('label.fatFiles', { count: entries.length, deleted: deleted.length }),
    columns: [
      T('col.path'),
      T('col.size'),
      T('col.modified'),
      T('col.cluster'),
      T('col.attrs'),
      T('col.status'),
    ],
    rows: shown.map((e) => [
      e.dir ? `${e.path}/` : e.path,
      e.dir ? '' : e.size,
      e.date,
      e.cluster,
      attrText(e.attrs),
      statusText(e),
    ]),
    highlight: shown.flatMap((e, i) => (e.deleted ? [i] : [])),
  });
  if (entries.length > MAX_ROWS)
    out.push({ type: 'note', level: 'info', text: T('note.rowsCapped', { count: MAX_ROWS }) });
  if (deleted.length) {
    out.push({ type: 'note', level: 'warn', text: T('note.deleted', { count: deleted.length }) });
  }
  if (deleted.some((e) => e.firstLetter === 'unknown'))
    out.push({ type: 'note', level: 'info', text: T('note.firstLetter') });
  if (capped) out.push({ type: 'note', level: 'warn', text: T('note.entriesCapped') });
  const start = x.files.length;
  for (const e of entries) {
    // Empty files are extracted too (as empty files): their name can be the clue.
    if (e.dir || (e.size > 0 && !e.clusters.length)) continue;
    if (!x.room()) continue;
    const name = `${e.deleted ? 'deleted/' : ''}${e.path.replace(/^\//, '')}`;
    const note = e.deleted ? statusText(e) : undefined;
    // Cluster runs are slices of the image: nothing is copied.
    x.files.push(
      e.size === 0
        ? { name, data: new Uint8Array(0), note }
        : { name, data: new Uint8Array(0), blob: vol.blobOf(e.clusters, e.size), note },
    );
  }
  const mine = x.files.slice(start);
  if (mine.length) out.push({ type: 'files', label: T('label.fatExtracted'), files: mine });
  return out;
}

async function partitionSection(file: LazyFile, id: Identity): Promise<Output[]> {
  const parts = id.partitions!;
  const out: Output[] = [
    {
      type: 'table',
      label: T('label.partitions', { scheme: parts[0]?.scheme ?? 'MBR', count: parts.length }),
      columns: [
        T('col.index'),
        T('col.type'),
        T('col.start'),
        T('col.size'),
        T('col.boot'),
        T('col.name'),
      ],
      rows: parts.map((p) => [
        p.index,
        `${p.typeName} (${p.type})`,
        `${p.start} (${hex(p.start)})`,
        formatSize(p.size),
        p.bootable ? '*' : '',
        p.name,
      ]),
    },
  ];
  const x = new Extractor(MAX_FILES);
  for (const p of parts) {
    if (p.start >= file.size) {
      out.push({ type: 'note', level: 'warn', text: T('note.partitionOutside', { n: p.index }) });
      continue;
    }
    const vol = await FatVolume.open(file, p.start);
    if (vol)
      out.push(
        ...(await fatSection(vol, T('label.partitionFat', { n: p.index, type: vol.bpb.type }), x)),
      );
    else
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.partitionNotFat', { n: p.index, type: p.typeName }),
      });
  }
  return [...out, ...capNotes(x, false)];
}
