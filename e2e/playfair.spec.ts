import { expect, test, type Page } from '@playwright/test';

// The Playfair tool through the real UI: typing the text, the key and the options by hand, the
// squares and the working, a key search with no key and the one-click decrypt that follows.
// (The tool's own examples are clicked by tools.spec.ts like every other tool's.)

const out = (page: Page) => page.locator('.pane-out');
const seg = (page: Page, group: string, name: string) =>
  page.getByRole('group', { name: group }).getByRole('button', { name, exact: true });

/** 358 letters of made-up English, Playfair with the key "lantern light"
 *  (node scripts/gen-samples-polygraphic.mjs playfair, the "playfair-e2e" line). */
const CIPHER =
  'LQRUKWNZUAKLAMHKLUACARHBHKPOUTLSYHLIEHARTFGAININGANDELHLBGHLZYZTLIUPKFLIFTTUUHSEQLHKNMGIYHAGHBLSKQOIGAHNBTANDUESGLAMHZHAUTNCNTKPZASAHAUHLNDEOCPUYHBTBUSATKLIRUOBHKLZRAANBNHOINHKLBAMQLHKNUPEZXHABRANTFLEPTAFCNTPSYQCELIABGUQLBGAHNBTVCBAPTRUSEADBLQHRSYHPTAFNDVCRQNYELTEBDLBQLTVHKBMTDLBPKEPHBELIVRSITFDARUMAMHKLEPVLBTPLDBGACUKRAAMNTKPIDKAITNYHKTMTZITFALZLBMBLTRVYH';
const PLAIN_START = 'NOBODYEXPECTEDTHEOLDLIGHTHOUSETOSTARTBLINKINGAGAINAFTERTHIRTY';

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
  await page.goto('./#/tool/playfair');
  return { errors, offsite };
}

test('encrypts a typed sentence, with the square and the working pair by pair', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill('Hide the gold in the tree stump');
  await seg(page, 'Mode', 'Encrypt').click();
  await page.locator('#opt-playfair-key').fill('playfair example');
  await expect(out(page)).toContainText('BMODZBXDNABEKUDMUIXMMOUVIF');
  await expect(out(page)).toContainText('HI DE TH EG OL DI NT HE TR EX ES TU MP');
  await expect(out(page)).toContainText('Doubled letters split with a filler (1): EE → EXE');
  // The square is shown as a table, the working has one row per pair with its rule.
  await expect(out(page).locator('table').first()).toContainText('PLAYF');
  await expect(out(page)).toContainText('same column: each letter moves one place down');
  await expect(out(page)).toContainText('rectangle: take the other two corners');
  await expect(out(page).locator('.note-error')).toHaveCount(0);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('the filler, the square and the grouping can be changed', async ({ page, baseURL }) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill('balloon');
  await seg(page, 'Mode', 'Encrypt').click();
  await page.locator('#opt-playfair-key').fill('monarchy');
  await expect(out(page)).toContainText('IBSUPMNA');
  await page.locator('#opt-playfair-filler').fill('z');
  await expect(out(page)).toContainText('BA LZ LO ON');
  await page.locator('#opt-playfair-groups').selectOption('pairs');
  await page.locator('#opt-playfair-filler').fill('x');
  await expect(out(page)).toContainText('IB SU PM NA');
  // With the 6 x 6 square, numbers are part of the message.
  await page.locator('#opt-playfair-square').selectOption('digits');
  await page.locator('.input-text').fill('Meet at 9');
  await expect(out(page)).toContainText('ME ET AT 9X');
});

test('four-square and the two-squares take a second key and show their squares', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill('HELPMEOBIWANKENOBI');
  await seg(page, 'Mode', 'Encrypt').click();
  await page.locator('#opt-playfair-variant').selectOption('four-square');
  await page.locator('#opt-playfair-key').fill('example');
  await page.locator('#opt-playfair-key2').fill('keyword');
  await page.locator('#opt-playfair-key2').press('Tab'); // leave the text box before using a menu
  await expect(out(page)).toContainText('FYNFNEHWBXAFFOKHMD');
  await expect(out(page)).toContainText('top-left and bottom-right = alphabet');
  await page.locator('#opt-playfair-variant').selectOption('two-horizontal');
  await expect(out(page)).toContainText('GXAOEMQLIAERGMLPBH');
  await expect(out(page)).toContainText('same row: the two letters trade places');
  // The other order some sources use is one tick away.
  await page.getByLabel('Swap the letters of each ciphertext pair').check();
  await expect(out(page)).toContainText('XGOAMELQAIREMGPLHB');
  // And decrypting it back gives the message.
  await seg(page, 'Mode', 'Decrypt').click();
  await page.locator('.input-text').fill('XGOAMELQAIREMGPLHB');
  await expect(out(page)).toContainText('HELPMEOBIWANKENOBI');
});

test('decrypting says what is odd about the text instead of guessing', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill('BMODZBXDNABEKUDMUIXMMOUVI');
  await page.locator('#opt-playfair-key').fill('playfair example');
  await expect(out(page)).toContainText('HIDETHEGOLDINTHETREXESTUMP'.slice(0, -2));
  await expect(out(page)).toContainText('odd number of letters (25)');
  await page.locator('.input-text').fill('BMODZBXDNABEKUDMUIXMOOUVIF');
  await expect(out(page)).toContainText('Pairs with two equal letters: 1 (first: OO)');
});

test('finds the key with no key, then decrypts with it in one click', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const w = await open(page, baseURL);
  await page.locator('.input-text').fill(CIPHER);
  await seg(page, 'Mode', 'Find the key').click();
  const result = out(page);
  await expect(result).toContainText('The result reads like English', { timeout: 60_000 });
  await expect(result.locator('.out-text').first()).toContainText(PLAIN_START);
  await expect(result).toContainText('Shortest keyword: LANTERIGH');
  await expect(result).toContainText('Best keys');
  await expect(result).toContainText('Restart');
  await expect(result.locator('.note-error')).toHaveCount(0);

  await result.getByRole('button', { name: 'Decrypt with this key' }).click();
  await expect(seg(page, 'Mode', 'Decrypt')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#opt-playfair-key')).toHaveValue('LANTERIGHBCDFKMOPQSUVWXYZ');
  await expect(result.locator('.out-text').first()).toContainText(PLAIN_START);
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('says so when there is no key to find, instead of showing noise as a result', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000);
  await open(page, baseURL);
  await seg(page, 'Mode', 'Find the key').click();
  await seg(page, 'Search effort', 'Quick').click();
  // The alphabet in order, over and over: no language in it.
  await page.locator('.input-text').fill('ABCDEFGHIKLMNOPQRSTUVWXYZ'.repeat(12));
  await expect(out(page)).toContainText('No convincing English found', { timeout: 60_000 });
  await expect(out(page)).toContainText('Best guess (not reliable)');
  await expect(out(page).locator('.note-success')).toHaveCount(0);
});

test('refuses the key search for the other ciphers, with the way out', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await page.locator('.input-text').fill(CIPHER);
  await seg(page, 'Mode', 'Find the key').click();
  await page.locator('#opt-playfair-variant').selectOption('four-square');
  await expect(out(page).locator('.note-error')).toContainText('works on Playfair only');
});
