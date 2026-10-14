import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { defaultOptions, TOOLS, validateTools } from './registry';
import { exampleToRaw, prepareInput } from './prepare';
import { resultToText } from './result-text';

const loadSample = async (name: string) =>
  new Uint8Array(await readFile(new URL(`../../public/samples/${name}`, import.meta.url)));

describe('registry', () => {
  it('discovers tools and they are all valid', () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    expect(validateTools(TOOLS.map((t) => [t.id, t]))).toEqual([]);
  });

  it('rejects duplicates and bad ids', () => {
    const t = TOOLS[0]!;
    const errs = validateTools([
      ['a.ts', t],
      ['b.ts', t],
      ['c.ts', { ...t, id: 'Bad Id' }],
    ]);
    expect(errs.join('\n')).toMatch(/duplicate id/);
    expect(errs.join('\n')).toMatch(/kebab-case/);
  });
});

// Every example of every tool is an executable test: run it, check the expected substring.
describe.each(TOOLS.map((t) => [t.id, t] as const))('%s examples', (_id, tool) => {
  it.each(tool.examples.map((e) => [e.label, e] as const))('%s', async (_label, ex) => {
    const raw = await exampleToRaw(ex.input, loadSample);
    const input = await prepareInput(tool.input, raw);
    const opts = { ...defaultOptions(tool), ...ex.options };
    const text = resultToText(await tool.run(input as never, opts as never));
    expect(text).toContain(ex.expect);
  });
});
