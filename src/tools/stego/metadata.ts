import { defineTool } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { formatSize, latin1Decode } from '../../lib/bytes';
import {
  bytesOfLike,
  decodeUserComment,
  exifr,
  fmtValue,
  isRecord,
  PARSE_OPTIONS,
  positionProblem,
  toDecimal,
} from './_exif';
import { parseGif } from './_gif';
import { jpegComments, isSof, parseJpeg } from './_jpeg';
import { pdfInfoEntries } from './_pdf-info';
import { parsePng, pngTexts, pngTime } from './_png';

export { decodeUserComment } from './_exif';

const GROUP_TITLES: Record<string, string> = {
  ifd0: 'IFD0 (main image)',
  ifd1: 'IFD1 (thumbnail)',
  exif: 'EXIF',
  gps: 'GPS',
  interop: 'Interoperability',
  xmp: 'XMP',
  iptc: 'IPTC',
  icc: 'ICC profile',
  jfif: 'JFIF',
  ihdr: 'PNG header / text',
  tiff: 'TIFF',
};
const GROUP_ORDER = Object.keys(GROUP_TITLES);

const CAMERA = new Set([
  'Make',
  'Model',
  'LensMake',
  'LensModel',
  'LensInfo',
  'BodySerialNumber',
  'SerialNumber',
  'CameraSerialNumber',
  'LensSerialNumber',
  'CameraOwnerName',
  'OwnerName',
  'ExposureTime',
  'FNumber',
  'ISO',
  'ISOSpeedRatings',
  'FocalLength',
  'FocalLengthIn35mmFormat',
  'Flash',
  'ExposureProgram',
  'ExposureMode',
  'ExposureBiasValue',
  'MeteringMode',
  'WhiteBalance',
  'SceneCaptureType',
  'Orientation',
  'ExifImageWidth',
  'ExifImageHeight',
  'ImageWidth',
  'ImageHeight',
  'ColorSpace',
]);
const TEXT_FIELDS = new Set([
  'ImageDescription',
  'UserComment',
  'Artist',
  'Copyright',
  'Software',
  'HostComputer',
  'ProcessingSoftware',
  'DocumentName',
  'XPComment',
  'XPAuthor',
  'XPTitle',
  'XPSubject',
  'XPKeywords',
  'ImageUniqueID',
]);
/** Fields people write messages into. */
const MESSAGE_FIELDS = [
  'ImageDescription',
  'UserComment',
  'Artist',
  'Copyright',
  'XPComment',
  'XPAuthor',
  'XPTitle',
  'XPSubject',
  'XPKeywords',
  'DocumentName',
];
const DATE_KEY =
  /^(?!GPS)(\w*date\w*|offsettime\w*|subsectime\w*|timecreated|digitalcreationtime)$/i;

type Entry = { group: string; key: string; value: string };

/** Turn a (possibly nested) group object into flat key/value rows. */
function flatten(group: string, prefix: string, value: unknown, out: Entry[], depth = 0): void {
  if (isRecord(value) && depth < 6) {
    for (const [k, v] of Object.entries(value)) {
      flatten(group, prefix ? `${prefix}.${k}` : k, v, out, depth + 1);
    }
    return;
  }
  const leaf = prefix.split('.').pop() ?? prefix;
  const text = fmtValue(leaf, value);
  if (text !== '') out.push({ group, key: prefix, value: text });
}

function gpsFromTags(gps: Record<string, unknown>, which: 'Latitude' | 'Longitude'): number | null {
  const fromTags = toDecimal(gps[`GPS${which}`], gps[`GPS${which}Ref`]);
  if (fromTags) return fromTags.value;
  const direct = gps[which.toLowerCase()];
  return typeof direct === 'number' && Number.isFinite(direct) ? direct : null;
}

function xmpPackets(bytes: Uint8Array): string[] {
  const text = latin1Decode(bytes.subarray(0, 1 << 24));
  const found = text.match(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/g) ?? [];
  return found
    .slice(0, 3)
    .map((p) =>
      p.length > 12000 ? `${p.slice(0, 12000)}\n… (${p.length - 12000} more characters)` : p,
    );
}

function thumbnailInfo(data: Uint8Array): string {
  const jpeg = parseJpeg(data);
  const sof = jpeg?.segments.find((s) => isSof(s.marker));
  if (jpeg && sof) {
    const d = data.subarray(sof.dataStart);
    return `${(d[3]! << 8) | d[4]!}x${(d[1]! << 8) | d[2]!} JPEG, ${formatSize(data.length)}`;
  }
  return formatSize(data.length);
}

const kvOf = (label: string, entries: [string, string][]): Output[] =>
  entries.length ? [{ type: 'kv', label, entries }] : [];

/** A map for a usable position (not 0, 0, which is what an empty fix looks like). */
const mapOf = (lat: number | null, lon: number | null): Output[] =>
  lat !== null && lon !== null && positionProblem(lat, lon) === null
    ? [{ type: 'map', label: 'GPS position', lat, lon, zoom: 16 }]
    : [];

function analysePdf(bytes: Uint8Array): Output[] {
  const out: Output[] = [];
  const header = latin1Decode(bytes.subarray(0, 16)).match(/%PDF-(\d\.\d)/);
  const entries = pdfInfoEntries(bytes);
  const total = new Map<string, number>();
  for (const e of entries) total.set(e.key, (total.get(e.key) ?? 0) + 1);
  const seen = new Map<string, number>();
  const rows: [string, string][] = entries.map((e) => {
    const n = (seen.get(e.key) ?? 0) + 1;
    seen.set(e.key, n);
    return [total.get(e.key)! > 1 ? `${e.key} #${n} (offset ${e.offset})` : e.key, e.value];
  });
  if (header) rows.unshift(['PDF version', header[1]!]);
  const eofs = latin1Decode(bytes).split('%%EOF').length - 1;
  out.push(...kvOf('PDF document information', rows));
  if (!entries.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: 'No readable Title/Author/Producer strings. The Info dictionary may sit inside a compressed object stream; try the XMP block below or a PDF-specific tool.',
    });
  }
  if (eofs > 1) {
    out.push({
      type: 'note',
      level: 'warn',
      text: `${eofs} end-of-file markers (%%EOF): the PDF was saved incrementally, so earlier versions of the content (and older metadata above) may still be inside the file.`,
    });
  }
  for (const [i, p] of xmpPackets(bytes).entries()) {
    out.push({ type: 'text', label: `XMP packet ${i + 1}`, value: p });
  }
  return out;
}

export default defineTool({
  id: 'metadata',
  name: 'EXIF / metadata',
  category: 'stego',
  description:
    'Read EXIF, GPS, XMP, IPTC and ICC data plus PNG text and JPEG comments from a photo, and pull out the embedded thumbnail.',
  tags: [
    'exiftool',
    'exif',
    'gps',
    'xmp',
    'iptc',
    'icc',
    'metadata',
    'jpeg',
    'tiff',
    'png',
    'thumbnail',
    'camera',
    'location',
    'pdf',
  ],
  input: 'bytes',
  placeholder: 'Drop a photo (JPEG, TIFF, PNG, WebP, HEIC) or a PDF',
  examples: [
    {
      label: 'Photo with GPS and a hidden description',
      input: { sample: 'stego-exif.jpg' },
      expect: 'flag{exif}',
    },
    { label: 'GPS position', input: { sample: 'stego-exif.jpg' }, expect: '48.858400, 2.294500' },
    {
      label: 'PNG text chunks',
      input: { sample: 'stego-text-chunk.png' },
      expect: 'flag{png_text_chunks}',
    },
  ],
  async run({ bytes }) {
    if (!bytes.length) throw new ToolError('Drop a photo (JPEG, TIFF, PNG, WebP, HEIC) or a PDF.');
    if (latin1Decode(bytes.subarray(0, 1024)).includes('%PDF-')) return analysePdf(bytes);

    const out: Output[] = [];
    const png = parsePng(bytes);
    const jpeg = parseJpeg(bytes);
    const gif = parseGif(bytes);

    let raw: unknown;
    let parseError: string | null = null;
    try {
      raw = await exifr.parse(bytes, PARSE_OPTIONS);
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }

    const isImage =
      png !== null ||
      jpeg !== null ||
      gif !== null ||
      raw !== undefined ||
      (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) ||
      (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[3] === 0x2a);
    if (!isImage) {
      return [
        {
          type: 'note',
          level: 'warn',
          text: 'This does not look like an image or a PDF. Metadata extraction works on JPEG, TIFF, PNG, WebP, HEIC/AVIF, GIF and PDF files; use "File type" to find out what it is.',
        },
      ];
    }

    // ---- flatten exifr output into rows
    const entries: Entry[] = [];
    const groups: Record<string, Record<string, unknown>> = {};
    if (isRecord(raw)) {
      for (const [name, value] of Object.entries(raw)) {
        if (name === 'userComment') {
          const b = bytesOfLike(value);
          const text = b ? decodeUserComment(b) : typeof value === 'string' ? value : '';
          if (text) entries.push({ group: 'exif', key: 'UserComment', value: text });
          continue;
        }
        if (isRecord(value)) {
          groups[name] = value;
          flatten(name, '', value, entries);
        } else {
          flatten('other', name, value, entries);
        }
      }
    }
    entries.sort((a, b) => {
      const ga = GROUP_ORDER.indexOf(a.group);
      const gb = GROUP_ORDER.indexOf(b.group);
      return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb);
    });

    const pick = (pred: (e: Entry) => boolean): [string, string][] =>
      entries.filter(pred).map((e) => [e.key, e.value]);
    const tagOf = (e: Entry) => e.key.split('.').pop() ?? e.key;

    // ---- GPS
    const gps = groups.gps;
    const lat = gps ? gpsFromTags(gps, 'Latitude') : null;
    const lon = gps ? gpsFromTags(gps, 'Longitude') : null;
    const gpsEntries: [string, string][] = [];
    if (lat !== null && lon !== null) {
      // Degrees/minutes/seconds and the map links are on the map block below.
      gpsEntries.push(['Latitude, longitude', `${lat.toFixed(6)}, ${lon.toFixed(6)}`]);
    }
    const skipGps = new Set([
      'GPSLatitude',
      'GPSLongitude',
      'GPSLatitudeRef',
      'GPSLongitudeRef',
      'latitude',
      'longitude',
    ]);
    gpsEntries.push(...pick((e) => e.group === 'gps' && !skipGps.has(tagOf(e))));

    // ---- notes first
    if (parseError && !png && !jpeg && !gif) {
      out.push({
        type: 'note',
        level: 'warn',
        text: `The EXIF reader could not parse this file: ${parseError}.`,
      });
    }
    if (gpsEntries.length && lat !== null) {
      out.push({
        type: 'note',
        level: 'info',
        text: `GPS position embedded: ${lat.toFixed(6)}, ${lon!.toFixed(6)}.`,
      });
    }
    const messageHits = entries.filter((e) => MESSAGE_FIELDS.includes(tagOf(e)) && e.value.trim());
    if (messageHits.length) {
      out.push({
        type: 'note',
        level: 'info',
        text: `Free-text fields worth reading: ${[...new Set(messageHits.map(tagOf))].join(', ')}.`,
      });
    }

    // ---- grouped blocks
    out.push(
      ...kvOf(
        'Camera and image',
        pick((e) => ['ifd0', 'exif'].includes(e.group) && CAMERA.has(tagOf(e))),
      ),
      ...kvOf(
        'Dates',
        pick(
          (e) =>
            DATE_KEY.test(tagOf(e)) &&
            !e.group.startsWith('ihdr') &&
            e.group !== 'gps' &&
            e.group !== 'icc' &&
            e.group !== 'ifd1',
        ),
      ),
      ...kvOf('GPS', gpsEntries),
      ...mapOf(lat, lon),
      ...kvOf(
        'Software and text',
        pick((e) => TEXT_FIELDS.has(tagOf(e))),
      ),
      ...kvOf(
        'XMP',
        pick((e) => e.group === 'xmp'),
      ),
      ...kvOf(
        'IPTC',
        pick((e) => e.group === 'iptc'),
      ),
      ...kvOf(
        'ICC profile',
        pick((e) => e.group === 'icc'),
      ),
    );

    // ---- formats exifr does not cover
    if (png) {
      const texts = pngTexts(bytes, png.chunks);
      out.push(
        ...kvOf(
          'PNG text chunks',
          texts.map((t) => [`${t.chunk}${t.keyword ? ` ${t.keyword}` : ''}`, t.text]),
        ),
      );
      const time = pngTime(bytes, png.chunks);
      if (time) out.push({ type: 'kv', label: 'PNG modification time', entries: [['tIME', time]] });
    }
    if (jpeg) {
      jpegComments(bytes, jpeg).forEach((c, i) => {
        out.push({ type: 'text', label: `JPEG comment ${i + 1}`, value: c });
      });
    }
    if (gif) {
      gif.comments.forEach((c, i) => {
        out.push({ type: 'text', label: `GIF comment ${i + 1}`, value: c });
      });
    }
    for (const [i, p] of xmpPackets(bytes).entries()) {
      out.push({ type: 'text', label: `XMP packet ${i + 1} (raw)`, value: p });
    }

    // ---- everything
    if (entries.length) {
      out.push({
        type: 'table',
        label: 'All tags',
        columns: ['Group', 'Tag', 'Value'],
        rows: entries.map((e) => [
          GROUP_TITLES[e.group] ?? e.group,
          e.key,
          e.value.length > 300 ? `${e.value.slice(0, 300)}…` : e.value,
        ]),
      });
    } else if (!out.some((o) => o.type === 'kv' || o.type === 'text')) {
      out.push({
        type: 'note',
        level: 'info',
        text: 'No EXIF, XMP, IPTC or ICC metadata found. The file may have been stripped; look at "Image structure" for chunks, comments and appended data.',
      });
    }

    // ---- thumbnail
    let thumb: Uint8Array | undefined;
    try {
      thumb = await exifr.thumbnail(bytes);
    } catch (e) {
      out.push({
        type: 'note',
        level: 'info',
        text: `Thumbnail could not be read: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    if (thumb && thumb.length) {
      const data = Uint8Array.from(thumb);
      out.push({
        type: 'files',
        label: 'Embedded thumbnail',
        files: [
          {
            name: 'thumbnail.jpg',
            data,
            note: `${thumbnailInfo(data)}. Compare it with the main image: an edited or cropped photo often keeps the original in its thumbnail.`,
          },
        ],
      });
    }
    return out;
  },
  detect({ bytes }) {
    const head = latin1Decode(bytes.subarray(0, 1 << 16));
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      return head.includes('Exif\0\0')
        ? { score: 0.7, reason: 'JPEG with EXIF data' }
        : { score: 0.3, reason: 'JPEG: check comments and XMP' };
    }
    if (head.startsWith('%PDF-'))
      return { score: 0.4, reason: 'PDF: read the document information' };
    if (
      (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[3] === 0x2a)
    ) {
      return { score: 0.6, reason: 'TIFF image tags' };
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && /tEXt|zTXt|iTXt|eXIf/.test(head)) {
      return { score: 0.45, reason: 'PNG with text or EXIF chunks' };
    }
    return null;
  },
});
