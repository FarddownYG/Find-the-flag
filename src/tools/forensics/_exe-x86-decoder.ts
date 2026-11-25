/**
 * Loads the ftf-x86 WebAssembly decoder (a thin iced-x86 wrapper, MIT; see wasm/ftf-x86) the first
 * time the "Instruction encoding" view runs. It returns only instruction byte lengths; the tool
 * walks those to find every opcode and does the direction-bit detection in TypeScript.
 *
 * The WebAssembly file is served from our own build (a hashed asset next to the others); the page's
 * CSP allows exactly that (`script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`).
 */
import initWasm, { instruction_lengths } from '../../../wasm/ftf-x86/pkg/ftf_x86.js';
import wasmUrl from '../../../wasm/ftf-x86/pkg/ftf_x86_bg.wasm?url';

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
  const path = createRequire(import.meta.url).resolve('../../../wasm/ftf-x86/pkg/ftf_x86_bg.wasm');
  return new Uint8Array(await readFile(path));
}

async function init(): Promise<void> {
  await initWasm(inNode() ? { module_or_path: await nodeWasmBytes() } : wasmUrl);
}

/** Ready the decoder. A failed load is not remembered (a retry may succeed). */
export function loadX86Decoder(): Promise<void> {
  loading ??= init().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** Byte length of each instruction decoded linearly from `code` at the given bitness (16/32/64). */
export async function instructionLengths(
  code: Uint8Array,
  bitness: 16 | 32 | 64,
): Promise<Uint32Array> {
  await loadX86Decoder();
  return instruction_lengths(code, bitness);
}
