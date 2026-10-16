import { toBase64, utf8Encode } from '../../lib/bytes';

/**
 * The sample scripts of the JavaScript deobfuscator, made from made-up payloads (FTF{…}) by
 * scripts/gen-samples-js-deobf.mjs. The tool's examples and tests read the files; the tests also
 * check that these builders still produce exactly the committed bytes.
 */

const b64 = (s: string): string => toBase64(utf8Encode(s));
const octal = (s: string): string =>
  Array.from(s, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`).join('');
const percent = (s: string): string =>
  Array.from(s, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');

export const STATIC_FLAG = 'FTF{static_peel}';
export const LAYERS_FLAG = 'FTF{hooked_function}';
export const NESTED_FLAG = 'FTF{nested_eval}';

/** Escapes, a joined string, String.fromCharCode, unescape and atob around a payload. */
export function staticSample(): string {
  const payload = `alert("${STATIC_FLAG}");`;
  const inner = `eval(atob("${b64(payload)}"));`;
  return [
    'var greeting = "\\x48\\x65\\x6c" + "lo " + String.fromCharCode(67, 84, 70) + "!";',
    `eval(unescape("${percent(inner)}"));`,
    '',
  ].join('\n');
}

/** Function(Function("return '…'")())(): the payload is written in octal escapes. */
export function layersSample(): string {
  const payload = `alert("${LAYERS_FLAG}")`;
  return `Function(Function("return '${octal(payload)}'")())()\n`;
}

/** eval(atob("…")) where the decoded text is itself eval(atob("…")). */
export function nestedEvalSample(): string {
  const inner = `alert("${NESTED_FLAG}");`;
  const middle = `eval(atob("${b64(inner)}"));`;
  return `eval(atob("${b64(middle)}"));\n`;
}

export function buildSamples(): Record<string, string> {
  return {
    'js-deobf-static.txt': staticSample(),
    'js-deobf-layers.txt': layersSample(),
    'js-deobf-nested-eval.txt': nestedEvalSample(),
  };
}
