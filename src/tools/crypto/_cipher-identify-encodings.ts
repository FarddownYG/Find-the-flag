import { prepareInput } from '../../core/prepare';
import { registeredTools } from '../../core/tool-list';
import type { AnyTool, Sample } from '../../core/types';
import { toolName, toolT } from '../../i18n/tool-text';
import { plaintextScore } from '../../lib/english';
import { printableRatio, utf8Decode, utf8Encode } from '../../lib/bytes';
import { readability } from '../../lib/readability';
import { autoDecode } from '../encoding/auto-decode';
import type { FamilyId } from './_cipher-identify-rank';
import type { Stats } from './_cipher-identify-stats';

const T = toolT('cipher-identify');

/**
 * What the other tools already know about a pasted text: the detect() of every encoding and
 * crypto tool in the registry (the same triage the home page uses), checked by actually decoding,
 * plus the chain Auto-decode finds and a look at the bytes an encoding hides. Nothing here
 * duplicates a rule of those tools: a new tool with a detect() is picked up by itself.
 */

export interface Shape {
  /** The tool to open for it. */
  tool: AnyTool;
  /** 0..100. */
  score: number;
  reasons: string[];
  against: string[];
  options: Record<string, unknown>;
  /** An encoding (not a cipher or a hash). */
  encoding: boolean;
  /** Its decoding (or Auto-decode's) reads as text: an encoding that matched for sure. */
  decoded: boolean;
  /** The statistical family this tool stands for, when the identifier has one. */
  family: FamilyId | null;
}

/** Tools whose detect() the statistical families already cover: the two are merged. */
const SAME_FAMILY: Record<string, FamilyId> = {
  playfair: 'playfair',
  adfgvx: 'adfgx',
  bacon: 'bacon',
  enigma: 'flat',
  polybius: 'polybius',
  atbash: 'atbash',
};

/**
 * Not asked: the identifier itself, the chain finder, and the base converter, which shows the same
 * codes as the Binary, Hex and Char codes tools it would tie with.
 */
const SKIP = new Set(['cipher-identify', 'auto-decode', 'base-convert']);

/**
 * Size of the alphabet of the encodings that are only recognised by their characters. A text of
 * L symbols encoding random data uses about A(1 - (1 - 1/A)^L) different ones: a string of 192
 * hex digits is not Base64, whose alphabet it uses a quarter of. (Used only to discard a match,
 * never to add one.)
 */
const ALPHABET: Record<string, number> = {
  hex: 16,
  base32: 32,
  base36: 36,
  base45: 45,
  base58: 58,
  base62: 62,
  base64: 64,
  base85: 85,
  base91: 91,
};
/** Longer texts are still looked at by detect(), but not decoded to check. */
const MAX_VERIFY = 50_000;
const PREVIEW = 70;
const FLAG_SHAPE = /\b[A-Za-z]{2,12}\{[A-Za-z0-9_-]{3,}\}/;
const TRANSFORM_STEP = /^(rot13|rot47|atbash|reverse)/;

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
const preview = (s: string): string => {
  const one = flat(s);
  return one.length > PREVIEW ? `${one.slice(0, PREVIEW)}…` : one;
};

/** The text these bytes spell if it reads as language or looks like a flag, else null. */
function readableText(bytes: Uint8Array): string | null {
  if (bytes.length < 4 || printableRatio(bytes) < 0.9) return null;
  const text = utf8Decode(bytes).slice(0, 4000);
  if (FLAG_SHAPE.test(text)) return text;
  if (plaintextScore(text) >= 55 && readability(text, ['en', 'fr']).score >= 30) return text;
  return null;
}

function defaultsOf(tool: AnyTool): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(tool.options ?? {})) out[key] = spec.default;
  return out;
}

/** What the tool gives for the text with these options: the first bytes or text block. */
async function decodeWith(
  tool: AnyTool,
  text: string,
  options: Record<string, unknown>,
): Promise<Uint8Array | null> {
  try {
    const input = await prepareInput(tool.input, { text });
    const result = await tool.run(input as never, { ...defaultsOf(tool), ...options } as never);
    for (const out of result) {
      if (out.type === 'bytes') return out.value;
      if (out.type === 'text') return utf8Encode(out.value);
    }
  } catch {
    // A tool that refuses the text (a ToolError, a malformed input) simply is not that encoding.
    return null;
  }
  return null;
}

/** Expected Shannon entropy (bits per byte) of n random bytes, with the bias of small samples. */
export function expectedEntropy(n: number): number {
  const m = Math.min(n, 256);
  const big = Math.max(n, 256);
  return Math.log2(m) - m / (2 * big * Math.LN2);
}

export function byteEntropy(bytes: Uint8Array): number {
  const counts = new Array<number>(256).fill(0);
  for (const b of bytes) counts[b]!++;
  let h = 0;
  for (const c of counts) if (c) h -= (c / bytes.length) * Math.log2(c / bytes.length);
  return h;
}

/** Bytes that are not text: one-byte XOR, random-looking data, or structure a repeating key leaves. */
function bytesShapes(bytes: Uint8Array, tools: Map<string, AnyTool>): Shape[] {
  const out: Shape[] = [];
  const xor = tools.get('xor');
  const symmetric = tools.get('symmetric');
  if (bytes.length < 8) return out;

  if (xor) {
    // Every one-byte key: the one whose result reads best, if any reads as text at all.
    let best: { key: number; text: string; score: number } | null = null;
    for (let key = 1; key < 256; key++) {
      const mixed = bytes.map((b) => b ^ key);
      if (printableRatio(mixed) < 0.97) continue;
      const text = readableText(mixed);
      if (!text) continue;
      const score = plaintextScore(text);
      if (!best || score > best.score) best = { key, text, score };
    }
    if (best) {
      out.push({
        tool: xor,
        score: 92,
        reasons: [
          T('reason.bytes.singleXor', {
            key: best.key.toString(16).padStart(2, '0'),
            preview: preview(best.text),
          }),
        ],
        against: [],
        options: { mode: 'brute' },
        encoding: false,
        decoded: false,
        family: null,
      });
      return out;
    }
  }

  const h = byteEntropy(bytes);
  const expected = expectedEntropy(bytes.length);
  const params = { entropy: h.toFixed(2), expected: expected.toFixed(2), size: bytes.length };
  // A few dozen bytes cannot fill the 256 values: the entropy of small samples varies more.
  const slack = 0.25 + 4 / bytes.length;
  if (h >= expected - slack && bytes.length >= 16 && symmetric) {
    const block = bytes.length % 16 === 0 ? 16 : bytes.length % 8 === 0 ? 8 : 0;
    out.push({
      tool: symmetric,
      score: 55 + (block === 16 ? 15 : block === 8 ? 8 : 0),
      reasons: [
        T('reason.bytes.random', params),
        ...(block ? [T('reason.bytes.blocks', { size: bytes.length, block })] : []),
      ],
      against: [],
      options: {},
      encoding: false,
      decoded: false,
      family: null,
    });
  } else if (h < expected - 0.6 && bytes.length >= 24 && xor && printableRatio(bytes) < 0.9) {
    out.push({
      tool: xor,
      score: 50,
      reasons: [T('reason.bytes.structured', params)],
      against: [],
      options: { mode: 'crack' },
      encoding: false,
      decoded: false,
      family: null,
    });
  }
  return out;
}

/** The text uses far fewer symbols than random data in this tool's alphabet would. */
function tooFewSymbols(id: string, stats: Stats): boolean {
  const size = ALPHABET[id];
  if (!size) return false;
  const expected = size * (1 - (1 - 1 / size) ** stats.symbols);
  return stats.distinct < expected * 0.6;
}

/** Everything the registry's detect() and Auto-decode say about the text, strongest first. */
export async function findShapes(text: string, stats: Stats): Promise<Shape[]> {
  const TOOLS = registeredTools();
  const byId = new Map(TOOLS.map((t) => [t.id, t] as const));
  const bytes = utf8Encode(text);
  const sample: Sample = { text, bytes };
  // Letters and spaces only, or digits and spaces only: no random-looking encoding is made of a
  // single kind of character, so a match on the alphabet alone is noise.
  const classical =
    (stats.digits === 0 && stats.others === 0 && stats.letters > 0) || stats.digitsOnly;
  const shapes: Shape[] = [];
  // The bytes of the best-scoring encoding that did not decode to text.
  let data: { score: number; bytes: Uint8Array } | null = null;

  for (const tool of TOOLS) {
    if (SKIP.has(tool.id) || !tool.detect) continue;
    if (tool.category !== 'encoding' && tool.category !== 'crypto') continue;
    let found;
    try {
      found = tool.detect(sample);
    } catch {
      continue; // a detector that throws does not vote
    }
    if (!found || found.score < 0.25) continue;
    const options = (found.options ?? {}) as Record<string, unknown>;
    const why = found.reason ?? '';
    const family = SAME_FAMILY[tool.id] ?? null;
    if (tool.category === 'crypto') {
      shapes.push({
        tool,
        score: Math.round(found.score * 100),
        reasons: [T('reason.triage', { tool: toolName(tool), why })],
        against: [],
        options,
        encoding: false,
        decoded: false,
        family,
      });
      continue;
    }
    const decoded = text.length <= MAX_VERIFY ? await decodeWith(tool, text, options) : null;
    const readable = decoded ? readableText(decoded) : null;
    // An encoding recognised by its alphabet alone (Base64, hex...) matches any text made of
    // letters, so it must decode to text to count. The others (Morse, binary, NATO words,
    // Braille...) are recognised by a shape of their own and their detect() is trusted.
    const byAlphabet = tool.id in ALPHABET;
    const printable = decoded !== null && decoded.length >= 3 && printableRatio(decoded) >= 0.95;
    if (readable || (!byAlphabet && printable && found.score >= 0.85)) {
      const shown = readable ?? utf8Decode(decoded!);
      shapes.push({
        tool,
        score: Math.round(Math.max(found.score, readable ? 0.9 : 0) * 100),
        reasons: [
          T('reason.triage', { tool: toolName(tool), why }),
          T('reason.encoding.decodes', { preview: preview(shown) }),
        ],
        against: [],
        options,
        encoding: true,
        decoded: readable !== null,
        family,
      });
    } else if (byAlphabet ? !classical && !tooFewSymbols(tool.id, stats) : true) {
      shapes.push({
        tool,
        score: Math.round(found.score * 100 * (byAlphabet ? 0.75 : 1)),
        reasons: [
          T('reason.triage', { tool: toolName(tool), why }),
          ...(decoded && !printable ? [T('reason.encoding.notText')] : []),
        ],
        against: [],
        options,
        encoding: true,
        decoded: false,
        family,
      });
      if (decoded && decoded.length >= 8 && (!data || found.score > data.score)) {
        data = { score: found.score, bytes: decoded };
      }
    }
  }

  // Auto-decode: chains of several decoders that end in readable text.
  const auto = byId.get('auto-decode');
  if (auto && bytes.length <= 20_000) {
    const result = autoDecode(bytes, { maxDepth: 4, beamWidth: 6 });
    const best = result.best;
    if (best !== result.input && best.recipe.some((step) => !TRANSFORM_STEP.test(step))) {
      const readable = readableText(best.bytes);
      const single = shapes.some((s) => s.decoded && best.recipe.length === 1);
      if (readable && !single) {
        shapes.push({
          tool: auto,
          score: 95,
          reasons: [
            T('reason.encoding.chain', {
              recipe: best.recipe.join(' → '),
              preview: preview(readable),
            }),
          ],
          against: [],
          options: {},
          encoding: true,
          decoded: true,
          family: null,
        });
      }
    }
  }

  if (data && !shapes.some((s) => s.decoded)) shapes.push(...bytesShapes(data.bytes, byId));
  return shapes.sort((a, b) => b.score - a.score);
}
