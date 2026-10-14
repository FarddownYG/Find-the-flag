import { decodeAudioInBrowser, decodeWav } from './decode-audio';
import { decodeImageExact, decodeImageInBrowser } from './decode-image';
import { ToolError } from './errors';
import { t } from '../i18n';
import type { AnyTool, ExampleInput, InputKind, LazyFile } from './types';
import { fromHex, utf8Decode, utf8Encode } from '../lib/bytes';

/** What the input panel holds before it is shaped for a tool. */
export interface RawInput {
  text?: string;
  bytes?: Uint8Array;
  /** A dropped/opened file, kept as a handle for tools with input 'file'. */
  file?: Blob;
  name?: string;
}

/** Wrap a Blob as a LazyFile (works in the page, the worker and Node). */
export function lazyFile(blob: Blob, name?: string): LazyFile {
  const size = blob.size;
  return {
    blob,
    name,
    size,
    async read(offset, length) {
      const start = Math.max(0, Math.min(size, Math.floor(offset)));
      const end = Math.max(start, Math.min(size, Math.floor(offset + length)));
      return new Uint8Array(await blob.slice(start, end).arrayBuffer());
    },
  };
}

const inBrowser = typeof document !== 'undefined';

/** Turn raw text/bytes into the value a tool of the given input kind expects. */
export async function prepareInput(kind: InputKind, raw: RawInput): Promise<unknown> {
  if (kind === 'file') {
    const blob = raw.file ?? new Blob([(raw.bytes ?? utf8Encode(raw.text ?? '')) as BlobPart]);
    return lazyFile(blob, raw.name ?? (blob instanceof File ? blob.name : undefined));
  }
  if (raw.file && !raw.bytes) raw = { ...raw, bytes: new Uint8Array(await raw.file.arrayBuffer()) };
  if (kind === 'text') return raw.text ?? (raw.bytes ? utf8Decode(raw.bytes) : '');
  const bytes = raw.bytes ?? utf8Encode(raw.text ?? '');
  const base = { bytes, name: raw.name };
  if (kind === 'bytes') return base;
  if (!bytes.length)
    throw new ToolError(t(kind === 'image' ? 'core.input.needImage' : 'core.input.needAudio'));
  if (kind === 'image') {
    const image = decodeImageExact(bytes) ?? (inBrowser ? await decodeImageInBrowser(bytes) : null);
    if (!image) throw new ToolError(t('core.input.imageFormat'));
    return { ...base, image };
  }
  const audio = decodeWav(bytes) ?? (inBrowser ? await decodeAudioInBrowser(bytes) : null);
  if (!audio) throw new ToolError(t('core.input.audioFormat'));
  return { ...base, ...audio };
}

export async function exampleToRaw(
  input: ExampleInput,
  loadSample: (name: string) => Promise<Uint8Array>,
): Promise<RawInput> {
  if (typeof input === 'string') return { text: input };
  if ('hex' in input) return { bytes: fromHex(input.hex) };
  return { bytes: await loadSample(input.sample), name: input.sample };
}

/** Load `{ sample }` placeholders of file options (examples) into real input values. */
export async function resolveExampleOptions(
  tool: AnyTool,
  options: Record<string, unknown> | undefined,
  loadSample: (name: string) => Promise<Uint8Array>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...options };
  for (const [key, spec] of Object.entries(tool.options ?? {})) {
    const v = out[key];
    if (spec.type !== 'file' || !v || typeof v !== 'object' || !('sample' in v)) continue;
    const name = String((v as { sample: string }).sample);
    out[key] = await prepareInput(spec.kind, { bytes: await loadSample(name), name });
  }
  return out;
}
