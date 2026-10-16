/**
 * What the Web source analyzer shows: the analysis turned into output blocks. Everything that
 * comes from the input (URLs, paths, code, comments) goes into text, table and key/value blocks,
 * which the page draws with textContent: nothing here is markup, and nothing is a link.
 */
import { registeredTools } from '../../core/tool-list';
import type { Output } from '../../core/types';
import { toolName, toolT } from '../../i18n/tool-text';
import { formatSize, utf8Encode } from '../../lib/bytes';
import { LineIndex } from './_web-source-lex';
import { MAX_BYTES, PROXIES, TIMEOUT_MS, type Attempt, type ProxyId } from './_web-source-fetch';
import { baseName, drawTree, utf8Length, zipSources, type MapSource } from './_web-source-map';
import type { Analysis, MapState, NetworkEntry, Opts, RunResult } from './_web-source-run';
import type { Finding, Kind } from './_web-source-secrets';

const T = toolT('web-source');

const MAX_CONTEXT_ENTRIES = 40;
const MAX_CONTEXT_CHARS = 30_000;
const MAX_OPEN = 12;
const MAX_AUTO_OPEN = 16;
const MAX_AUTO_OPEN_BYTES = 400_000;
const MAX_AUTO_FILE_BYTES = 150_000;
const MAX_COMMENTS = 100;

const shorten = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const proxyLabel = (id: ProxyId): string => PROXIES.find((p) => p.id === id)?.label ?? id;

// ---------- words for the hunter's results ----------

function kindLabel(k: Kind): string {
  switch (k) {
    case 'aws':
      return T('kind.aws');
    case 'github':
      return T('kind.github');
    case 'google':
      return T('kind.google');
    case 'stripe':
      return T('kind.stripe');
    case 'slack':
      return T('kind.slack');
    case 'pem':
      return T('kind.pem');
    case 'jwt':
      return T('kind.jwt');
    case 'credentials':
      return T('kind.credentials');
    case 'bearer':
      return T('kind.bearer');
    case 'flag':
      return T('kind.flag');
    case 'assign':
      return T('kind.assign');
    case 'compare':
      return T('kind.compare');
    case 'charcode':
      return T('kind.charcode');
    case 'escaped':
      return T('kind.escaped');
    case 'hidden':
      return T('kind.hidden');
    case 'blob':
      return T('kind.blob');
    case 'entropy':
      return T('kind.entropy');
    case 'keyword':
      return T('kind.keyword');
  }
}

function viaLabel(via: string): string {
  switch (via) {
    case 'escapes':
      return T('via.escapes');
    case 'charcode':
      return T('via.charcode');
    case 'comment':
      return T('via.comment');
    case 'field':
      return T('via.field');
    case 'line':
      return T('via.line');
    default:
      return via; // base64, hex: technical terms
  }
}

function detailOf(f: Finding): string {
  const i = f.info;
  const parts: string[] = [];
  if (i.service) parts.push(i.service);
  if (i.name && f.kinds.includes('credentials')) {
    parts.push(T('detail.credentials', { user: i.name, password: i.value ?? '' }));
  } else if (i.name && f.kinds.includes('compare')) {
    parts.push(T('detail.compare', { expr: i.name, op: i.op ?? '==' }));
  } else if (i.name) {
    // Where the name was seen: a comment, a form field, a plain file.
    const seen =
      i.via === 'comment' || i.via === 'field' || i.via === 'line' ? ` (${viaLabel(i.via)})` : '';
    parts.push(T('detail.name', { name: i.name }) + seen);
  }
  if (i.header !== undefined)
    parts.push(T('detail.jwt', { header: i.header, payload: i.payload ?? '' }));
  if (i.decoded !== undefined) {
    parts.push(T('detail.decoded', { via: viaLabel(i.via ?? 'base64'), text: i.decoded }));
  } else if (i.via && !i.name) parts.push(viaLabel(i.via));
  if (i.fileType)
    parts.push(T('detail.fileType', { type: i.fileType, size: formatSize(Number(i.bytes ?? 0)) }));
  else if (i.bytes && f.kinds.includes('pem')) parts.push(T('detail.pem', { size: i.bytes }));
  if (i.hash) parts.push(T('detail.hash', { hash: i.hash }));
  if (i.entropy) parts.push(T('detail.entropy', { bits: i.entropy }));
  return parts.join(' · ');
}

const whereOf = (a: Analysis, f: Finding): string => {
  const name = a.docs[f.doc]?.name;
  return name ? `${name}:${f.line}:${f.col}` : `${f.line}:${f.col}`;
};

const kindsOf = (f: Finding): string =>
  f.kinds
    .slice(0, 3)
    .map((k) => kindLabel(k))
    .join(' + ');

/** The whole matched text (Finding.match is cut for display), without the quotes of a literal. */
function fullMatch(a: Analysis, f: Finding, max = 20_000): string {
  const text = (a.docs[f.doc]?.text ?? '').slice(f.start, Math.min(f.end, f.start + max));
  const q = text[0];
  return text.length >= 2 && (q === '"' || q === "'" || q === '`') && text.endsWith(q)
    ? text.slice(1, -1)
    : text;
}

// ---------- network ----------

function attemptDetail(at: Attempt): string {
  if (at.ok) return `${at.status} · ${formatSize(at.bytes)} · ${at.ms} ms`;
  switch (at.reason) {
    case 'http':
      return T('net.http', { status: at.status ?? 0 });
    case 'timeout':
      return T('net.timeout', { seconds: TIMEOUT_MS / 1000 });
    case 'empty':
      return T('net.empty');
    case 'tooLarge':
      return T('net.tooLarge', { limit: formatSize(MAX_BYTES) });
    default:
      return T('net.network');
  }
}

function requestLabel(e: NetworkEntry): string {
  const what = e.what === 'page' ? T('net.page') : e.what === 'map' ? T('net.map') : T('net.guess');
  return `${what}: ${e.url}`;
}

function networkBlocks(entries: NetworkEntry[], o: Opts): Output[] {
  const rows: string[][] = [];
  const good: number[] = [];
  for (const e of entries) {
    for (const at of e.outcome.attempts) {
      if (at.ok) good.push(rows.length);
      // The long request (a URL) comes last: the first columns of a table never wrap.
      rows.push([
        proxyLabel(at.proxy),
        at.ok ? T('net.ok') : T('net.failed'),
        attemptDetail(at),
        requestLabel(e),
      ]);
    }
  }
  const out: Output[] = [
    {
      type: 'table',
      label: T('label.network'),
      columns: [T('col.proxy'), T('col.result'), T('col.detail'), T('col.request')],
      rows,
      highlight: good,
    },
  ];
  if (entries.some((e) => e.outcome.cached)) {
    out.push({ type: 'note', level: 'info', text: T('note.fromMemory') });
    out.push(fetchAgain(o));
  }
  return out;
}

const fetchAgain = (o: Opts): Output => ({
  type: 'actions',
  actions: [
    {
      label: T('action.fetchAgain'),
      options: { refresh: String((Number(o.refresh) || 0) + 1) },
    },
  ],
});

// ---------- summary ----------

function typeLabel(a: Analysis): string {
  switch (a.type) {
    case 'html':
      return T('type.html');
    case 'js':
      return T('type.js');
    case 'map':
      return T('type.map');
    case 'css':
      return T('type.css');
    default:
      return T('type.text');
  }
}

function mapStatus(m: MapState): string {
  switch (m.status) {
    case 'none':
      return m.guessed ? T('map.noneGuess', { url: m.guessed }) : T('map.none');
    case 'pending':
      return T('map.pending', { ref: shorten(m.ref, 300) });
    case 'failed':
      return T('map.failed', { detail: shorten(m.detail, 300) });
    case 'loaded':
      switch (m.via) {
        case 'input':
          return T('map.input');
        case 'pasted':
          return T('map.pasted');
        case 'file':
          return T('map.file', { name: m.fileName ?? '.map' });
        case 'inline':
          return T('map.inline');
        case 'url':
          return T('map.url', { url: m.url ?? '' });
        case 'guess':
          return T('map.guess', { url: m.url ?? '' });
      }
  }
}

function originLabel(a: Analysis): string {
  if (a.origin === 'paste') return T('origin.paste');
  const entry = a.network.find((e) => e.what === 'page');
  const ok = entry?.outcome.ok ? entry.outcome : null;
  const p = { url: a.url ?? '', proxy: ok ? proxyLabel(ok.via) : '?' };
  return ok?.cached ? T('origin.cached', p) : T('origin.url', p);
}

function summary(a: Analysis): Output {
  const { findings } = a.scan;
  const count = (s: Finding['severity']) => findings.filter((f) => f.severity === s).length;
  const entries: [string, string][] = [
    [T('kv.type'), typeLabel(a)],
    [T('kv.size'), T('kv.sizeValue', { size: formatSize(utf8Length(a.text)), lines: a.lines })],
    [T('kv.origin'), originLabel(a)],
    [T('kv.map'), mapStatus(a.map)],
  ];
  if (a.map.status === 'loaded') {
    const m = a.map.map;
    const withContent = m.sources.filter((s) => s.content !== null).length;
    entries.push([
      T('kv.sources'),
      T('kv.sourcesValue', {
        count: m.sources.length,
        withContent,
        size: formatSize(m.sources.reduce((n, s) => n + s.bytes, 0)),
      }),
    ]);
    if (m.file) entries.push([T('kv.mapFile'), m.file]);
    if (m.version !== null) entries.push([T('kv.mapVersion'), String(m.version)]);
    if (m.sourceRoot) entries.push([T('kv.mapRoot'), m.sourceRoot]);
    if (m.sections) entries.push([T('kv.mapSections'), String(m.sections)]);
  }
  entries.push([
    T('kv.findings'),
    findings.length
      ? T('kv.findingsValue', {
          count: findings.length,
          high: count('high'),
          medium: count('medium'),
          low: count('low'),
        })
      : T('kv.none'),
  ]);
  return { type: 'kv', label: T('label.summary'), entries };
}

// ---------- findings ----------

function findingBlocks(a: Analysis): Output[] {
  const { findings } = a.scan;
  if (!findings.length) return [{ type: 'note', level: 'info', text: T('note.noFindings') }];
  // What was found comes first and the place (a long path) after it: the first columns of a
  // table never wrap, and the pane is narrow. "#" is the number in the preview below.
  const rows = findings.map((f, i) => [
    i + 1,
    f.match,
    kindsOf(f),
    whereOf(a, f),
    detailOf(f),
    `${f.before}${f.match}${f.after}`,
  ]);
  const out: Output[] = [
    {
      type: 'table',
      label: T('label.findings', { count: findings.length }),
      columns: [
        T('col.index'),
        T('col.found'),
        T('col.kind'),
        T('col.where'),
        T('col.detail'),
        T('col.context'),
      ],
      rows,
      highlight: findings.flatMap((f, i) => (f.severity === 'high' && i < 200 ? [i] : [])),
    },
  ];
  // The strongest findings with the match marked in its line: a bounded preview.
  const lines: string[] = [];
  let chars = 0;
  for (const [i, f] of findings.slice(0, MAX_CONTEXT_ENTRIES).entries()) {
    const entry = `${i + 1}. ${whereOf(a, f)}  [${kindsOf(f)}]\n     ${f.before}«${f.match}»${f.after}`;
    chars += entry.length + 2;
    if (chars > MAX_CONTEXT_CHARS) break;
    lines.push(entry);
  }
  out.push({ type: 'text', label: T('label.context'), value: lines.join('\n\n') });
  if (a.scan.capped) out.push({ type: 'note', level: 'warn', text: T('note.capped') });
  if (a.scan.trimmed) {
    out.push({ type: 'note', level: 'info', text: T('note.trimmed', { count: a.scan.trimmed }) });
  }
  return out;
}

// ---------- source map ----------

/** Sources the user asked for with the Open option: a number (`5`, `#5`) or part of a path. */
function matching(sources: MapSource[], query: string): MapSource[] {
  const tokens = query.split(/[\s,;]+/).filter(Boolean);
  const hit = new Set<number>();
  for (const tok of tokens) {
    const n = /^#?(\d+)$/.exec(tok);
    if (n) {
      if (sources[Number(n[1])]) hit.add(Number(n[1]));
      continue;
    }
    const needle = tok.toLowerCase();
    for (const s of sources) if (s.path.toLowerCase().includes(needle)) hit.add(s.index);
  }
  return [...hit].sort((x, y) => x - y).map((i) => sources[i]!);
}

/** Without a request from the user: the files with findings, then the application's own files. */
function autoOpen(sources: MapSource[], hits: Map<number, number>): MapSource[] {
  const withContent = sources.filter((s) => s.content);
  const flagged = withContent
    .filter((s) => (hits.get(s.index) ?? 0) > 0)
    .sort((x, y) => (hits.get(y.index) ?? 0) - (hits.get(x.index) ?? 0) || x.index - y.index)
    .slice(0, 8);
  const chosen = new Set(flagged.map((s) => s.index));
  let total = flagged.reduce((n, s) => n + s.bytes, 0);
  for (const s of withContent) {
    if (chosen.size >= MAX_AUTO_OPEN) break;
    if (s.dependency || chosen.has(s.index) || s.bytes > MAX_AUTO_FILE_BYTES) continue;
    if (total + s.bytes > MAX_AUTO_OPEN_BYTES) continue;
    chosen.add(s.index);
    total += s.bytes;
  }
  return withContent.filter((s) => chosen.has(s.index));
}

function mapBlocks(a: Analysis, o: Opts): Output[] {
  const m = a.map;
  const out: Output[] = [];
  if (m.status === 'pending') {
    const p = { ref: shorten(m.ref, 300) };
    const usable = m.why === 'paste' || m.why === 'relative';
    out.push({
      type: 'note',
      level: 'warn',
      text: usable ? T('note.mapPending', p) : T('note.mapUnusable', p),
    });
    return out;
  }
  if (m.status === 'failed') {
    const p = { detail: shorten(m.detail, 300) };
    out.push({
      type: 'note',
      level: 'warn',
      text: m.why === 'fetch' ? T('note.mapFetchFailed', p) : T('note.mapBad', p),
    });
    return out;
  }
  if (m.status === 'none') {
    out.push({ type: 'note', level: 'info', text: T('note.noMap') });
    return out;
  }
  const { sources, warnings } = m.map;
  for (const w of warnings) {
    if (w.code === 'version')
      out.push({ type: 'note', level: 'warn', text: T('warn.version', { version: w.arg }) });
    else if (w.code === 'sectionUrl')
      out.push({ type: 'note', level: 'warn', text: T('warn.sectionUrl', { url: w.arg }) });
    else out.push({ type: 'note', level: 'warn', text: T('warn.capped', { max: w.arg }) });
  }
  if (a.ignoredMapFile) out.push({ type: 'note', level: 'info', text: T('note.mapFileIgnored') });
  if (!sources.length) {
    out.push({ type: 'note', level: 'warn', text: T('note.mapEmpty') });
    return out;
  }
  // Findings per source.
  const hits = new Map<number, number>();
  for (const f of a.scan.findings) {
    const s = a.docSources[f.doc];
    if (s) hits.set(s.index, (hits.get(s.index) ?? 0) + 1);
  }
  const withContent = sources.filter((s) => s.content !== null);
  if (!withContent.length) {
    out.push({ type: 'note', level: 'warn', text: T('note.noContent', { count: sources.length }) });
  }
  const label = (s: MapSource) => s.path || `#${s.index}`;
  out.push({
    type: 'table',
    label: T('label.sources', { count: sources.length }),
    // The path (long) is the last column, so that it can use the width that is left.
    columns: [
      T('col.index'),
      T('col.bytes'),
      T('col.findingsCount'),
      T('col.type'),
      T('col.source'),
    ],
    rows: sources.map((s) => [
      s.index,
      s.bytes,
      hits.get(s.index) ?? 0,
      s.content === null
        ? T('type.noContent')
        : s.dependency
          ? T('type.dependency')
          : T('type.app'),
      label(s),
    ]),
    highlight: sources.flatMap((s, i) => ((hits.get(s.index) ?? 0) > 0 && i < 300 ? [i] : [])),
  });
  const tree = drawTree(sources, (s) => {
    const parts = [formatSize(s.bytes)];
    if (s.content === null) parts.push(T('tree.noContent'));
    else if (s.dependency) parts.push(T('tree.dependency'));
    const n = hits.get(s.index);
    if (n) parts.push(T('tree.findings', { count: n }));
    return `  ${parts.join(' · ')}`;
  });
  out.push({
    type: 'text',
    label: T('label.tree'),
    value: tree.lines.join('\n') + (tree.cut ? `\n${T('tree.more', { count: tree.cut })}` : ''),
  });

  // The files themselves: shown as text, each with Copy and Download.
  const query = o.open.trim();
  let shown: MapSource[];
  if (query) {
    const found = matching(sources, query);
    shown = found.slice(0, MAX_OPEN);
    if (!found.length)
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.openNone', { query: shorten(query, 60) }),
      });
    else if (found.length > shown.length) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.openMore', { shown: shown.length, count: found.length }),
      });
    }
  } else {
    shown = autoOpen(sources, hits);
    const rest = withContent.length - shown.length;
    if (rest > 0)
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.openRest', { shown: shown.length, rest }),
      });
  }
  for (const s of shown) {
    if (s.content === null) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.openNoContent', { source: label(s) }),
      });
      continue;
    }
    out.push({
      type: 'bytes',
      label: `#${s.index} ${label(s)}`,
      value: utf8Encode(s.content),
      filename: baseName(s),
    });
  }
  const zip = zipSources(sources);
  if (zip) {
    out.push({
      type: 'files',
      label: T('label.download'),
      files: [{ name: 'sources.zip', data: zip.zip, note: T('note.zip', { count: zip.files }) }],
    });
  }
  const deps = sources.filter((s) => s.dependency && s.content !== null).length;
  if (deps && !o.deps)
    out.push({ type: 'note', level: 'info', text: T('note.deps', { count: deps }) });
  out.push({ type: 'note', level: 'info', text: T('note.orphan') });
  return out;
}

// ---------- HTML ----------

function refNote(url: string, base: string | null): string {
  const u = url.trim();
  if (/^javascript:/i.test(u)) return T('refnote.javascript');
  if (/^data:/i.test(u)) return T('refnote.data');
  if (!base || /^(?:mailto|tel|sms|#)/i.test(u)) return '';
  try {
    const abs = new URL(u, base).href;
    return abs === u ? '' : T('refnote.resolved', { url: abs });
  } catch {
    return '';
  }
}

function checklist(a: Analysis): string[] {
  const base = a.url;
  const abs = (p: string) => {
    if (!base) return p;
    try {
      return new URL(p, base).href;
    } catch {
      return p;
    }
  };
  const lines = [abs('/robots.txt'), abs('/sitemap.xml'), abs('/.git/')];
  for (const r of a.html?.refs ?? []) {
    if (r.tag !== 'script' || r.attr !== 'src' || /^(?:data|javascript):/i.test(r.url)) continue;
    const file = r.url.replace(/[?#].*$/, '');
    if (/\.m?js$/i.test(file)) lines.push(abs(`${file}.map`));
  }
  return [...new Set(lines)].slice(0, 40);
}

function htmlBlocks(a: Analysis): Output[] {
  const h = a.html;
  if (!h) return [];
  const out: Output[] = [];
  if (h.shell) out.push({ type: 'note', level: 'warn', text: T('note.shell') });
  if (h.refs.length) {
    out.push({
      type: 'table',
      label: T('label.refs', { count: h.refs.length }),
      columns: [T('col.tag'), T('col.attr'), T('col.reference'), T('col.note')],
      rows: h.refs.map((r) => [r.tag, r.attr, r.url, refNote(r.url, a.url)]),
    });
  }
  const comments = h.parsed.comments.filter((c) => c.text.trim() !== '');
  if (comments.length) {
    const lines = new LineIndex(a.text);
    out.push({
      type: 'text',
      label: T('label.comments', { count: comments.length }),
      value: comments
        .slice(0, MAX_COMMENTS)
        .map(
          (c) =>
            `${T('comment.line', { line: lines.at(c.start).line })}\n${shorten(c.text.trim(), 2000)}`,
        )
        .join('\n\n'),
    });
  }
  out.push({ type: 'text', label: T('label.paths'), value: checklist(a).join('\n') });
  return out;
}

// ---------- links to other tools ----------

function related(a: Analysis): Output[] {
  const tools = registeredTools();
  const find = (id: string) => tools.find((t) => t.id === id);
  const link = (id: string, text: string) => {
    const tool = find(id);
    return tool
      ? [
          {
            label: T('action.open', { tool: toolName(tool) }),
            options: {},
            open: { tool: id, text },
          },
        ]
      : [];
  };
  const findings = a.scan.findings;
  const first = (k: Kind, pick?: (f: Finding) => boolean) =>
    findings.find((f) => f.kinds.includes(k) && (!pick || pick(f)));
  const actions: Extract<Output, { type: 'actions' }>['actions'] = [];
  const jwt = first('jwt');
  if (jwt) actions.push(...link('jwt', fullMatch(a, jwt)));
  const b64 = first('blob', (f) => f.info.via === 'base64');
  if (b64) actions.push(...link('base64', fullMatch(a, b64)));
  const esc = first('escaped');
  if (esc) actions.push(...link('unicode-escape', fullMatch(a, esc)));
  const cc = first('charcode');
  if (cc)
    actions.push(
      ...link(
        'charcode',
        (/\(([^)]*)\)/.exec(fullMatch(a, cc))?.[1] ?? '').replace(/[[\]\s.]/g, ''),
      ),
    );
  const main = a.docs[0]?.text.slice(0, 2_000_000) ?? '';
  if (main) {
    actions.push(...link('strings', main));
    actions.push(...link('js-deobfuscate', main));
  }
  const names = ['unicode-escape', 'charcode', 'base64', 'strings']
    .map((id) => {
      const t = find(id);
      return t ? toolName(t) : id;
    })
    .join(', ');
  const out: Output[] = [
    { type: 'note', level: 'info', text: T('note.related', { tools: names }) },
  ];
  if (actions.length) out.push({ type: 'actions', label: T('label.related'), actions });
  return out;
}

// ---------- everything ----------

export function buildReport(r: RunResult, o: Opts): Output[] {
  if (r.stage === 'suggest-url') {
    return [
      { type: 'note', level: 'info', text: T('note.urlOnly', { url: shorten(r.url, 200) }) },
      { type: 'note', level: 'warn', text: T('note.proxyHonest') },
      {
        type: 'actions',
        actions: [
          { label: T('action.fetchUrl'), options: { source: 'url' }, primary: true },
          { label: T('action.asText'), options: { source: 'paste' } },
        ],
      },
    ];
  }
  if (r.stage === 'fetch-failed') {
    return [
      ...networkBlocks(r.network, o),
      { type: 'note', level: 'error', text: T('note.fetchFailed') },
      { type: 'note', level: 'info', text: T('note.pasteInstead') },
      { type: 'note', level: 'warn', text: T('note.proxyHonest') },
      {
        type: 'actions',
        actions: [
          {
            label: T('action.tryAgain'),
            options: { refresh: String((Number(o.refresh) || 0) + 1) },
            primary: true,
          },
        ],
      },
    ];
  }
  const a = r.analysis;
  const out: Output[] = [];
  if (a.urlModeText) out.push({ type: 'note', level: 'info', text: T('note.urlModeText') });
  if (a.origin === 'url') {
    out.push(...networkBlocks(a.network, o));
    out.push({ type: 'note', level: 'warn', text: T('note.proxyHonest') });
  }
  out.push(summary(a));
  out.push(...findingBlocks(a));
  out.push(...mapBlocks(a, o));
  out.push(...htmlBlocks(a));
  if (a.scan.cut)
    out.push({ type: 'note', level: 'warn', text: T('note.cut', { count: a.scan.cut }) });
  out.push(...related(a));
  out.push({ type: 'note', level: 'info', text: T('note.inert') });
  return out;
}
