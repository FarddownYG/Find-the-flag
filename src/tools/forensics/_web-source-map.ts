/**
 * Source maps (the "version 3" format browsers read from a `.map` file): finding the reference in
 * a script, reading the map, and laying out the original files it carries.
 *
 * A map lists `sources` (original file names) and, when the build asked for it, `sourcesContent`
 * (the files themselves). Anyone who has the map has every file in it, whether or not any page
 * ever loads it: a component whose route was commented out in the router is still there.
 * Indexed maps (`sections`) hold several maps one after the other and are flattened.
 */
import { zipSync } from 'fflate';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { fromBase64, utf8Decode, utf8Encode } from '../../lib/bytes';

const T = toolT('web-source');

// ---------- finding the reference ----------

export type MapRef =
  /** A data: URI inside the script: the map itself. */
  | { kind: 'inline'; json: string; encoding: 'base64' | 'percent' }
  /** A data: URI that cannot be decoded. */
  | { kind: 'inline-bad'; reason: string }
  /** A file name or URL, as written in the comment. */
  | { kind: 'external'; ref: string };

const REF_RE = /(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL=([^\s*'"]+)/g;
/** A reference this close to the end counts even when the comment follows code on its line. */
const TAIL = 2048;

/**
 * The `//# sourceMappingURL=` (or legacy `//@`) comment of a script or stylesheet. The last one
 * wins, as in browsers; a comment that starts its own line, or sits at the very end, is preferred
 * over a mention in the middle of a bundle.
 */
export function findMapRef(source: string): MapRef | null {
  let pick: { ref: string; at: number } | null = null;
  let tailPick: { ref: string; at: number } | null = null;
  for (const m of source.matchAll(REF_RE)) {
    const lineStart = m.index === 0 ? 0 : source.lastIndexOf('\n', m.index - 1) + 1;
    if (source.slice(lineStart, m.index).trim() === '') pick = { ref: m[1]!, at: m.index };
    if (m.index >= source.length - TAIL) tailPick = { ref: m[1]!, at: m.index };
  }
  const chosen = tailPick && (!pick || tailPick.at > pick.at) ? tailPick : pick;
  if (!chosen) return null;
  return chosen.ref.startsWith('data:')
    ? decodeDataUri(chosen.ref)
    : { kind: 'external', ref: chosen.ref };
}

function decodeDataUri(uri: string): MapRef {
  const comma = uri.indexOf(',');
  if (comma < 0) return { kind: 'inline-bad', reason: 'no comma' };
  const meta = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  if (/;base64$/i.test(meta)) {
    try {
      return { kind: 'inline', json: utf8Decode(fromBase64(body)), encoding: 'base64' };
    } catch (e) {
      return { kind: 'inline-bad', reason: e instanceof Error ? e.message : String(e) };
    }
  }
  try {
    return { kind: 'inline', json: decodeURIComponent(body), encoding: 'percent' };
  } catch (e) {
    return { kind: 'inline-bad', reason: e instanceof Error ? e.message : String(e) };
  }
}

export type Resolved =
  { ok: true; url: string } | { ok: false; reason: 'relative' | 'scheme' | 'invalid' };

/** Turn a reference into an absolute http(s) URL: against the script's URL when it is known. */
export function resolveRef(ref: string, base: string | null): Resolved {
  let url: URL;
  try {
    url = base ? new URL(ref, base) : new URL(ref);
  } catch {
    // Without a base, a bare file name is not a URL: the caller says "relative".
    return { ok: false, reason: base || /^[a-z][a-z0-9+.-]*:/i.test(ref) ? 'invalid' : 'relative' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  url.hash = '';
  return { ok: true, url: url.href };
}

/** `https://x/a/app.js?v=3` -> `https://x/a/app.js.map` (the usual place, with or without a comment). */
export function guessMapUrl(scriptUrl: string): string {
  const u = new URL(scriptUrl);
  return new URL(`${u.pathname}.map`, u.origin).href;
}

// ---------- reading the map ----------

export interface MapSource {
  /** Position in the flattened list (0-based). */
  index: number;
  /** Which section of an indexed map it came from; null for a plain map. */
  section: number | null;
  /** The name with sourceRoot applied: what the tree and the table show. */
  path: string;
  /** The name exactly as it is in `sources`. */
  original: string;
  /** The file itself, or null when the map does not carry it. */
  content: string | null;
  /** Size of the content in UTF-8 bytes (0 without content). */
  bytes: number;
  /** node_modules and bundler internals: kept, but only strong checks run on them by default. */
  dependency: boolean;
  lang: 'js' | 'html' | 'text';
}

export type MapWarning =
  | { code: 'version'; arg: string }
  | { code: 'sectionUrl'; arg: string }
  | { code: 'capped'; arg: string };

export interface ParsedMap {
  file: string | null;
  version: number | null;
  sourceRoot: string | null;
  sources: MapSource[];
  /** Sections of an indexed map (0 for a plain map). */
  sections: number;
  names: number;
  /** Length of the `mappings` string(s): the positions are not decoded, they are not needed. */
  mappingsChars: number;
  warnings: MapWarning[];
}

const MAX_SOURCES = 50_000;
const MAX_DEPTH = 4;

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export function isDependency(path: string): boolean {
  // Without the scheme and the project name: webpack://app/webpack/runtime/x -> webpack/runtime/x
  const rest = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i, '').replace(/^\.\//, '');
  return (
    /(^|\/)(?:node_modules|bower_components|jspm_packages)\//.test(path) ||
    /^(?:webpack\/(?:bootstrap|runtime)|\(webpack\)|external\b|multi\b)/.test(rest) ||
    /^(?:webpack|vite|rollup|parcel|browserify)\/(?:runtime|bootstrap|modulepreload)/i.test(path) ||
    /^vite\/|^\(webpack\)/.test(path) ||
    path.charCodeAt(0) === 0 // rollup's virtual modules start with a NUL character
  );
}

function sourceLang(path: string): MapSource['lang'] {
  const name = path.replace(/[?#].*$/, '').toLowerCase();
  if (/\.(?:html?|vue|svelte|astro|hbs|ejs|jsp|php|erb)$/.test(name)) return 'html';
  if (
    /\.(?:css|scss|sass|less|styl|md|markdown|txt|env|ya?ml|ini|toml|properties|conf|cfg|xml|svg|csv)$/.test(
      name,
    )
  )
    return 'text';
  if (/(^|\/)\.env[^/]*$/.test(name)) return 'text';
  return 'js';
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function joinRoot(root: string, source: string): string {
  if (!root || source === '' || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('/'))
    return source;
  return root.endsWith('/') ? root + source : `${root}/${source}`;
}

/** True when the text, once a leading XSSI guard is removed, parses as a JSON object. */
export function parseMapJson(text: string): Record<string, unknown> {
  // Servers may prefix a map with )]}' so that it cannot be loaded as a script.
  const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a byte order mark
  const body = unmarked.replace(/^\)\]\}'[^\n]*\n/, '');
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new ToolError(
      T('error.mapJson', { message: e instanceof Error ? e.message : String(e) }),
    );
  }
  if (!isObject(json) || (!Array.isArray(json.sources) && !Array.isArray(json.sections))) {
    throw new ToolError(T('error.notMap'));
  }
  return json;
}

export function parseSourceMap(text: string): ParsedMap {
  const top = parseMapJson(text);
  const out: ParsedMap = {
    file: typeof top.file === 'string' ? top.file : null,
    version: typeof top.version === 'number' ? top.version : null,
    sourceRoot: typeof top.sourceRoot === 'string' && top.sourceRoot ? top.sourceRoot : null,
    sources: [],
    sections: Array.isArray(top.sections) ? top.sections.length : 0,
    names: 0,
    mappingsChars: 0,
    warnings: [],
  };
  if (out.version !== 3) out.warnings.push({ code: 'version', arg: String(top.version ?? '?') });

  const walk = (map: Record<string, unknown>, section: number | null, depth: number) => {
    if (typeof map.mappings === 'string') out.mappingsChars += map.mappings.length;
    if (Array.isArray(map.names)) out.names += map.names.length;
    if (Array.isArray(map.sections) && depth < MAX_DEPTH) {
      map.sections.forEach((s: unknown, i: number) => {
        if (!isObject(s)) return;
        if (isObject(s.map)) walk(s.map, section ?? i, depth + 1);
        else if (typeof s.url === 'string') out.warnings.push({ code: 'sectionUrl', arg: s.url });
      });
    }
    const sources = Array.isArray(map.sources) ? (map.sources as unknown[]) : [];
    const contents = Array.isArray(map.sourcesContent) ? (map.sourcesContent as unknown[]) : [];
    const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
    for (let i = 0; i < sources.length; i++) {
      if (out.sources.length >= MAX_SOURCES) {
        if (!out.warnings.some((w) => w.code === 'capped')) {
          out.warnings.push({ code: 'capped', arg: String(MAX_SOURCES) });
        }
        return;
      }
      const original = typeof sources[i] === 'string' ? (sources[i] as string) : '';
      const path = joinRoot(root, original);
      const c = contents[i];
      const content = typeof c === 'string' ? c : null;
      out.sources.push({
        index: out.sources.length,
        section,
        path,
        original,
        content,
        bytes: content === null ? 0 : utf8Length(content),
        dependency: isDependency(path),
        lang: sourceLang(path),
      });
    }
  };
  walk(top, null, 0);
  return out;
}

/** Quick test used to tell a map from other JSON before parsing it all. */
export function looksLikeMap(text: string): boolean {
  const head = text.slice(0, 20_000);
  return (
    /^\s*(?:\)\]\}'[^\n]*\n\s*)?\{/.test(head) &&
    /"(?:sources|sections)"\s*:/.test(text.slice(0, 2_000_000)) &&
    (/"version"\s*:\s*\d/.test(head) || /"mappings"\s*:/.test(text.slice(0, 2_000_000)))
  );
}

/** Most places a map can start that are tried in one text (each costs a JSON parse). */
const MAX_SPLIT_TRIES = 16;

/**
 * A script followed by its source map in the same box (the `.map` pasted under the bundle): the
 * script, and the map. The map starts at the beginning of a line, runs to the end of the text
 * and has to parse as a source map, so a script that only contains some JSON is never cut in two.
 * The places are tried from the end: the map is the last thing in the box.
 */
export function splitCombined(text: string): { code: string; map: string } | null {
  let tries = 0;
  for (
    let i = text.lastIndexOf('\n{');
    i >= 0 && tries < MAX_SPLIT_TRIES;
    i = i > 0 ? text.lastIndexOf('\n{', i - 1) : -1
  ) {
    tries++;
    let at = i + 1;
    // A )]}' guard line right above the brace belongs to the map.
    const above = text.lastIndexOf('\n', i - 1) + 1;
    if (text.startsWith(")]}'", above)) at = above;
    const code = text.slice(0, at);
    if (!code.trim()) continue;
    const rest = text.slice(at).trim();
    if (!looksLikeMap(rest)) continue;
    try {
      parseMapJson(rest);
    } catch (e) {
      if (e instanceof ToolError) continue;
      throw e;
    }
    return { code, map: rest };
  }
  return null;
}

// ---------- layout ----------

/**
 * `webpack://app/./src/App.js` -> [`webpack://`, `app`, `src`, `App.js`]. Without a project name
 * the root keeps its third slash: `webpack:///./src/a.js` -> [`webpack:///`, `src`, `a.js`].
 */
export function pathParts(path: string): string[] {
  const parts: string[] = [];
  let rest = path;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/\/?/.exec(rest);
  if (scheme) {
    parts.push(scheme[0]);
    rest = rest.slice(scheme[0].length);
  }
  for (const seg of rest.split('/')) if (seg !== '' && seg !== '.') parts.push(seg);
  return parts;
}

interface Node {
  name: string;
  dirs: Map<string, Node>;
  files: { name: string; source: MapSource }[];
}

const newNode = (name: string): Node => ({ name, dirs: new Map(), files: [] });

/** The paths as an ASCII tree, one line per entry; `describe` adds text after a file name. */
export function drawTree(
  sources: MapSource[],
  describe: (s: MapSource) => string,
  maxLines = 1500,
): { lines: string[]; cut: number } {
  const root = newNode('');
  for (const s of sources) {
    const parts = pathParts(s.path);
    if (!parts.length) parts.push(`(source ${s.index})`);
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (!next) node.dirs.set(dir, (next = newNode(dir)));
      node = next;
    }
    const base = parts[parts.length - 1]!;
    const taken = node.files.some((f) => f.name === base) || node.dirs.has(base);
    node.files.push({ name: taken ? `${base} (#${s.index})` : base, source: s });
  }
  const lines: string[] = [];
  let total = 0;
  const emit = (line: string) => {
    total++;
    if (lines.length < maxLines) lines.push(line);
  };
  const walk = (node: Node, prefix: string) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const count = dirs.length + files.length;
    let i = 0;
    for (const d of dirs) {
      // A directory whose only content is another directory is written on one line: a/b/c/.
      let dir = d;
      let name = d.name;
      while (dir.dirs.size === 1 && dir.files.length === 0) {
        dir = [...dir.dirs.values()][0]!;
        name += name.endsWith('/') ? dir.name : `/${dir.name}`;
      }
      const last = ++i === count;
      emit(`${prefix}${last ? '└─ ' : '├─ '}${name}/`);
      walk(dir, prefix + (last ? '   ' : '│  '));
    }
    for (const f of files) {
      const last = ++i === count;
      emit(`${prefix}${last ? '└─ ' : '├─ '}${f.name}${describe(f.source)}`);
    }
  };
  walk(root, '');
  return { lines, cut: Math.max(0, total - lines.length) };
}

/** A name segment without characters that are unsafe in a file name. */
function cleanSegment(seg: string): string {
  let out = '';
  for (const ch of seg) {
    out += ch.codePointAt(0)! < 32 || '\\:*?"<>|'.includes(ch) ? '_' : ch;
  }
  return out;
}

/** A path that is safe inside a zip: no scheme, no `..`, no odd characters. */
export function safePath(source: MapSource): string {
  const parts = pathParts(source.path).map((p, i) => {
    if (p === '..') return '_up';
    return cleanSegment(i === 0 ? p.replace(/^([a-z][a-z0-9+.-]*):\/\/\/?$/i, '$1') : p);
  });
  return parts.filter(Boolean).join('/') || `source-${source.index}`;
}

/** Every source that has content, in one zip (paths made safe, repeated names told apart). */
export function zipSources(sources: MapSource[]): { zip: Uint8Array; files: number } | null {
  const files: Record<string, Uint8Array> = {};
  let n = 0;
  for (const s of sources) {
    if (s.content === null) continue;
    let name = safePath(s);
    if (name in files) name = `${name}.${s.index}`;
    files[name] = utf8Encode(s.content);
    n++;
  }
  if (!n) return null;
  // A fixed date keeps the zip identical for the same map.
  return { zip: zipSync(files, { level: 4, mtime: Date.UTC(1980, 0, 1, 12) }), files: n };
}

/** The last path segment (without a query), for a download name. */
export function baseName(source: MapSource): string {
  const parts = pathParts(source.path);
  const last = (parts[parts.length - 1] ?? '').replace(/[?#].*$/, '');
  return cleanSegment(last) || `source-${source.index}.txt`;
}
