import { bool, defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  concatBytes,
  formatSize,
  printableRatio,
  toBase64,
  toHex,
  utf8Encode,
} from '../../lib/bytes';
import {
  ALGOS,
  ALGO_NAME,
  DERIVED_KEY,
  HASHES,
  HASH_NAME,
  MODES,
  FORMAT_NAME,
  MODE_NAME,
  acceptsKey,
  decryptData,
  deriveStream,
  derivedIvLength,
  encryptData,
  isAead,
  isPadded,
  ivLength,
  parseField,
  readCiphertext,
  splitKeyIv,
  splitSalted,
  usesIv,
  usesMode,
  wrapBase64,
  type Algo,
  type Derivation,
  type FieldFormat,
  type Hash,
  type InFormat,
  type Kdf,
  type Mode,
  type PadStatus,
  type Padding,
  type TagStatus,
} from './_symmetric';
import {
  CHACHA_IV16,
  IV16,
  IV8,
  KEY16,
  KEY24,
  KEY32,
  NOSALT_MD5,
  PASSPHRASE,
  PBKDF2_BODY_SALT_0011,
  PLAINTEXT,
  RAW,
  SALTED_3DES_MD5,
  SALTED_MD5,
  SALTED_PBKDF2,
  SALTED_RC4_MD5,
} from './_symmetric-examples';
import { searchModes, type Candidate, type IvSource } from './_symmetric-search';

const T = toolT('symmetric');

// ---------------------------------------------------------------- options

/** The option values `run` reads (the option builders below produce exactly these types). */
interface Settings {
  action: 'decrypt' | 'encrypt' | 'search';
  algorithm: Algo;
  mode: Mode;
  kdf: Kdf;
  key: string;
  keyFormat: FieldFormat;
  kdfHash: Hash;
  iterations: number;
  salt: string;
  iv: string;
  ivFormat: FieldFormat;
  ivPrefix: boolean;
  inputFormat: InFormat;
  padding: Padding;
  counter: number;
  aad: string;
}

type Values = Record<string, unknown>;
const algoOf = (v: Values): Algo => ALGOS.find((a) => a === v.algorithm) ?? 'aes-256';
const modeOf = (v: Values): Mode => MODES.find((m) => m === v.mode) ?? 'cbc';
const searching = (v: Values) => v.action === 'search';
const derivedKdf = (v: Values) => v.kdf === 'openssl' || v.kdf === 'pbkdf2';
/** The IV is typed by the user (the OpenSSL derivations produce it, ECB and RC4 have none). */
const askIv = (v: Values) =>
  (v.kdf === 'raw' || v.kdf === 'hash') && (searching(v) || usesIv(algoOf(v), modeOf(v)));

const FORMATS = [
  { value: 'hex', label: 'Hex' },
  { value: 'base64', label: 'Base64' },
  { value: 'text', label: 'Text (UTF-8)' },
] satisfies { value: FieldFormat; label: string }[];

// ------------------------------------------------------------------ helpers

const zeros = (n: number) => new Uint8Array(n);
const hex = (b: Uint8Array) => toHex(b);

/** "Read as hex that key would be 16 bytes long": the way out of a wrong key length. */
function keyHint(o: Settings): string {
  for (const f of ['text', 'hex', 'base64'] as const) {
    if (f === o.keyFormat) continue;
    try {
      const n = parseField(o.key, f, 'key').length;
      if (n > 0 && acceptsKey(o.algorithm, n)) {
        return T('hint.keyFormat', { format: FORMAT_NAME[f](), size: n });
      }
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
    }
  }
  return '';
}

/** AAD: UTF-8 text, or hex after a `hex:` prefix. */
function parseAad(value: string): Uint8Array {
  return /^hex:/i.test(value) ? parseField(value.slice(4), 'hex', 'aad') : utf8Encode(value);
}

const blank = (value: string, format: FieldFormat) =>
  format === 'text' ? value === '' : value.trim() === '';

type SaltSource = 'header' | 'option' | 'default' | 'none';

interface Plan {
  algo: Algo;
  mode: Mode;
  key: Uint8Array;
  iv: Uint8Array;
  ivSource: IvSource;
  /** The data to run: header and IV prefix taken off. */
  data: Uint8Array;
  derivation: Derivation | null;
  salt: Uint8Array | null;
  saltSource: SaltSource | null;
  aad: Uint8Array;
}

/** Turn the options into a key, an IV and the data to process (derivations run here). */
async function plan(o: Settings, input: Uint8Array, encrypting: boolean): Promise<Plan> {
  const { algorithm: algo, mode } = o;
  let data = input;
  let salt: Uint8Array | null = null;
  let saltSource: SaltSource | null = null;
  const openssl = o.kdf === 'openssl' || o.kdf === 'pbkdf2';
  if (openssl) {
    const header = encrypting ? null : splitSalted(data);
    if (header) {
      salt = header.salt;
      data = header.body;
      saltSource = 'header';
    } else if (!blank(o.salt, 'hex')) {
      salt = parseField(o.salt, 'hex', 'salt');
      if (encrypting && salt.length !== 8) {
        throw new ToolError(T('error.saltLength', { got: salt.length }));
      }
      saltSource = 'option';
    } else if (encrypting) {
      salt = zeros(8);
      saltSource = 'default';
    } else {
      saltSource = 'none';
    }
  }

  let key: Uint8Array;
  let iv: Uint8Array = new Uint8Array();
  let ivSource: IvSource = 'none';
  let derivation: Derivation | null = null;
  if (o.kdf === 'raw') {
    if (blank(o.key, o.keyFormat)) throw new ToolError(T('error.noKey'));
    key = parseField(o.key, o.keyFormat, 'key');
  } else {
    if (o.key === '') throw new ToolError(T('error.noKey'));
    derivation = { kdf: o.kdf, hash: o.kdfHash, iterations: o.iterations, salt };
    const stream = await deriveStream(
      derivation,
      utf8Encode(o.key),
      DERIVED_KEY[algo] + (openssl ? derivedIvLength(algo, mode) : 0),
    );
    const split = splitKeyIv(derivation, stream, algo, mode);
    key = split.key;
    if (split.iv) {
      iv = split.iv;
      ivSource = iv.length > 0 ? 'derived' : 'none';
    }
  }

  const need = ivLength(algo, mode);
  if (!openssl && need > 0) {
    if (o.ivPrefix && !encrypting) {
      if (data.length < need) {
        throw new ToolError(T('error.ivPrefixShort', { need, size: data.length }));
      }
      iv = data.slice(0, need);
      data = data.subarray(need);
      ivSource = 'prefix';
    } else if (!blank(o.iv, o.ivFormat)) {
      iv = parseField(o.iv, o.ivFormat, 'iv');
      ivSource = 'given';
    } else {
      iv = zeros(need);
      ivSource = 'zero';
    }
  }
  const aad = isAead(algo, mode) ? parseAad(o.aad) : new Uint8Array();
  return { algo, mode, key, iv, ivSource, data, derivation, salt, saltSource, aad };
}

// ----------------------------------------------------------------- reporting

const modeText = (algo: Algo, mode: Mode) => (usesMode(algo) ? MODE_NAME[mode] : T('value.stream'));

function derivationText(d: Derivation | null): string {
  if (!d) return T('value.rawKey');
  const hash = HASH_NAME[d.hash];
  if (d.kdf === 'openssl') return T('value.evp', { hash });
  if (d.kdf === 'pbkdf2') return T('value.pbkdf2', { hash, iterations: d.iterations });
  return T('value.hashKey', { hash });
}

function saltText(p: Plan): string | null {
  const h = p.salt ? hex(p.salt) : '';
  switch (p.saltSource) {
    case 'header':
      return T('value.salt.header', { hex: h });
    case 'option':
      return T('value.salt.option', { hex: h });
    case 'default':
      return T('value.salt.default', { hex: h });
    case 'none':
      return T('value.salt.none');
    case null:
      return null;
  }
}

function ivText(iv: Uint8Array, source: IvSource): string | null {
  const h = hex(iv);
  switch (source) {
    case 'given':
      return h;
    case 'zero':
      return T('value.iv.zero', { hex: h });
    case 'prefix':
      return T('value.iv.prefix', { hex: h });
    case 'derived':
      return T('value.iv.derived', { hex: h });
    case 'none':
      return null;
  }
}

function paddingText(status: PadStatus, removed: number): string {
  switch (status) {
    case 'valid':
      return T('value.pad.valid', { count: removed });
    case 'invalid':
      return T('value.pad.invalid');
    case 'zeros':
      return T('value.pad.zeros', { count: removed });
    case 'none':
      return T('value.pad.none');
    case 'n/a':
      return T('value.pad.na');
  }
}

function addedText(kind: Padding, count: number): string {
  if (kind === 'pkcs7') return T('value.pad.addedPkcs7', { count });
  if (kind === 'zero') return T('value.pad.addedZero', { count });
  return T('value.pad.none');
}

function tagText(tag: TagStatus): string | null {
  if (tag === null) return null;
  return tag === 'valid' ? T('value.tag.valid') : T('value.tag.invalid');
}

/** The common rows of the "Details" list. */
function summary(p: Plan): [string, string][] {
  const rows: [string, string][] = [
    [T('kv.algorithm'), ALGO_NAME[p.algo]],
    [T('kv.mode'), modeText(p.algo, p.mode)],
    [T('kv.derivation'), derivationText(p.derivation)],
  ];
  const salt = saltText(p);
  if (salt) rows.push([T('kv.salt'), salt]);
  rows.push([T('kv.key'), hex(p.key)]);
  const iv = ivText(p.iv, p.ivSource);
  if (iv) rows.push([T('kv.iv'), iv]);
  return rows;
}

function noteOf(level: 'info' | 'warn' | 'error' | 'success', text: string): Output {
  return { type: 'note', level, text };
}

// ------------------------------------------------------------------- decrypt

async function decrypt(bytes: Uint8Array, o: Settings): Promise<Output[]> {
  if (!bytes.length) throw new ToolError(T('error.noData'));
  const read = readCiphertext(bytes, o.inputFormat);
  const out: Output[] = [];
  // A Salted__ file read with a raw key: the header is data, and the key cannot be right.
  const saltedRaw = o.kdf === 'raw' && splitSalted(read.data) !== null;
  if (saltedRaw) {
    out.push(noteOf('warn', T('note.salted')), {
      type: 'actions',
      actions: [
        { label: T('action.openssl'), options: { kdf: 'openssl' }, primary: true },
        { label: T('action.pbkdf2'), options: { kdf: 'pbkdf2' } },
      ],
    });
  }
  let p: Plan;
  let result: ReturnType<typeof decryptData>;
  try {
    p = await plan(o, read.data, false);
    result = decryptData(
      {
        algo: p.algo,
        mode: p.mode,
        key: p.key,
        iv: p.iv,
        aad: p.aad,
        counter: o.counter,
        data: p.data,
        padding: o.padding,
      },
      o.kdf === 'raw' ? keyHint(o) : '',
    );
  } catch (e) {
    if (saltedRaw && e instanceof ToolError) {
      throw new ToolError(`${e.message} ${T('hint.salted')}`);
    }
    throw e;
  }

  if (p.saltSource === 'none') out.push(noteOf('info', T('note.noSalt')));
  if (p.ivSource === 'zero') out.push(noteOf('info', T('note.zeroIv')));
  if (result.padding === 'valid') out.push(noteOf('success', T('note.padValid')));
  else if (result.padding === 'invalid') out.push(noteOf('warn', T('note.padInvalid')));
  if (result.tag === 'valid') out.push(noteOf('success', T('note.tagValid')));
  else if (result.tag === 'invalid') out.push(noteOf('warn', T('note.tagInvalid')));
  const sure = result.padding === 'valid' || result.tag === 'valid';
  const readable =
    result.output.length > 0 && printableRatio(result.output.subarray(0, 4096)) >= 0.85;
  if (!sure && !readable) {
    // Nothing says the key is right and the output is noise: point to the search.
    if (result.padding !== 'invalid') out.push(noteOf('info', T('note.unreadable')));
    out.push({
      type: 'actions',
      actions: [{ label: T('action.search'), options: { action: 'search' } }],
    });
  }

  out.push({
    type: 'bytes',
    label: T('label.plaintext'),
    value: result.output,
    filename: 'decrypted.bin',
  });

  const readFormat = FORMAT_NAME[read.format]();
  const rows = summary(p);
  rows.push([T('kv.read'), read.auto ? T('value.read.auto', { format: readFormat }) : readFormat]);
  if (isPadded(p.algo, p.mode)) {
    rows.push([T('kv.padding'), paddingText(result.padding, result.removed)]);
  }
  const tag = tagText(result.tag);
  if (tag) rows.push([T('kv.tag'), tag]);
  rows.push([T('kv.size'), formatSize(result.output.length)]);
  out.push({ type: 'kv', label: T('label.details'), entries: rows });
  return out;
}

// ------------------------------------------------------------------- encrypt

const SALTED_HEADER = utf8Encode('Salted__');

async function encrypt(bytes: Uint8Array, o: Settings): Promise<Output[]> {
  if (!bytes.length) throw new ToolError(T('error.noData'));
  const p = await plan(o, bytes, true);
  const hint = o.kdf === 'raw' ? keyHint(o) : '';
  const enc = encryptData(
    {
      algo: p.algo,
      mode: p.mode,
      key: p.key,
      iv: p.iv,
      aad: p.aad,
      counter: o.counter,
      data: p.data,
      padding: o.padding,
    },
    hint,
  );
  const out: Output[] = [];
  if (p.saltSource === 'default') out.push(noteOf('info', T('note.defaultSalt')));
  if (p.ivSource === 'zero') out.push(noteOf('info', T('note.zeroIv')));

  const prefixed = o.ivPrefix && p.ivSource !== 'derived' && p.iv.length > 0;
  const body = prefixed ? concatBytes(p.iv, enc.output) : enc.output;
  out.push(
    { type: 'text', label: T('label.cipherHex'), value: hex(body) },
    { type: 'text', label: T('label.cipherBase64'), value: toBase64(body) },
  );
  let file = body;
  if (p.salt && p.derivation) {
    file = concatBytes(SALTED_HEADER, p.salt, body);
    out.push({
      type: 'text',
      label: T('label.openssl'),
      value: wrapBase64(toBase64(file)),
    });
  }
  out.push({
    type: 'bytes',
    label: T('label.cipherFile'),
    value: file,
    filename: p.salt ? 'encrypted.enc' : 'encrypted.bin',
  });

  const rows = summary(p);
  if (isPadded(p.algo, p.mode)) {
    rows.push([T('kv.padding'), addedText(o.padding, enc.added)]);
  }
  if (enc.tag) rows.push([T('kv.tag'), hex(enc.tag)]);
  if (prefixed) rows.push([T('kv.ivPrefixed'), T('value.yes')]);
  rows.push([T('kv.size'), formatSize(file.length)]);
  out.push({ type: 'kv', label: T('label.details'), entries: rows });
  return out;
}

// -------------------------------------------------------------------- search

/** Printable ASCII view of the start of the output, '.' for the rest. */
function preview(b: Uint8Array, max = 22): string {
  let s = '';
  for (let i = 0; i < Math.min(b.length, max); i++) {
    const c = b[i]!;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
  }
  return s + (b.length > max ? '…' : '');
}

const WEAK = 30;
const SHOWN = 15;

function candidateCheck(c: Candidate): string {
  if (c.outcome.tag === 'valid') return T('value.check.tag');
  if (c.outcome.padding === 'valid') return T('value.check.padding');
  return T('value.check.none');
}

async function search(bytes: Uint8Array, o: Settings): Promise<Output[]> {
  if (!bytes.length) throw new ToolError(T('error.noData'));
  const read = readCiphertext(bytes, o.inputFormat);
  let data = read.data;
  let salt: Uint8Array | null = null;
  const openssl = o.kdf === 'openssl' || o.kdf === 'pbkdf2';
  if (openssl) {
    const header = splitSalted(data);
    if (header) {
      salt = header.salt;
      data = header.body;
    } else if (!blank(o.salt, 'hex')) {
      salt = parseField(o.salt, 'hex', 'salt');
    }
  }
  const raw = o.kdf === 'raw';
  if (raw ? blank(o.key, o.keyFormat) : o.key === '') throw new ToolError(T('error.noKey'));
  const secret = raw ? parseField(o.key, o.keyFormat, 'key') : utf8Encode(o.key);
  const iv =
    !openssl && !blank(o.iv, o.ivFormat) ? parseField(o.iv, o.ivFormat, 'iv') : new Uint8Array();

  const res = await searchModes({
    data,
    kdf: o.kdf,
    secret,
    iv,
    ivPrefix: o.ivPrefix,
    aad: parseAad(o.aad),
    counter: o.counter,
    iterations: o.iterations,
    salt,
  });
  const best = res.candidates[0];
  if (!best) throw new ToolError(T('error.searchNothing', { got: secret.length }));

  const out: Output[] = [
    noteOf('info', T('note.search', { tried: res.tried, skipped: res.skipped })),
  ];
  if (!raw) {
    out.push(
      noteOf(
        'info',
        T('note.searchHashes', { hashes: HASHES.map((h) => HASH_NAME[h]).join(', ') }),
      ),
    );
  }
  const found = best.score >= WEAK;
  if (!found) out.push(noteOf('warn', T('note.searchWeak')));

  const name = usesMode(best.algo)
    ? `${ALGO_NAME[best.algo]} ${MODE_NAME[best.mode]}`
    : ALGO_NAME[best.algo];
  out.push({
    type: 'bytes',
    label: T('label.best', { name }),
    value: best.outcome.output,
    filename: 'decrypted.bin',
  });

  if (found) {
    out.push({
      type: 'actions',
      label: T('label.apply'),
      actions: res.candidates
        .slice(0, 3)
        .filter((c) => c.score >= WEAK)
        .map((c, i) => {
          const n = usesMode(c.algo)
            ? `${ALGO_NAME[c.algo]} ${MODE_NAME[c.mode]}`
            : ALGO_NAME[c.algo];
          const options: Record<string, unknown> = { action: 'decrypt', algorithm: c.algo };
          if (usesMode(c.algo)) options.mode = c.mode;
          if (c.hash) options.kdfHash = c.hash;
          if (c.outcome.padding === 'valid') options.padding = 'pkcs7';
          return {
            label: c.hash
              ? T('action.useHash', { name: n, hash: HASH_NAME[c.hash] })
              : T('action.use', { name: n }),
            options,
            primary: i === 0,
          };
        }),
    });
  }

  const derived = !raw;
  out.push({
    type: 'table',
    label: T('label.ranking'),
    columns: [
      T('col.algorithm'),
      T('col.mode'),
      ...(derived ? [T('col.hash')] : []),
      T('col.check'),
      T('col.printable'),
      T('col.readable'),
      T('col.score'),
      T('col.preview'),
    ],
    rows: res.candidates
      .slice(0, SHOWN)
      .map((c) => [
        ALGO_NAME[c.algo],
        usesMode(c.algo) ? MODE_NAME[c.mode] : '—',
        ...(derived && c.hash ? [HASH_NAME[c.hash]] : []),
        candidateCheck(c),
        `${Math.round(c.printable * 100)}%`,
        Math.round(c.readable),
        Math.round(c.score),
        preview(c.outcome.output),
      ]),
    highlight: [0],
  });

  const rows: [string, string][] = [
    [T('kv.algorithm'), ALGO_NAME[best.algo]],
    [T('kv.mode'), modeText(best.algo, best.mode)],
  ];
  if (best.hash && o.kdf !== 'raw') {
    const d: Derivation = { kdf: o.kdf, hash: best.hash, iterations: o.iterations, salt };
    rows.push([T('kv.derivation'), derivationText(d)]);
  }
  rows.push([T('kv.key'), hex(best.key)]);
  const ivRow = ivText(best.iv, best.ivSource);
  if (ivRow) rows.push([T('kv.iv'), ivRow]);
  if (isPadded(best.algo, best.mode)) {
    rows.push([T('kv.padding'), paddingText(best.outcome.padding, best.outcome.removed)]);
  }
  const tag = tagText(best.outcome.tag);
  if (tag) rows.push([T('kv.tag'), tag]);
  out.push({ type: 'kv', label: T('label.bestDetails'), entries: rows });
  return out;
}

// ---------------------------------------------------------------------- tool

const OPTIONS = {
  action: toggle(
    'Operation',
    [
      { value: 'decrypt', label: 'Decrypt' },
      { value: 'encrypt', label: 'Encrypt' },
      { value: 'search', label: 'Try every mode' },
    ],
    'decrypt',
    {
      hint: 'Try every mode runs your data through every algorithm and mode that accepts the key and ranks the results (local search over your own data).',
    },
  ),
  algorithm: select(
    'Algorithm',
    ALGOS.map((a) => ({ value: a, label: ALGO_NAME[a] })),
    'aes-256',
    { showIf: (v) => !searching(v) },
  ),
  mode: select(
    'Mode',
    MODES.map((m) => ({ value: m, label: MODE_NAME[m] })),
    'cbc',
    {
      showIf: (v) => !searching(v) && usesMode(algoOf(v)),
      hint: 'GCM is AES only: the last 16 bytes of the data are the authentication tag.',
    },
  ),
  kdf: toggle(
    'Key derivation',
    [
      { value: 'raw', label: 'Raw key' },
      { value: 'openssl', label: 'OpenSSL enc' },
      { value: 'pbkdf2', label: 'OpenSSL -pbkdf2' },
      { value: 'hash', label: 'Passphrase hash' },
    ],
    'raw',
    {
      hint: 'OpenSSL enc: passphrase to key and IV like `openssl enc` (EVP_BytesToKey, or PBKDF2 with -pbkdf2), salt read from the Salted__ header. Passphrase hash: the key is the hash of the passphrase.',
    },
  ),
  key: text('Key or passphrase', '', {
    placeholder: '000102…0f (hex)  ·  or a passphrase',
    hint: 'A raw key in the chosen Key format, or a passphrase (always text) for the OpenSSL and hash options.',
  }),
  keyFormat: toggle('Key format', FORMATS, 'hex', { showIf: (v) => v.kdf === 'raw' }),
  kdfHash: select(
    'Hash',
    HASHES.map((h) => ({ value: h, label: HASH_NAME[h] })),
    'sha256',
    {
      showIf: (v) => v.kdf !== 'raw' && !searching(v),
      hint: 'openssl enc used MD5 before 1.1.0 and uses SHA-256 since. -pbkdf2 defaults to SHA-256. Try every mode tries all four.',
    },
  ),
  iterations: number('Iterations', 10000, {
    min: 1,
    max: 5_000_000,
    showIf: (v) => v.kdf === 'pbkdf2',
    hint: 'The -iter value; openssl enc -pbkdf2 uses 10000 by default.',
  }),
  salt: text('Salt (hex)', '', {
    placeholder: '8 bytes, optional',
    showIf: derivedKdf,
    hint: 'Read from the Salted__ header when there is one. Used when the data has no header (openssl enc -S, a salt given on the side) and when encrypting (empty: eight zero bytes).',
  }),
  iv: text('IV / nonce', '', {
    placeholder: '0f0e0d0c… (empty: all zeros)',
    showIf: askIv,
    hint: 'Empty means an all-zero IV, common in CTF challenges. ChaCha20 takes a 12-byte nonce, or 16 bytes as OpenSSL writes it (counter + nonce).',
  }),
  ivFormat: toggle('IV format', FORMATS, 'hex', { showIf: askIv }),
  ivPrefix: bool('IV is in front of the data', false, {
    showIf: askIv,
    hint: 'Decrypt: the first bytes of the ciphertext are the IV. Encrypt: write the IV in front of the ciphertext.',
  }),
  inputFormat: select(
    'Ciphertext format',
    [
      { value: 'auto', label: 'Auto (hex, base64 or raw)' },
      { value: 'hex', label: 'Hex' },
      { value: 'base64', label: 'Base64' },
      { value: 'raw', label: 'Raw bytes' },
    ],
    'auto',
    {
      showIf: (v) => v.action !== 'encrypt',
      hint: 'Pasted text is read as hex or base64 when it looks like one; a dropped file is read as raw bytes.',
    },
  ),
  padding: toggle(
    'Padding',
    [
      { value: 'pkcs7', label: 'PKCS#7' },
      { value: 'zero', label: 'Zero' },
      { value: 'none', label: 'None' },
    ],
    'pkcs7',
    {
      showIf: (v) => !searching(v) && isPadded(algoOf(v), modeOf(v)),
      hint: 'ECB and CBC only. Valid PKCS#7 padding is a strong sign the key is right.',
    },
  ),
  counter: number('Start counter', 0, {
    min: 0,
    max: 4_294_967_295,
    showIf: (v) => searching(v) || algoOf(v) === 'chacha20',
    hint: 'ChaCha20 block counter to start from (12-byte nonce: RFC 8439 examples use 1). A 16-byte IV carries its own counter.',
  }),
  aad: text('Additional data (AAD)', '', {
    placeholder: 'text, or hex:0102…',
    showIf: (v) => searching(v) || isAead(algoOf(v), modeOf(v)),
    hint: 'Authenticated but not encrypted data of GCM and ChaCha20-Poly1305. Empty if there is none.',
  }),
};

export default defineTool({
  id: 'symmetric',
  name: 'Symmetric ciphers',
  category: 'crypto',
  description:
    'Decrypt or encrypt with AES, DES / 3DES, RC4 and ChaCha20, read OpenSSL enc output (Salted__), or try every mode on your key.',
  tags: [
    'aes',
    'des',
    '3des',
    'triple des',
    'tdes',
    'rc4',
    'chacha20',
    'poly1305',
    'cbc',
    'ecb',
    'ctr',
    'cfb',
    'ofb',
    'gcm',
    'openssl enc',
    'openssl',
    'salted__',
    'evp_bytestokey',
    'pbkdf2',
    'decrypt',
    'encrypt',
    'block cipher',
    'stream cipher',
    'cyberchef aes decrypt',
    'cryptojs',
  ],
  input: 'bytes',
  placeholder: 'Ciphertext as hex, base64 or raw (U2FsdGVkX1… is an OpenSSL file), or open a file',
  options: OPTIONS,
  examples: [
    {
      label: 'OpenSSL Salted__ AES-256-CBC (-pbkdf2)',
      input: SALTED_PBKDF2,
      options: {
        algorithm: 'aes-256',
        mode: 'cbc',
        kdf: 'pbkdf2',
        key: PASSPHRASE,
        kdfHash: 'sha256',
        iterations: 10000,
      },
      expect: PLAINTEXT,
    },
    {
      label: 'Old OpenSSL blob (MD5 key derivation)',
      input: SALTED_MD5,
      options: {
        algorithm: 'aes-256',
        mode: 'cbc',
        kdf: 'openssl',
        key: PASSPHRASE,
        kdfHash: 'md5',
      },
      expect: PLAINTEXT,
    },
    {
      label: 'AES-128-ECB with a hex key',
      input: { hex: RAW.aes128ecb },
      options: { algorithm: 'aes-128', mode: 'ecb', kdf: 'raw', key: KEY16, keyFormat: 'hex' },
      expect: PLAINTEXT,
    },
    {
      label: 'AES-128-CBC with a key and an IV',
      input: { hex: RAW.aes128cbc },
      options: {
        algorithm: 'aes-128',
        mode: 'cbc',
        key: KEY16,
        iv: IV16,
      },
      expect: PLAINTEXT,
    },
    {
      label: 'Triple DES (3DES-CBC)',
      input: { hex: RAW.tdes3cbc },
      options: { algorithm: '3des', mode: 'cbc', key: KEY24, iv: IV8 },
      expect: PLAINTEXT,
    },
    {
      label: 'RC4 with a hex key',
      input: { hex: RAW.rc4 },
      options: { algorithm: 'rc4', key: KEY16 },
      expect: PLAINTEXT,
    },
    {
      label: 'ChaCha20 (OpenSSL IV: counter + nonce)',
      input: { hex: RAW.chacha20 },
      options: { algorithm: 'chacha20', key: KEY32, iv: CHACHA_IV16 },
      expect: PLAINTEXT,
    },
    {
      label: 'Encrypt with AES-128-CBC',
      input: PLAINTEXT,
      options: { action: 'encrypt', algorithm: 'aes-128', mode: 'cbc', key: KEY16, iv: IV16 },
      expect: RAW.aes128cbc,
    },
    {
      label: 'Encrypt to an OpenSSL Salted__ file',
      input: PLAINTEXT,
      options: {
        action: 'encrypt',
        algorithm: 'aes-256',
        mode: 'cbc',
        kdf: 'pbkdf2',
        key: PASSPHRASE,
        salt: PBKDF2_BODY_SALT_0011,
      },
      expect: 'U2FsdGVkX18AESIzRFVmd+LTVvSEOIfgoKoHNR8U7jnRwIIuqpBVT09n+2QrScUL',
    },
    {
      label: 'Try every mode with a known key',
      input: { hex: RAW.aes128ctr },
      options: { action: 'search', kdf: 'raw', key: KEY16, iv: IV16 },
      expect: 'Best guess: AES-128 CTR',
    },
    {
      label: 'Try every mode with only a passphrase',
      input: SALTED_3DES_MD5,
      options: { action: 'search', kdf: 'openssl', key: PASSPHRASE },
      expect: 'Best guess: 3DES CBC',
    },
    {
      label: 'Salted__ RC4 blob found by search',
      input: SALTED_RC4_MD5,
      options: { action: 'search', kdf: 'openssl', key: PASSPHRASE },
      expect: PLAINTEXT,
    },
    {
      label: 'No Salted__ header (openssl enc -nosalt)',
      input: NOSALT_MD5,
      options: {
        algorithm: 'aes-256',
        mode: 'cbc',
        kdf: 'openssl',
        key: PASSPHRASE,
        kdfHash: 'md5',
      },
      expect: PLAINTEXT,
    },
  ],
  detect({ text, bytes }) {
    const salted = text ? /^\s*U2FsdGVkX1/.test(text) : splitSalted(bytes.subarray(0, 16)) !== null;
    if (!salted) return null;
    return { score: 0.9, options: { kdf: 'openssl' }, reason: T('detect.salted') };
  },
  async run({ bytes }, o) {
    if (o.action === 'encrypt') return encrypt(bytes, o);
    if (o.action === 'search') return search(bytes, o);
    return decrypt(bytes, o);
  },
});
