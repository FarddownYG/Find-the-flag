import { expect, test, type Page } from '@playwright/test';

// The Nihilist cipher tool through the real UI: the numbers decrypted by hand, the key-length
// helper and its "decrypt with these key numbers" button, the transposition and the home triage.
// (The examples of the tool are clicked by tools.spec.ts like every other tool's.)

const out = (page: Page) => page.locator('.pane-out');
const seg = (page: Page, group: string, name: string) =>
  page.getByRole('group', { name: group }).getByRole('button', { name, exact: true });

// Wikipedia, "Nihilist cipher": square keyword ZEBRAS, key RUSSIAN, DYNAMITE WINTER PALACE.
const WIKI = '37 106 62 36 67 47 86 26 104 53 62 77 27 55 57 66 55 36 54 27';

// scripts/gen-samples-transposition.mjs: an English message, square ZEBRAS, key RUSSIAN.
const LONG =
  '59 82 33 54 44 70 73 35 66 35 72 53 36 73 29 92 74 63 46 38 56 55 74 66 52 44 39 75 29 76 53 42 63 47 64 37 63 62 53 73 60 72 26 72 72 56 53 57 65 55 102 56 34 44 29 62 26 103 33 35 87 36 53 66 63 62 66 63 56 92 49 64 33 35 53 46 56 28 63 42 36 65 27 96 55 102 56 34 44 29 62 56 73 63 72 73 60 86 45 63 46 35 74 66 84 35 66 62 44 66 57 83 47 66 66 66 63 27 86 26 92 42 36 73 38 92 55 83 66 42 45 27 65 56 65 33 76 74 66 86 28 106 66 63 57 66 53 35 72 66 52 44 68 83 28 74';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/nihilist');
  return errors;
}

test('decrypts by hand, with the key as a word and then as numbers', async ({ page }) => {
  const errors = await open(page);
  await page.locator('.input-text').fill(WIKI);
  await expect(out(page).locator('.note-error')).toContainText('Enter the key');
  await page.locator('#opt-nihilist-square').fill('ZEBRAS');
  await page.locator('#opt-nihilist-key').fill('RUSSIAN');
  const result = out(page);
  await expect(result.locator('.out-text').first()).toContainText('DYNAMITEWINTERPALACE');
  await expect(result).toContainText('14 51 21 21 32 15 41');
  await page.locator('#opt-nihilist-key').fill('14 51 21 21 32 15 41');
  await expect(result.locator('.out-text').first()).toContainText('DYNAMITEWINTERPALACE');
  // The wrong key shows ? where no letter comes out, and says so.
  await page.locator('#opt-nihilist-key').fill('KEY');
  await expect(result.locator('.out-text').first()).toContainText('?');
  await expect(result).toContainText('do not give a letter with this key and square');
  expect(errors).toEqual([]);
});

test('encrypts and shows the key numbers and the square', async ({ page }) => {
  const errors = await open(page);
  await seg(page, 'Mode', 'Encrypt').click();
  await page.locator('#opt-nihilist-square').fill('ZEBRAS');
  await page.locator('#opt-nihilist-key').fill('RUSSIAN');
  await page.locator('.input-text').fill('Dynamite winter palace');
  const result = out(page);
  await expect(result.locator('.out-text').first()).toContainText(WIKI);
  await expect(result.locator('table').first()).toContainText('Z');
  expect(errors).toEqual([]);
});

test('the key-length helper finds 7 and its button decrypts with the key it found', async ({
  page,
}) => {
  const errors = await open(page);
  await seg(page, 'Method', 'Key length').click();
  await page.locator('#opt-nihilist-square').fill('ZEBRAS');
  await page.locator('.input-text').fill(LONG);
  const result = out(page);
  await expect(result).toContainText('Most likely key length: 7');
  await expect(result).toContainText('Plaintext guess with a key of 7 numbers');
  await expect(result).toContainText('THEKEYISARUSSIANWORDANDTHEFLAGISHIDDEN');
  await expect(result).toContainText('14 51 21 21 32 15 41');
  await expect(result.locator('tr.is-hl').first()).toContainText('7');
  await expect(result.locator('.note-error')).toHaveCount(0);

  await result.getByRole('button', { name: 'Decrypt with these key numbers' }).click();
  await expect(seg(page, 'Method', 'Numbers')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#opt-nihilist-key')).toHaveValue('14 51 21 21 32 15 41');
  await expect(result.locator('.out-text').first()).toContainText('THEKEYISARUSSIANWORD');

  // A length typed by hand is tried even though the table does not recommend it.
  await seg(page, 'Method', 'Key length').click();
  await page.locator('#opt-nihilist-keyLength').fill('3');
  await expect(result).toContainText('some positions have no key number that fits');
  expect(errors).toEqual([]);
});

test('the transposition writes a square and puts its rows and columns in key order', async ({
  page,
}) => {
  const errors = await open(page);
  await seg(page, 'Method', 'Transposition').click();
  await page.locator('#opt-nihilist-transpositionKey').fill('CAB');
  await seg(page, 'Mode', 'Encrypt').click();
  await page.locator('.input-text').fill('ABCDEFGHI');
  const result = out(page);
  await expect(result.locator('.out-text').first()).toContainText('EFDHIGBCA');
  await seg(page, 'Read the result', 'By columns').click();
  await expect(result.locator('.out-text').first()).toContainText('EHBFICDGA');
  await seg(page, 'Mode', 'Decrypt').click();
  await page.locator('.input-text').fill('EHBFICDGA');
  await expect(result.locator('.out-text').first()).toContainText('ABCDEFGHI');
  await page.locator('.input-text').fill('EHBFICDG');
  await expect(result.locator('.note-error')).toContainText('3×3 square holds 9 characters');
  expect(errors).toEqual([]);
});

test('the home page offers the key-length helper for sums of two coordinates', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill(WIKI);
  const guess = page.locator('.guess').filter({ hasText: 'Nihilist cipher' });
  await expect(guess).toBeVisible();
  await guess.click();
  await expect(page).toHaveURL(/#\/tool\/nihilist/);
  await expect(seg(page, 'Method', 'Key length')).toHaveAttribute('aria-pressed', 'true');
});

test('plain Polybius numbers above 5 point to this tool', async ({ page }) => {
  await page.goto('./#/tool/polybius');
  await page.locator('.input-text').fill('37 106 62 36');
  await expect(out(page).locator('.note-error')).toContainText('Nihilist cipher tool');
});
