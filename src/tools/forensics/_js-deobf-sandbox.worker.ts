/// <reference lib="webworker" />
/**
 * The sandbox worker of the JavaScript deobfuscator: a dedicated worker loaded from the app's own
 * bundle (never from a blob: URL, which would inherit the page's no-eval policy). It runs ONE
 * pasted script, once, and is terminated by whoever started it, from outside: a script that never
 * ends cannot stop that.
 *
 * Protocol (plain strings and plain objects only; nothing but text ever leaves this worker):
 *   worker -> host  { kind: 'ready' }                       the module is loaded
 *   host -> worker  { nonce, code, graceMs, limitMs }       the script to run
 *   worker -> host  { nonce, t: 'layer' | 'update' | 'event', ... }   as the script runs
 *   worker -> host  { nonce, t: 'done', snapshot, ms }      the script and the short wait are over
 * Every message after `ready` carries the nonce the host chose, which the script never sees, so a
 * script that manages to post a message cannot pass for the sandbox.
 */
import { installSandbox, type HookEmit, type HookSnapshot } from './_js-deobf-hooks';

interface RunMessage {
  nonce: string;
  code: string;
  /** How long timers and promises of the script may still fire once it has returned. */
  graceMs: number;
  /** The hard limit the host enforces (the wait never takes the script past it). */
  limitMs: number;
}

export type SandboxMessage =
  | { kind: 'ready' }
  | ({ nonce: string } & HookEmit)
  | { nonce: string; t: 'done'; snapshot: HookSnapshot; ms: number };

// Copies of what this file needs after the script has had its chance to replace the globals.
const nativePost = self.postMessage.bind(self) as (m: SandboxMessage) => void;
const realSetTimeout = self.setTimeout.bind(self);
const now = performance.now.bind(performance);
const { max, min, round } = Math;

// What the script throws or rejects is its own business: it is recorded as its error, and must
// not reach the page as an error of the app.
self.addEventListener('unhandledrejection', (ev) => ev.preventDefault());
self.addEventListener('error', (ev) => ev.preventDefault());

self.onmessage = (ev: MessageEvent<RunMessage>) => {
  const { nonce, code, graceMs, limitMs } = ev.data;
  self.onmessage = null;
  if (typeof nonce !== 'string' || typeof code !== 'string') return;
  const emit = (m: HookEmit): void => nativePost({ nonce, ...m });
  const control = installSandbox(self, { emit });
  const started = now();
  control.run(code);
  const spent = now() - started;
  // Timers and promises of the script get a moment to fire before the result is read, but never
  // so long that the host's limit would cut a script that had finished in time.
  const room = typeof limitMs === 'number' ? limitMs - spent - 25 : graceMs;
  const wait = typeof graceMs === 'number' ? max(0, min(graceMs, room, 500)) : 0;
  realSetTimeout(
    () => nativePost({ nonce, t: 'done', snapshot: control.snapshot(), ms: round(spent) }),
    wait,
  );
};

nativePost({ kind: 'ready' });
