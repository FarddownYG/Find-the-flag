import { expect, test, type Page } from '@playwright/test';
import { PROSE_B } from '../src/tools/crypto/_sample-text';

// The Columnar transposition tool through the real UI: solving a pasted ciphertext in the worker
// and applying the key it found, typing keys by hand, the route options and the error messages.
// (The examples of the tool are clicked by tools.spec.ts like every other tool's.)

const out = (page: Page) => page.locator('.pane-out');
const seg = (page: Page, group: string, name: string) =>
  page.getByRole('group', { name: group }).getByRole('button', { name, exact: true });

/** Columns read in key order (an independent copy of the cipher, not the tool's own code). */
function columnar(text: string, key: string): string {
  const order = [...key]
    .map((ch, i) => [ch, i] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]))
    .map(([, i]) => i);
  let result = '';
  for (const col of order) for (let i = col; i < text.length; i += key.length) result += text[i];
  return result;
}

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/columnar');
  return errors;
}

// scripts/gen-samples-transposition.mjs: an English message with a flag, key STRANGE.
const SOLVE =
  'ociodrlttreetindkltdtwl_fntleeynnenultahrftcnef{dnydtbhruehkoynltaryeehsgrudetrtafhtmdrildcelhrtaaoobilonbelhokvhvalaadlayfy_nohehlstisotihgeeiohwkokedotediihigtcegeeotnliherer}';

test('solves a pasted ciphertext and the button applies the key it found', async ({ page }) => {
  const errors = await open(page);
  await page.locator('.input-text').fill(SOLVE);
  const result = out(page);
  await expect(result).toContainText('Best guess · 7 columns, key ', { timeout: 20_000 });
  // On an incomplete grid the look-alike keys are listed too: the exact message is one of them.
  await expect(result).toContainText('nobodynoticedthelittledoor');
  await expect(result).toContainText('flag{key_order_found}');
  await expect(result).toContainText('The best result reads like English.');
  await expect(result.locator('.note-error')).toHaveCount(0);

  await result
    .getByRole('button', { name: /^Same key length, text starting nobodynoticed/ })
    .click();
  await expect(seg(page, 'Mode', 'Decrypt')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#opt-columnar-key')).toHaveValue(/^[1-7]{7}$/);
  await expect(result.locator('.out-text').first()).toContainText(
    'nobodynoticedthelittledoorbehindthelibraryshelf',
  );
  await expect(result).toContainText('flag{key_order_found}');
  expect(errors).toEqual([]);
});

test('a 9-letter key is found in the browser within the time bound', async ({ page }) => {
  const errors = await open(page);
  const plain = PROSE_B.replace(/[^A-Za-z]/g, '')
    .toLowerCase()
    .slice(0, 700);
  await page.locator('.input-text').fill(columnar(plain, 'SPHINXVOW'));
  const started = Date.now();
  const result = out(page);
  await expect(result).toContainText('Best guess · 9 columns', { timeout: 30_000 });
  expect(Date.now() - started).toBeLessThan(30_000);
  await expect(result.locator('.out-text').first()).toContainText(plain.slice(0, 120));
  expect(errors).toEqual([]);
});

test('encrypts and decrypts with a typed key', async ({ page }) => {
  const errors = await open(page);
  await seg(page, 'Mode', 'Encrypt').click();
  await page.locator('#opt-columnar-key').fill('ZEBRAS');
  await page.locator('.input-text').fill('WE ARE DISCOVERED FLEE AT ONCE');
  const result = out(page);
  await expect(result.locator('.out-text').first()).toContainText('EVLNACDTESEAROFODEECWIREE');
  // The grid shows the key and the order the columns are read in.
  await expect(result.locator('table').first()).toContainText('Z');
  await seg(page, 'Mode', 'Decrypt').click();
  await seg(page, 'Grid', 'Complete (padded)').click();
  await page.locator('.input-text').fill('EVLNE ACDTK ESEAQ ROFOJ DEECU WIREE');
  await expect(result.locator('.out-text').first()).toContainText('WEAREDISCOVEREDFLEEATONCEQKJEU');
  expect(errors).toEqual([]);
});

test('route options: a spiral is read in the chosen direction', async ({ page }) => {
  const errors = await open(page);
  await page.locator('#opt-columnar-method').selectOption('route');
  await seg(page, 'Mode', 'Decrypt').click();
  await page.locator('#opt-columnar-width').fill('6');
  await page.locator('.input-text').fill('readths{leog}ko__stisfirgatuorpflari');
  const result = out(page);
  await expect(result).toContainText('readthisfirstflag{spiral_route_ok}go');
  await expect(result).toContainText('Reading order: Spiral inward from the top left, clockwise');
  await seg(page, 'Rotation', 'Counter-clockwise').click();
  await expect(result).not.toContainText('readthisfirstflag{spiral_route_ok}go');
  await expect(result.locator('.note-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('says what is missing instead of failing silently', async ({ page }) => {
  await open(page);
  await seg(page, 'Mode', 'Decrypt').click();
  await page.locator('.input-text').fill('EVLNACDTESEAROFODEECWIREE');
  await expect(out(page).locator('.note-error')).toContainText('Enter a key');
  await page.locator('#opt-columnar-key').fill('ZEBRAS');
  await expect(out(page)).toContainText('WEAREDISCOVEREDFLEEATONCE');
  await seg(page, 'Grid', 'Complete (padded)').click();
  await expect(out(page).locator('.note-error')).toContainText('multiple of 6 characters');
});
