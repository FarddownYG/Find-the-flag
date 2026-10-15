import { expect, test, type Page } from '@playwright/test';

// The cipher identifier through the real UI: the ranking and its reasons, the statistics tables,
// and the one-click "Open in" buttons that carry the text and the right options to the other tool.
// (The tool's own examples are clicked by tools.spec.ts like every other tool's.)

const out = (page: Page) => page.locator('.pane-out');
const example = (page: Page, label: string) =>
  page.locator('.examples').getByRole('button', { name: label, exact: true }).click();
const seg = (page: Page, group: string, name: string) =>
  page.getByRole('group', { name: group }).getByRole('button', { name, exact: true });

/** Open the tool, collecting page errors and requests that leave the app's origin. */
async function open(page: Page, baseURL: string | undefined) {
  const origin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  const errors: string[] = [];
  const offsite: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.context().on('request', (r) => {
    const url = r.url();
    if (!url.startsWith('blob:') && !url.startsWith('data:') && new URL(url).origin !== origin) {
      offsite.push(url);
    }
  });
  await page.goto('./#/tool/cipher-identify');
  return { errors, offsite };
}

test('a Playfair ciphertext: ranking, reasons, statistics and tables', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await example(page, 'Playfair');
  const o = out(page);
  await expect(o).toContainText('Most likely: Playfair / Two-square / Four-square');
  await expect(o).toContainText('Statistics only point in a direction');
  // The ranking, best first, then the reasons that fired for the first candidate.
  const rows = o.locator('.out-table').first().locator('tbody tr');
  await expect(rows.first()).toContainText('Playfair / Two-square / Four-square');
  await expect(o).toContainText('no letter is doubled inside any of the');
  await expect(o).toContainText('no J among the letters: a 25-letter square');
  await expect(o).toContainText('the text repeats');
  // The measures, each with a line that says what it means.
  await expect(o).toContainText('Index of coincidence');
  await expect(o).toContainText('English 0.067 · French 0.078 · random 0.038');
  await expect(o).toContainText('Chi-squared vs English / French');
  await expect(o).toContainText('Doubled letters');
  await expect(o).toContainText('25 letters, J missing');
  await expect(o).toContainText('yes: J never appears');
  await expect(
    o
      .locator('.out-table')
      .filter({ hasText: 'Index of coincidence by period' })
      .locator('tbody tr'),
  ).toHaveCount(20);
  await expect(o.locator('.note-error')).toHaveCount(0);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('Open in Playfair carries the text and sets the solver', async ({ page, baseURL }) => {
  const w = await open(page, baseURL);
  await example(page, 'Playfair');
  await expect(out(page)).toContainText('Most likely: Playfair');
  const text = await page.locator('.input-text').inputValue();
  expect(text.replace(/\s/g, '').length).toBeGreaterThan(300);
  await out(page)
    .getByRole('button', { name: 'Open in Playfair / Two-square / Four-square', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/tool\/playfair$/);
  await expect(page.locator('.input-text')).toHaveValue(text);
  await expect(seg(page, 'Mode', 'Find the key')).toHaveAttribute('aria-pressed', 'true');
  expect(w.errors).toEqual([]);
});

test('Open in the Vigenère tool sets the crack mode', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await example(page, 'Vigenère, key of 5 letters');
  await expect(out(page)).toContainText('Most likely: Vigenère family');
  await expect(out(page)).toContainText('dealt into 5 columns');
  await out(page)
    .getByRole('button', { name: 'Open in Vigenère / Beaufort / Autokey', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/tool\/vigenere$/);
  await expect(seg(page, 'Mode', 'Crack (no key)')).toHaveAttribute('aria-pressed', 'true');
  // The crack of that tool finds the key the identifier guessed the length of.
  await expect(page.locator('.pane-out')).toContainText('CRYPT');
});

test('an encoding comes first, and Open in Base64 decodes it', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await example(page, 'Base64 text');
  const o = out(page);
  await expect(o).toContainText('This is an encoding rather than a cipher: Base64.');
  await expect(o.locator('.out-table').first().locator('tbody tr').first()).toContainText(
    'Encoding: Base64',
  );
  await expect(o).toContainText('decodes to: The old lighthouse keeper');
  await o.getByRole('button', { name: 'Open in Base64', exact: true }).first().click();
  await expect(page).toHaveURL(/#\/tool\/base64$/);
  await expect(page.locator('.pane-out')).toContainText('The old lighthouse keeper');
});

test('typed plain English reads as plain language, short text is called weak', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page
    .locator('.input-text')
    .fill(
      'Nobody expected the old lighthouse to start blinking again after thirty years of darkness, ' +
        'but on the first night of spring its beam swept the empty bay once more.',
    );
  await expect(out(page)).toContainText('This looks like plain language');
  await expect(out(page)).not.toContainText(/Only \d+ letters/);
  await page.locator('.input-text').fill('KHOOR ZRUOG');
  await expect(out(page)).toContainText('Only 10 letters: the statistics give weak evidence');
  await expect(out(page)).toContainText('Caesar / ROT shift');
  expect(w.errors).toEqual([]);
});

test('the language option changes the reference the letters are compared with', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await page
    .locator('.input-text')
    .fill(
      'Le village se réveille doucement chaque matin, quand les premières lueurs du jour glissent ' +
        'sur les toits de tuiles rouges et que la boulangère allume son four.',
    );
  await expect(out(page)).toContainText('the text cuts into French words');
  await seg(page, 'Plaintext language', 'English').click();
  await expect(out(page)).toContainText('Statistics only point in a direction');
  await expect(seg(page, 'Plaintext language', 'English')).toHaveAttribute('aria-pressed', 'true');
});

test('the home page suggests the identifier for a ciphertext, not for prose', async ({ page }) => {
  await page.goto('./');
  const triage = page.locator('.triage-input');
  await triage.fill(
    'PDFMT CSEFY PDMVL IEFFL KMEUE ACIKZ CFTQK AMSTL BSATF UKMCG UFAGY QPMYQ CIPHM KPDFG KATLP BFSXB ' +
      'SVLFR MKCNA PDFCN MKXNA CFBMA ZAKKC MSRAL KMAMS NRPHI HMKRB RABRI BSZLK MKYRR PICAV RFGAV YEBBV',
  );
  await expect(page.locator('.guesses')).toContainText('Cipher identifier');
  await triage.fill(
    'The old lighthouse keeper climbed the spiral stairs every evening, long before the first ships appeared on the horizon.',
  );
  await expect(page.locator('.guesses')).toHaveCount(0);
});
