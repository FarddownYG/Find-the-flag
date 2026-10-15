/**
 * What the tool worker does with each request (worker.ts only wires it to `self`). Kept apart so
 * that Node tests can drive the real protocol through a stand-in Worker.
 *
 * Memory: the worker keeps at most ONE input between runs, the decoded audio of the file on
 * screen (its bytes as read from the Blob, and its Float32Array channels). The page keeps only
 * the File/Blob handle (a user's file is not even read into the page's memory), so a big file
 * lives in one thread, once. The held input is dropped when another one replaces it (before the
 * new one is decoded), when the page releases it, or with the worker when a run is cancelled.
 */
import { getTool } from './registry';
import { ToolError } from './errors';
import { decodeAudioFile, isAudioFile, lazyFile } from './prepare';
import { getLocale, isLocale, setLocale, t } from '../i18n';
import type { Output } from './types';

interface RunBase {
  id: number;
  toolId: string;
  options: Record<string, unknown>;
  /** UI language, so tool messages come back translated. */
  locale: string;
}

export type RunRequest = RunBase &
  (
    | {
        /** The input itself (cloned, or transferred for audio decoded by the page). */
        input: unknown;
        /** Keep this input for later runs under this id (decoded audio only). */
        hold?: number;
      }
    /** Run on the input kept under this id: nothing big crosses threads again. */
    | { reuse: number }
  );

/** Forget the input kept for later runs (the page no longer shows it). */
export interface ReleaseRequest {
  release: true;
}

export type WorkerRequest = RunRequest | ReleaseRequest;

export type RunOutcome =
  | { status: 'ok'; result: unknown }
  | { status: 'error'; error: string; user: boolean }
  /** The input to reuse is not here (it never arrived, or failed to decode): send it again. */
  | { status: 'resend' }
  /** Audio only Web Audio can decode, which workers do not have: the page decodes it. */
  | { status: 'decode-in-page' };

export type RunResponse = RunOutcome & {
  id: number;
  /** Id of the input the worker keeps after this request, if any. */
  held: number | null;
};

export function createWorkerHandler(
  post: (res: RunResponse) => void,
): (req: WorkerRequest) => Promise<void> {
  let held: { id: number; value: unknown } | null = null;

  return async (req) => {
    if ('release' in req) {
      held = null;
      return;
    }
    const { id, toolId, options, locale } = req;
    const reply = (r: RunOutcome) => post({ ...r, id, held: held?.id ?? null });
    try {
      if (isLocale(locale) && locale !== getLocale()) await setLocale(locale);
      const tool = getTool(toolId);
      if (!tool) throw new ToolError(t('core.unknownTool', { id: toolId }));
      let value: unknown;
      if ('reuse' in req) {
        if (held?.id !== req.reuse) return reply({ status: 'resend' });
        value = held.value;
      } else {
        // A new input replaces the kept one: free it before decoding, not after.
        if (req.hold !== undefined) held = null;
        value = await fromWire(req.input);
        if (value === PAGE) return reply({ status: 'decode-in-page' });
        if (req.hold !== undefined) held = { id: req.hold, value };
      }
      const result = await tool.run(value as never, options as never);
      reply({ status: 'ok', result: forPage(result) });
    } catch (e) {
      const err = e as Error;
      reply({ status: 'error', error: err?.message || String(e), user: err instanceof ToolError });
    }
  };
}

const PAGE = Symbol('decode in page');

/** Functions cannot cross postMessage: a LazyFile comes as its Blob, an AudioFile undecoded. */
async function fromWire(input: unknown): Promise<unknown> {
  if (isAudioFile(input)) return (await decodeAudioFile(input)) ?? PAGE;
  const wire = input as { __lazyFile?: boolean; blob?: Blob; name?: string } | null;
  return wire?.__lazyFile && wire.blob ? lazyFile(wire.blob, wire.name) : input;
}

/**
 * Audio results cross as Blobs: the bytes are copied into the Blob here, off the page's thread,
 * and the page gets a handle it plays and downloads without ever touching them.
 */
function forPage(result: Output[]): Output[] {
  return result.map((o) =>
    o.type === 'audio' && o.data instanceof Uint8Array
      ? { ...o, data: new Blob([o.data as BlobPart], { type: o.mime ?? 'audio/wav' }) }
      : o,
  );
}
