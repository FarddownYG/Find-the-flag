import { expect, test, type Page } from '@playwright/test';

// The Hill cipher tool through the real UI: typing the text and the key matrix by hand, the inverse
// and the reason a key has none, the known-plaintext key recovery and the 2 x 2 crack with their
// one-click decrypt. (The tool's own examples are clicked by tools.spec.ts like every other
// tool's.)

const out = (page: Page) => page.locator('.pane-out');
const seg = (page: Page, group: string, name: string) =>
  page.getByRole('group', { name: group }).getByRole('button', { name, exact: true });

/** Hill encryption written here independently of the tool: column vectors, A=0..Z=25, X padding. */
function hill(text: string, key: number[][]): string {
  const n = key.length;
  const v = [...text.toUpperCase().replace(/[^A-Z]/g, '')].map((c) => c.charCodeAt(0) - 65);
  while (v.length % n) v.push(23);
  let out = '';
  for (let at = 0; at < v.length; at += n) {
    for (const row of key) {
      const sum = row.reduce((s, k, j) => s + k * v[at + j]!, 0);
      out += String.fromCharCode(65 + (sum % 26));
    }
  }
  return out;
}

const MESSAGE =
  'Meet me at the north gate before the sun goes down and bring the green lantern, because the old keeper will only open the door for someone who knows the signal.';
const KEY2 = [
  [7, 8],
  [11, 11],
];
const CIPHER2 = hill(MESSAGE, KEY2);
const KEY3 = [
  [2, 4, 5],
  [9, 2, 1],
  [3, 17, 7],
];
const CIPHER3 = hill(MESSAGE, KEY3);

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
  await page.goto('./#/tool/hill');
  return { errors, offsite };
}

/** Type into a text or number option and leave it, so the change is taken before the next click. */
async function setOption(page: Page, id: string, value: string) {
  const box = page.locator(`#opt-hill-${id}`);
  await box.fill(value);
  await box.press('Tab');
}

test('encrypts with a keyword key and shows the matrix, its inverse and the working', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill('ACT');
  await seg(page, 'Mode', 'Encrypt').click();
  await setOption(page, 'key', 'GYBNQKURP');
  await expect(out(page)).toContainText('POH');
  await expect(out(page)).toContainText('Determinant: 25 (mod 26)');
  await expect(out(page)).toContainText('K × K⁻¹ = identity (mod 26)');
  const inverse = out(page).locator('section').filter({ hasText: 'Inverse matrix K⁻¹' });
  await expect(inverse.locator('tbody tr').nth(0)).toContainText('8');
  await expect(inverse.locator('tbody tr').nth(0)).toContainText('5');
  await expect(inverse.locator('tbody tr').nth(0)).toContainText('10');
  await expect(out(page)).toContainText('Working, block by block');
  // Decrypt with the same key: the inverse does the work.
  await page.locator('.input-text').fill('POH');
  await seg(page, 'Mode', 'Decrypt').click();
  await expect(out(page)).toContainText('ACT');
  await expect(out(page)).toContainText('K⁻¹ × vector');
  await expect(out(page).locator('.note-error')).toHaveCount(0);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('a key given as numbers, and the row convention', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill('JULY');
  await seg(page, 'Mode', 'Encrypt').click();
  await setOption(page, 'key', '[[11, 8], [3, 7]]');
  await expect(out(page)).toContainText('Keyword: LIDH');
  await expect(out(page)).not.toContainText('DELW');
  await seg(page, 'Vectors', 'Rows: C = P·K').click();
  await expect(out(page)).toContainText('DELW');
});

test('says why a key has no inverse instead of producing noise', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill('ABCD');
  await setOption(page, 'key', '2 4 6 8');
  const why = out(page).locator('.note-warn');
  await expect(why).toContainText('not invertible mod 26');
  await expect(why).toContainText('determinant is 18');
  await expect(why).toContainText('gcd(18, 26) = 2');
  await expect(out(page)).toContainText('Invertible: no');
  // Encrypting is still possible, with a warning.
  await seg(page, 'Mode', 'Encrypt').click();
  await expect(out(page).locator('.note-warn')).toContainText('nobody can decrypt it');
  await expect(out(page).locator('.note-error')).toHaveCount(0);
  // A prime modulus only fails on a zero determinant.
  await seg(page, 'Mode', 'Decrypt').click();
  await page.locator('#opt-hill-alphabet').selectOption('az29');
  await expect(out(page).locator('.note-error')).toHaveCount(0);
});

test('recovers a 3 x 3 key from known plaintext, then decrypts with it in one click', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill(CIPHER3);
  await seg(page, 'Mode', 'Recover the key').click();
  await setOption(page, 'size', '3');
  await setOption(page, 'known', 'MEETMEATTHENORTHGATE');
  await expect(out(page)).toContainText('Recovered the 3 × 3 key');
  await expect(out(page)).toContainText(`Numbers: ${KEY3.flat().join(' ')}`);
  await expect(out(page)).toContainText('MEETMEATTHENORTHGATEBEFORETHESUN');
  await out(page).getByRole('button', { name: 'Decrypt with this key' }).click();
  await expect(seg(page, 'Mode', 'Decrypt')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#opt-hill-key')).toHaveValue(KEY3.flat().join(' '));
  await expect(out(page)).toContainText('MEETMEATTHENORTHGATEBEFORETHESUN');
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('known plaintext that does not fit says so, and where it would', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(CIPHER2);
  await seg(page, 'Mode', 'Recover the key').click();
  // The real text starts at letter 1 ("EETMEATT..."), not at letter 0.
  await setOption(page, 'known', 'EETMEATTHENORTH');
  await expect(out(page).locator('.note-error')).toContainText(
    'No 2 × 2 matrix maps the known plaintext',
  );
  await expect(out(page)).toContainText('would fit if it started at letter 1');
  await setOption(page, 'offset', '1');
  await expect(out(page)).toContainText('Recovered the 2 × 2 key');
  await expect(out(page)).toContainText(`Numbers: ${KEY2.flat().join(' ')}`);
});

test('cracks a 2 x 2 Hill cipher with no key, then decrypts with the key it found', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill(CIPHER2);
  await seg(page, 'Mode', 'Crack 2×2').click();
  await expect(out(page)).toContainText('The result reads like English');
  await expect(out(page)).toContainText('MEETMEATTHENORTHGATEBEFORETHESUN');
  await expect(out(page)).toContainText(`Numbers: ${KEY2.flat().join(' ')}`);
  await expect(out(page)).toContainText('Matrices tried: 157248');
  await expect(out(page)).toContainText('Candidate keys, best first');
  await out(page).getByRole('button', { name: 'Decrypt with this key' }).click();
  await expect(seg(page, 'Mode', 'Decrypt')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#opt-hill-key')).toHaveValue(KEY2.flat().join(' '));
  await expect(out(page)).toContainText('MEETMEATTHENORTHGATEBEFORETHESUN');
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('the 3 x 3 cipher is out of reach of the crack, and the tool says so', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(CIPHER3);
  await seg(page, 'Mode', 'Crack 2×2').click();
  await expect(out(page)).toContainText('still does not read like English');
  await expect(out(page)).toContainText('Best guess (not reliable)');
  await expect(out(page)).toContainText('For a larger key, use known plaintext');
  await expect(out(page).locator('.note-success')).toHaveCount(0);
});
