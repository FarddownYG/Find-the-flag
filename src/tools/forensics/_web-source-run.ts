/**
 * The Web source analyzer's pipeline, from the input to the findings:
 *
 *   input (pasted text, or the one URL to fetch)  ->  what it is (page, script, source map, …)
 *   ->  the source map it points to, if any (inline data: URI, external file, or the usual
 *   `<script>.map` address)  ->  every document to read (the input, and every sourcesContent of
 *   the map)  ->  the secret hunter.
 *
 * The network is used in one place only: URL mode, which a run in URL mode reaches by the user's
 * own press on Run. Pasted text is never sent anywhere.
 */
import { ToolError } from '../../core/errors';
import type { FileInput } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { utf8Decode } from '../../lib/bytes';
import {
  fetchViaProxies,
  isBareUrl,
  parseTargetUrl,
  PROXIES,
  takeRefresh,
  type Outcome,
  type ProxyId,
} from './_web-source-fetch';
import {
  looksLikeAppShell,
  parseHtml,
  references,
  regions,
  type Parsed,
  type Reference,
} from './_web-source-html';
import {
  findMapRef,
  guessMapUrl,
  looksLikeMap,
  parseSourceMap,
  resolveRef,
  splitCombined,
  type MapRef,
  type MapSource,
  type ParsedMap,
} from './_web-source-map';
import { scanDocs, type ScanDoc, type ScanResult } from './_web-source-secrets';

const T = toolT('web-source');

export type InputType = 'map' | 'html' | 'js' | 'css' | 'text';

export interface Opts {
  source: 'auto' | 'paste' | 'url';
  map: FileInput | null;
  allorigins: boolean;
  corsproxy: boolean;
  codetabs: boolean;
  guess: boolean;
  deps: boolean;
  open: string;
  /** "Fetch again" counter (see takeRefresh). */
  refresh: string;
}

export interface NetworkEntry {
  what: 'page' | 'map' | 'guess';
  url: string;
  outcome: Outcome;
}

export type MapState =
  /** No reference in the input. `guessed`: the usual address that was tried (URL mode) and failed. */
  | { status: 'none'; guessed: string | null }
  /** A reference was found but the map was not loaded (paste mode, or a relative reference). */
  | { status: 'pending'; ref: string; why: 'paste' | 'relative' | 'scheme' | 'invalid' }
  | {
      status: 'loaded';
      via: 'input' | 'pasted' | 'file' | 'inline' | 'url' | 'guess';
      ref: string | null;
      url: string | null;
      fileName: string | null;
      map: ParsedMap;
    }
  | { status: 'failed'; why: 'fetch' | 'parse' | 'inline'; ref: string | null; detail: string };

export interface Analysis {
  type: InputType;
  origin: 'paste' | 'url';
  /** The URL that was fetched (URL mode). */
  url: string | null;
  text: string;
  lines: number;
  /** The input was not a single URL in URL mode: it was read as pasted text. */
  urlModeText: boolean;
  /** A map file was given but the map is part of the input (pasted): the file was not used. */
  ignoredMapFile: boolean;
  network: NetworkEntry[];
  map: MapState;
  html: { refs: Reference[]; parsed: Parsed; shell: boolean } | null;
  docs: ScanDoc[];
  /** The map source each document came from (null for the input itself), parallel to docs. */
  docSources: (MapSource | null)[];
  scan: ScanResult;
}

export type RunResult =
  /** Auto mode and the input is only a URL: nothing is requested, the page offers URL mode. */
  | { stage: 'suggest-url'; url: string }
  /** URL mode and no proxy returned the page. */
  | { stage: 'fetch-failed'; url: string; network: NetworkEntry[] }
  | { stage: 'done'; analysis: Analysis };

// ---------- what the input is ----------

/** Page, script, source map, stylesheet or other text, from its first characters. */
export function classify(text: string): InputType {
  if (looksLikeMap(text)) return 'map';
  const head = text.slice(0, 20_000).trimStart();
  // A page, or a piece of one (a tag, a comment, an end tag): it starts with "<".
  if (/^<(?:!--|!doctype\b|\/?[a-z][\w-]*[\s>/])/i.test(head)) return 'html';
  if (/^\/\*#\s*sourceMappingURL=/m.test(text.slice(-1024)) && !/\bfunction\b|=>/.test(head))
    return 'css';
  if (/^[[{]/.test(head)) return 'js'; // JSON-ish: its strings are read like a script's
  const js =
    /\b(?:function\s*[\w$]*\s*\(|const\s|let\s|var\s|import\s[^;]*from|export\s|require\(|module\.exports|document\.|window\.|console\.)|=>|!function\(|\(\(\)=>/.test(
      head,
    );
  if (js) return 'js';
  if (
    /[^{}]+\{\s*[\w-]+\s*:[^{}]*\}/.test(head) &&
    !/[;{]\s*(?:var|let|const|function)\b/.test(head)
  ) {
    return 'css';
  }
  return 'text';
}

/** The text in the box is meant as a URL (one line, no spaces), as opposed to pasted content. */
function looksLikeUrlAttempt(input: string): boolean {
  const s = input.trim();
  return s.length > 0 && s.length <= 2048 && !/\s/.test(s);
}

const countLines = (text: string): number => {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
};

// ---------- the source map ----------

interface Ctx {
  o: Opts;
  /** A map pasted under the script, in the same box. */
  pasted: string | null;
  type: InputType;
  pageUrl: string | null;
  network: NetworkEntry[];
  enabled: ProxyId[];
  bypass: boolean;
  prefer: ProxyId | null;
}

function parsedOrFailed(
  text: string,
  base: Omit<Extract<MapState, { status: 'loaded' }>, 'status' | 'map'>,
  failRef: string | null,
): MapState {
  try {
    return { status: 'loaded', ...base, map: parseSourceMap(text) };
  } catch (e) {
    if (e instanceof ToolError)
      return { status: 'failed', why: 'parse', ref: failRef, detail: e.message };
    throw e;
  }
}

async function fetchMap(
  ctx: Ctx,
  url: string,
  what: 'map' | 'guess',
  ref: string | null,
): Promise<MapState> {
  try {
    parseTargetUrl(url); // the same rules as for the page: no private address, no credentials
  } catch (e) {
    if (e instanceof ToolError) return { status: 'failed', why: 'fetch', ref, detail: e.message };
    throw e;
  }
  const outcome = await fetchViaProxies({
    target: url,
    enabled: ctx.enabled,
    prefer: ctx.prefer,
    bypass: ctx.bypass,
  });
  ctx.network.push({ what, url, outcome });
  if (!outcome.ok) {
    return what === 'guess'
      ? { status: 'none', guessed: url }
      : { status: 'failed', why: 'fetch', ref, detail: url };
  }
  const state = parsedOrFailed(
    outcome.text,
    { via: what === 'guess' ? 'guess' : 'url', ref, url, fileName: null },
    ref,
  );
  // A "map" that is not one (an HTML error page from a proxy) at the guessed address means: none.
  return what === 'guess' && state.status === 'failed' ? { status: 'none', guessed: url } : state;
}

async function loadMap(ctx: Ctx, ref: MapRef | null): Promise<MapState> {
  const { o } = ctx;
  const refText = ref?.kind === 'external' ? ref.ref : null;
  if (ctx.pasted !== null) {
    return parsedOrFailed(
      ctx.pasted,
      { via: 'pasted', ref: refText, url: null, fileName: null },
      refText,
    );
  }
  if (o.map) {
    return parsedOrFailed(
      utf8Decode(o.map.bytes),
      { via: 'file', ref: refText, url: null, fileName: o.map.name ?? null },
      refText,
    );
  }
  if (!ref) {
    if (o.source === 'url' && o.guess && ctx.pageUrl && ctx.type === 'js') {
      return fetchMap(ctx, guessMapUrl(ctx.pageUrl), 'guess', null);
    }
    return { status: 'none', guessed: null };
  }
  if (ref.kind === 'inline') {
    return parsedOrFailed(ref.json, { via: 'inline', ref: null, url: null, fileName: null }, null);
  }
  if (ref.kind === 'inline-bad') {
    return { status: 'failed', why: 'inline', ref: null, detail: ref.reason };
  }
  const resolved = resolveRef(ref.ref, ctx.pageUrl);
  if (!resolved.ok) return { status: 'pending', ref: ref.ref, why: resolved.reason };
  if (o.source !== 'url') return { status: 'pending', ref: ref.ref, why: 'paste' };
  return fetchMap(ctx, resolved.url, 'map', ref.ref);
}

/** The reference in a script, a stylesheet, or the inline scripts of a page. */
function findRef(type: InputType, text: string, parsed: Parsed | null): MapRef | null {
  if (type === 'html' && parsed) {
    let found: MapRef | null = null;
    for (const s of parsed.scripts) found = findMapRef(text.slice(s.start, s.end)) ?? found;
    return found;
  }
  return findMapRef(text);
}

// ---------- the whole run ----------

export async function analyze(input: string, o: Opts): Promise<RunResult> {
  if (!input.trim()) throw new ToolError(T('error.empty'));
  const network: NetworkEntry[] = [];
  const enabled = PROXIES.filter((p) => o[p.id]).map((p) => p.id);
  let text = input;
  let origin: Analysis['origin'] = 'paste';
  let pageUrl: string | null = null;
  let prefer: ProxyId | null = null;
  let bypass = false;
  let urlModeText = false;

  if (o.source === 'url') {
    if (looksLikeUrlAttempt(input)) {
      const target = parseTargetUrl(input);
      if (!enabled.length) throw new ToolError(T('error.noProxy'));
      bypass = takeRefresh(o.refresh);
      const outcome = await fetchViaProxies({ target: target.href, enabled, bypass });
      network.push({ what: 'page', url: target.href, outcome });
      if (!outcome.ok) return { stage: 'fetch-failed', url: target.href, network };
      text = outcome.text;
      origin = 'url';
      pageUrl = target.href;
      prefer = outcome.via;
    } else urlModeText = true;
  } else if (o.source === 'auto' && isBareUrl(input)) {
    return { stage: 'suggest-url', url: input.trim() };
  }

  let type = classify(text);
  // A script with its .map pasted under it: the map is read, the rest is the script.
  let pasted: string | null = null;
  if (type !== 'map' && origin === 'paste') {
    const combined = splitCombined(text);
    if (combined) {
      text = combined.code;
      pasted = combined.map;
      type = classify(text);
    }
  }
  const docs: ScanDoc[] = [];
  const docSources: (MapSource | null)[] = [];
  let html: Analysis['html'] = null;
  let map: MapState;
  let ignoredMapFile: boolean;

  if (type === 'map') {
    ignoredMapFile = o.map !== null;
    map = parsedOrFailed(text, { via: 'input', ref: null, url: pageUrl, fileName: null }, null);
    if (map.status === 'failed') throw new ToolError(map.detail);
  } else {
    let parsed: Parsed | null = null;
    if (type === 'html') {
      parsed = parseHtml(text);
      html = { parsed, refs: references(parsed), shell: looksLikeAppShell(text, parsed) };
      docs.push({ name: null, text, dependency: false, lang: 'html', html: regions(parsed) });
    } else {
      docs.push({
        name: null,
        text,
        dependency: false,
        lang: type === 'js' ? 'js' : 'text',
        css: type === 'css',
      });
    }
    docSources.push(null);
    map = await loadMap(
      { o, pasted, type, pageUrl, network, enabled, bypass, prefer },
      findRef(type, text, parsed),
    );
    ignoredMapFile = pasted !== null && o.map !== null;
  }

  if (map.status === 'loaded') {
    for (const s of map.map.sources) {
      if (s.content === null || s.content === '') continue;
      docs.push({
        name: s.path || `#${s.index}`,
        text: s.content,
        dependency: s.dependency,
        lang: s.lang,
        css: /\.(?:css|scss|sass|less|styl)(?:[?#].*)?$/i.test(s.path),
        html: s.lang === 'html' ? regions(parseHtml(s.content)) : undefined,
      });
      docSources.push(s);
    }
  }

  return {
    stage: 'done',
    analysis: {
      type,
      origin,
      url: pageUrl,
      text,
      lines: countLines(text),
      urlModeText,
      ignoredMapFile,
      network,
      map,
      html,
      docs,
      docSources,
      scan: scanDocs(docs, { deps: o.deps }),
    },
  };
}
