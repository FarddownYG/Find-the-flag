/**
 * What the secret hunter of the Web source analyzer finds, and the vocabulary it judges names
 * and values with: kinds, severities, the shape of a hit and of a finding, and small helpers that
 * say whether a name looks like `password`, and whether a value looks like a secret.
 */

export type Kind =
  | 'aws'
  | 'github'
  | 'google'
  | 'stripe'
  | 'slack'
  | 'pem'
  | 'jwt'
  | 'credentials'
  | 'bearer'
  | 'flag'
  | 'assign'
  | 'compare'
  | 'charcode'
  | 'escaped'
  | 'hidden'
  | 'blob'
  | 'entropy'
  | 'keyword';

/** Strongest first: a finding with several reasons is named after the first of them. */
export const KIND_ORDER: readonly Kind[] = [
  'aws',
  'github',
  'google',
  'stripe',
  'slack',
  'pem',
  'jwt',
  'credentials',
  'bearer',
  'flag',
  'assign',
  'compare',
  'charcode',
  'escaped',
  'hidden',
  'blob',
  'entropy',
  'keyword',
];

export type Severity = 'high' | 'medium' | 'low';
export const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Language-neutral facts about a hit; the report words them. */
export interface Info {
  /** The name an assignment or comparison is about (`password`, `adminToken`…). */
  name?: string;
  /** The password of URL credentials. */
  value?: string;
  /** What the value says once decoded (base64, hex, escapes, char codes). */
  decoded?: string;
  /** How it was decoded or where it was seen: base64, hex, escapes, charcode, comment, field, line. */
  via?: string;
  /** The service of a key format (AWS access key ID…). */
  service?: string;
  entropy?: string;
  /** The comparison operator (`===`). */
  op?: string;
  /** JWT header and payload as compact JSON. */
  header?: string;
  payload?: string;
  /** File type of a decoded blob (a signature name). */
  fileType?: string;
  /** Size in bytes of a decoded blob or a PEM body. */
  bytes?: string;
  /** Hash family guessed from a hex length. */
  hash?: string;
}

export interface Hit {
  kind: Kind;
  severity: Severity;
  start: number;
  end: number;
  info?: Info;
}

export interface Finding {
  /** Index of the document in the list given to scanDocs. */
  doc: number;
  kinds: Kind[];
  severity: Severity;
  start: number;
  end: number;
  line: number;
  col: number;
  /** The matched text (cut to a bounded length, on one line). */
  match: string;
  info: Info;
  /** The rest of the line around the match: text before it, text after it. */
  before: string;
  after: string;
}

/** Collects hits, with a ceiling so that a hostile or odd file cannot fill the memory. */
export class Hits {
  readonly list: Hit[] = [];
  /** Keyword hits so far in this document (they are capped: prose is full of them). */
  keywords = 0;
  /** Of those, the ones for the bare words pass, key and api (capped much lower). */
  weakKeywords = 0;

  add(hit: Hit): void {
    if (this.list.length < MAX_HITS) this.list.push(hit);
  }
}

const MAX_HITS = 30_000;

// ---------- names ----------

/** `adminPassword` -> [admin, password]; `API_KEY` -> [api, key]. */
export function subwords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Words that make a name a likely secret: `adminPassword`, `DB_PASS`, `authToken`, `flag`. */
const SECRET_WORDS = new Set([
  'flag',
  'pass',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'passcode',
  'secret',
  'secrets',
  'token',
  'apikey',
  'auth',
  'authorization',
  'private',
  'credential',
  'credentials',
  'bearer',
]);

/** Qualifiers that make a plain `key` a secret: `apiKey`, `SECRET_KEY`, `privateKey`. */
const KEY_QUALIFIERS = new Set([
  'api',
  'private',
  'secret',
  'access',
  'encryption',
  'signing',
  'master',
]);

/** Is this name a password / secret / token…? 'strong' always, 'weak' for a bare `key` or `api`. */
export function nameClass(name: string): 'strong' | 'weak' | null {
  const words = subwords(name);
  if (words.some((w) => SECRET_WORDS.has(w))) return 'strong';
  if (words.includes('key') && words.some((w) => KEY_QUALIFIERS.has(w))) return 'strong';
  if (words.includes('key') || words.includes('api')) return 'weak';
  return null;
}

/** Names a comparison with a literal is worth reporting next to. */
const COMPARE_STRONG = new Set([
  'pass',
  'password',
  'passwd',
  'pwd',
  'pw',
  'passphrase',
  'passcode',
  'pin',
  'otp',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'apikey',
  'flag',
  'answer',
]);
/** Names that only count when the literal itself looks like a secret. */
const COMPARE_EXTRA = new Set([
  'token',
  'key',
  'code',
  'admin',
  'user',
  'username',
  'login',
  'auth',
  'authorization',
  'private',
  'bearer',
  'serial',
  'license',
  'check',
  'verify',
]);

/** For the other side of a comparison: every identifier and `#id` in it. */
export function compareClass(expr: string): 'strong' | 'extra' | null {
  let extra = false;
  for (const m of expr.matchAll(/#[\w-]+|[A-Za-z_$][\w$]*/g)) {
    const words = subwords(m[0]);
    if (words.some((w) => COMPARE_STRONG.has(w))) return 'strong';
    if (nameClass(m[0]) === 'strong' || words.some((w) => COMPARE_EXTRA.has(w))) extra = true;
    if (words.includes('key') && words.some((w) => KEY_QUALIFIERS.has(w))) return 'strong';
  }
  return extra ? 'extra' : null;
}

/** The words that make a comment line or a file line worth a "keyword" row. */
const KEYWORDS = new Set([
  'flag',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'passcode',
  'secret',
  'secrets',
  'token',
  'credential',
  'credentials',
  'apikey',
]);

/** A keyword in prose: `password`, `API key`, `secret_key`; not the verb "pass" or a bare "key". */
export function keywordIn(token: string, next: string | undefined): boolean {
  const words = subwords(token);
  if (words.some((w) => KEYWORDS.has(w))) return true;
  const last = words[words.length - 1];
  const qualified = last !== undefined && KEY_QUALIFIERS.has(last) && /^keys?$/i.test(next ?? '');
  return qualified || (words.includes('key') && words.some((w) => KEY_QUALIFIERS.has(w)));
}

/** Words that are keywords only when they stand alone, and only the first few count. */
const WEAK_KEYWORDS = new Set(['pass', 'key', 'keys', 'api']);

/** A whole word that only hints at a secret: `pass`, `key`, `api` (a verb, a lookup, an endpoint). */
export function weakKeywordIn(token: string): boolean {
  return WEAK_KEYWORDS.has(token.toLowerCase());
}

// ---------- values ----------

/** Values that say nothing: option names, type names, the words of a configuration. */
const TRIVIAL_VALUES = new Set([
  'undefined',
  'null',
  'true',
  'false',
  'none',
  'auto',
  'default',
  'same-origin',
  'include',
  'omit',
  'cors',
  'no-cors',
  'string',
  'number',
  'boolean',
  'object',
  'function',
  'symbol',
  'bigint',
  'any',
  'void',
  'nan',
]);

export type ValueClass = 'secret' | 'label' | 'path' | 'empty';

/** What a literal looks like: a secret, a UI label / sentence, a path or URL, or nothing. */
export function valueClass(v: string): ValueClass {
  if (v.length < 3 || v.length > 200 || TRIVIAL_VALUES.has(v.toLowerCase())) return 'empty';
  if (/^[*•#.\-_ ]+$/.test(v) || /^\$\{.*\}$/.test(v)) return 'empty'; // masks, placeholders
  if (/[<>]/.test(v) && /<\w+[^>]*>/.test(v)) return 'empty'; // markup
  if (/^[./#~]/.test(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^[\w-]+\/[\w./-]+$/.test(v)) {
    return 'path';
  }
  if (/\s/.test(v)) return 'label';
  if (/^[A-Z]?[a-z]+$/.test(v) && v.length < 14 && nameClass(v) !== null) return 'label';
  return 'secret';
}

/** A value that looks chosen or generated, not a word or an option name: a digit or a symbol in it. */
export function secretLike(v: string): boolean {
  return (v.length >= 4 && /[0-9]/.test(v)) || (v.length >= 6 && /[!@#$%^&*+=?]/.test(v));
}

export function shannon(s: string): number {
  const chars = [...s];
  if (!chars.length) return 0;
  const counts = new Map<string, number>();
  for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) h -= (c / chars.length) * Math.log2(c / chars.length);
  return h;
}

/** `password`, `pass`, `xxxx`, `{{password}}`, `<password>`, `${PASSWORD}`: a placeholder. */
export const PLACEHOLDER =
  /^(?:password|pass|pwd|secret|x{3,}|\*+|\{\{?\w*\}?\}|<\w+>|\$\{?\w+\}?|%s|%\w+%)$/i;

export const preview = (s: string, max = 200): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};
