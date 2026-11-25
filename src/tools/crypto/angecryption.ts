import { bool, defineTool, file, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { formatSize, fromHex, toHex, utf8Decode } from '../../lib/bytes';
import { identify } from '../../lib/signatures';
import {
  BLOCK,
  buildConstruct,
  customHeader,
  decryptWithIv,
  deriveIv,
  encrypt,
  entropy,
  familyOf,
  HEADER_MODELS,
  looksRandom,
  MAX_LIST,
  MAX_WINDOWS,
  modelFor,
  padTo16,
  parseKey,
  testKey,
  windowKeys,
  type HeaderModel,
  type KeyFormat,
} from './_angecryption';

const T = toolT('angecryption');

const SIG_LABEL: Record<string, () => string> = {
  'png-idat': () => T('sig.pngIdat'),
  'png-iend': () => T('sig.pngIend'),
  'png-chunk': () => T('sig.pngChunk'),
  'jpeg-dqt': () => T('sig.jpegDqt'),
  'jpeg-sof': () => T('sig.jpegSof'),
  'jpeg-dht': () => T('sig.jpegDht'),
  'jpeg-sos': () => T('sig.jpegSos'),
  'gif-gce': () => T('sig.gifGce'),
  'gif-netscape': () => T('sig.gifNetscape'),
  'pdf-endobj': () => T('sig.pdfEndobj'),
  'pdf-endstream': () => T('sig.pdfEndstream'),
  'pdf-xref': () => T('sig.pdfXref'),
  'pdf-eof': () => T('sig.pdfEof'),
  'zip-local': () => T('sig.zipLocal'),
  'zip-central': () => T('sig.zipCentral'),
  'zip-eocd': () => T('sig.zipEocd'),
};

type Source = 'typed' | 'list' | 'window';
interface Candidate {
  key: Uint8Array;
  source: Source;
  at?: number;
}

/** A key shown as text when it is printable ASCII, always with its hex form. */
function showKey(key: Uint8Array): string {
  const printable = key.every((x) => x >= 0x20 && x < 0x7f);
  return printable ? `"${utf8Decode(key)}" (${toHex(key)})` : toHex(key);
}

const typeName = (b: Uint8Array): string | null => {
  const sig = identify(b)[0];
  return sig && !sig.weak ? sig.name : null;
};

function gatherCandidates(
  cipher: Uint8Array,
  o: { key: string; keyFormat: KeyFormat; keyList: { bytes: Uint8Array } | null; windows: boolean },
): { list: Candidate[]; skipped: number } {
  const list: Candidate[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const add = (c: Candidate) => {
    const id = toHex(c.key);
    if (seen.has(id)) return;
    seen.add(id);
    list.push(c);
  };

  if (o.key.trim() !== '') {
    const key = parseKey(o.key, o.keyFormat);
    if (!key) throw new ToolError(T('err.badTypedKey'));
    add({ key, source: 'typed' });
  }
  if (o.keyList) {
    const lines = utf8Decode(o.keyList.bytes).split('\n', MAX_LIST);
    for (const line of lines) {
      if (line.trim() === '') continue;
      const key = parseKey(line, o.keyFormat);
      if (key) add({ key, source: 'list' });
      else skipped++;
    }
  }
  if (o.windows) {
    for (const w of windowKeys(cipher, MAX_WINDOWS))
      add({ key: w.key, source: 'window', at: w.at });
  }
  return { list, skipped };
}

const sourceLabel = (c: Candidate): string =>
  c.source === 'typed'
    ? T('source.typed')
    : c.source === 'list'
      ? T('source.list')
      : T('source.window', { at: c.at ?? 0 });

function analysis(cipher: Uint8Array, tested: number, skipped: number): [Output, boolean] {
  const multiple = cipher.length % BLOCK === 0;
  const body = cipher.subarray(BLOCK);
  const h = entropy(body);
  const random = looksRandom(body);
  const head = typeName(cipher);
  const entries: [string, string][] = [
    [
      T('kv.size'),
      T(multiple ? 'value.sizeOk' : 'value.sizeBad', {
        size: formatSize(cipher.length),
        count: cipher.length,
      }),
    ],
    [
      T('kv.header'),
      head
        ? T('value.headerKnown', { name: head })
        : T('value.headerUnknown', { hex: toHex(cipher.subarray(0, BLOCK), ' ') }),
    ],
    [
      T('kv.entropy'),
      T(random ? 'value.entropyRandom' : 'value.entropyLow', { bits: h.toFixed(2) }),
    ],
    [T('kv.tested'), T('value.tested', { count: tested, skipped })],
  ];
  return [{ type: 'kv', label: T('label.analysis'), entries }, multiple && random && head !== null];
}

function decryptRun(
  cipherIn: Uint8Array,
  o: {
    key: string;
    keyFormat: KeyFormat;
    keyList: { bytes: Uint8Array } | null;
    windows: boolean;
    target: string;
    header: string;
  },
): Output[] {
  if (cipherIn.length < 2 * BLOCK) throw new ToolError(T('err.tooShort'));
  const out: Output[] = [];
  const trimmed = cipherIn.length % BLOCK;
  const cipher = trimmed === 0 ? cipherIn : cipherIn.subarray(0, cipherIn.length - trimmed);

  const { list, skipped } = gatherCandidates(cipher, o);
  let hit: { cand: Candidate; signatures: string[] } | null = null;
  let tested = 0;
  for (const cand of list) {
    tested++;
    const r = testKey(cipher, cand.key);
    if (r.ok) {
      hit = { cand, signatures: r.signatures };
      break;
    }
  }

  const [kv, probable] = analysis(cipherIn, tested, skipped);

  if (!hit) {
    if (list.length === 0) {
      out.push({
        type: 'note',
        level: probable ? 'warn' : 'info',
        text: T(probable ? 'verdict.probable' : 'verdict.noKey'),
      });
    } else {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('verdict.notFound', { count: tested }),
      });
    }
    out.push(kv);
    if (trimmed !== 0)
      out.push({ type: 'note', level: 'warn', text: T('note.trimmed', { n: trimmed }) });
    out.push({ type: 'note', level: 'info', text: T('note.honest') });
    out.push({ type: 'note', level: 'info', text: T('note.technique') });
    return out;
  }

  // The key is proven by the body; the IV only has to fit the header of the hidden file.
  const { cand, signatures } = hit;
  const family = familyOf(signatures);
  const base: HeaderModel | undefined = modelFor(o.target === 'auto' ? (family ?? '') : o.target);
  let header: Uint8Array;
  if (o.target === 'custom') header = customHeader(o.header, family ? modelFor(family) : undefined);
  else if (base) header = base.header;
  else throw new ToolError(T('err.noModel'));
  const certain =
    o.target === 'custom' ? Math.min(BLOCK, o.header.replace(/\s/g, '').length / 2) : base!.certain;

  const iv = deriveIv(cipher, cand.key, header);
  const recovered = decryptWithIv(cipher, cand.key, iv);
  const real = identify(recovered)[0];
  const model = base ?? (real ? HEADER_MODELS.find((m) => m.ext === real.ext) : undefined);
  const ext = real && !real.weak ? real.ext : (model?.ext ?? 'bin');
  const name = `recovered.${ext}`;

  out.push({
    type: 'note',
    level: 'success',
    text: T('verdict.confirmed', {
      key: showKey(cand.key),
      name: real?.name ?? model?.name ?? '?',
    }),
  });
  out.push({
    type: 'kv',
    label: T('label.found'),
    entries: [
      [T('kv.key'), showKey(cand.key)],
      [T('kv.variant'), `AES-${cand.key.length * 8}-CBC`],
      [T('kv.keySource'), sourceLabel(cand)],
      [T('kv.iv'), toHex(iv)],
      [T('kv.proof'), signatures.map((s) => SIG_LABEL[s]?.() ?? s).join(', ')],
      [
        T('kv.recovered'),
        `${real?.name ?? T('value.unknownType')} · ${formatSize(recovered.length)}`,
      ],
    ],
  });

  const mime = real?.mime;
  if (mime && /^image\/(png|jpeg|gif)$/.test(mime)) {
    out.push({
      type: 'picture',
      label: T('label.recovered'),
      data: recovered,
      mime,
      filename: name,
    });
  } else {
    out.push({ type: 'bytes', label: T('label.recovered'), value: recovered, filename: name });
  }

  out.push({ type: 'note', level: 'info', text: T('note.how', { iv: toHex(iv), certain }) });
  if (certain < BLOCK) {
    out.push({ type: 'note', level: 'warn', text: T('note.headerGuess', { certain }) });
  }
  if (!real) out.push({ type: 'note', level: 'warn', text: T('note.unverified') });
  else if (recovered.length > 0) out.push({ type: 'note', level: 'info', text: T('note.next') });
  out.push(kv);
  if (trimmed !== 0)
    out.push({ type: 'note', level: 'warn', text: T('note.trimmed', { n: trimmed }) });
  out.push({ type: 'note', level: 'info', text: T('note.honest') });
  out.push({ type: 'note', level: 'info', text: T('note.technique') });
  return out;
}

function encryptRun(
  plain: Uint8Array,
  o: { key: string; keyFormat: KeyFormat; iv: string; cover: string },
): Output[] {
  if (plain.length === 0) throw new ToolError(T('err.empty'));
  const key = parseKey(o.key, o.keyFormat);
  if (!key) throw new ToolError(o.key.trim() === '' ? T('err.needKey') : T('err.badTypedKey'));
  const padded = padTo16(plain);
  let cipher: Uint8Array;
  let iv: Uint8Array;
  const cover = modelFor(o.cover);
  if (cover) {
    ({ cipher, iv } = buildConstruct(plain, key, cover.header));
  } else {
    const clean = o.iv.replace(/0x/gi, '').replace(/[\s:,_-]/g, '');
    if (clean !== '' && !/^[0-9a-f]{32}$/i.test(clean)) throw new ToolError(T('err.badIv'));
    iv = clean === '' ? new Uint8Array(BLOCK) : fromHex(clean);
    cipher = encrypt(padded, key, iv);
  }
  const back = decryptWithIv(cipher, key, iv);
  if (toHex(back) !== toHex(padded)) throw new ToolError(T('err.roundTrip'));

  const out: Output[] = [
    {
      type: 'note',
      level: 'success',
      text: cover ? T('built.cover', { name: cover.name }) : T('built.plain'),
    },
    {
      type: 'kv',
      label: T('label.built'),
      entries: [
        [T('kv.key'), showKey(key)],
        [T('kv.variant'), `AES-${key.length * 8}-CBC`],
        [T('kv.iv'), toHex(iv)],
        [T('kv.input'), formatSize(plain.length)],
        [T('kv.output'), formatSize(cipher.length)],
      ],
    },
    { type: 'bytes', label: T('label.output'), value: cipher, filename: 'angecryption-built.bin' },
  ];
  if (padded.length !== plain.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.padded', { n: padded.length - plain.length }),
    });
  }
  if (cover) out.push({ type: 'note', level: 'warn', text: T('note.coverLimit') });
  out.push({ type: 'note', level: 'info', text: T('note.technique') });
  return out;
}

const MODEL_CHOICES = HEADER_MODELS.map((m) => ({ value: m.id, label: m.name }));

export default defineTool({
  id: 'angecryption',
  name: 'AngeCryption',
  category: 'crypto',
  description:
    'AES-CBC polyglots (Ange Albertini): test candidate keys on a file that decrypts into another file, recover the hidden file and its IV, or build the construct.',
  tags: [
    'angecryption',
    'angecrypt',
    'ange albertini',
    'corkami',
    'polyglot',
    'aes',
    'cbc',
    'iv',
    'encrypted png',
    'file that decrypts to a file',
  ],
  input: 'bytes',
  placeholder: 'Drop the suspect file (its size is a multiple of 16 bytes)',
  options: {
    mode: toggle('Mode', [
      { value: 'decrypt', label: 'Recover the hidden file' },
      { value: 'encrypt', label: 'Build (encrypt)' },
    ]),
    key: text('Key', '', {
      placeholder: 'FTF-angecrypt-16   or   00112233445566778899aabbccddeeff',
      hint: 'UTF-8 text or hex of 16, 24 or 32 bytes: its length picks AES-128, 192 or 256.',
    }),
    keyFormat: select(
      'Key format',
      [
        { value: 'auto', label: 'Auto (hex if 32/48/64 hex digits, else text)' },
        { value: 'text', label: 'UTF-8 text' },
        { value: 'hex', label: 'Hex' },
      ],
      'auto',
    ),
    keyList: file('Key list (one per line)', 'bytes', {
      hint: 'A text file of candidate keys, one per line, same format as above. Lines of an invalid AES length are skipped.',
      showIf: (v) => v.mode === 'decrypt',
    }),
    windows: bool('Also try keys cut from the file itself', false, {
      hint: `Every 16, 24 and 32-byte window from the start of the file, at most ${MAX_WINDOWS} keys.`,
      showIf: (v) => v.mode === 'decrypt',
    }),
    target: select(
      'Hidden file type',
      [
        { value: 'auto', label: 'Auto (from the signatures found)' },
        ...MODEL_CHOICES,
        { value: 'custom', label: 'Custom header (hex)' },
      ],
      'auto',
      {
        hint: 'The first 16 bytes of the hidden file, used to derive the IV.',
        showIf: (v) => v.mode === 'decrypt',
      },
    ),
    header: text('Header (hex)', '', {
      placeholder: '89504e470d0a1a0a0000000d49484452',
      hint: 'Up to 16 bytes; missing bytes are taken from the model of the detected type, or zeros.',
      showIf: (v) => v.mode === 'decrypt' && v.target === 'custom',
    }),
    iv: text('IV (hex)', '', {
      placeholder: '32 hex digits, empty = all zeros',
      showIf: (v) => v.mode === 'encrypt' && v.cover === 'none',
    }),
    cover: select(
      'Visible file header',
      [{ value: 'none', label: 'None (plain CBC with the IV above)' }, ...MODEL_CHOICES],
      'none',
      {
        hint: 'Start the output with the header of this format and derive the IV so that the input comes out when decrypting.',
        showIf: (v) => v.mode === 'encrypt',
      },
    ),
  },
  examples: [
    {
      label: 'Encrypted PNG (key given)',
      input: { sample: 'angecryption-sample.bin' },
      options: { key: 'FTF-angecrypt-16' },
      expect: 'Angecryption confirmed',
    },
  ],
  run({ bytes }, o) {
    if (o.mode === 'encrypt') return encryptRun(bytes, o);
    return decryptRun(bytes, {
      key: o.key,
      keyFormat: o.keyFormat,
      keyList: o.keyList,
      windows: o.windows,
      target: o.target,
      header: o.header,
    });
  },
});
