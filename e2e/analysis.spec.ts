import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';

// The home page analyses what you drop with no click: a verdict sentence on top, findings by
// confidence with proof, a way to redo each by hand and the lesson behind the technique, then what
// was checked. The analysis runs in a worker and can be stopped.

const sample = (name: string) =>
  fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url));

test('a dropped video gets a verdict, the proof and the lesson, above the tool guesses', async ({
  page,
}) => {
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles(sample('mp4-encrypted-mdat.mp4'));
  const verdict = page.locator('.an-sentence');
  await expect(verdict).toContainText('encrypted data is hidden in this file');
  await expect(page.locator('.an-chip-probable').first()).toHaveText('Probable');
  const first = page.locator('.an-finding').first();
  await expect(first).toHaveAttribute('open', '');
  await expect(first.locator('.hex')).toBeVisible();
  await expect(first.getByRole('heading', { name: 'The lesson' })).toBeVisible();
  await expect(first.getByRole('heading', { name: 'Redo by hand' })).toBeVisible();
  await expect(first.locator('.an-code').first()).toContainText('binwalk');
  await expect(page.locator('.an-checks li').first()).toContainText('File format identified: mp4');
  // The analysis sits above the manual guesses.
  const order = await page.evaluate(() => {
    const a = document.querySelector('.analysis-slot');
    const g = document.querySelector('.triage-results');
    return Boolean(a && g && a.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
});

test('a hidden flag is named, opens the tool that found it, and stays out of the writeup', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles(sample('stego-lsb.png'));
  await expect(page.locator('.an-sentence')).toContainText('flag{lsb_hidden_in_pixels}');

  await page.getByRole('button', { name: 'Copy writeup (Markdown)' }).click();
  const hidden = await page.evaluate(() => navigator.clipboard.readText());
  expect(hidden).toContain('## Verdict');
  expect(hidden).not.toContain('flag{lsb_hidden_in_pixels}');

  await page.getByLabel('Include the flag in the writeup').check();
  await page.getByRole('button', { name: 'Copy writeup (Markdown)' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('flag{lsb_hidden_in_pixels}');

  await page
    .getByRole('button', { name: /^Open in LSB/ })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/tool\/lsb$/);
});

test('a pasted text is analysed too, and its explanation is translated', async ({ page }) => {
  await page.goto('./');
  await page
    .locator('.triage-input')
    .fill('Pelcgbtencul vf sha, ohg nabgure frpergzrffntr jvyy abg or gur nafjre.');
  await expect(page.locator('.an-sentence')).toBeVisible();
  await expect(page.locator('.an-checks')).toContainText(
    'Detector run: text and classical ciphers',
  );
  await page.locator('#lang-side').selectOption('fr');
  await expect(page.locator('.home-title')).toHaveText('Qu’as-tu trouvé ?');
  await page
    .locator('.triage-input')
    .fill('Pelcgbtencul vf sha, ohg nabgure frpergzrffntr jvyy abg or gur nafjre.');
  await expect(page.locator('.an h3').filter({ hasText: 'Ce qui a été vérifié' })).toBeVisible();
});

test('the analysis can be stopped, and run again', async ({ page }) => {
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({
    name: 'noise.bin',
    mimeType: 'application/octet-stream',
    buffer: randomBytes(48 * 1024 * 1024),
  });
  const stop = page.locator('.an-busy').getByRole('button', { name: 'Stop' });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(page.locator('.an-busy')).toContainText('Analysis stopped.');
  await page.getByRole('button', { name: 'Run again' }).click();
  await expect(page.locator('.an-busy').getByRole('button', { name: 'Stop' })).toBeVisible();
});
