import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { expect, test, type Page, type Route } from '@playwright/test';

// The Web source analyzer through the real UI. Everything here is made-up sample data
// (public/samples/web-source-*), and the URL-mode tests use SIMULATED proxies: Playwright
// answers the three proxy origins itself and aborts every other request that is not the app's,
// so no request ever leaves the machine.

const samplePath = (name: string) =>
  fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url));
const sample = (name: string) => readFileSync(samplePath(name), 'utf8');
const BUNDLE = sample('web-source-bundle.js');
const BUNDLE_MAP = sample('web-source-bundle.js.map');
const INLINE = sample('web-source-inline.js');

const HIDDEN = 'webpack://demo-shop/./src/pages/Admin/SecretPanel.js';
const PROXY_HOSTS = ['api.allorigins.win', 'corsproxy.io', 'api.codetabs.com'];
const SITE = 'https://ctf.example.test/static/';

const out = (page: Page) => page.locator('.pane-out');
const run = (page: Page) => page.getByRole('button', { name: 'Run', exact: true }).click();
const input = (page: Page) => page.locator('.input-text');
const mode = (page: Page, name: 'Auto' | 'Paste' | 'URL') =>
  page.locator('.options').getByRole('button', { name, exact: true }).click();

/** Record page errors, console errors (CSP violations included) and every request that is not the app's. */
async function watch(page: Page, baseURL: string | undefined) {
  const origin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  const errors: string[] = [];
  const offsite: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.context().on('request', (r) => {
    const u = r.url();
    if (u.startsWith('blob:') || u.startsWith('data:')) return;
    if (new URL(u).origin !== origin) offsite.push(u);
  });
  return { errors, offsite };
}

type Answer = { status?: number; body?: string } | null;

/**
 * SIMULATED proxies. `answer(proxy, target)` says what each one returns (null: the request
 * fails, as a blocked or unreachable proxy does). Anything else leaving the app is aborted and
 * recorded in `stray`: it must stay empty.
 */
async function simulateProxies(
  page: Page,
  baseURL: string | undefined,
  answer: (proxy: string, target: string) => Answer,
) {
  const calls: [string, string][] = [];
  const stray: string[] = [];
  const origin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  await page.context().route('**/*', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'blob:' || url.protocol === 'data:' || url.origin === origin)
      return route.fallback();
    if (!PROXY_HOSTS.includes(url.host)) {
      stray.push(url.href);
      return route.abort();
    }
    const target = url.searchParams.get('url') ?? url.searchParams.get('quest') ?? '';
    calls.push([url.host, target]);
    const a = answer(url.host, target);
    if (!a) return route.abort('failed');
    return route.fulfill({
      status: a.status ?? 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'text/plain; charset=utf-8' },
      body: a.body ?? '',
    });
  });
  return { calls, stray };
}

test('paste a bundle: the map it names is found, its file is chosen, and the hidden file surfaces', async ({
  page,
  baseURL,
}) => {
  const w = await watch(page, baseURL);
  await page.goto('./#/tool/web-source');
  await input(page).fill(BUNDLE);
  await run(page);
  // Paste mode finds the reference but fetches nothing.
  await expect(out(page)).toContainText(
    'Named in the script, not loaded: web-source-bundle.js.map',
  );
  await expect(out(page)).toContainText('Nothing was requested.');

  // The .map file chosen in its option; the same script, run again.
  await page
    .locator('.options input[type=file]')
    .setInputFiles(samplePath('web-source-bundle.js.map'));
  await run(page);
  await expect(out(page)).toContainText('From the file web-source-bundle.js.map');
  await expect(out(page)).toContainText('7 (6 with content');

  // The tree of the paths, every source in the table, the finding with its source file.
  const tree = out(page).locator('.out-text', { hasText: 'Tree of the sources' });
  await expect(tree).toContainText('└─ webpack://demo-shop/');
  await expect(tree).toContainText('SecretPanel.js  184 B · findings: 1');
  const sources = out(page).locator('.out-table', { hasText: 'Sources in the map (7)' });
  await expect(sources.locator('tbody tr')).toHaveCount(7);
  const row = out(page).locator('.out-table tr', { hasText: 'TEST_FLAG_123' }).first();
  await expect(row).toContainText(`${HIDDEN}:2:12`);
  await expect(row).toContainText('Secret-like assignment');
  await expect(row).toContainText('name: secret (in a comment)');

  // The hidden file is open as text, with Copy and Download.
  const file = out(page).locator('.out-bytes', { hasText: `#4 ${HIDDEN}` });
  await expect(file.locator('pre')).toContainText('// secret: TEST_FLAG_123');
  await expect(file.getByRole('button', { name: 'Copy' })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    file.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('SecretPanel.js');
  expect(readFileSync(await download.path(), 'utf8')).toContain('// secret: TEST_FLAG_123');

  // Everything in one zip.
  const [zipDownload] = await Promise.all([
    page.waitForEvent('download'),
    out(page)
      .locator('.out-files li', { hasText: 'sources.zip' })
      .getByRole('button', { name: 'Download' })
      .click(),
  ]);
  const zipped = unzipSync(new Uint8Array(readFileSync(await zipDownload.path())));
  expect(Object.keys(zipped)).toHaveLength(6);
  expect(
    new TextDecoder().decode(zipped['webpack/demo-shop/src/pages/Admin/SecretPanel.js']),
  ).toContain('TEST_FLAG_123');

  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
  expect(baseURL).toBeTruthy();
});

test('the bundle and its .map pasted one under the other in the same box', async ({
  page,
  baseURL,
}) => {
  const w = await watch(page, baseURL);
  await page.goto('./#/tool/web-source');
  await input(page).fill(`${BUNDLE}\n${BUNDLE_MAP}`);
  await run(page);
  await expect(out(page)).toContainText('Pasted under the script, in the same box');
  await expect(out(page)).toContainText('7 (6 with content');
  const row = out(page).locator('.out-table tr', { hasText: 'TEST_FLAG_123' }).first();
  await expect(row).toContainText(`${HIDDEN}:2:12`);
  await expect(out(page)).not.toContainText('Nothing was requested.');
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('the Open option shows any source in full, by number or by part of its path', async ({
  page,
  baseURL,
}) => {
  await watch(page, baseURL);
  await page.goto('./#/tool/web-source');
  await input(page).fill(BUNDLE_MAP);
  await page.locator('#opt-web-source-open').fill('router');
  await run(page);
  await expect(out(page).locator('.out-bytes')).toHaveCount(1);
  await expect(out(page).locator('.out-bytes pre')).toContainText("// '/admin-panel': SecretPanel");
  await page.locator('#opt-web-source-open').fill('#5 nothing-here');
  await run(page);
  await expect(out(page).locator('.out-bytes')).toHaveCount(1);
  await expect(out(page).locator('.out-bytes')).toContainText('tiny-lib');
});

test('a source map inlined as a base64 data: URI is decoded and scanned', async ({
  page,
  baseURL,
}) => {
  const w = await watch(page, baseURL);
  await page.goto('./#/tool/web-source');
  await input(page).fill(INLINE);
  await run(page);
  await expect(out(page)).toContainText('Inlined in the script (data: URI)');
  const row = out(page).locator('.out-table tr', { hasText: 'INLINE_SECRET_456' }).first();
  await expect(row).toContainText('webpack:///./src/config.js:1:30');
  await expect(row).toContainText('name: adminPassword');
  await expect(out(page).locator('.out-text', { hasText: 'Tree of the sources' })).toContainText(
    'config.js  76 B',
  );
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('a .map pasted as it is lists every source and finds the same secret', async ({
  page,
  baseURL,
}) => {
  await watch(page, baseURL);
  await page.goto('./#/tool/web-source');
  await input(page).fill(BUNDLE_MAP);
  await run(page);
  await expect(out(page)).toContainText('The input is itself a source map');
  await expect(
    out(page).locator('.out-table tr', { hasText: 'TEST_FLAG_123' }).first(),
  ).toContainText(HIDDEN);
});

test('pasted HTML is shown as text, never rendered or run', async ({ page, baseURL }) => {
  const w = await watch(page, baseURL);
  const payload = '<img src=x onerror="window.__pwned=1">';
  const script = '</script><script>window.__pwned=2</script>';
  await page.goto('./#/tool/web-source');
  await input(page).fill(
    [
      '<!doctype html><html><body>',
      `<!-- ${payload} ${script} -->`,
      `<a href="${script}">link</a>`,
      '<a href="javascript:window.__pwned=3">js link</a>',
      `<script>var s = "${script.replace(/"/g, "'")}"; // the password is ${payload}</script>`,
      '</body></html>',
    ].join('\n'),
  );
  await run(page);
  await expect(out(page)).toContainText('References in the page');
  // The payloads are on the page as characters ...
  await expect(
    out(page).locator('.out-text', { hasText: 'HTML comments' }).locator('pre'),
  ).toContainText(payload);
  await expect(
    out(page).locator('td', { hasText: 'javascript:window.__pwned=3' }).first(),
  ).toHaveText('javascript:window.__pwned=3');
  await expect(out(page).locator('td', { hasText: script }).first()).toHaveText(script);
  // ... and nothing was built from them: no image, no script, no link, nothing ran.
  expect(await out(page).locator('img, script, iframe, a, object, embed').count()).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('the app makes no request on load, and none in Auto or Paste mode, even for a URL', async ({
  page,
  baseURL,
}) => {
  const w = await watch(page, baseURL);
  await page.goto('./');
  await page.goto('./#/tool/web-source');
  await input(page).fill('https://ctf.example.test/static/app.js');
  await run(page);
  await expect(out(page)).toContainText('so nothing was requested');
  await mode(page, 'Paste');
  await run(page);
  await expect(out(page)).toContainText('Pasted');
  await page.waitForTimeout(500);
  expect(w.offsite).toEqual([]);
});

test('URL mode (simulated proxies): nothing is requested until Run; then the proxies are tried in order', async ({
  page,
  baseURL,
}) => {
  const w = await watch(page, baseURL);
  await page.goto('./#/tool/web-source');
  const net = await simulateProxies(page, baseURL, (proxy, target) => {
    if (proxy === 'api.allorigins.win') return { status: 200, body: '' }; // empty body
    if (proxy === 'corsproxy.io' && target === `${SITE}web-source-bundle.js`)
      return { body: BUNDLE };
    if (proxy === 'corsproxy.io' && target === `${SITE}web-source-bundle.js.map`)
      return { body: BUNDLE_MAP };
    return null;
  });
  await mode(page, 'URL');
  await expect(page.locator('.options')).toContainText('Proxy allorigins.win');
  await input(page).fill(`${SITE}web-source-bundle.js`);
  await page.waitForTimeout(600);
  expect(net.calls).toEqual([]); // typing, choosing URL: still nothing
  expect(w.offsite).toEqual([]);

  await run(page);
  await expect(out(page)).toContainText('TEST_FLAG_123', { timeout: 15_000 });
  expect(net.calls).toEqual([
    ['api.allorigins.win', `${SITE}web-source-bundle.js`],
    ['corsproxy.io', `${SITE}web-source-bundle.js`],
    ['corsproxy.io', `${SITE}web-source-bundle.js.map`],
  ]);
  const network = out(page).locator('.out-table', { hasText: 'Network (public proxies)' });
  const rows = network.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('allorigins.win');
  await expect(rows.nth(0)).toContainText('failed');
  await expect(rows.nth(0)).toContainText('empty answer');
  await expect(rows.nth(1)).toContainText('corsproxy.io');
  await expect(rows.nth(1)).toContainText('OK');
  await expect(rows.nth(2)).toContainText(`Source map: ${SITE}web-source-bundle.js.map`);
  await expect(out(page)).toContainText(
    `Fetched from ${SITE}web-source-bundle.js through corsproxy.io`,
  );
  await expect(out(page)).toContainText('Fetching through a public proxy is fragile');
  await expect(
    out(page).locator('.out-table tr', { hasText: 'TEST_FLAG_123' }).first(),
  ).toContainText(HIDDEN);
  // Nothing left for anywhere but the (simulated) proxies.
  expect(net.stray).toEqual([]);
  expect(w.offsite.every((u) => PROXY_HOSTS.includes(new URL(u).host))).toBe(true);
  expect(w.errors).toEqual([]);
});

test('URL mode: coming back to the tool does not ask the proxies again; "Fetch again" does', async ({
  page,
  baseURL,
}) => {
  await watch(page, baseURL);
  await page.goto('./#/tool/web-source');
  const net = await simulateProxies(page, baseURL, (proxy, target) =>
    proxy === 'api.allorigins.win' && target === `${SITE}plain.js`
      ? { body: 'var a = 1;\n' }
      : null,
  );
  await mode(page, 'URL');
  await input(page).fill(`${SITE}plain.js`);
  await run(page);
  await expect(out(page)).toContainText(`Fetched from ${SITE}plain.js through allorigins.win`);
  const first = net.calls.length;
  expect(first).toBeGreaterThanOrEqual(1);

  // Another tool, then back: the tool runs again by itself, from memory.
  await page.goto('./#/tool/base64');
  await page.goto('./#/tool/web-source');
  await expect(out(page)).toContainText('No new request was made');
  await page.waitForTimeout(400);
  expect(net.calls.length).toBe(first);

  await out(page).getByRole('button', { name: 'Fetch again', exact: true }).click();
  await expect.poll(() => net.calls.length).toBeGreaterThan(first);
  await expect(out(page)).not.toContainText('No new request was made');
});

test('URL mode: when no proxy answers, each failure is explained and Try again asks once more', async ({
  page,
  baseURL,
}) => {
  await watch(page, baseURL);
  await page.goto('./#/tool/web-source');
  const net = await simulateProxies(page, baseURL, (proxy) => {
    if (proxy === 'api.allorigins.win') return { status: 429, body: 'slow down' };
    if (proxy === 'corsproxy.io') return { status: 403, body: 'forbidden' };
    return null;
  });
  await mode(page, 'URL');
  await input(page).fill(`${SITE}app.js`);
  await run(page);
  const rows = out(page).locator('.out-table tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('answered HTTP 429');
  await expect(rows.nth(1)).toContainText('answered HTTP 403');
  await expect(rows.nth(2)).toContainText('network error');
  await expect(out(page).locator('.note-error')).toContainText('No proxy returned the page');
  await expect(out(page)).toContainText('press Ctrl+U (view-source:)');
  expect(net.calls).toHaveLength(3);
  await out(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect.poll(() => net.calls.length).toBe(6);
});

test('Auto offers URL mode for a bare URL, and only the button starts a request', async ({
  page,
  baseURL,
}) => {
  await watch(page, baseURL);
  await page.goto('./#/tool/web-source');
  const net = await simulateProxies(page, baseURL, (proxy, target) =>
    proxy === 'api.allorigins.win' && target === `${SITE}x.js`
      ? { body: 'var password = "from-the-proxy-1";' }
      : null,
  );
  await input(page).fill(`${SITE}x.js`);
  await run(page);
  await expect(out(page)).toContainText('so nothing was requested');
  expect(net.calls).toEqual([]);
  await out(page)
    .getByRole('button', { name: 'Fetch it through a public proxy', exact: true })
    .click();
  await expect(out(page)).toContainText('from-the-proxy-1', { timeout: 15_000 });
  expect(net.calls[0]).toEqual(['api.allorigins.win', `${SITE}x.js`]);
  await expect(
    page.locator('.options').getByRole('button', { name: 'URL', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('URL mode refuses a private address before any request', async ({ page, baseURL }) => {
  await watch(page, baseURL);
  await page.goto('./#/tool/web-source');
  const net = await simulateProxies(page, baseURL, () => ({ body: 'never' }));
  await mode(page, 'URL');
  await input(page).fill('http://192.168.1.20/app.js');
  await run(page);
  await expect(out(page).locator('.note-error')).toContainText('private or local address');
  expect(net.calls).toEqual([]);
});

for (const locale of ['en', 'fr', 'ru', 'zh', 'hi']) {
  test(`the result is translated and fits a phone (390×844, ${locale})`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((l) => localStorage.setItem('ftf.locale', l), locale);
    const w = await watch(page, baseURL);
    await page.goto('./#/tool/web-source');
    // The first example: the bundle with its map file.
    await page.locator('.examples button').first().click();
    await expect(out(page).locator('.out-table').first()).toBeVisible({ timeout: 15_000 });
    await expect(out(page).locator('.out-table tr', { hasText: 'TEST_FLAG_123' })).toHaveCount(1);
    // No key name leaks into the page, whatever the language.
    expect(await page.locator('body').innerText()).not.toContain('tool.web-source.');
    const width = () => page.evaluate(() => document.documentElement.scrollWidth);
    const widest = () =>
      page.evaluate(() =>
        Math.max(
          ...[...document.querySelectorAll('.options .opt, .pane-in, .out-stack > *')].map(
            (e) => e.getBoundingClientRect().right,
          ),
        ),
      );
    expect(await widest()).toBeLessThanOrEqual(390);
    // The Russian top bar is 9 px too wide on every tool (shared shell): not this tool.
    if (locale !== 'ru') expect(await width()).toBeLessThanOrEqual(390);
    expect(w.errors).toEqual([]);
    expect(w.offsite).toEqual([]);
  });
}
