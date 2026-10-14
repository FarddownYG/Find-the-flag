import { md5, sha1, sha256 } from 'hash-wasm';
import { defineTool, file, number } from '../../core/define';
import { ToolError } from '../../core/errors';
import { mapLinks } from '../../core/result-text';
import type { FileInput, Output, RgbaImage } from '../../core/types';
import { formatSize, utf8Encode } from '../../lib/bytes';
import { findStrings, type FoundString } from '../forensics/strings';
import { errorText, exifr } from './_exif';
import {
  cameraAndDate,
  decodedText,
  Findings,
  flagsIn,
  oneLine,
  strongFlag,
  textFindings,
} from './_image-analyzer-findings';
import {
  analyseLayout,
  embeddedFiles,
  imageSignature,
  locate,
  regionAt,
  webpMetadataAsJpeg,
  webpSize,
  withRegion,
  type EmbeddedFile,
  type Region,
} from './_image-analyzer-layout';
import {
  readGps,
  readMetadata,
  type GpsFix,
  type GpsInfo,
  type ImageMeta,
  type MetaRow,
} from './_image-analyzer-meta';
import {
  compareThumbnail,
  decodeJpeg,
  decodeMain,
  type ThumbComparison,
} from './_image-analyzer-thumb';
import { describeTail } from './image-structure';

const PRIVACY = 'Everything below was computed in this tab — the file was not uploaded anywhere.';
const THUMB_MISMATCH =
  'The EXIF thumbnail does not match the main image — it may show the original picture.';
const MAX_STRINGS = 3000;
/** Strings table cells: long strings are shown in full in All metadata / text blocks. */
const MAX_STRING_CELL = 1000;
/** All metadata cells: full values, up to a size a table can still show. */
const MAX_META_CELL = 20000;
/** Values longer than this get a copyable text block of their own. */
const LONG_VALUE = 240;
const MAX_LONG_BLOCKS = 12;
/** Strings inside compressed pixels shorter than this are coincidences: not listed. */
const NOISE_STRING = 20;

/** Formats a browser can draw from the raw bytes. */
const BROWSER_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
};

/** Magic numbers, to name a file that is cut inside its own header. */
const HEADERS: [string, number[]][] = [
  ['JPEG', [0xff, 0xd8, 0xff]],
  ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['GIF', [0x47, 0x49, 0x46, 0x38]],
  ['TIFF', [0x49, 0x49, 0x2a, 0x00]],
  ['TIFF', [0x4d, 0x4d, 0x00, 0x2a]],
  ['WebP (RIFF)', [0x52, 0x49, 0x46, 0x46]],
];

const hex = (n: number) => `0x${n.toString(16)}`;
const at = (n: number) => `${n} (${hex(n)})`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortName = (name: string) => name.replace(/ \(.*$/, '');
const cut = (s: string, max: number, rest: string) =>
  s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters ${rest})` : s;

function stemOf(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  return base.replace(/\.[^.]*$/, '') || 'image';
}

// ---------------------------------------------------------------- hashes

interface Digests {
  md5: string;
  sha1: string;
  sha256: string;
}

async function digests(b: Uint8Array): Promise<Digests> {
  const [m, s1, s2] = await Promise.all([md5(b), sha1(b), sha256(b)]);
  return { md5: m, sha1: s1, sha256: s2 };
}

function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

interface Comparison {
  entries: [string, string][];
  /** One line for Findings. */
  summary: string;
}

function comparison(a: Uint8Array, ha: Digests, other: FileInput, hb: Digests): Comparison {
  const b = other.bytes;
  const name = other.name ?? 'the second file';
  const diff = firstDifference(a, b);
  const identical = diff < 0;
  const entries: [string, string][] = [
    ['Compared with', `${other.name ?? 'second file'} (${plural(b.length, 'byte')})`],
    ['MD5 (other file)', hb.md5],
    ['SHA-1 (other file)', hb.sha1],
    ['SHA-256 (other file)', hb.sha256],
    ['Verdict', identical ? 'Identical files (same MD5/SHA-1/SHA-256)' : 'Different files'],
  ];
  if (identical) {
    return { entries, summary: `identical to ${name} (same MD5, SHA-1 and SHA-256)` };
  }
  const shorter = Math.min(a.length, b.length);
  const where =
    diff < shorter
      ? `: ${hex(a[diff]!)} in this file, ${hex(b[diff]!)} in the other`
      : ': one file ends there';
  entries.push(['First difference', `offset ${at(diff)}${where}`]);
  const delta = b.length - a.length;
  entries.push([
    'Size difference',
    delta === 0
      ? 'none (same size)'
      : `${delta > 0 ? '+' : '−'}${plural(Math.abs(delta), 'byte')} (the other file is ${delta > 0 ? 'longer' : 'shorter'})`,
  ]);
  if (diff === shorter) {
    entries.push([
      'Note',
      'The shorter file is the exact start of the longer one: data was appended (or cut off).',
    ]);
  }
  const collided = (['md5', 'sha1', 'sha256'] as const).filter((k) => ha[k] === hb[k]);
  if (collided.length) {
    entries.push([
      'Collision',
      `Same ${collided.map((k) => k.toUpperCase()).join('/')} for different bytes: a hash collision.`,
    ]);
  }
  const prefix = diff === shorter ? ', the shorter one is the start of the longer one' : '';
  return {
    entries,
    summary: `different from ${name}: first difference at offset ${at(diff)}${delta ? `, sizes differ by ${plural(Math.abs(delta), 'byte')}` : ''}${prefix}`,
  };
}

// ---------------------------------------------------------------- thumbnail

interface Thumbnail {
  data: Uint8Array;
  offset: number;
  image: RgbaImage | null;
  check: ThumbComparison | null;
  /** Problems worth a warning, and plain information. */
  warnings: string[];
  info: string[];
}

async function readThumbnail(
  bytes: Uint8Array,
  meta: ImageMeta,
  exifSource: Uint8Array,
  drawable: boolean,
): Promise<Thumbnail | null> {
  const thumb: Thumbnail = {
    data: new Uint8Array(),
    offset: -1,
    image: null,
    check: null,
    warnings: [],
    info: [],
  };
  if (meta.thumbnail === null) return null;
  if (meta.thumbnail === undefined) {
    // No EXIF block we could walk ourselves (HEIC...): exifr finds the thumbnail.
    const declared = meta.exif.ifd1?.ThumbnailOffset !== undefined;
    let raw: Uint8Array | undefined;
    try {
      raw = await exifr.thumbnail(exifSource);
    } catch (e) {
      if (!declared) return null;
      thumb.warnings.push(
        `IFD1 declares a thumbnail but it could not be read (${errorText(e)}): the EXIF block is truncated or damaged.`,
      );
      return thumb;
    }
    if (!raw || raw.length < 4) return null;
    thumb.data = Uint8Array.from(raw);
    thumb.offset = locate(bytes, thumb.data);
  } else if ('error' in meta.thumbnail) {
    thumb.warnings.push(
      `${meta.thumbnail.error}: the thumbnail is cut off, the EXIF block is truncated or damaged.`,
    );
    return thumb;
  } else {
    thumb.data = meta.thumbnail.data;
    thumb.offset = meta.thumbnail.offset;
  }
  const data = thumb.data;
  if (data[0] !== 0xff || data[1] !== 0xd8) {
    thumb.warnings.push(
      'The IFD1 thumbnail is not a JPEG (it does not start with FF D8): look at it in a hex view (it is in Extracted files).',
    );
    return thumb;
  }
  try {
    thumb.image = decodeJpeg(data);
  } catch (e) {
    thumb.warnings.push(`The EXIF thumbnail could not be decoded (${errorText(e)}).`);
    return thumb;
  }
  let main: ReturnType<typeof decodeMain>;
  try {
    main = decodeMain(bytes);
  } catch (e) {
    thumb.warnings.push(
      `The main image could not be decoded (${errorText(e)}), so the thumbnail was not compared with it: look at the thumbnail, it may be the only intact view of the picture.`,
    );
    return thumb;
  }
  if (!main) {
    thumb.info.push(
      drawable
        ? 'The thumbnail is checked against the main image for JPEG and PNG only: compare the two pictures by eye.'
        : 'This format cannot be decoded here, so only the thumbnail is shown and it was not compared with the main image: open the file in an image viewer to compare.',
    );
    return thumb;
  }
  thumb.check = compareThumbnail(main, thumb.image);
  return thumb;
}

function thumbnailOutputs(t: Thumbnail, mainSize: string | null): Output[] {
  const out: Output[] = t.info.map((text) => ({ type: 'note', level: 'info', text }));
  const c = t.check;
  if (!c) return out;
  const pct = `${Math.round(c.similarity * 100)}%`;
  if (c.verdict === 'loose') {
    out.push({
      type: 'note',
      level: 'info',
      text: `The EXIF thumbnail only loosely resembles the main image (${pct} similar): compare the two pictures above.`,
    });
  }
  if (c.verdict === 'match' && c.rotation) {
    out.push({
      type: 'note',
      level: 'info',
      text: `The thumbnail matches once rotated by ${c.rotation}° clockwise: the main image was rotated after the thumbnail was made.`,
    });
  }
  const entries: [string, string][] = [
    ['Thumbnail', `${t.image!.width}x${t.image!.height} JPEG, ${t.data.length} bytes`],
  ];
  if (mainSize) entries.push(['Main image', mainSize]);
  entries.push(
    ['Similarity', pct],
    [
      'Verdict',
      c.verdict === 'match'
        ? c.editedRegion
          ? `same picture, except the ${c.editedRegion}`
          : 'same picture'
        : c.verdict === 'loose'
          ? 'loosely similar'
          : 'a different picture',
    ],
    ['Method', `luminance correlation on a ${c.grid.width}x${c.grid.height} grid`],
  );
  if (c.bars)
    entries.push(['Letterbox bars', 'ignored (the thumbnail has a different aspect ratio)']);
  if (c.rotation) entries.push(['Best orientation', `rotated ${c.rotation}° clockwise`]);
  out.push({ type: 'kv', label: 'Thumbnail check', entries });
  return out;
}

// ---------------------------------------------------------------- strings

function stringOutputs(
  bytes: Uint8Array,
  regions: Region[],
  min: number,
): { out: Output[]; flags: string[] } {
  const all = findStrings(bytes, min);
  // Printable runs inside compressed pixels (and codec tables) are coincidences: list only the
  // long ones, and report only flags with a well-known prefix from there.
  const noise = (s: FoundString) => regionAt(regions, s.offset)?.imageData === true;
  const flagged: FoundString[] = [];
  const flags: string[] = [];
  const rest: FoundString[] = [];
  const longNoise: FoundString[] = [];
  let dropped = 0;
  for (const s of all) {
    const found = flagsIn(s.text).filter((f) => !noise(s) || strongFlag(f));
    if (found.length) {
      flagged.push(s);
      for (const f of found) if (!flags.includes(f)) flags.push(f);
    } else if (!noise(s)) rest.push(s);
    else if (s.text.length >= NOISE_STRING) longNoise.push(s);
    else dropped++;
  }
  const ordered = [...flagged, ...rest, ...longNoise];
  const shown = ordered.slice(0, MAX_STRINGS);
  const out: Output[] = [];
  if (!shown.length) {
    out.push({ type: 'note', level: 'info', text: `No string of at least ${min} characters.` });
  } else {
    out.push({
      type: 'table',
      label: 'Strings',
      columns: ['Offset', 'Where', 'Encoding', 'String'],
      rows: shown.map((s) => [
        hex(s.offset),
        regionAt(regions, s.offset)?.label ?? '',
        s.encoding,
        cut(s.text, MAX_STRING_CELL, 'in this string'),
      ]),
      highlight: flagged.slice(0, MAX_STRINGS).map((_, i) => i),
    });
  }
  if (ordered.length > MAX_STRINGS) {
    out.push({
      type: 'note',
      level: 'warn',
      text: `Showing ${MAX_STRINGS} of ${ordered.length} strings (flag-like ones first). Raise "Minimum string length", or use the Strings tool to filter.`,
    });
  }
  if (dropped) {
    out.push({
      type: 'note',
      level: 'info',
      text: `${plural(dropped, 'short string')} inside the compressed image data ${dropped === 1 ? 'is' : 'are'} not listed: random bytes that happen to be printable. The Strings tool shows every string.`,
    });
  }
  return { out, flags };
}

// ---------------------------------------------------------------- GPS

const fixText = (g: GpsFix) => `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}`;

function gpsInvalidText(g: GpsFix): string {
  return g.problem === 'zero'
    ? `The GPS tags hold 0, 0 (${g.source}), which is what an empty fix (or a wiped position) looks like, not a real place: no map.`
    : `The GPS tags hold ${g.lat}, ${g.lon} (${g.source}), which is not a position on Earth (latitude must be within ±90°, longitude within ±180°): invalid, no map.`;
}

function gpsFindings(gps: GpsInfo, f: Findings, warnings: string[]): void {
  const hemisphere = gps.missingRefs.length
    ? `; hemisphere unknown (${gps.missingRefs.join(', ')} missing)`
    : '';
  if (gps.valid) f.add('GPS position', `${fixText(gps)} (${gps.source}${hemisphere})`);
  else {
    f.add(
      'GPS',
      gps.problem === 'zero'
        ? 'tags hold 0, 0: no real fix, ignored'
        : `tags hold ${gps.lat}, ${gps.lon}: off the globe, invalid, ignored`,
    );
    warnings.push(gpsInvalidText(gps));
  }
  for (const ref of gps.missingRefs) {
    const isLat = ref === 'GPSLatitudeRef';
    const v = isLat ? gps.lat : gps.lon;
    warnings.push(
      `${ref} is missing: the hemisphere is unknown, so the ${isLat ? 'latitude' : 'longitude'} could be ${(-Math.abs(v)).toFixed(6)} instead of ${Math.abs(v).toFixed(6)} (the map assumes ${isLat ? 'N' : 'E'}).`,
    );
  }
  for (const o of gps.others) {
    f.add(
      'Other GPS position',
      `${fixText(o)} (${o.source})${o.problem ? ', invalid' : ''}: not the same place`,
    );
  }
  if (gps.others.length) {
    warnings.push(
      `The file holds more than one position: ${[gps, ...gps.others].map((g) => `${fixText(g)} in ${g.source}`).join(', ')}. One of them may be a decoy; each valid one has its own map below.`,
    );
  }
}

// ---------------------------------------------------------------- report

interface Report {
  name: string | undefined;
  size: number;
  type: string | null;
  hashes: Digests;
  findings: [string, string][];
  gps: GpsInfo | null;
  rows: MetaRow[];
  meta: ImageMeta;
  thumb: Thumbnail | null;
  tail: { offset: number; size: number; type: string } | null;
  embedded: EmbeddedFile[];
  flags: string[];
  compare: [string, string][] | null;
}

const round7 = (n: number) => Math.round(n * 1e7) / 1e7;

/** The JSON export: deterministic (no timestamps), human-readable values, GPS as numbers. */
function metadataJson(r: Report): string {
  const metadata: Record<string, Record<string, string>> = {};
  for (const row of r.rows) {
    const g = (metadata[row.group] ??= {});
    let key = row.tag;
    for (let n = 2; key in g; n++) key = `${row.tag} #${n}`;
    g[key] = row.value;
  }
  const links = r.gps?.valid ? mapLinks(r.gps.lat, r.gps.lon) : null;
  const doc = {
    file: { name: r.name ?? null, size: r.size, type: r.type, ...r.hashes },
    findings: Object.fromEntries(r.findings),
    gps: r.gps
      ? {
          latitude: round7(r.gps.lat),
          longitude: round7(r.gps.lon),
          valid: r.gps.valid,
          problem: r.gps.problem,
          source: r.gps.source,
          missingReferences: r.gps.missingRefs,
          googleMaps: links?.google ?? null,
          openStreetMap: links?.osm ?? null,
          details: Object.fromEntries(r.gps.details),
          otherPositions: r.gps.others.map((o) => ({
            latitude: round7(o.lat),
            longitude: round7(o.lon),
            valid: o.problem === null,
            source: o.source,
          })),
        }
      : null,
    exifBlocks: r.meta.blocks.map((b) => ({
      where: b.where,
      offset: b.offset,
      problems: b.problems,
    })),
    thumbnail:
      r.thumb && r.thumb.data.length
        ? {
            size: r.thumb.data.length,
            offset: r.thumb.offset >= 0 ? r.thumb.offset : null,
            width: r.thumb.image?.width ?? null,
            height: r.thumb.image?.height ?? null,
            similarityPercent: r.thumb.check ? Math.round(r.thumb.check.similarity * 100) : null,
            verdict: r.thumb.check?.verdict ?? null,
          }
        : null,
    dataAfterEnd: r.tail,
    embeddedFiles: r.embedded.map((f) => ({
      offset: f.start,
      size: f.end - f.start,
      type: f.sig.name,
      where: f.where,
    })),
    flagLikeStrings: r.flags,
    comparison: r.compare ? Object.fromEntries(r.compare) : null,
    metadata,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Name a file whose first bytes are the start of a known image header. */
function cutHeader(bytes: Uint8Array): string | null {
  if (bytes.length >= 16) return null;
  for (const [name, magic] of HEADERS) {
    const n = Math.min(bytes.length, magic.length);
    if (n >= 2 && magic.slice(0, n).every((x, i) => bytes[i] === x)) return name;
  }
  return null;
}

/** What the text fields of a further EXIF block say, for its Findings line. */
function blockSummary(rows: MetaRow[], n: number): string {
  const prefix = `EXIF #${n} `;
  const own = rows.filter((r) => r.group.startsWith(prefix));
  const text = own
    .filter((r) =>
      /^(ImageDescription|Artist|Copyright|UserComment|XP\w+|Software|Make|Model|OwnerName|CameraOwnerName|DocumentName)$/.test(
        r.tag,
      ),
    )
    .map((r) => `${r.tag} "${oneLine(r.value, 80)}"`);
  return text.length ? text.join(', ') : `${plural(own.length, 'field')}`;
}

// ---------------------------------------------------------------- tool

export default defineTool({
  id: 'image-analyzer',
  name: 'Image analyzer (metadata, GPS, hashes)',
  category: 'stego',
  description:
    'Drop an image, see everything: EXIF/IPTC/XMP/ICC fields, GPS on a map, MD5/SHA hashes, the EXIF thumbnail checked against the picture, appended data and strings.',
  tags: [
    'aperisolve',
    'exiftool',
    'exif',
    'gps',
    'location',
    'geolocation',
    'osint',
    'xmp',
    'iptc',
    'thumbnail',
    'md5',
    'sha256',
    'compare files',
    'appended data',
    'jpeg',
    'png',
    'heic',
  ],
  input: 'bytes',
  placeholder: 'Drop an image (JPEG, PNG, TIFF, WebP, HEIC, GIF) — it stays in this tab',
  options: {
    compare: file('Compare with', 'bytes', {
      hint: 'A second file: hashes side by side, identical or not, first differing byte.',
    }),
    minLength: number('Minimum string length', 6, { min: 3, max: 200 }),
  },
  examples: [
    {
      label: 'Photo with GPS (synthetic, Eiffel Tower)',
      input: { sample: 'meta-eiffel.jpg' },
      expect: 'Latitude: 48.858400',
    },
    {
      label: 'Thumbnail that shows another picture',
      input: { sample: 'meta-eiffel.jpg' },
      expect: 'Thumbnail: differs from the main image',
    },
    {
      label: 'PNG with XMP and text chunks',
      input: { sample: 'meta-plain.png' },
      expect: 'Synthetic PNG for the image analyzer',
    },
    {
      label: 'Compare a file with itself',
      input: { sample: 'meta-eiffel.jpg' },
      options: { compare: { sample: 'meta-eiffel.jpg' } },
      expect: 'Verdict: Identical files',
    },
  ],
  async run({ bytes, name }, { compare, minLength }) {
    if (!bytes.length) {
      throw new ToolError('Drop an image (JPEG, PNG, TIFF, WebP, HEIC, GIF), or any file to hash.');
    }
    const min = Math.max(3, Math.min(200, Math.round(minLength) || 6));
    const layout = analyseLayout(bytes);
    const type = layout.sig ? shortName(layout.sig.name) : null;
    const [hashes, otherHashes] = await Promise.all([
      digests(bytes),
      compare ? digests(compare.bytes) : Promise.resolve(null),
    ]);
    // exifr reads no WebP: it gets the XMP chunk wrapped in a minimal JPEG instead.
    const wrapped = layout.riff.length ? webpMetadataAsJpeg(bytes, layout.riff) : null;
    const exifSource = wrapped ?? bytes;
    const structure = { ...layout, size: layout.riff.length ? webpSize(bytes, layout.riff) : null };
    const meta: ImageMeta = layout.isImage
      ? await readMetadata(bytes, structure, { type, size: bytes.length }, exifSource)
      : {
          rows: [
            { group: 'File', tag: 'Type', value: type ?? 'unknown' },
            { group: 'File', tag: 'Size', value: `${bytes.length} bytes` },
          ],
          exif: {},
          xmp: {},
          errors: [],
          blocks: [],
          thumbnail: null,
        };
    const mime = layout.sig ? BROWSER_MIME[layout.sig.id] : undefined;
    const gps = layout.isImage ? readGps(meta) : null;
    const thumb = layout.isImage
      ? await readThumbnail(bytes, meta, exifSource, mime !== undefined)
      : null;

    // The thumbnail is pixels too: what it contains is no more a hidden file than the scan data.
    let regions = layout.regions;
    if (thumb && thumb.offset >= 0 && thumb.data.length) {
      regions = withRegion(regions, {
        start: thumb.offset,
        end: thumb.offset + thumb.data.length,
        label: 'EXIF thumbnail',
        imageData: true,
      });
    }

    // Data after the end of the image, and files hidden in it or in metadata segments.
    const stem = stemOf(name);
    const tailBytes =
      layout.end !== null && layout.end < bytes.length ? bytes.subarray(layout.end) : null;
    const tailKind = tailBytes ? describeTail(tailBytes) : null;
    const tail =
      tailBytes && tailKind && layout.end !== null
        ? { offset: layout.end, size: tailBytes.length, type: shortName(tailKind.label) }
        : null;
    const known = thumb && thumb.offset >= 0 ? [thumb.offset] : [];
    const { files: embedded, capped } = embeddedFiles(bytes, { ...layout, regions }, known);
    const strings = stringOutputs(bytes, regions, min);

    // ---- findings, most telling first
    const f = new Findings();
    const warnings: string[] = [];
    const compared =
      compare && otherHashes ? comparison(bytes, hashes, compare, otherHashes) : null;
    if (compared) f.add('Comparison', compared.summary);
    const cutAt = layout.isImage ? null : cutHeader(bytes);
    if (cutAt) {
      f.add(
        'File type',
        `${cutAt}, cut inside its header: only ${plural(bytes.length, 'byte')}, nothing else to read`,
      );
    } else if (!layout.isImage) {
      f.add(
        'File type',
        `${type ?? 'unknown'}: not an image, so only hashes, strings and embedded files apply`,
      );
    }
    if (gps) gpsFindings(gps, f, warnings);
    cameraAndDate(meta, f);
    const hits = textFindings(meta.rows, f);

    // A Base64 / hex layer on a text field.
    const decoded: string[] = [];
    for (const { label, row } of hits) {
      const d = decodedText(row.value);
      if (!d) continue;
      decoded.push(d.text);
      f.add(
        'Encoded text',
        `${label} (${row.group} ${row.tag}) is ${d.how} for "${oneLine(d.text, 120)}"`,
      );
    }
    if (decoded.length) {
      warnings.push(
        'A metadata field is encoded text (see "Encoded text" above). Auto-decode can peel further layers.',
      );
    }

    // Further EXIF blocks: most readers stop at the first.
    meta.blocks.slice(1).forEach((b, i) => {
      f.add(
        'Another EXIF block',
        `${b.where}, ignored by most readers: ${blockSummary(meta.rows, i + 2)}`,
      );
    });
    if (meta.blocks.length > 1) {
      warnings.push(
        `The file holds ${meta.blocks.length} EXIF blocks (${meta.blocks.map((b) => b.where).join(', ')}). Most software reads only the first one: the others are listed as "EXIF #2"... in All metadata.`,
      );
    }
    const damaged = meta.blocks.filter((b) => b.problems.length);
    for (const b of damaged) {
      f.add('EXIF', `present but damaged (${b.where}): ${oneLine(b.problems[0]!, 200)}`);
      warnings.push(
        `The EXIF block (${b.where}) is damaged: ${b.problems.slice(0, 4).join(' ')}${b.problems.length > 4 ? ` (+${b.problems.length - 4} more)` : ''} Everything that could still be read is listed below.`,
      );
    }
    if (meta.errors.length) {
      f.add('Metadata', `partly unreadable: ${oneLine(meta.errors[0]!, 200)}`);
      warnings.push(
        `Some metadata could not be read (${meta.errors.slice(0, 3).join('; ')}): the file may be truncated or its metadata damaged. What could be read is below.`,
      );
    }

    const c = thumb?.check;
    if (c && c.verdict === 'different') {
      f.add(
        'Thumbnail',
        `differs from the main image (${Math.round(c.similarity * 100)}% similar): it may show the original picture`,
      );
      warnings.push(THUMB_MISMATCH);
    } else if (c && c.verdict === 'loose') {
      f.add(
        'Thumbnail',
        `only loosely matches the main image (${Math.round(c.similarity * 100)}% similar)`,
      );
    } else if (c && c.rotation) {
      f.add(
        'Thumbnail',
        `matches the main image only once rotated ${c.rotation}° clockwise: the picture was rotated (or flipped) after the thumbnail was made`,
      );
    } else if (c?.editedRegion) {
      f.add('Thumbnail', `matches the main image except the ${c.editedRegion}: edited there?`);
      warnings.push(
        `The EXIF thumbnail matches the main image except around the ${c.editedRegion}: that area may have been edited after the thumbnail was made.`,
      );
    }
    if (thumb) warnings.push(...thumb.warnings);
    if (tail) {
      f.add('Data after the end', `${tail.size} bytes at offset ${at(tail.offset)}: ${tail.type}`);
    }
    if (embedded.length) {
      const list = embedded
        .slice(0, 4)
        .map((e) => `${shortName(e.sig.name)} at ${hex(e.start)}`)
        .join(', ');
      f.add('Embedded files', `${embedded.length}: ${list}${embedded.length > 4 ? ', …' : ''}`);
    }
    const flags = [...strings.flags];
    for (const t of [...meta.rows.map((r) => r.value), ...decoded]) {
      for (const flag of flagsIn(t)) if (!flags.includes(flag)) flags.push(flag);
    }
    if (flags.length) {
      f.add(
        'Flag-like strings',
        oneLine(
          flags.slice(0, 5).join(', ') + (flags.length > 5 ? `, +${flags.length - 5} more` : ''),
          240,
        ),
      );
    }
    if (layout.truncated) {
      f.add(
        'Structure',
        'the image never reaches its end marker: truncated or damaged (see Image structure)',
      );
    }
    const ihdr = layout.png?.chunks.find((k) => k.type === 'IHDR');
    if (ihdr && !ihdr.crcOk) {
      f.add(
        'PNG header',
        'IHDR CRC is wrong: the width or height was probably edited (see Image structure)',
      );
    }
    const findings = f.entries;
    if (!findings.length) {
      findings.push([
        'Nothing unusual found',
        'no GPS, no free-text metadata, no appended data, no flag-like strings',
      ]);
    }

    // ---- files to download
    const files: { name: string; data: Uint8Array; note?: string }[] = [];
    if (tail && tailBytes && tailKind) {
      const whole = embedded.some((e) => e.start === tail.offset && e.end === bytes.length);
      if (!whole) {
        files.push({
          name: `${stem}-after-end.${tailKind.ext}`,
          data: tailBytes.slice(),
          note: `${tail.type}, from offset ${tail.offset}`,
        });
      }
    }
    for (const e of embedded) {
      files.push({
        name: `${e.start.toString(16).padStart(8, '0')}.${e.sig.ext}`,
        data: bytes.slice(e.start, e.end),
        note: `${shortName(e.sig.name)}${e.where ? `, ${e.where}` : ''}`,
      });
    }
    if (thumb && thumb.data.length) {
      files.push({
        name: `${stem}-exif-thumbnail.jpg`,
        data: thumb.data,
        note: 'EXIF (IFD1) thumbnail',
      });
    }
    const makerNote = meta.exif.exif?.MakerNote;
    if (makerNote instanceof Uint8Array && makerNote.length > 32) {
      files.push({
        name: `${stem}-makernote.bin`,
        data: makerNote,
        note: `MakerNote (vendor data), ${makerNote.length} bytes`,
      });
    }
    const report: Report = {
      name,
      size: bytes.length,
      type,
      hashes,
      findings,
      gps,
      rows: meta.rows,
      meta,
      thumb,
      tail,
      embedded,
      flags,
      compare: compared?.entries ?? null,
    };
    files.push({
      name: 'metadata.json',
      data: utf8Encode(metadataJson(report)),
      note: 'everything above, as JSON',
    });
    const filesBlock: Output = { type: 'files', label: 'Extracted files', files };
    // A payload is the answer: its download goes right under the warnings, not at the bottom.
    const payload = tail !== null || embedded.length > 0;

    // ---- output, in reading order
    const out: Output[] = [
      { type: 'note', level: 'info', text: PRIVACY },
      { type: 'kv', label: 'Findings', entries: findings },
      ...warnings.map((text): Output => ({ type: 'note', level: 'warn', text })),
    ];
    if (payload) out.push(filesBlock);
    if (gps) {
      if (gps.valid) {
        out.push({ type: 'map', label: 'GPS position', lat: gps.lat, lon: gps.lon, zoom: 16 });
      }
      for (const o of gps.others) {
        if (!o.problem) {
          out.push({
            type: 'map',
            label: `GPS position (${o.source})`,
            lat: o.lat,
            lon: o.lon,
            zoom: 16,
          });
        }
      }
      out.push({ type: 'kv', label: 'GPS details', entries: gps.details });
    }
    out.push({
      type: 'kv',
      label: 'Hashes',
      entries: [
        ['MD5', hashes.md5],
        ['SHA-1', hashes.sha1],
        ['SHA-256', hashes.sha256],
        ['Size', `${plural(bytes.length, 'byte')} (${formatSize(bytes.length)})`],
      ],
    });
    if (compared) out.push({ type: 'kv', label: 'Comparison', entries: compared.entries });

    if (mime) {
      out.push({
        type: 'picture',
        label: 'Main image',
        data: bytes,
        mime,
        filename: name ?? `image.${layout.sig!.ext}`,
      });
    } else if (layout.isImage && !(thumb && thumb.data.length)) {
      out.push({
        type: 'note',
        level: 'info',
        text: `Browsers cannot draw ${type ?? 'this format'} files, so the main image is not shown; everything else below still applies.`,
      });
    }
    if (thumb && thumb.data.length) {
      out.push({
        type: 'picture',
        label: 'EXIF thumbnail',
        data: thumb.data,
        mime: 'image/jpeg',
        filename: `${stem}-exif-thumbnail.jpg`,
      });
    }
    if (thumb) {
      const dims =
        meta.rows.find((r) => r.group === 'File' && r.tag === 'Dimensions')?.value ?? null;
      out.push(...thumbnailOutputs(thumb, dims));
    }

    out.push({
      type: 'table',
      label: 'All metadata',
      columns: ['Group', 'Tag', 'Value'],
      rows: meta.rows.map((r) => [r.group, r.tag, cut(r.value, MAX_META_CELL, 'in metadata.json')]),
    });
    const onlyFile = meta.rows.every((r) => r.group === 'File' || r.group === 'PNG IHDR');
    if (layout.isImage && onlyFile) {
      out.push({
        type: 'note',
        level: 'info',
        text:
          meta.errors.length || meta.blocks.length
            ? 'Metadata segments are present but nothing could be read from them (see the warnings above).'
            : 'No EXIF, XMP, IPTC, ICC or text metadata: the file was stripped, or never had any.',
      });
    }
    // Long free-text values in full, copyable and pipeable (the table shows them too).
    const long = meta.rows.filter(
      (r) => r.value.length > LONG_VALUE && !/^<\d+ bytes>/.test(r.value),
    );
    for (const r of long.slice(0, MAX_LONG_BLOCKS)) {
      out.push({ type: 'text', label: `Full value: ${r.group} ${r.tag}`, value: r.value });
    }

    if (tail) {
      out.push({
        type: 'table',
        label: 'Data after the end of the image',
        columns: ['Offset', 'Type', 'Size'],
        rows: [[at(tail.offset), tail.type, `${tail.size} bytes`]],
        highlight: [0],
      });
    }
    if (embedded.length) {
      out.push({
        type: 'table',
        label: 'Embedded files',
        columns: ['Offset', 'Type', 'Size', 'Where', 'End found by'],
        rows: embedded.map((e) => [
          at(e.start),
          shortName(e.sig.name),
          `${e.end - e.start} bytes`,
          e.where,
          e.how,
        ]),
      });
      if (capped) {
        out.push({
          type: 'note',
          level: 'warn',
          text: `Stopped at ${embedded.length} embedded files.`,
        });
      }
    }
    if (!payload) out.push(filesBlock);
    out.push(...strings.out);
    return out;
  },
  detect({ bytes }) {
    const sig = imageSignature(bytes);
    if (!sig) return null;
    if (sig.id === 'gif' || sig.id === 'bmp' || sig.id === 'ico' || sig.id === 'qoi') {
      return { score: 0.5, reason: `${shortName(sig.name)}: comments, hashes, appended data` };
    }
    return { score: 0.7, reason: 'Image: metadata, GPS, thumbnail, hashes' };
  },
});
