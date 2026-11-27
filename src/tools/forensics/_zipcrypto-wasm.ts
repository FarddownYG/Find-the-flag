/**
 * Loads the ftf-zipcrypto WebAssembly module (the Biham-Kocher known-plaintext search, written in
 * Rust; see wasm/ftf-zipcrypto) the first time the cracker runs. The heavy key search is the only
 * thing in WebAssembly; all of the ZIP parsing, the roll-back to the base keys and the decryption
 * live in TypeScript.
 *
 * The WebAssembly file is served from our own build (a hashed asset); the page's CSP allows exactly
 * that (`script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`). Nothing is fetched remotely.
 */
import initWasm, { recover_keys } from '../../../wasm/ftf-zipcrypto/pkg/ftf_zipcrypto.js';
import wasmUrl from '../../../wasm/ftf-zipcrypto/pkg/ftf_zipcrypto_bg.wasm?url';
import type { RecoverKeys } from './_zipcrypto-attack';

let loading: Promise<void> | null = null;

function inNode(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof proc?.versions?.node === 'string' && !('window' in globalThis);
}

/** Node (the unit tests): there is no URL to fetch, read the wasm from disk. */
async function nodeWasmBytes(): Promise<Uint8Array> {
  const moduleName = 'node:module';
  const fsName = 'node:fs/promises';
  const { createRequire } = (await import(
    /* @vite-ignore */ moduleName
  )) as typeof import('node:module');
  const { readFile } = (await import(
    /* @vite-ignore */ fsName
  )) as typeof import('node:fs/promises');
  const path = createRequire(import.meta.url).resolve(
    '../../../wasm/ftf-zipcrypto/pkg/ftf_zipcrypto_bg.wasm',
  );
  return new Uint8Array(await readFile(path));
}

async function init(): Promise<void> {
  await initWasm(inNode() ? { module_or_path: await nodeWasmBytes() } : wasmUrl);
}

/** Ready the search module. A failed load is not remembered (a retry may succeed). */
export function loadZipcryptoAttack(): Promise<void> {
  loading ??= init().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** Load the module and return the (synchronous) key-search function the attack glue expects. */
export async function getRecoverKeys(): Promise<RecoverKeys> {
  await loadZipcryptoAttack();
  return (plaintext, keystream) => {
    const out = recover_keys(plaintext, keystream);
    if (!out || out.length < 3) return null;
    return { k0: out[0]! >>> 0, k1: out[1]! >>> 0, k2: out[2]! >>> 0 };
  };
}
