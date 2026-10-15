import { expect, test } from '@playwright/test';

// Punycode / IDN through the real UI, beyond the example buttons clicked by tools.spec.ts.

test('encode domains, then decode the result back through the Mode toggle', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/punycode');
  await page.locator('.options').getByRole('button', { name: 'encode', exact: true }).click();
  await page.locator('.input-text').fill('https://bücher.example/straße text-ünï.org');
  const out = page.locator('.pane-out');
  await expect(out).toContainText('https://xn--bcher-kva.example/straße xn--text-n-nwa6h.org');
  await expect(out.locator('table')).toContainText('xn--bcher-kva');

  await page.locator('.options').getByRole('button', { name: 'decode', exact: true }).click();
  await page.locator('.input-text').fill('https://xn--bcher-kva.example/ xn--mnchen-3ya.de');
  await expect(out).toContainText('https://bücher.example/ münchen.de');
  expect(errors).toEqual([]);
});

test('a broken label is reported with its position in the whole text', async ({ page }) => {
  await page.goto('./#/tool/punycode');
  await page.locator('.input-text').fill('see xn--bcher-k.example');
  await expect(page.locator('.pane-out .note-error')).toContainText(
    'ends in the middle of a number (position 15)',
  );
});

test('bare Punycode: the RFC 3492 samples, line by line', async ({ page }) => {
  await page.goto('./#/tool/punycode');
  await page
    .locator('.options')
    .getByRole('button', { name: /Bare Punycode/ })
    .click();
  await page
    .locator('.input-text')
    .fill('ihqwcrb4cv8a8dqg056pqjye\nde-jg4avhby1noc0d\n-with-SUPER-MONKEYS-pc58ag80a8qai00g7n9n');
  const out = page.locator('.pane-out');
  await expect(out).toContainText('他们为什么不说中文');
  await expect(out).toContainText('パフィーdeルンバ');
  await expect(out).toContainText('安室奈美恵-with-SUPER-MONKEYS');
});

test('home triage recognises a domain with an xn-- label', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill('xn--bcher-kva.example');
  const first = page.locator('.guess').first();
  await expect(first).toContainText('Punycode');
  await first.click();
  await expect(page.locator('.pane-out')).toContainText('bücher.example');
});
