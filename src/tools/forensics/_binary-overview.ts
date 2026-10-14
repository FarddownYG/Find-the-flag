/**
 * Overview, Carving and Entropy views of the Binary analyzer. All three come from one
 * streamed pass over the whole file (signatures, entropy blocks, flag-like text, hashes).
 */
import { ToolError } from '../../core/errors';
import { KNOWN_PREFIX } from '../../core/flags';
import type { LazyFile, Output } from '../../core/types';
import { tOr } from '../../i18n';
import { signatureName, slug, toolT } from '../../i18n/tool-text';
import { formatSize, printableRatio, toHex } from '../../lib/bytes';
import { identify, type Signature } from '../../lib/signatures';
import { Extractor, hex, hex8, readRange, stem, windows } from './_binary-stream';
import {
  CarveCollector,
  EntropyCollector,
  FLAG_LOOKBEHIND,
  findFlagsIn,
  Hashes,
  knownTypes,
  MAX_BLOCKS,
  SCAN_OVERLAP,
  type CarveResult,
  type CarveSettings,
  type Carved,
  type FlagHit,
  type IgnoreHit,
} from './_binary-scan';
import { identifyFile, maybeCdAudio, verdict, type Identity } from './_binary-identify';
import { cueMode, hasSync, isRawLayout, SectorReader, USER, zeroSectors } from './_cd';
import { autoBlockSize, entropyChart, highRegions, histogramChart } from './entropy';

const T = toolT('binary-analyzer');

const MAX_FLAGS = 200;
/** Hashing costs about 6 ns per byte (MD5 + SHA-256): skipped above this size. */
export const HASH_MAX = 1 << 30;
const OVERVIEW_ROWS = 50;
const REGION_ROWS = 1000;

export interface PassResult {
  carve: CarveResult | null;
  entropy: EntropyCollector;
  flags: FlagHit[];
  digests: [string, string][];
  /** Offset of the last non-zero byte (-1 when the file is all zeros). */
  lastNonZero: number;
}

/** One read of the whole file feeding every collector. */
export async function fullPass(
  file: LazyFile,
  o: {
    block: number;
    carve: CarveSettings | null;
    hashes: boolean;
    flags: boolean;
    chunk?: number;
    ignore?: IgnoreHit;
  },
): Promise<PassResult> {
  const carver = o.carve ? new CarveCollector(file, o.carve.only, o.ignore) : null;
  const entropy = new EntropyCollector(file.size, o.block);
  const hashes = o.hashes ? await Hashes.create() : null;
  const flags: FlagHit[] = [];
  let lastNonZero = -1;
  for await (const w of windows(file, {
    chunk: o.chunk,
    overlap: SCAN_OVERLAP,
    lead: FLAG_LOOKBEHIND,
  })) {
    const own = w.bytes.subarray(w.ownStart, w.ownEnd);
    entropy.add(w.bytes, w.ownStart, w.ownEnd);
    hashes?.update(own);
    carver?.onWindow(w);
    if (o.flags && flags.length < MAX_FLAGS) {
      findFlagsIn(w.bytes, w.ownStart, w.ownEnd, w.offset, flags, MAX_FLAGS);
    }
    for (let k = w.ownEnd - 1; k >= w.ownStart; k--) {
      if (w.bytes[k] !== 0) {
        lastNonZero = w.offset + k;
        break;
      }
    }
  }
  const carve = carver && o.carve ? await carver.finish(o.carve) : null;
  return { carve, entropy, flags, digests: hashes?.digests() ?? [], lastNonZero };
}

/** How the end of a carved file was found, in the user's language. */
export function endText(f: Carved): string {
  const how = f.sig.endHow
    ? tOr(`tool.binary-analyzer.end.${slug(f.sig.endHow)}`, f.sig.endHow)
    : T('how.structure');
  switch (f.kind) {
    case 'structure':
      return how;
    case 'truncated':
      return T('how.truncated', { how });
    case 'next':
      return T('how.next');
    case 'eof':
      return T('how.eof');
    case 'tooBig':
      return T('how.tooBig');
  }
  return how;
}

const highlightFlags = (n: number) => Array.from({ length: n }, (_, i) => i);

function flagTable(flags: FlagHit[]): Output {
  return {
    type: 'table',
    label: T('label.flags', { count: flags.length }),
    columns: [T('col.offset'), T('col.hex'), T('col.encoding'), T('col.text')],
    rows: flags.map((f) => [f.offset, hex(f.offset), f.encoding, f.text]),
    highlight: highlightFlags(flags.length),
  };
}

function entropyWord(e: number): string {
  if (e >= 7.5) return T('entropy.high');
  if (e >= 5) return T('entropy.mid');
  return T('entropy.low');
}

/** What the first bytes of some data look like: a known file, text, or unknown. */
function describeData(head: Uint8Array): { label: string; ext: string } {
  const sig = identify(head).find((x) => !x.weak);
  if (sig) return { label: signatureName(sig), ext: sig.ext };
  if (printableRatio(head.subarray(0, 512)) > 0.9) return { label: T('tail.text'), ext: 'txt' };
  return { label: T('tail.unknown'), ext: 'bin' };
}

/**
 * The data after the end of the main structure: a classic hiding place, unless it is only
 * zero padding. In a raw CD image the sectors after the volume are judged by their user data
 * (their headers are never zero), and the audio sectors after the data track are told apart.
 */
async function trailing(
  file: LazyFile,
  id: Identity,
  carve: CarveResult | null,
  lastNonZero: number,
): Promise<{ notes: Output[]; files: Output[]; data: boolean }> {
  const notes: Output[] = [];
  const files: Output[] = [];
  let data = false;
  const extract = async (start: number, stop: number, label: string, ext: string) => {
    const x = new Extractor();
    await x.slice(file, start, stop, `${stem(file.name)}-after-${hex8(start)}.${ext}`, label);
    files.push({ type: 'files', label: T('label.trailingFile'), files: x.files });
  };
  const l = id.cd;
  if (l && id.iso && isRawLayout(l)) {
    const reader = new SectorReader(file, l);
    const after = l.dataSectors - id.iso.blocks;
    if (after > 0) {
      const start = l.base + id.iso.blocks * l.sectorSize;
      const stop = l.base + l.dataSectors * l.sectorSize;
      const state = await zeroSectors(reader, id.iso.blocks, l.dataSectors);
      if (state === 'data') {
        data = true;
        notes.push({
          type: 'note',
          level: 'warn',
          text: T('note.trailingSectors', { count: after, offset: start, hex: hex(start) }),
        });
        await extract(start, stop, T('note.rawSectorsFile'), 'bin');
      } else {
        const lba = id.iso.blocks;
        notes.push({
          type: 'note',
          level: 'info',
          text:
            state === 'zero'
              ? T('note.afterVolumeZeros', { count: after, lba })
              : T('note.afterVolumeSampled', { count: after, lba }),
        });
      }
    }
    // A file glued onto the BIN (or zeros) rather than audio: judged like any tail.
    if (id.afterData && id.afterData.kind !== 'audio') {
      const tail = await tailBytes(file, id.afterData.start, lastNonZero, notes, files, extract);
      return { notes, files, data: data || tail.data };
    }
    if (id.afterData) {
      notes.push({
        type: 'note',
        level: 'info',
        text: T('note.audioAfter', { count: id.afterData.sectors, from: l.dataSectors }),
      });
    }
    if (!l.remainder) return { notes, files, data };
    const start = file.size - l.remainder;
    if (hasSync(await readRange(file, start, 12), 0)) {
      // The start of one more sector: the image was cut, nothing was appended.
      notes.push({
        type: 'note',
        level: 'info',
        text: T('note.cutSector', { count: l.remainder, size: l.sectorSize }),
      });
      return { notes, files, data };
    }
    const tail = await tailBytes(file, start, lastNonZero, notes, files, extract);
    return { notes, files, data: data || tail.data };
  }
  let end = id.mainEnd;
  const c = carve?.container;
  if (end === null && c?.exact && c.kind === 'structure') end = c.end;
  if (end === null || end <= 0 || end >= file.size) return { notes, files, data };
  return tailBytes(file, end, lastNonZero, notes, files, extract);
}

/** Bytes [start, end of file): zero padding, or data to extract. */
async function tailBytes(
  file: LazyFile,
  start: number,
  lastNonZero: number,
  notes: Output[],
  files: Output[],
  extract: (start: number, stop: number, label: string, ext: string) => Promise<void>,
): Promise<{ notes: Output[]; files: Output[]; data: boolean }> {
  const size = file.size - start;
  // The full pass saw every byte: the tail is padding exactly when nothing non-zero follows.
  if (lastNonZero < start) {
    notes.push({
      type: 'note',
      level: 'info',
      text: T('note.trailingPadding', { size, count: size, offset: start, hex: hex(start) }),
    });
    return { notes, files, data: false };
  }
  const { label, ext } = describeData(await readRange(file, start, Math.min(size, 1 << 20)));
  notes.push({
    type: 'note',
    level: 'warn',
    text: T('note.trailing', { size, count: size, offset: start, hex: hex(start), what: label }),
  });
  await extract(start, file.size, label, ext);
  return { notes, files, data: true };
}

/**
 * In a raw CD image the volume descriptor sits 16 × 2352 (+ header) bytes in, so the cooked
 * ISO signature (CD001 at 0x8001) matches at a meaningless offset. Drop that echo before the
 * layout: it would claim the whole image and hide every file carved inside it.
 */
function rawIsoEcho(id: Identity): IgnoreHit {
  const l = id.cd;
  if (!l || l.sectorSize === USER) return () => false;
  const echo = l.base + 16 * l.sectorSize + l.dataOffset + 1 - 0x8001;
  return (start: number, sig: Signature) => sig.id === 'iso' && start === echo;
}

// ---------------------------------------------------------------- Overview

export async function overviewView(file: LazyFile): Promise<Output[]> {
  if (file.size === 0) throw new ToolError(T('error.empty'));
  const id = await identifyFile(file);
  const pass = await fullPass(file, {
    block: autoBlockSize(file.size),
    carve: { container: false, nested: false, only: new Set() },
    hashes: file.size <= HASH_MAX,
    flags: true,
    ignore: rawIsoEcho(id),
  });
  const ent = pass.entropy;
  const overall = ent.overall;
  const zeroShare = ent.counts[0]! / file.size;
  const out: Output[] = [];
  const ext = file.name?.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  const entries: [string, string][] = [
    [T('kv.verdict'), verdict(id, overall, zeroShare)],
    [T('kv.size'), `${formatSize(file.size)} (${file.size} ${T('value.bytes')})`],
    [T('kv.firstBytes'), toHex(id.head.subarray(0, 16), ' ')],
  ];
  if (id.sig && !id.cd && !id.bpb && !id.partitions) {
    entries.push([T('kv.detected'), `${signatureName(id.sig)} (.${id.sig.ext})`]);
    if (ext && ext !== id.sig.ext && id.sigSure && ext !== 'bin') {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.extension', { ext, expected: id.sig.ext }),
      });
    }
  }
  entries.push([
    T('kv.entropy'),
    `${overall.toFixed(3)} ${T('value.bitsPerByte')} — ${entropyWord(overall)}`,
  ]);
  for (const [name, digest] of pass.digests) entries.push([name, digest]);
  if (!pass.digests.length)
    entries.push([T('kv.hashes'), T('value.hashesSkipped', { max: '1 GiB' })]);
  out.unshift({ type: 'kv', label: T('label.identification'), entries });

  // Disk structures, in a few lines (the Disk image view has the details).
  const disk: [string, string][] = [];
  if (id.cd) {
    disk.push([T('kv.sectorSize'), `${id.cd.sectorSize}`]);
    if (id.cd.sectorSize !== 2048)
      disk.push([T('kv.cueTrack'), cueMode(id.cd) ?? T('value.noCue')]);
    disk.push([T('kv.sectors'), String(id.cd.sectors)]);
    if (id.afterData?.kind === 'audio') {
      disk.push([
        T('kv.audioTrack'),
        T('value.audioTrack', { count: id.afterData.sectors, from: id.cd.dataSectors }),
      ]);
    }
  }
  if (id.iso) {
    disk.push(
      [T('kv.volumeLabel'), id.iso.label || '-'],
      [T('kv.volumeSize'), `${id.iso.blocks} × ${id.iso.blockSize}`],
    );
    if (id.iso.joliet) disk.push(['Joliet', T('value.yes')]);
  }
  if (id.bpb) disk.push([T('kv.fatType'), id.bpb.type], [T('kv.volumeLabel'), id.bpb.label || '-']);
  if (id.partitions) {
    for (const p of id.partitions.slice(0, 8)) {
      disk.push([
        T('kv.partition', { n: p.index }),
        `${p.typeName} · ${formatSize(p.size)} @ ${hex(p.start)}`,
      ]);
    }
  }
  if (disk.length) out.push({ type: 'kv', label: T('label.diskSummary'), entries: disk });

  const carve = pass.carve!;
  if (carve.found.length) {
    out.push({
      type: 'table',
      label: T('label.embedded', { count: carve.found.length }),
      columns: [T('col.offset'), T('col.hex'), T('col.type'), T('col.size'), T('col.endFoundBy')],
      rows: carve.found
        .slice(0, OVERVIEW_ROWS)
        .map((f) => [f.start, hex(f.start), signatureName(f.sig), f.end - f.start, endText(f)]),
      highlight: carve.found.slice(0, OVERVIEW_ROWS).flatMap((f, i) => (f.exact ? [i] : [])),
    });
    if (carve.found.length > OVERVIEW_ROWS) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.moreEmbedded', { count: carve.found.length - OVERVIEW_ROWS }),
      });
    }
  } else {
    out.push({ type: 'note', level: 'info', text: T('note.noEmbedded') });
  }

  const tail = await trailing(file, id, carve, pass.lastNonZero);
  out.push(...tail.notes, ...tail.files);

  if (pass.flags.length) {
    // Known prefixes (flag{, CTF{, HTB{…) first, each group in file order.
    const known = (f: FlagHit) => Number(!KNOWN_PREFIX.test(f.text));
    out.push(flagTable([...pass.flags].sort((a, b) => known(a) - known(b) || a.offset - b.offset)));
  }

  let lowest = 8;
  let highest = 0;
  for (const b of ent.blocks) {
    lowest = Math.min(lowest, b.entropy);
    highest = Math.max(highest, b.entropy);
  }
  const regions = highRegions(ent.blocks, 7.5);
  out.push({
    type: 'kv',
    label: T('label.entropySummary'),
    entries: [
      [T('kv.overall'), `${overall.toFixed(4)} ${T('value.bitsPerByte')}`],
      [T('kv.blockSize'), `${ent.block} (${ent.blocks.length})`],
      [T('kv.lowHigh'), `${lowest.toFixed(3)} / ${highest.toFixed(3)}`],
      [T('kv.highRegions'), String(regions.length)],
      [T('kv.zeroBytes'), `${(zeroShare * 100).toFixed(1)} %`],
    ],
  });

  const facts = {
    found: carve.found.length,
    flags: pass.flags.length,
    tail: tail.data,
    regions: regions.length,
  };
  for (const h of hints(id, facts, overall, file.size)) {
    out.push({ type: 'note', level: 'info', text: h });
  }
  return out;
}

function hints(
  id: Identity,
  f: { found: number; flags: number; tail: boolean; regions: number },
  overall: number,
  size: number,
): string[] {
  const out: string[] = [];
  if (id.cd?.iso || id.iso) out.push(T('hint.disk'));
  if (id.cd && id.cd.sectorSize !== 2048 && id.cd.sectorSize !== 2448)
    out.push(id.cd.iso ? T('hint.rawCue') : T('hint.rawNoIso'));
  if (id.afterData?.kind === 'audio') out.push(T('hint.audio'));
  if (id.bpb || id.partitions) out.push(T('hint.fat'));
  if (id.fs) out.push(T('hint.fs', { fs: id.fs }));
  if (f.found) out.push(T('hint.carve', { count: f.found }));
  if (f.tail) out.push(T('hint.trailing'));
  if (f.flags) out.push(T('hint.flags'));
  const structured = id.cd || id.bpb || id.partitions || id.fs || (id.sig && id.sigSure);
  if (!structured) {
    if (maybeCdAudio(id, size)) out.push(T('hint.cdAudio'));
    if (id.printable > 0.95) out.push(T('hint.text'));
    else if (overall >= 7.5) out.push(T('hint.encrypted'));
    else out.push(T('hint.numeric'));
  } else if (f.regions > 0 && overall < 7.5) {
    out.push(T('hint.entropy'));
  }
  return out;
}

// ---------------------------------------------------------------- Carving

/** "zip, png .gz" → set of names; unknown names are an error. */
export function parseTypes(raw: string): Set<string> {
  const names = raw
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((x) => x.replace(/^\./, ''))
    .filter(Boolean);
  const known = knownTypes();
  const unknown = names.filter((x) => !known.has(x));
  if (unknown.length) throw new ToolError(T('error.types', { types: unknown.join(', ') }));
  return new Set(names);
}

export async function carveView(
  file: LazyFile,
  o: { container: boolean; nested: boolean; types: string },
): Promise<Output[]> {
  if (file.size === 0) throw new ToolError(T('error.empty'));
  const only = parseTypes(o.types);
  const id = await identifyFile(file);
  const pass = await fullPass(file, {
    block: autoBlockSize(file.size),
    carve: { container: o.container, nested: o.nested, only },
    hashes: false,
    flags: false,
    ignore: rawIsoEcho(id),
  });
  const res = pass.carve!;
  const out: Output[] = [];
  if (id.cd && id.cd.sectorSize !== USER) {
    out.push({ type: 'note', level: 'warn', text: T('note.carveRaw', { size: id.cd.sectorSize }) });
  }
  const c = res.container;
  if (c?.exact && c.kind === 'structure' && c.end < file.size) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.containerEnds', {
        name: signatureName(c.sig),
        end: c.end,
        hex: hex(c.end),
        count: file.size - c.end,
      }),
    });
  }
  if (res.found.length) {
    out.push({
      type: 'table',
      label: T('label.carved', { count: res.found.length }),
      columns: [
        T('col.offset'),
        T('col.hex'),
        T('col.type'),
        T('col.size'),
        T('col.endsAt'),
        T('col.endFoundBy'),
      ],
      rows: res.found.map((f) => [
        f.start,
        hex(f.start),
        signatureName(f.sig),
        f.end - f.start,
        hex(f.end),
        endText(f),
      ]),
      highlight: res.found.flatMap((f, i) => (f.exact && f.start > 0 ? [i] : [])),
    });
    // Carved files are slices of the input: nothing is copied beyond small ones.
    const x = new Extractor();
    for (const f of res.found) {
      await x.slice(
        file,
        f.start,
        f.end,
        `${hex8(f.start)}.${f.sig.ext}`,
        `${signatureName(f.sig)} · ${endText(f)}`,
      );
    }
    out.push({ type: 'files', label: T('label.carvedFiles'), files: x.files });
  } else {
    out.push({
      type: 'note',
      level: 'info',
      text: c
        ? T('note.onlyContainer', { name: signatureName(c.sig) })
        : T('note.noEmbeddedCarve', { count: file.size }),
    });
  }
  if (res.nestedSkipped)
    out.push({ type: 'note', level: 'info', text: T('note.nested', { count: res.nestedSkipped }) });
  if (res.zipEntries)
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.zipEntries', { count: res.zipEntries }),
    });
  if (res.capped)
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.carveCapped', { count: res.found.length }),
    });
  return out;
}

// ---------------------------------------------------------------- Entropy

export async function entropyView(
  file: LazyFile,
  o: { block: number; threshold: number },
): Promise<Output[]> {
  if (file.size === 0) throw new ToolError(T('error.empty'));
  const block = o.block > 0 ? Math.floor(o.block) : autoBlockSize(file.size);
  const count = Math.ceil(file.size / block);
  if (count > MAX_BLOCKS) {
    throw new ToolError(
      T('error.blocks', { block, count, min: Math.ceil(file.size / MAX_BLOCKS) }),
    );
  }
  const pass = await fullPass(file, { block, carve: null, hashes: false, flags: false });
  const ent = pass.entropy;
  const regions = highRegions(ent.blocks, o.threshold);
  let top = 0;
  let distinct = 0;
  for (let v = 0; v < 256; v++) {
    if (ent.counts[v]! > 0) distinct++;
    if (ent.counts[v]! > ent.counts[top]!) top = v;
  }
  const out: Output[] = [
    {
      type: 'kv',
      label: T('label.entropySummary'),
      entries: [
        [
          T('kv.overall'),
          `${ent.overall.toFixed(4)} ${T('value.bitsPerByte')} — ${entropyWord(ent.overall)}`,
        ],
        [T('kv.blockSize'), `${block} (${ent.blocks.length})`],
        [T('kv.distinct'), `${distinct} / 256`],
        [
          T('kv.commonByte'),
          `0x${top.toString(16).padStart(2, '0')} (${((ent.counts[top]! / file.size) * 100).toFixed(1)} %)`,
        ],
      ],
    },
    {
      type: 'image',
      label: T('label.entropyChart', { threshold: o.threshold.toFixed(1) }),
      image: entropyChart(ent.blocks, file.size, o.threshold, 'bars'),
      filename: 'entropy.png',
    },
  ];
  if (regions.length) {
    out.push({
      type: 'table',
      label: T('label.regions', { count: regions.length }),
      columns: [T('col.start'), T('col.end'), T('col.size'), T('col.mean'), T('col.looksLike')],
      rows: regions
        .slice(0, REGION_ROWS)
        .map((r) => [
          hex(r.start),
          hex(r.end),
          r.end - r.start,
          r.mean.toFixed(3),
          r.mean >= 7.9 ? T('entropy.random') : T('entropy.compressed'),
        ]),
    });
    if (regions.length > REGION_ROWS) {
      out.push({ type: 'note', level: 'info', text: T('note.rowsCapped', { count: REGION_ROWS }) });
    }
  } else {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.noRegions', { threshold: o.threshold.toFixed(1) }),
    });
  }
  out.push({
    type: 'image',
    label: T('label.histogram'),
    image: histogramChart(ent.counts, file.size),
    filename: 'histogram.png',
  });
  return out;
}
