import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { defaultOptions } from '../../core/registry';
import { resultToText } from '../../core/result-text';
import type { Output, ToolResult } from '../../core/types';
import {
  LAYERS_FLAG,
  NESTED_FLAG,
  STATIC_FLAG,
  buildSamples,
  layersSample,
  nestedEvalSample,
  staticSample,
} from './_js-deobf-samples';
import tool, { MAX_INPUT } from './js-deobfuscate';

const sample = (name: string) =>
  readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url), 'utf8');

type Options = Partial<ReturnType<typeof defaultOptions>>;
const run = async (text: string, options: Options = {}): Promise<ToolResult> =>
  tool.run(text, { ...defaultOptions(tool as never), ...options } as never);
const sandbox = (text: string, options: Options = {}) => run(text, { mode: 'sandbox', ...options });

const tables = (r: ToolResult) =>
  r.filter((o): o is Extract<Output, { type: 'table' }> => o.type === 'table');
const table = (r: ToolResult, label: string) => tables(r).find((t) => t.label === label)!;
const texts = (r: ToolResult) =>
  r.filter((o): o is Extract<Output, { type: 'text' }> => o.type === 'text');
const kv = (r: ToolResult) => new Map(r.flatMap((o) => (o.type === 'kv' ? o.entries : [])));
const notes = (r: ToolResult) =>
  r.flatMap((o) => (o.type === 'note' ? [`${o.level}: ${o.text}`] : []));

describe('the samples', () => {
  it('are exactly what scripts/gen-samples-js-deobf.mjs writes', () => {
    for (const [name, text] of Object.entries(buildSamples())) {
      expect(sample(name), name).toBe(text);
    }
  });

  it('are small, and hold only made-up payloads', () => {
    for (const name of Object.keys(buildSamples())) expect(sample(name).length).toBeLessThan(400);
  });
});

describe('static mode (nothing is run)', () => {
  it('peels the static sample down to its payload, round by round', async () => {
    const r = await run(staticSample());
    expect(texts(r).at(-1)!.value.trimEnd()).toBe(
      `var greeting = "Hello CTF!";\nalert("${STATIC_FLAG}");`,
    );
    const t = table(r, 'Static layers: read from the code, nothing was run');
    expect(t.rows.map((row) => [row[0], row[2]])).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
      [2, 1],
      [2, 1],
      [2, 1],
    ]);
    expect(kv(r).get('Passes')).toBe('2');
    expect(kv(r).get('Replacements')).toBe('8');
    expect(t.columns).toEqual(['Pass', 'Rule', 'Replacements', 'Size']);
  });

  it('shows each pass before the last one', async () => {
    const r = await run(staticSample());
    const passes = texts(r).filter((x) => x.label?.startsWith('Code after pass'));
    expect(passes).toHaveLength(1);
    expect(passes[0]!.value).toContain('eval(atob("');
  });

  it('says so when there is nothing to peel, and offers the sandbox', async () => {
    const r = await run('var a = 1; console.log(a);');
    expect(notes(r).join('\n')).toContain('Nothing to peel by reading');
    const actions = r.find((o) => o.type === 'actions');
    expect(actions && actions.type === 'actions' && actions.actions[0]!.options).toEqual({
      mode: 'sandbox',
    });
  });

  it('links to the decoders with the result as their input', async () => {
    const r = await run(staticSample());
    const actions = r.find((o) => o.type === 'actions');
    if (actions?.type !== 'actions') throw new Error('no actions');
    const opens = actions.actions.flatMap((a) => (a.open ? [a.open.tool] : []));
    expect(opens).toEqual(['unicode-escape', 'charcode', 'base64']);
    expect(actions.actions.find((a) => a.open)!.open!.text).toContain(STATIC_FLAG);
  });

  it('points to the PDF and executable analyzers, with a button for each', async () => {
    const r = await run(staticSample());
    const text = notes(r).join('\n');
    expect(text).toContain('PDF analyzer');
    expect(text).toContain('Executable analyzer');
    const opens = r.flatMap((o) =>
      o.type === 'actions' ? o.actions.flatMap((a) => (a.open ? [a.open.tool] : [])) : [],
    );
    expect(opens).toEqual(['unicode-escape', 'charcode', 'base64', 'pdf-analyzer', 'exe-analyzer']);
  });

  it('warns when eval of a computed value is left', async () => {
    const r = await run('var c = "al" + "ert"; eval(c + "(1)");');
    expect(notes(r).join('\n')).toContain('still calls eval or Function');
  });

  it('re-indents long cramped code only when asked, and never changes the tokens', async () => {
    const code = `function f(a){${'a=a+1;'.repeat(40)}return a}`;
    const plain = await run(code, { beautify: false });
    const pretty = await run(code, { beautify: true });
    expect(texts(plain).at(-1)!.value).toBe(code);
    expect(texts(pretty).at(-1)!.value).toContain('\n  a = a + 1;');
  });
});

describe('sandbox mode (run once, text only)', () => {
  it('the Function chain: two layers, the first returned the next code', async () => {
    const r = await sandbox(layersSample());
    const t = table(r, 'Dynamic layers: captured while the script ran');
    // No layer failed here, so the table has no Error column.
    expect(t.columns).toEqual(['#', 'Type', 'Input', 'Output']);
    expect(t.rows).toEqual([
      [1, 'Function', `return 'alert("${LAYERS_FLAG}")'`, `alert("${LAYERS_FLAG}")`],
      [2, 'Function', `alert("${LAYERS_FLAG}")`, 'undefined'],
    ]);
    expect(kv(r).get('Layers captured')).toBe('2');
    expect(kv(r).get('The script')).toBe('ran to the end');
    const final = texts(r).find((x) => x.label?.startsWith('Final code'))!;
    expect(final.value).toBe(`alert("${LAYERS_FLAG}")`);
  });

  it('the octal case a=p: the second layer fails, and the report keeps it', async () => {
    const r = await sandbox(
      `Function(Function("return '${String.fromCharCode(92)}141${String.fromCharCode(92)}75${String.fromCharCode(92)}160'")())()`,
    );
    const t = table(r, 'Dynamic layers: captured while the script ran');
    expect(t.rows.map((row) => row.slice(1, 5))).toEqual([
      ['Function', "return 'a=p'", 'a=p', ''],
      ['Function', 'a=p', '', 'ReferenceError: p is not defined'],
    ]);
    expect(kv(r).get('The script')).toBe('stopped with an error');
    expect(texts(r).find((x) => x.label?.startsWith('Final code'))!.value).toBe('a=p');
  });

  it('eval(atob(eval(atob(…)))): atob, eval, atob, eval, in this order', async () => {
    const r = await sandbox(nestedEvalSample());
    const t = table(r, 'Dynamic layers: captured while the script ran');
    expect(t.rows.map((row) => row[1])).toEqual(['atob', 'eval', 'atob', 'eval']);
    expect(t.rows[3]![2]).toBe(`alert("${NESTED_FLAG}");`);
    const decoded = texts(r).filter((x) => x.label?.includes('decoded text'));
    expect(decoded.map((d) => d.value)).toEqual([
      expect.stringMatching(/^eval\(atob\("/),
      `alert("${NESTED_FLAG}");`,
    ]);
  });

  it('text written to a page that does not exist is a layer, and is not taken for code', async () => {
    const r = await sandbox('document.write(unescape("%3Cb%3EFTF%7Bpage%7D%3C/b%3E"))');
    const t = table(r, 'Dynamic layers: captured while the script ran');
    expect(t.rows.map((row) => row[1])).toEqual(['unescape', 'document.write']);
    const labels = texts(r).map((x) => x.label);
    expect(labels).toContain('Layer 1 \u00b7 unescape \u00b7 decoded text');
    expect(labels).toContain('Layer 2 \u00b7 document.write \u00b7 text written to the page');
    const last = texts(r).find((x) => x.label === 'Last text the script decoded or wrote')!;
    expect(last.value).toBe('<b>FTF{page}</b>');
    expect(labels.some((l) => l?.startsWith('Final code'))).toBe(false);
  });

  it('the static peel of the final code is shown when it still has something to give', async () => {
    const r = await sandbox(`eval("var x = '${String.fromCharCode(92)}x41' + 'B'")`);
    const finals = texts(r).filter((x) => x.label?.startsWith('Final code'));
    expect(finals.map((f) => f.label)).toEqual([
      'Final code (the last code the script compiled)',
      'Final code, peeled statically',
    ]);
    // The quote of the original literal is kept.
    expect(finals[1]!.value).toBe("var x = 'AB'");
  });

  it('records the attempts to reach the network and says nothing was sent', async () => {
    const r = await sandbox(
      'fetch("https://example.invalid/a").catch(function () {}); import("https://example.invalid/b").catch(function () {});',
    );
    const events = table(r, 'Blocked attempts, dialogs (never shown) and console output');
    const names = events.rows.map((row) => `${row[0]} ${row[1]}`);
    expect(names).toContain('Blocked · fetch https://example.invalid/a');
    expect(names).toContain('Blocked · import() https://example.invalid/b');
    expect(kv(r).get('Blocked attempts')).toBe('3');
    expect(notes(r).join('\n')).toContain('No request was made.');
  });

  it('says what happens when the time is up', async () => {
    const r = await sandbox('while (true) {}', { timeout: '200' });
    expect(kv(r).get('The script')).toBe('was cut at the time limit');
    expect(notes(r).join('\n')).toContain('The time limit (200 ms) was reached');
  });

  it('says what the script did when it never called a watched function', async () => {
    const r = await sandbox('var a = 1 + 1;');
    expect(notes(r).join('\n')).toContain('called none of the watched functions');
  });

  it('always states the limits of the design', async () => {
    const text = notes(await sandbox('1')).join('\n');
    expect(text).toContain('Tested design');
    expect(text).toContain('Function.prototype.toString()');
    expect(text).toContain('document.write');
    expect(text).toContain('eval is called indirectly');
  });

  it('shows the code as the user wrote it, not with the renamed word import', async () => {
    const r = await sandbox('eval(\'var s = "import this"; alert(s)\')');
    const finals = texts(r).find((x) => x.label?.startsWith('Final code'))!;
    expect(finals.value).toContain('"import this"');
    expect(finals.value).not.toContain('__imp__');
  });

  it('keeps the page responsive on a megabyte of script', async () => {
    const big = `/*${'x'.repeat(1_000_000)}*/ alert("big");`;
    const t0 = Date.now();
    const r = await sandbox(big);
    expect(resultToText(r)).toContain('big');
    expect(Date.now() - t0).toBeLessThan(8000);
  });
});

describe('errors and the rest', () => {
  it('asks for a script', async () => {
    await expect(run('   ')).rejects.toBeInstanceOf(ToolError);
  });

  it('refuses a script over the size limit, and says the limit', async () => {
    await expect(run('a'.repeat(MAX_INPUT + 1))).rejects.toThrow(String(MAX_INPUT));
  });

  it('leaves no {placeholder} in any text', async () => {
    const results = [
      await run(staticSample()),
      await run('1 + 1'),
      await sandbox(layersSample()),
      await sandbox('while (1) {}', { timeout: '200' }),
      await sandbox('throw new Error("x")'),
      await sandbox('fetch("https://example.invalid/").catch(function () {}); alert(1)'),
    ];
    for (const r of results) {
      expect(resultToText(r)).not.toMatch(
        /\{(n|type|error|count|ms|tool|pdf|exe|list|rules|reason|size|max)\}/,
      );
    }
  });
});

describe('detect', () => {
  const detect = (text: string) => tool.detect!({ text, bytes: new TextEncoder().encode(text) });

  it('suggests the static mode (never the sandbox) for obfuscated JavaScript, with a modest score', () => {
    for (const text of [
      staticSample(),
      layersSample(),
      nestedEvalSample(),
      'var x = eval(unescape("%61%6c%65%72%74%28%31%29")); var y = 1;',
    ]) {
      const d = detect(text);
      expect(d, text).not.toBeNull();
      expect(d!.score).toBeGreaterThanOrEqual(0.4);
      expect(d!.score).toBeLessThanOrEqual(0.62);
      expect(d!.options).toEqual({ mode: 'static' });
    }
  });

  it('recognises a script made of ( ) [ ] ! + only', () => {
    const jsfuck = '[][(![]+[])[+[]]+([![]]+[][[]])[+!+[]+[+[]]]+(![]+[])[!+[]+!+[]]]'.repeat(3);
    expect(detect(jsfuck)!.score).toBe(0.6);
  });

  it('stays quiet on text that is not JavaScript', () => {
    for (const text of [
      'ZmxhZ3toZWxsb19jdGZ9ZmxhZ3toZWxsb19jdGZ9',
      'The quick brown fox jumps over the lazy dog, again and again.',
      '66 6c 61 67 7b 68 65 6c 6c 6f 7d 66 6c 61 67 7b 68 65 6c 6c 6f 7d',
      'short',
      '',
    ]) {
      expect(detect(text), text).toBeNull();
    }
  });
});
