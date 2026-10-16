/**
 * The prelude of the JavaScript sandbox: it runs FIRST in the sandbox's global scope, before the
 * pasted script, and turns that scope into a recording, network-less one.
 *
 *  - eval, Function (and the AsyncFunction / GeneratorFunction / AsyncGeneratorFunction constructors,
 *    reached through Function.prototype.constructor and friends), setTimeout("code"), unescape, atob,
 *    decodeURIComponent and document.write are replaced by wrappers that record a layer
 *    {type, input, output} (text only) and then do what the original did, so the decryption goes on.
 *  - Every way out is replaced by a stub that records the attempt and does nothing: fetch,
 *    XMLHttpRequest, WebSocket, EventSource, WebTransport, importScripts, sendBeacon, Worker,
 *    SharedWorker, the Cache / IndexedDB storage, postMessage, close, and the word `import` (so
 *    import("https://...") cannot be written, even inside a string passed to eval). alert, confirm,
 *    prompt and console are recorded too, never shown.
 *  - What a script could use to read the engine's stack frames (Error.prepareStackTrace) is closed.
 *
 * `installSandbox` is ONE self-contained function: it uses nothing but the globals of the realm it
 * runs in, and it keeps its own copy of every built-in it needs, taken before anything is replaced
 * (a script that overwrites Array.prototype.push, Reflect.apply or String.prototype.slice afterwards
 * changes nothing for the hooks). That is what lets the tests run it inside a Node `vm` context (by
 * its source text, so the hooks and the script share one realm, like in the worker) and the worker
 * call it directly. It must not import anything or use a helper from this file.
 *
 * Design limits, stated in the tool: a script that reads Function.prototype.toString() or checks
 * its environment can see the hooks and stop; eval is called indirectly (a direct eval inside a
 * function cannot read that function's local variables here); nothing needing a real DOM exists;
 * the word `import` is renamed wherever it is written, strings included.
 */

export interface HookLayer {
  type: string;
  input: string;
  output: string;
  error: string;
}

export interface HookEvent {
  /** sink: a blocked way out · dialog: alert/confirm/prompt · console: console.* output. */
  kind: 'sink' | 'dialog' | 'console';
  name: string;
  detail: string;
}

/** What the prelude reports as it happens (the worker forwards it, so a run cut short keeps it). */
export type HookEmit =
  | { t: 'layer'; i: number; layer: HookLayer }
  | { t: 'update'; i: number; output: string; error: string }
  | { t: 'event'; ev: HookEvent };

export interface HookSnapshot {
  layers: HookLayer[];
  events: HookEvent[];
  /** The last piece of code the script compiled (else the last thing it decoded). */
  finalCode: string;
  /** Layers that were not kept because there were too many. */
  dropped: number;
  /** The error that stopped the script ('' if it ran to the end). */
  scriptError: string;
  /** Things the prelude could not neutralise here (should be empty). */
  warnings: string[];
}

export interface HookControl {
  /** Run the script (sanitised, as an indirect eval). Returns the error message, or ''. */
  run(code: string): string;
  snapshot(): HookSnapshot;
}

export interface HookOptions {
  maxText?: number;
  maxLayers?: number;
  maxEvents?: number;
  maxTotal?: number;
  emit?: (m: HookEmit) => void;
}

/** Layer types whose input is code the script compiled. */
export const COMPILE_TYPES: readonly string[] = [
  'eval',
  'Function',
  'AsyncFunction',
  'GeneratorFunction',
  'AsyncGeneratorFunction',
  'setTimeout',
  'setInterval',
];

type Dict = Record<string, unknown>;
type AnyFn = (...args: unknown[]) => unknown;
/** What this file needs to know of a built-in constructor (Function and its siblings). */
interface Ctor {
  prototype: object;
  name: string;
}

export function installSandbox(g: object, options?: HookOptions): HookControl {
  'use strict';
  const G = g as Dict;
  const opt: HookOptions = options ?? {};
  const MAX_TEXT = opt.maxText ?? 100_000;
  const MAX_LAYERS = opt.maxLayers ?? 300;
  const MAX_EVENTS = opt.maxEvents ?? 200;
  const MAX_TOTAL = opt.maxTotal ?? 4_000_000;

  // ---- the built-ins this function needs, taken before anything is replaced ----
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const getPrototypeOf = Object.getPrototypeOf;
  const reflectApply = Reflect.apply;
  const reflectConstruct = Reflect.construct;
  const reflectGet = Reflect.get;
  const NativeProxy = Proxy;
  const NativePromise = Promise;
  const NativeError = Error;
  const NativeTypeError = TypeError;
  const toStr = String;
  const nativeEval = G['eval'] as (code: string) => unknown;
  const NativeFunction = Function as unknown as Ctor;
  const fnToString = Function.prototype.toString;
  const strIndexOf = String.prototype.indexOf;
  const strSlice = String.prototype.slice;
  const strCharCodeAt = String.prototype.charCodeAt;

  const slice = (s: string, a: number, b?: number): string =>
    reflectApply(strSlice, s, b === undefined ? [a] : [a, b]) as string;
  const indexOf = (s: string, what: string, from: number): number =>
    reflectApply(strIndexOf, s, [what, from]) as number;
  const code = (s: string, i: number): number => reflectApply(strCharCodeAt, s, [i]) as number;

  // ---- what is recorded ----
  const layers: HookLayer[] = [];
  const events: HookEvent[] = [];
  const warnings: string[] = [];
  let dropped = 0;
  let total = 0;
  let lastCode = '';
  let lastDecoded = '';
  let scriptError = '';
  let importRewrites = 0;
  let consoleCount = 0;
  let otherCount = 0;

  const COMPILE = [
    'eval',
    'Function',
    'AsyncFunction',
    'GeneratorFunction',
    'AsyncGeneratorFunction',
    'setTimeout',
    'setInterval',
  ];
  const isCompile = (type: string): boolean => {
    for (let k = 0; k < COMPILE.length; k++) if (COMPILE[k] === type) return true;
    return false;
  };

  const warn = (what: string): void => {
    if (warnings.length < 50) warnings[warnings.length] = what;
  };

  const emit = (m: HookEmit): void => {
    const fn = opt.emit;
    if (!fn) return;
    try {
      fn(m);
    } catch {
      warn('emit failed');
    }
  };

  const cap = (s: string): string => {
    const limit = total > MAX_TOTAL ? 200 : MAX_TEXT;
    const out = s.length > limit ? slice(s, 0, limit) + '…[+' + (s.length - limit) + ' chars]' : s;
    total += out.length;
    return out;
  };

  /** Any value as text, without ever throwing. */
  const str = (v: unknown): string => {
    try {
      if (typeof v === 'string') return v;
      if (typeof v === 'function') return reflectApply(fnToString, v, []) as string;
      return toStr(v);
    } catch {
      warn('unprintable value: ' + typeof v);
      return '[unprintable ' + typeof v + ']';
    }
  };

  const begin = (type: string, input: string): number => {
    if (layers.length >= MAX_LAYERS) {
      dropped++;
      if (isCompile(type)) lastCode = cap(input);
      return -1;
    }
    const layer: HookLayer = { type, input: cap(input), output: '', error: '' };
    const i = layers.length;
    layers[i] = layer;
    if (isCompile(type)) lastCode = layer.input;
    emit({ t: 'layer', i, layer: { type, input: layer.input, output: '', error: '' } });
    return i;
  };

  const finish = (i: number, output: string, error: string): void => {
    if (i < 0) return;
    const layer = layers[i]!;
    layer.output = cap(output);
    layer.error = cap(error);
    emit({ t: 'update', i, output: layer.output, error: layer.error });
  };

  const addEvent = (kind: HookEvent['kind'], name: string, detail: string): void => {
    if (kind === 'console') {
      if (consoleCount >= MAX_EVENTS) return;
      consoleCount++;
    } else {
      if (otherCount >= MAX_EVENTS) return;
      otherCount++;
    }
    const ev: HookEvent = { kind, name, detail: cap(detail) };
    events[events.length] = ev;
    emit({ t: 'event', ev: { kind, name, detail: ev.detail } });
  };

  // ---- `import` can never be written, so no module can be fetched ----
  const isSpaceCode = (k: number): boolean =>
    k === 0xa0 ||
    k === 0x85 ||
    k === 0xfeff ||
    k === 0x1680 ||
    k === 0x180e ||
    (k >= 0x2000 && k <= 0x200f) ||
    (k >= 0x2028 && k <= 0x202f) ||
    (k >= 0x205f && k <= 0x206f) ||
    k === 0x3000;
  const isIdentCode = (k: number): boolean =>
    (k >= 48 && k <= 57) ||
    (k >= 65 && k <= 90) ||
    (k >= 97 && k <= 122) ||
    k === 95 ||
    k === 36 ||
    k === 92 ||
    (k >= 128 && !isSpaceCode(k));

  /**
   * Every code the sandbox compiles goes through here first. The keyword `import` cannot be
   * written with escapes, so renaming every whole word `import` (a key or a `.import` is renamed the same way, so it still matches) leaves no
   * way to write import(…): `import("https://x")` becomes a call of the recorded stub below.
   */
  const sanitize = (src: string): string => {
    let from = 0;
    let out = '';
    let n = 0;
    let pos = indexOf(src, 'import', 0);
    while (pos >= 0) {
      const before = pos > 0 ? code(src, pos - 1) : NaN;
      const after = code(src, pos + 6);
      if (!isIdentCode(before) && !isIdentCode(after)) {
        out += slice(src, from, pos) + '__imp__';
        from = pos + 6;
        n++;
      }
      pos = indexOf(src, 'import', pos + 6);
    }
    if (n === 0) return src;
    importRewrites += n;
    return out + slice(src, from);
  };

  // ---- names ----
  const rename = (fn: unknown, name: string): void => {
    try {
      defineProperty(fn as object, 'name', { value: name, configurable: true });
    } catch (e) {
      warn('name: ' + toStr(e));
    }
  };

  /** Replace `name` on `obj` and on every object of its prototype chain that owns it. */
  const replaceEverywhere = (obj: unknown, name: string, value: unknown): void => {
    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return;
    let owned = false;
    let o: object | null = obj as object;
    while (o) {
      if (getOwnPropertyDescriptor(o, name)) {
        owned = true;
        try {
          defineProperty(o, name, {
            value,
            writable: false,
            configurable: true,
            enumerable: false,
          });
        } catch (e) {
          warn('cannot replace ' + name + ': ' + toStr(e));
        }
      }
      o = getPrototypeOf(o);
    }
    if (!owned) {
      try {
        defineProperty(obj, name, {
          value,
          writable: false,
          configurable: true,
          enumerable: false,
        });
      } catch (e) {
        warn('cannot define ' + name + ': ' + toStr(e));
      }
    }
  };

  // ---- the code compilers ----
  const hookedEval = function (this: unknown, x?: unknown): unknown {
    if (typeof x !== 'string') return nativeEval(x as string);
    const i = begin('eval', x);
    let r: unknown;
    try {
      r = nativeEval(sanitize(x));
    } catch (e) {
      finish(i, '', str(e));
      throw e;
    }
    finish(i, str(r), '');
    return r;
  };
  rename(hookedEval, 'eval');

  /** The function the script made watches itself: the first value it returns completes its layer. */
  const watch = (fn: unknown, i: number): unknown => {
    if (i < 0) return fn;
    let first = true;
    return new NativeProxy(fn as object, {
      apply(target: object, thisArg: unknown, argArray: ArrayLike<unknown>): unknown {
        if (!first) return reflectApply(target as AnyFn, thisArg, argArray as unknown[]);
        first = false;
        let r: unknown;
        try {
          r = reflectApply(target as AnyFn, thisArg, argArray as unknown[]);
        } catch (e) {
          finish(i, '', str(e));
          throw e;
        }
        finish(i, str(r), '');
        return r;
      },
      get(target: object, key: string | symbol, receiver: unknown): unknown {
        if (key === 'toString') return () => reflectApply(fnToString, target, []);
        return reflectGet(target, key, receiver);
      },
    });
  };

  const makeConstructorHook = (type: string, Native: Ctor): AnyFn => {
    const Hooked = function (this: unknown, ...args: unknown[]): unknown {
      const n = args.length;
      const parts: unknown[] = [];
      for (let k = 0; k < n; k++) {
        const a = args[k];
        parts[k] = typeof a === 'symbol' ? a : str(a);
      }
      const last = n > 0 ? parts[n - 1] : '';
      const input = typeof last === 'string' ? last : '';
      const clean: unknown[] = [];
      for (let k = 0; k < n; k++) {
        const p = parts[k];
        clean[k] = typeof p === 'string' ? sanitize(p) : p;
      }
      const i = begin(type, input);
      let fn: unknown;
      try {
        fn = reflectConstruct(Native as unknown as AnyFn, clean, new.target || Hooked);
      } catch (e) {
        finish(i, '', str(e));
        throw e;
      }
      return watch(fn, i);
    };
    Hooked.prototype = Native.prototype;
    rename(Hooked, Native.name);
    return Hooked;
  };

  const HookedFunction = makeConstructorHook('Function', NativeFunction);
  defineProperty(NativeFunction.prototype, 'constructor', {
    value: HookedFunction,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  defineProperty(g, 'Function', {
    value: HookedFunction,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  defineProperty(g, 'eval', {
    value: hookedEval,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  const otherKinds: [string, object][] = [
    ['AsyncFunction', getPrototypeOf(async function () {})],
    ['GeneratorFunction', getPrototypeOf(function* () {})],
    ['AsyncGeneratorFunction', getPrototypeOf(async function* () {})],
  ];
  for (let k = 0; k < otherKinds.length; k++) {
    const [type, proto] = otherKinds[k]!;
    const Native = (proto as { constructor: Ctor }).constructor;
    defineProperty(proto, 'constructor', {
      value: makeConstructorHook(type, Native),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  // ---- the decoders ----
  const hookDecoder = (name: string): void => {
    const native = G[name];
    if (typeof native !== 'function') return;
    const hooked = function (this: unknown, ...args: unknown[]): unknown {
      const n = args.length;
      const passed: unknown[] = [];
      for (let k = 0; k < n; k++) passed[k] = args[k];
      let input = '';
      if (n > 0 && typeof passed[0] !== 'symbol') {
        input = str(passed[0]);
        passed[0] = input;
      }
      const i = begin(name, input);
      let r: unknown;
      try {
        r = reflectApply(native as AnyFn, this, passed);
      } catch (e) {
        finish(i, '', str(e));
        throw e;
      }
      const out = str(r);
      if (typeof r === 'string') lastDecoded = cap(r);
      finish(i, out, '');
      return r;
    };
    rename(hooked, name);
    replaceEverywhere(g, name, hooked);
  };
  hookDecoder('unescape');
  hookDecoder('atob');
  hookDecoder('decodeURIComponent');

  // ---- timers: a string handler is code, so it is recorded and sanitised like eval ----
  const hookTimer = (name: string): void => {
    const native = G[name];
    if (typeof native !== 'function') return;
    const hooked = function (this: unknown, ...args: unknown[]): unknown {
      const n = args.length;
      const passed: unknown[] = [];
      for (let k = 0; k < n; k++) passed[k] = args[k];
      const handler = passed[0];
      if (typeof handler === 'string') {
        const source = handler;
        const i = begin(name, source);
        passed[0] = function (): void {
          try {
            nativeEval(sanitize(source));
          } catch (e) {
            finish(i, '', str(e));
            throw e;
          }
          // The value of the code is not returned to anybody by a timer: the layer has no output.
          finish(i, '', '');
        };
      }
      return reflectApply(native as AnyFn, g, passed);
    };
    rename(hooked, name);
    replaceEverywhere(g, name, hooked);
  };
  hookTimer('setTimeout');
  hookTimer('setInterval');

  // ---- the ways out ----
  const sink = (name: string, detail: string): void => addEvent('sink', name, detail);

  const blockedConstructor = (name: string): void => {
    const stub = function (this: unknown, ...args: unknown[]): never {
      sink(name, args.length > 0 ? str(args[0]) : '');
      throw new NativeError('Blocked by the sandbox: ' + name + ' is not available here');
    };
    rename(stub, name);
    replaceEverywhere(g, name, stub);
  };
  const blocked = [
    'WebSocket',
    'WebSocketStream',
    'WebTransport',
    'EventSource',
    'Worker',
    'SharedWorker',
    'RTCPeerConnection',
    'webkitRTCPeerConnection',
    'BroadcastChannel',
    'FontFace',
    'ShadowRealm',
  ];
  for (let k = 0; k < blocked.length; k++) blockedConstructor(blocked[k]!);

  const describeRequest = (input: unknown, init: unknown): string => {
    let url: string;
    if (input !== null && typeof input === 'object' && typeof (input as Dict)['url'] === 'string') {
      url = (input as Dict)['url'] as string;
    } else {
      url = str(input);
    }
    const method =
      init !== null && typeof init === 'object' && typeof (init as Dict)['method'] === 'string'
        ? ((init as Dict)['method'] as string)
        : '';
    return method ? method + ' ' + url : url;
  };

  const blockedFetch = function (this: unknown, input?: unknown, init?: unknown): unknown {
    sink('fetch', describeRequest(input, init));
    return NativePromise.reject(new NativeTypeError('Failed to fetch'));
  };
  rename(blockedFetch, 'fetch');
  replaceEverywhere(g, 'fetch', blockedFetch);
  replaceEverywhere(g, 'fetchLater', blockedFetch);

  const InertXhr = function (this: unknown): unknown {
    const noop = (): void => undefined;
    return {
      readyState: 0,
      status: 0,
      responseText: '',
      response: null,
      onload: null,
      onerror: null,
      onreadystatechange: null,
      open(method?: unknown, url?: unknown): void {
        sink('XMLHttpRequest', str(method) + ' ' + str(url));
      },
      send(body?: unknown): void {
        sink('XMLHttpRequest.send', body === undefined || body === null ? '' : str(body));
      },
      setRequestHeader: noop,
      abort: noop,
      addEventListener: noop,
      removeEventListener: noop,
    };
  };
  rename(InertXhr, 'XMLHttpRequest');
  replaceEverywhere(g, 'XMLHttpRequest', InertXhr);

  const blockedImportScripts = function (this: unknown, ...urls: unknown[]): never {
    for (let k = 0; k < urls.length; k++) sink('importScripts', str(urls[k]));
    throw new NativeError('Blocked by the sandbox: importScripts is not available here');
  };
  rename(blockedImportScripts, 'importScripts');
  replaceEverywhere(g, 'importScripts', blockedImportScripts);

  const blockedImport = function (this: unknown, specifier?: unknown): unknown {
    sink('import()', str(specifier));
    return NativePromise.reject(new NativeTypeError('Failed to fetch dynamically imported module'));
  };
  rename(blockedImport, 'import');
  defineProperty(g, '__imp__', {
    value: blockedImport,
    writable: false,
    configurable: false,
    enumerable: false,
  });

  const blockedBeacon = function (this: unknown, url?: unknown): boolean {
    sink('sendBeacon', str(url));
    return false;
  };
  rename(blockedBeacon, 'sendBeacon');
  const nav = G['navigator'];
  replaceEverywhere(nav, 'sendBeacon', blockedBeacon);
  for (const name of ['serviceWorker', 'storage', 'locks']) {
    if (nav !== null && typeof nav === 'object') replaceEverywhere(nav, name, undefined);
  }
  // Storage shared with the site itself: not for a pasted script.
  for (const name of [
    'indexedDB',
    'caches',
    'webkitRequestFileSystem',
    'webkitResolveLocalFileSystemURL',
  ]) {
    replaceEverywhere(g, name, undefined);
  }

  // The worker's own line to the page: a script must not be able to write to it.
  const blockedPost = function (this: unknown): void {
    sink('postMessage', '');
  };
  rename(blockedPost, 'postMessage');
  replaceEverywhere(g, 'postMessage', blockedPost);

  // close() would end the worker before it can report: the script gets a recorded no-op instead.
  const blockedClose = function (this: unknown): void {
    sink('close', '');
  };
  rename(blockedClose, 'close');
  replaceEverywhere(g, 'close', blockedClose);

  // ---- dialogs and console: recorded, never shown ----
  const dialog = (name: string, result: unknown): void => {
    const stub = function (this: unknown, message?: unknown): unknown {
      addEvent('dialog', name, message === undefined ? '' : str(message));
      return result;
    };
    rename(stub, name);
    replaceEverywhere(g, name, stub);
  };
  dialog('alert', undefined);
  dialog('confirm', false);
  dialog('prompt', null);

  let con = G['console'];
  if (con === null || (typeof con !== 'object' && typeof con !== 'function')) {
    con = {};
    defineProperty(g, 'console', {
      value: con,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'];
  for (let k = 0; k < consoleMethods.length; k++) {
    const method = consoleMethods[k]!;
    const stub = function (this: unknown, ...args: unknown[]): void {
      let line = '';
      for (let j = 0; j < args.length; j++) line += (j > 0 ? ' ' : '') + str(args[j]);
      addEvent('console', 'console.' + method, line);
    };
    rename(stub, method);
    replaceEverywhere(con, method, stub);
  }

  if (G['window'] === undefined) replaceEverywhere(g, 'window', g);
  if (G['self'] === undefined) replaceEverywhere(g, 'self', g);

  // document.write(unescape("…")) is the classic, and `document` is read before its argument is
  // evaluated: without it the script would stop before the decoding. There is no page, but what the
  // page would have been given is a layer (it is text: nothing is rendered or run).
  if (G['document'] === undefined) {
    const writer = (name: string, method: string): AnyFn => {
      const stub = function (this: unknown, ...args: unknown[]): void {
        let text = '';
        for (let j = 0; j < args.length; j++) text += str(args[j]);
        const i = begin(name, text);
        lastDecoded = cap(text);
        finish(i, '', '');
      };
      rename(stub, method);
      return stub;
    };
    const doc: Dict = { cookie: '', referrer: '', title: '' };
    doc['write'] = writer('document.write', 'write');
    doc['writeln'] = writer('document.writeln', 'writeln');
    replaceEverywhere(g, 'document', doc);
  }

  // A script must not be able to read the engine's stack frames (they can hold functions).
  try {
    defineProperty(Error, 'prepareStackTrace', {
      value: undefined,
      writable: false,
      configurable: false,
    });
  } catch (e) {
    warn('prepareStackTrace: ' + toStr(e));
  }

  return {
    run(source: string): string {
      try {
        nativeEval(sanitize(source));
        return '';
      } catch (e) {
        scriptError = str(e);
        return scriptError;
      }
    },
    snapshot(): HookSnapshot {
      const outLayers: HookLayer[] = [];
      for (let k = 0; k < layers.length; k++) {
        const l = layers[k]!;
        outLayers[k] = { type: l.type, input: l.input, output: l.output, error: l.error };
      }
      const outEvents: HookEvent[] = [];
      for (let k = 0; k < events.length; k++) {
        const e = events[k]!;
        outEvents[k] = { kind: e.kind, name: e.name, detail: e.detail };
      }
      if (importRewrites > 0) {
        outEvents[outEvents.length] = {
          kind: 'sink',
          name: 'import()',
          detail:
            'the word "import" was renamed ' + importRewrites + ' time(s): no module can load',
        };
      }
      const outWarnings: string[] = [];
      for (let k = 0; k < warnings.length; k++) outWarnings[k] = warnings[k]!;
      return {
        layers: outLayers,
        events: outEvents,
        finalCode: lastCode || lastDecoded,
        dropped,
        scriptError,
        warnings: outWarnings,
      };
    },
  };
}
