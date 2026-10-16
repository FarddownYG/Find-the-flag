import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { concatBytes, utf8Encode } from '../src/lib/bytes';
import {
  app1Exif,
  ascii,
  comment,
  jpegOf,
  jpegWith,
  picture,
  tiff,
} from '../src/tools/stego/_image-analyzer-fixtures';

// 1x1 transparent PNG served in place of OpenStreetMap tiles: the test never leaves the machine.
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const TILE_HOST = 'tile.openstreetmap.org';
const LAT = 48.8584;
const LON = 2.2945;
const SAMPLE_PATH = fileURLToPath(new URL('../public/samples/meta-eiffel.jpg', import.meta.url));
const PLAIN_PATH = fileURLToPath(new URL('../public/samples/meta-plain.png', import.meta.url));
const SAMPLE = readFileSync(SAMPLE_PATH);
const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Slippy-map tile that contains a point (what Leaflet must request around the marker). */
function tileOf(lat: number, lon: number, z: number): string {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return `/${z}/${x}/${y}.png`;
}

interface Seen {
  url: string;
  type: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

/** Record every request (page, popups, workers), console error, page error and CSP violation. */
async function watch(page: Page) {
  const requests: Seen[] = [];
  const errors: string[] = [];
  page.context().on('request', (r) =>
    requests.push({
      url: r.url(),
      type: r.resourceType(),
      method: r.method(),
      headers: r.headers(),
      body: r.postDataBuffer(),
    }),
  );
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  await page
    .context()
    .route(`https://${TILE_HOST}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: TILE }),
    );
  return { requests, errors };
}

const origin = (url: string) =>
  url.startsWith('data:') || url.startsWith('blob:') ? url.split(':')[0]! : new URL(url).origin;

test('image analyzer: GPS of the synthetic photo, no third-party request until "Show map"', async ({
  page,
}) => {
  const { requests, errors } = await watch(page);
  await page.goto('./#/tool/image-analyzer');
  const self = new URL(page.url()).origin;
  await page
    .locator('.examples')
    .getByRole('button', { name: 'Photo with GPS (synthetic, Eiffel Tower)', exact: true })
    .click();

  const out = page.locator('.pane-out');
  await expect(out).toContainText(
    'Everything below was computed in this tab — the file was not uploaded anywhere.',
  );
  const map = out.locator('.out-map');
  await expect(map).toHaveCount(1, { timeout: 15_000 });
  await expect(map.locator('.out-meta')).toHaveText('48.858400, 2.294500');
  await expect(map).toContainText('48° 51′ 30.24″ N');
  const google = map.getByRole('link', { name: 'Open in Google Maps' });
  await expect(google).toHaveAttribute('href', /48\.858400,2\.294500/);
  await expect(out).toContainText('Latitude: 48.858400');
  await expect(out).toContainText('Thumbnail: differs from the main image');

  // The main image and the EXIF thumbnail are two separate pictures, both decoded by the browser.
  const pictures = out.locator('img.out-picture');
  await expect(pictures).toHaveCount(2);
  await expect
    .poll(() =>
      pictures.evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth)),
    )
    .toEqual([320, 160]);

  // Nothing has left the page so far: only the app's own files (and blob: URLs of the pictures).
  await page.waitForTimeout(500);
  expect(requests.filter((r) => !['blob', 'data', self].includes(origin(r.url)))).toEqual([]);

  await map.getByRole('button', { name: 'Show map' }).click();
  await expect(map.locator('.leaflet-container')).toBeVisible();
  await expect(map.locator('img.leaflet-tile-loaded').first()).toBeVisible();
  const tiles = requests.filter((r) => !['blob', 'data', self].includes(origin(r.url)));
  expect(tiles.length).toBeGreaterThan(0);
  for (const t of tiles) {
    expect(new URL(t.url).hostname).toBe(TILE_HOST);
    expect(t.type).toBe('image');
    expect(t.method).toBe('GET');
    expect(t.url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    // At most the origin as Referer (never the page URL), and no cookie.
    expect([undefined, `${self}/`]).toContain(t.headers.referer);
    expect(t.headers.cookie).toBeUndefined();
  }
  // The map is centred on the photo's position: its tile is among those requested.
  expect(tiles.map((t) => new URL(t.url).pathname)).toContain(tileOf(LAT, LON, 16));
  expect(errors).toEqual([]);
});

test('image analyzer: comparing the photo with itself', async ({ page }) => {
  const { errors } = await watch(page);
  await page.goto('./#/tool/image-analyzer');
  await page
    .locator('.examples')
    .getByRole('button', { name: 'Compare a file with itself', exact: true })
    .click();
  const out = page.locator('.pane-out');
  await expect(out).toContainText('Verdict: Identical files (same MD5/SHA-1/SHA-256)', {
    timeout: 15_000,
  });
  await expect(out).toContainText(`MD5: ${md5(SAMPLE)}`);
  await expect(out).toContainText('Comparison: identical to meta-eiffel.jpg');
  expect(errors).toEqual([]);
});

test('image analyzer: real file inputs, second file, links, and no trace left', async ({
  page,
  baseURL,
}) => {
  const { requests, errors } = await watch(page);
  // Any request to another origin than the app (and the stubbed Google page) is a failure.
  const appOrigin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  await page.context().route(
    (url) => url.origin !== appOrigin,
    (route) => {
      const u = route.request().url();
      if (u.startsWith('https://www.google.com/'))
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<title>stub</title>',
        });
      if (u.startsWith(`https://${TILE_HOST}/`)) return route.fallback();
      return route.abort();
    },
  );
  await page.goto('./#/tool/image-analyzer');
  const self = new URL(page.url()).origin;
  const startUrl = page.url();
  await page.locator('.input-box input[type=file]').setInputFiles(SAMPLE_PATH);
  const out = page.locator('.pane-out');
  const map = out.locator('.out-map');
  await expect(map.locator('.out-meta')).toHaveText('48.858400, 2.294500', { timeout: 15_000 });

  // The most telling facts come first: Findings, then the warning about the thumbnail.
  const blocks = out.locator('.out-stack > *');
  await expect(blocks.nth(1)).toContainText('Findings');
  await expect(blocks.nth(2)).toHaveClass(/note-warn/);
  await expect(blocks.nth(2)).toContainText('The EXIF thumbnail does not match the main image');

  // Outbound links: a new tab, no opener, no referrer, exactly the query.
  const google = map.getByRole('link', { name: 'Open in Google Maps' });
  await expect(google).toHaveAttribute(
    'href',
    'https://www.google.com/maps/search/?api=1&query=48.858400,2.294500',
  );
  await expect(google).toHaveAttribute('target', '_blank');
  await expect(google).toHaveAttribute('rel', /noopener/);
  await expect(google).toHaveAttribute('rel', /noreferrer/);
  const osm = map.getByRole('link', { name: 'Open in OpenStreetMap' });
  await expect(osm).toHaveAttribute('rel', /noreferrer/);
  const [popup] = await Promise.all([page.context().waitForEvent('page'), google.click()]);
  await popup.waitForLoadState();
  expect(await popup.evaluate(() => [window.opener === null, document.referrer])).toEqual([
    true,
    '',
  ]);
  const nav = requests.find((r) => r.url.startsWith('https://www.google.com/'));
  expect(nav?.headers.referer).toBeUndefined();
  await popup.close();

  // A second file through the "Compare with" input.
  await page.locator('.options input[type=file]').setInputFiles(SAMPLE_PATH);
  await page.locator('.btn-run').click();
  await expect(out).toContainText('Comparison: identical to meta-eiffel.jpg', { timeout: 15_000 });
  await page.locator('.options input[type=file]').setInputFiles(PLAIN_PATH);
  await page.locator('.btn-run').click();
  await expect(out).toContainText('Comparison: different from meta-plain.png', {
    timeout: 15_000,
  });
  await expect(out).toContainText('Verdict: Different files');

  // Nothing about the file went anywhere, and nothing stayed behind.
  const needles = [
    '48.858',
    '2.2945',
    'meta-eiffel',
    md5(SAMPLE),
    sha256(SAMPLE),
    SAMPLE.subarray(2, 26).toString('hex'),
    SAMPLE.subarray(2, 26).toString('base64'),
  ];
  for (const r of requests) {
    if (origin(r.url) === self || r.url.startsWith('https://www.google.com/')) continue;
    expect(r.method).toBe('GET');
    expect(r.body).toBeNull();
    for (const n of needles) expect(decodeURIComponent(r.url)).not.toContain(n);
  }
  for (const r of requests.filter((x) => origin(x.url) === self)) {
    expect(r.method).toBe('GET');
    expect(r.body).toBeNull();
  }
  expect(page.url()).toBe(startUrl);
  const stored = await page.evaluate(async () => {
    const dbs = 'databases' in indexedDB ? await indexedDB.databases() : [];
    return JSON.stringify({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
      cookie: document.cookie,
      dbs,
      caches: await caches.keys(),
      sw: (await navigator.serviceWorker.getRegistrations()).length,
    });
  });
  for (const n of needles) expect(stored).not.toContain(n);
  expect(JSON.parse(stored)).toMatchObject({ cookie: '', caches: [], sw: 0 });
  expect(errors).toEqual([]);
});

test('image analyzer: the page CSP allows only OpenStreetMap tiles and the three URL-mode proxies off-site, and enforces it', async ({
  page,
}) => {
  const { errors } = await watch(page);
  let probed = 0;
  await page.context().route('http://127.0.0.1:4173/**', (route) => {
    probed++;
    return route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*' },
      body: 'reached',
    });
  });
  await page.goto('./#/tool/image-analyzer');
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  const directives = Object.fromEntries(
    (csp ?? '').split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values];
    }),
  );
  const remote = Object.values(directives)
    .flat()
    .filter(
      (v) =>
        !["'self'", "'none'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'blob:', 'data:'].includes(
          v,
        ),
    );
  // The map tiles (img-src) and, in connect-src, the three public proxies the Web source
  // analyzer's URL mode uses when the user runs it: nothing else, no wildcard.
  const proxies = [
    'https://api.allorigins.win',
    'https://corsproxy.io',
    'https://api.codetabs.com',
  ];
  expect(remote).toEqual(['https://tile.openstreetmap.org', ...proxies]);
  expect(directives['img-src']).toContain('https://tile.openstreetmap.org');
  expect(directives['default-src']).toEqual(["'self'"]);
  expect(directives['connect-src']).toEqual(["'self'", ...proxies]);
  expect(directives['object-src']).toEqual(["'none'"]);
  // The meta comes before any script.
  expect(
    await page.evaluate(() => {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')!;
      const script = document.querySelector('script')!;
      return Boolean(meta.compareDocumentPosition(script) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  ).toBe(true);
  const results = await page.evaluate(async () => {
    const target = 'http://127.0.0.1:4173/csp-probe';
    const out: string[] = [];
    try {
      await fetch(target, { mode: 'no-cors' });
      out.push('fetch reached');
    } catch {
      out.push('fetch blocked');
    }
    out.push(
      await new Promise<string>((done) => {
        const img = new Image();
        img.onload = () => done('image reached');
        img.onerror = () => done('image blocked');
        img.src = `${target}.png`;
      }),
    );
    try {
      out.push(navigator.sendBeacon(target, 'x') ? 'beacon queued' : 'beacon refused');
    } catch {
      out.push('beacon blocked');
    }
    return out;
  });
  expect(results.slice(0, 2)).toEqual(['fetch blocked', 'image blocked']);
  await page.waitForTimeout(300);
  expect(probed).toBe(0);
  expect(
    errors.every((e) => e.startsWith('CSP violation') || /Content Security Policy/.test(e)),
  ).toBe(true);
});

test('image analyzer: a long metadata value is on the page in full and found by the filter', async ({
  page,
}) => {
  const { errors } = await watch(page);
  const value =
    'Long synthetic comment. '.repeat(150) + 'END-MARKER the passphrase is correct-horse-battery';
  const base = jpegOf(picture(64, 48));
  const photo = jpegWith(
    base,
    app1Exif(
      tiff({
        // Enough rows for the table to get its filter box.
        ifd0: [
          [0x010f, ascii('ProbeMake')],
          [0x0110, ascii('ProbeModel')],
          [0x0131, ascii('ProbeSoftware')],
          [0x013b, ascii('Probe Artist')],
          [0x8298, ascii('Probe Copyright')],
        ],
        exif: [[0x9286, comment('ASCII', utf8Encode(value))]],
      }),
    ),
  );
  await page.goto('./#/tool/image-analyzer');
  await page.locator('.input-box input[type=file]').setInputFiles({
    name: 'long-comment.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(concatBytes(photo)),
  });
  const out = page.locator('.pane-out');
  const table = out.locator('.out-table').filter({ hasText: 'All metadata' });
  await expect(table).toHaveCount(1, { timeout: 15_000 });
  await table.locator('.out-filter').fill('correct-horse');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody tr')).toContainText(
    'END-MARKER the passphrase is correct-horse-battery',
  );
  const full = out.locator('.out-text').filter({ hasText: 'Full value: ExifIFD UserComment' });
  await expect(full).toContainText('END-MARKER the passphrase is correct-horse-battery');
  expect(errors).toEqual([]);
});
