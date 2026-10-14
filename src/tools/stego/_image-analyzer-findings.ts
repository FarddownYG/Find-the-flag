import { DEFAULT_FLAG_PATTERN, findFlags, KNOWN_PREFIX } from '../../core/flags';
import { toolT } from '../../i18n/tool-text';
import { fromBase64, fromHex, isValidUtf8, utf8Decode } from '../../lib/bytes';
import type { ImageMeta, MetaRow } from './_image-analyzer-meta';

const T = toolT('image-analyzer');

/** Findings, one line per label: a second value for the same label joins the first. */
export class Findings {
  readonly entries: [string, string][] = [];
  add(label: string, value: string): void {
    const at = this.entries.find(([k]) => k === label);
    if (at) at[1] = `${at[1]} | ${value}`;
    else this.entries.push([label, value]);
  }
  has(label: string): boolean {
    return this.entries.some(([k]) => k === label);
  }
}

/** One line, cut to `max` characters (the full value is in All metadata and below it). */
export const oneLine = (s: string, max = 160) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

type Source = [group: string, tag: RegExp, name: string];

/**
 * CTF-relevant text fields, grouped so that the same value from EXIF, XMP and IPTC is one line.
 * `key`: the Findings label, tool.image-analyzer.finding.<key>.
 */
const TEXT_FINDINGS: { key: string; sources: Source[] }[] = [
  {
    key: 'description',
    sources: [
      ['IFD0', /^ImageDescription$/, 'EXIF'],
      ['XMP', /^dc:description$/, 'XMP'],
      ['XMP', /^tiff:ImageDescription$/, 'XMP'],
      ['IPTC', /^Caption$/, 'IPTC'],
      ['PNG text', /^\w+ Description$/i, 'PNG'],
    ],
  },
  {
    key: 'user-comment',
    sources: [
      ['ExifIFD', /^UserComment$/, 'EXIF'],
      ['IFD0', /^XPComment$/, 'Windows'],
      ['XMP', /^exif:UserComment$/, 'XMP'],
      ['PNG text', /^\w+ Comment$/i, 'PNG'],
    ],
  },
  {
    key: 'title',
    sources: [
      ['IFD0', /^(XPTitle|XPSubject|DocumentName)$/, 'EXIF'],
      ['XMP', /^(dc:title|photoshop:Headline)$/, 'XMP'],
      ['IPTC', /^(ObjectName|Headline)$/, 'IPTC'],
      ['PNG text', /^\w+ Title$/i, 'PNG'],
    ],
  },
  {
    key: 'author',
    sources: [
      ['IFD0', /^(Artist|XPAuthor)$/, 'EXIF'],
      ['XMP', /^(dc:creator|tiff:Artist)$/, 'XMP'],
      ['IPTC', /^(Byline|Writer)$/, 'IPTC'],
      ['PNG text', /^\w+ Author$/i, 'PNG'],
    ],
  },
  {
    key: 'camera-owner',
    sources: [
      ['ExifIFD', /^(OwnerName|CameraOwnerName)$/, 'EXIF'],
      ['IFD0', /^(OwnerName|CameraOwnerName)$/, 'EXIF'],
      ['XMP', /^\w+:(OwnerName|CameraOwnerName)$/, 'XMP'],
    ],
  },
  {
    key: 'serial',
    sources: [
      ['ExifIFD', /^(SerialNumber|BodySerialNumber|LensSerialNumber)$/, 'EXIF'],
      ['XMP', /^\w+:(SerialNumber|BodySerialNumber)$/, 'XMP'],
    ],
  },
  {
    key: 'copyright',
    sources: [
      ['IFD0', /^Copyright$/, 'EXIF'],
      ['XMP', /^dc:rights$/, 'XMP'],
      ['IPTC', /^CopyrightNotice$/, 'IPTC'],
      ['PNG text', /^\w+ Copyright$/i, 'PNG'],
    ],
  },
  {
    key: 'software',
    sources: [
      ['IFD0', /^(Software|ProcessingSoftware|HostComputer)$/, 'EXIF'],
      ['XMP', /^xmp:CreatorTool$/, 'XMP'],
      ['PNG text', /^\w+ Software$/i, 'PNG'],
    ],
  },
  {
    key: 'keywords',
    sources: [
      ['IPTC', /^Keywords$/, 'IPTC'],
      ['XMP', /^dc:subject$/, 'XMP'],
      ['IFD0', /^XPKeywords$/, 'EXIF'],
    ],
  },
  {
    key: 'place-names',
    sources: [
      [
        'IPTC',
        /^(City|Sublocation|SubLocation|State|ProvinceState|Country|CountryCode|Location)$/,
        'IPTC',
      ],
      ['XMP', /^(photoshop:(City|State|Country)|Iptc4xmpCore:(Location|CountryCode))$/, 'XMP'],
    ],
  },
  {
    key: 'instructions',
    sources: [
      ['IPTC', /^SpecialInstructions$/, 'IPTC'],
      ['XMP', /^photoshop:Instructions$/, 'XMP'],
    ],
  },
  {
    key: 'icc-text',
    sources: [
      ['ICC', /^(ProfileDescription|ProfileCopyright|DeviceMfgDesc|DeviceModelDesc)$/, 'ICC'],
    ],
  },
  { key: 'jpeg-comment', sources: [['JPEG comment', /./, 'COM']] },
  { key: 'gif-comment', sources: [['GIF comment', /./, 'GIF']] },
];

/** XMP namespaces that hold technical data; anything else (custom namespaces) is free text. */
const TECHNICAL_XMP = new Set([
  'xmp',
  'xmpMM',
  'xmpRights',
  'xmpBJ',
  'xmpTPg',
  'xmpDM',
  'xmpG',
  'xmpGImg',
  'xmpNote',
  'stEvt',
  'stRef',
  'stDim',
  'stArea',
  'stFnt',
  'stJob',
  'tiff',
  'exif',
  'exifEX',
  'aux',
  'crs',
  'photoshop',
  'Iptc4xmpCore',
  'Iptc4xmpExt',
  'plus',
  'pdf',
  'pdfx',
  'pdfaid',
  'GPano',
  'mwg-rs',
  'illustrator',
  'lr',
  'dc',
  'MicrosoftPhoto',
  'GCamera',
  'Device',
  'hdrgm',
]);

/** Profiles every camera and editor embeds: their names say nothing about the picture. */
const STANDARD_ICC =
  /^(s?RGB( IEC61966-2[.-]1| built-in| v4.*| Profile)?|Display P3|Adobe RGB \(1998\)|Generic (RGB|Gray|CMYK) Profile|Apple RGB|ProPhoto RGB|ColorMatch RGB|Coated FOGRA\d+.*|U\.S\. Web Coated \(SWOP\) v2|Dot Gain \d+%|Gray Gamma [\d.]+|ROMM RGB.*|Rec\.? ?(709|2020).*|DCI\(?-?P3\)?.*|Linear .*|GIMP built-in .*|c2|Camera RGB Profile|Uncalibrated)$/i;

const meaningful = (v: string) => /[^\s0.,:-]/.test(v);

/** The rows Findings quotes, with the label each one went under. */
export interface TextHit {
  label: string;
  row: MetaRow;
}

export function textFindings(rows: MetaRow[], f: Findings): TextHit[] {
  const hits: TextHit[] = [];
  const used = new Set<MetaRow>();
  const iccDesc = rows.find((r) => r.group === 'ICC' && r.tag === 'ProfileDescription')?.value;
  const standardIcc = iccDesc !== undefined && STANDARD_ICC.test(iccDesc.trim());
  const add = (label: string, found: { row: MetaRow; source: string }[]) => {
    if (!found.length) return;
    const byValue = new Map<string, string[]>();
    for (const { row, source } of found) {
      const v = oneLine(row.value);
      const list = byValue.get(v) ?? [];
      if (!list.includes(source)) list.push(source);
      byValue.set(v, list);
      hits.push({ label, row });
    }
    const value = [...byValue].map(([v, s]) => `${v} (${s.join(', ')})`).join(' | ');
    f.add(label, oneLine(value, 240));
  };
  for (const { key, sources } of TEXT_FINDINGS) {
    if (key === 'icc-text' && (standardIcc || iccDesc === undefined)) continue;
    const found: { row: MetaRow; source: string }[] = [];
    for (const row of rows) {
      const src = sources.find(([g, re]) => g === row.group && re.test(row.tag));
      if (src && meaningful(row.value)) {
        found.push({ row, source: src[2] === 'XMP' ? `XMP ${row.tag}` : src[2] });
        used.add(row);
      }
    }
    add(T(`finding.${key}`), found);
  }
  for (const row of rows) {
    if (used.has(row) || !meaningful(row.value)) continue;
    if (row.group === 'PNG text')
      add(T('finding.png-text', { name: row.tag.replace(/^\w+ /, '') }), [
        { row, source: row.tag.split(' ')[0]! },
      ]);
    if (row.group === 'XMP' && !TECHNICAL_XMP.has(row.tag.split(':')[0]!)) {
      add(`XMP ${row.tag}`, [{ row, source: 'XMP' }]);
    }
  }
  return hits;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** "Which device took it, and when": the two classic OSINT answers. */
export function cameraAndDate(meta: ImageMeta, f: Findings): void {
  const ifd0 = meta.exif.ifd0 ?? {};
  const exif = meta.exif.exif ?? {};
  const tiff = meta.xmp.tiff ?? {};
  const xe = meta.xmp.exif ?? {};
  const aux = meta.xmp.aux ?? {};
  const make = str(ifd0.Make) ?? str(tiff.Make);
  const model = str(ifd0.Model) ?? str(tiff.Model);
  const lens = str(exif.LensModel) ?? str(aux.Lens) ?? str(meta.xmp.exifEX?.LensModel);
  const body =
    make && model && model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]!)
      ? model
      : [make, model].filter(Boolean).join(' ');
  if (body || lens) {
    f.add(
      T('finding.camera'),
      [body, lens ? T('finding.lens', { lens }) : ''].filter(Boolean).join(', '),
    );
  }

  const dates: [unknown, unknown, string][] = [
    [exif.DateTimeOriginal, exif.OffsetTimeOriginal, 'DateTimeOriginal'],
    [exif.CreateDate, exif.OffsetTimeDigitized, 'CreateDate'],
    [xe.DateTimeOriginal, null, 'XMP exif:DateTimeOriginal'],
    [meta.xmp.photoshop?.DateCreated, null, 'XMP photoshop:DateCreated'],
    [meta.xmp.xmp?.CreateDate, null, 'XMP xmp:CreateDate'],
    [ifd0.ModifyDate, exif.OffsetTime, 'ModifyDate'],
  ];
  for (const [date, offset, tag] of dates) {
    const d = str(date);
    if (!d || /^[0\s:.-]+$/.test(d)) continue;
    const o = str(offset);
    f.add(T('finding.taken'), `${d}${o ? ` ${o}` : ''} (${tag})`);
    break;
  }
}

// ---------------------------------------------------------------- encoded values

/** A value that is Base64 or hex for readable text: the classic extra layer on a metadata field. */
export function decodedText(value: string): { how: string; text: string } | null {
  const v = value.trim();
  if (v.length < 8 || v.length > 8192) return null;
  let bytes: Uint8Array | null = null;
  let how = '';
  if (/^(?:[0-9a-f]{2})+$/i.test(v)) {
    bytes = fromHex(v);
    how = 'hex';
  } else if (/^(?:[0-9a-f]{2}[ :]){3,}[0-9a-f]{2}$/i.test(v)) {
    bytes = fromHex(v);
    how = 'hex';
  } else if (
    /^[A-Za-z0-9+/]+={0,2}$/.test(v) &&
    v.length % 4 === 0 &&
    // A plain word is valid Base64 too: ask for a digit, a symbol or mixed case inside.
    /[0-9+/=]|[a-z][A-Z]|[A-Z][a-z].*[A-Z]/.test(v)
  ) {
    bytes = fromBase64(v);
    how = 'Base64';
  }
  if (!bytes || bytes.length < 4 || !isValidUtf8(bytes)) return null;
  const text = utf8Decode(bytes);
  let ok = 0;
  for (const ch of text) if (/[\p{L}\p{N}\p{P}\p{S} \t\n\r]/u.test(ch)) ok++;
  return ok / [...text].length >= 0.95 ? { how, text } : null;
}

// ---------------------------------------------------------------- flags

/** A file name glued in front of a flag ("flag.txtflag{...}": a ZIP entry name, then its data). */
const GLUED_EXTENSION = /^(txt|md|dat|bin|log|json|csv|xml|html?|js|py|sh|cfg|ini)(?=[A-Za-z])/i;

/** prefix{...} candidates, exactly as written: nested braces kept, nothing cut off the prefix. */
export function flagsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of findFlags(text, new RegExp(DEFAULT_FLAG_PATTERN, 'g'), 200)) {
    let { start, end } = m;
    // flag{nested{brace}}: the pattern matches the inner part only; widen to the outer braces.
    for (let depth = 0; depth < 3 && text[start - 1] === '{' && text[end] === '}'; depth++) {
      const before = /[A-Za-z][A-Za-z0-9_-]{1,24}$/.exec(
        text.slice(Math.max(0, start - 26), start - 1),
      );
      if (!before) break;
      start -= 1 + before[0].length;
      end += 1;
    }
    let value = text.slice(start, end);
    if (text[start - 1] === '.') value = value.replace(GLUED_EXTENSION, '');
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** Flags worth reporting from a string found inside compressed pixels: known prefixes only. */
export const strongFlag = (v: string) => KNOWN_PREFIX.test(v);
