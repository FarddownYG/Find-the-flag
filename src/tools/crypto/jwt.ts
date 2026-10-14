import { bool, defineTool, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { fromBase64, toBase64, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import { createHmac, type HmacAlgo } from './_hmac';
import { WEAK_SECRETS } from './_jwt-secrets';

const T = toolT('jwt');

const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const b64url = (b: Uint8Array) => toBase64(b, URL_SAFE, false);

const HS: Record<string, HmacAlgo> = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };

interface AsymAlg {
  importAlg: RsaHashedImportParams | EcKeyImportParams | Algorithm;
  verifyAlg: Algorithm | RsaPssParams | EcdsaParams;
}

const rsa = (name: string, bits: number): AsymAlg['importAlg'] => ({
  name,
  hash: `SHA-${bits}`,
});

const ASYM: Record<string, AsymAlg> = {
  RS256: { importAlg: rsa('RSASSA-PKCS1-v1_5', 256), verifyAlg: { name: 'RSASSA-PKCS1-v1_5' } },
  RS384: { importAlg: rsa('RSASSA-PKCS1-v1_5', 384), verifyAlg: { name: 'RSASSA-PKCS1-v1_5' } },
  RS512: { importAlg: rsa('RSASSA-PKCS1-v1_5', 512), verifyAlg: { name: 'RSASSA-PKCS1-v1_5' } },
  PS256: { importAlg: rsa('RSA-PSS', 256), verifyAlg: { name: 'RSA-PSS', saltLength: 32 } },
  PS384: { importAlg: rsa('RSA-PSS', 384), verifyAlg: { name: 'RSA-PSS', saltLength: 48 } },
  PS512: { importAlg: rsa('RSA-PSS', 512), verifyAlg: { name: 'RSA-PSS', saltLength: 64 } },
  ES256: {
    importAlg: { name: 'ECDSA', namedCurve: 'P-256' },
    verifyAlg: { name: 'ECDSA', hash: 'SHA-256' },
  },
  ES384: {
    importAlg: { name: 'ECDSA', namedCurve: 'P-384' },
    verifyAlg: { name: 'ECDSA', hash: 'SHA-384' },
  },
  ES512: {
    importAlg: { name: 'ECDSA', namedCurve: 'P-521' },
    verifyAlg: { name: 'ECDSA', hash: 'SHA-512' },
  },
  EdDSA: { importAlg: { name: 'Ed25519' }, verifyAlg: { name: 'Ed25519' } },
};

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Copy into a fresh ArrayBuffer-backed view, which is what WebCrypto's typings want. */
const buf = (b: Uint8Array) => new Uint8Array(b);

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------- parsing ----------

interface Token {
  parts: string[];
  header: Rec;
  /** Parsed JSON when the payload is JSON, otherwise the decoded text. */
  payload: unknown;
  payloadText: string;
  signature: Uint8Array;
  signingInput: string;
  alg: string | undefined;
}

const TOKEN_RE = /eyJ[\w-]*(?:\.[\w-]*){1,4}/;

/** Finds a token in pasted text: a bare token, "Bearer ...", a cookie, a JSON field, a whole request. */
function findToken(input: string): string {
  const compact = input.replace(/\s+/g, '');
  const whole = compact.match(/^(?:Bearer|bearer)?(eyJ[\w-]*(?:\.[\w-]*){1,4})$/);
  if (whole) return whole[1]!;
  const lone = input.trim();
  if (/^eyJ\S*$/.test(lone)) {
    const bad = lone.match(/[^\w.-]/)?.[0];
    throw new ToolError(bad ? T('error.badChar', { char: bad }) : T('error.incomplete'));
  }
  const found = input.match(TOKEN_RE);
  if (found) return found[0];
  if (/^[\w-]+(?:\.[\w-]*){1,4}$/.test(compact)) return compact;
  throw new ToolError(T('error.notFound'));
}

const NOT_BASE64URL = {
  header: (reason: string) => T('error.headerNotB64', { reason }),
  payload: (reason: string) => T('error.payloadNotB64', { reason }),
  signature: (reason: string) => T('error.signatureNotB64', { reason }),
};

function decodePart(part: string, what: keyof typeof NOT_BASE64URL): Uint8Array {
  try {
    return fromBase64(part);
  } catch (e) {
    if (e instanceof ToolError) throw new ToolError(NOT_BASE64URL[what](e.message));
    throw e;
  }
}

function parseToken(input: string): Token {
  const raw = findToken(input);
  const parts = raw.split('.');
  if (parts.length === 5) throw new ToolError(T('error.jwe'));
  if (parts.length < 2 || parts.length > 3)
    throw new ToolError(T('error.partCount', { count: parts.length }));
  let header: unknown;
  try {
    header = JSON.parse(utf8Decode(decodePart(parts[0]!, 'header')));
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(T('error.headerNotJson'));
  }
  if (!isRecord(header)) throw new ToolError(T('error.headerNotObject'));
  const payloadText = utf8Decode(decodePart(parts[1]!, 'payload'));
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    payload = payloadText;
  }
  const sigPart = parts[2] ?? '';
  return {
    parts,
    header,
    payload,
    payloadText,
    signature: decodePart(sigPart, 'signature'),
    signingInput: `${parts[0]}.${parts[1]}`,
    alg: typeof header.alg === 'string' ? header.alg : undefined,
  };
}

// ---------- time ----------

function human(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return T('time.seconds', { count: s });
  const m = Math.floor(s / 60);
  if (m < 60) return T('time.minutes', { count: m });
  const h = Math.floor(m / 60);
  if (h < 48) return T('time.hours', { count: h });
  const d = Math.floor(h / 24);
  if (d < 730) return T('time.days', { count: d });
  return T('time.years', { count: Math.floor(d / 365.25) });
}

interface TimeInfo {
  value: string;
  /** Epoch milliseconds, when the claim is a usable number. */
  ms?: number;
  guessedMs: boolean;
}

function timeInfo(v: unknown): TimeInfo {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { value: typeof v === 'string' ? v : JSON.stringify(v), guessedMs: false };
  }
  const guessedMs = Math.abs(v) > 1e11;
  const ms = guessedMs ? v : v * 1000;
  if (Math.abs(ms) > 8.64e15) return { value: String(v), guessedMs };
  return { value: new Date(ms).toISOString(), ms, guessedMs };
}

// ---------- decode ----------

const CLAIM_NAMES: Record<string, () => string> = {
  iss: () => T('claim.iss'),
  sub: () => T('claim.sub'),
  aud: () => T('claim.aud'),
  exp: () => T('claim.exp'),
  nbf: () => T('claim.nbf'),
  iat: () => T('claim.iat'),
  jti: () => T('claim.jti'),
};

const PRIVILEGE_CLAIMS = new Set([
  'admin',
  'isAdmin',
  'is_admin',
  'role',
  'roles',
  'scope',
  'scp',
  'permissions',
  'groups',
  'privileges',
]);

function claimsTable(payload: Rec, now: number): Output[] {
  const rows: string[][] = [];
  for (const [k, v] of Object.entries(payload)) {
    const meaning: string[] = [];
    const claimName = Object.hasOwn(CLAIM_NAMES, k) ? CLAIM_NAMES[k] : undefined;
    if (claimName) meaning.push(claimName());
    let shown = typeof v === 'string' ? v : JSON.stringify(v);
    if (k === 'exp' || k === 'nbf' || k === 'iat') {
      const t = timeInfo(v);
      shown = t.value;
      if (t.ms === undefined) meaning.push(T('meaning.notSeconds'));
      else {
        const rel =
          t.ms <= now
            ? T('time.ago', { time: human(now - t.ms) })
            : T('time.in', { time: human(t.ms - now) });
        meaning.push(rel);
        if (t.guessedMs) meaning.push(T('meaning.millis'));
      }
    }
    if (PRIVILEGE_CLAIMS.has(k)) meaning.push(T('meaning.privilege'));
    rows.push([k, shown ?? '', meaning.join(' · ')]);
  }
  const exp = timeInfo(payload.exp);
  const expired = T('row.expired');
  if (payload.exp === undefined) rows.push([expired, T('value.noExp'), T('meaning.neverExpires')]);
  else if (exp.ms === undefined) rows.push([expired, T('value.unknown'), T('meaning.badExp')]);
  else rows.push([expired, exp.ms <= now ? T('value.yes') : T('value.no'), T('meaning.clock')]);
  const nbf = timeInfo(payload.nbf);
  if (nbf.ms !== undefined && nbf.ms > now)
    rows.push([
      T('row.validYet'),
      T('value.no'),
      T('meaning.nbfFuture', { time: human(nbf.ms - now) }),
    ]);
  return [
    {
      type: 'table',
      label: T('label.claims'),
      columns: [T('col.claim'), T('col.value'), T('col.meaning')],
      rows,
    },
  ];
}

/** Test a token against a list of secrets. Returns the first that reproduces the signature. */
async function findSecret(
  t: Token,
  hmacAlgo: HmacAlgo,
  candidates: readonly string[],
): Promise<string | null> {
  const mac = await createHmac(hmacAlgo);
  const data = utf8Encode(t.signingInput);
  for (const c of candidates) {
    if (equalBytes(mac(utf8Encode(c), data), t.signature)) return c;
  }
  return null;
}

async function securityNotes(t: Token): Promise<Output[]> {
  const notes: Output[] = [];
  const warn = (text: string) => notes.push({ type: 'note', level: 'warn', text });
  const alg = t.alg;
  if (alg === undefined) {
    warn(T('note.noAlg'));
  } else if (alg.toLowerCase() === 'none') {
    warn(T('note.algNone', { alg }));
  } else if (HS[alg]) {
    if (t.signature.length > 0) {
      const found = await findSecret(t, HS[alg], WEAK_SECRETS);
      if (found !== null) {
        notes.push({
          type: 'note',
          level: 'success',
          text: T('note.weakSecret', { secret: found }),
        });
      }
    }
  } else if (ASYM[alg]) {
    notes.push({
      type: 'note',
      level: 'info',
      text: T('note.asymmetric', { alg }),
    });
  }
  const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  if (t.header.kid !== undefined) warn(T('note.kid', { value: show(t.header.kid) }));
  if (t.header.jku !== undefined) warn(T('note.jku', { value: show(t.header.jku) }));
  if (t.header.x5u !== undefined) warn(T('note.x5u', { value: show(t.header.x5u) }));
  if (t.header.jwk !== undefined) warn(T('note.jwk'));
  if (t.header.x5c !== undefined) warn(T('note.x5c'));
  return notes;
}

async function decode(t: Token): Promise<Output[]> {
  const out: Output[] = [
    { type: 'text', label: T('label.header'), value: JSON.stringify(t.header, null, 2) },
    {
      type: 'text',
      label: T('label.payload'),
      value:
        isRecord(t.payload) || Array.isArray(t.payload)
          ? JSON.stringify(t.payload, null, 2)
          : t.payloadText,
    },
  ];
  if (isRecord(t.payload)) out.push(...claimsTable(t.payload, Date.now()));
  else
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.payloadNotObject'),
    });
  out.push({
    type: 'text',
    label: T('label.signature', { count: t.signature.length }),
    value: t.signature.length ? toHex(t.signature) : T('value.unsigned'),
  });
  out.push(...(await securityNotes(t)));
  return out;
}

// ---------- keys ----------

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new ToolError(T('error.noWebCrypto'));
  return s;
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/** Wrap a PKCS#1 RSAPublicKey ("BEGIN RSA PUBLIC KEY") into the SPKI structure WebCrypto wants. */
function pkcs1ToSpki(pkcs1: Uint8Array): Uint8Array {
  const rsaEncryption = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const bitString = [0x03, ...derLength(pkcs1.length + 1), 0x00, ...pkcs1];
  const body = [...rsaEncryption, ...bitString];
  return Uint8Array.from([0x30, ...derLength(body.length), ...body]);
}

const PUBLIC_JWK_FIELDS = ['kty', 'crv', 'x', 'y', 'n', 'e'] as const;

function jwkFrom(rec: Rec, kid: unknown): JsonWebKey {
  let key = rec;
  if (Array.isArray(rec.keys)) {
    const keys = rec.keys.filter(isRecord);
    const chosen = keys.find((k) => kid !== undefined && k.kid === kid) ?? keys[0];
    if (!chosen) throw new ToolError(T('error.emptyJwks'));
    key = chosen;
  }
  const jwk: JsonWebKey = {};
  for (const f of PUBLIC_JWK_FIELDS) {
    const v = key[f];
    if (typeof v === 'string') jwk[f] = v;
  }
  if (!jwk.kty) throw new ToolError(T('error.noKty'));
  return jwk;
}

type KeyMaterial = { jwk: JsonWebKey } | { der: Uint8Array };

function parseKeyMaterial(input: string, kid: unknown): KeyMaterial {
  // The option box is a single line: pasted PEMs lose their newlines, JSON strings keep a literal \n.
  const t = input.trim().replace(/\\n/g, '\n');
  if (t.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      throw new ToolError(T('error.keyBadJson'));
    }
    if (!isRecord(parsed)) throw new ToolError(T('error.keyNotObject'));
    return { jwk: jwkFrom(parsed, kid) };
  }
  const pem = t.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (pem) {
    const label = pem[1]!;
    const der = fromBase64(pem[2]!);
    if (label === 'PUBLIC KEY') return { der };
    if (label === 'RSA PUBLIC KEY') return { der: pkcs1ToSpki(der) };
    if (label === 'CERTIFICATE') throw new ToolError(T('error.certificate'));
    if (label.includes('PRIVATE KEY')) throw new ToolError(T('error.privateKey'));
    throw new ToolError(T('error.pemLabel', { label }));
  }
  if (/^[A-Za-z0-9+/_\-\s]+=*$/.test(t) && t.length > 40) return { der: fromBase64(t) };
  throw new ToolError(T('error.unreadableKey'));
}

async function importPublicKey(input: string, alg: string, kid: unknown): Promise<CryptoKey> {
  const spec = ASYM[alg]!;
  const material = parseKeyMaterial(input, kid);
  const s = subtle();
  try {
    return 'jwk' in material
      ? await s.importKey('jwk', material.jwk, spec.importAlg, false, ['verify'])
      : await s.importKey('spki', buf(material.der), spec.importAlg, false, ['verify']);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new ToolError(T('error.keyMismatch', { alg, reason: why }));
  }
}

// ---------- modes ----------

async function verify(
  t: Token,
  secret: string,
  secretIsB64: boolean,
  publicKey: string,
): Promise<Output[]> {
  const alg = t.alg;
  if (alg === undefined) throw new ToolError(T('error.verifyNoAlg'));
  if (alg.toLowerCase() === 'none') {
    return [
      {
        type: 'note',
        level: t.signature.length ? 'warn' : 'info',
        text: t.signature.length
          ? T('note.noneWithSignature', { alg })
          : T('note.noneNoSignature', { alg }),
      },
    ];
  }
  let ok: boolean;
  const data = utf8Encode(t.signingInput);
  const hmacAlgo = HS[alg];
  if (hmacAlgo) {
    if (!secret) throw new ToolError(T('error.verifyNeedsSecret', { alg }));
    const key = secretIsB64 ? fromBase64(secret) : utf8Encode(secret);
    ok = equalBytes((await createHmac(hmacAlgo))(key, data), t.signature);
  } else if (ASYM[alg]) {
    if (!publicKey.trim()) throw new ToolError(T('error.needsPublicKey', { alg }));
    const key = await importPublicKey(publicKey, alg, t.header.kid);
    ok = await subtle().verify(ASYM[alg].verifyAlg, key, buf(t.signature), buf(data));
  } else {
    throw new ToolError(T('error.unsupportedAlg', { alg }));
  }
  return [
    ok
      ? { type: 'note', level: 'success', text: T('note.valid', { alg }) }
      : {
          type: 'note',
          level: 'error',
          text: hmacAlgo ? T('note.mismatchSecret', { alg }) : T('note.mismatchKey', { alg }),
        },
  ];
}

function encodeSegment(value: unknown): string {
  return b64url(utf8Encode(JSON.stringify(value)));
}

/** Header and payload to sign: from an existing token, `{header, payload}` JSON, or a bare payload. */
function signSource(input: string): { header: Rec; payload: unknown } {
  const trimmed = input.trim();
  if (!trimmed) throw new ToolError(T('error.signEmpty'));
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const t = parseToken(trimmed);
    if (typeof t.payload === 'string') throw new ToolError(T('error.signPayloadNotJson'));
    return { header: t.header, payload: t.payload };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ToolError(T('error.signBadJson'));
  }
  if (isRecord(parsed) && isRecord(parsed.payload)) {
    return { header: isRecord(parsed.header) ? parsed.header : {}, payload: parsed.payload };
  }
  return { header: { typ: 'JWT' }, payload: parsed };
}

const NONE_SPELLINGS = ['none', 'None', 'NONE', 'nOnE'];

async function sign(
  input: string,
  alg: string,
  secret: string,
  secretIsB64: boolean,
): Promise<Output[]> {
  const { header, payload } = signSource(input);
  // An existing alg keeps its position, a fresh header gets alg first like every library writes it.
  const headerFor = (name: string): Rec =>
    'alg' in header ? { ...header, alg: name } : { alg: name, ...header };
  const make = (name: string, signature: string) =>
    `${encodeSegment(headerFor(name))}.${encodeSegment(payload)}.${signature}`;

  if (alg === 'none') {
    return [
      { type: 'text', label: T('label.unsigned'), value: make('none', '') },
      {
        type: 'table',
        label: T('label.spellings'),
        // "alg" is the name of the header field, not prose.
        columns: ['alg', T('col.token')],
        rows: NONE_SPELLINGS.map((n) => [n, make(n, '')]),
      },
    ];
  }
  const hmacAlgo = HS[alg];
  if (!hmacAlgo) throw new ToolError(T('error.cannotSign', { alg }));
  if (!secret) throw new ToolError(T('error.signNeedsSecret', { alg }));
  const key = secretIsB64 ? fromBase64(secret) : utf8Encode(secret);
  const unsigned = make(alg, '');
  const mac = (await createHmac(hmacAlgo))(key, utf8Encode(unsigned.slice(0, -1)));
  return [{ type: 'text', label: T('label.signed', { alg }), value: unsigned + b64url(mac) }];
}

async function crack(t: Token, extra: string): Promise<Output[]> {
  const hmacAlgo = t.alg ? HS[t.alg] : undefined;
  if (!hmacAlgo) throw new ToolError(T('error.notHmac', { alg: t.alg ?? T('value.noAlg') }));
  if (t.signature.length === 0) throw new ToolError(T('error.noSignature'));
  const extras = extra.split(',').filter((s) => s !== '');
  const candidates = [...new Set(['', ...extras, ...WEAK_SECRETS])];
  const found = await findSecret(t, hmacAlgo, candidates);
  if (found === null) {
    return [
      {
        type: 'note',
        level: 'warn',
        text: T('note.noMatch', { count: candidates.length }),
      },
    ];
  }
  return [
    {
      type: 'note',
      level: 'success',
      text: found === '' ? T('note.emptySecret') : T('note.secretFound', { secret: found }),
    },
    {
      type: 'kv',
      entries: [
        [T('kv.algorithm'), t.alg ?? ''],
        [T('kv.secret'), found === '' ? T('value.empty') : found],
        [T('kv.tried'), String(candidates.length)],
      ],
    },
    {
      type: 'note',
      level: 'info',
      text: T('note.forge'),
    },
  ];
}

const JWTIO_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const CRACK_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0Iiwicm9sZSI6InVzZXIiLCJleHAiOjQxMDI0NDQ4MDB9.v3S7sX-Mg9I-XJuz4BupQ2nLghrotZrJSfGkMZwuZn8';

export default defineTool({
  id: 'jwt',
  name: 'JWT',
  category: 'crypto',
  description:
    'Decode, verify, forge (alg none / HS256) and crack the secret of a JSON Web Token, offline.',
  tags: [
    'jwt.io',
    'json web token',
    'bearer',
    'hs256',
    'rs256',
    'alg none',
    'jws',
    'token',
    'jwt_tool',
  ],
  input: 'text',
  placeholder: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.…',
  options: {
    mode: toggle('Mode', [
      { value: 'decode', label: 'Decode' },
      { value: 'verify', label: 'Verify' },
      { value: 'sign', label: 'Sign' },
      { value: 'crack', label: 'Crack' },
    ]),
    alg: select('Sign with', ['HS256', 'HS384', 'HS512', 'none'], 'HS256', {
      showIf: (v) => v.mode === 'sign',
      hint: 'Input: a token to re-sign, {"header":{…},"payload":{…}}, or just the payload object.',
    }),
    secret: text('Secret', '', {
      placeholder: 'HMAC secret',
      showIf: (v) => v.mode === 'verify' || v.mode === 'sign',
    }),
    secretB64: bool('Secret is Base64', false, {
      showIf: (v) => v.mode === 'verify' || v.mode === 'sign',
      hint: 'Some libraries Base64-decode the secret before using it as the HMAC key.',
    }),
    publicKey: text('Public key', '', {
      placeholder: 'PEM or JWK (for RS / PS / ES / EdDSA)',
      showIf: (v) => v.mode === 'verify',
      hint: 'Paste the PEM on one line, newlines are not needed.',
    }),
    extra: text('Extra candidates', '', {
      placeholder: 'comma,separated,guesses',
      showIf: (v) => v.mode === 'crack',
      hint: 'Tried in addition to the built-in list of common weak secrets.',
    }),
  },
  examples: [
    { label: 'Decode the jwt.io token', input: JWTIO_TOKEN, expect: '"name": "John Doe"' },
    {
      label: 'Weak secret flagged on decode',
      input: JWTIO_TOKEN,
      expect: 'signed with "your-256-bit-secret"',
    },
    {
      label: 'Verify with the secret',
      input: JWTIO_TOKEN,
      options: { mode: 'verify', secret: 'your-256-bit-secret' },
      expect: 'Signature is valid (HS256)',
    },
    {
      label: 'Crack a weak secret',
      input: CRACK_TOKEN,
      options: { mode: 'crack' },
      expect: 'Secret found: letmein',
    },
    {
      label: 'Forge an admin token',
      input: '{"user":"admin"}',
      options: { mode: 'sign', alg: 'HS256', secret: 'secret' },
      expect:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoiYWRtaW4ifQ.LmuLCvLRfzvDVYK_iUBmwL3-5K9N0QLFrHwhXVb5TPU',
    },
    {
      label: 'alg none',
      input: '{"user":"admin"}',
      options: { mode: 'sign', alg: 'none' },
      expect: 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ1c2VyIjoiYWRtaW4ifQ.',
    },
  ],
  detect({ text }) {
    const t = text?.trim();
    if (!t || t.length > 20000) return null;
    let token: string;
    try {
      token = findToken(t);
    } catch {
      return null;
    }
    if (!token.startsWith('eyJ')) return null;
    try {
      const parsed = parseToken(token);
      return {
        score: parsed.alg !== undefined ? 0.95 : 0.7,
        options: { mode: 'decode' },
        reason: T('detect.token', { alg: parsed.alg ?? T('value.noAlg') }),
      };
    } catch {
      return null;
    }
  },
  async run(input, { mode, alg, secret, secretB64, publicKey, extra }) {
    switch (mode) {
      case 'decode':
        return decode(parseToken(input));
      case 'verify':
        return verify(parseToken(input), secret, secretB64, publicKey);
      case 'sign':
        return sign(input, alg, secret, secretB64);
      case 'crack':
        return crack(parseToken(input), extra);
    }
  },
});
