import { ToolError } from './errors';
import { getLocale, t } from '../i18n';
import { getTool } from './registry';
import type { ToolResult } from './types';
import type { RunRequest, RunResponse } from './worker';

/**
 * Runs tools off the main thread. Starting a new run while one is pending kills the worker,
 * which is how live typing cancels a slow previous computation.
 */
export class Runner {
  private worker: Worker | null = null;
  private seq = 0;
  private pending: { id: number; reject: (e: Error) => void } | null = null;

  private spawn(): Worker | null {
    try {
      return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return null;
    }
  }

  run(toolId: string, input: unknown, options: Record<string, unknown>): Promise<ToolResult> {
    if (this.pending) {
      this.worker?.terminate();
      this.worker = null;
      this.pending.reject(new CancelledError());
      this.pending = null;
    }
    this.worker ??= this.spawn();
    const worker = this.worker;
    if (!worker) return runInline(toolId, input, options);
    const id = ++this.seq;
    return new Promise<ToolResult>((resolve, reject) => {
      this.pending = { id, reject };
      worker.onmessage = (ev: MessageEvent<RunResponse>) => {
        if (ev.data.id !== id) return;
        this.pending = null;
        if (ev.data.ok) resolve(ev.data.result as ToolResult);
        else reject(ev.data.user ? new ToolError(ev.data.error) : new Error(ev.data.error));
      };
      worker.onerror = (ev) => {
        ev.preventDefault();
        this.pending = null;
        this.worker = null;
        reject(new Error(ev.message || 'The tool crashed.'));
      };
      worker.postMessage({
        id,
        toolId,
        input: toWire(input),
        options,
        locale: getLocale(),
      } satisfies RunRequest);
    });
  }
}

export class CancelledError extends Error {
  override name = 'CancelledError';
}

async function runInline(toolId: string, input: unknown, options: Record<string, unknown>) {
  const tool = getTool(toolId);
  if (!tool) throw new ToolError(t('core.unknownTool', { id: toolId }));
  return tool.run(input as never, options as never);
}

/** Functions cannot cross postMessage: send a LazyFile as its Blob, the worker re-wraps it. */
function toWire(input: unknown): unknown {
  if (input && typeof input === 'object' && 'blob' in input && 'read' in input) {
    const f = input as { blob: Blob; name?: string };
    return { __lazyFile: true, blob: f.blob, name: f.name };
  }
  return input;
}
