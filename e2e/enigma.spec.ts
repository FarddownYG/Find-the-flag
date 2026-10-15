import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { SAMPLE_M3, U264 } from '../src/tools/crypto/_enigma-samples';

// Real use of the Enigma tool in the browser, beyond the example buttons: typing the message and
// the machine settings by hand, the "use this setting" button of the crib search, opening a file.

const out = (page: Page) => page.locator('.pane-out');
const seg = (page: Page, group: string, name: string) =>
  page.getByRole('group', { name: group }).getByRole('button', { name, exact: true });
const opt = (page: Page, key: string) => page.locator(`#opt-enigma-${key}`);
const m3Cipher = readFileSync(
  new URL(`../public/samples/${SAMPLE_M3.file}`, import.meta.url),
  'utf8',
);

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
  await page.goto('./#/tool/enigma');
  return { errors, offsite };
}

test('encrypts what is typed and follows the double step in the tables', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill('AAAAA');
  await expect(out(page)).toContainText('BDZGO');
  await expect(out(page)).toContainText('Encryption and decryption are the same operation');
  // From A D U the middle rotor steps twice in a row, and the third key turns the left rotor too.
  await opt(page, 'start').fill('A D U');
  await page.locator('.input-text').fill('AAA');
  await expect(out(page)).toContainText('Positions after the message: B F X');
  const steps = out(page).locator('table').filter({ hasText: 'Stepped' });
  await expect(steps.locator('tbody tr')).toHaveCount(3);
  await expect(steps.locator('tbody tr').nth(2)).toContainText('L M R*');
  await expect(steps.locator('tbody tr').nth(2)).toContainText('A E W');
  await expect(steps.locator('tbody tr').nth(2)).toContainText('B F X');
  // The path table has one row per key, ending on the lamp.
  const path = out(page).locator('table').filter({ hasText: 'Lamp' });
  await expect(path.locator('tbody tr')).toHaveCount(3);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('decrypts an M4 message from the machine settings typed by hand', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill(U264.cipher);
  await seg(page, 'Machine', 'M4').click();
  await opt(page, 'rotors').fill('Beta II IV I');
  await opt(page, 'rings').fill('A A A V');
  await opt(page, 'start').fill('V J N A');
  await opt(page, 'plugboard').fill(U264.settings.plugboard);
  await expect(out(page)).toContainText('VONV ONJL OOKS JHFF TTTE');
  await expect(out(page)).toContainText('Positions after the message: V J W Y');
  // Dropping the other characters and grouping by five rewrites the output.
  await seg(page, 'Other characters', 'Drop').click();
  await page.locator('.opt-bool input[type=checkbox]').check();
  await expect(out(page)).toContainText('VONVO NJLOO KSJHF');
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('says what is wrong with the plugboard or the rotors instead of showing a result', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill('HELLOWORLD');
  await opt(page, 'plugboard').fill('AB BC');
  await expect(out(page).locator('.note-error')).toContainText('two pairs');
  await opt(page, 'plugboard').fill('');
  await expect(out(page)).toContainText('ILBDAAMTAZ');
  await opt(page, 'rotors').fill('I II VI');
  await expect(out(page).locator('.note-error')).toContainText('only had rotors I to V');
  // Following the advice works.
  await seg(page, 'Machine', 'M3').click();
  await expect(out(page).locator('.note-error')).toHaveCount(0);
  await expect(out(page)).toContainText('Rotors (left to right): I II VI');
});

test('a crib search finds the setting and one click applies it', async ({ page, baseURL }) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill(m3Cipher);
  await seg(page, 'Mode', 'Crib search').click();
  await seg(page, 'Machine', 'M3').click();
  await opt(page, 'crib').fill('WETTERBERICHT');
  await expect(out(page)).toContainText('336 of 336', { timeout: 20_000 });
  await expect(out(page)).toContainText('Settings found: 1');
  await expect(out(page)).toContainText('bombe');
  await out(page).getByRole('button', { name: 'Use VII V II, start K C T' }).click();
  await expect(seg(page, 'Mode', 'Encrypt / decrypt')).toHaveAttribute('aria-pressed', 'true');
  await expect(opt(page, 'rotors')).toHaveValue('VII V II');
  await expect(opt(page, 'start')).toHaveValue('K C T');
  // The message is back in the clear (the groups of five of the sample are kept).
  await expect(out(page)).toContainText('WETTE RBERI CHTXP LANQU');
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('a crib at a place where a letter meets itself is refused with the reason', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(m3Cipher);
  await seg(page, 'Mode', 'Crib search').click();
  // The ciphertext starts with B: a crib starting with B cannot be at letter 1.
  await opt(page, 'crib').fill('BERICHT');
  await opt(page, 'cribPos').fill('1');
  await expect(out(page).locator('.note-error')).toContainText(
    'the Enigma never encrypts a letter to itself',
  );
  // Without a position it simply tries the other places.
  await opt(page, 'cribPos').fill('0');
  await expect(out(page).locator('.note-error')).toHaveCount(0);
  await expect(out(page)).toContainText('Rotor orders searched');
});

test('lists where a crib can sit and marks the places ruled out', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(m3Cipher);
  await seg(page, 'Mode', 'Crib positions').click();
  await opt(page, 'crib').fill('WETTERBERICHT');
  await expect(out(page)).toContainText('Places not ruled out: 65');
  await expect(out(page)).toContainText('Places ruled out: 42');
  await expect(out(page)).toContainText('ruled out (crib letter 8 = E)');
});

test('opens a text file and works on it', async ({ page, baseURL }) => {
  const w = await open(page, baseURL);
  await opt(page, 'rotors').fill(SAMPLE_M3.settings.rotors);
  await seg(page, 'Machine', 'M3').click();
  await opt(page, 'start').fill(SAMPLE_M3.settings.start);
  await page.locator('input[type=file]').setInputFiles({
    name: 'weather.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(m3Cipher),
  });
  await expect(out(page)).toContainText('WETTE RBERI CHTXP LANQU');
  await expect(out(page)).toContainText('Letters processed: 119');
  expect(w.errors).toEqual([]);
});

test('the tool and its messages are translated (French)', async ({ page, baseURL }) => {
  await page.addInitScript(() => localStorage.setItem('ftf.locale', 'fr'));
  await open(page, baseURL);
  await expect(page.locator('h1')).toContainText('Machine Enigma');
  await page
    .locator('.examples')
    .getByRole('button', { name: 'Vecteur de test : AAAAA', exact: true })
    .click();
  await expect(out(page)).toContainText('BDZGO');
  await expect(out(page)).toContainText('Positions après le message');
  await expect(out(page)).toContainText('Avance des rotors');
  await page
    .locator('.examples')
    .getByRole('button', { name: 'Recherche de mot probable : bulletin météo (M3)', exact: true })
    .click();
  await expect(out(page)).toContainText('336 sur 336');
  await expect(out(page)).toContainText('Limite à connaître');
});
