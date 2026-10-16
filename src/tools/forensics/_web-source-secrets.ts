/**
 * The secret hunter of the Web source analyzer: a SEARCH over text, not a guess about file names.
 * It looks at everything it is given (a page, a script, and every sourcesContent of a source map)
 * and reports what looks like a credential or a flag:
 *
 *  - flag-like strings (`prefix{…}`, the same pattern as the rest of the site);
 *  - known key formats: AWS, GitHub, Google, Stripe, Slack, PEM private keys, URL credentials,
 *    Bearer and Basic headers, and JSON Web Tokens (header and payload decoded);
 *  - assignments and properties named pass / password / secret / token / api key / auth /
 *    private … with a literal value, and `key: value` lines in comments and plain files;
 *  - comparisons of something with a string literal near such a name (`pw === "letmein"`);
 *  - strings written as escapes (`"\x66\x6c…"`) or `String.fromCharCode(…)`, decoded;
 *  - base64 and hex blobs, with the decoded text when it is printable, or the file type;
 *  - high-entropy strings (Shannon ≥ 4.0 bits per character, 20 characters or more);
 *  - the keywords flag, password, secret, token, api key in comments.
 *
 * Nothing is executed. Hits that overlap are merged into one finding that lists every reason.
 * Dependencies (node_modules, bundler runtime) only get the strong checks, so a React build does
 * not drown the application's own files in noise; the weak checks can be switched on.
 */
import {
  detectAssignments,
  detectCharCodes,
  detectComments,
  detectComparisons,
  detectLines,
  detectNumbers,
  detectStrong,
  detectStringValues,
  detectTokens,
} from './_web-source-detect';
import {
  Hits,
  KIND_ORDER,
  SEVERITY_RANK,
  nameClass,
  valueClass,
  type Finding,
  type Hit,
  type Info,
  type Kind,
  type Severity,
} from './_web-source-hits';
import { lexJs, LineIndex, type Lexed } from './_web-source-lex';

export type { Finding, Info, Kind, Severity } from './_web-source-hits';
export { KIND_ORDER } from './_web-source-hits';

export interface Region {
  start: number;
  end: number;
}

export interface HtmlRegions {
  /** Inline <script> bodies and on…= attribute values (JavaScript). */
  scripts: Region[];
  /** <style> bodies. */
  styles: Region[];
  comments: Region[];
  /** Form fields, meta tags and data-* attributes: the name they go by and their value. */
  fields: { name: string; value: string; start: number; end: number; hidden: boolean }[];
}

export interface ScanDoc {
  name: string | null;
  text: string;
  dependency: boolean;
  lang: 'js' | 'html' | 'text';
  /** A stylesheet: `a{color:red}` is not a flag. */
  css?: boolean;
  html?: HtmlRegions;
}

export interface ScanOptions {
  /** Run the weak checks on dependencies too. */
  deps: boolean;
}

export interface ScanResult {
  findings: Finding[];
  /** Documents longer than the scan limit: only their start was read. */
  cut: number;
  /** Findings of a weak kind left out because their file already had many of them. */
  trimmed: number;
  /** More findings than the cap: the weakest were dropped. */
  capped: boolean;
}

export const MAX_DOC_CHARS = 8_000_000;
const MAX_FINDINGS = 2000;
const MAX_PER_DOC = 400;
const MAX_MATCH_CHARS = 160;
const CONTEXT_WIDTH = 64;

/** Sorted, non-overlapping-or-not spans of a text, and a binary search for "is this inside one". */
class Spans {
  private readonly spans: Region[];

  constructor(spans: Region[]) {
    this.spans = [...spans].sort((a, b) => a.start - b.start);
  }

  has(pos: number): boolean {
    let lo = 0;
    let hi = this.spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.spans[mid]!;
      if (pos < s.start) hi = mid - 1;
      else if (pos >= s.end) lo = mid + 1;
      else return true;
    }
    return false;
  }
}

function assignHidden(doc: ScanDoc, hits: Hits): void {
  for (const f of doc.html?.fields ?? []) {
    const cls = nameClass(f.name);
    if (!f.value || !(f.hidden || cls)) continue;
    const vc = valueClass(f.value);
    if (vc === 'empty') continue;
    hits.add({
      kind: cls ? 'assign' : 'hidden',
      severity: cls ? (cls === 'strong' && vc === 'secret' ? 'high' : 'low') : 'low',
      start: f.start,
      end: f.end,
      info: { name: f.name, via: 'field' },
    });
  }
}

function scanDoc(doc: ScanDoc, text: string, opts: ScanOptions): Hit[] {
  const hits = new Hits();
  if (doc.dependency && !opts.deps) {
    detectStrong(text, hits, { strongOnly: true, genericAt: () => false });
    return hits.list;
  }
  /** The checks that read code: `lexed` has absolute positions; `source` starts at `base`. */
  const code = (lexed: Lexed, source: string, base: number) => {
    detectAssignments(text, lexed.strings, hits);
    detectComparisons(text, lexed.strings, hits);
    detectStringValues(lexed.strings, hits);
    detectComments(lexed.comments, hits);
    detectCharCodes(source, base, hits);
    detectNumbers(source, base, hits);
  };
  if (doc.lang === 'js') {
    const lexed = lexJs(text);
    const inLiteral = new Spans([...lexed.strings, ...lexed.comments]);
    detectStrong(text, hits, {
      strongOnly: doc.dependency,
      genericAt: (i) => !doc.css && inLiteral.has(i),
    });
    code(lexed, text, 0);
  } else if (doc.lang === 'html' && doc.html) {
    const html = doc.html;
    const lexed = html.scripts.map((s) => lexJs(text.slice(s.start, s.end), s.start));
    const scripts = new Spans(html.scripts);
    const styles = new Spans(html.styles);
    const inLiteral = new Spans(lexed.flatMap((l) => [...l.strings, ...l.comments]));
    detectStrong(text, hits, {
      strongOnly: doc.dependency,
      genericAt: (i) => !styles.has(i) && (!scripts.has(i) || inLiteral.has(i)),
    });
    html.scripts.forEach((s, i) => code(lexed[i]!, text.slice(s.start, s.end), s.start));
    for (const c of html.comments)
      detectLines(text.slice(c.start, c.end), c.start, hits, 'comment');
    assignHidden(doc, hits);
    detectTokens(text, hits, (i) => scripts.has(i));
  } else {
    detectStrong(text, hits, { strongOnly: doc.dependency, genericAt: () => !doc.css });
    detectLines(text, 0, hits, 'line');
    detectTokens(text, hits, () => false);
  }
  return hits.list;
}

/** Hits to findings: overlapping hits merge, the strongest reason names the row. */
function merge(docIndex: number, text: string, hits: Hit[], lines: () => LineIndex): Finding[] {
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const groups: Hit[][] = [];
  let end = -1;
  for (const h of hits) {
    const g = groups[groups.length - 1];
    if (g && h.start < end) {
      g.push(h);
      end = Math.max(end, h.end);
    } else {
      groups.push([h]);
      end = h.end;
    }
  }
  const strongStarts = groups
    .filter((g) => g.some((h) => h.kind !== 'keyword'))
    .map((g) => g[0]!.start);
  const out: Finding[] = [];
  for (const g of groups) {
    if (g.every((h) => h.kind === 'keyword')) {
      // A keyword is only worth a row when nothing better is on that line.
      const at = g[0]!.start;
      const near = strongStarts.some(
        (s) =>
          Math.abs(s - at) <= 160 && !text.slice(Math.min(s, at), Math.max(s, at)).includes('\n'),
      );
      if (near) continue;
    }
    const rank = (h: Hit) => KIND_ORDER.indexOf(h.kind);
    const sorted = [...g].sort(
      (a, b) => rank(a) - rank(b) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    const primary = sorted[0]!;
    // "High entropy" and "keyword" only explain a row when nothing more specific does.
    const specific = sorted.filter((h) => h.kind !== 'entropy' && h.kind !== 'keyword');
    const reasons = specific.length ? specific : sorted;
    const info: Info = {};
    for (const h of reasons) {
      for (const [k, v] of Object.entries(h.info ?? {})) {
        if (v !== undefined && info[k as keyof Info] === undefined) info[k as keyof Info] = v;
      }
    }
    const severity = g.reduce<Severity>(
      (acc, h) => (SEVERITY_RANK[h.severity] < SEVERITY_RANK[acc] ? h.severity : acc),
      'low',
    );
    const pos = lines().at(primary.start);
    const matchEnd = Math.min(primary.end, primary.start + MAX_MATCH_CHARS);
    const lineEnd = text.indexOf('\n', primary.start);
    const cut = lineEnd >= 0 && lineEnd < matchEnd ? lineEnd : matchEnd;
    const cutShort = primary.end > cut;
    const beforeRaw = text.slice(Math.max(0, primary.start - CONTEXT_WIDTH), primary.start);
    const afterRaw = cutShort ? '' : text.slice(cut, cut + CONTEXT_WIDTH);
    const nlBefore = beforeRaw.lastIndexOf('\n');
    const nlAfter = afterRaw.indexOf('\n');
    const flat = (s: string) => s.replace(/[\t\r]/g, ' ');
    out.push({
      doc: docIndex,
      kinds: [...new Set(reasons.map((h) => h.kind))],
      severity,
      start: primary.start,
      end: primary.end,
      line: pos.line,
      col: pos.col,
      match: flat(text.slice(primary.start, cut)) + (cutShort ? '…' : ''),
      info,
      before:
        (nlBefore >= 0 ? '' : primary.start - CONTEXT_WIDTH > 0 ? '…' : '') +
        flat(nlBefore >= 0 ? beforeRaw.slice(nlBefore + 1) : beforeRaw),
      after:
        flat(nlAfter >= 0 ? afterRaw.slice(0, nlAfter) : afterRaw) +
        (!cutShort && nlAfter < 0 && cut + CONTEXT_WIDTH < text.length ? '…' : ''),
    });
  }
  return out;
}

/** Strongest severity first, then the kind order, then where it sits. */
function rowOrder(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    KIND_ORDER.indexOf(a.kinds[0]!) - KIND_ORDER.indexOf(b.kinds[0]!) ||
    a.doc - b.doc ||
    a.start - b.start
  );
}

/**
 * Per file, the weak kinds are listed up to a limit: a data table or a lookup of messages holds
 * hundreds of random-looking strings, and they must not bury what matters.
 */
const PER_DOC_LIMIT: Partial<Record<Kind, number>> = {
  entropy: 12,
  blob: 25,
  compare: 60,
  keyword: 40,
};

/** Scan documents; the findings are sorted strongest first, then in document order. */
export function scanDocs(docs: ScanDoc[], opts: ScanOptions): ScanResult {
  const all: Finding[] = [];
  let cut = 0;
  let trimmed = 0;
  docs.forEach((doc, i) => {
    const long = doc.text.length > MAX_DOC_CHARS;
    if (long) cut++;
    const text = long ? doc.text.slice(0, MAX_DOC_CHARS) : doc.text;
    const hits = scanDoc(doc, text, opts);
    if (!hits.length) return;
    let index: LineIndex | null = null;
    const found = merge(i, text, hits, () => (index ??= new LineIndex(text)));
    found.sort(rowOrder);
    const seen = new Map<Kind, number>();
    const kept = found.filter((f) => {
      const kind = f.kinds[0]!;
      const n = (seen.get(kind) ?? 0) + 1;
      seen.set(kind, n);
      const limit = PER_DOC_LIMIT[kind];
      if (limit !== undefined && n > limit) {
        trimmed++;
        return false;
      }
      return true;
    });
    all.push(...kept.slice(0, MAX_PER_DOC));
  });
  all.sort(rowOrder);
  return { findings: all.slice(0, MAX_FINDINGS), cut, trimmed, capped: all.length > MAX_FINDINGS };
}
