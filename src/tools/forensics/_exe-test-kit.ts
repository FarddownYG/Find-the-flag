/**
 * Helpers shared by the Executable analyzer tests: run a view on bytes, pick blocks out of the
 * result, read extracted files back. Tests only; nothing in the app imports it.
 */
import { lazyFile } from '../../core/prepare';
import { defaultOptions } from '../../core/registry';
import type { AnyTool, LazyFile, Output, ToolResult } from '../../core/types';
import { Reader } from './_exe-bin';
import tool from './exe-analyzer';

export { tool };

export const fileOf = (b: Uint8Array | Blob, name = 'input.bin'): LazyFile =>
  lazyFile(b instanceof Blob ? b : new Blob([b as BlobPart]), name);

export const readerOf = (b: Uint8Array): Reader => new Reader(fileOf(b));

export type Opts = Record<string, unknown>;

export async function run(input: Uint8Array | LazyFile, opts: Opts = {}): Promise<ToolResult> {
  const f = input instanceof Uint8Array ? fileOf(input) : input;
  return tool.run(f, { ...defaultOptions(tool as unknown as AnyTool), ...opts } as never);
}

export const kvs = (r: ToolResult): Map<string, string> =>
  new Map(r.flatMap((o) => (o.type === 'kv' ? o.entries : [])));

export const tables = (r: ToolResult) =>
  r.filter((o): o is Extract<Output, { type: 'table' }> => o.type === 'table');

/** The first table whose label starts with `prefix`. */
export function table(r: ToolResult, prefix: string) {
  const t = tables(r).find((x) => (x.label ?? '').startsWith(prefix));
  if (!t)
    throw new Error(
      `no table "${prefix}" in: ${tables(r)
        .map((x) => x.label)
        .join(' | ')}`,
    );
  return t;
}

export const notes = (r: ToolResult): string[] =>
  r.flatMap((o) => (o.type === 'note' ? [o.text] : []));

export const filesOf = (r: ToolResult) => r.flatMap((o) => (o.type === 'files' ? o.files : []));

export async function fileBytes(f: { data: Uint8Array; blob?: Blob }): Promise<Uint8Array> {
  return f.blob ? new Uint8Array(await f.blob.arrayBuffer()) : f.data;
}

/** All text a result shows, for "contains" checks. */
export function flat(r: ToolResult): string {
  return r
    .map((o) => {
      if (o.type === 'kv') return o.entries.map(([k, v]) => `${k}: ${v}`).join('\n');
      if (o.type === 'table')
        return [o.columns.join('\t'), ...o.rows.map((x) => x.join('\t'))].join('\n');
      if (o.type === 'text') return o.value;
      if (o.type === 'note') return o.text;
      if (o.type === 'files') return o.files.map((f) => `${f.name} ${f.note ?? ''}`).join('\n');
      return '';
    })
    .join('\n');
}
