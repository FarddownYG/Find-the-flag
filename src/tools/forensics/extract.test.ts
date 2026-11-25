import { readFileSync } from 'node:fs';
import { gzipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { lazyFile } from '../../core/prepare';
import { defaultOptions, getTool } from '../../core/registry';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { buildTar, buildZip, noise } from './_fixtures';

const tool = getTool('extract')!;

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

async function open(
  bytes: Uint8Array,
  opts: Record<string, unknown> = {},
  name = 'input.bin',
): Promise<Output[]> {
  const input = lazyFile(new Blob([bytes as BlobPart]), name);
  return tool.run(input, { ...defaultOptions(tool), ...opts } as never);
}

function part<T extends Output['type']>(out: Output[], type: T): Extract<Output, { type: T }> {
  const found = out.find((o) => o.type === type);
  if (!found) throw new Error(`no ${type} block in ${out.map((o) => o.type).join(',')}`);
  return found as Extract<Output, { type: T }>;
}
const first = (out: Output[]) => out[0] as Extract<Output, { type: 'note' }>;

describe('Universal extractor tool', () => {
  it('opens with the flags: a success note, then the summary and the tree', async () => {
    const out = await open(sample('extract-nested.zip'), {}, 'extract-nested.zip');
    expect(first(out).type).toBe('note');
    expect(first(out).level).toBe('success');
    expect(first(out).text).toContain('FTF{extract_unwraps_layers}');
    const kv = Object.fromEntries(part(out, 'kv').entries);
    expect(kv['Items in the tree']).toBe('7');
    expect(kv['Complete']).toBe('yes');
    expect(kv['Deepest level']).toBe('3');
    expect(kv['Found']).toContain('PNG');
    const where = out.filter((o) => o.type === 'kv')[1] as Extract<Output, { type: 'kv' }>;
    expect(where.entries).toEqual([
      ['FTF{extract_unwraps_layers}', 'extract-nested.zip/layers/pic.png/tEXt-Comment/base64.txt'],
    ]);
  });

  it('flattens the tree depth-first with an indented path and highlights the finds', async () => {
    const out = await open(sample('extract-nested.zip'), {}, 'extract-nested.zip');
    const t = part(out, 'table');
    expect(t.columns).toEqual(['Path', 'Format', 'Offset', 'Size', 'Status', 'Found by', 'Flag']);
    expect(t.rows.map((r) => r[0])).toEqual([
      'extract-nested.zip',
      '· readme.txt',
      '· layers/pic.png',
      '· · tEXt-Comment',
      '· · · base64.txt',
      expect.stringMatching(/^· · [0-9a-f]{8}\.gz$/),
      expect.stringMatching(/^· · · [0-9a-f]{8}\.txt$/),
    ]);
    const base64 = t.rows[4]!;
    expect(base64[4]).toBe('Decoded text');
    expect(base64[5]).toBe('Decoded (base64)');
    expect(base64[6]).toBe('FTF{extract_unwraps_layers}');
    const gz = t.rows[5]!;
    expect(gz[1]).toContain('GZIP');
    expect(typeof gz[2]).toBe('number');
    expect(gz[4]).toBe('Confirmed');
    // the root is not highlighted; a confirmed entry and the flag row are
    expect(t.highlight).toContain(2);
    expect(t.highlight).toContain(4);
    expect(t.highlight).not.toContain(0);
  });

  it('offers one download per item, the flagged one first, named after its path', async () => {
    const out = await open(sample('extract-nested.zip'), {}, 'extract-nested.zip');
    const files = part(out, 'files').files;
    expect(files).toHaveLength(6);
    expect(files[0]!.name).toBe('layers__pic.png__tEXt-Comment__base64.txt');
    expect(new TextDecoder().decode(files[0]!.data)).toBe('FTF{extract_unwraps_layers}');
    expect(files.map((f) => f.name)).toContain('layers__pic.png');
    expect(new Set(files.map((f) => f.name)).size).toBe(files.length);
  });

  it('hands a big item over as a Blob', async () => {
    const big = noise(9 * 1024 * 1024, 11, false);
    const zip = buildZip([{ name: 'big.bin', data: big, method: 0 }]);
    const out = await open(zip);
    const f = part(out, 'files').files.find((x) => x.name === 'big.bin')!;
    expect(f.data.length).toBe(0);
    expect(f.blob?.size).toBe(big.length);
  });

  it('offers Auto-decode for leftover text and points to Send to for images', async () => {
    const zip = buildZip([
      { name: 'a.txt', data: strToU8('some leftover text with no flag in it, just words') },
      { name: 'b/pic.png', data: sample('forensics-polyglot.png').subarray(0, 1000) },
    ]);
    const text = resultToText(await open(zip));
    expect(text).toContain('Open a.txt in Auto-decode');
    const real = await open(sample('forensics-polyglot.png'));
    expect(resultToText(real)).toContain('flag{binwalk_found_me}');
  });

  it('reads at most the size cap and says so', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024 + 5);
    bytes.set(strToU8('plain'), 0);
    const out = await open(bytes, { size: 1 });
    const warn = out.find((o) => o.type === 'note' && o.level === 'warn') as Extract<
      Output,
      { type: 'note' }
    >;
    expect(warn.text).toContain('Only the first 1.00 MiB of the 2.00 MiB were read');
  });

  it('says plainly when there is nothing inside', async () => {
    const out = await open(noise(50_000, 21, false));
    expect(first(out).level).toBe('info');
    expect(first(out).text).toContain('Nothing inside');
    expect(out.some((o) => o.type === 'table')).toBe(false);
    expect(out.some((o) => o.type === 'files')).toBe(false);
  });

  it('warns when the depth limit cuts the tree', async () => {
    let data: Uint8Array = strToU8('core');
    for (let i = 0; i < 4; i++) data = gzipSync(data, { mtime: 0 });
    const text = resultToText(await open(data, { depth: 2 }));
    expect(text).toContain('depth limit (2)');
  });

  it('lists the files of a tar.gz', async () => {
    const tar = buildTar([
      ['one.txt', strToU8('first file')],
      ['dir/two.txt', strToU8('second file')],
    ]);
    const out = await open(gzipSync(tar, { mtime: 0 }), {}, 'pack.tgz');
    const rows = part(out, 'table').rows.map((r) => r[0]);
    expect(rows).toEqual(['pack.tgz', '· pack.tar', '· · one.txt', '· · dir/two.txt']);
  });

  it('rejects an empty file', async () => {
    await expect(open(new Uint8Array(0))).rejects.toBeInstanceOf(ToolError);
  });
});
