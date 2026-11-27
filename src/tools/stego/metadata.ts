import { defineTool } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
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

const T = toolT('metadata');

/** Group titles; the bare format names (EXIF, GPS, XMP...) are not translated. */
const GROUP_TITLES: Record<string, () => string> = {
  ifd0: () => T('group.ifd0'),
  ifd1: () => T('group.ifd1'),
  exif: () => 'EXIF',
  gps: () => 'GPS',
  interop: () => T('group.interop'),
  xmp: () => 'XMP',
  iptc: () => 'IPTC',
  icc: () => T('group.icc'),
  jfif: () => 'JFIF',
  ihdr: () => T('group.ihdr'),
  tiff: () => 'TIFF',
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

interface GpsFix {
  lat: number;
  lon: number;
  /** Where it was read: the GPS IFD, or an XMP/EXIF-namespace packet. */
  where: 'gps' | 'xmp';
  /** The raw latitude/longitude as stored, for the "redo it by hand" note. */
  rawLat: string;
  rawLon: string;
  altitude?: string;
  time?: string;
}

const rawText = (v: unknown, ref: unknown): string => {
  const r = typeof ref === 'string' ? ref : '';
  if (Array.isArray(v)) {
    const [d, m, sec] = v as unknown[];
    return `${String(d)}° ${String(m ?? 0)}′ ${String(sec ?? 0)}″ ${r}`.trim();
  }
  return `${String(v)} ${r}`.trim();
};

/** "35/1" (XMP rational) or a plain number. */
const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(-?\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const n = m[2] === undefined ? Number(m[1]) : Number(m[1]) / Number(m[2]);
  return Number.isFinite(n) ? n : null;
};

function gpsAltitude(g: Record<string, unknown>): string | undefined {
  const n = asNumber(g.GPSAltitude);
  if (n === null) return undefined;
  const ref = g.GPSAltitudeRef;
  const below = ref === 1 || ref === '1' || (isRecord(ref) && Object.values(ref).includes(1));
  return `${Math.round((below ? -n : n) * 100) / 100} m`;
}

function gpsTime(g: Record<string, unknown>): string | undefined {
  const stamp = g.GPSTimeStamp;
  const date = typeof g.GPSDateStamp === 'string' ? g.GPSDateStamp.replace(/:/g, '-') : '';
  if (Array.isArray(stamp) && stamp.length >= 3) {
    const [hh, mm, ss] = (stamp as unknown[]).map((x) => Math.floor(Number(x)));
    const clock = [hh, mm, ss].map((x) => String(x).padStart(2, '0')).join(':');
    return `${date ? `${date} ` : ''}${clock} UTC`;
  }
  if (typeof stamp === 'string' && stamp) return stamp;
  return date || undefined;
}

function gpsFix(groups: Record<string, Record<string, unknown>>): GpsFix | null {
  // The GPS IFD first, then XMP (its exif: namespace lands in the "exif" group of the reader).
  for (const where of ['gps', 'xmp', 'exif'] as const) {
    const g = groups[where];
    if (!g) continue;
    const la = toDecimal(g.GPSLatitude, g.GPSLatitudeRef);
    const lo = toDecimal(g.GPSLongitude, g.GPSLongitudeRef);
    let lat = la?.value ?? null;
    let lon = lo?.value ?? null;
    if (where === 'gps') {
      if (lat === null && typeof g.latitude === 'number' && Number.isFinite(g.latitude))
        lat = g.latitude;
      if (lon === null && typeof g.longitude === 'number' && Number.isFinite(g.longitude))
        lon = g.longitude;
    }
    if (lat === null || lon === null) continue;
    return {
      lat,
      lon,
      where: where === 'gps' ? 'gps' : 'xmp',
      rawLat: rawText(g.GPSLatitude, g.GPSLatitudeRef),
      rawLon: rawText(g.GPSLongitude, g.GPSLongitudeRef),
      altitude: gpsAltitude(g),
      time: gpsTime(g),
    };
  }
  return null;
}

function xmpPackets(bytes: Uint8Array): string[] {
  const text = latin1Decode(bytes.subarray(0, 1 << 24));
  const found = text.match(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/g) ?? [];
  return found
    .slice(0, 3)
    .map((p) =>
      p.length > 12000 ? `${p.slice(0, 12000)}\n${T('text.more', { count: p.length - 12000 })}` : p,
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

/** The Localisation block. A doubtful position (0, 0 or off the globe) is shown with its problem, never hidden. */
const mapOf = (fix: GpsFix | null): Output[] =>
  fix
    ? [
        {
          type: 'map',
          label: T('label.gpsMap'),
          lat: fix.lat,
          lon: fix.lon,
          zoom: 16,
          problem: positionProblem(fix.lat, fix.lon) ?? undefined,
          altitude: fix.altitude,
          time: fix.time,
        },
      ]
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
    return [
      total.get(e.key)! > 1 ? T('kv.pdfRepeat', { key: e.key, n, offset: e.offset }) : e.key,
      e.value,
    ];
  });
  if (header) rows.unshift([T('kv.pdfVersion'), header[1]!]);
  const eofs = latin1Decode(bytes).split('%%EOF').length - 1;
  out.push(...kvOf(T('label.pdfInfo'), rows));
  if (!entries.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.pdfNoInfo'),
    });
  }
  if (eofs > 1) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.pdfEof', { count: eofs }),
    });
  }
  for (const [i, p] of xmpPackets(bytes).entries()) {
    out.push({ type: 'text', label: T('label.xmpPacket', { n: i + 1 }), value: p });
  }
  out.push({ type: 'note', level: 'info', text: T('note.pdfAnalyzer') });
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
    if (!bytes.length) throw new ToolError(T('error.empty'));
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
          text: T('note.notImage'),
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
    const fix = gpsFix(groups);
    const lat = fix?.lat ?? null;
    const lon = fix?.lon ?? null;
    const gpsEntries: [string, string][] = [];
    if (lat !== null && lon !== null) {
      // Degrees/minutes/seconds and the map links are on the map block below.
      gpsEntries.push([T('kv.latLon'), `${lat.toFixed(6)}, ${lon.toFixed(6)}`]);
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

    // ---- the Localisation block comes first when there is a position
    out.push(...mapOf(fix));

    // ---- notes first
    if (parseError && !png && !jpeg && !gif) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.parseError', { error: parseError }),
      });
    }
    if (gpsEntries.length && lat !== null) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.gps', { lat: lat.toFixed(6), lon: lon!.toFixed(6) }),
      });
    }
    if (fix) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.gpsTrace', {
          where: T(fix.where === 'gps' ? 'gpsWhere.ifd' : 'gpsWhere.xmp'),
          lat: fix.rawLat,
          lon: fix.rawLon,
          dlat: fix.lat.toFixed(6),
          dlon: fix.lon.toFixed(6),
        }),
      });
    }
    const messageHits = entries.filter((e) => MESSAGE_FIELDS.includes(tagOf(e)) && e.value.trim());
    if (messageHits.length) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.messages', { fields: [...new Set(messageHits.map(tagOf))].join(', ') }),
      });
    }

    // ---- grouped blocks
    out.push(
      ...kvOf(
        T('label.camera'),
        pick((e) => ['ifd0', 'exif'].includes(e.group) && CAMERA.has(tagOf(e))),
      ),
      ...kvOf(
        T('label.dates'),
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
      ...kvOf(
        T('label.software'),
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
        T('label.icc'),
        pick((e) => e.group === 'icc'),
      ),
    );

    // ---- formats exifr does not cover
    if (png) {
      const texts = pngTexts(bytes, png.chunks);
      out.push(
        ...kvOf(
          T('label.pngText'),
          texts.map((t) => [`${t.chunk}${t.keyword ? ` ${t.keyword}` : ''}`, t.text]),
        ),
      );
      const time = pngTime(bytes, png.chunks);
      if (time) out.push({ type: 'kv', label: T('label.pngTime'), entries: [['tIME', time]] });
    }
    if (jpeg) {
      jpegComments(bytes, jpeg).forEach((c, i) => {
        out.push({ type: 'text', label: T('label.jpegComment', { n: i + 1 }), value: c });
      });
    }
    if (gif) {
      gif.comments.forEach((c, i) => {
        out.push({ type: 'text', label: T('label.gifComment', { n: i + 1 }), value: c });
      });
    }
    for (const [i, p] of xmpPackets(bytes).entries()) {
      out.push({ type: 'text', label: T('label.xmpRaw', { n: i + 1 }), value: p });
    }

    // ---- everything
    if (entries.length) {
      out.push({
        type: 'table',
        label: T('label.allTags'),
        columns: [T('col.group'), T('col.tag'), T('col.value')],
        rows: entries.map((e) => [
          GROUP_TITLES[e.group]?.() ?? e.group,
          e.key,
          e.value.length > 300 ? `${e.value.slice(0, 300)}…` : e.value,
        ]),
      });
    } else if (!out.some((o) => o.type === 'kv' || o.type === 'text')) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.noMeta'),
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
        text: T('note.thumbError', { error: e instanceof Error ? e.message : String(e) }),
      });
    }
    if (thumb && thumb.length) {
      const data = Uint8Array.from(thumb);
      out.push({
        type: 'files',
        label: T('label.thumb'),
        files: [
          {
            name: 'thumbnail.jpg',
            data,
            note: T('text.thumb', { info: thumbnailInfo(data) }),
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
        ? { score: 0.7, reason: T('detect.jpegExif') }
        : { score: 0.3, reason: T('detect.jpeg') };
    }
    if (head.startsWith('%PDF-')) return { score: 0.4, reason: T('detect.pdf') };
    if (
      (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[3] === 0x2a)
    ) {
      return { score: 0.6, reason: T('detect.tiff') };
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && /tEXt|zTXt|iTXt|eXIf/.test(head)) {
      return { score: 0.45, reason: T('detect.png') };
    }
    return null;
  },
});
