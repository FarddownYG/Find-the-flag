import { expect, test } from '@playwright/test';

// uuencode / xxencode through the real UI, beyond the example buttons clicked by tools.spec.ts:
// a file in a mail handed on to another tool, the options of both directions, honest errors.

test('a picture attached to a mail: name, mode and size, then on to File type', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/uuencode');
  await page
    .locator('.examples')
    .getByRole('button', { name: 'A picture attached to a mail', exact: true })
    .click();
  const out = page.locator('.pane-out');
  await expect(out).toContainText('demo.png');
  await expect(out).toContainText('644 (rw-r--r--)');
  await expect(out).toContainText('uuencode');
  await out.locator('select.pipe').first().selectOption('file-type');
  await expect(page).toHaveURL(/#\/tool\/file-type/);
  await expect(page.locator('.pane-out')).toContainText('PNG');
  expect(errors).toEqual([]);
});

test('encode with a name, a mode and xxencode, then decode what was written', async ({ page }) => {
  await page.goto('./#/tool/uuencode');
  const options = page.locator('.options');
  await options.getByRole('button', { name: 'encode', exact: true }).click();
  await page.locator('.input-text').fill('Cat');
  const out = page.locator('.pane-out');
  await expect(out).toContainText('begin 644 data.bin #0V%T');
  await page.locator('#opt-uuencode-name').fill('cat.txt');
  await page.locator('#opt-uuencode-fileMode').fill('600');
  await expect(out).toContainText('begin 600 cat.txt #0V%T');
  await options.getByRole('button', { name: 'xxencode', exact: true }).click();
  await expect(out).toContainText('begin 600 cat.txt 1Eq3o');
  await options.getByText('Begin / end lines').click();
  await expect(out).not.toContainText('begin');
  await expect(out).toContainText('1Eq3o');

  await options.getByRole('button', { name: 'decode', exact: true }).click();
  await page.locator('.input-text').fill('begin 600 cat.txt\n1Eq3o\n+\nend');
  await expect(out).toContainText('Cat');
  await expect(out).toContainText('xxencode');
  await expect(out).toContainText('600 (rw-------)');
});

test('a bad line is reported with its line and column, and short lines can be restored', async ({
  page,
}) => {
  await page.goto('./#/tool/uuencode');
  await page.locator('.input-text').fill('begin 644 x\n#0V%t\n`\nend');
  await expect(page.locator('.pane-out .note-error')).toContainText(
    'Line 2, column 5: "t" is not in the uuencode alphabet.',
  );
  // a line whose trailing blanks were stripped by a mail system
  await page.locator('.input-text').fill('begin 644 z\n*     0(#\n`\nend');
  await expect(page.locator('.pane-out .note-error')).toContainText(
    'says 10 bytes (16 characters), but the line has 8',
  );
  await page.locator('.options').getByText('Keep going on bad lines').click();
  await expect(page.locator('.pane-out .note-error')).toHaveCount(0);
  await expect(page.locator('.pane-out')).toContainText('10 B');
});

test('home triage recognises the begin line of a uuencoded file', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill('begin 644 cat.txt\n#0V%T\n`\nend');
  const first = page.locator('.guess').first();
  await expect(first).toContainText('uuencode');
  await first.click();
  await expect(page.locator('.pane-out')).toContainText('Cat');
});
