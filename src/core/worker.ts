/// <reference lib="webworker" />
import { getTool } from './registry';
import { ToolError } from './errors';
import { getLocale, isLocale, setLocale, t } from '../i18n';

export interface RunRequest {
  id: number;
  toolId: string;
  input: unknown;
  options: Record<string, unknown>;
  /** UI language, so tool messages come back translated. */
  locale: string;
}

export type RunResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; user: boolean };

self.onmessage = async (ev: MessageEvent<RunRequest>) => {
  const { id, toolId, input, options, locale } = ev.data;
  if (isLocale(locale) && locale !== getLocale()) await setLocale(locale);
  const tool = getTool(toolId);
  try {
    if (!tool) throw new ToolError(t('core.unknownTool', { id: toolId }));
    const result = await tool.run(input as never, options as never);
    self.postMessage({ id, ok: true, result } satisfies RunResponse);
  } catch (e) {
    const err = e as Error;
    self.postMessage({
      id,
      ok: false,
      error: err?.message || String(e),
      user: err instanceof ToolError,
    } satisfies RunResponse);
  }
};
