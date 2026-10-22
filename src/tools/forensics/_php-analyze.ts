/**
 * Static source→sink analysis of PHP. It is 100 % offline: it reads the code the user pastes and
 * nothing else — no request is made, no site is contacted, nothing is executed. It tracks tainted
 * data from a *source* (attacker input) to a *sink* (a dangerous operation), looking at what
 * sanitiser, if any, sits between them, and runs a set of pattern rules (type juggling, weak
 * randomness, unserialize, config, version) on top. Its taint tracking is intra-file and
 * best-effort: it follows plain `$x = …` assignments, concatenation and interpolation, so complex
 * inter-function or array-driven flows can escape it. Findings carry a confidence for that reason.
 *
 * Exploitation is described as a *payload family* (educational), never produced as a turnkey
 * exploit. The actively-exploited PHP2Shell CVEs (2026-109618/109619) are detection + patch advice
 * only; no proof of concept is emitted.
 */
import { lexPhp, type Token } from './_php-lex';

export type VulnClass =
  | 'lfi'
  | 'rfi'
  | 'cmd'
  | 'code'
  | 'unserialize'
  | 'sqli'
  | 'juggle'
  | 'upload'
  | 'ssrf'
  | 'rand'
  | 'password'
  | 'header'
  | 'xss'
  | 'config'
  | 'version';

export type Severity = 'P0' | 'P1' | 'P2' | 'P3';
export type Confidence = 'verified' | 'review';

export interface Finding {
  cls: VulnClass;
  severity: Severity;
  line: number;
  /** The offending source line, trimmed. */
  snippet: string;
  /** Sink reached (function / construct name), when the finding is a source→sink one. */
  sink?: string;
  /** Human "source → … → sink" trail — the "why exploitable". */
  path?: string;
  confidence: Confidence;
  /** Extra note: version-specific condition, CVE id, why a control is bypassable. */
  extra?: string;
}

export interface SafeSink {
  sink: string;
  line: number;
  /** Which sanitiser cleared it. */
  by: string;
  ctx: Context;
}

export interface Analysis {
  findings: Finding[];
  /** Sinks that were reached by tainted data but are refuted (adequate sanitiser present). */
  safe: SafeSink[];
  /** True if the input looked like PHP at all (an opening tag or `$`-variables). */
  isPhp: boolean;
  /** Magic methods seen in the file (feed POP-chain reasoning for unserialize). */
  magicMethods: string[];
  /** PHP version string seen in a pasted banner, if any (e.g. "5.6.40"). */
  versionBanner: string | null;
  /** How many findings were dropped past the cap. */
  capped: number;
}

type Context = 'lfi' | 'sql' | 'shell' | 'html' | 'code' | 'any';

const MAX_FINDINGS = 200;

const SUPERGLOBALS = new Set([
  '_GET',
  '_POST',
  '_REQUEST',
  '_COOKIE',
  '_FILES',
  '_SERVER',
  '_ENV',
  'GLOBALS',
  'HTTP_RAW_POST_DATA',
]);

/** Sanitisers: which context each one actually cleans, and whether it is only partial. */
const SANITIZERS: Record<string, { ctx: Context; weak?: boolean; note?: string }> = {
  intval: { ctx: 'any' },
  floatval: { ctx: 'any' },
  doubleval: { ctx: 'any' },
  settype: { ctx: 'any' },
  abs: { ctx: 'any' },
  ceil: { ctx: 'any' },
  floor: { ctx: 'any' },
  round: { ctx: 'any' },
  basename: { ctx: 'lfi', note: 'nullbyte' },
  realpath: { ctx: 'lfi', weak: true, note: 'webroot' },
  htmlspecialchars: { ctx: 'html' },
  htmlentities: { ctx: 'html' },
  strip_tags: { ctx: 'html', weak: true },
  escapeshellarg: { ctx: 'shell' },
  escapeshellcmd: { ctx: 'shell', weak: true },
  mysqli_real_escape_string: { ctx: 'sql' },
  mysql_real_escape_string: { ctx: 'sql' },
  mysql_escape_string: { ctx: 'sql', weak: true },
  pg_escape_string: { ctx: 'sql' },
  pg_escape_literal: { ctx: 'sql' },
  addslashes: { ctx: 'sql', weak: true },
};

/** Type casts, written `(int)$x`: clean every context (a number carries no payload). */
const CASTS = new Set(['int', 'integer', 'float', 'double', 'real', 'bool', 'boolean']);

interface SinkDef {
  cls: VulnClass;
  ctx: Context;
  severity: Severity;
  /** Only treat as a sink when written as a method call (`$x->query(`). */
  method?: boolean;
}

const SINKS: Record<string, SinkDef> = {
  include: { cls: 'lfi', ctx: 'lfi', severity: 'P0' },
  include_once: { cls: 'lfi', ctx: 'lfi', severity: 'P0' },
  require: { cls: 'lfi', ctx: 'lfi', severity: 'P0' },
  require_once: { cls: 'lfi', ctx: 'lfi', severity: 'P0' },
  readfile: { cls: 'lfi', ctx: 'lfi', severity: 'P1' },
  file_get_contents: { cls: 'lfi', ctx: 'lfi', severity: 'P1' },
  file: { cls: 'lfi', ctx: 'lfi', severity: 'P1' },
  fopen: { cls: 'lfi', ctx: 'lfi', severity: 'P1' },
  show_source: { cls: 'lfi', ctx: 'lfi', severity: 'P1' },
  highlight_file: { cls: 'lfi', ctx: 'lfi', severity: 'P1' },
  file_put_contents: { cls: 'lfi', ctx: 'lfi', severity: 'P1' },
  system: { cls: 'cmd', ctx: 'shell', severity: 'P0' },
  exec: { cls: 'cmd', ctx: 'shell', severity: 'P0' },
  shell_exec: { cls: 'cmd', ctx: 'shell', severity: 'P0' },
  passthru: { cls: 'cmd', ctx: 'shell', severity: 'P0' },
  popen: { cls: 'cmd', ctx: 'shell', severity: 'P0' },
  proc_open: { cls: 'cmd', ctx: 'shell', severity: 'P0' },
  pcntl_exec: { cls: 'cmd', ctx: 'shell', severity: 'P0' },
  eval: { cls: 'code', ctx: 'code', severity: 'P0' },
  assert: { cls: 'code', ctx: 'code', severity: 'P0' },
  create_function: { cls: 'code', ctx: 'code', severity: 'P0' },
  mysql_query: { cls: 'sqli', ctx: 'sql', severity: 'P0' },
  mysqli_query: { cls: 'sqli', ctx: 'sql', severity: 'P0' },
  pg_query: { cls: 'sqli', ctx: 'sql', severity: 'P0' },
  query: { cls: 'sqli', ctx: 'sql', severity: 'P0', method: true },
  multi_query: { cls: 'sqli', ctx: 'sql', severity: 'P0', method: true },
  unserialize: { cls: 'unserialize', ctx: 'code', severity: 'P0' },
  move_uploaded_file: { cls: 'upload', ctx: 'any', severity: 'P1' },
  header: { cls: 'header', ctx: 'html', severity: 'P2' },
  echo: { cls: 'xss', ctx: 'html', severity: 'P2' },
  print: { cls: 'xss', ctx: 'html', severity: 'P2' },
};

/** Constructs whose argument may be written with no parentheses (`include $x;`). */
const PARENLESS = new Set(['include', 'include_once', 'require', 'require_once', 'echo', 'print']);

const HASH_FNS = new Set(['md5', 'sha1', 'crc32', 'crypt', 'hash']);

// ---------- token helpers ----------

const isVar = (t: Token | undefined, name?: string): t is Extract<Token, { kind: 'var' }> =>
  !!t && t.kind === 'var' && (name === undefined || t.name === name);
const isId = (t: Token | undefined): t is Extract<Token, { kind: 'id' }> => !!t && t.kind === 'id';
const isPunc = (t: Token | undefined, v: string): boolean =>
  !!t && t.kind === 'punc' && t.value === v;
const isOp = (t: Token | undefined, v: string): boolean => !!t && t.kind === 'op' && t.value === v;

/** Index of the punctuation matching the opener at `open` (same shape `( ) [ ] { }`). */
function matchPair(tokens: Token[], open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const openCh = tokens[open]!.kind === 'punc' ? (tokens[open] as { value: string }).value : '';
  const closeCh = pairs[openCh];
  if (!closeCh) return open;
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isPunc(t, openCh)) depth++;
    else if (isPunc(t, closeCh)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

/** Render a source access as text: `$_GET` then its first `['key']` if it is a simple literal. */
function renderAccess(tokens: Token[], i: number): string {
  const v = tokens[i];
  if (!isVar(v)) return '';
  let out = `$${v.name}`;
  if (isPunc(tokens[i + 1], '[') && tokens[i + 2]?.kind === 'str' && isPunc(tokens[i + 3], ']')) {
    out += `['${(tokens[i + 2] as { str: { content: string } }).str.content}']`;
  }
  return out;
}

// ---------- taint ----------

interface Taint {
  origin: string;
  cleaned: Set<Context>;
  weak: Set<Context>;
}

interface RegionTaint {
  tainted: boolean;
  origin: string | null;
  varName: string | null;
  cleaned: Set<Context>;
  weak: Set<Context>;
  /** Notes attached to the sanitisers found (e.g. a basename nullbyte caveat). */
  notes: Set<string>;
}

/**
 * Look at `file_get_contents('php://input')` and `getallheaders()` / `apache_request_headers()`:
 * request bodies and headers are attacker-controlled sources, not sinks.
 */
function sourceCall(tokens: Token[], i: number): string | null {
  const id = tokens[i];
  if (!isId(id)) return null;
  const name = id.lower;
  if (name === 'getallheaders' || name === 'apache_request_headers') return `${name}()`;
  if (name === 'file_get_contents' && isPunc(tokens[i + 1], '(')) {
    const arg = tokens[i + 2];
    if (arg?.kind === 'str' && /^php:\/\/input/i.test(arg.str.content)) return 'php://input';
  }
  return null;
}

/** Evaluate taint over a token region [from, to) using the taint known so far. */
function evalRegion(
  tokens: Token[],
  from: number,
  to: number,
  taint: Map<string, Taint>,
): RegionTaint {
  const r: RegionTaint = {
    tainted: false,
    origin: null,
    varName: null,
    cleaned: new Set(),
    weak: new Set(),
    notes: new Set(),
  };
  for (let i = from; i < to; i++) {
    const t = tokens[i]!;
    // Sanitiser call or cast anywhere in the region clears its context.
    if (isId(t)) {
      const s = SANITIZERS[t.lower];
      if (s && isPunc(tokens[i + 1], '(')) {
        (s.weak ? r.weak : r.cleaned).add(s.ctx);
        if (s.note) r.notes.add(s.note);
      }
      const src = sourceCall(tokens, i);
      if (src && !r.tainted) {
        r.tainted = true;
        r.origin = src;
      }
    }
    if (
      isPunc(t, '(') &&
      isId(tokens[i + 1]) &&
      CASTS.has((tokens[i + 1] as { lower: string }).lower) &&
      isPunc(tokens[i + 2], ')')
    ) {
      r.cleaned.add('any');
    }
    if (isVar(t)) {
      if (SUPERGLOBALS.has(t.name)) {
        if (!r.tainted) {
          r.tainted = true;
          r.origin = renderAccess(tokens, i);
        }
      } else {
        const known = taint.get(t.name);
        if (known) {
          if (!r.tainted) {
            r.tainted = true;
            r.origin = known.origin;
            r.varName = t.name;
          }
          // A tainted value carries the sanitising it already went through.
          for (const c of known.cleaned) r.cleaned.add(c);
          for (const c of known.weak) r.weak.add(c);
        }
      }
    }
  }
  return r;
}

/** Is context `ctx` adequately cleaned by this region? */
function cleared(r: RegionTaint, ctx: Context): boolean {
  if (ctx === 'code') return false; // nothing makes eval()/unserialize() of input safe
  return r.cleaned.has('any') || r.cleaned.has(ctx);
}
function clearedWeak(r: RegionTaint, ctx: Context): boolean {
  return r.weak.has(ctx) || r.weak.has('any');
}

// ---------- the forward pass: assignments + sinks ----------

interface Ctx {
  tokens: Token[];
  lines: string[];
  taint: Map<string, Taint>;
  findings: Finding[];
  safe: SafeSink[];
}

const snippetAt = (lines: string[], line: number): string =>
  (lines[line - 1] ?? '').trim().slice(0, 200);

function pushFinding(c: Ctx, f: Finding): void {
  // One finding per (class, line): keep the most severe / most confident.
  const key = (x: Finding) => `${x.cls}:${x.line}`;
  const existing = c.findings.find((x) => key(x) === key(f));
  if (!existing) {
    c.findings.push(f);
    return;
  }
  const rank: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  if (rank[f.severity] < rank[existing.severity]) Object.assign(existing, f);
}

/** The region of a sink's first argument (inside parens, or up to `;` when written bare). */
function sinkArgRegion(
  tokens: Token[],
  i: number,
  parenless: boolean,
): { from: number; to: number; next: number; hadParen: boolean; closeIdx: number } | null {
  if (isPunc(tokens[i + 1], '(')) {
    const close = matchPair(tokens, i + 1);
    return { from: i + 2, to: close, next: close + 1, hadParen: true, closeIdx: close };
  }
  if (!parenless) return null;
  let j = i + 1;
  while (j < tokens.length && !isPunc(tokens[j], ';')) j++;
  return { from: i + 1, to: j, next: j, hadParen: false, closeIdx: j };
}

function handleSink(c: Ctx, i: number, def: SinkDef, name: string): number {
  const { tokens } = c;
  // Method sinks only count after `->` (so `$db->query` matches, a bare query() does not).
  if (def.method && !isOp(tokens[i - 1], '->')) return i;
  // A non-method function sink needs parentheses unless it is a bare-allowed construct.
  const region = sinkArgRegion(tokens, i, PARENLESS.has(name));
  if (!region) return i;
  const r = evalRegion(tokens, region.from, region.to, c.taint);
  if (!r.tainted) return region.next;

  const line = tokens[i]!.line;
  // unserialize(input, ['allowed_classes'=>…]) is safe.
  if (def.cls === 'unserialize' && region.hadParen) {
    const rest = tokens.slice(region.from, region.closeIdx);
    if (rest.some((t) => t.kind === 'str' && /allowed_classes/i.test(t.str.content))) {
      c.safe.push({ sink: name, line, by: 'allowed_classes', ctx: def.ctx });
      return region.next;
    }
  }

  if (cleared(r, def.ctx)) {
    const by = [...r.cleaned].join(',');
    c.safe.push({ sink: name, line, by, ctx: def.ctx });
    return region.next;
  }

  const trail = r.varName ? `${r.origin} → $${r.varName} → ${name}()` : `${r.origin} → ${name}()`;
  const weak = clearedWeak(r, def.ctx);
  const extras: string[] = [];
  if (weak) extras.push('weak-sanitizer');
  if (def.cls === 'lfi') {
    extras.push('lfi-wrappers');
    if (r.notes.has('nullbyte')) extras.push('nullbyte');
  }
  if (def.cls === 'lfi' && /^(include|include_once|require|require_once)$/.test(name))
    extras.push('rfi');
  pushFinding(c, {
    cls: def.cls,
    severity: def.severity,
    line,
    snippet: snippetAt(c.lines, line),
    sink: name,
    path: trail,
    confidence: weak ? 'review' : 'verified',
    extra: extras.length ? extras.join(' ') : undefined,
  });
  return region.next;
}

/** `$x = …`, `$x .= …`, `$x[...] = …`: taint (or clear) the left-hand variable. */
function handleAssign(c: Ctx, i: number): number | null {
  const { tokens } = c;
  if (!isVar(tokens[i]) || SUPERGLOBALS.has((tokens[i] as { name: string }).name)) return null;
  let j = i + 1;
  // Skip a single `[...]` subscript on the left-hand side.
  if (isPunc(tokens[j], '[')) j = matchPair(tokens, j) + 1;
  const assign = tokens[j];
  const append = isOp(assign, '.=');
  if (!isOp(assign, '=') && !append) return null;
  // Find the end of the statement (top-level `;`).
  let end = j + 1;
  let depth = 0;
  for (; end < tokens.length; end++) {
    const t = tokens[end]!;
    if (isPunc(t, '(') || isPunc(t, '[') || isPunc(t, '{')) depth++;
    else if (isPunc(t, ')') || isPunc(t, ']') || isPunc(t, '}')) depth--;
    else if (isPunc(t, ';') && depth === 0) break;
  }
  const r = evalRegion(tokens, j + 1, end, c.taint);
  const name = (tokens[i] as { name: string }).name;
  const prev = append ? c.taint.get(name) : undefined;
  if (r.tainted) {
    c.taint.set(name, {
      origin: prev?.origin ?? r.origin ?? name,
      cleaned: new Set([...(prev?.cleaned ?? []), ...r.cleaned]),
      weak: new Set([...(prev?.weak ?? []), ...r.weak]),
    });
  } else if (!append) {
    c.taint.delete(name); // plain re-assignment to a clean value clears the taint
  }
  return end;
}

/** First simple (non-superglobal) variable inside a call argument region. */
function firstLocalVar(tokens: Token[], from: number, to: number): string | null {
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (isVar(t) && !SUPERGLOBALS.has(t.name)) return t.name;
  }
  return null;
}

/**
 * A validating guard narrows a tainted variable so the branch it guards is safe:
 * `in_array($x, $w, true)` (strict whitelist), `ctype_*($x)`, anchored `preg_match('/^…$/', $x)`.
 * Processed in source order, so the guard clears the variable before the sink it protects. This is
 * a heuristic (no real branch scope): a bypass in an `else` branch can escape it.
 */
function handleGuard(c: Ctx, i: number): void {
  const { tokens } = c;
  const id = tokens[i];
  if (!isId(id) || !isPunc(tokens[i + 1], '(')) return;
  const close = matchPair(tokens, i + 1);
  const name = id.lower;
  const clean = (v: string | null, weak: boolean) => {
    if (!v) return;
    const cur = c.taint.get(v);
    if (cur) (weak ? cur.weak : cur.cleaned).add('any');
  };
  if ((name === 'in_array' || name === 'array_search') && isPunc(tokens[i + 1], '(')) {
    const args = splitArgs(tokens, i + 2, close);
    const strict = args[2]?.some((x) => isId(x) && x.lower === 'true');
    if (strict) clean(firstLocalVar(tokens, i + 2, close), false);
  } else if (/^ctype_[a-z]+$/.test(name)) {
    clean(firstLocalVar(tokens, i + 2, close), false);
  } else if (name === 'preg_match') {
    const pat = tokens[i + 2];
    const anchored = pat?.kind === 'str' && /\^.*\$/.test(pat.str.content);
    const args = splitArgs(tokens, i + 2, close);
    const subject = args[1] ? firstLocalVar(tokens, i + 2, close) : null;
    clean(subject, !anchored);
  }
}

function forwardPass(c: Ctx): void {
  const { tokens } = c;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // Record taint from an assignment, but keep scanning its right-hand side: a sink can sit there
    // (`$out = system($_GET['c']);`, `$o = unserialize($_POST['x']);`, a backtick command).
    if (isVar(t)) handleAssign(c, i);
    if (isId(t)) {
      handleGuard(c, i);
      const def = SINKS[t.lower];
      if (def) {
        const next = handleSink(c, i, def, t.lower);
        if (next > i) i = next - 1;
      }
    }
    // Backtick shell: `… $cmd …` with an interpolated tainted / superglobal variable.
    if (t.kind === 'backtick') {
      const vars = t.str.vars;
      const tainted = vars.find((v) => SUPERGLOBALS.has(v) || c.taint.has(v));
      if (tainted) {
        const known = c.taint.get(tainted);
        pushFinding(c, {
          cls: 'cmd',
          severity: 'P0',
          line: t.line,
          snippet: snippetAt(c.lines, t.line),
          sink: '`…`',
          path: `${known?.origin ?? `$${tainted}`} → \`…\``,
          confidence: 'verified',
        });
      }
    }
  }
}

// ---------- pattern rules (context-free) ----------

function patternRules(c: Ctx, src: string): string[] {
  const { tokens } = c;
  const magic: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // Magic methods present (feeds the unserialize POP-chain note).
    if (
      isId(t) &&
      /^__(wakeup|destruct|tostring|get|set|call|callstatic|invoke|construct)$/.test(t.lower)
    ) {
      magic.push(t.name);
    }
    // Loose comparison == / != — type juggling and magic hashes.
    if (isOp(t, '==') || isOp(t, '!=')) {
      const left = tokens[i - 1];
      const right = tokens[i + 1];
      const isMagicStr = (x: Token | undefined) =>
        !!x && x.kind === 'str' && /^0e\d+$/i.test(x.str.content);
      // `md5(...) == "0e..."` or a bare 0e-string comparison: magic hash.
      if (isMagicStr(left) || isMagicStr(right)) {
        pushFinding(c, {
          cls: 'juggle',
          severity: 'P1',
          line: t.line,
          snippet: snippetAt(c.lines, t.line),
          path: 'magic-hash',
          confidence: 'verified',
          extra: '0e',
        });
        continue;
      }
      // A hash function on either side compared loosely: type juggling on a digest.
      const leftHash = isPunc(left, ')') && hashBefore(tokens, i - 1);
      const rightHash = isId(right) && HASH_FNS.has(right.lower) && isPunc(tokens[i + 2], '(');
      if (leftHash || rightHash) {
        pushFinding(c, {
          cls: 'juggle',
          severity: 'P1',
          line: t.line,
          snippet: snippetAt(c.lines, t.line),
          path: 'loose-hash-compare',
          confidence: 'review',
        });
      }
    }
    // strcmp / strcasecmp used as a boolean (auth bypass with an array argument).
    if (
      isId(t) &&
      (t.lower === 'strcmp' || t.lower === 'strcasecmp') &&
      isPunc(tokens[i + 1], '(')
    ) {
      pushFinding(c, {
        cls: 'juggle',
        severity: 'P1',
        line: t.line,
        snippet: snippetAt(c.lines, t.line),
        path: 'strcmp',
        confidence: 'review',
      });
    }
    // in_array / array_search without the strict third argument.
    if (
      isId(t) &&
      (t.lower === 'in_array' || t.lower === 'array_search') &&
      isPunc(tokens[i + 1], '(')
    ) {
      const close = matchPair(tokens, i + 1);
      const args = splitArgs(tokens, i + 2, close);
      if (args.length < 3 || !args[2]!.some((x) => isId(x) && x.lower === 'true')) {
        pushFinding(c, {
          cls: 'juggle',
          severity: 'P2',
          line: t.line,
          snippet: snippetAt(c.lines, t.line),
          path: 'loose-in-array',
          confidence: 'review',
        });
      }
    }
    // Weak randomness for a secret.
    if (
      isId(t) &&
      /^(rand|mt_rand|uniqid|lcg_value|mt_srand|srand)$/.test(t.lower) &&
      isPunc(tokens[i + 1], '(')
    ) {
      pushFinding(c, {
        cls: 'rand',
        severity: 'P2',
        line: t.line,
        snippet: snippetAt(c.lines, t.line),
        path: t.lower,
        confidence: 'review',
      });
    }
    // Variable extraction from a request.
    if (isId(t) && t.lower === 'extract' && isPunc(tokens[i + 1], '(')) {
      const close = matchPair(tokens, i + 1);
      const inner = tokens.slice(i + 2, close);
      if (inner.some((x) => isVar(x) && SUPERGLOBALS.has(x.name))) {
        pushFinding(c, {
          cls: 'code',
          severity: 'P1',
          line: t.line,
          snippet: snippetAt(c.lines, t.line),
          sink: 'extract',
          path: 'extract(request)',
          confidence: 'verified',
        });
      }
    }
    // parse_str without the second (output) argument writes into local scope.
    if (isId(t) && t.lower === 'parse_str' && isPunc(tokens[i + 1], '(')) {
      const close = matchPair(tokens, i + 1);
      if (splitArgs(tokens, i + 2, close).length < 2) {
        pushFinding(c, {
          cls: 'code',
          severity: 'P1',
          line: t.line,
          snippet: snippetAt(c.lines, t.line),
          sink: 'parse_str',
          path: 'parse_str(1-arg)',
          confidence: 'review',
        });
      }
    }
    // preg_replace with the /e modifier (code execution, PHP < 7).
    if (isId(t) && t.lower === 'preg_replace' && isPunc(tokens[i + 1], '(')) {
      const pat = tokens[i + 2];
      if (pat?.kind === 'str' && /^(.).*\1[a-z]*e[a-z]*$/i.test(pat.str.content.trim())) {
        pushFinding(c, {
          cls: 'code',
          severity: 'P0',
          line: t.line,
          snippet: snippetAt(c.lines, t.line),
          sink: 'preg_replace',
          path: 'preg_replace /e',
          confidence: 'verified',
          extra: 'php7',
        });
      }
    }
    // curl_setopt(…, CURLOPT_URL, $tainted) — SSRF.
    if (isId(t) && t.lower === 'curl_setopt' && isPunc(tokens[i + 1], '(')) {
      const close = matchPair(tokens, i + 1);
      const args = splitArgs(tokens, i + 2, close);
      const opt = args[1];
      if (opt?.some((x) => isId(x) && x.lower === 'curlopt_url')) {
        const r = evalRegion(tokens, i + 2, close, c.taint);
        if (r.tainted)
          pushFinding(c, {
            cls: 'ssrf',
            severity: 'P1',
            line: t.line,
            snippet: snippetAt(c.lines, t.line),
            sink: 'curl_setopt',
            path: `${r.origin} → CURLOPT_URL`,
            confidence: 'verified',
          });
      }
    }
  }

  // Password hashing with a broken digest, when the line is about a password.
  const lines = c.lines;
  for (let n = 0; n < lines.length; n++) {
    const ln = lines[n]!;
    if (
      /\b(md5|sha1)\s*\(/i.test(ln) &&
      /\b(pass|passwd|password|pwd|mot_de_passe|motdepasse)\b/i.test(ln)
    ) {
      pushFinding(c, {
        cls: 'password',
        severity: 'P1',
        line: n + 1,
        snippet: ln.trim().slice(0, 200),
        path: 'weak-password-hash',
        confidence: 'review',
      });
    }
  }

  // php.ini directives pasted alongside (or instead of) code.
  const iniRe =
    /^\s*(allow_url_include|allow_url_fopen|register_globals|display_errors|expose_php|enable_dl|session\.upload_progress\.enabled)\s*=\s*(On|1|true)\b/gim;
  for (const m of src.matchAll(iniRe)) {
    const line = src.slice(0, m.index).split(/\r?\n/).length;
    pushFinding(c, {
      cls: 'config',
      severity: m[1]!.toLowerCase().startsWith('allow_url') ? 'P1' : 'P2',
      line,
      snippet: m[0].trim(),
      path: m[1]!,
      confidence: 'verified',
    });
  }

  return [...new Set(magic)];
}

function hashBefore(tokens: Token[], closeParen: number): boolean {
  // tokens[closeParen] is ')': find its opener and the id just before it.
  for (let d = 0, i = closeParen; i >= 0; i--) {
    if (isPunc(tokens[i], ')')) d++;
    else if (isPunc(tokens[i], '(')) {
      d--;
      if (d === 0) {
        const name = tokens[i - 1];
        return isId(name) && HASH_FNS.has(name.lower);
      }
    }
  }
  return false;
}

function splitArgs(tokens: Token[], from: number, to: number): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (let i = from; i < to; i++) {
    const t = tokens[i]!;
    if (isPunc(t, '(') || isPunc(t, '[') || isPunc(t, '{')) depth++;
    else if (isPunc(t, ')') || isPunc(t, ']') || isPunc(t, '}')) depth--;
    if (isPunc(t, ',') && depth === 0) {
      out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------- version banner ----------

function versionBanner(src: string): string | null {
  const m =
    /PHP\/(\d+\.\d+(?:\.\d+)?)/i.exec(src) ??
    /X-Powered-By:\s*PHP\/(\d+\.\d+(?:\.\d+)?)/i.exec(src);
  return m ? m[1]! : null;
}

// ---------- entry point ----------

export function analyze(src: string): Analysis {
  const tokens = lexPhp(src);
  const lines = src.split(/\r?\n/);
  const c: Ctx = { tokens, lines, taint: new Map(), findings: [], safe: [] };
  const isPhp = /<\?(php|=)?/.test(src) || tokens.some((t) => t.kind === 'var');

  forwardPass(c);
  const magicMethods = patternRules(c, src);

  // Sort: severity first, then line.
  const rank: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  c.findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.line - b.line);
  const capped = Math.max(0, c.findings.length - MAX_FINDINGS);

  return {
    findings: c.findings.slice(0, MAX_FINDINGS),
    safe: c.safe,
    isPhp,
    magicMethods,
    versionBanner: versionBanner(src),
    capped,
  };
}
