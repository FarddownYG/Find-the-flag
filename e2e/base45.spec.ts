import { expect, test } from '@playwright/test';

// Base45 through the real UI, beyond the example buttons clicked by tools.spec.ts: an EU
// certificate string handed on to Auto-decode, an honest error, and the home triage.

// "HC1:" + Base45 of zlib("flag{hc1_inflated}"): a made-up payload, not a real certificate.
const HC1 = 'HC1:6BF8Q9:B96AM 592 HRZP5G6FIA2IDMO80-0';

test('an HC1: string loses its prefix and the zlib layer goes on to Auto-decode', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/base45');
  await page.locator('.input-text').fill(HC1);
  const out = page.locator('.pane-out');
  await expect(out).toContainText('The HC1: prefix was removed');
  await expect(out).toContainText('zlib');
  await out.locator('select.pipe').first().selectOption('auto-decode');
  await expect(page).toHaveURL(/#\/tool\/auto-decode/);
  await expect(page.locator('.pane-out')).toContainText('flag{hc1_inflated}');
  expect(errors).toEqual([]);
});

test('a group that is too big is reported with its position', async ({ page }) => {
  await page.goto('./#/tool/base45');
  await page.locator('.input-text').fill('BB8GGW');
  await expect(page.locator('.pane-out .note-error')).toContainText(
    'Invalid Base45 group "GGW" at positions 4–6',
  );
  await page.locator('.input-text').fill('bb8');
  await expect(page.locator('.pane-out .note-error')).toContainText('upper case only');
  await page.locator('.options').getByText('Accept lower case').click();
  await expect(page.locator('.pane-out')).toContainText('AB');
  await expect(page.locator('.pane-out .note-error')).toHaveCount(0);
});

test('home triage recognises an EU certificate string', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill(HC1);
  const first = page.locator('.guess').first();
  await expect(first).toContainText('Base45');
  await first.click();
  await expect(page.locator('.pane-out')).toContainText('The HC1: prefix was removed');
});
