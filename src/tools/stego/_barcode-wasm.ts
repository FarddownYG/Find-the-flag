/**
 * Loads the zxing-cpp reader (zxing-wasm, MIT; zxing-cpp is Apache-2.0) the first time a barcode
 * tool runs. Nothing of it is fetched before that: the JavaScript glue is a separate chunk and
 * the WebAssembly file is only requested when the module is instantiated.
 *
 * The WebAssembly file is served from our own build (a hashed file next to the other assets),
 * never from the CDN the library points to by default. The page's CSP allows exactly that:
 * `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`.
 */
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

type ReaderModule = typeof import('zxing-wasm/reader');

let loading: Promise<ReaderModule> | null = null;

function inNode(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof proc?.versions?.node === 'string' && !('window' in globalThis);
}

/** Node (the unit tests): there is no URL to fetch from, read the file out of node_modules. */
async function nodeWasm(): Promise<ArrayBuffer> {
  // Computed specifiers: the bundler must not try to pull Node's modules into the page.
  const moduleName = 'node:module';
  const fsName = 'node:fs/promises';
  const { createRequire } = (await import(
    /* @vite-ignore */ moduleName
  )) as typeof import('node:module');
  const { readFile } = (await import(
    /* @vite-ignore */ fsName
  )) as typeof import('node:fs/promises');
  const path = createRequire(import.meta.url).resolve('zxing-wasm/reader/zxing_reader.wasm');
  const bytes = await readFile(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function init(): Promise<ReaderModule> {
  const mod = await import('zxing-wasm/reader');
  await mod.prepareZXingModule({
    overrides: {
      locateFile: () => wasmUrl,
      ...(inNode() ? { wasmBinary: await nodeWasm() } : {}),
    },
    fireImmediately: true,
  });
  return mod;
}

/** The reader module, ready to use. A failed load is not remembered (a retry may succeed). */
export function loadReader(): Promise<ReaderModule> {
  loading ??= init().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}
