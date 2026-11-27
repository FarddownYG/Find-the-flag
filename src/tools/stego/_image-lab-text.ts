/**
 * The written parts of the image lab: facts about the file, its structure and repair, the zsteg
 * style LSB scan, strings, and the password tools it cannot run for you. Each helper returns
 * ready outputs; everything else (metadata, hashes, GPS) comes from the image analyzer.
 */
import type { FileInput, ImageInput, Output, RgbaImage } from '../../core/types';
import { signatureName, toolT } from '../../i18n/tool-text';
import { formatSize } from '../../lib/bytes';
import { extract, flatten } from '../forensics/_extract';
import { findStrings, type FoundString } from '../forensics/strings';
import { channelValues, histogram, statsFromHistogram, type Channel } from './_channel';
import { analyseLayout, imageSignature, regionAt } from './_image-analyzer-layout';
import { flagsIn, oneLine, strongFlag } from './_image-analyzer-findings';
import { parseJpeg } from './_jpeg';
import { colorTypeName, KNOWN_CHUNKS, parsePng, readIhdr } from './_png';
import { DEFAULT_OPTIONS, operate } from './_png-surgeon-core';
import { parseTolerant } from './_png-surgeon-parse';
import { hasAlpha } from './_pixels';
import imageAnalyzer from './image-analyzer';
import { hitLabel, scan } from './lsb';

const T = toolT('image-lab');
const AN = toolT('image-analyzer');

/** Rows kept in the long tables; "show more" lifts the cap. */
export const SHORT = 12;
export const LONG = 200;
/** Plain readable text shorter than this in an LSB stream is chance. */
const MIN_TEXT_RUN = 16;
const SPARK = '▁▂▃▄▅▆▇█';

const labelled = (section: string, outputs: Output[]): Output[] =>
  outputs.map((o) =>
    'label' in o && o.label ? ({ ...o, label: `${section} · ${o.label}` } as Output) : o,
  );

/** Distinct colours: one bit per 24-bit colour in a 2 MiB bitmap. */
function uniqueColours(img: RgbaImage): number {
  const seen = new Uint32Array(1 << 19);
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const k = (img.data[i * 4]! << 16) | (img.data[i * 4 + 1]! << 8) | img.data[i * 4 + 2]!;
    const word = k >>> 5;
    const bit = 1 << (k & 31);
    if (!(seen[word]! & bit)) {
      seen[word]! |= bit;
      n++;
    }
  }
  return n;
}

function sparkline(hist: Uint32Array, bins = 16): string {
  const per = 256 / bins;
  const sums = Array.from({ length: bins }, (_, b) => {
    let s = 0;
    for (let v = Math.floor(b * per); v < Math.floor((b + 1) * per); v++) s += hist[v]!;
    return s;
  });
  const max = Math.max(...sums, 1);
  return sums.map((s) => SPARK[Math.min(7, Math.floor((s / max) * 7.999))]!).join('');
}

/** Type, size, depth, colour type, colours and per-channel statistics. */
export function infoOutputs(input: ImageInput, shownAs: { w: number; h: number } | null): Output[] {
  const { bytes, image } = input;
  const sig = imageSignature(bytes);
  const png = parsePng(bytes);
  const ihdrChunk = png?.chunks.find((c) => c.type === 'IHDR');
  const ihdr = ihdrChunk && ihdrChunk.length >= 13 ? readIhdr(bytes, ihdrChunk.dataStart) : null;
  const alpha = hasAlpha(image);
  const entries: [string, string][] = [
    [T('kv.type'), sig ? signatureName(sig) : T('value.unknown')],
    [T('kv.size'), formatSize(bytes.length)],
    [T('kv.dimensions'), `${image.width} × ${image.height}`],
  ];
  if (ihdr) {
    entries.push(
      [T('kv.depth'), T('value.bitsPerChannel', { bits: ihdr.bitDepth })],
      [T('kv.colorType'), colorTypeName(ihdr.colorType) ?? String(ihdr.colorType)],
    );
    if (ihdr.interlace) entries.push([T('kv.interlace'), 'Adam7']);
  }
  entries.push(
    [T('kv.alpha'), alpha ? T('value.alphaUsed') : T('value.alphaOpaque')],
    [T('kv.colours'), String(uniqueColours(image))],
  );
  if (shownAs) entries.push([T('kv.analysedAt'), `${shownAs.w} × ${shownAs.h}`]);

  const channels: Channel[] = alpha ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b'];
  const rows = channels.map((c) => {
    const hist = histogram(channelValues(image, c));
    const s = statsFromHistogram(hist);
    const n = image.width * image.height;
    let sq = 0;
    for (let v = 0; v < 256; v++) sq += hist[v]! * (v - s.mean) ** 2;
    return [
      c.toUpperCase(),
      s.min,
      s.max,
      s.mean.toFixed(1),
      Math.sqrt(sq / Math.max(1, n)).toFixed(1),
      hist.reduce((k, x) => k + (x ? 1 : 0), 0),
      sparkline(hist),
    ];
  });
  return [
    { type: 'kv', label: `${T('section.info')} · ${T('label.image')}`, entries },
    {
      type: 'table',
      label: `${T('section.info')} · ${T('label.channels')}`,
      columns: [
        T('col.channel'),
        T('col.min'),
        T('col.max'),
        T('col.mean'),
        T('col.stddev'),
        T('col.distinct'),
        T('col.histogram'),
      ],
      rows,
    },
  ];
}

/** Metadata, GPS, hashes, appended data and embedded files: the image analyzer's own blocks. */
export async function analyzerOutputs(input: FileInput): Promise<Output[]> {
  const stringsLabel = AN('label.strings');
  const result = await imageAnalyzer.run(
    { bytes: input.bytes, name: input.name },
    { compare: null, minLength: 12 },
  );
  // Pictures are the gallery's job and strings have a section of their own here.
  const privacy = AN('note.privacy');
  const kept = result.filter(
    (o) =>
      o.type !== 'picture' &&
      !(o.type === 'table' && o.label === stringsLabel) &&
      !(o.type === 'note' && o.text === privacy),
  );
  return labelled(T('section.info'), kept);
}

export interface Structure {
  out: Output[];
  /** The image decoded from the repaired file, when the repair changed its size. */
  repaired: RgbaImage | null;
}

/** PNG chunks with CRC, JPEG segments, the IHDR repair, and what the extractor finds inside. */
export async function structureOutputs(input: ImageInput): Promise<Structure> {
  const { bytes, image } = input;
  const section = T('section.structure');
  const out: Output[] = [];
  let repaired: RgbaImage | null = null;

  const tol = parseTolerant(bytes);
  if (tol) {
    const rows = tol.chunks.map((c) => [
      c.index,
      c.type,
      c.offset,
      c.length,
      c.crcOk ? 'ok' : T('value.crcBad'),
      c.afterIend ? T('value.afterIend') : (KNOWN_CHUNKS[c.type]?.() ?? T('value.unknownChunk')),
    ]);
    const highlight = tol.chunks.flatMap((c, i) => (!c.crcOk || c.afterIend ? [i] : []));
    out.push({
      type: 'table',
      label: `${section} · ${T('label.chunks')}`,
      columns: [
        T('col.n'),
        T('col.type'),
        T('col.offset'),
        T('col.length'),
        'CRC',
        T('col.meaning'),
      ],
      rows: rows.slice(0, LONG),
      highlight: highlight.filter((i) => i < LONG),
    });
    const ihdr = tol.chunks.find((c) => c.type === 'IHDR' && c.validType && !c.afterIend);
    if (ihdr && ihdr.length >= 13 && !ihdr.crcOk) {
      const fix = operate(bytes, DEFAULT_OPTIONS);
      const stored = fix?.stored;
      const final = fix?.final;
      if (fix && stored && final && fix.image) {
        const changed = final.width !== stored.width || final.height !== stored.height;
        out.push({
          type: 'note',
          level: 'warn',
          text: changed
            ? T('note.ihdrRepaired', {
                stored: `${stored.width}×${stored.height}`,
                fixed: `${final.width}×${final.height}`,
              })
            : T('note.ihdrCrc'),
        });
        if (fix.candidates.length > 1) {
          out.push({
            type: 'kv',
            label: `${section} · ${T('label.ihdrCandidates')}`,
            entries: fix.candidates
              .slice(0, 6)
              .map((c) => [c.kind, `${c.ihdr.width}×${c.ihdr.height}`] as [string, string]),
          });
        }
        if (fix.rebuilt) {
          out.push({
            type: 'files',
            label: `${section} · ${T('label.repair')}`,
            files: [{ name: 'repaired.png', data: fix.rebuilt, note: T('file.repaired') }],
          });
        }
        if (fix.image.width !== image.width || fix.image.height !== image.height) {
          repaired = fix.image;
        }
      } else {
        out.push({ type: 'note', level: 'warn', text: T('note.ihdrUnrepaired') });
      }
    }
  }
  const jpeg = tol ? null : parseJpeg(bytes);
  if (jpeg) {
    out.push({
      type: 'table',
      label: `${section} · ${T('label.segments')}`,
      columns: [T('col.n'), T('col.type'), T('col.offset'), T('col.length')],
      rows: jpeg.segments.slice(0, LONG).map((s) => [s.index, s.name, s.offset, s.length]),
    });
    for (const p of jpeg.problems) out.push({ type: 'note', level: 'warn', text: p });
  }

  const tree = await extract(bytes, {
    name: input.name,
    maxDepth: 3,
    maxNodes: 300,
    maxBytes: 64 << 20,
    maxWork: 128 << 20,
  });
  const nodes = flatten(tree.root).filter((n) => n.depth > 0);
  if (nodes.length) {
    out.push({
      type: 'table',
      label: `${section} · ${T('label.extracted')}`,
      columns: [T('col.path'), T('col.type'), T('col.size'), T('col.how')],
      rows: nodes.slice(0, 30).map(({ node }) => [node.path, node.format, node.size, node.how]),
    });
    if (nodes.length > 30) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.moreNodes', { count: nodes.length - 30 }),
      });
    }
  }
  if (tree.flags.length) {
    out.push({
      type: 'note',
      level: 'success',
      text: T('note.flags', { flags: tree.flags.join(' · ') }),
    });
  }
  return { out, repaired };
}

export interface Lsb {
  out: Output[];
  /** The best readable result, for the writeup. */
  best: string | null;
}

/** zsteg style scan of the full-resolution pixels: readable text and file signatures first. */
export function lsbOutputs(image: RgbaImage, showAll: boolean): Lsb {
  const section = T('section.hidden');
  const { hits, tried } = scan(image);
  const seen = new Set<string>();
  const unique = hits.filter((h) => {
    // A handful of printable bytes in 8 KiB of noise happens by chance: not a result.
    if (h.kind === 'text' && h.score < MIN_TEXT_RUN && !showAll) return false;
    const key = `${h.what}\u0000${h.preview}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const out: Output[] = [];
  if (!unique.length) {
    out.push({ type: 'note', level: 'info', text: T('note.lsbNone', { count: tried }) });
    return { out, best: null };
  }
  const shown = unique.slice(0, showAll ? LONG : SHORT);
  const top = unique[0]!;
  out.push({
    type: 'note',
    level: top.kind === 'flag' || top.kind === 'file' ? 'success' : 'info',
    text: T('note.lsbFound', { count: unique.length, tried, what: top.what }),
  });
  out.push({
    type: 'table',
    label: `${section} · ${T('label.lsb')}`,
    columns: [T('col.settings'), T('col.what'), T('col.preview')],
    rows: shown.map((h) => [hitLabel(h), h.what, h.preview]),
    highlight: shown.flatMap((h, i) => (h.kind === 'flag' || h.kind === 'file' ? [i] : [])),
  });
  if (unique.length > shown.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.moreLines', { count: unique.length - shown.length }),
    });
  }
  return { out, best: `${hitLabel(top)}: ${top.preview}` };
}

export interface Strings {
  out: Output[];
  found: FoundString[];
}

/** Strings of the file, flag-like first; runs inside compressed pixels need to be long. */
export function stringsOutputs(bytes: Uint8Array, min: number, showAll: boolean): Strings {
  const section = T('section.hidden');
  const regions = analyseLayout(bytes).regions;
  const all = findStrings(bytes, min);
  const flagged: FoundString[] = [];
  const rest: FoundString[] = [];
  for (const s of all) {
    const noise = regionAt(regions, s.offset)?.imageData === true;
    const flags = flagsIn(s.text).filter((f) => !noise || strongFlag(f));
    if (flags.length) flagged.push(s);
    else if (!noise || s.text.length >= 20) rest.push(s);
  }
  const ordered = [...flagged, ...rest];
  const shown = ordered.slice(0, showAll ? LONG : SHORT);
  const out: Output[] = [];
  if (!ordered.length) {
    out.push({ type: 'note', level: 'info', text: T('note.noStrings', { min }) });
    return { out, found: all };
  }
  out.push({
    type: 'table',
    label: `${section} · ${T('label.strings', { min })}`,
    columns: [T('col.offset'), T('col.encoding'), T('col.string')],
    rows: shown.map((s) => [`0x${s.offset.toString(16)}`, s.encoding, oneLine(s.text, 300)]),
    highlight: shown.flatMap((s, i) => (flagged.includes(s) ? [i] : [])),
  });
  if (ordered.length > shown.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.moreLines', { count: ordered.length - shown.length }),
    });
  }
  return { out, found: all };
}

const HINT =
  /(pass(?:word|phrase|wd)?|pwd|mdp|mot de passe|secret|key|cl[eé])\s*[:=]\s*(\S[^\r\n]{0,60})/i;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Honest cards for the tools that need a password: the exact local command, never run here. */
export function passwordOutputs(
  bytes: Uint8Array,
  name: string | undefined,
  found: FoundString[],
): Output[] {
  const id = imageSignature(bytes)?.id ?? '';
  const file = quote(name || 'image');
  const hints = [
    ...new Set(
      found
        .map((s) => HINT.exec(s.text)?.[2]?.trim())
        .filter((v): v is string => v !== undefined && v.length > 0),
    ),
  ].slice(0, 6);
  const tools: [string, boolean, string[]][] = [
    [
      'steghide',
      id === 'jpeg' || id === 'bmp',
      [`steghide info ${file}`, `steghide extract -sf ${file} -p ${quote(hints[0] ?? 'PASSWORD')}`],
    ],
    ['stegseek', id === 'jpeg', [`stegseek ${file} rockyou.txt`]],
    ['outguess', id === 'jpeg', [`outguess -k ${quote(hints[0] ?? 'KEY')} -r ${file} out.txt`]],
    [
      'OpenStego',
      id === 'png' || id === 'bmp',
      [`java -jar openstego.jar extract -sf ${file} -xd . -p ${quote(hints[0] ?? 'PASSWORD')}`],
    ],
  ];
  const out: Output[] = [
    { type: 'note', level: 'info', text: T('note.passwordTools') },
    {
      type: 'kv',
      label: `${T('section.password')} · ${T('label.commands')}`,
      entries: tools.map(([tool, applies, cmds]) => [
        `${tool} (${applies ? T('value.applies') : T('value.notThisFormat')})`,
        cmds.join('\n'),
      ]),
    },
  ];
  out.push(
    hints.length
      ? {
          type: 'kv',
          label: `${T('section.password')} · ${T('label.hints')}`,
          entries: hints.map((v) => [T('kv.candidate'), v]),
        }
      : { type: 'note', level: 'info', text: T('note.noHints') },
  );
  return out;
}
