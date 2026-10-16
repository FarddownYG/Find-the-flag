import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../core/errors';
import {
  PROXIES,
  fetchViaProxies,
  isBareUrl,
  isPrivateHost,
  parseTargetUrl,
  resetFetchMemory,
  takeRefresh,
  type FetchEnv,
  type ProxyId,
} from './_web-source-fetch';

const TARGET = 'https://ctf.example.test/static/app.js';
const ALL: ProxyId[] = ['allorigins', 'corsproxy', 'codetabs'];

interface Call {
  url: string;
  init: RequestInit;
}

/** A stand-in for the network: answers by proxy host, and records every request. */
function network(answers: Partial<Record<string, () => Response | Promise<Response>>>) {
  const calls: Call[] = [];
  const env: Partial<FetchEnv> = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const answer = answers[new URL(url).host];
      if (!answer) throw new TypeError('Failed to fetch');
      return answer();
    },
  };
  return { calls, env };
}
const text =
  (body: string, status = 200) =>
  () =>
    new Response(body, { status });

beforeEach(() => resetFetchMemory());
afterEach(() => vi.unstubAllGlobals());

describe('the proxies', () => {
  it('are the three of the page CSP, in the documented order, with the documented URL shapes', () => {
    expect(PROXIES.map((p) => p.id)).toEqual(ALL);
    const target = 'https://ctf.example.test/a b?x=1&y=2#frag';
    const enc = encodeURIComponent(target);
    expect(PROXIES.map((p) => p.build(target))).toEqual([
      `https://api.allorigins.win/raw?url=${enc}`,
      `https://corsproxy.io/?url=${enc}`,
      `https://api.codetabs.com/v1/proxy?quest=${enc}`,
    ]);
  });

  it('can only be reached on their own origin, whatever the target is', () => {
    for (const p of PROXIES) {
      for (const target of [
        'https://a.test/',
        'http://evil.test@good.test/',
        'https://x.test/?u=https://y.test',
        'https://x.test/\\@y.test',
      ]) {
        expect(new URL(p.build(target)).origin, `${p.id} ${target}`).toBe(p.origin);
      }
    }
  });

  it('match connect-src in index.html exactly', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)![1]!;
    const connect = csp
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .find((d) => d[0] === 'connect-src')!;
    expect(connect.slice(1)).toEqual(["'self'", ...PROXIES.map((p) => p.origin)]);
    expect(connect.join(' ')).not.toMatch(/\*/);
  });
});

describe('fetchViaProxies: one request per proxy, in order', () => {
  it('stops at the first proxy that answers', async () => {
    const net = network({
      'api.allorigins.win': text('var a=1;'),
      'corsproxy.io': text('never asked'),
    });
    const r = await fetchViaProxies({ target: TARGET, enabled: ALL, env: net.env });
    expect(r).toMatchObject({ ok: true, text: 'var a=1;', via: 'allorigins', cached: false });
    expect(net.calls.map((c) => new URL(c.url).host)).toEqual(['api.allorigins.win']);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ proxy: 'allorigins', ok: true, status: 200, bytes: 8 });
  });

  it('falls through on a network error, a non-2xx answer and an empty body, and says why', async () => {
    const net = network({
      // allorigins is not in the table at all: fetch rejects, as a blocked or refused request does.
      'corsproxy.io': text('Too Many Requests', 429),
      'api.codetabs.com': text('   \n '),
    });
    const r = await fetchViaProxies({ target: TARGET, enabled: ALL, env: net.env });
    expect(r.ok).toBe(false);
    expect(r.attempts.map((a) => [a.proxy, a.ok, a.reason, a.status])).toEqual([
      ['allorigins', false, 'network', null],
      ['corsproxy', false, 'http', 429],
      ['codetabs', false, 'empty', 200],
    ]);
  });

  it('succeeds on a later proxy and lists the failures before it', async () => {
    const net = network({
      'api.allorigins.win': text('', 200),
      'corsproxy.io': text('<html>page</html>'),
    });
    const r = await fetchViaProxies({ target: TARGET, enabled: ALL, env: net.env });
    expect(r).toMatchObject({ ok: true, via: 'corsproxy', text: '<html>page</html>' });
    expect(r.attempts.map((a) => [a.proxy, a.ok, a.reason])).toEqual([
      ['allorigins', false, 'empty'],
      ['corsproxy', true, null],
    ]);
    expect(net.calls).toHaveLength(2);
  });

  it('gives up on a proxy that does not answer within the timeout', async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const t0 = performance.now();
    const r = await fetchViaProxies({
      target: TARGET,
      enabled: ['allorigins'],
      env: { fetch: hang, timeoutMs: 40 },
    });
    expect(r.ok).toBe(false);
    expect(r.attempts[0]).toMatchObject({ reason: 'timeout', ok: false });
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('times out while the body is still arriving', async () => {
    const slow = (_url: string, init: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial'));
              init.signal!.addEventListener('abort', () =>
                controller.error(new DOMException('aborted', 'AbortError')),
              );
            },
          }),
        ),
      );
    const r = await fetchViaProxies({
      target: TARGET,
      enabled: ['corsproxy'],
      env: { fetch: slow, timeoutMs: 40 },
    });
    expect(r.attempts[0]).toMatchObject({ reason: 'timeout' });
  });

  it('refuses an answer over the size limit, declared or streamed', async () => {
    const declared = () => new Response('x', { headers: { 'content-length': '5000' } });
    const r1 = await fetchViaProxies({
      target: TARGET,
      enabled: ['allorigins'],
      env: { fetch: async () => declared(), maxBytes: 100 },
    });
    expect(r1.attempts[0]).toMatchObject({ reason: 'tooLarge' });
    const streamed = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(64).fill(65));
          },
        }),
      );
    const r2 = await fetchViaProxies({
      target: TARGET,
      enabled: ['allorigins'],
      env: { fetch: async () => streamed(), maxBytes: 200 },
    });
    expect(r2.attempts[0]).toMatchObject({ reason: 'tooLarge' });
  });

  it('asks the way the page promises: GET, no credentials, no referrer, no cache, no extra headers', async () => {
    const net = network({ 'api.allorigins.win': text('ok') });
    await fetchViaProxies({ target: `${TARGET}#fragment`, enabled: ALL, env: net.env });
    const { url, init } = net.calls[0]!;
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'follow',
    });
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(url).toBe(
      `https://api.allorigins.win/raw?url=${encodeURIComponent(`${TARGET}#fragment`)}`,
    );
  });

  it('uses only the proxies left switched on, and the preferred one first', async () => {
    const net = network({ 'corsproxy.io': text('c'), 'api.codetabs.com': text('d') });
    const r = await fetchViaProxies({
      target: TARGET,
      enabled: ['codetabs', 'corsproxy'],
      prefer: 'codetabs',
      env: net.env,
    });
    expect(r).toMatchObject({ ok: true, via: 'codetabs' });
    expect(net.calls.map((c) => new URL(c.url).host)).toEqual(['api.codetabs.com']);
    const none = await fetchViaProxies({ target: `${TARGET}2`, enabled: [], env: net.env });
    expect(none).toMatchObject({ ok: false, attempts: [] });
  });
});

describe('what is kept in memory', () => {
  it('answers a repeated request from memory, without a request', async () => {
    const net = network({ 'api.allorigins.win': text('first') });
    await fetchViaProxies({ target: TARGET, enabled: ALL, env: net.env });
    const again = await fetchViaProxies({ target: TARGET, enabled: ALL, env: net.env });
    expect(again).toMatchObject({ ok: true, text: 'first', cached: true });
    expect(net.calls).toHaveLength(1);
  });

  it('keeps a failure too, so that a replay does not call the proxies again', async () => {
    const net = network({});
    await fetchViaProxies({ target: TARGET, enabled: ALL, env: net.env });
    expect(net.calls).toHaveLength(3);
    const again = await fetchViaProxies({ target: TARGET, enabled: ALL, env: net.env });
    expect(again).toMatchObject({ ok: false, cached: true });
    expect(net.calls).toHaveLength(3);
  });

  it('asks again when told to, when the proxies chosen change, or for another address', async () => {
    const net = network({ 'api.allorigins.win': text('v1'), 'corsproxy.io': text('v2') });
    await fetchViaProxies({ target: TARGET, enabled: ALL, env: net.env });
    const forced = await fetchViaProxies({
      target: TARGET,
      enabled: ALL,
      bypass: true,
      env: net.env,
    });
    expect(forced).toMatchObject({ cached: false });
    expect(net.calls).toHaveLength(2);
    await fetchViaProxies({ target: TARGET, enabled: ['corsproxy'], env: net.env });
    await fetchViaProxies({ target: `${TARGET}?v=2`, enabled: ALL, env: net.env });
    expect(net.calls).toHaveLength(4);
  });

  it('gives each "Fetch again" token one use', () => {
    expect(takeRefresh('')).toBe(false);
    expect(takeRefresh('0')).toBe(false);
    expect(takeRefresh('1')).toBe(true);
    expect(takeRefresh('1')).toBe(false); // a replay of the same click
    expect(takeRefresh('2')).toBe(true);
  });

  it('forgets the oldest answers', async () => {
    const net = network({ 'api.allorigins.win': text('x') });
    for (let i = 0; i < 8; i++)
      await fetchViaProxies({ target: `${TARGET}?n=${i}`, enabled: ALL, env: net.env });
    const before = net.calls.length;
    await fetchViaProxies({ target: `${TARGET}?n=7`, enabled: ALL, env: net.env });
    expect(net.calls.length).toBe(before); // recent: still in memory
    await fetchViaProxies({ target: `${TARGET}?n=0`, enabled: ALL, env: net.env });
    expect(net.calls.length).toBe(before + 1); // old: asked again
  });
});

describe('the address the user types', () => {
  it('accepts an http or https URL and drops the fragment', () => {
    expect(parseTargetUrl('https://ctf.example.test/a.js#top').href).toBe(
      'https://ctf.example.test/a.js',
    );
    expect(parseTargetUrl('  http://ctf.example.test:8080/x?y=1 \n').href).toBe(
      'http://ctf.example.test:8080/x?y=1',
    );
    expect(parseTargetUrl('https://bücher.example/a.js').hostname).toBe('xn--bcher-kva.example');
  });

  it('says what is wrong with anything else', () => {
    const msg = (s: string) => {
      try {
        parseTargetUrl(s);
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        return (e as Error).message;
      }
      throw new Error(`accepted: ${s}`);
    };
    expect(msg('')).toMatch(/Type the address/);
    expect(msg('example.test/app.js')).toMatch(/not a valid URL/);
    expect(msg('https://a.test/x y')).toMatch(/one address at a time/);
    expect(msg('ftp://a.test/x')).toMatch(/Only http and https.*ftp/);
    expect(msg('file:///etc/passwd')).toMatch(/Only http and https.*file/);
    expect(msg('javascript:alert(1)')).toMatch(/Only http and https.*javascript/);
    expect(msg('data:text/html,hi')).toMatch(/Only http and https.*data/);
    expect(msg('https://user:pw@a.test/x')).toMatch(/user name or password/);
    expect(msg(`https://a.test/${'x'.repeat(2100)}`)).toMatch(/longer than 2048/);
  });

  it('refuses private and local addresses: a public proxy cannot reach them', () => {
    for (const host of [
      'localhost',
      'intranet',
      'app.local',
      'svc.internal',
      'printer.lan',
      '127.0.0.1',
      '127.8.8.8',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '[::1]',
      '[fd00::1]',
      '[fe80::1]',
      '[::ffff:7f00:1]',
      '2130706433',
    ]) {
      expect(() => parseTargetUrl(`http://${host}/x`), host).toThrow(/private or local address/);
    }
    for (const host of [
      'example.test',
      '8.8.8.8',
      '172.32.0.1',
      '192.169.0.1',
      'sub.domain.example.org',
      '[2001:db8::1]',
    ]) {
      expect(isPrivateHost(new URL(`http://${host}/`).hostname), host).toBe(false);
    }
  });

  it('knows a bare URL from a sentence that contains one', () => {
    expect(isBareUrl('https://a.test/app.js')).toBe(true);
    expect(isBareUrl('  http://a.test  \n')).toBe(true);
    expect(isBareUrl('see https://a.test/app.js for details')).toBe(false);
    expect(isBareUrl('https://a.test/a\nhttps://a.test/b')).toBe(false);
    expect(isBareUrl('var u = "https://a.test";')).toBe(false);
  });
});

describe('no request is made until a run asks for one', () => {
  it('loading the modules does not touch the network', async () => {
    vi.resetModules();
    const spy = vi.fn(() => Promise.reject(new Error('the network must not be used')));
    vi.stubGlobal('fetch', spy);
    await import('./_web-source-fetch');
    await import('./_web-source-run');
    await import('./_web-source-report');
    const tool = (await import('./web-source')).default;
    expect(tool.id).toBe('web-source');
    expect(spy).not.toHaveBeenCalled();
  });
});
