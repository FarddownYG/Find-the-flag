import { ToolError } from './errors';
import { getLocale, t } from '../i18n';
import { getTool } from './registry';
import { decodeAudioFileInPage, isAudioFile, prepareInput, type AudioFile } from './prepare';
import type { AudioInput, ToolResult } from './types';
import type { RunRequest, RunResponse, WorkerRequest } from './worker-handler';

/** What the runner needs from a Worker (a stand-in in Node tests). */
export type WorkerLike = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((ev: MessageEvent<RunResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
};

export interface RunnerDeps {
  /** A new tool worker, or null where workers are unavailable (tools then run inline). */
  spawn?: () => WorkerLike | null;
  /** Decode audio with the browser decoder (Web Audio exists in the page only). */
  decodeInPage?: (file: AudioFile) => Promise<AudioInput>;
}

function spawnWorker(): WorkerLike | null {
  try {
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

/**
 * Runs tools off the main thread. Starting a new run while one is pending kills the worker,
 * which is how live typing cancels a slow previous computation.
 *
 * Audio inputs (`AudioFile`) are decoded in the worker and kept there between runs: the first
 * run sends the Blob handle, later runs of the same file send only the options. A cancelled run
 * takes the worker and what it kept with it; the next run sends the Blob again. Other inputs are
 * cloned to the worker on every run, as before (tools may count on a fresh copy).
 */
export class Runner {
  private worker: WorkerLike | null = null;
  private seq = 0;
  private pending: { id: number; reject: (e: Error) => void } | null = null;
  /** The audio the live worker keeps, by the Blob (and name) it was decoded from. */
  private held: { blob: Blob; name?: string; id: number } | null = null;
  private holds = 0;
  /** Files the worker said it cannot decode: later sends go straight to the page decoder. */
  private readonly pageDecoded = new WeakSet<Blob>();
  /** A page decode in flight, shared by the run that started it and the one replacing it. */
  private decoding: { blob: Blob; promise: Promise<AudioInput> } | null = null;
  private readonly spawn: () => WorkerLike | null;
  private readonly decodeInPage: (file: AudioFile) => Promise<AudioInput>;

  constructor(deps: RunnerDeps = {}) {
    this.spawn = deps.spawn ?? spawnWorker;
    this.decodeInPage = deps.decodeInPage ?? decodeAudioFileInPage;
  }

  run(toolId: string, input: unknown, options: Record<string, unknown>): Promise<ToolResult> {
    this.cancel();
    this.worker ??= this.spawn();
    const worker = this.worker;
    if (!worker) return runInline(toolId, input, options);
    const id = ++this.seq;
    const base = { id, toolId, options, locale: getLocale() };
    return new Promise<ToolResult>((resolve, reject) => {
      this.pending = { id, reject };
      const current = () => this.pending?.id === id && this.worker === worker;
      const settle = () => {
        this.pending = null;
      };
      const fail = (e: unknown) => {
        if (!current()) return;
        settle();
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      const post = (req: RunRequest, transfer: Transferable[] = []) =>
        worker.postMessage(req satisfies WorkerRequest, transfer);

      const sendAudio = async (file: AudioFile) => {
        const hold = ++this.holds;
        this.held = { blob: file.blob, name: file.name, id: hold };
        if (!this.pageDecoded.has(file.blob)) return post({ ...base, input: file, hold });
        const audio = await this.pageDecode(file);
        // Cancelled while the browser was decoding: the run replacing this one uses the result.
        if (!current()) return;
        this.decoding = null; // its samples now go to the worker, and leave this thread
        postTransferring(worker, { ...base, input: audio, hold }, audio);
      };

      worker.onmessage = (ev) => {
        const res = ev.data;
        if (res.id !== id) return;
        if (this.held?.id !== res.held) this.held = null;
        if (res.status === 'resend' || res.status === 'decode-in-page') {
          if (!isAudioFile(input)) return fail(new Error('The worker asked for an audio input.'));
          if (res.status === 'decode-in-page') this.pageDecoded.add(input.blob);
          sendAudio(input).catch(fail);
          return;
        }
        settle();
        if (res.status === 'ok') resolve(res.result as ToolResult);
        else reject(res.user ? new ToolError(res.error) : new Error(res.error));
      };
      worker.onerror = (ev) => {
        ev.preventDefault();
        if (this.worker === worker) {
          this.worker = null;
          this.held = null;
        }
        fail(new Error(ev.message || 'The tool crashed.'));
      };

      if (!isAudioFile(input)) post({ ...base, input: toWire(input) });
      else if (this.held?.blob === input.blob && this.held.name === input.name) {
        post({ ...base, reuse: this.held.id });
      } else sendAudio(input).catch(fail);
    });
  }

  /** The input on screen is gone: drop what the worker keeps for it (and any run for it). */
  release(): void {
    if (this.pending) this.cancel();
    else if (this.held) this.worker?.postMessage({ release: true } satisfies WorkerRequest);
    this.held = null;
    this.decoding = null;
  }

  private pageDecode(file: AudioFile): Promise<AudioInput> {
    if (this.decoding?.blob !== file.blob) {
      const promise = this.decodeInPage(file);
      this.decoding = { blob: file.blob, promise };
      // A failed decode is not kept: the next run tries again.
      promise.catch(() => {
        if (this.decoding?.promise === promise) this.decoding = null;
      });
    }
    return this.decoding.promise;
  }

  private cancel(): void {
    if (!this.pending) return;
    this.worker?.terminate();
    this.worker = null;
    this.held = null;
    this.pending.reject(new CancelledError());
    this.pending = null;
  }
}

export class CancelledError extends Error {
  override name = 'CancelledError';
}

/**
 * Hand decoded audio over without copying it: the page gives up its samples. A browser that
 * does not let AudioBuffer storage be transferred gets copies of the channels instead.
 */
function postTransferring(worker: WorkerLike, req: RunRequest, audio: AudioInput): void {
  const buffers = (a: AudioInput) => [
    ...new Set([a.bytes.buffer, ...a.channels.map((c) => c.buffer)] as ArrayBuffer[]),
  ];
  try {
    worker.postMessage(req, buffers(audio));
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'DataCloneError')) throw e;
    const copy = { ...audio, channels: audio.channels.map((c) => c.slice()) };
    worker.postMessage({ ...req, input: copy }, buffers(copy));
  }
}

async function runInline(toolId: string, input: unknown, options: Record<string, unknown>) {
  const tool = getTool(toolId);
  if (!tool) throw new ToolError(t('core.unknownTool', { id: toolId }));
  const value = isAudioFile(input)
    ? await prepareInput('audio', { file: input.blob, name: input.name })
    : input;
  return tool.run(value as never, options as never);
}

/** Functions cannot cross postMessage: send a LazyFile as its Blob, the worker re-wraps it. */
function toWire(input: unknown): unknown {
  if (input && typeof input === 'object' && 'blob' in input && 'read' in input) {
    const f = input as { blob: Blob; name?: string };
    return { __lazyFile: true, blob: f.blob, name: f.name };
  }
  return input;
}
