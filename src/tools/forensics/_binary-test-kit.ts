/**
 * Helpers shared by the Binary analyzer tests: run a view, pick blocks out of the result, read
 * extracted files back, and count what a run reads. Tests only; nothing in the app imports it.
 */
import { lazyFile } from '../../core/prepare';
import { defaultOptions } from '../../core/registry';
import type { AnyTool, LazyFile, Output, ToolResult } from '../../core/types';
import tool from './binary-analyzer';

export { tool };

export const fileOf = (b: Uint8Array | Blob, name = 'input.bin'): LazyFile =>
  lazyFile(b instanceof Blob ? b : new Blob([b as BlobPart]), name);

export const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

export type Opts = Record<string, unknown>;

export async function run(
  input: Uint8Array | Blob | LazyFile,
  opts: Opts = {},
  name = 'input.bin',
): Promise<ToolResult> {
  const f = input instanceof Uint8Array || input instanceof Blob ? fileOf(input, name) : input;
  return tool.run(f, { ...defaultOptions(tool as unknown as AnyTool), ...opts } as never);
}

export const kv = (r: ToolResult) => new Map(r.flatMap((o) => (o.type === 'kv' ? o.entries : [])));
export const filesOf = (r: ToolResult) => r.flatMap((o) => (o.type === 'files' ? o.files : []));
export const tables = (r: ToolResult) =>
  r.filter((o): o is Extract<Output, { type: 'table' }> => o.type === 'table');
export const notes = (r: ToolResult) => r.flatMap((o) => (o.type === 'note' ? [o.text] : []));
export const texts = (r: ToolResult) => r.flatMap((o) => (o.type === 'text' ? [o.value] : []));
export const table = (r: ToolResult, prefix: string) =>
  tables(r).find((t) => t.label?.startsWith(prefix));

export async function content(f: { data: Uint8Array; blob?: Blob }): Promise<Uint8Array> {
  return f.blob ? new Uint8Array(await f.blob.arrayBuffer()) : f.data;
}

/** The extracted file called `name` (throws when it is missing, so tests fail clearly). */
export function fileNamed(r: ToolResult, name: string) {
  const f = filesOf(r).find((x) => x.name === name);
  if (!f)
    throw new Error(
      `no file ${name} in ${filesOf(r)
        .map((x) => x.name)
        .join(', ')}`,
    );
  return f;
}

export interface ReadStats {
  calls: number;
  bytes: number;
  largest: number;
}

/** A LazyFile whose read() is counted. */
export function counted(b: Uint8Array | Blob, name = 'input.bin'): [LazyFile, ReadStats] {
  const f = fileOf(b, name);
  const stats: ReadStats = { calls: 0, bytes: 0, largest: 0 };
  const read = f.read.bind(f);
  f.read = async (o, l) => {
    const got = await read(o, l);
    stats.calls++;
    stats.bytes += got.length;
    stats.largest = Math.max(stats.largest, l);
    return got;
  };
  return [f, stats];
}

/** `count` references to one Blob part: a big file that costs one part of memory. */
export const repeatBlob = (part: Uint8Array, count: number) => {
  const unit = new Blob([part as BlobPart]);
  return new Blob(Array.from({ length: count }, () => unit));
};

export const utf16le = (s: string) => {
  const out = new Uint8Array(s.length * 2);
  [...s].forEach((c, i) => (out[i * 2] = c.charCodeAt(0)));
  return out;
};
