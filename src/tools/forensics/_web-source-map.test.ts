import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { toBase64, utf8Decode, utf8Encode } from '../../lib/bytes';
import {
  BUNDLE_SECRET,
  HIDDEN_FILE,
  INLINE_SECRET,
  bundleMap,
  buildBundleMapJson,
  buildSamples,
  inlineMap,
} from './_web-source-fixtures';
import {
  baseName,
  drawTree,
  findMapRef,
  guessMapUrl,
  looksLikeMap,
  parseSourceMap,
  pathParts,
  resolveRef,
  safePath,
  splitCombined,
  utf8Length,
  zipSources,
  type MapSource,
} from './_web-source-map';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

describe('findMapRef: the reference in a script', () => {
  it('reads //# sourceMappingURL= at the end', () => {
    expect(findMapRef('var a=1;\n//# sourceMappingURL=app.js.map\n')).toEqual({
      kind: 'external',
      ref: 'app.js.map',
    });
  });

  it('reads the legacy //@ form and the stylesheet form', () => {
    expect(findMapRef('a();\n//@ sourceMappingURL=old.js.map')).toEqual({
      kind: 'external',
      ref: 'old.js.map',
    });
    expect(findMapRef('a{b:c}\n/*# sourceMappingURL=style.css.map */')).toEqual({
      kind: 'external',
      ref: 'style.css.map',
    });
  });

  it('keeps the last reference, as browsers do', () => {
    const src = '//# sourceMappingURL=first.map\ncode();\n//# sourceMappingURL=second.map\n';
    expect(findMapRef(src)).toEqual({ kind: 'external', ref: 'second.map' });
  });

  it('accepts a comment that follows code on its line when it is near the end', () => {
    expect(findMapRef('a();//# sourceMappingURL=glued.js.map')).toEqual({
      kind: 'external',
      ref: 'glued.js.map',
    });
  });

  it('prefers a comment on its own line over a mention in the middle of a bundle', () => {
    const middle = 'var doc = "see //# sourceMappingURL=docs-only.map for details";';
    const src = `${middle}\n${'x();\n'.repeat(2000)}//# sourceMappingURL=real.js.map\n`;
    expect(findMapRef(src)).toEqual({ kind: 'external', ref: 'real.js.map' });
  });

  it('ignores a mention in the middle when nothing real is at the end', () => {
    const src = `var doc = "//# sourceMappingURL=docs-only.map";${'x();\n'.repeat(2000)}`;
    expect(findMapRef(src)).toBeNull();
  });

  it('returns null when there is no reference', () => {
    expect(findMapRef('console.log(1)')).toBeNull();
    expect(findMapRef('// sourceMappingURL is mentioned but not as a directive')).toBeNull();
  });

  it('decodes an inline base64 data: URI, with or without a charset', () => {
    const json = JSON.stringify({ version: 3, sources: ['a.js'], sourcesContent: ['é'] });
    const b64 = toBase64(utf8Encode(json));
    for (const meta of ['application/json;base64', 'application/json;charset=utf-8;base64']) {
      const ref = findMapRef(`x();\n//# sourceMappingURL=data:${meta},${b64}`);
      expect(ref).toEqual({ kind: 'inline', json, encoding: 'base64' });
    }
  });

  it('decodes an inline data: URI that is percent-encoded', () => {
    const json = '{"version":3,"sources":["a.js"]}';
    const ref = findMapRef(
      `x();\n//# sourceMappingURL=data:application/json,${encodeURIComponent(json)}`,
    );
    expect(ref).toEqual({ kind: 'inline', json, encoding: 'percent' });
  });

  it('reports an inline map that cannot be decoded instead of throwing', () => {
    const bad64 = findMapRef('x();\n//# sourceMappingURL=data:application/json;base64,@@@@@@@@');
    expect(bad64?.kind).toBe('inline-bad');
    const badPct = findMapRef('x();\n//# sourceMappingURL=data:application/json,%E0%A4%A');
    expect(badPct?.kind).toBe('inline-bad');
    expect(findMapRef('x();\n//# sourceMappingURL=data:application/json;base64')?.kind).toBe(
      'inline-bad',
    );
  });
});

describe('resolveRef and guessMapUrl', () => {
  it('resolves a relative reference against the address of the script', () => {
    expect(resolveRef('app.js.map', 'https://site.test/static/js/app.js')).toEqual({
      ok: true,
      url: 'https://site.test/static/js/app.js.map',
    });
    expect(resolveRef('../maps/app.map', 'https://site.test/static/js/app.js')).toEqual({
      ok: true,
      url: 'https://site.test/static/maps/app.map',
    });
    expect(resolveRef('/m/app.map', 'https://site.test/static/js/app.js')).toEqual({
      ok: true,
      url: 'https://site.test/m/app.map',
    });
    expect(resolveRef('https://cdn.test/app.map#frag', 'https://site.test/a.js')).toEqual({
      ok: true,
      url: 'https://cdn.test/app.map',
    });
  });

  it('cannot resolve a bare file name when the script address is unknown', () => {
    expect(resolveRef('app.js.map', null)).toEqual({ ok: false, reason: 'relative' });
    expect(resolveRef('https://cdn.test/x.map', null)).toEqual({
      ok: true,
      url: 'https://cdn.test/x.map',
    });
  });

  it('refuses anything that is not http or https', () => {
    expect(resolveRef('webpack://app/x.map', 'https://site.test/a.js')).toEqual({
      ok: false,
      reason: 'scheme',
    });
    expect(resolveRef('file:///etc/x.map', null)).toEqual({ ok: false, reason: 'scheme' });
    expect(resolveRef('http://', 'https://site.test/a.js')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('guesses <script>.map on the same origin, without query or fragment', () => {
    expect(guessMapUrl('https://site.test/static/app.js?v=3#x')).toBe(
      'https://site.test/static/app.js.map',
    );
  });
});

describe('parseSourceMap', () => {
  const map = (o: Record<string, unknown>) => JSON.stringify({ version: 3, ...o });

  it('lists sources with their content, sizes in UTF-8 bytes', () => {
    const m = parseSourceMap(
      map({
        file: 'out.js',
        sources: ['a.js', 'b/c.js', 'd.js'],
        sourcesContent: ['é', 'x\ny', null],
        names: ['p', 'q'],
        mappings: 'AAAA',
      }),
    );
    expect(m.version).toBe(3);
    expect(m.file).toBe('out.js');
    expect(m.names).toBe(2);
    expect(m.mappingsChars).toBe(4);
    expect(m.sources.map((s) => [s.index, s.path, s.content, s.bytes])).toEqual([
      [0, 'a.js', 'é', 2],
      [1, 'b/c.js', 'x\ny', 3],
      [2, 'd.js', null, 0],
    ]);
    expect(m.warnings).toEqual([]);
  });

  it('applies sourceRoot to relative names only', () => {
    const rooted = (root: string) =>
      parseSourceMap(
        map({
          sourceRoot: root,
          sources: ['a.js', '/abs.js', 'webpack://p/b.js'],
          sourcesContent: [],
        }),
      ).sources.map((s) => s.path);
    expect(rooted('src')).toEqual(['src/a.js', '/abs.js', 'webpack://p/b.js']);
    expect(rooted('src/')).toEqual(['src/a.js', '/abs.js', 'webpack://p/b.js']);
    expect(rooted('')).toEqual(['a.js', '/abs.js', 'webpack://p/b.js']);
    expect(parseSourceMap(map({ sourceRoot: 'src', sources: ['a.js'] })).sourceRoot).toBe('src');
    // The original name is kept next to the joined one.
    expect(parseSourceMap(map({ sourceRoot: 'src', sources: ['a.js'] })).sources[0]!.original).toBe(
      'a.js',
    );
  });

  it('tolerates a null name, a short sourcesContent and non-string content', () => {
    const m = parseSourceMap(map({ sources: ['a.js', null, 'c.js'], sourcesContent: ['A', 5] }));
    expect(m.sources.map((s) => [s.path, s.content])).toEqual([
      ['a.js', 'A'],
      ['', null],
      ['c.js', null],
    ]);
  });

  it('flattens the sections of an indexed map, each with its own sourceRoot', () => {
    const m = parseSourceMap(
      JSON.stringify({
        version: 3,
        file: 'bundle.js',
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: {
              version: 3,
              sourceRoot: 'one',
              sources: ['a.js'],
              sourcesContent: ['AAA'],
              mappings: 'AAAA',
            },
          },
          {
            offset: { line: 10, column: 0 },
            map: {
              version: 3,
              sources: ['b.js', 'c.js'],
              sourcesContent: ['BBB', 'CCC'],
              names: ['n'],
              mappings: 'AA',
            },
          },
          { offset: { line: 20, column: 0 }, url: 'other.js.map' },
        ],
      }),
    );
    expect(m.sections).toBe(3);
    expect(m.sources.map((s) => [s.index, s.section, s.path, s.content])).toEqual([
      [0, 0, 'one/a.js', 'AAA'],
      [1, 1, 'b.js', 'BBB'],
      [2, 1, 'c.js', 'CCC'],
    ]);
    expect(m.names).toBe(1);
    expect(m.mappingsChars).toBe(6);
    expect(m.warnings).toEqual([{ code: 'sectionUrl', arg: 'other.js.map' }]);
  });

  it('stops following nested sections beyond a small depth', () => {
    let nested: Record<string, unknown> = {
      version: 3,
      sources: ['deep.js'],
      sourcesContent: ['x'],
    };
    for (let i = 0; i < 8; i++) nested = { version: 3, sections: [{ map: nested }] };
    expect(() => parseSourceMap(JSON.stringify(nested))).not.toThrow();
  });

  it("strips the )]}' guard and a byte order mark", () => {
    const body = map({ sources: ['a.js'], sourcesContent: ['A'] });
    expect(parseSourceMap(`)]}'\n${body}`).sources[0]!.content).toBe('A');
    expect(parseSourceMap(`${String.fromCharCode(0xfeff)}${body}`).sources[0]!.content).toBe('A');
  });

  it('warns about a version other than 3 but still reads the map', () => {
    const m = parseSourceMap(
      JSON.stringify({ version: 2, sources: ['a.js'], sourcesContent: ['A'] }),
    );
    expect(m.warnings).toEqual([{ code: 'version', arg: '2' }]);
    expect(m.sources).toHaveLength(1);
    expect(parseSourceMap(JSON.stringify({ sources: ['a.js'] })).warnings).toEqual([
      { code: 'version', arg: '?' },
    ]);
  });

  it('refuses text that is not JSON, and JSON that is not a map, with a user message', () => {
    expect(() => parseSourceMap('{"version":3,"sources":["a.js"')).toThrow(ToolError);
    expect(() => parseSourceMap('{"version":3,"sources":["a.js"')).toThrow(/valid JSON/);
    expect(() => parseSourceMap('[1,2,3]')).toThrow(/not a source map/);
    expect(() => parseSourceMap('{"name":"package"}')).toThrow(/not a source map/);
  });

  it('marks node_modules and bundler internals as dependencies', () => {
    const m = parseSourceMap(
      map({
        sources: [
          'webpack://app/./src/App.js',
          'webpack://app/./node_modules/react/index.js',
          '../node_modules/lodash/lodash.js',
          'webpack://app/webpack/runtime/define property getters',
          'webpack:///webpack/bootstrap',
        ],
      }),
    );
    expect(m.sources.map((s) => s.dependency)).toEqual([false, true, true, true, true]);
  });

  it('guesses the kind of text of each source from its name', () => {
    const m = parseSourceMap(
      map({ sources: ['a.js', 'b.ts', 'c.vue', 'd.html', 'e.css', 'f.json', 'g.env', 'h.txt'] }),
    );
    expect(m.sources.map((s) => s.lang)).toEqual([
      'js',
      'js',
      'html',
      'html',
      'text',
      'js',
      'text',
      'text',
    ]);
  });

  it('caps the number of sources it lists', () => {
    const sources = Array.from({ length: 50_010 }, (_, i) => `s${i}.js`);
    const m = parseSourceMap(map({ sources }));
    expect(m.sources).toHaveLength(50_000);
    expect(m.warnings).toEqual([{ code: 'capped', arg: '50000' }]);
  });
});

describe('looksLikeMap and utf8Length', () => {
  it('recognises a map and nothing else that is JSON', () => {
    expect(looksLikeMap('{"version":3,"sources":[],"mappings":""}')).toBe(true);
    expect(looksLikeMap(`)]}'\n{"version":3,"sections":[]}`)).toBe(true);
    expect(looksLikeMap('{"name":"x","version":"1.0.0","dependencies":{}}')).toBe(false);
    expect(looksLikeMap('var a = {"sources": 1};')).toBe(false);
    expect(looksLikeMap('<html>{"version":3,"sources":[]}</html>')).toBe(false);
  });

  it('counts UTF-8 bytes like TextEncoder does', () => {
    for (const s of [
      '',
      'abc',
      'é',
      '€',
      String.fromCodePoint(0x1f600),
      'aé€\u{1F600}b',
      '\ud800',
    ]) {
      expect(utf8Length(s)).toBe(utf8Encode(s).length);
    }
  });
});

describe('splitCombined: a script with its map pasted under it', () => {
  const object = {
    version: 3,
    sources: ['a.js'],
    sourcesContent: ['let x = 1;'],
    mappings: 'AAAA',
  };
  const map = JSON.stringify(object);
  const script = 'var a=1;\n//# sourceMappingURL=app.js.map\n';

  it('cuts the script from the map under it', () => {
    expect(splitCombined(`${script}${map}\n`)).toEqual({ code: script, map });
    expect(splitCombined(`${script}\n\n${map}  \n\n`)?.map).toBe(map);
  });

  it("takes a pretty-printed map, and a )]}' guard line", () => {
    const pretty = JSON.stringify(object, null, 2);
    expect(splitCombined(`${script}${pretty}`)).toEqual({ code: script, map: pretty });
    const guarded = `)]}'\n${map}`;
    expect(splitCombined(`${script}${guarded}`)).toEqual({ code: script, map: guarded });
  });

  it('works with Windows line ends', () => {
    const r = splitCombined(`var a=1;\r\n//# sourceMappingURL=app.js.map\r\n${map}\r\n`);
    expect(r?.map).toBe(map);
    expect(r?.code.startsWith('var a=1;')).toBe(true);
  });

  it('keeps looking when an earlier line only looks like the start of a map', () => {
    const decoy = 'var x =\n{"version":3,"sources":[1]}\n;\nvar y = 2;\n';
    expect(splitCombined(`${decoy}${map}`)).toEqual({ code: decoy, map });
  });

  it('does nothing when the rest is not exactly one map', () => {
    expect(splitCombined(`${script}${map} and more`)).toBeNull();
    expect(splitCombined(`${script}{"name":"pkg","version":3}`)).toBeNull();
    expect(splitCombined('var a = 1;\n{"version":3,"sources":[]')).toBeNull(); // cut short
    expect(splitCombined('var a=1;')).toBeNull();
    expect(splitCombined('')).toBeNull();
  });

  it('does nothing when the map is all there is (the input is a map: nothing to cut)', () => {
    expect(splitCombined(map)).toBeNull();
    expect(splitCombined(`\n  \n${map}`)).toBeNull();
  });

  it('finds the map after any number of lines that open an object, and gives up quickly', () => {
    const noise = Array.from({ length: 5000 }, () => '{\n"a": 1 }').join('\n');
    expect(splitCombined(`${noise}\n${map}`)).toEqual({ code: `${noise}\n`, map });
    const t0 = performance.now();
    expect(splitCombined(`${noise}\n${map}\nthe end`)).toBeNull(); // the tail is not a map
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('the tree, the zip and the names', () => {
  const src = (index: number, path: string, content: string | null = 'x'): MapSource => ({
    index,
    section: null,
    path,
    original: path,
    content,
    bytes: content?.length ?? 0,
    dependency: false,
    lang: 'js',
  });

  it('splits a path after its scheme and drops ./ parts', () => {
    expect(pathParts('webpack://app/./src/App.js')).toEqual(['webpack://', 'app', 'src', 'App.js']);
    expect(pathParts('webpack:///./src/index.js')).toEqual(['webpack:///', 'src', 'index.js']);
    expect(pathParts('../src/a.js')).toEqual(['..', 'src', 'a.js']);
    expect(pathParts('')).toEqual([]);
  });

  it('draws directories first, files after, one line for a chain of single directories', () => {
    const { lines, cut } = drawTree(
      [
        src(0, 'webpack://app/./src/a/b/deep.js'),
        src(1, 'webpack://app/./src/z.js'),
        src(2, 'webpack://app/./src/m.js'),
      ],
      (s) => (s.index === 0 ? ' <-' : ''),
    );
    expect(cut).toBe(0);
    expect(lines).toEqual([
      '└─ webpack://app/src/',
      '   ├─ a/b/',
      '   │  └─ deep.js <-',
      '   ├─ m.js',
      '   └─ z.js',
    ]);
  });

  it('does not mistake the first directory for a project name when there is none', () => {
    const { lines } = drawTree(
      [src(0, 'webpack:///./src/a.js'), src(1, 'webpack:///./src/b.js')],
      () => '',
    );
    expect(lines).toEqual(['└─ webpack:///src/', '   ├─ a.js', '   └─ b.js']);
  });

  it('tells two sources with the same path apart and cuts a very long tree', () => {
    const same = drawTree([src(0, 'a/x.js'), src(1, 'a/x.js')], () => '');
    expect(same.lines.join('\n')).toContain('x.js (#1)');
    const many = Array.from({ length: 50 }, (_, i) => src(i, `f${String(i).padStart(2, '0')}.js`));
    const cutTree = drawTree(many, () => '', 10);
    expect(cutTree.lines).toHaveLength(10);
    expect(cutTree.cut).toBe(40);
  });

  it('makes safe zip paths: no scheme, no .., no odd characters, no collision', () => {
    expect(safePath(src(0, 'webpack://x/../etc/passwd'))).toBe('webpack/x/_up/etc/passwd');
    expect(safePath(src(1, 'webpack:///./src/a?b*c.js'))).toBe('webpack/src/a_b_c.js');
    expect(safePath(src(2, ''))).toBe('source-2');
    expect(baseName(src(3, 'webpack://x/./src/Panel.js?abcd'))).toBe('Panel.js');
    expect(baseName(src(4, ''))).toBe('source-4.txt');
  });

  it('zips every source with content, byte for byte, and nothing without', () => {
    const sources = [
      src(0, 'webpack://x/./a.js', 'AAA\n'),
      src(1, 'webpack://x/./b.js', null),
      src(2, 'webpack://x/./a.js', 'DUP'),
      src(3, 'webpack://x/../evil.js', 'é€'),
    ];
    const zipped = zipSources(sources)!;
    expect(zipped.files).toBe(3);
    const files = unzipSync(zipped.zip);
    expect(Object.keys(files).sort()).toEqual([
      'webpack/x/_up/evil.js',
      'webpack/x/a.js',
      'webpack/x/a.js.2',
    ]);
    expect(utf8Decode(files['webpack/x/a.js']!)).toBe('AAA\n');
    expect(utf8Decode(files['webpack/x/a.js.2']!)).toBe('DUP');
    expect(utf8Decode(files['webpack/x/_up/evil.js']!)).toBe('é€');
    expect(zipSources([src(0, 'a.js', null)])).toBeNull();
  });

  it('writes the same zip twice', () => {
    const sources = [src(0, 'a.js', 'AAA'), src(1, 'b.js', 'BBB')];
    expect(
      Buffer.from(zipSources(sources)!.zip).equals(Buffer.from(zipSources(sources)!.zip)),
    ).toBe(true);
  });
});

describe('the sample files', () => {
  it('are exactly what the fixtures build (scripts/gen-samples-web-source.mjs)', () => {
    for (const { name, bytes } of buildSamples()) {
      expect(Buffer.from(sample(name)).equals(Buffer.from(bytes)), name).toBe(true);
    }
  });

  it('are small and their JavaScript is valid', () => {
    for (const { name, bytes } of buildSamples()) expect(bytes.length, name).toBeLessThan(4096);
    // `node --check` only parses the file: it is not run.
    for (const name of ['web-source-bundle.js', 'web-source-inline.js']) {
      const file = fileURLToPath(new URL(`../../../public/samples/${name}`, import.meta.url));
      expect(
        () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
        name,
      ).not.toThrow();
    }
  });

  it('bundle: ends with the reference, and the map lists a file nothing else mentions', () => {
    const js = utf8Decode(sample('web-source-bundle.js'));
    expect(js.trimEnd().endsWith('//# sourceMappingURL=web-source-bundle.js.map')).toBe(true);
    expect(findMapRef(js)).toEqual({ kind: 'external', ref: 'web-source-bundle.js.map' });
    const m = parseSourceMap(utf8Decode(sample('web-source-bundle.js.map')));
    expect(m.sources.map((s) => s.path)).toContain(HIDDEN_FILE);
    const hidden = m.sources.find((s) => s.path === HIDDEN_FILE)!;
    expect(hidden.content).toContain(`// secret: ${BUNDLE_SECRET}`);
    // No other source imports it, and the bundle does not carry its code.
    for (const s of m.sources.filter((x) => x !== hidden)) {
      expect(s.content ?? '').not.toMatch(/^\s*import .*SecretPanel/m);
    }
    expect(js).not.toContain(BUNDLE_SECRET);
    expect(m.sources).toHaveLength(7);
    expect(m.sources.filter((s) => s.content !== null)).toHaveLength(6);
  });

  it('bundle map: the same JSON the fixture builds', () => {
    expect(JSON.parse(buildBundleMapJson())).toEqual(bundleMap());
  });

  it('inline: the data: URI decodes to exactly the map the fixture describes', () => {
    const js = utf8Decode(sample('web-source-inline.js'));
    const ref = findMapRef(js);
    expect(ref?.kind).toBe('inline');
    if (ref?.kind !== 'inline') throw new Error('not inline');
    expect(JSON.parse(ref.json)).toEqual(inlineMap());
    const m = parseSourceMap(ref.json);
    expect(m.sources.map((s) => s.path)).toEqual([
      'webpack:///./src/config.js',
      'webpack:///./src/loader.js',
    ]);
    expect(m.sources[0]!.content).toContain(INLINE_SECRET);
  });
});
