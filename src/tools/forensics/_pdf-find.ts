/**
 * What lives in a PDF besides its text: how each object is reached, the pdfid-style keyword
 * counts, JavaScript (decoded, never run), embedded files, links and actions, form fields,
 * annotations, the Info dictionary and the XMP packet.
 */
import { latin1Decode, utf8Decode, isValidUtf8 } from '../../lib/bytes';
import { identify } from '../../lib/signatures';
import type { ObjRecord, PdfDoc, XrefMap } from './_pdf-doc';
import {
  formatValue,
  isArray,
  isDict,
  isName,
  isNum,
  isRef,
  isString,
  nameOf,
  pdfText,
  stringText,
  type PdfDict,
  type PdfValue,
} from './_pdf-lex';
import type { PageInfo } from './_pdf-text';

// ---------- reachability ----------

export interface Reach {
  parent: number | null;
  /** How the parent points here: `/Kids[0]`, `/Annots[1]`, `/A`. */
  via: string;
}

/** Walk the references from the trailer: which objects the document actually uses, and how. */
export function computeReach(doc: PdfDoc, view: XrefMap = doc.view): Map<number, Reach> {
  const reach = new Map<number, Reach>();
  const queue: number[] = [];
  const add = (ref: { num: number }, parent: number | null, via: string) => {
    if (reach.has(ref.num) || reach.size > 1_500_000) return;
    reach.set(ref.num, { parent, via });
    queue.push(ref.num);
  };
  const walk = (v: PdfValue | undefined, parent: number | null, path: string, depth: number) => {
    if (depth > 24 || v === undefined || v === null || typeof v !== 'object') return;
    if (isRef(v)) return add(v, parent, path);
    if (isArray(v)) {
      v.items.forEach((x, i) => walk(x, parent, `${path}[${i}]`, depth + 1));
    } else if (isDict(v)) {
      for (const [k, x] of v.map) walk(x, parent, `${path}/${k}`, depth + 1);
    }
  };
  for (const key of ['Root', 'Info', 'Encrypt']) {
    walk(doc.trailer.map.get(key), null, `/${key}`, 0);
  }
  // Object streams and xref streams are part of the file's structure: nothing needs to point to
  // them, and what they point to (their /Length) is in use.
  for (const [num, e] of view) {
    if (e.kind !== 'n') continue;
    const rec = doc.recordFor(num, e);
    if (rec && rec.stream && isDict(rec.value)) {
      const type = nameOf(rec.value.map.get('Type'));
      if (type === 'ObjStm' || type === 'XRef') {
        if (!reach.has(num)) {
          reach.set(num, { parent: null, via: `/${type}` });
          queue.push(num);
        }
      }
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const num = queue[i]!;
    const value = doc.getObject(num, view);
    walk(value, num, '', 0);
  }
  return reach;
}

/** `/Root/Pages/Kids[0]/Annots[1]`: the way from the trailer to an object. */
export function pathOf(reach: Map<number, Reach>, num: number): string | null {
  const parts: string[] = [];
  let cur: number | null = num;
  for (let i = 0; i < 40 && cur !== null; i++) {
    const r = reach.get(cur);
    if (!r) return null;
    parts.unshift(r.via);
    cur = r.parent;
  }
  const path = parts.join('');
  return path.length > 120 ? `…${path.slice(-118)}` : path;
}

const ROLES: Record<string, string> = {
  Root: 'Catalog',
  Info: 'Info',
  Encrypt: 'Encrypt',
  Contents: 'page content',
  Font: 'font',
  FontFile: 'font file',
  FontFile2: 'font file',
  FontFile3: 'font file',
  FontDescriptor: 'font descriptor',
  ToUnicode: 'ToUnicode CMap',
  Metadata: 'metadata',
  EF: 'embedded file',
  F: 'file',
  UF: 'file',
  JS: 'JavaScript',
  A: 'action',
  AA: 'actions',
  OpenAction: 'action',
  Annots: 'annotation',
  Resources: 'resources',
  XObject: 'XObject',
  ExtGState: 'graphics state',
  ColorSpace: 'colour space',
  Pages: 'page tree',
  Kids: 'page tree',
  Names: 'name tree',
  Dests: 'destinations',
  Outlines: 'outline',
  AcroForm: 'form',
  Fields: 'form field',
  Length: 'length',
  Parent: 'parent',
  Thumb: 'thumbnail',
  SMask: 'soft mask',
  Mask: 'mask',
  ICCBased: 'ICC profile',
};

function lastKey(via: string): string | null {
  const m = /\/([^/[\]]+)(?:\[\d+\])*$/.exec(via);
  return m ? m[1]! : null;
}

/** A short label for an object: its /Type and /Subtype, else how it is used. */
export function typeLabel(
  value: PdfValue | undefined,
  isStream: boolean,
  via: string | null,
): string {
  if (isDict(value)) {
    const t = nameOf(value.map.get('Type'));
    const s = nameOf(value.map.get('Subtype'));
    if (t && s) return `${t}/${s}`;
    if (t) return t;
    if (s) return s;
    if (value.map.has('Linearized')) return 'Linearized';
    if (value.map.has('JS') || (nameOf(value.map.get('S')) && value.map.has('S'))) {
      return 'Action';
    }
    if (value.map.has('FT')) return 'Field';
    const key = via ? lastKey(via) : null;
    if (key && ROLES[key]) return ROLES[key]!;
    return isStream ? 'stream' : 'dictionary';
  }
  if (isStream) return 'stream';
  const key = via ? lastKey(via) : null;
  if (isNum(value) && key === 'Length') return 'length';
  if (isArray(value)) return 'array';
  if (isString(value)) return 'string';
  if (isNum(value)) return 'number';
  if (value === null) return 'null';
  if (isName(value)) return 'name';
  return typeof value === 'boolean' ? 'boolean' : '?';
}

// ---------- pdfid-style counts ----------

export const COUNT_NAMES = [
  'Page',
  'Encrypt',
  'ObjStm',
  'JS',
  'JavaScript',
  'AA',
  'OpenAction',
  'AcroForm',
  'JBIG2Decode',
  'RichMedia',
  'Launch',
  'EmbeddedFile',
  'XFA',
  'URI',
  'GoToR',
  'SubmitForm',
] as const;
const COUNT_SET = new Set<string>(COUNT_NAMES);
const WORDS = new Set(['obj', 'endobj', 'stream', 'endstream', 'xref', 'trailer', 'startxref']);

export interface KeywordCount {
  key: string;
  /** Occurrences in the file text (outside stream data), as pdfid counts them. */
  file: number;
  /** Of which written with # escapes (/J#61vaScript). */
  escaped: number;
  /** Occurrences in the parsed objects, object streams included. */
  parsed: number | null;
}

const isDelimOrSpace = (c: number): boolean =>
  c === 0 ||
  c === 9 ||
  c === 10 ||
  c === 12 ||
  c === 13 ||
  c === 32 ||
  c === 0x28 ||
  c === 0x29 ||
  c === 0x3c ||
  c === 0x3e ||
  c === 0x5b ||
  c === 0x5d ||
  c === 0x7b ||
  c === 0x7d ||
  c === 0x2f ||
  c === 0x25;

export function keywordCounts(doc: PdfDoc): KeywordCount[] {
  const { bytes } = doc;
  const file = new Map<string, { n: number; esc: number }>();
  const bump = (key: string, escaped: boolean) => {
    const e = file.get(key) ?? { n: 0, esc: 0 };
    e.n++;
    if (escaped) e.esc++;
    file.set(key, e);
  };
  let from = 0;
  const regions: [number, number][] = [];
  for (const s of doc.streamRanges) {
    if (s.start > from) regions.push([from, s.start]);
    from = Math.max(from, s.end);
  }
  regions.push([from, bytes.length]);
  for (const [a, b] of regions) scanRegion(bytes, a, b, bump);

  // names in the parsed objects (keys and values), object stream members included
  const parsed = new Map<string, number>();
  const count = (v: PdfValue | undefined, depth: number) => {
    if (depth > 24 || v === undefined || v === null || typeof v !== 'object') return;
    if (isName(v)) {
      if (COUNT_SET.has(v.v)) parsed.set(v.v, (parsed.get(v.v) ?? 0) + 1);
    } else if (isArray(v)) for (const x of v.items) count(x, depth + 1);
    else if (isDict(v)) {
      for (const [k, x] of v.map) {
        if (COUNT_SET.has(k)) parsed.set(k, (parsed.get(k) ?? 0) + 1);
        count(x, depth + 1);
      }
    }
  };
  for (const rec of doc.records) {
    count(doc.decryptedValue(rec), 0);
    if (isDict(rec.value) && isName(rec.value.map.get('Type'), 'ObjStm')) {
      for (const m of doc.objStmMembers(rec)) count(m.value, 0);
    }
  }
  const out: KeywordCount[] = [];
  for (const w of ['obj', 'endobj', 'stream', 'endstream', 'xref', 'trailer', 'startxref']) {
    out.push({ key: w, file: file.get(w)?.n ?? 0, escaped: 0, parsed: null });
  }
  for (const name of COUNT_NAMES) {
    const f = file.get(`/${name}`);
    out.push({
      key: `/${name}`,
      file: f?.n ?? 0,
      escaped: f?.esc ?? 0,
      parsed: parsed.get(name) ?? 0,
    });
  }
  return out;
}

function scanRegion(
  b: Uint8Array,
  from: number,
  to: number,
  bump: (key: string, escaped: boolean) => void,
): void {
  let i = from;
  while (i < to) {
    const c = b[i]!;
    if (c === 0x28) {
      // literal string: skip to the matching parenthesis
      let depth = 1;
      i++;
      while (i < to && depth > 0) {
        const d = b[i]!;
        if (d === 0x5c) i++;
        else if (d === 0x28) depth++;
        else if (d === 0x29) depth--;
        i++;
      }
    } else if (c === 0x25) {
      while (i < to && b[i] !== 10 && b[i] !== 13) i++;
    } else if (c === 0x2f) {
      let j = i + 1;
      let name = '';
      let escaped = false;
      while (j < to && !isDelimOrSpace(b[j]!)) {
        if (b[j] === 0x23 && j + 2 < to) {
          const h = parseInt(String.fromCharCode(b[j + 1]!, b[j + 2]!), 16);
          if (Number.isFinite(h)) {
            name += String.fromCharCode(h);
            escaped = true;
            j += 3;
            continue;
          }
        }
        name += String.fromCharCode(b[j]!);
        j++;
      }
      if (COUNT_SET.has(name)) bump(`/${name}`, escaped);
      i = j;
    } else if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) {
      let j = i;
      while (j < to && !isDelimOrSpace(b[j]!) && j - i < 12) j++;
      const prev = i > from ? b[i - 1]! : 32;
      if (j - i <= 9 && (isDelimOrSpace(prev) || (prev >= 0x30 && prev <= 0x39))) {
        const word = latin1Decode(b.subarray(i, j));
        if (WORDS.has(word) && (j >= to || isDelimOrSpace(b[j]!))) bump(word, false);
      }
      while (j < to && !isDelimOrSpace(b[j]!)) j++;
      i = j;
    } else i++;
  }
}

// ---------- walking the objects ----------

export interface Source {
  num: number;
  gen: number;
  /** The record is the object a reader sees now. */
  state: 'current' | 'old' | 'packed';
  value: PdfValue | undefined;
  rec: ObjRecord | null;
}

/** Every object worth reading: all versions of the file's objects, and the packed ones. */
export function* sources(doc: PdfDoc): Generator<Source> {
  const view = doc.view;
  for (const rec of doc.records) {
    const e = view.get(rec.num);
    const current = !!e && e.kind === 'n' && doc.recordFor(rec.num, e) === rec;
    yield {
      num: rec.num,
      gen: rec.gen,
      state: current || doc.recovered ? 'current' : 'old',
      value: doc.decryptedValue(rec),
      rec,
    };
    if (isDict(rec.value) && isName(rec.value.map.get('Type'), 'ObjStm')) {
      for (const m of doc.objStmMembers(rec)) {
        const e2 = view.get(m.num);
        const live = !!e2 && e2.kind === 'c' && e2.a === rec.num;
        yield { num: m.num, gen: 0, state: live ? 'packed' : 'old', value: m.value, rec: null };
      }
    }
  }
}

/** Every dictionary inside a value (the value itself included), with the key path to it. */
export function* dictsIn(
  v: PdfValue | undefined,
  path = '',
  depth = 0,
): Generator<[PdfDict, string]> {
  if (depth > 20 || v === undefined || v === null || typeof v !== 'object') return;
  if (isDict(v)) {
    yield [v, path];
    for (const [k, x] of v.map) yield* dictsIn(x, `${path}/${k}`, depth + 1);
  } else if (isArray(v)) {
    for (let i = 0; i < v.items.length; i++) yield* dictsIn(v.items[i], `${path}[${i}]`, depth + 1);
  }
}

function describeWhere(
  s: Source,
  innerPath: string,
  reach: Map<number, Reach>,
  labels: { old: string; orphan: string },
): string {
  if (s.state === 'old') return `${labels.old} ${s.num}${innerPath}`;
  const p = pathOf(reach, s.num);
  if (p === null) return `${labels.orphan} ${s.num}${innerPath}`;
  return `${p}${innerPath}`;
}

// ---------- text of JavaScript, streams as text ----------

export function textOfBytes(b: Uint8Array): string {
  if (b.length >= 2 && ((b[0] === 0xfe && b[1] === 0xff) || (b[0] === 0xff && b[1] === 0xfe))) {
    return pdfText(b);
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)
    return utf8Decode(b.subarray(3));
  return isValidUtf8(b) ? utf8Decode(b) : latin1Decode(b);
}

/** The bytes a value stands for: a string's bytes, or the decoded stream it references. */
function bytesOfValue(doc: PdfDoc, v: PdfValue | undefined, limit: number): Uint8Array | null {
  if (isString(v)) return v.b;
  if (isRef(v)) {
    const rec = doc.getRecord(v.num);
    if (rec?.stream) return doc.decode(rec, limit).data;
    const r = doc.resolve(v);
    if (isString(r)) return r.b;
  }
  return null;
}

// ---------- JavaScript ----------

export interface ScriptFinding {
  num: number;
  where: string;
  /** The action that carries it (`/S /JavaScript`), if known. */
  trigger: string;
  source: string;
  state: Source['state'];
  /** Patterns worth a look in the code. */
  notable: string[];
}

const NOTABLE: [RegExp, string][] = [
  [/\beval\s*\(/, 'eval'],
  [/\bunescape\s*\(/, 'unescape'],
  [/String\.fromCharCode/, 'fromCharCode'],
  [/app\.launchURL|\blaunchURL\b/, 'launchURL'],
  [/submitForm|getURL/, 'submitForm'],
  [/exportDataObject|importDataObject/, 'exportDataObject'],
  [/util\.printf/, 'util.printf'],
  [/this\.(?:getField|getAnnots|getPageNthWord)/, 'doc access'],
  [/[A-Za-z0-9+/]{200,}={0,2}/, 'long encoded string'],
  [/\\x[0-9a-fA-F]{2}.*\\x[0-9a-fA-F]{2}.*\\x[0-9a-fA-F]{2}/, 'hex escapes'],
];

export function findScripts(doc: PdfDoc, reach: Map<number, Reach>): ScriptFinding[] {
  const out: ScriptFinding[] = [];
  for (const s of sources(doc)) {
    for (const [d, path] of dictsIn(s.value)) {
      if (!d.map.has('JS')) continue;
      const data = bytesOfValue(doc, d.map.get('JS'), 4 * 1024 * 1024);
      if (!data) continue;
      const source = textOfBytes(data);
      const action = nameOf(d.map.get('S'));
      out.push({
        num: s.num,
        where: describeWhere(s, path, reach, {
          old: 'older version of object',
          orphan: 'unreferenced object',
        }),
        trigger: action ?? '',
        source,
        state: s.state,
        notable: NOTABLE.filter(([re]) => re.test(source)).map(([, label]) => label),
      });
      if (out.length >= 60) return out;
    }
  }
  return out;
}

// ---------- embedded files ----------

export interface EmbeddedFinding {
  name: string;
  /** Name in the EmbeddedFiles name tree, when it differs from the file name. */
  treeName: string | null;
  description: string;
  mime: string;
  declaredSize: number | null;
  date: string;
  data: Uint8Array;
  truncated: boolean;
  where: string;
  num: number;
  kind: string | null;
  encrypted: boolean;
}

export function findEmbedded(doc: PdfDoc, reach: Map<number, Reach>): EmbeddedFinding[] {
  const out: EmbeddedFinding[] = [];
  const used = new Set<number>();
  const treeNames = new Map<number, string>();
  // names from the EmbeddedFiles name tree
  const root = doc.dictOf(doc.trailer.map.get('Root'));
  const names = doc.dictOf(root?.map.get('Names'));
  const tree = doc.dictOf(names?.map.get('EmbeddedFiles'));
  const walk = (node: PdfDict | null, depth: number) => {
    if (!node || depth > 12) return;
    const list = doc.resolve(node.map.get('Names'));
    if (isArray(list)) {
      for (let i = 0; i + 1 < list.items.length; i += 2) {
        const key = doc.resolve(list.items[i]);
        const target = list.items[i + 1];
        if (isString(key) && isRef(target)) treeNames.set(target.num, pdfText(key.b));
      }
    }
    const kids = doc.resolve(node.map.get('Kids'));
    if (isArray(kids)) for (const k of kids.items) walk(doc.dictOf(k), depth + 1);
  };
  walk(tree, 0);

  const add = (
    specNum: number,
    spec: PdfDict | null,
    streamRef: PdfValue | undefined,
    where: string,
  ) => {
    if (!isRef(streamRef)) return;
    const rec = doc.getRecord(streamRef.num);
    if (!rec?.stream || !isDict(rec.value)) return;
    if (used.has(rec.num)) return;
    used.add(rec.num);
    const dec = doc.decode(rec);
    const params = doc.dictOf(rec.value.map.get('Params'));
    const size = params ? doc.resolve(params.map.get('Size')) : undefined;
    const date = params
      ? doc.resolve(params.map.get('ModDate') ?? params.map.get('CreationDate'))
      : undefined;
    const fileName =
      spec &&
      [
        spec.map.get('UF'),
        spec.map.get('F'),
        spec.map.get('DOS'),
        spec.map.get('Mac'),
        spec.map.get('Unix'),
      ]
        .map((v) => stringText(doc.resolve(v)))
        .find((s) => s !== '');
    const tn = treeNames.get(specNum) ?? null;
    const name = fileName || tn || `embedded-${rec.num}`;
    const desc = spec ? stringText(doc.resolve(spec.map.get('Desc'))) : '';
    const sig = identify(dec.data).find((x) => !x.weak);
    out.push({
      name,
      treeName: tn && tn !== name ? tn : null,
      description: desc,
      mime: nameOf(doc.resolve(rec.value.map.get('Subtype'))) ?? '',
      declaredSize: isNum(size) ? size : null,
      date: isString(date) ? pdfText(date.b) : '',
      data: dec.data,
      truncated: dec.truncated,
      where,
      num: rec.num,
      kind: sig ? sig.id : null,
      encrypted: dec.encrypted,
    });
  };

  for (const s of sources(doc)) {
    if (s.state === 'old') continue;
    for (const [d, path] of dictsIn(s.value)) {
      const ef = doc.dictOf(d.map.get('EF'));
      if (!ef) continue;
      const where = describeWhere(s, path, reach, {
        old: 'older object',
        orphan: 'unreferenced object',
      });
      for (const key of ['UF', 'F', 'DOS', 'Mac', 'Unix']) add(s.num, d, ef.map.get(key), where);
      if (out.length >= 200) return out;
    }
  }
  // embedded file streams nothing points to
  for (const rec of doc.records) {
    if (!rec.stream || !isDict(rec.value) || used.has(rec.num)) continue;
    if (!isName(rec.value.map.get('Type'), 'EmbeddedFile')) continue;
    const e = doc.view.get(rec.num);
    if (!e || doc.recordFor(rec.num, e) !== rec) continue;
    add(
      rec.num,
      null,
      { k: 'ref', num: rec.num, gen: rec.gen },
      'unreferenced EmbeddedFile stream',
    );
  }
  return out;
}

// ---------- actions and links ----------

export interface ActionFinding {
  type: string;
  target: string;
  where: string;
}

export function findActions(doc: PdfDoc, reach: Map<number, Reach>): ActionFinding[] {
  const out: ActionFinding[] = [];
  const seen = new Set<string>();
  const push = (a: ActionFinding) => {
    const key = `${a.type}|${a.target}|${a.where}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(a);
    }
  };
  for (const s of sources(doc)) {
    for (const [d, path] of dictsIn(s.value)) {
      const type = nameOf(d.map.get('S'));
      if (type === null) continue;
      const where = describeWhere(s, path, reach, {
        old: 'older version of object',
        orphan: 'unreferenced object',
      });
      const str = (k: string) => stringText(doc.resolve(d.map.get(k)));
      switch (type) {
        case 'URI':
          push({ type, target: str('URI'), where });
          break;
        case 'Launch':
        case 'GoToR':
        case 'GoToE':
        case 'SubmitForm':
        case 'ImportData': {
          const f = doc.resolve(d.map.get('F'));
          let target = isString(f) ? pdfText(f.b) : '';
          if (isDict(f)) target = stringText(doc.resolve(f.map.get('UF') ?? f.map.get('F')));
          const win = doc.dictOf(d.map.get('Win'));
          if (win) {
            target = [stringText(win.map.get('F')), stringText(win.map.get('P'))]
              .filter(Boolean)
              .join(' ');
          }
          const params = str('Parameters');
          push({ type, target: [target, params].filter(Boolean).join(' '), where });
          break;
        }
        case 'JavaScript':
        case 'Named':
        case 'Hide':
        case 'Rendition':
        case 'Movie':
        case 'Sound':
        case 'SetOCGState':
        case 'GoTo':
          // JavaScript has its own section; the others are shown by name only when unusual
          if (type === 'Named') push({ type, target: nameOf(d.map.get('N')) ?? '', where });
          break;
        default:
          break;
      }
    }
  }
  const root = doc.dictOf(doc.trailer.map.get('Root'));
  const uri = doc.dictOf(root?.map.get('URI'));
  const base = uri ? stringText(doc.resolve(uri.map.get('Base'))) : '';
  if (base) push({ type: 'URI base', target: base, where: '/Root/URI' });
  return out.slice(0, 500);
}

// ---------- forms ----------

export interface FieldFinding {
  name: string;
  type: string;
  value: string;
  defaultValue: string;
  flags: string[];
  num: number | null;
}

const FIELD_TYPES: Record<string, string> = {
  Tx: 'text',
  Btn: 'button',
  Ch: 'choice',
  Sig: 'signature',
};

function fieldValue(doc: PdfDoc, v: PdfValue | undefined): string {
  const r = doc.resolve(v);
  if (isString(r)) return pdfText(r.b);
  if (isName(r)) return `/${r.v}`;
  if (isArray(r)) return r.items.map((x) => fieldValue(doc, x)).join(', ');
  if (isDict(r)) return formatValue(r, 120);
  if (isNum(r)) return String(r);
  if (isRef(v)) {
    const rec = doc.getRecord(v.num);
    if (rec?.stream) return textOfBytes(doc.decode(rec, 65536).data);
  }
  return '';
}

export function findFields(doc: PdfDoc): FieldFinding[] {
  const out: FieldFinding[] = [];
  const root = doc.dictOf(doc.trailer.map.get('Root'));
  const form = doc.dictOf(root?.map.get('AcroForm'));
  const fields = doc.resolve(form?.map.get('Fields'));
  const seen = new Set<number>();
  const visit = (
    ref: PdfValue | undefined,
    prefix: string,
    inherited: { ft: string; ff: number },
    depth: number,
  ) => {
    if (depth > 20 || out.length >= 1000) return;
    let num: number | null = null;
    if (isRef(ref)) {
      if (seen.has(ref.num)) return;
      seen.add(ref.num);
      num = ref.num;
    }
    const d = doc.dictOf(ref);
    if (!d) return;
    const t = stringText(doc.resolve(d.map.get('T')));
    const name = t ? (prefix ? `${prefix}.${t}` : t) : prefix;
    const ft = nameOf(doc.resolve(d.map.get('FT'))) ?? inherited.ft;
    const ffv = doc.resolve(d.map.get('Ff'));
    const ff = isNum(ffv) ? ffv : inherited.ff;
    const kids = doc.resolve(d.map.get('Kids'));
    const fieldKids = isArray(kids)
      ? kids.items.filter((k) => {
          const kd = doc.dictOf(k);
          return kd?.map.has('T') || kd?.map.has('Kids');
        })
      : [];
    if (fieldKids.length > 0) {
      for (const k of fieldKids) visit(k, name, { ft, ff }, depth + 1);
      return;
    }
    const flags: string[] = [];
    if (ff & 1) flags.push('readOnly');
    if (ff & 2) flags.push('required');
    if (ft === 'Tx' && ff & (1 << 13)) flags.push('password');
    const widgets = isArray(kids) ? kids.items.map((k) => doc.dictOf(k)) : [d];
    for (const w of widgets) {
      const f = w ? doc.resolve(w.map.get('F')) : undefined;
      if (isNum(f) && (f & 2 || f & 32)) {
        flags.push('hidden');
        break;
      }
    }
    out.push({
      name,
      type: FIELD_TYPES[ft] ?? (ft || '?'),
      value: fieldValue(doc, d.map.get('V')),
      defaultValue: fieldValue(doc, d.map.get('DV')),
      flags,
      num,
    });
  };
  if (isArray(fields)) for (const f of fields.items) visit(f, '', { ft: '', ff: 0 }, 0);
  return out;
}

/** The XFA packets of an AcroForm: [name, bytes] pairs. */
export function findXfa(doc: PdfDoc): { name: string; data: Uint8Array }[] {
  const root = doc.dictOf(doc.trailer.map.get('Root'));
  const form = doc.dictOf(root?.map.get('AcroForm'));
  const xfa = doc.resolve(form?.map.get('XFA'));
  const out: { name: string; data: Uint8Array }[] = [];
  const get = (v: PdfValue | undefined): Uint8Array | null => {
    if (isRef(v)) {
      const rec = doc.getRecord(v.num);
      return rec?.stream ? doc.decode(rec).data : null;
    }
    return null;
  };
  if (isArray(xfa)) {
    for (let i = 0; i + 1 < xfa.items.length; i += 2) {
      const n = doc.resolve(xfa.items[i]);
      const data = get(xfa.items[i + 1]);
      if (data) out.push({ name: isString(n) ? pdfText(n.b) : `packet-${i / 2}`, data });
    }
  } else {
    const ref = form?.map.get('XFA');
    const data = get(ref);
    if (data) out.push({ name: 'xfa', data });
  }
  return out;
}

// ---------- annotations ----------

export interface AnnotationFinding {
  page: number;
  type: string;
  text: string;
  author: string;
  flags: string[];
  num: number | null;
}

const ANNOT_FLAGS: [number, string][] = [
  [1, 'invisible'],
  [2, 'hidden'],
  [32, 'noView'],
];

export function findAnnotations(doc: PdfDoc, pages: PageInfo[]): AnnotationFinding[] {
  const out: AnnotationFinding[] = [];
  for (const page of pages) {
    const annots = doc.resolve(page.dict.map.get('Annots'));
    if (!isArray(annots)) continue;
    for (const item of annots.items) {
      const d = doc.dictOf(item);
      if (!d || out.length >= 600) continue;
      const type = nameOf(doc.resolve(d.map.get('Subtype'))) ?? '?';
      const f = doc.resolve(d.map.get('F'));
      const flags = isNum(f) ? ANNOT_FLAGS.filter(([bit]) => f & bit).map(([, n]) => n) : [];
      const rc = fieldValue(doc, d.map.get('RC')).replace(/<[^>]*>/g, ' ');
      const text = [stringText(doc.resolve(d.map.get('Contents'))), rc]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' | ');
      const author = stringText(doc.resolve(d.map.get('T')));
      if (!text && flags.length === 0 && ['Link', 'Widget', 'Popup'].includes(type)) continue;
      out.push({ page: page.index, type, text, author, flags, num: isRef(item) ? item.num : null });
    }
  }
  return out;
}

// ---------- metadata ----------

export interface InfoEntry {
  key: string;
  value: string;
  custom: boolean;
}

const INFO_KEYS = new Set([
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
  'Trapped',
]);

export function readInfo(doc: PdfDoc): InfoEntry[] {
  const info = doc.dictOf(doc.trailer.map.get('Info'));
  if (!info) return [];
  const out: InfoEntry[] = [];
  for (const [key, v] of info.map) {
    out.push({
      key,
      value: fieldValue(doc, v) || formatValue(doc.resolve(v), 200),
      custom: !INFO_KEYS.has(key),
    });
  }
  return out;
}

/** The XMP packet of the catalog, as text. */
export function readXmp(doc: PdfDoc): string | null {
  const root = doc.dictOf(doc.trailer.map.get('Root'));
  const ref = root?.map.get('Metadata');
  if (!isRef(ref)) return null;
  const rec = doc.getRecord(ref.num);
  if (!rec?.stream) return null;
  const data = doc.decode(rec, 1024 * 1024).data;
  return data.length > 0 ? textOfBytes(data) : null;
}

const XMP_FIELDS: [string, string][] = [
  ['dc:title', 'Title'],
  ['dc:creator', 'Author'],
  ['dc:description', 'Description'],
  ['dc:subject', 'Keywords'],
  ['pdf:Producer', 'Producer'],
  ['pdf:Keywords', 'Keywords'],
  ['xmp:CreatorTool', 'Creator tool'],
  ['xmp:CreateDate', 'Created'],
  ['xmp:ModifyDate', 'Modified'],
  ['xmp:MetadataDate', 'Metadata date'],
  ['xmpMM:DocumentID', 'Document ID'],
  ['xmpMM:InstanceID', 'Instance ID'],
];

export function xmpFields(xmp: string): [string, string][] {
  const out: [string, string][] = [];
  for (const [tag, label] of XMP_FIELDS) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:>([\\s\\S]*?)</${tag}>|\\s+/>)`);
    const m = re.exec(xmp);
    const attr = new RegExp(`${tag}="([^"]*)"`).exec(xmp);
    const raw = m?.[1] ?? attr?.[1];
    if (raw === undefined) continue;
    const text = raw
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) out.push([label, text]);
  }
  return out;
}

// ---------- unusual entries ----------

const CATALOG_KEYS = new Set(
  (
    'Type Version Extensions Pages PageLabels Names Dests ViewerPreferences PageLayout PageMode Outlines Threads ' +
    'OpenAction AA URI AcroForm Metadata StructTreeRoot MarkInfo Lang SpiderInfo OutputIntents PieceInfo ' +
    'OCProperties Perms Legal Requirements Collection NeedsRendering DSS AF DPartRoot'
  ).split(' '),
);
const TRAILER_KEYS = new Set(
  'Size Prev Root Encrypt Info ID XRefStm Type W Index Length Filter DecodeParms DL'.split(' '),
);
const PAGE_KEYS = new Set(
  (
    'Type Parent LastModified Resources MediaBox CropBox BleedBox TrimBox ArtBox BoxColorInfo Contents Rotate ' +
    'Group Thumb B Dur Trans Annots AA Metadata PieceInfo StructParents ID PZ SeparationInfo Tabs ' +
    'TemplateInstantiated PresSteps UserUnit VP Kids Count Rotate'
  ).split(' '),
);

export interface UnusualEntry {
  where: string;
  key: string;
  value: string;
}

/** Entries that no PDF reader looks at: a common place to leave a message. */
export function unusualEntries(doc: PdfDoc, pages: PageInfo[]): UnusualEntry[] {
  const out: UnusualEntry[] = [];
  const check = (where: string, d: PdfDict | null, known: Set<string>) => {
    if (!d) return;
    for (const [k, v] of d.map) {
      if (!known.has(k) && out.length < 200) {
        out.push({
          where,
          key: `/${k}`,
          value: fieldValue(doc, v) || formatValue(doc.resolve(v), 160),
        });
      }
    }
  };
  check('trailer', doc.trailer, TRAILER_KEYS);
  check('Catalog', doc.dictOf(doc.trailer.map.get('Root')), CATALOG_KEYS);
  const seen = new Set<number>();
  for (const p of pages) {
    if (p.num !== null && seen.has(p.num)) continue;
    if (p.num !== null) seen.add(p.num);
    check(`page ${p.index}`, p.dict, PAGE_KEYS);
  }
  return out;
}
