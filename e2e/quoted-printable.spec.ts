import { expect, test } from '@playwright/test';

// Quoted-printable / MIME words through the real UI, beyond the example buttons clicked by
// tools.spec.ts: a whole e-mail, the charset and strict options, encoding, and the home triage.

test('a whole e-mail: header words, body charset and the table of encoded words', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./#/tool/quoted-printable');
  await page
    .locator('.examples')
    .getByRole('button', { name: 'A whole e-mail (headers and body)', exact: true })
    .click();
  const out = page.locator('.pane-out');
  await expect(out).toContainText('Subject: Résumé du drapeau ✓');
  await expect(out).toContainText('FTF{qp_in_an_email}');
  await expect(out).toContainText('Voilà le drapeau que tu cherchais');
  await expect(out).toContainText('le signe = en fin de ligne');
  await expect(out.locator('table')).toContainText('UTF-8');
  await expect(out).toContainText('The body was read as utf-8');
  await expect(out.locator('.note-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the charset option: Latin-1 bytes read right, UTF-8 shown with a fallback note', async ({
  page,
}) => {
  await page.goto('./#/tool/quoted-printable');
  await page.locator('.input-text').fill('Caf=E9 cr=E8me');
  await expect(page.locator('.pane-out')).toContainText('Café crème');
  await expect(page.locator('.pane-out')).toContainText('Windows-1252');
  await page.locator('#opt-quoted-printable-charset').selectOption('utf-8');
  await expect(page.locator('.pane-out')).toContainText('Output is binary');
  await page.locator('#opt-quoted-printable-charset').selectOption('iso-8859-1');
  await expect(page.locator('.pane-out')).toContainText('Café crème');
});

test('strict mode names the line and column of an invalid escape', async ({ page }) => {
  await page.goto('./#/tool/quoted-printable');
  await page.locator('.input-text').fill('first line\nsecond =Zz line');
  await expect(page.locator('.pane-out')).toContainText('Invalid escapes kept as written: 1');
  await expect(page.locator('.pane-out')).toContainText('"=Zz" at line 2, column 8');
  await page.locator('.options').getByText('Strict').click();
  await expect(page.locator('.pane-out .note-error')).toContainText(
    'Invalid escape "=Zz" at line 2, column 8',
  );
});

test('encode a text, then an encoded word, then decode it again', async ({ page }) => {
  await page.goto('./#/tool/quoted-printable');
  await page.locator('.options').getByRole('button', { name: 'encode', exact: true }).click();
  await page.locator('.input-text').fill('Café: 5€ = cinq euros');
  const out = page.locator('.pane-out');
  await expect(out).toContainText('Caf=C3=A9: 5=E2=82=AC =3D cinq euros');
  await page.locator('.options').getByRole('button', { name: 'Encoded words (Q)' }).click();
  await expect(out).toContainText('=?UTF-8?Q?Caf=C3=A9=3A_5=E2=82=AC_=3D_cinq_euros?=');
  await out.locator('select.pipe').first().selectOption('auto-decode');
  await expect(page).toHaveURL(/#\/tool\/auto-decode/);
  await expect(page.locator('.pane-out')).toContainText('Café: 5€ = cinq euros');
});

test('home triage recognises a header with encoded words and a quoted-printable body', async ({
  page,
}) => {
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill('Subject: =?UTF-8?B?UsOpc3Vtw6k=?=');
  await expect(page.locator('.guess').first()).toContainText('Quoted-printable');
  await page.goto('./');
  await page.getByLabel('Paste data to identify').fill('Caf=C3=A9 cr=C3=A8me =E2=82=AC');
  const first = page.locator('.guess').first();
  await expect(first).toContainText('Quoted-printable');
  await first.click();
  await expect(page.locator('.pane-out')).toContainText('Café crème €');
});
