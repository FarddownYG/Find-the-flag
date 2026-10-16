import { expect, test } from '@playwright/test';

// The Binary / Octal / Decimal / Hex converter through the real UI, beyond the example buttons
// clicked by tools.spec.ts: detection, the ambiguity table, the options, "Send to", the pointer to
// Number / base converter, and the home triage.

const OCTAL = '106 124 106 173 157 143 164 141 154 175';

test('text is written in binary, octal, decimal and hex, each copyable and pipeable', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/base-convert');
  await page.locator('.input-text').fill('FTF{ok}');
  const out = page.locator('.pane-out');
  await expect(out).toContainText('01000110 01010100 01000110 01111011 01101111 01101011 01111101');
  await expect(out).toContainText('106 124 106 173 157 153 175');
  await expect(out).toContainText('70 84 70 123 111 107 125');
  await expect(out).toContainText('46 54 46 7b 6f 6b 7d');
  await expect(out.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(5);

  // "Send to" the Hex tool: the hex block lands in its input box.
  await out
    .locator('.out-text', { hasText: '46 54 46 7b 6f 6b 7d' })
    .locator('select.pipe')
    .selectOption('hex');
  await expect(page).toHaveURL(/#\/tool\/hex/);
  await expect(page.locator('.input-text')).toHaveValue('46 54 46 7b 6f 6b 7d');
  expect(errors).toEqual([]);
});

test('an octal flag is detected, with the other readings listed and ranked', async ({ page }) => {
  await page.goto('./#/tool/base-convert');
  await page.locator('.input-text').fill(OCTAL);
  const out = page.locator('.pane-out');
  await expect(out).toContainText('Read as Octal character codes (confidence: high).');
  await expect(out.locator('.flag-strip')).toContainText('FTF{octal}');
  const rows = out.locator('table tbody tr');
  await expect(rows.first()).toContainText('Octal character codes');
  await expect(rows.first()).toContainText('FTF{octal}');
  await expect(rows).toHaveCount(3);
  // The same digits as decimal or hex do not spell text, and the page says so.
  await expect(out).toContainText('Also valid: Hex bytes');
});

test('"101 102 103" is octal, decimal and hex at once, and says it is unsure', async ({ page }) => {
  await page.goto('./#/tool/base-convert');
  await page.locator('.input-text').fill('101 102 103');
  const out = page.locator('.pane-out');
  await expect(out.locator('.note-warn')).toContainText('confidence: low');
  const table = out.locator('table');
  await expect(table).toContainText('Octal character codes');
  await expect(table).toContainText('ABC');
  await expect(table).toContainText('Decimal character codes');
  await expect(table).toContainText('efg');
  await expect(table).toContainText('Hex bytes');
  // Choosing the base settles it.
  await page.locator('#opt-base-convert-input').selectOption('8');
  await expect(out.locator('.out-bytes').first()).toContainText('ABC');
  await expect(out.locator('table')).toHaveCount(0);
});

test('a forced base explains what does not fit', async ({ page }) => {
  await page.goto('./#/tool/base-convert');
  await page.locator('.input-text').fill('98 99');
  await page.locator('#opt-base-convert-input').selectOption('8');
  await expect(page.locator('.pane-out .note-error')).toContainText('98');
});

test('7-bit binary, separators and hex case', async ({ page }) => {
  await page.goto('./#/tool/base-convert');
  const out = page.locator('.pane-out');
  const options = page.locator('.options');
  await page.locator('.input-text').fill('1000110 1010100 1000110 1111011 1100010 1111101');
  await options.getByRole('button', { name: '7', exact: true }).click();
  await expect(out).toContainText('FTF{b}');
  await expect(out).toContainText('Binary (7-bit groups)');

  await page.locator('.input-text').fill('Hi!');
  await options.getByRole('button', { name: 'ABC', exact: true }).click();
  await page.locator('#opt-base-convert-separator').selectOption('comma');
  await expect(out).toContainText('48,69,21');
  await options.getByRole('button', { name: '8', exact: true }).click();
  await page.locator('#opt-base-convert-separator').selectOption('none');
  await expect(out).toContainText('486921');
  await expect(out).toContainText('010010000110100100100001');
});

test('a huge number is written in every base and points to Number / base converter', async ({
  page,
}) => {
  await page.goto('./#/tool/base-convert');
  const n = '2511413510842060413510119088141712512283210298218286115709';
  await page.locator('.input-text').fill(n);
  const out = page.locator('.pane-out');
  await expect(out).toContainText('666c61677b7273615f736d616c6c5f655f61747461636b7d');
  await expect(out).toContainText('flag{rsa_small_e_attack}');
  await out.getByRole('button', { name: 'Open in Number / base converter' }).click();
  await expect(page).toHaveURL(/#\/tool\/number-base/);
  await expect(page.locator('.input-text')).toHaveValue(n);
});

test('home triage offers it for a list of octal codes, below the Binary and Hex tools', async ({
  page,
}) => {
  await page.goto('./');
  const box = page.getByLabel('Paste data to identify');
  await box.fill(OCTAL);
  const guess = page.locator('.guess', { hasText: 'Binary / Octal / Decimal / Hex' });
  await expect(guess).toContainText('Octal character codes');
  await guess.click();
  await expect(page).toHaveURL(/#\/tool\/base-convert/);
  await expect(page.locator('.pane-out')).toContainText('FTF{octal}');
  await expect(page.locator('#opt-base-convert-input')).toHaveValue('8');

  // A hex string is the Hex tool's: the converter never comes first.
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill('666c61677b6865787d');
  await expect(page.locator('.guess .guess-name').first()).toHaveText('Hex');
  const names = await page.locator('.guess .guess-name').allTextContents();
  expect(names.indexOf('Hex')).toBeGreaterThanOrEqual(0);
  const converter = names.indexOf('Binary / Octal / Decimal / Hex');
  if (converter >= 0) expect(names.indexOf('Hex')).toBeLessThan(converter);
  // Plain text is nobody's business but the text tools'.
  await page.getByLabel('Paste data to identify').fill('hello world, nothing to see');
  await expect(page.locator('.guess', { hasText: 'Binary / Octal / Decimal / Hex' })).toHaveCount(
    0,
  );
});

test('French interface: the name, the verdict and a French query', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ftf.locale', 'fr'));
  await page.goto('./#/tool/base-convert');
  await expect(page.locator('h1')).toHaveText('Binaire / Octal / Décimal / Hexa');
  await page.locator('.input-text').fill(OCTAL);
  await expect(page.locator('.pane-out')).toContainText(
    'Lu comme Codes de caractères en octal (confiance : élevée).',
  );
  await expect(page.locator('.pane-out .flag-strip')).toContainText('FTF{octal}');
});
