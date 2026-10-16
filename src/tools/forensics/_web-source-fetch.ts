/**
 * URL mode of the Web source analyzer: fetch ONE page or file that the user named, through a
 * public CORS proxy, because a browser cannot read another site's response directly.
 *
 * Rules this file keeps, and web-source.test.ts proves:
 *  - nothing is requested at import time or by merely opening the tool: a request is made only by
 *    a run in URL mode, which is a press on Run;
 *  - a request can only go to the three origins of PROXIES (the same three as `connect-src` in
 *    index.html). The check is here as well as in the page's CSP, because a tool runs in a Web
 *    Worker, and a worker is not bound by the page's CSP;
 *  - only http(s) URLs, with no credentials, no fragment and no private address;
 *  - credentials 'omit', no referrer, no cache, 15 s per proxy, a size limit, one URL per fetch;
 *  - what was fetched (or why it failed) is kept in memory for the session, so that running the
 *    tool again with the same input (a settings change, coming back to the page) does not call
 *    the proxies again: "Fetch again" is an explicit button.
 */
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { concatBytes } from '../../lib/bytes';

const T = toolT('web-source');

export type ProxyId = 'allorigins' | 'corsproxy' | 'codetabs';

export interface Proxy {
  id: ProxyId;
  /** Shown to the user. */
  label: string;
  /** The only origin a request for this proxy may go to. */
  origin: string;
  build(target: string): string;
}

/** In the order they are tried. Keep in sync with `connect-src` in index.html. */
export const PROXIES: readonly Proxy[] = [
  {
    id: 'allorigins',
    label: 'allorigins.win',
    origin: 'https://api.allorigins.win',
    build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  },
  {
    id: 'corsproxy',
    label: 'corsproxy.io',
    origin: 'https://corsproxy.io',
    build: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  },
  {
    id: 'codetabs',
    label: 'codetabs.com',
    origin: 'https://api.codetabs.com',
    build: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  },
];

export const TIMEOUT_MS = 15_000;
export const MAX_BYTES = 40 * 1024 * 1024;

export type FailReason = 'network' | 'http' | 'timeout' | 'empty' | 'tooLarge';

export interface Attempt {
  proxy: ProxyId;
  ok: boolean;
  status: number | null;
  reason: FailReason | null;
  bytes: number;
  ms: number;
}

export interface Fetched {
  ok: true;
  text: string;
  via: ProxyId;
  attempts: Attempt[];
  /** Served from memory: no request was made. */
  cached: boolean;
}

export interface FetchFailed {
  ok: false;
  attempts: Attempt[];
  cached: boolean;
}

export type Outcome = Fetched | FetchFailed;

export interface FetchEnv {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs: number;
  maxBytes: number;
  now: () => number;
}

const defaultEnv = (): FetchEnv => ({
  fetch: (input, init) => globalThis.fetch(input, init),
  timeoutMs: TIMEOUT_MS,
  maxBytes: MAX_BYTES,
  now: () => performance.now(),
});

// ---------- the URL the user typed ----------

/** Names that only exist on a private network, or addresses no public proxy can reach. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1);
    return (
      v6 === '::1' ||
      v6 === '::' ||
      /^f[cd]/.test(v6) ||
      /^fe[89ab]/.test(v6) ||
      v6.startsWith('::ffff:') ||
      v6.startsWith('64:ff9b')
    );
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (!h.includes('.')) return true; // a single-label name only exists on a private network
  return /\.(?:localhost|local|internal|lan|home|corp|intranet|home\.arpa)$/.test(h);
}

/** One http(s) URL, or a ToolError that says what is wrong. Fragments are dropped. */
export function parseTargetUrl(input: string): URL {
  const s = input.trim();
  if (!s) throw new ToolError(T('error.urlEmpty'));
  if (/\s/.test(s)) throw new ToolError(T('error.urlOne'));
  if (s.length > 2048) throw new ToolError(T('error.urlLong'));
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new ToolError(T('error.urlInvalid', { url: s.slice(0, 80) }));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError(T('error.urlScheme', { scheme: url.protocol.replace(/:$/, '') }));
  }
  if (url.username || url.password) throw new ToolError(T('error.urlCredentials'));
  if (isPrivateHost(url.hostname))
    throw new ToolError(T('error.urlPrivate', { host: url.hostname }));
  url.hash = '';
  return url;
}

/** Whether the whole input is a single http(s) URL (Auto mode offers URL mode instead of fetching). */
export function isBareUrl(input: string): boolean {
  const s = input.trim();
  return /^https?:\/\/\S+$/i.test(s) && s.length <= 2048;
}

// ---------- one request ----------

async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.length > max ? null : all;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return concatBytes(...chunks);
}

async function attemptOne(
  proxy: Proxy,
  target: string,
  env: FetchEnv,
): Promise<{ attempt: Attempt; text?: string }> {
  const url = proxy.build(target);
  if (new URL(url).origin !== proxy.origin) {
    throw new Error(`Refusing a request outside ${proxy.origin}`);
  }
  const t0 = env.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, env.timeoutMs);
  const failed = (reason: FailReason, status: number | null = null) => ({
    attempt: {
      proxy: proxy.id,
      ok: false,
      status,
      reason,
      bytes: 0,
      ms: Math.round(env.now() - t0),
    },
  });
  try {
    const res = await env.fetch(url, {
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'follow',
      mode: 'cors',
      signal: controller.signal,
    });
    if (!res.ok) {
      controller.abort(); // close the connection: the body is not wanted
      return failed('http', res.status);
    }
    const bytes = await readLimited(res, env.maxBytes);
    if (bytes === null) {
      controller.abort();
      return failed('tooLarge', res.status);
    }
    const text = new TextDecoder('utf-8').decode(bytes); // a byte order mark is dropped
    if (!text.trim()) return failed('empty', res.status);
    return {
      attempt: {
        proxy: proxy.id,
        ok: true,
        status: res.status,
        reason: null,
        bytes: bytes.length,
        ms: Math.round(env.now() - t0),
      },
      text,
    };
  } catch {
    // A browser reports a refused, blocked or unreachable request only as a TypeError.
    return failed(timedOut ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

// ---------- the proxies, in order, with a memory ----------

const MAX_CACHED = 6;
const MAX_CACHED_CHARS = 48 * 1024 * 1024;
const memory = new Map<string, Outcome>();
const usedRefresh = new Set<string>();

const sizeOf = (o: Outcome) => (o.ok ? o.text.length : 0);

function remember(key: string, outcome: Outcome): void {
  memory.delete(key);
  memory.set(key, outcome);
  let chars = 0;
  for (const o of memory.values()) chars += sizeOf(o);
  for (const k of memory.keys()) {
    if (memory.size <= MAX_CACHED && chars <= MAX_CACHED_CHARS) break;
    chars -= sizeOf(memory.get(k)!);
    memory.delete(k);
  }
}

/** Forget everything kept in memory (tests, and nothing else). */
export function resetFetchMemory(): void {
  memory.clear();
  usedRefresh.clear();
}

/**
 * "Fetch again" writes a new token into the tool's options; the first run to see a token asks
 * the proxies again, later runs with the same token (a replay) use what is in memory.
 */
export function takeRefresh(token: string): boolean {
  const t = token.trim();
  if (!t || t === '0' || usedRefresh.has(t)) return false;
  usedRefresh.add(t);
  return true;
}

export interface FetchRequest {
  /** The absolute http(s) URL to fetch. */
  target: string;
  /** Proxies the user left switched on, whatever their order here. */
  enabled: readonly ProxyId[];
  /** Tried first: the proxy that worked for the previous request of this run. */
  prefer?: ProxyId | null;
  /** Ask the proxies again even if the answer is in memory. */
  bypass?: boolean;
  env?: Partial<FetchEnv>;
}

/**
 * Fetch `target`, trying the enabled proxies in order and falling through on a network error,
 * a non-2xx answer, a timeout, an empty body or a body over the size limit. Every attempt is
 * reported, so the page can say which proxy worked and why the earlier ones did not.
 */
export async function fetchViaProxies(req: FetchRequest): Promise<Outcome> {
  const key = `${[...req.enabled].sort().join(',')}|${req.target}`;
  const kept = memory.get(key);
  if (kept && !req.bypass) return { ...kept, cached: true };
  let list = PROXIES.filter((p) => req.enabled.includes(p.id));
  const first = list.find((p) => p.id === req.prefer);
  if (first) list = [first, ...list.filter((p) => p !== first)];
  const env = { ...defaultEnv(), ...req.env };
  const attempts: Attempt[] = [];
  for (const proxy of list) {
    const { attempt, text } = await attemptOne(proxy, req.target, env);
    attempts.push(attempt);
    if (attempt.ok && text !== undefined) {
      const outcome: Fetched = { ok: true, text, via: proxy.id, attempts, cached: false };
      remember(key, outcome);
      return outcome;
    }
  }
  const outcome: FetchFailed = { ok: false, attempts, cached: false };
  remember(key, outcome);
  return outcome;
}
