/**
 * The detectors of the secret hunter. Each one reads text (or the string and comment tokens of a
 * script) and adds hits; _web-source-secrets.ts runs them over every document and merges the
 * hits. Nothing here executes or decodes anything beyond base64, hex and JavaScript escapes.
 */
import { buildFlagRegex, findFlags, KNOWN_PREFIX } from '../../core/flags';
import { signatureName } from '../../i18n/tool-text';
import { fromBase64, printableRatio, utf8Decode } from '../../lib/bytes';
import { identify } from '../../lib/signatures';
import { unescapeJs, type CommentToken, type StringToken } from './_web-source-lex';
import {
  compareClass,
  keywordIn,
  nameClass,
  PLACEHOLDER,
  preview,
  secretLike,
  shannon,
  subwords,
  valueClass,
  type Hit,
  type Hits,
  type Info,
  type Kind,
  type Severity,
  type ValueClass,
  weakKeywordIn,
} from './_web-source-hits';

// ---------- helpers ----------

/** base64 / base64url to bytes, or null when it is not valid. */
function tryBase64(s: string): Uint8Array | null {
  try {
    return fromBase64(s);
  } catch {
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const FLAG_RE = buildFlagRegex();

/** The first flag-like string in a (decoded) text, or null. */
export function flagIn(text: string): string | null {
  return findFlags(text, FLAG_RE, 1)[0]?.value ?? null;
}

/** Control characters other than tab, line feed and carriage return: binary, not text. */
function hasBinaryControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) return true;
  }
  return false;
}

const isPrintableText = (b: Uint8Array): boolean =>
  b.length >= 4 && printableRatio(b) >= 0.95 && !hasBinaryControl(utf8Decode(b));

const isSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** A template literal with a `${…}` part is code that builds a value, not a value. */
const dynamic = (s: StringToken): boolean => s.quote === '`' && s.raw.includes('${');

// ---------- strong checks, on any text ----------

const KEY_FORMATS: { kind: Kind; re: RegExp; service: string; severity: Severity }[] = [
  {
    kind: 'aws',
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
    service: 'AWS access key ID',
    severity: 'high',
  },
  {
    kind: 'github',
    re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    service: 'GitHub token',
    severity: 'high',
  },
  {
    kind: 'github',
    re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
    service: 'GitHub fine-grained token',
    severity: 'high',
  },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, service: 'Google API key', severity: 'high' },
  {
    kind: 'stripe',
    re: /\b[sr]k_live_[0-9A-Za-z]{10,99}\b/g,
    service: 'Stripe live secret key',
    severity: 'high',
  },
  {
    kind: 'stripe',
    re: /\bpk_live_[0-9A-Za-z]{10,99}\b/g,
    service: 'Stripe live publishable key',
    severity: 'medium',
  },
  {
    kind: 'stripe',
    re: /\b[sr]k_test_[0-9A-Za-z]{10,99}\b/g,
    service: 'Stripe test secret key',
    severity: 'medium',
  },
  {
    kind: 'slack',
    re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/g,
    service: 'Slack token',
    severity: 'high',
  },
];

function detectKeyFormats(text: string, hits: Hits): void {
  for (const f of KEY_FORMATS) {
    for (const m of text.matchAll(f.re)) {
      hits.add({
        kind: f.kind,
        severity: f.severity,
        start: m.index,
        end: m.index + m[0].length,
        info: { service: f.service },
      });
    }
  }
}

const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

const compactJson = (v: unknown, max: number): string => {
  const s = JSON.stringify(v) ?? '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

function detectJwt(text: string, hits: Hits): void {
  for (const m of text.matchAll(JWT_RE)) {
    const [h64, p64] = m[0].split('.');
    const hb = tryBase64(h64!);
    const header = hb ? parseJson(utf8Decode(hb)) : undefined;
    if (typeof header !== 'object' || header === null) continue;
    const pb = tryBase64(p64!);
    const payloadText = pb ? utf8Decode(pb) : '';
    const payload = parseJson(payloadText);
    hits.add({
      kind: 'jwt',
      severity: 'high',
      start: m.index,
      end: m.index + m[0].length,
      info: {
        header: compactJson(header, 160),
        payload: payload === undefined ? preview(payloadText, 200) : compactJson(payload, 240),
      },
    });
  }
}

const PEM_RE = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----/g;

function detectPem(text: string, hits: Hits): void {
  for (const m of text.matchAll(PEM_RE)) {
    const headerEnd = m.index + m[0].length;
    const close = text.indexOf(`-----END ${m[1]!}-----`, headerEnd);
    hits.add({
      kind: 'pem',
      severity: 'high',
      start: m.index,
      end: headerEnd,
      info: { service: m[1]!, bytes: close < 0 ? undefined : String(close - headerEnd) },
    });
  }
}

const CREDENTIALS_RE =
  /\b[a-z][a-z0-9+.-]{1,12}:\/\/([^\s/:@'"`<>\\]{1,64}):([^\s/@'"`<>\\]{1,128})@[^\s/'"`<>\\]{1,128}/gi;

function detectCredentials(text: string, hits: Hits): void {
  for (const m of text.matchAll(CREDENTIALS_RE)) {
    if (PLACEHOLDER.test(m[2]!)) continue;
    hits.add({
      kind: 'credentials',
      severity: 'high',
      start: m.index,
      end: m.index + m[0].length,
      info: { name: m[1]!, value: m[2]! },
    });
  }
}

function detectBearer(text: string, hits: Hits): void {
  for (const m of text.matchAll(/\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g)) {
    if (m[1]!.startsWith('eyJ')) continue; // a JWT: reported as one
    hits.add({
      kind: 'bearer',
      severity: 'medium',
      start: m.index + m[0].length - m[1]!.length,
      end: m.index + m[0].length,
      info: { service: 'Bearer' },
    });
  }
  for (const m of text.matchAll(/\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})/g)) {
    const bytes = tryBase64(m[1]!);
    const decoded = bytes && isPrintableText(bytes) ? utf8Decode(bytes) : '';
    if (!/^[^:\s]+:.+/.test(decoded)) continue;
    hits.add({
      kind: 'bearer',
      severity: 'high',
      start: m.index + m[0].length - m[1]!.length,
      end: m.index + m[0].length,
      info: { service: 'Basic', decoded },
    });
  }
}

export interface FlagMode {
  /** Dependencies: only prefixes that are known flag formats. */
  strongOnly: boolean;
  /** Whether a lookalike (`abc{def}`) at this offset may be a flag: in a string or a comment. */
  genericAt: (offset: number) => boolean;
}

/**
 * Flags are found as everywhere on the site (`prefix{…}`), with the same rule: a known prefix
 * always counts; lookalikes (`a{b}` in CSS, `try{x()}` in minified code) only when there are
 * very few and they sit in a string or a comment, not in a doc-comment tag such as `@type{…}`.
 */
export function detectFlags(text: string, hits: Hits, mode: FlagMode): void {
  const spans = findFlags(text, FLAG_RE, 500);
  const strong = spans.filter((s) => KNOWN_PREFIX.test(s.value));
  for (const s of strong) hits.add({ kind: 'flag', severity: 'high', start: s.start, end: s.end });
  if (mode.strongOnly || strong.length) return;
  const generic = spans.filter((s) => text[s.start - 1] !== '@' && mode.genericAt(s.start));
  if (generic.length > 3) return;
  // A lookalike in a string or a comment, when there are so few, is very likely a flag.
  for (const s of generic) hits.add({ kind: 'flag', severity: 'high', start: s.start, end: s.end });
}

export function detectStrong(text: string, hits: Hits, mode: FlagMode): void {
  detectFlags(text, hits, mode);
  detectKeyFormats(text, hits);
  detectJwt(text, hits);
  detectPem(text, hits);
  detectCredentials(text, hits);
  detectBearer(text, hits);
}

// ---------- blobs and entropy ----------

const HASH_BY_LENGTH: Record<number, string> = {
  32: 'MD5 / NTLM',
  40: 'SHA-1',
  56: 'SHA-224',
  64: 'SHA-256',
  96: 'SHA-384',
  128: 'SHA-512',
};

/** A base64 or hex literal whose bytes read as text or as a known file type. */
function blobHit(value: string, start: number, end: number): Hit | null {
  if (/^(?:[0-9a-fA-F]{2}){8,}$/.test(value)) {
    const bytes = new Uint8Array(value.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    if (!isPrintableText(bytes)) return null;
    const info = { via: 'hex', decoded: preview(utf8Decode(bytes)) };
    return { kind: 'blob', severity: 'medium', start, end, info };
  }
  if (!/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(value) || value.length > 1_000_000) return null;
  const bytes = tryBase64(value);
  if (!bytes || bytes.length < 8) return null;
  if (isPrintableText(bytes)) {
    const info = { via: 'base64', decoded: preview(utf8Decode(bytes)) };
    return { kind: 'blob', severity: 'medium', start, end, info };
  }
  if (value.length >= 48) {
    const sig = identify(bytes)[0];
    if (sig) {
      const info = { via: 'base64', fileType: signatureName(sig), bytes: String(bytes.length) };
      return { kind: 'blob', severity: 'low', start, end, info };
    }
  }
  return null;
}

const pathLike = (s: string): boolean => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(?:\.{0,2}|~)\//.test(s)) return true;
  const parts = s.split('/');
  return parts.length >= 3 && parts.some((p) => /^[a-z]{3,}$/.test(p));
};

/** `This_is_a_message_key_1011`, `this.props.someValue`: words joined by separators. */
const wordy = (s: string): boolean => {
  const parts = s.split(/[_.-]/).filter(Boolean);
  const words = parts.filter((p) => /^[A-Za-z]+\d{0,4}$|^\d+$/.test(p)).length;
  return (
    (parts.length >= 2 && words === parts.length) ||
    (parts.length >= 3 && words / parts.length >= 0.7)
  );
};

/** `ABCDEFGHIJKL…`, `0123456789`: an alphabet, not a secret. */
const alphabetLike = (s: string): boolean => {
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    run = s.charCodeAt(i) === s.charCodeAt(i - 1) + 1 ? run + 1 : 1;
    if (run >= 10) return true;
  }
  return false;
};

/** A string that looks like a random secret: long enough, mixed, Shannon entropy of 4 bits or more. */
function entropyHit(value: string, start: number, end: number, literal: boolean): Hit | null {
  const n = value.length;
  // Longer base64 is data (an image, a table), not a key: the blob check names what it is.
  if (n < 20 || n > 128) return null;
  if (/\s/.test(value) || /^sha(?:256|384|512)-/.test(value) || pathLike(value)) return null;
  if (!literal && !/^[A-Za-z0-9+/=_-]+$/.test(value)) return null;
  if (wordy(value) || alphabetLike(value)) return null;
  const classes =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/[0-9]/.test(value)) +
    Number(/[^A-Za-z0-9]/.test(value));
  if (classes < 2 || (classes < 3 && n < 40)) return null;
  const e = shannon(value);
  if (e < 4.0) return null;
  if (/^[A-Za-z]+$/.test(value) && (n < 28 || e < 4.3)) return null; // a long identifier
  return {
    kind: 'entropy',
    severity: classes >= 3 ? 'medium' : 'low',
    start,
    end,
    info: { entropy: e.toFixed(2) },
  };
}

/** Plain text (HTML, config files): maximal runs of base64-ish characters. */
export function detectTokens(text: string, hits: Hits, skip: (i: number) => boolean): void {
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{16,}/g)) {
    if (skip(m.index)) continue;
    const lead = m[0].length - m[0].replace(/^[-_=]+/, '').length;
    const token = m[0].slice(lead).replace(/[-_]+$/, '');
    const start = m.index + lead;
    const end = start + token.length;
    const blob = blobHit(token, start, end);
    if (blob) hits.add(blob);
    else {
      const e = entropyHit(token, start, end, false);
      if (e) hits.add(e);
    }
  }
}

// ---------- JavaScript: strings, assignments, comparisons ----------

const FROM_CHAR_CODE =
  /String\s*\.\s*fromCharCode\s*\(\s*(?:\.\.\.\s*)?\[?\s*((?:0x[0-9a-fA-F]+|\d+)(?:\s*,\s*(?:0x[0-9a-fA-F]+|\d+)){3,})\s*\]?\s*\)/g;

/** `String.fromCharCode(70, 84, …)`; `source` starts at `base` in the document. */
export function detectCharCodes(source: string, base: number, hits: Hits): void {
  for (const m of source.matchAll(FROM_CHAR_CODE)) {
    const codes = m[1]!.split(',').map((x) => Number(x.trim()));
    if (codes.some((c) => !Number.isInteger(c) || c < 0 || c > 0x10ffff)) continue;
    const decoded = String.fromCodePoint(...codes);
    if (!/^[\x20-\x7e\t\n]{4,}$/.test(decoded)) continue;
    const start = base + m.index;
    const end = start + m[0].length;
    const flag = flagIn(decoded);
    hits.add({
      kind: 'charcode',
      severity: flag || nameClass(decoded) === 'strong' ? 'high' : 'medium',
      start,
      end,
      info: { via: 'charcode', decoded: preview(decoded) },
    });
    if (flag) hits.add({ kind: 'flag', severity: 'high', start, end, info: { decoded: flag } });
  }
}

const NUMBER_NAMES = new Set(['pass', 'password', 'passwd', 'pwd', 'passcode', 'pin', 'secret']);

/** `pin = 1234` / `password: 424242`: a number kept under a password-like name. */
export function detectNumbers(source: string, base: number, hits: Hits): void {
  for (const m of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*[:=]\s*(\d{4,12})\b(?!\s*[:=./])/g)) {
    if (m[0].includes('==') || !subwords(m[1]!).some((w) => NUMBER_NAMES.has(w))) continue;
    const start = base + m.index + m[0].length - m[2]!.length;
    hits.add({
      kind: 'assign',
      severity: 'medium',
      start,
      end: start + m[2]!.length,
      info: { name: m[1]! },
    });
  }
}

/** The previous non-space index at or before i, or -1. */
function prevSig(text: string, i: number): number {
  while (i >= 0 && isSpace(text[i])) i--;
  return i;
}

function nextSig(text: string, i: number): number {
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

/** The name written at index i going left: an identifier, or a quoted key (`"password":`). */
function nameBefore(text: string, i: number, byEnd: Map<number, StringToken>): string | null {
  const p = prevSig(text, i);
  if (p < 0) return null;
  const c = text[p]!;
  if (c === '"' || c === "'" || c === '`') {
    const s = byEnd.get(p + 1);
    return s && s.raw.length <= 60 && /^[\w$.\- ]+$/.test(s.raw) ? s.raw : null;
  }
  let q = p;
  while (q >= 0 && /[\w$]/.test(text[q]!)) q--;
  if (q === p) return null;
  const word = text.slice(q + 1, p + 1);
  // `token: string = "…"` (TypeScript): the name is the one before the type.
  if (/^(?:string|any|number|unknown)$/.test(word)) {
    const m = /([A-Za-z_$][\w$]*)\s*\??:\s*$/.exec(text.slice(Math.max(0, q - 80), q + 1));
    if (m) return m[1]!;
  }
  return word;
}

/** The expression written before index i, cut at the previous statement or condition. */
function exprBefore(text: string, i: number): string {
  let s = text.slice(Math.max(0, i - 90), i);
  const cut = Math.max(
    s.lastIndexOf(';'),
    s.lastIndexOf('{'),
    s.lastIndexOf('}'),
    s.lastIndexOf('&&'),
    s.lastIndexOf('||'),
    s.lastIndexOf('\n'),
  );
  if (cut >= 0) s = s.slice(cut + 1);
  let depth = 0;
  for (let k = s.length - 1; k >= 0; k--) {
    if (s[k] === ')') depth++;
    else if (s[k] === '(') {
      if (depth === 0) return s.slice(k + 1);
      depth--;
    }
  }
  return s;
}

function exprAfter(text: string, i: number): string {
  let s = text.slice(i, i + 90);
  const cut = [';', '{', '}', '&&', '||', '\n']
    .map((x) => s.indexOf(x))
    .filter((x) => x >= 0)
    .sort((a, b) => a - b)[0];
  if (cut !== undefined) s = s.slice(0, cut);
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')') {
      if (depth === 0) return s.slice(0, k);
      depth--;
    }
  }
  return s;
}

const COMPARE_OPS = ['===', '!==', '==', '!='];

/** The comparison operator whose last character is at p. */
function opEndingAt(text: string, p: number): string | null {
  for (const op of COMPARE_OPS) {
    const at = p - op.length + 1;
    if (at < 0 || !text.startsWith(op, at)) continue;
    const before = text[at - 1];
    if (before === '=' || before === '!' || before === '<' || before === '>') continue;
    return op;
  }
  return null;
}

function opStartingAt(text: string, i: number): string | null {
  for (const op of COMPARE_OPS) {
    if (text.startsWith(op, i) && text[i + op.length] !== '=') return op;
  }
  return null;
}

/** Key names and the like: compared with everywhere, and nothing to do with a secret. */
const KEY_NAMES = new Set([
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

function assignSeverity(cls: 'strong' | 'weak', v: ValueClass, value: string): Severity | null {
  if (cls === 'strong') return v === 'secret' ? 'high' : 'low';
  // A bare `key` or `api` only counts when the value looks generated.
  return v === 'secret' && value.length >= 8 && /[0-9]/.test(value) && shannon(value) >= 3
    ? 'medium'
    : null;
}

/** `password = "…"`, `{ token: "…" }`, `"apiKey": "…"`, `process.env.KEY || "…"`, `setItem("auth", "…")`. */
export function detectAssignments(text: string, strings: StringToken[], hits: Hits): void {
  const byEnd = new Map(strings.map((s) => [s.end, s] as const));
  strings.forEach((s, idx) => {
    if (dynamic(s)) return;
    const p = prevSig(text, s.start - 1);
    if (p < 0) return;
    const c = text[p]!;
    let name: string | null = null;
    if (c === '=') {
      const q = text[p - 1];
      if (q === '=' || q === '!' || q === '<' || q === '>') return; // a comparison
      name = nameBefore(text, p - 1, byEnd);
    } else if (c === ':') {
      name = nameBefore(text, p - 1, byEnd);
    } else if ((c === '|' && text[p - 1] === '|') || (c === '?' && text[p - 1] === '?')) {
      name = nameBefore(text, p - 2, byEnd);
    } else if (c === ',') {
      // Two strings that are the arguments of one call: setItem("token", "abc").
      const prev = strings[idx - 1];
      if (prev && text.slice(prev.end, p).trim() === '' && /^[\w$.\- ]{1,40}$/.test(prev.raw)) {
        const open = prevSig(text, prev.start - 1);
        if (open >= 0 && text[open] === '(') name = prev.raw;
      }
    }
    if (!name) return;
    const cls = nameClass(name);
    if (!cls) return;
    const { value } = unescapeJs(s.raw);
    const vc = valueClass(value);
    if (vc === 'empty' || PLACEHOLDER.test(value) || value.toLowerCase() === name.toLowerCase())
      return;
    const severity = assignSeverity(cls, vc, value);
    if (severity)
      hits.add({ kind: 'assign', severity, start: s.start, end: s.end, info: { name } });
  });
}

/** `if (password === "letmein")`, `"admin" == user.name && pw == "…"`. */
export function detectComparisons(text: string, strings: StringToken[], hits: Hits): void {
  for (const s of strings) {
    if (dynamic(s)) continue;
    const { value } = unescapeJs(s.raw);
    if (value.length > 120 || KEY_NAMES.has(value)) continue;
    const vc = valueClass(value);
    if (vc !== 'secret') continue;
    let found: { op: string; expr: string } | null = null;
    const p = prevSig(text, s.start - 1);
    const opBefore = p >= 0 ? opEndingAt(text, p) : null;
    if (opBefore) found = { op: opBefore, expr: exprBefore(text, p - opBefore.length + 1) };
    if (!found) {
      const n = nextSig(text, s.end);
      const opAfter = opStartingAt(text, n);
      if (opAfter) found = { op: opAfter, expr: exprAfter(text, n + opAfter.length) };
    }
    if (!found || /\btypeof\b/.test(found.expr)) continue;
    const cls = compareClass(found.expr);
    // A weak name (`key`, `user`, `code`) needs a value that looks chosen, not a plain word.
    if (!cls || (cls === 'extra' && !secretLike(value))) continue;
    const info: Info = { name: preview(found.expr, 60), op: found.op };
    const hash = HASH_BY_LENGTH[value.length];
    if (hash && /^[0-9a-fA-F]+$/.test(value)) info.hash = hash;
    hits.add({
      kind: 'compare',
      severity: cls === 'strong' ? 'high' : 'medium',
      start: s.start,
      end: s.end,
      info,
    });
  }
}

/** Strings written as escapes (obfuscation), and what the strings, decoded, say. */
export function detectStringValues(strings: StringToken[], hits: Hits): void {
  for (const s of strings) {
    if (dynamic(s)) continue;
    const { value, encoded } = unescapeJs(s.raw);
    if (encoded >= 3 && value !== s.raw && /^[\x20-\x7e\t\n]{4,}$/.test(value)) {
      const covered = (s.raw.length - value.length) / Math.max(1, s.raw.length);
      if (covered >= 0.3) {
        const flag = flagIn(value);
        hits.add({
          kind: 'escaped',
          severity: flag || nameClass(value) === 'strong' ? 'high' : 'medium',
          start: s.start,
          end: s.end,
          info: { via: 'escapes', decoded: preview(value) },
        });
        if (flag) {
          hits.add({
            kind: 'flag',
            severity: 'high',
            start: s.start,
            end: s.end,
            info: { decoded: flag },
          });
        }
      }
    }
    const blob = blobHit(value, s.start, s.end);
    if (blob) {
      const decoded = blob.info?.decoded;
      const flag = decoded ? flagIn(decoded) : null;
      if (flag) {
        hits.add({
          kind: 'flag',
          severity: 'high',
          start: s.start,
          end: s.end,
          info: { decoded: flag },
        });
      }
      if (decoded && (flag || nameClass(decoded) === 'strong')) blob.severity = 'high';
      hits.add(blob);
      continue;
    }
    const e = entropyHit(value, s.start, s.end, true);
    if (e) hits.add(e);
  }
}

// ---------- comments and plain lines ----------

const WORD = /[A-Za-z][A-Za-z0-9_-]*/g;
const KV_LINE =
  /^[\s*#/-]*(?:export\s+|set\s+)?([A-Za-z_][\w.-]*(?:[ \t]+[A-Za-z_][\w.-]*){0,3}?)[ \t]*[:=][ \t]*(\S.*?)[ \t]*$/;
const MAX_KEYWORDS = 40;
/** The bare words pass, key and api are everywhere in prose: only the first few get a row. */
const MAX_WEAK_KEYWORDS = 12;

/**
 * Lines of a comment or a plain file: `secret: VALUE` / `PASSWORD=VALUE` become an assignment
 * whose range is the value, and a line that only mentions a keyword becomes a weak keyword hit.
 * `text` starts at `base` in the document; `via` says where the lines come from.
 */
export function detectLines(text: string, base: number, hits: Hits, via: string): void {
  let at = 0;
  for (const line of text.split('\n')) {
    const lineStart = base + at;
    at += line.length + 1;
    if (line.length > 400) continue;
    const kv = KV_LINE.exec(line);
    if (kv) {
      const cls = nameClass(kv[1]!);
      const value = kv[2]!
        .replace(/[\s*/;,]*(?:-->)?\s*$/, '')
        .replace(/^["'`]|["'`]$/g, '')
        .trim();
      const vc = valueClass(value);
      const severity =
        cls && vc !== 'empty' && !PLACEHOLDER.test(value) ? assignSeverity(cls, vc, value) : null;
      if (severity) {
        const offset = line.lastIndexOf(value);
        const start = lineStart + (offset >= 0 ? offset : line.length - value.length);
        hits.add({
          kind: 'assign',
          severity,
          start,
          end: start + value.length,
          info: { name: kv[1]!.trim(), via },
        });
        continue;
      }
    }
    if (hits.keywords >= MAX_KEYWORDS) continue;
    const words = [...line.matchAll(WORD)];
    const strong = words.findIndex((w, i) => keywordIn(w[0], words[i + 1]?.[0]));
    const weak =
      strong < 0 && hits.weakKeywords < MAX_WEAK_KEYWORDS
        ? words.findIndex((w) => weakKeywordIn(w[0]))
        : -1;
    const found = words[strong >= 0 ? strong : weak];
    if (!found) continue;
    hits.add({
      kind: 'keyword',
      severity: 'low',
      start: lineStart + found.index,
      end: lineStart + found.index + found[0].length,
      info: { via },
    });
    hits.keywords++;
    if (strong < 0) hits.weakKeywords++;
  }
}

export function detectComments(comments: CommentToken[], hits: Hits): void {
  for (const c of comments) detectLines(c.text, c.start + 2, hits, 'comment');
}
