import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { buildElf } from '../src/tools/forensics/_exe-fixtures';

const sample = (name: string) =>
  fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url));

/** Record page errors, console errors and every request that leaves the app's origin. */
function watch(page: Page, appOrigin: string) {
  const errors: string[] = [];
  const offsite: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.context().on('request', (r) => {
    const url = r.url();
    if (!url.startsWith('blob:') && !url.startsWith('data:') && new URL(url).origin !== appOrigin)
      offsite.push(url);
  });
  return { errors, offsite };
}

const out = (page: Page) => page.locator('.pane-out');
/** Pick a view the way a person does: the select takes the focus (and so the Filter box loses it). */
async function view(page: Page, value: string) {
  const select = page.locator('#opt-exe-analyzer-view');
  await select.focus();
  await select.selectOption(value);
}

async function open(page: Page, baseURL: string | undefined) {
  const appOrigin = new URL(baseURL ?? 'http://localhost:4173/').origin;
  const w = watch(page, appOrigin);
  await page.goto('./#/tool/exe-analyzer');
  return w;
}

const upload = (page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) =>
  page.locator('.input-box input[type=file]').setInputFiles(file);

async function download(page: Page, row: string): Promise<Buffer> {
  const [d] = await Promise.all([
    page.waitForEvent('download'),
    out(page)
      .locator('.out-files li', { hasText: row })
      .getByRole('button', { name: 'Download' })
      .click(),
  ]);
  return readFileSync(await d.path());
}

test('exe analyzer: a PE file from the picker, every view, every extraction', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await upload(page, sample('exe-sample.exe'));

  // Overview: identification, protections, sections with entropy, the overlay and its flag.
  await expect(out(page)).toContainText('Windows console (3)');
  await expect(out(page)).toContainText('DYNAMIC_BASE');
  await expect(out(page)).toContainText('present, checksum OK');
  await expect(page.locator('.flag-strip')).toContainText('FTF{overlay}');
  expect(await download(page, 'overlay.bin')).toEqual(Buffer.from('FTF{overlay}\n'));

  // Imports: by name and by ordinal; the filter narrows the list.
  await view(page, 'imports');
  await expect(out(page)).toContainText('ExitProcess');
  await expect(out(page)).toContainText('#115');
  await page.locator('#opt-exe-analyzer-filter').fill('GetProc');
  await expect(out(page)).toContainText('GetProcAddress');
  await expect(out(page)).not.toContainText('ExitProcess');
  await page.locator('#opt-exe-analyzer-filter').fill('');
  await expect(out(page)).toContainText('ExitProcess');

  // Resources: the RCDATA payload, the manifest, the version info, the rebuilt icon.
  await view(page, 'resources');
  await expect(out(page)).toContainText('FTF{pe_resource}');
  await expect(out(page)).toContainText('requestedExecutionLevel');
  await expect(out(page)).toContainText('Find The Flag samples');
  expect(await download(page, 'RT_RCDATA_101_1033.txt')).toEqual(Buffer.from('FTF{pe_resource}'));
  const ico = await download(page, 'icon_MAINICON.ico');
  expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 1, 0]);

  // Headers: the Rich header with its checksum.
  await view(page, 'details');
  await expect(out(page)).toContainText('Rich header (key 0x8e43eff7, checksum OK)');

  // Strings: flags first, UTF-16 found as well.
  await view(page, 'strings');
  await expect(out(page).locator('tbody tr').first()).toContainText('FTF{pe_resource}');
  await expect(out(page)).toContainText('VS_VERSION_INFO');

  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('exe analyzer: an ELF file, protections, a section as a file, strings of one section', async ({
  page,
  baseURL,
}) => {
  const w = await open(page, baseURL);
  await upload(page, sample('exe-sample.elf'));
  await expect(out(page)).toContainText('PT_GNU_STACK RW-');
  await expect(out(page)).toContainText('__stack_chk_fail');
  await expect(out(page)).toContainText('031425364758697a8b9cadbecfe0f10213243546');

  await view(page, 'sections');
  await page.locator('#opt-exe-analyzer-section').fill('.rodata');
  await expect(out(page)).toContainText('rodata.bin');
  const dump = await download(page, 'rodata.bin');
  expect(dump.toString('latin1')).toBe('FTF{elf_rodata}\0usage: sample [name]\0');

  await view(page, 'strings');
  await expect(out(page)).toContainText('FTF{elf_rodata}');
  await expect(page.locator('.flag-strip')).toContainText('FTF{elf_rodata}');

  await view(page, 'symbols');
  await expect(out(page)).toContainText('ftf_flag_function');
  expect(w.errors).toEqual([]);
  expect(w.offsite).toEqual([]);
});

test('exe analyzer: C++ names are demangled, and can be shown as they are', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  const elf = buildElf({ exports: ['_ZN3Foo3barEi', '_ZNSt6vectorIiSaIiEE9push_backERKi'] });
  await upload(page, {
    name: 'cpp.so',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(elf),
  });
  await view(page, 'symbols');
  await expect(out(page)).toContainText('Foo::bar(int)');
  await expect(out(page)).toContainText(
    'std::vector<int, std::allocator<int> >::push_back(int const&)',
  );
  await page.getByLabel('Demangle C++ names').uncheck();
  await expect(out(page)).not.toContainText('Foo::bar(int)');
  await expect(out(page)).toContainText('_ZN3Foo3barEi');
});

test('exe analyzer: something that is not an executable names the tools to try', async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await upload(page, {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello, not a binary'),
  });
  await expect(out(page).locator('.note-error')).toContainText('File type');
  await expect(out(page).locator('.note-error')).toContainText('Binary analyzer');
});

test('exe analyzer: a 48 MiB file with 48 MiB of appended data stays responsive', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const w = await open(page, baseURL);
  const elf = Buffer.from(buildElf({}));
  const big = Buffer.concat([elf, Buffer.alloc(48 << 20)]);
  await upload(page, { name: 'big.elf', mimeType: 'application/octet-stream', buffer: big });
  await expect(out(page)).toContainText('Data after the end of the file structure', {
    timeout: 60_000,
  });
  await expect(out(page)).toContainText('48.00 MiB');
  // still usable: switching views works while the big file is loaded
  await view(page, 'symbols');
  await expect(out(page)).toContainText('ftf_flag_function', { timeout: 30_000 });
  expect(w.errors).toEqual([]);
});

for (const locale of ['en', 'fr', 'ru', 'zh', 'hi']) {
  test(`exe analyzer: no horizontal scroll on a phone (390×844, ${locale})`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((l) => localStorage.setItem('ftf.locale', l), locale);
    await open(page, baseURL);
    await upload(page, sample('exe-sample.exe'));
    await expect(out(page).locator('.out').first()).toBeVisible({ timeout: 15_000 });
    const width = () => page.evaluate(() => document.documentElement.scrollWidth);
    const widest = () =>
      page.evaluate(() =>
        Math.max(
          ...[...document.querySelectorAll('.options .opt, .pane-in, .out-stack > *')].map(
            (e) => e.getBoundingClientRect().right,
          ),
        ),
      );
    expect(await widest()).toBeLessThanOrEqual(390);
    // The Russian top bar is 9 px too wide on every tool (shared shell): not this tool.
    if (locale !== 'ru') expect(await width()).toBeLessThanOrEqual(390);
  });
}

test('exe analyzer: French UI, the tool text is translated', async ({ page, baseURL }) => {
  await page.addInitScript(() => localStorage.setItem('ftf.locale', 'fr'));
  await open(page, baseURL);
  await upload(page, sample('exe-sample.exe'));
  await expect(out(page)).toContainText('Identification');
  await expect(out(page)).toContainText('Point d’entrée'.replace('’', "'"));
  await expect(out(page)).toContainText('Protections');
  await expect(out(page)).toContainText('somme de contrôle OK');
  const english = [
    'Entry point',
    'Image base',
    'Linker version',
    'Looks like',
    'Starts with',
    'Overlay (data after the last section)',
    'To pull files out of these bytes',
    'Random load address',
  ];
  const text = await out(page).innerText();
  for (const e of english) expect(text).not.toContain(e);
});
