import { readFileSync, readdirSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../core/errors';
import { defaultOptions, TOOLS } from '../../core/registry';
import { resultToText } from '../../core/result-text';
import type { AnyTool, Output, ToolResult } from '../../core/types';
import { toBase64, utf8Decode, utf8Encode } from '../../lib/bytes';
import { resetFetchMemory } from './_web-source-fetch';
import { BUNDLE_SECRET, HIDDEN_FILE, INLINE_SECRET, bundleMap } from './_web-source-fixtures';
import tool from './web-source';

const sampleBytes = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));
const sample = (name: string) => utf8Decode(sampleBytes(name));
const BUNDLE = sample('web-source-bundle.js');
const BUNDLE_MAP = sample('web-source-bundle.js.map');
const INLINE = sample('web-source-inline.js');
const mapFile = (name = 'web-source-bundle.js.map', text = BUNDLE_MAP) => ({
  bytes: utf8Encode(text),
  name,
});

async function run(input: string, opts: Record<string, unknown> = {}): Promise<ToolResult> {
  return tool.run(input, { ...defaultOptions(tool as unknown as AnyTool), ...opts } as never);
}

const blocks = <T extends Output['type']>(r: ToolResult, type: T) =>
  r.filter((o): o is Extract<Output, { type: T }> => o.type === type);
const table = (r: ToolResult, label: RegExp) => {
  const t = blocks(r, 'table').find((x) => label.test(x.label ?? ''));
  if (!t) throw new Error(`no table ${label}`);
  return t;
};
/** The rows of a table as records keyed by column name (the order of the columns is not tested). */
const records = (t: { columns: string[]; rows: (string | number)[][] }) =>
  t.rows.map(
    (row) =>
      Object.fromEntries(t.columns.map((c, i) => [c, row[i]!])) as Record<string, string | number>,
  );
const kv = (r: ToolResult) => new Map(blocks(r, 'kv').flatMap((o) => o.entries));
const notes = (r: ToolResult) => blocks(r, 'note').map((n) => n.text);
const flat = resultToText;

/** The answers of the three proxies, by what they were asked for. Records every request. */
function stubNetwork(answer: (proxy: string, target: string) => Response | null) {
  const calls: [string, string][] = [];
  const inits: RequestInit[] = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const u = new URL(input);
    const proxy = {
      'api.allorigins.win': 'allorigins',
      'corsproxy.io': 'corsproxy',
      'api.codetabs.com': 'codetabs',
    }[u.host];
    if (!proxy) throw new Error(`a request left for ${input}`);
    const target = u.searchParams.get('url') ?? u.searchParams.get('quest') ?? '';
    calls.push([proxy, target]);
    inits.push(init);
    const res = answer(proxy, target);
    if (!res) throw new TypeError('Failed to fetch');
    return res;
  });
  return { calls, inits };
}

beforeEach(() => resetFetchMemory());
afterEach(() => vi.unstubAllGlobals());

describe('the external map of a bundle (paste mode, map file given)', () => {
  it('discovers the reference, lists every source and finds the secret in the file nothing imports', async () => {
    const r = await run(BUNDLE, { map: mapFile() });
    const summary = kv(r);
    expect(summary.get('Type')).toBe('JavaScript');
    expect(summary.get('Origin')).toBe('Pasted');
    expect(summary.get('Source map')).toBe('From the file web-source-bundle.js.map');
    expect(summary.get('Sources')).toMatch(/^7 \(6 with content, /);

    const findings = table(r, /^Findings \(/);
    // What was found and its kind come first: the first columns of a table never wrap.
    expect(findings.columns).toEqual(['#', 'Found', 'Kind', 'Where', 'Detail', 'Context']);
    const hit = records(findings).find((row) => String(row.Found).includes(BUNDLE_SECRET))!;
    expect(hit).toBeDefined();
    expect(hit.Where).toBe(`${HIDDEN_FILE}:2:12`);
    expect(hit.Kind).toBe('Secret-like assignment');
    expect(hit.Detail).toBe('name: secret (in a comment)');
    expect(hit.Context).toBe(`// secret: ${BUNDLE_SECRET}`);
    expect(findings.highlight).toContain(Number(hit['#']) - 1);

    // Every source is in the table, the hidden one included, with its number of findings.
    const sources = table(r, /^Sources in the map/);
    expect(sources.columns).toEqual(['#', 'Bytes', 'Findings', 'Type', 'Source file']);
    const all = records(sources);
    expect(all.map((row) => row['Source file'])).toEqual(bundleMap().sources);
    expect(all.find((row) => row['Source file'] === HIDDEN_FILE)).toEqual({
      '#': 4,
      'Source file': HIDDEN_FILE,
      Bytes: 184,
      Type: 'Application',
      Findings: 1,
    });
    expect(all.find((row) => String(row['Source file']).includes('node_modules'))!.Type).toBe(
      'Dependency',
    );
    expect(all[6]!.Type).toBe('No content');
  });

  it('shows a tree of the paths, the preview with the match marked, and opens the hidden file as text', async () => {
    const r = await run(BUNDLE, { map: mapFile() });
    const tree = blocks(r, 'text').find((t) => t.label === 'Tree of the sources')!.value;
    expect(tree).toContain('└─ webpack://demo-shop/');
    expect(tree).toContain('SecretPanel.js  184 B · findings: 1');
    expect(tree).toContain('external "tiny-ui"  0 B · no content');
    const context = blocks(r, 'text').find((t) =>
      t.label?.startsWith('Findings in context'),
    )!.value;
    expect(context).toContain(`// secret: «${BUNDLE_SECRET}»`);
    const file = blocks(r, 'bytes').find((b) => b.label?.includes('SecretPanel.js'))!;
    expect(file.label).toBe(`#4 ${HIDDEN_FILE}`);
    expect(file.filename).toBe('SecretPanel.js');
    expect(utf8Decode(file.value)).toContain(`// secret: ${BUNDLE_SECRET}`);
    expect(utf8Decode(file.value)).toBe((bundleMap().sourcesContent as string[])[4]);
    // The application's files are open; the dependency is not (nothing in it, nothing to say).
    expect(blocks(r, 'bytes').map((b) => b.filename)).toEqual([
      'index.js',
      'App.js',
      'router.js',
      'Home.js',
      'SecretPanel.js',
    ]);
  });

  it('reminds that every source is reachable through the map, orphans included', async () => {
    const r = await run(BUNDLE, { map: mapFile() });
    expect(notes(r).join('\n')).toMatch(
      /component whose route is commented out in the router is reachable only through the map/,
    );
  });

  it('puts the hidden file first among the findings, and the commented-out route behind it', async () => {
    const r = await run(BUNDLE, { map: mapFile() });
    const rows = records(table(r, /^Findings \(/));
    expect(rows[0]!.Found).toBe(BUNDLE_SECRET);
    expect(rows.map((row) => row.Where)).toContain('webpack://demo-shop/./src/router.js:7:24');
  });

  it('lets the .map file be any name, and the input be only a reference', async () => {
    const r = await run(BUNDLE, { map: mapFile('whatever.map') });
    expect(kv(r).get('Source map')).toBe('From the file whatever.map');
    expect(flat(r)).toContain(BUNDLE_SECRET);
  });

  it('offers every source with content as one zip, byte for byte', async () => {
    const r = await run(BUNDLE, { map: mapFile() });
    const zip = blocks(r, 'files')[0]!.files[0]!;
    expect(zip.name).toBe('sources.zip');
    expect(zip.note).toBe('Files: 6');
    const files = unzipSync(zip.data);
    const contents = bundleMap().sourcesContent as (string | null)[];
    const names = Object.keys(files).sort();
    expect(names).toHaveLength(6);
    expect(utf8Decode(files['webpack/demo-shop/src/pages/Admin/SecretPanel.js']!)).toBe(
      contents[4],
    );
    expect(utf8Decode(files['webpack/demo-shop/node_modules/tiny-lib/index.js']!)).toBe(
      contents[5],
    );
  });
});

describe('a bundle alone, and a map as the input', () => {
  it('a bundle alone names the map it does not carry, and says nothing was requested', async () => {
    const r = await run(BUNDLE);
    expect(kv(r).get('Source map')).toBe(
      'Named in the script, not loaded: web-source-bundle.js.map',
    );
    expect(notes(r).join('\n')).toMatch(
      /names a source map, web-source-bundle\.js\.map.*Nothing was requested/s,
    );
    expect(flat(r)).not.toContain(BUNDLE_SECRET);
  });

  it('a .map pasted as the input is read directly', async () => {
    const r = await run(BUNDLE_MAP);
    expect(kv(r).get('Type')).toBe('Source map');
    expect(kv(r).get('Source map')).toBe('The input is itself a source map');
    expect(records(table(r, /^Findings/))[0]!.Where).toBe(`${HIDDEN_FILE}:2:12`);
    expect(kv(r).get('Generated file')).toBe('web-source-bundle.js');
    expect(kv(r).get('Map version')).toBe('3');
  });

  it('ignores a map file when the input is already a map, and says so', async () => {
    const r = await run(BUNDLE_MAP, {
      map: mapFile('other.map', '{"version":3,"sources":["x.js"],"sourcesContent":["secret = 1"]}'),
    });
    expect(notes(r).join('\n')).toMatch(/map is part of the input/);
    expect(flat(r)).toContain(BUNDLE_SECRET);
  });

  it('refuses a map that is cut off or is not a map', async () => {
    await expect(run(BUNDLE_MAP.slice(0, 500))).rejects.toThrow(/not valid JSON/);
    await expect(
      run(BUNDLE, { map: mapFile('bad.map', '{"name":"package.json"}') }),
    ).resolves.toBeDefined();
    const bad = await run(BUNDLE, { map: mapFile('bad.map', '{"name":"package.json"}') });
    expect(kv(bad).get('Source map')).toMatch(/^Could not be read: This JSON is not a source map/);
    expect(notes(bad).join('\n')).toMatch(/The source map could not be read/);
  });
});

describe('the map pasted under the script (one box)', () => {
  const both = `${BUNDLE}\n${BUNDLE_MAP}\n`;
  const PASTED = 'Pasted under the script, in the same box';

  it('reads the map that follows the bundle: same sources, same hit, and the text is the script', async () => {
    const r = await run(both);
    expect(kv(r).get('Type')).toBe('JavaScript');
    expect(kv(r).get('Source map')).toBe(PASTED);
    expect(kv(r).get('Sources')).toMatch(/^7 \(6 with content, /);
    const hit = records(table(r, /^Findings \(/)).find((row) =>
      String(row.Found).includes(BUNDLE_SECRET),
    )!;
    expect(hit.Where).toBe(`${HIDDEN_FILE}:2:12`);
    expect(notes(r).join('\n')).not.toMatch(/Nothing was requested/);
    // The size is the script's own: the map is not counted as part of it.
    expect(kv(r).get('Size')).toMatch(new RegExp(`^${utf8Encode(`${BUNDLE}\n`).length} B`));
  });

  it('gives the same findings as the map chosen as a file', async () => {
    const viaFile = records(table(await run(BUNDLE, { map: mapFile() }), /^Findings \(/));
    const pasted = records(table(await run(both), /^Findings \(/));
    expect(pasted).toEqual(viaFile);
  });

  it('wins over a map file, and says that the file option was not used', async () => {
    const other = mapFile(
      'other.map',
      '{"version":3,"sources":["x.js"],"sourcesContent":["a = 1"]}',
    );
    const r = await run(both, { map: other });
    expect(kv(r).get('Source map')).toBe(PASTED);
    expect(notes(r).join('\n')).toMatch(/map is part of the input/);
    expect(flat(r)).toContain(BUNDLE_SECRET);
  });

  it('does not cut a script that only ends with some JSON', async () => {
    const r = await run(`${BUNDLE}\n{"version":3,"name":"not a map"}\n`);
    expect(kv(r).get('Source map')).toBe(
      'Named in the script, not loaded: web-source-bundle.js.map',
    );
  });

  it('is only for pasted text: a fetched page is never cut', async () => {
    stubNetwork((proxy) =>
      proxy === 'allorigins' ? new Response(`${BUNDLE}\n${BUNDLE_MAP}`) : null,
    );
    const r = await run('https://ctf.example.test/static/app.js', { source: 'url', guess: false });
    expect(kv(r).get('Source map')).not.toBe(PASTED);
  });
});

describe('the map inlined as a data: URI', () => {
  it('decodes it on the spot, lists its sources and finds the secret with its file', async () => {
    const r = await run(INLINE);
    expect(kv(r).get('Source map')).toBe('Inlined in the script (data: URI)');
    expect(kv(r).get('Sources')).toMatch(/^2 \(2 with content, /);
    const hit = records(table(r, /^Findings \(/))[0]!;
    expect([hit.Where, hit.Kind, hit.Found]).toEqual([
      'webpack:///./src/config.js:1:30',
      'Secret-like assignment',
      `'${INLINE_SECRET}'`,
    ]);
    expect(hit.Detail).toBe('name: adminPassword');
    expect(blocks(r, 'bytes').map((b) => b.label)).toEqual([
      '#0 webpack:///./src/config.js',
      '#1 webpack:///./src/loader.js',
    ]);
    expect(blocks(r, 'text').find((t) => t.label === 'Tree of the sources')!.value).toBe(
      ['└─ webpack:///src/', '   ├─ config.js  76 B · findings: 1', '   └─ loader.js  81 B'].join(
        '\n',
      ),
    );
  });

  it('reports a data: URI that cannot be decoded, and still reads the script', async () => {
    const r = await run('var a=1;\n//# sourceMappingURL=data:application/json;base64,@@@@@@@@\n');
    expect(kv(r).get('Source map')).toMatch(/^Could not be read:/);
    expect(notes(r).join('\n')).toMatch(/The source map could not be read/);
  });
});

describe('indexed maps and maps without content', () => {
  const sections = JSON.stringify({
    version: 3,
    file: 'all.js',
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: {
          version: 3,
          sourceRoot: 'app',
          sources: ['a.js'],
          sourcesContent: ['const token = "sec-tok-1";'],
          mappings: 'AAAA',
        },
      },
      {
        offset: { line: 5, column: 0 },
        map: {
          version: 3,
          sources: ['b.js'],
          sourcesContent: ['// password: pw-from-b\n'],
          mappings: 'AAAA',
        },
      },
    ],
  });

  it('flattens the sections and scans each source', async () => {
    const r = await run(sections);
    expect(kv(r).get('Sections (indexed map)')).toBe('2');
    const rows = records(table(r, /^Findings/));
    expect(rows.map((row) => [row.Where, row.Found])).toEqual([
      ['app/a.js:1:15', '"sec-tok-1"'],
      ['b.js:1:14', 'pw-from-b'],
    ]);
  });

  it('says so when a map carries names and positions but no code', async () => {
    const r = await run('{"version":3,"sources":["a.js","b.js"],"names":[],"mappings":"AAAA"}');
    expect(notes(r).join('\n')).toMatch(
      /names its sources \(count: 2\) but carries none of their code/,
    );
    expect(table(r, /^Sources/).rows).toHaveLength(2);
    expect(blocks(r, 'bytes')).toEqual([]);
  });

  it('warns about a section that points to another map', async () => {
    const r = await run(
      JSON.stringify({
        version: 3,
        sections: [{ offset: { line: 0, column: 0 }, url: 'other.js.map' }],
      }),
    );
    expect(notes(r).join('\n')).toMatch(
      /points to another map, other\.js\.map, which is not loaded/,
    );
  });
});

describe('opening source files on request', () => {
  const many = JSON.stringify({
    version: 3,
    sources: Array.from({ length: 30 }, (_, i) => `src/file${i}.js`),
    sourcesContent: Array.from({ length: 30 }, (_, i) => `// file number ${i}\n`),
  });

  it('opens by number, by part of a path, and says when nothing matches or too much does', async () => {
    const byNumber = await run(many, { open: '#7 12' });
    expect(blocks(byNumber, 'bytes').map((b) => b.label)).toEqual([
      '#7 src/file7.js',
      '#12 src/file12.js',
    ]);
    const byName = await run(many, { open: 'file2' });
    expect(blocks(byName, 'bytes').map((b) => b.filename)).toEqual(
      ['file2.js', ...Array.from({ length: 10 }, (_, i) => `file2${i}.js`)].slice(0, 12),
    );
    const none = await run(many, { open: 'nothing-like-this' });
    expect(blocks(none, 'bytes')).toEqual([]);
    expect(notes(none).join('\n')).toMatch(/No source matches "nothing-like-this"/);
    const all = await run(many, { open: 'src' });
    expect(blocks(all, 'bytes')).toHaveLength(12);
    expect(notes(all).join('\n')).toMatch(/Showing 12 of the 30 sources that match/);
  });

  it('by default shows a bounded number of files and points to the option for the rest', async () => {
    const r = await run(many);
    expect(blocks(r, 'bytes')).toHaveLength(16);
    expect(notes(r).join('\n')).toMatch(/Showing 16 files; other files with content: 14/);
    expect(table(r, /^Sources/).rows).toHaveLength(30);
  });

  it('does not show a very large file by default, but opens it when asked', async () => {
    const big = JSON.stringify({
      version: 3,
      sources: ['big.js', 'small.js'],
      sourcesContent: [`var x = "${'a'.repeat(200_000)}";`, 'var y = 1;'],
    });
    expect(blocks(await run(big), 'bytes').map((b) => b.filename)).toEqual(['small.js']);
    expect(blocks(await run(big, { open: 'big' }), 'bytes').map((b) => b.filename)).toEqual([
      'big.js',
    ]);
  });
});

describe('dependencies', () => {
  const mixed = JSON.stringify({
    version: 3,
    sources: ['webpack://a/./src/app.js', 'webpack://a/./node_modules/lib/index.js'],
    sourcesContent: ['var ok = 1;', 'var password = "hunter22"; var f = "flag{in_a_lib}";'],
  });

  it('only get the strong checks by default, and every check when asked', async () => {
    const quiet = records(table(await run(mixed), /^Findings/)).map((r) => r.Found);
    expect(quiet).toEqual(['flag{in_a_lib}']);
    const all = records(table(await run(mixed, { deps: true }), /^Findings/)).map((r) => r.Found);
    expect(all).toContain('"hunter22"');
    expect(notes(await run(mixed)).join('\n')).toMatch(/Dependency files.*files: 1/);
  });
});

describe('Auto, Paste and URL', () => {
  it('Auto never fetches: a bare URL gets a suggestion and two buttons', async () => {
    const net = stubNetwork(() => new Response('should not be asked'));
    const r = await run('https://ctf.example.test/static/app.js');
    expect(net.calls).toEqual([]);
    expect(notes(r)[0]).toMatch(/only a URL.*nothing was requested/);
    const actions = blocks(r, 'actions')[0]!.actions;
    expect(actions.map((a) => [a.label, a.options])).toEqual([
      ['Fetch it through a public proxy', { source: 'url' }],
      ['Analyse it as text', { source: 'paste' }],
    ]);
    expect(actions[0]!.primary).toBe(true);
  });

  it('Paste reads even a bare URL as text, and nothing is requested', async () => {
    const net = stubNetwork(() => null);
    const r = await run('https://ctf.example.test/static/app.js', { source: 'paste' });
    expect(net.calls).toEqual([]);
    expect(kv(r).get('Origin')).toBe('Pasted');
    expect(
      blocks(r, 'actions').some((a) => a.actions.some((x) => x.options.source === 'url')),
    ).toBe(false);
  });

  it('URL mode with text that is not a single URL analyses it as text, with a note', async () => {
    const net = stubNetwork(() => null);
    const r = await run(BUNDLE, { source: 'url' });
    expect(net.calls).toEqual([]);
    expect(notes(r)[0]).toMatch(
      /Input is URL, but the text is not a single URL.*Nothing was requested/,
    );
    expect(kv(r).get('Type')).toBe('JavaScript');
  });

  it('URL mode refuses what it cannot fetch, before any request', async () => {
    const net = stubNetwork(() => null);
    for (const [input, message] of [
      ['ftp://a.test/x', /Only http and https/],
      ['example.test/app.js', /not a valid URL/],
      ['https://user:pw@a.test/x', /user name or password/],
      ['http://192.168.1.10/app.js', /private or local address/],
      ['http://localhost:8000/app.js', /private or local address/],
    ] as const) {
      await expect(run(input, { source: 'url' }), input).rejects.toThrow(message);
    }
    await expect(
      run('https://a.test/x', {
        source: 'url',
        allorigins: false,
        corsproxy: false,
        codetabs: false,
      }),
    ).rejects.toThrow(/at least one proxy/);
    expect(net.calls).toEqual([]);
  });
});

describe('URL mode (simulated proxies: no real network)', () => {
  const BASE = 'https://ctf.example.test/static/';
  const PAGE = `${BASE}web-source-bundle.js`;
  const served = (proxy: string, target: string): Response | null => {
    if (proxy === 'allorigins') return new Response('', { status: 200 });
    if (proxy === 'corsproxy' && target === PAGE) return new Response(BUNDLE);
    if (proxy === 'corsproxy' && target === `${PAGE}.map`) return new Response(BUNDLE_MAP);
    return null;
  };

  it('tries the proxies in order, reports why each failed and which worked, then fetches the map', async () => {
    const net = stubNetwork(served);
    const r = await run(PAGE, { source: 'url' });
    expect(net.calls).toEqual([
      ['allorigins', PAGE],
      ['corsproxy', PAGE],
      ['corsproxy', `${PAGE}.map`], // the proxy that worked is tried first for the map
    ]);
    const network = table(r, /^Network/);
    // The long request (a URL) is the last column: the first columns of a table never wrap.
    expect(network.columns).toEqual(['Proxy', 'Result', 'Detail', 'Request']);
    const attempts = records(network);
    expect(attempts.map((a) => [a.Proxy, a.Result, a.Request])).toEqual([
      ['allorigins.win', 'failed', `Page: ${PAGE}`],
      ['corsproxy.io', 'OK', `Page: ${PAGE}`],
      ['corsproxy.io', 'OK', `Source map: ${PAGE}.map`],
    ]);
    expect(attempts[0]!.Detail).toBe('empty answer');
    expect(attempts[1]!.Detail).toMatch(/^200 · \d+ B · \d+ ms$/);
    expect(network.highlight).toEqual([1, 2]);

    const summary = kv(r);
    expect(summary.get('Origin')).toBe(`Fetched from ${PAGE} through corsproxy.io`);
    expect(summary.get('Source map')).toBe(`Fetched from ${PAGE}.map`);
    const hit = records(table(r, /^Findings \(/))[0]!;
    expect(hit.Where).toBe(`${HIDDEN_FILE}:2:12`);
    expect(hit.Found).toBe(BUNDLE_SECRET);
    // The honest note about proxies comes with every URL-mode result.
    expect(notes(r).join('\n')).toMatch(
      /Fetching through a public proxy is fragile.*Its operator sees the URL and the page.*raw HTML.*Ctrl\+U/s,
    );
  });

  it('sends nothing but the three proxies are asked, the way the page promises', async () => {
    const net = stubNetwork(served);
    await run(PAGE, { source: 'url' });
    for (const init of net.inits) {
      expect(init).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    }
  });

  it('does not ask again when the tool runs again with the same input (a replay), only on "Fetch again"', async () => {
    const net = stubNetwork(served);
    await run(PAGE, { source: 'url' });
    expect(net.calls).toHaveLength(3);
    const replay = await run(PAGE, { source: 'url', deps: true }); // a changed option, same fetch
    expect(net.calls).toHaveLength(3);
    expect(notes(replay).join('\n')).toMatch(/No new request was made/);
    expect(kv(replay).get('Origin')).toMatch(/^From memory \(fetched earlier from /);
    const fetchAgain = blocks(replay, 'actions')
      .flatMap((a) => a.actions)
      .find((a) => a.label === 'Fetch again')!;
    expect(fetchAgain.options).toEqual({ refresh: '1' });
    await run(PAGE, { source: 'url', ...fetchAgain.options });
    expect(net.calls).toHaveLength(6);
    await run(PAGE, { source: 'url', ...fetchAgain.options }); // the same click replayed
    expect(net.calls).toHaveLength(6);
  });

  it('shows the failures and a way to try again when no proxy answers', async () => {
    const net = stubNetwork((proxy) =>
      proxy === 'allorigins'
        ? new Response('rate limited', { status: 429 })
        : proxy === 'corsproxy'
          ? new Response('', { status: 403 })
          : null,
    );
    const r = await run(PAGE, { source: 'url' });
    expect(net.calls.map((c) => c[0])).toEqual(['allorigins', 'corsproxy', 'codetabs']);
    const rows = records(table(r, /^Network/));
    expect(rows.map((row) => row.Detail)).toEqual([
      'answered HTTP 429',
      'answered HTTP 403',
      'network error (proxy down, request refused or blocked)',
    ]);
    const levels = blocks(r, 'note').map((n) => [n.level, n.text]);
    expect(levels.map((l) => l[0])).toEqual(['error', 'info', 'warn']);
    expect(levels[0]![1]).toMatch(/^No proxy returned the page\./);
    expect(levels[1]![1]).toMatch(/^Open the page in your browser, press Ctrl\+U \(view-source:\)/);
    expect(levels[2]![1]).toMatch(/^Fetching through a public proxy is fragile/);
    expect(blocks(r, 'actions')[0]!.actions.map((a) => [a.label, a.options])).toEqual([
      ['Try again', { refresh: '1' }],
    ]);
    // A replay does not call the proxies again.
    await run(PAGE, { source: 'url' });
    expect(net.calls).toHaveLength(3);
  });

  it('honours the proxies that were switched off', async () => {
    const net = stubNetwork((proxy, target) =>
      proxy === 'codetabs' && target === PAGE ? new Response('var a = 1;') : null,
    );
    await run(PAGE, { source: 'url', allorigins: false, corsproxy: false });
    expect(net.calls[0]).toEqual(['codetabs', PAGE]);
    expect(net.calls.every(([proxy]) => proxy === 'codetabs')).toBe(true); // the map too
  });

  it('finds a map next to a script that does not name one, only when asked to try', async () => {
    const script = 'var a = 1;\nvar b = "plain";\n';
    const guessed = stubNetwork((proxy, target) => {
      if (proxy !== 'allorigins') return null;
      if (target === `${BASE}plain.js`) return new Response(script);
      if (target === `${BASE}plain.js.map`) return new Response(BUNDLE_MAP);
      return null;
    });
    const r = await run(`${BASE}plain.js`, { source: 'url' });
    expect(guessed.calls).toEqual([
      ['allorigins', `${BASE}plain.js`],
      ['allorigins', `${BASE}plain.js.map`],
    ]);
    expect(kv(r).get('Source map')).toBe(`Found at the usual address ${BASE}plain.js.map`);
    expect(records(table(r, /^Network/))[1]!.Request).toBe(
      `Source map (usual address): ${BASE}plain.js.map`,
    );
    expect(flat(r)).toContain(BUNDLE_SECRET);

    resetFetchMemory();
    const off = stubNetwork((proxy, target) =>
      proxy === 'allorigins' && target === `${BASE}plain.js` ? new Response(script) : null,
    );
    await run(`${BASE}plain.js`, { source: 'url', guess: false });
    expect(off.calls).toEqual([['allorigins', `${BASE}plain.js`]]);
  });

  it('takes an HTML error page at the usual address for "no map"', async () => {
    stubNetwork((proxy, target) => {
      if (proxy !== 'allorigins') return null;
      return new Response(
        target.endsWith('.map') ? '<html><body>404 not found</body></html>' : 'var a = 1;',
      );
    });
    const r = await run(`${BASE}plain.js`, { source: 'url' });
    expect(kv(r).get('Source map')).toBe(
      `No reference in the input; ${BASE}plain.js.map was tried and has no map`,
    );
  });

  it('follows a map reference to another host, but never to a private address', async () => {
    const cdn = 'https://cdn.example.test/m/app.js.map';
    const net = stubNetwork((proxy, target) => {
      if (proxy !== 'allorigins') return null;
      if (target === `${BASE}a.js`) return new Response(`x();\n//# sourceMappingURL=${cdn}\n`);
      if (target === `${BASE}b.js`)
        return new Response('x();\n//# sourceMappingURL=http://192.168.0.5/internal.map\n');
      if (target === cdn) return new Response(BUNDLE_MAP);
      return null;
    });
    const a = await run(`${BASE}a.js`, { source: 'url' });
    expect(net.calls[1]).toEqual(['allorigins', cdn]);
    expect(flat(a)).toContain(BUNDLE_SECRET);
    const b = await run(`${BASE}b.js`, { source: 'url' });
    expect(net.calls.some((c) => c[1].includes('192.168.0.5'))).toBe(false);
    expect(kv(b).get('Source map')).toMatch(/private or local address/);
  });

  it('reports a map that could not be fetched, with advice, and still analyses the script', async () => {
    stubNetwork((proxy, target) =>
      proxy === 'allorigins' && target === PAGE ? new Response(BUNDLE) : null,
    );
    const r = await run(PAGE, { source: 'url' });
    expect(notes(r).join('\n')).toMatch(
      /The source map could not be fetched: .*web-source-bundle\.js\.map\. Many production builds do not ship a map/,
    );
    expect(kv(r).get('Type')).toBe('JavaScript');
    expect(
      records(table(r, /^Network/)).filter((row) => String(row.Request).startsWith('Source map')),
    ).toHaveLength(3);
  });

  it('reads a fetched HTML page: references resolved, comments, and the paths to try by hand', async () => {
    const html = [
      '<!doctype html><html><head><script src="/static/app.js"></script><link rel="stylesheet" href="css/site.css"></head>',
      '<body><!-- note to self: FTF{fetched_comment} --><a href="javascript:alert(1)">x</a></body></html>',
    ].join('\n');
    const net = stubNetwork((proxy) => (proxy === 'allorigins' ? new Response(html) : null));
    const r = await run('https://ctf.example.test/app/index.html', { source: 'url' });
    expect(net.calls).toHaveLength(1); // a page has no map to fetch
    const refs = table(r, /^References in the page/);
    expect(refs.columns).toEqual(['Tag', 'Attribute', 'Reference', 'Note']);
    expect(refs.rows).toEqual([
      ['script', 'src', '/static/app.js', 'resolves to https://ctf.example.test/static/app.js'],
      ['link', 'href', 'css/site.css', 'resolves to https://ctf.example.test/app/css/site.css'],
      ['a', 'href', 'javascript:alert(1)', 'javascript: URL, shown as text and never run'],
    ]);
    expect(flat(r)).toContain('FTF{fetched_comment}');
    const paths = blocks(r, 'text')
      .find((t) => t.label?.startsWith('Paths worth trying'))!
      .value.split('\n');
    expect(paths).toEqual([
      'https://ctf.example.test/robots.txt',
      'https://ctf.example.test/sitemap.xml',
      'https://ctf.example.test/.git/',
      'https://ctf.example.test/static/app.js.map',
    ]);
  });

  it('says that a page which only mounts an app is a shell, and what to do', async () => {
    stubNetwork((proxy) =>
      proxy === 'allorigins'
        ? new Response(
            '<html><body><div id="root"></div><script src="/main.js"></script></body></html>',
          )
        : null,
    );
    const r = await run('https://ctf.example.test/', { source: 'url' });
    expect(notes(r).join('\n')).toMatch(
      /shell of a JavaScript app.*raw HTML, not the page after they ran/s,
    );
  });
});

describe('an HTML page (paste mode)', () => {
  const PAGE = [
    '<!doctype html><html><head>',
    '<script src="app.js"></script><link href="style.css" rel="stylesheet">',
    '</head><body>',
    '<img src="/img/logo.png"><iframe src="/frame.html"></iframe>',
    '<!-- hidden: FTF{page_comment} -->',
    '<input type="hidden" name="api_token" value="tok-4417-demo">',
    '</body></html>',
  ].join('\n');

  it('lists scripts, links, images and frames, the comment as text, and the paths to try', async () => {
    const r = await run(PAGE);
    expect(kv(r).get('Type')).toBe('HTML page');
    const refs = table(r, /^References/);
    expect(refs.rows.map((row) => [row[0], row[1], row[2]])).toEqual([
      ['script', 'src', 'app.js'],
      ['link', 'href', 'style.css'],
      ['img', 'src', '/img/logo.png'],
      ['iframe', 'src', '/frame.html'],
    ]);
    const comments = blocks(r, 'text').find((t) => t.label?.startsWith('HTML comments'))!;
    expect(comments.value).toBe('Line 5:\nhidden: FTF{page_comment}');
    const paths = blocks(r, 'text').find((t) => t.label?.startsWith('Paths worth trying'))!;
    expect(paths.label).toBe('Paths worth trying by hand (this tool requests none of them)');
    expect(paths.value.split('\n')).toEqual([
      '/robots.txt',
      '/sitemap.xml',
      '/.git/',
      'app.js.map',
    ]);
    // The flag first (a flag, in a comment), then the token in the hidden field.
    expect(records(table(r, /^Findings/)).map((row) => row.Found)).toEqual([
      'FTF{page_comment}',
      'tok-4417-demo',
    ]);
  });
});

describe('everything is text', () => {
  const PAYLOADS = ['<img src=x onerror=alert(1)>', '</script><script>alert(1)</script>'];
  const KINDS = new Set(['text', 'bytes', 'table', 'kv', 'note', 'files', 'actions']);

  const strings = (r: ToolResult): string[] =>
    r.flatMap((o): string[] => {
      switch (o.type) {
        case 'text':
          return [o.value, o.label ?? ''];
        case 'bytes':
          return [utf8Decode(o.value), o.label ?? ''];
        case 'table':
          return [...o.rows.flat().map(String), ...o.columns, o.label ?? ''];
        case 'kv':
          return o.entries.flat();
        case 'note':
          return [o.text];
        case 'files':
          return o.files.map((f) => `${f.name} ${f.note ?? ''}`);
        case 'actions':
          return o.actions.map((a) => a.label);
        default:
          return [];
      }
    });

  for (const payload of PAYLOADS) {
    it(`${payload} comes out as plain strings in text-bearing blocks, unchanged`, async () => {
      const quoted = payload.replace(/"/g, "'");
      // Each of these puts the payload where the tool shows it back: a comment, a link, a
      // finding's context, a source name and its content.
      const echoing = [
        `<!doctype html><html><body><!-- ${payload} --></body></html>`,
        `<a href="${payload}">x</a>`,
        `var x = 1; // the password is ${payload}`,
        JSON.stringify({
          version: 3,
          sources: [payload],
          sourcesContent: [`var password = "${quoted}"; // ${payload}`],
        }),
      ];
      for (const input of echoing) {
        for (const source of ['auto', 'paste']) {
          const r = await run(input, { source });
          expect(
            r.every((o) => KINDS.has(o.type)),
            `${source}: ${input}`,
          ).toBe(true);
          const text = strings(r);
          expect(
            text.some((s) => s.includes(payload)),
            `${source}: ${input}`,
          ).toBe(true);
          // Not escaped, not altered: what the person sees is what was pasted.
          expect(text.join('\n')).not.toMatch(/&lt;|&gt;|&#/);
        }
      }
      // And on its own, as a page or as a script, it is only analysed.
      for (const source of ['auto', 'paste']) {
        const r = await run(payload, { source });
        expect(r.every((o) => KINDS.has(o.type))).toBe(true);
      }
    });
  }

  it('lists a javascript: link as text with a note, and never as anything else', async () => {
    const r = await run(
      '<a href="javascript:alert(1)">x</a><a href="data:text/html,<script>alert(1)</script>">y</a>',
    );
    const rows = table(r, /^References/).rows;
    expect(rows.map((row) => [row[2], row[3]])).toEqual([
      ['javascript:alert(1)', 'javascript: URL, shown as text and never run'],
      ['data:text/html,<script>alert(1)</script>', 'data: URI'],
    ]);
  });

  it('the page builds every node from text: no innerHTML, no markup parser, anywhere in src/ui', () => {
    const dir = new URL('../../ui/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      for (const banned of [
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
        'document.write',
        'DOMParser',
        'createContextualFragment',
        'srcdoc',
      ]) {
        expect(src.includes(banned), `${f} uses ${banned}`).toBe(false);
      }
    }
    const dom = readFileSync(new URL('dom.ts', dir), 'utf8');
    expect(dom).toContain('document.createTextNode(String(c))');
  });

  it('the analyzer itself never evaluates what it reads', () => {
    const dir = new URL('./', import.meta.url);
    const files = readdirSync(dir).filter(
      (f) => /^_?web-source(-.*)?\.ts$/.test(f) && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      expect(
        /\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(|setTimeout\s*\(\s*['"`]|import\s*\(\s*[^'")]/.test(
          src,
        ),
        f,
      ).toBe(false);
    }
  });
});

describe('links to other tools', () => {
  it('opens only tools that exist, with the text that matters', async () => {
    const r = await run(
      [
        `var hint = atob('${toBase64(utf8Encode('the answer is forty two'))}');`,
        'var code = String.fromCharCode(112, 97, 115, 115, 119, 111, 114, 100);',
        `var jwt = '${[b64('{"alg":"HS256"}'), b64('{"user":"admin"}'), 'c2ln'].join('.')}';`,
        'var s = "\\x68\\x65\\x6c\\x6c\\x6f\\x20\\x77";',
      ].join('\n'),
    );
    const actions = blocks(r, 'actions').flatMap((a) => a.actions);
    const byTool = new Map(actions.map((a) => [a.open?.tool, a.open?.text]));
    const ids = new Set(TOOLS.map((t) => t.id));
    for (const id of byTool.keys()) expect(ids.has(id!), String(id)).toBe(true);
    expect(byTool.get('base64')).toBe(toBase64(utf8Encode('the answer is forty two')));
    expect(byTool.get('charcode')).toBe('112,97,115,115,119,111,114,100');
    expect(byTool.get('unicode-escape')).toBe('\\x68\\x65\\x6c\\x6c\\x6f\\x20\\x77');
    expect(byTool.get('jwt')).toBe(
      [b64('{"alg":"HS256"}'), b64('{"user":"admin"}'), 'c2ln'].join('.'),
    );
    expect(byTool.has('strings')).toBe(true);
    expect(actions.find((a) => a.open?.tool === 'strings')!.label).toBe('Open in Strings');
    // The note names the tools and the deobfuscator, which is linked only when it exists.
    expect(notes(r).join('\n')).toMatch(
      /Related tools: Unicode escapes, Char codes, Base64, Strings\. .*JS deobfuscator \(js-deobfuscate\)/,
    );
    expect(byTool.has('js-deobfuscate')).toBe(ids.has('js-deobfuscate'));
  });
});

function b64(json: string): string {
  return toBase64(utf8Encode(json)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

describe('triage', () => {
  const detect = (text: string) => tool.detect?.({ text, bytes: utf8Encode(text) }) ?? null;

  it('recognises a source map, a script that names one, a page and a bare URL', () => {
    expect(detect(BUNDLE_MAP)).toMatchObject({ score: 0.9 });
    expect(detect(BUNDLE)).toMatchObject({ score: 0.85 });
    expect(detect(INLINE)).toMatchObject({ score: 0.85 });
    expect(detect('<!doctype html><html><body>x</body></html>')).toMatchObject({ score: 0.6 });
    expect(detect('https://ctf.example.test/app.js')).toMatchObject({ score: 0.4 });
  });

  it('stays quiet on ordinary text and short inputs', () => {
    expect(detect('hello world, nothing to see')).toBeNull();
    expect(detect('see https://a.test/app.js for details')).toBeNull();
    expect(detect('ab')).toBeNull();
  });

  it('is the forensics tool with a descriptive name in the registry', () => {
    expect(tool.category).toBe('forensics');
    expect(tool.name).toBe('Web source analyzer (HTML / JS / source maps)');
    expect(TOOLS.some((t) => t.id === 'web-source')).toBe(true);
    expect(tool.live).toBe(false);
  });
});

describe("errors are the user's to read", () => {
  it('an empty input is a ToolError', async () => {
    await expect(run('   \n ')).rejects.toBeInstanceOf(ToolError);
  });
});
