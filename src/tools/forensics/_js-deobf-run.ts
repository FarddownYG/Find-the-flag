/**
 * Runs a pasted script in the sandbox and brings back plain text.
 *
 * In a browser: a fresh dedicated worker per run (see _js-deobf-sandbox.worker.ts), killed from
 * here, where the event loop is free, once the time limit is over. In Node (the unit tests and
 * the examples run there): the same prelude inside a `vm` context, with the vm's own timeout.
 *
 * What the sandbox says is untrusted: every message is checked, every string cut to a size, and
 * the result is rebuilt as new plain objects. Nothing from the sandbox is ever called or run.
 */
import { COMPILE_TYPES, installSandbox } from './_js-deobf-hooks';
import type { HookEvent, HookLayer, HookSnapshot } from './_js-deobf-hooks';
import type { SandboxMessage } from './_js-deobf-sandbox.worker';

export interface SandboxRunOptions {
  /** Hard limit for the script, in milliseconds. */
  timeoutMs: number;
  /** How long timers and promises of the script may still fire after it returned. */
  graceMs?: number;
}

export interface SandboxResult {
  layers: HookLayer[];
  events: HookEvent[];
  finalCode: string;
  dropped: number;
  scriptError: string;
  warnings: string[];
  timedOut: boolean;
  /** Milliseconds from the start of the script to the result. */
  ms: number;
  /** Why there is no result (the worker could not start, or died); '' otherwise. */
  failure: string;
}

/** The sizes a result is held to, whatever the sandbox sends. */
export const LIMITS = { text: 100_200, layers: 400, events: 500, warnings: 50, type: 40 } as const;

const START_TIMEOUT_MS = 10_000;
/** Timers of the script that fire within this long after it returned are kept. */
const GRACE_MS = 50;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const text = (v: unknown, max: number = LIMITS.text): string =>
  typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : '';

function cleanLayer(v: unknown): HookLayer | null {
  if (!isRecord(v)) return null;
  return {
    type: text(v['type'], LIMITS.type),
    input: text(v['input']),
    output: text(v['output']),
    error: text(v['error']),
  };
}

function cleanEvent(v: unknown): HookEvent | null {
  if (!isRecord(v)) return null;
  const kind = v['kind'];
  if (kind !== 'sink' && kind !== 'dialog' && kind !== 'console') return null;
  return { kind, name: text(v['name'], LIMITS.type), detail: text(v['detail']) };
}

function cleanSnapshot(v: unknown): HookSnapshot | null {
  if (!isRecord(v)) return null;
  const layers: HookLayer[] = [];
  if (Array.isArray(v['layers'])) {
    for (const l of v['layers'].slice(0, LIMITS.layers)) {
      const c = cleanLayer(l);
      if (c) layers.push(c);
    }
  }
  const events: HookEvent[] = [];
  if (Array.isArray(v['events'])) {
    for (const e of v['events'].slice(0, LIMITS.events)) {
      const c = cleanEvent(e);
      if (c) events.push(c);
    }
  }
  const warnings = Array.isArray(v['warnings'])
    ? v['warnings'].slice(0, LIMITS.warnings).map((w) => text(w, 300))
    : [];
  return {
    layers,
    events,
    finalCode: text(v['finalCode']),
    dropped: typeof v['dropped'] === 'number' ? Math.max(0, Math.floor(v['dropped'])) : 0,
    scriptError: text(v['scriptError'], 2000),
    warnings,
  };
}

/** The last code the script compiled, from the layers seen so far. */
export function lastCodeOf(layers: readonly HookLayer[]): string {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (COMPILE_TYPES.includes(layers[i]!.type)) return layers[i]!.input;
  }
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i]!.output) return layers[i]!.output;
  }
  return '';
}

const failure = (why: string, ms = 0): SandboxResult => ({
  layers: [],
  events: [],
  finalCode: '',
  dropped: 0,
  scriptError: '',
  warnings: [],
  timedOut: false,
  ms,
  failure: why,
});

const nonce = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

function runInWorker(code: string, opts: SandboxRunOptions): Promise<SandboxResult> {
  return new Promise<SandboxResult>((resolve) => {
    let worker: Worker;
    try {
      // Same pattern as core/runner.ts: a bundled module worker, never a blob: URL.
      worker = new Worker(new URL('./_js-deobf-sandbox.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (e) {
      resolve(failure(e instanceof Error ? e.message : String(e)));
      return;
    }
    const secret = nonce();
    const layers: HookLayer[] = [];
    const events: HookEvent[] = [];
    let snapshot: HookSnapshot | null = null;
    let started = 0;
    /** How long the script itself ran, as the worker measured it (the wait after it is not counted). */
    let scriptMs: number | null = null;
    let settled = false;
    let runTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (extra: { timedOut?: boolean; failure?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(runTimer);
      clearTimeout(startTimer);
      worker.terminate();
      const ms = scriptMs ?? (started ? Math.round(performance.now() - started) : 0);
      const snap = snapshot;
      resolve({
        layers: snap ? snap.layers : layers,
        events: snap ? snap.events : events,
        finalCode: snap ? snap.finalCode : lastCodeOf(layers),
        dropped: snap ? snap.dropped : 0,
        scriptError: snap ? snap.scriptError : '',
        warnings: snap ? snap.warnings : [],
        timedOut: extra.timedOut ?? false,
        ms,
        failure: extra.failure ?? '',
      });
    };
    const startTimer = setTimeout(
      () => settle({ failure: 'The sandbox worker did not start.' }),
      START_TIMEOUT_MS,
    );

    worker.onmessage = (ev: MessageEvent<SandboxMessage>) => {
      const m: unknown = ev.data;
      if (!isRecord(m)) return;
      if (m['kind'] === 'ready') {
        if (started) return; // only the first one counts: the script must not restart the clock
        started = performance.now();
        clearTimeout(startTimer);
        runTimer = setTimeout(() => settle({ timedOut: true }), opts.timeoutMs);
        worker.postMessage({
          nonce: secret,
          code,
          graceMs: opts.graceMs ?? GRACE_MS,
          limitMs: opts.timeoutMs,
        });
        return;
      }
      if (m['nonce'] !== secret) return;
      switch (m['t']) {
        case 'layer': {
          const l = cleanLayer(m['layer']);
          if (l && layers.length < LIMITS.layers) layers.push(l);
          break;
        }
        case 'update': {
          const i = m['i'];
          const l = typeof i === 'number' ? layers[i] : undefined;
          if (l) {
            l.output = text(m['output']);
            l.error = text(m['error']);
          }
          break;
        }
        case 'event': {
          const e = cleanEvent(m['ev']);
          if (e && events.length < LIMITS.events) events.push(e);
          break;
        }
        case 'done': {
          const took = m['ms'];
          if (typeof took === 'number' && took >= 0 && took < 1e7) scriptMs = Math.round(took);
          snapshot = cleanSnapshot(m['snapshot']);
          settle({});
          break;
        }
      }
    };
    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault();
      // Once the script runs, what it throws is its own error (the worker handles it). Before
      // that, the worker itself failed to load.
      if (!started) settle({ failure: ev.message || 'The sandbox worker could not load.' });
    };
    worker.onmessageerror = () => settle({ failure: 'The sandbox sent something unreadable.' });
  });
}

/** atob for a bare V8 context, which has none (a worker or a page has its own). */
const VM_ATOB = `
globalThis.atob = function atob(input) {
  var s = String(input).replace(/[\\t\\n\\f\\r ]/g, '');
  if (s.length % 4 === 0) s = s.replace(/==?$/, '');
  if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) throw new Error('InvalidCharacterError');
  var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = '', bits = 0, acc = 0;
  for (var i = 0; i < s.length; i++) {
    acc = (acc << 6) | abc.indexOf(s[i]);
    bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 255); acc &= (1 << bits) - 1; }
  }
  return out;
};
`;

/** The same prelude and script in a Node `vm` context (tests only: a worker does this in a page). */
export async function runInNodeVm(code: string, opts: SandboxRunOptions): Promise<SandboxResult> {
  const moduleName = ['node', 'vm'].join(':');
  const vm = (await import(/* @vite-ignore */ moduleName)) as typeof import('node:vm');
  // A context with no prototype on its global object: `this.constructor` is the context's own.
  const context = vm.createContext(Object.create(null) as object);
  const started = Date.now();
  // One script: the controller never becomes a property of the global, so the script cannot reach it.
  const program = `'use strict';
(function () {
  const stringify = JSON.stringify;
  const control = (${installSandbox.toString()})(globalThis, {});
  control.run(${JSON.stringify(code)});
  return stringify(control.snapshot());
})()`;
  try {
    vm.runInContext(VM_ATOB, context, { timeout: opts.timeoutMs });
    const json = vm.runInContext(program, context, { timeout: opts.timeoutMs }) as unknown;
    const snap = typeof json === 'string' ? cleanSnapshot(JSON.parse(json) as unknown) : null;
    if (!snap) return failure('The sandbox returned nothing readable.', Date.now() - started);
    return { ...snap, timedOut: false, ms: Date.now() - started, failure: '' };
  } catch (e) {
    const timedOut = isRecord(e) && e['code'] === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
    if (timedOut) return { ...failure('', Date.now() - started), timedOut: true };
    return failure(e instanceof Error ? e.message : String(e), Date.now() - started);
  }
}

const inNode = (): boolean =>
  typeof process !== 'undefined' && typeof process.versions?.node === 'string';

/** Run `code` in the sandbox: a worker in a browser, a vm context in Node. */
export async function runSandbox(code: string, opts: SandboxRunOptions): Promise<SandboxResult> {
  if (typeof Worker === 'function') return runInWorker(code, opts);
  if (inNode()) return runInNodeVm(code, opts);
  return failure('this browser cannot start a worker from the worker that runs the tools');
}
