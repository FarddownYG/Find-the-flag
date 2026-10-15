import { expect, test, type Page } from '@playwright/test';

// The Bifid / Trifid tool through the real UI: typing the text, the key and the period by hand,
// the coordinates rows, the Trifid cube and the 27th symbol, and "Find the period" with its
// one-click decrypt. (The tool's own examples are clicked by tools.spec.ts like every other
// tool's.)

const out = (page: Page) => page.locator('.pane-out');
const seg = (page: Page, group: string, name: string) =>
  page.getByRole('group', { name: group }).getByRole('button', { name, exact: true });

/** 196 letters of made-up English, Bifid with the key "lighthouse" and period 7
 *  (node scripts/gen-samples-polygraphic.mjs bifid, the "bifid-period" line). */
const CIPHER =
  'LULRQCCOWUAIXFMOMCZVSMLGNSRRELULTQLBAESVEZPNCCCLGWMIFIYNUOCOXWIGILVKMIIICEHXFMLLNWZRUOEHPMZBUIETFPEUUTKSRIMWHNWLEINOSIPLSITQNFENNEVNKGLNUCVRMLOIZRZIOEQPVVWOBUIGWQCCROQTSANQKUWDEEDMVUOIZEYQENMLTRSR';

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
  await page.goto('./#/tool/bifid');
  return { errors, offsite };
}

test('encrypts typed text with a key and a period, and shows the coordinates rows', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill('Defend the east wall of the castle');
  await seg(page, 'Mode', 'Encrypt').click();
  await page.locator('#opt-bifid-key').fill('PHQGMEAYLNOFDXKRCVSZWBUTI');
  await page.locator('#opt-bifid-key').press('Tab');
  await page.locator('#opt-bifid-period').fill('5');
  await page.locator('#opt-bifid-period').press('Tab');
  await expect(out(page)).toContainText('FFYHMKHYCPLIASHADTRLHCCHLBLR');
  await expect(out(page)).toContainText('Coordinates, block by block');
  await expect(out(page)).toContainText('Cut into blocks of 5 letters (number of blocks: 6)');
  // The first block, DEFEN: rows 1 1 2 1 3, columns 3 3 5 3 2 - shown as lines of digits.
  const table = out(page).locator('table').filter({ hasText: 'Read in pairs' });
  await expect(table.locator('tbody tr').first()).toContainText('DEFEN');
  await expect(table.locator('tbody tr').first()).toContainText('FFYHM');
  await expect(out(page).locator('.note-error')).toHaveCount(0);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('Trifid swaps the square for a cube and asks for the 27th symbol', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await expect(page.locator('#opt-bifid-symbol')).toHaveCount(0);
  await seg(page, 'Cipher', 'Trifid (cube)').click();
  await expect(page.locator('#opt-bifid-symbol')).toHaveValue('+');
  await expect(page.locator('#opt-bifid-square')).toHaveCount(0);
  await page.locator('.input-text').fill('FMJFVOISSUFTFPUFEQQC');
  await page.locator('#opt-bifid-key').fill('felixmariedelastelle');
  await page.locator('#opt-bifid-key').press('Tab');
  await page.locator('#opt-bifid-period').fill('5');
  await page.locator('#opt-bifid-period').press('Tab');
  await expect(out(page)).toContainText('AIDETOILECIELTAIDERA');
  await expect(out(page)).toContainText('Key cube (layers 1 to 3)');
  await expect(out(page)).toContainText('Read in triples');
  // A letter is not a valid 27th symbol.
  await page.locator('#opt-bifid-symbol').fill('x');
  await page.locator('#opt-bifid-symbol').press('Tab');
  await expect(out(page).locator('.note-error')).toContainText('27th symbol');
});

test('finds the period of a message with a known key, then decrypts with it in one click', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill(CIPHER);
  await page.locator('#opt-bifid-key').fill('lighthouse');
  await page.locator('#opt-bifid-key').press('Tab');
  await seg(page, 'Mode', 'Find the period').click();
  await expect(out(page)).toContainText('Best guess: period 7');
  await expect(out(page)).toContainText('THESIGNALWASSENTATMIDNIGHT');
  await expect(out(page)).toContainText('ranked by how much they read like English');
  await out(page).getByRole('button', { name: 'Decrypt with period 7' }).click();
  await expect(seg(page, 'Mode', 'Decrypt')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#opt-bifid-period')).toHaveValue('7');
  await expect(out(page)).toContainText('THESIGNALWASSENTATMIDNIGHT');
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('a wrong period reads as noise, the right one as English', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(CIPHER);
  await page.locator('#opt-bifid-key').fill('lighthouse');
  await page.locator('#opt-bifid-key').press('Tab');
  await page.locator('#opt-bifid-period').fill('6');
  await page.locator('#opt-bifid-period').press('Tab');
  await expect(out(page).locator('.out-text').first()).not.toContainText('THESIGNALWAS');
  await page.locator('#opt-bifid-period').fill('7');
  await page.locator('#opt-bifid-period').press('Tab');
  await expect(out(page).locator('.out-text').first()).toContainText('THESIGNALWASSENTATMIDNIGHT');
});
