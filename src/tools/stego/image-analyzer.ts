import { md5, sha1, sha256 } from 'hash-wasm';
import { defineTool, file, number } from '../../core/define';
import { ToolError } from '../../core/errors';
import { mapLinks } from '../../core/result-text';
import type { FileInput, Output, RgbaImage } from '../../core/types';
import { signatureName, slug, toolT } from '../../i18n/tool-text';
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

const T = toolT('image-analyzer');
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
/** A file-type name without its parenthesised detail ("JPEG image (JFIF)" -> "JPEG image"). */
const shortName = (name: string) => name.replace(/\s*[(（].*$/, '');
/** `more` gives the "… (N more characters …)" tail. */
const cut = (s: string, max: number, more: (n: number) => string) =>
  s.length > max ? `${s.slice(0, max)}${more(s.length - max)}` : s;

/** Display names of the metadata groups and tags this tool makes up (EXIF/XMP/IPTC names stay). */
const GROUP_KEYS: Record<string, string> = {
  File: 'group.file',
  'PNG text': 'group.png-text',
  'JPEG comment': 'group.jpeg-comment',
  'GIF comment': 'group.gif-comment',
};
const groupText = (group: string) => {
  const key = GROUP_KEYS[group];
  return key ? T(key) : group;
};
function tagText(group: string, tag: string): string {
  if (group === 'File' && (tag === 'Type' || tag === 'Size' || tag === 'Dimensions')) {
    return T(`tag.${tag.toLowerCase()}`);
  }
  if (group === 'PNG tIME' && tag === 'Modified') return T('tag.modified');
  if (group === 'JPEG comment' || group === 'GIF comment') {
    if (tag === 'Comment') return T('tag.comment');
    const n = /^Comment (\d+)$/.exec(tag);
    if (n) return T('tag.comment-n', { n: n[1]! });
  }
  return tag;
}
/** "top-left corner"... (from the thumbnail check) as the user reads it. */
const regionText = (region: string) => T(`value.region.${slug(region)}`);

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
  const name = other.name ?? T('value.the-second-file');
  const diff = firstDifference(a, b);
  const identical = diff < 0;
  const entries: [string, string][] = [
    [
      T('kv.compared-with'),
      T('value.compared-with', { name: other.name ?? T('value.second-file'), count: b.length }),
    ],
    [T('kv.md5-other'), hb.md5],
    [T('kv.sha1-other'), hb.sha1],
    [T('kv.sha256-other'), hb.sha256],
    [T('kv.verdict'), identical ? T('value.identical-files') : T('value.different-files')],
  ];
  if (identical) {
    return { entries, summary: T('finding.identical-to', { name }) };
  }
  const shorter = Math.min(a.length, b.length);
  const where =
    diff < shorter
      ? T('value.diff-bytes', { a: hex(a[diff]!), b: hex(b[diff]!) })
      : T('value.diff-ends');
  entries.push([T('kv.first-difference'), T('value.first-difference', { at: at(diff), where })]);
  const delta = b.length - a.length;
  entries.push([
    T('kv.size-difference'),
    delta === 0
      ? T('value.same-size')
      : T(delta > 0 ? 'value.size-longer' : 'value.size-shorter', { count: Math.abs(delta) }),
  ]);
  if (diff === shorter) {
    entries.push([T('kv.note'), T('value.appended')]);
  }
  const collided = (['md5', 'sha1', 'sha256'] as const).filter((k) => ha[k] === hb[k]);
  if (collided.length) {
    entries.push([
      T('kv.collision'),
      T('value.collision', { hashes: collided.map((k) => k.toUpperCase()).join('/') }),
    ]);
  }
  const prefix = diff === shorter ? T('finding.shorter-is-start') : '';
  return {
    entries,
    summary: `${T('finding.different-from', { name, at: at(diff) })}${delta ? T('finding.sizes-differ', { count: Math.abs(delta) }) : ''}${prefix}`,
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
      thumb.warnings.push(T('warn.thumb-unreadable', { error: errorText(e) }));
      return thumb;
    }
    if (!raw || raw.length < 4) return null;
    thumb.data = Uint8Array.from(raw);
    thumb.offset = locate(bytes, thumb.data);
  } else if ('error' in meta.thumbnail) {
    thumb.warnings.push(T('warn.thumb-cut', { error: meta.thumbnail.error }));
    return thumb;
  } else {
    thumb.data = meta.thumbnail.data;
    thumb.offset = meta.thumbnail.offset;
  }
  const data = thumb.data;
  if (data[0] !== 0xff || data[1] !== 0xd8) {
    thumb.warnings.push(T('warn.thumb-not-jpeg'));
    return thumb;
  }
  try {
    thumb.image = decodeJpeg(data);
  } catch (e) {
    thumb.warnings.push(T('warn.thumb-undecodable', { error: errorText(e) }));
    return thumb;
  }
  let main: ReturnType<typeof decodeMain>;
  try {
    main = decodeMain(bytes);
  } catch (e) {
    thumb.warnings.push(T('warn.main-undecodable', { error: errorText(e) }));
    return thumb;
  }
  if (!main) {
    thumb.info.push(drawable ? T('note.thumb-jpeg-png-only') : T('note.thumb-not-compared'));
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
      text: T('note.thumb-loose', { pct }),
    });
  }
  if (c.verdict === 'match' && c.rotation) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.thumb-rotated', { deg: c.rotation }),
    });
  }
  const entries: [string, string][] = [
    [
      T('kv.thumbnail'),
      T('value.thumb-size', { w: t.image!.width, h: t.image!.height, count: t.data.length }),
    ],
  ];
  if (mainSize) entries.push([T('kv.main-image'), mainSize]);
  entries.push(
    [T('kv.similarity'), pct],
    [
      T('kv.verdict'),
      c.verdict === 'match'
        ? c.editedRegion
          ? T('value.same-except', { region: regionText(c.editedRegion) })
          : T('value.same-picture')
        : c.verdict === 'loose'
          ? T('value.loosely-similar')
          : T('value.different-picture'),
    ],
    [T('kv.method'), T('value.method', { w: c.grid.width, h: c.grid.height })],
  );
  if (c.bars) entries.push([T('kv.letterbox'), T('value.letterbox')]);
  if (c.rotation) entries.push([T('kv.best-orientation'), T('value.rotated', { deg: c.rotation })]);
  out.push({ type: 'kv', label: T('label.thumb-check'), entries });
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
    out.push({ type: 'note', level: 'info', text: T('note.no-strings', { min }) });
  } else {
    out.push({
      type: 'table',
      label: T('label.strings'),
      columns: [T('col.offset'), T('col.where'), T('col.encoding'), T('col.string')],
      rows: shown.map((s) => [
        hex(s.offset),
        regionAt(regions, s.offset)?.text ?? '',
        s.encoding,
        cut(s.text, MAX_STRING_CELL, (n) => T('value.cut-string', { n })),
      ]),
      highlight: flagged.slice(0, MAX_STRINGS).map((_, i) => i),
    });
  }
  if (ordered.length > MAX_STRINGS) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.strings-capped', { shown: MAX_STRINGS, total: ordered.length }),
    });
  }
  if (dropped) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.short-strings', { count: dropped }),
    });
  }
  return { out, flags };
}

// ---------------------------------------------------------------- GPS

const fixText = (g: GpsFix) => `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}`;

function gpsInvalidText(g: GpsFix): string {
  return g.problem === 'zero'
    ? T('warn.gps-zero', { source: g.source })
    : T('warn.gps-range', { lat: g.lat, lon: g.lon, source: g.source });
}

function gpsFindings(gps: GpsInfo, f: Findings, warnings: string[]): void {
  const hemisphere = gps.missingRefs.length
    ? T('finding.hemisphere-unknown', { refs: gps.missingRefs.join(', ') })
    : '';
  if (gps.valid) f.add(T('finding.gps-position'), `${fixText(gps)} (${gps.source}${hemisphere})`);
  else {
    f.add(
      'GPS',
      gps.problem === 'zero'
        ? T('finding.gps-zero')
        : T('finding.gps-range', { lat: gps.lat, lon: gps.lon }),
    );
    warnings.push(gpsInvalidText(gps));
  }
  for (const ref of gps.missingRefs) {
    const isLat = ref === 'GPSLatitudeRef';
    const v = isLat ? gps.lat : gps.lon;
    warnings.push(
      T(isLat ? 'warn.missing-lat-ref' : 'warn.missing-lon-ref', {
        ref,
        neg: (-Math.abs(v)).toFixed(6),
        pos: Math.abs(v).toFixed(6),
      }),
    );
  }
  for (const o of gps.others) {
    f.add(
      T('finding.other-gps'),
      T(o.problem ? 'finding.other-gps-invalid' : 'finding.other-gps-value', {
        fix: fixText(o),
        source: o.source,
      }),
    );
  }
  if (gps.others.length) {
    const list = [gps, ...gps.others]
      .map((g) => T('warn.position-in', { fix: fixText(g), source: g.source }))
      .join(', ');
    warnings.push(T('warn.several-positions', { list }));
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
  return text.length ? text.join(', ') : T('finding.fields', { count: own.length });
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
      throw new ToolError(T('error.empty'));
    }
    const min = Math.max(3, Math.min(200, Math.round(minLength) || 6));
    const layout = analyseLayout(bytes);
    const type = layout.sig ? shortName(signatureName(layout.sig)) : null;
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
            { group: 'File', tag: 'Type', value: type ?? T('value.unknown') },
            { group: 'File', tag: 'Size', value: T('value.bytes', { count: bytes.length }) },
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
        text: T('region.exif-thumbnail'),
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
    if (compared) f.add(T('finding.comparison'), compared.summary);
    const cutAt = layout.isImage ? null : cutHeader(bytes);
    if (cutAt) {
      f.add(T('finding.file-type'), T('finding.cut-header', { type: cutAt, count: bytes.length }));
    } else if (!layout.isImage) {
      f.add(T('finding.file-type'), T('finding.not-image', { type: type ?? T('value.unknown') }));
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
        T('finding.encoded-text'),
        T('finding.encoded-value', {
          label,
          where: `${groupText(row.group)} ${tagText(row.group, row.tag)}`,
          how: d.how,
          text: oneLine(d.text, 120),
        }),
      );
    }
    if (decoded.length) warnings.push(T('warn.encoded'));

    // Further EXIF blocks: most readers stop at the first.
    meta.blocks.slice(1).forEach((b, i) => {
      f.add(
        T('finding.another-exif'),
        T('finding.another-exif-value', {
          where: b.where,
          summary: blockSummary(meta.rows, i + 2),
        }),
      );
    });
    if (meta.blocks.length > 1) {
      warnings.push(
        T('warn.several-exif', {
          count: meta.blocks.length,
          list: meta.blocks.map((b) => b.where).join(', '),
        }),
      );
    }
    const damaged = meta.blocks.filter((b) => b.problems.length);
    for (const b of damaged) {
      f.add(
        'EXIF',
        T('finding.exif-damaged', { where: b.where, problem: oneLine(b.problems[0]!, 200) }),
      );
      warnings.push(
        T('warn.exif-damaged', {
          where: b.where,
          problems: b.problems.slice(0, 4).join(' '),
          more: b.problems.length > 4 ? T('warn.more', { n: b.problems.length - 4 }) : '',
        }),
      );
    }
    if (meta.errors.length) {
      f.add(
        T('finding.metadata'),
        T('finding.partly-unreadable', { error: oneLine(meta.errors[0]!, 200) }),
      );
      warnings.push(T('warn.metadata-errors', { errors: meta.errors.slice(0, 3).join('; ') }));
    }

    const c = thumb?.check;
    if (c && c.verdict === 'different') {
      f.add(
        T('finding.thumbnail'),
        T('finding.thumb-differs', { pct: Math.round(c.similarity * 100) }),
      );
      warnings.push(T('warn.thumb-mismatch'));
    } else if (c && c.verdict === 'loose') {
      f.add(
        T('finding.thumbnail'),
        T('finding.thumb-loose', { pct: Math.round(c.similarity * 100) }),
      );
    } else if (c && c.rotation) {
      f.add(T('finding.thumbnail'), T('finding.thumb-rotated', { deg: c.rotation }));
    } else if (c?.editedRegion) {
      const region = regionText(c.editedRegion);
      f.add(T('finding.thumbnail'), T('finding.thumb-edited', { region }));
      warnings.push(T('warn.thumb-edited', { region }));
    }
    if (thumb) warnings.push(...thumb.warnings);
    if (tail) {
      f.add(
        T('finding.data-after-end'),
        T('finding.data-after-end-value', {
          count: tail.size,
          at: at(tail.offset),
          type: tail.type,
        }),
      );
    }
    if (embedded.length) {
      const list = embedded
        .slice(0, 4)
        .map((e) =>
          T('finding.embedded-at', { type: shortName(signatureName(e.sig)), offset: hex(e.start) }),
        )
        .join(', ');
      f.add(
        T('finding.embedded'),
        `${embedded.length}: ${list}${embedded.length > 4 ? ', …' : ''}`,
      );
    }
    const flags = [...strings.flags];
    for (const t of [...meta.rows.map((r) => r.value), ...decoded]) {
      for (const flag of flagsIn(t)) if (!flags.includes(flag)) flags.push(flag);
    }
    if (flags.length) {
      f.add(
        T('finding.flags'),
        oneLine(
          flags.slice(0, 5).join(', ') +
            (flags.length > 5 ? T('finding.more', { n: flags.length - 5 }) : ''),
          240,
        ),
      );
    }
    if (layout.truncated) f.add(T('finding.structure'), T('finding.truncated'));
    const ihdr = layout.png?.chunks.find((k) => k.type === 'IHDR');
    if (ihdr && !ihdr.crcOk) f.add(T('finding.png-header'), T('finding.ihdr-crc'));
    const findings = f.entries;
    if (!findings.length) findings.push([T('finding.nothing'), T('finding.nothing-value')]);

    // ---- files to download
    const files: { name: string; data: Uint8Array; note?: string }[] = [];
    if (tail && tailBytes && tailKind) {
      const whole = embedded.some((e) => e.start === tail.offset && e.end === bytes.length);
      if (!whole) {
        files.push({
          name: `${stem}-after-end.${tailKind.ext}`,
          data: tailBytes.slice(),
          note: T('file.after-end', { type: tail.type, offset: tail.offset }),
        });
      }
    }
    for (const e of embedded) {
      files.push({
        name: `${e.start.toString(16).padStart(8, '0')}.${e.sig.ext}`,
        data: bytes.slice(e.start, e.end),
        note: `${shortName(signatureName(e.sig))}${e.where ? `, ${e.where}` : ''}`,
      });
    }
    if (thumb && thumb.data.length) {
      files.push({
        name: `${stem}-exif-thumbnail.jpg`,
        data: thumb.data,
        note: T('file.thumbnail'),
      });
    }
    const makerNote = meta.exif.exif?.MakerNote;
    if (makerNote instanceof Uint8Array && makerNote.length > 32) {
      files.push({
        name: `${stem}-makernote.bin`,
        data: makerNote,
        note: T('file.makernote', { count: makerNote.length }),
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
      note: T('file.json'),
    });
    const filesBlock: Output = { type: 'files', label: T('label.files'), files };
    // A payload is the answer: its download goes right under the warnings, not at the bottom.
    const payload = tail !== null || embedded.length > 0;

    // ---- output, in reading order
    const out: Output[] = [
      { type: 'note', level: 'info', text: T('note.privacy') },
      { type: 'kv', label: T('label.findings'), entries: findings },
      ...warnings.map((text): Output => ({ type: 'note', level: 'warn', text })),
    ];
    if (payload) out.push(filesBlock);
    if (gps) {
      if (gps.valid) {
        out.push({
          type: 'map',
          label: T('label.gps-position'),
          lat: gps.lat,
          lon: gps.lon,
          zoom: 16,
        });
      }
      for (const o of gps.others) {
        if (!o.problem) {
          out.push({
            type: 'map',
            label: T('label.gps-position-of', { source: o.source }),
            lat: o.lat,
            lon: o.lon,
            zoom: 16,
          });
        }
      }
      out.push({ type: 'kv', label: T('label.gps-details'), entries: gps.details });
    }
    out.push({
      type: 'kv',
      label: T('label.hashes'),
      entries: [
        ['MD5', hashes.md5],
        ['SHA-1', hashes.sha1],
        ['SHA-256', hashes.sha256],
        [T('kv.size'), T('value.size', { count: bytes.length, size: formatSize(bytes.length) })],
      ],
    });
    if (compared) out.push({ type: 'kv', label: T('label.comparison'), entries: compared.entries });

    if (mime) {
      out.push({
        type: 'picture',
        label: T('label.main-image'),
        data: bytes,
        mime,
        filename: name ?? `image.${layout.sig!.ext}`,
      });
    } else if (layout.isImage && !(thumb && thumb.data.length)) {
      out.push({
        type: 'note',
        level: 'info',
        text: type ? T('note.cannot-draw', { type }) : T('note.cannot-draw-unknown'),
      });
    }
    if (thumb && thumb.data.length) {
      out.push({
        type: 'picture',
        label: T('label.exif-thumbnail'),
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
      label: T('label.all-metadata'),
      columns: [T('col.group'), T('col.tag'), T('col.value')],
      rows: meta.rows.map((r) => [
        groupText(r.group),
        tagText(r.group, r.tag),
        cut(r.value, MAX_META_CELL, (n) => T('value.cut-meta', { n })),
      ]),
    });
    const onlyFile = meta.rows.every((r) => r.group === 'File' || r.group === 'PNG IHDR');
    if (layout.isImage && onlyFile) {
      out.push({
        type: 'note',
        level: 'info',
        text:
          meta.errors.length || meta.blocks.length
            ? T('note.meta-unreadable')
            : T('note.no-metadata'),
      });
    }
    // Long free-text values in full, copyable and pipeable (the table shows them too).
    const long = meta.rows.filter(
      (r) => r.value.length > LONG_VALUE && !/^<\d+ bytes>/.test(r.value),
    );
    for (const r of long.slice(0, MAX_LONG_BLOCKS)) {
      out.push({
        type: 'text',
        label: T('label.full-value', { group: groupText(r.group), tag: tagText(r.group, r.tag) }),
        value: r.value,
      });
    }

    if (tail) {
      out.push({
        type: 'table',
        label: T('label.after-end'),
        columns: [T('col.offset'), T('col.type'), T('col.size')],
        rows: [[at(tail.offset), tail.type, T('value.bytes', { count: tail.size })]],
        highlight: [0],
      });
    }
    if (embedded.length) {
      out.push({
        type: 'table',
        label: T('label.embedded'),
        columns: [
          T('col.offset'),
          T('col.type'),
          T('col.size'),
          T('col.where'),
          T('col.end-found-by'),
        ],
        rows: embedded.map((e) => [
          at(e.start),
          shortName(signatureName(e.sig)),
          T('value.bytes', { count: e.end - e.start }),
          e.where,
          e.how,
        ]),
      });
      if (capped) {
        out.push({
          type: 'note',
          level: 'warn',
          text: T('note.capped', { count: embedded.length }),
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
      return {
        score: 0.5,
        reason: T('detect.simple', { type: shortName(signatureName(sig)) }),
      };
    }
    return { score: 0.7, reason: T('detect.image') };
  },
});
