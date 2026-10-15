import { expect, test, type Page } from '@playwright/test';
import {
  IV16,
  KEY16,
  KEY32,
  PASSPHRASE,
  PLAINTEXT,
  RAW,
  SALTED_PBKDF2,
} from '../src/tools/crypto/_symmetric-examples';

// Real use of the Symmetric ciphers tool in the browser, beyond the example buttons: typing the
// ciphertext and the options by hand, opening a binary file, the "apply this result" buttons.

const out = (page: Page) => page.locator('.pane-out');
const seg = (page: Page, group: string, name: string) =>
  page.getByRole('group', { name: group }).getByRole('button', { name, exact: true });
const run = (page: Page) => page.locator('.btn-run').click();

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
  await page.goto('./#/tool/symmetric');
  return { errors, offsite };
}

test('decrypts a pasted OpenSSL blob once the derivation and passphrase are set', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill(SALTED_PBKDF2);
  await seg(page, 'Key derivation', 'OpenSSL -pbkdf2').click();
  await page.locator('#opt-symmetric-key').fill(PASSPHRASE);
  await run(page);
  await expect(out(page)).toContainText(PLAINTEXT);
  await expect(out(page)).toContainText('Valid PKCS#7 padding');
  await expect(out(page)).toContainText('(from the Salted__ header)');
  await expect(out(page).locator('.note-error')).toHaveCount(0);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('a wrong passphrase says so instead of showing a result as if it were right', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(SALTED_PBKDF2);
  await seg(page, 'Key derivation', 'OpenSSL -pbkdf2').click();
  await page.locator('#opt-symmetric-key').fill('not the passphrase');
  await run(page);
  await expect(out(page)).toContainText('The PKCS#7 padding is not valid');
  await expect(out(page)).not.toContainText(PLAINTEXT);
});

test('says what is wrong with a key of the wrong size, and suggests the algorithm', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(RAW.aes128cbc);
  await page.locator('#opt-symmetric-key').fill(KEY16);
  await run(page);
  await expect(out(page).locator('.note-error')).toContainText(
    'AES-256 needs a 32-byte key, got 16. Did you mean AES-128',
  );
  // Following the advice works.
  await page.locator('#opt-symmetric-algorithm').selectOption('aes-128');
  await page.locator('#opt-symmetric-iv').fill(IV16);
  await run(page);
  await expect(out(page)).toContainText(PLAINTEXT);
});

test('a Salted__ blob read with a raw key offers the OpenSSL derivation in one click', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(SALTED_PBKDF2);
  await page.locator('#opt-symmetric-key').fill(KEY32);
  await run(page);
  await expect(out(page)).toContainText('starts with the OpenSSL Salted__ header');
  await out(page).getByRole('button', { name: 'Use OpenSSL -pbkdf2 key derivation' }).click();
  await expect(seg(page, 'Key derivation', 'OpenSSL -pbkdf2')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // The key box is a passphrase now, so this hex string is simply a wrong passphrase.
  await expect(out(page)).toContainText('(from the Salted__ header)');
});

test('opens a binary file (what `openssl enc` writes without -a)', async ({ page, baseURL }) => {
  const w = await open(page, baseURL);
  await seg(page, 'Key derivation', 'OpenSSL -pbkdf2').click();
  await page.locator('#opt-symmetric-key').fill(PASSPHRASE);
  await page.locator('input[type=file]').setInputFiles({
    name: 'secret.enc',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(SALTED_PBKDF2, 'base64'),
  });
  await expect(out(page)).toContainText(PLAINTEXT);
  await expect(out(page)).toContainText('raw bytes (auto-detected)');
  expect(w.errors).toEqual([]);
});

test('encrypts what is typed and matches the OpenSSL bytes', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(PLAINTEXT);
  await seg(page, 'Operation', 'Encrypt').click();
  await page.locator('#opt-symmetric-algorithm').selectOption('aes-128');
  await page.locator('#opt-symmetric-key').fill(KEY16);
  await page.locator('#opt-symmetric-iv').fill(IV16);
  await run(page);
  await expect(out(page)).toContainText(RAW.aes128cbc);
  await expect(out(page)).toContainText('Ciphertext (base64)');
});

test('"Try every mode" results can be applied with one click', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await page
    .locator('.examples')
    .getByRole('button', { name: 'Try every mode with a known key', exact: true })
    .click();
  await expect(out(page)).toContainText('Best guess: AES-128 CTR');
  await out(page).getByRole('button', { name: 'Use AES-128 CTR', exact: true }).click();
  await expect(seg(page, 'Operation', 'Decrypt')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#opt-symmetric-mode')).toHaveValue('ctr');
  await expect(out(page)).toContainText(PLAINTEXT);
  await expect(out(page)).toContainText('Mode: CTR');
});

test('the tool and its messages are translated (French)', async ({ page, baseURL }) => {
  await page.addInitScript(() => localStorage.setItem('ftf.locale', 'fr'));
  await open(page, baseURL);
  await expect(page.locator('h1')).toContainText('Chiffrements symétriques');
  await page
    .locator('.examples')
    .getByRole('button', { name: 'Essayer tous les modes avec une clé connue', exact: true })
    .click();
  await expect(out(page)).toContainText('Meilleure hypothèse : AES-128 CTR');
  await expect(out(page)).toContainText('Recherche locale sur les données fournies');
});
