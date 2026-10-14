import { bool, defineTool, number, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import { plaintextScore } from '../../lib/english';
import { fromHex, latin1Decode, toHex, utf8Encode } from '../../lib/bytes';
import { ENGLISH_FREQ, minimalPeriod, preview } from './_classical';
import { rankScore } from './_fitness';

const T = toolT('xor');

/** How many bytes are looked at when ranking candidate keys (keeps big files fast). */
const SAMPLE = 8192;
/** Bytes used to solve key columns statistically. */
const SOLVE_SAMPLE = 32768;

export function xorBytes(data: Uint8Array, key: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i]! ^ key[i % key.length]!;
  return out;
}

/** Key text -> bytes. Formats: plain text (UTF-8), hex, or a list of decimal byte values. */
export function parseKey(key: string, format: 'text' | 'hex' | 'decimal'): Uint8Array {
  if (!key.trim()) throw new ToolError(T('error.noKey'));
  if (format === 'text') return utf8Encode(key);
  if (format === 'hex') {
    const bytes = fromHex(key);
    if (!bytes.length) throw new ToolError(T('error.emptyHex'));
    return bytes;
  }
  const parts = key.trim().split(/[\s,;]+/);
  return Uint8Array.from(
    parts.map((p) => {
      const n = /^\d+$/.test(p) ? Number(p) : NaN;
      if (!(n >= 0 && n <= 255)) {
        throw new ToolError(T('error.notByte', { value: p }));
      }
      return n;
    }),
  );
}

/** Log-likelihood of each byte value in English-looking text (letters, spaces, punctuation). */
const LOGP: Float64Array = (() => {
  const p = new Float64Array(256).fill(1e-6);
  for (let i = 0; i < 26; i++) {
    p[97 + i] = (0.68 * ENGLISH_FREQ[i]!) / 100;
    p[65 + i] = (0.05 * ENGLISH_FREQ[i]!) / 100;
  }
  for (let c = 0x21; c < 0x7f; c++) if (p[c]! < 1e-5) p[c] = 3e-4;
  for (let c = 48; c <= 57; c++) p[c] = 1.5e-3;
  for (const ch of '.,') p[ch.charCodeAt(0)] = 0.01;
  for (const ch of '\'-_:;!?"()') p[ch.charCodeAt(0)] = 2e-3;
  for (const ch of '{}[]/=<>+*&%$#@') p[ch.charCodeAt(0)] = 7e-4;
  p[0x20] = 0.17;
  p[10] = 0.012;
  p[13] = 2e-3;
  p[9] = 2e-3;
  return p.map(Math.log);
})();

/** Best single-byte key for the bytes data[start], data[start+step], ... (below `limit`). */
export function solveColumn(data: Uint8Array, start: number, step: number, limit: number): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let k = 0; k < 256; k++) {
    let s = 0;
    for (let i = start; i < limit; i += step) s += LOGP[data[i]! ^ k]!;
    if (s > bestScore) {
      bestScore = s;
      best = k;
    }
  }
  return best;
}

/** Rank a candidate key by how English the start of the decryption looks. */
const scoreOf = (data: Uint8Array, key: ArrayLike<number>): number =>
  rankScore(latin1Decode(xorBytes(data.subarray(0, SAMPLE), key)));

/** Printable ASCII view of bytes, '.' for the rest. */
function visible(b: Uint8Array, max = 60): string {
  let s = '';
  for (let i = 0; i < Math.min(b.length, max); i++) {
    const c = b[i]!;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
  }
  return s + (b.length > max ? '…' : '');
}

function keyText(key: Uint8Array): string {
  return key.every((c) => c >= 0x20 && c < 0x7f)
    ? `"${latin1Decode(key)}"`
    : T('value.notPrintable');
}

function keyEntries(key: Uint8Array): [string, string][] {
  return [
    [T('kv.keyText'), keyText(key)],
    [T('kv.keyHex'), toHex(key)],
    [T('kv.keyLength'), T('value.bytes', { count: key.length })],
  ];
}

// ---------------------------------------------------------------- single byte

export interface ByteGuess {
  key: number;
  score: number;
}

/** All 256 single-byte keys, best first. */
export function bruteForceByte(data: Uint8Array): ByteGuess[] {
  const sample = data.subarray(0, SAMPLE);
  const out: ByteGuess[] = [];
  for (let k = 0; k < 256; k++) {
    out.push({ key: k, score: plaintextScore(latin1Decode(xorBytes(sample, [k]))) });
  }
  return out.sort((a, b) => b.score - a.score || a.key - b.key);
}

// ------------------------------------------------------------- repeating key

function hamming(data: Uint8Array, a: number, b: number, n: number): number {
  let d = 0;
  for (let i = 0; i < n; i++) {
    let x = data[a + i]! ^ data[b + i]!;
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Normalised Hamming distance between consecutive blocks for each key length (lower = likelier). */
export function keyLengthDistances(
  data: Uint8Array,
  maxLen: number,
): { length: number; distance: number }[] {
  const out: { length: number; distance: number }[] = [];
  const cap = Math.min(maxLen, Math.floor(data.length / 2));
  for (let len = 1; len <= cap; len++) {
    const blocks = Math.min(Math.floor(data.length / len), 24);
    let total = 0;
    for (let i = 0; i + 1 < blocks; i++) total += hamming(data, i * len, (i + 1) * len, len);
    out.push({ length: len, distance: total / (blocks - 1) / len });
  }
  return out.sort((a, b) => a.distance - b.distance || a.length - b.length);
}

export interface KeyCandidate {
  key: Uint8Array;
  score: number;
  /** Known-plaintext mode: the crib alone fixed (and double-checked) every key byte. */
  verified: boolean;
  /** Distance for crack mode, offset for known-plaintext mode. */
  extra: number;
}

/** Cryptopals-style: guess key lengths from the Hamming distance, solve each column. */
export function crackRepeatingKey(
  data: Uint8Array,
  maxLen: number,
  tries = 6,
): { candidates: KeyCandidate[]; lengths: { length: number; distance: number }[] } {
  const lengths = keyLengthDistances(data, maxLen);
  const limit = Math.min(data.length, SOLVE_SAMPLE);
  const seen = new Set<string>();
  const candidates: KeyCandidate[] = [];
  for (const { length, distance } of lengths.slice(0, tries)) {
    const key = new Uint8Array(length);
    for (let r = 0; r < length; r++) key[r] = solveColumn(data, r, length, limit);
    const reduced = key.slice(0, minimalPeriod([...key]));
    const id = toHex(reduced);
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push({
      key: reduced,
      score: scoreOf(data, reduced),
      verified: false,
      extra: distance,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.key.length - b.key.length);
  return { candidates, lengths };
}

// ------------------------------------------------------------ known plaintext

function fragmentAt(data: Uint8Array, known: Uint8Array, offset: number): Uint8Array {
  const frag = new Uint8Array(known.length);
  for (let j = 0; j < known.length; j++) frag[j] = data[offset + j]! ^ known[j]!;
  return frag;
}

const consistent = (frag: Uint8Array, len: number): boolean => {
  for (let j = 0; j + len < frag.length; j++) if (frag[j] !== frag[j + len]) return false;
  return true;
};

/**
 * Key candidates when `known` sits at `offset`: its key bytes are known, a repeating key
 * must agree with itself, and any key bytes the crib does not reach are solved statistically.
 */
export function knownPlaintextAt(
  data: Uint8Array,
  known: Uint8Array,
  offset: number,
  maxLen: number,
): KeyCandidate[] {
  const m = known.length;
  const frag = fragmentAt(data, known, offset);
  const limit = Math.min(data.length, SOLVE_SAMPLE);
  const seen = new Set<string>();
  const out: KeyCandidate[] = [];
  for (let len = 1; len <= Math.min(maxLen, data.length); len++) {
    if (!consistent(frag, len)) continue;
    const key = new Array<number>(len).fill(-1);
    for (let j = 0; j < m; j++) key[(offset + j) % len] = frag[j]!;
    for (let r = 0; r < len; r++) if (key[r]! < 0) key[r] = solveColumn(data, r, len, limit);
    const reduced = Uint8Array.from(key.slice(0, minimalPeriod(key)));
    const id = toHex(reduced);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key: reduced, score: scoreOf(data, reduced), verified: len < m, extra: offset });
  }
  // A key the crib fully determines (and that repeats inside it) beats statistical guesses.
  return out.sort(
    (a, b) =>
      Number(b.verified) - Number(a.verified) ||
      (a.verified ? a.key.length - b.key.length : b.score - a.score) ||
      a.key.length - b.key.length,
  );
}

/** Every offset at which the crib implies a short repeating key (no statistics, so it is fast). */
export function knownPlaintextAnywhere(
  data: Uint8Array,
  known: Uint8Array,
  maxLen: number,
): KeyCandidate[] {
  const m = known.length;
  const out: KeyCandidate[] = [];
  const seen = new Set<string>();
  const longest = Math.min(maxLen, m - 2);
  for (let offset = 0; offset + m <= data.length; offset++) {
    const frag = fragmentAt(data, known, offset);
    for (let len = 1; len <= longest; len++) {
      if (!consistent(frag, len)) continue;
      const key = new Array<number>(len);
      for (let j = 0; j < len; j++) key[(offset + j) % len] = frag[j]!;
      const reduced = Uint8Array.from(key.slice(0, minimalPeriod(key)));
      const id = `${offset}:${toHex(reduced)}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ key: reduced, score: scoreOf(data, reduced), verified: true, extra: offset });
      }
      break;
    }
  }
  return out.sort((a, b) => b.score - a.score || a.extra - b.extra);
}

export function parseKnown(known: string): Uint8Array {
  if (!known) throw new ToolError(T('error.noKnown'));
  return /^hex:/i.test(known) ? fromHex(known.slice(4)) : utf8Encode(known);
}

export default defineTool({
  id: 'xor',
  name: 'XOR',
  category: 'crypto',
  description:
    'XOR with a key, brute-force a single byte, crack a repeating key, or derive it from known plaintext.',
  tags: [
    'xor',
    'exclusive or',
    'xor brute force',
    'single byte xor',
    'repeating key xor',
    'vigenere xor',
    'cryptopals',
    'known plaintext',
    'crib',
    'cyberchef xor brute force',
  ],
  input: 'bytes',
  placeholder: 'Ciphertext as text, hex or base64, or open a file',
  options: {
    mode: toggle(
      'Mode',
      [
        { value: 'key', label: 'Key' },
        { value: 'brute', label: 'Single-byte brute force' },
        { value: 'crack', label: 'Crack repeating key' },
        { value: 'known', label: 'Known plaintext' },
      ],
      'brute',
    ),
    keyFormat: toggle(
      'Key format',
      [
        { value: 'text', label: 'Text' },
        { value: 'hex', label: 'Hex' },
        { value: 'decimal', label: 'Decimal list' },
      ],
      undefined,
      { showIf: (v) => v.mode === 'key' },
    ),
    key: text('Key', '', {
      placeholder: 'secret · 73 65 63 · 115 101 99',
      showIf: (v) => v.mode === 'key',
    }),
    maxLen: number('Max key length', 40, {
      min: 1,
      max: 256,
      showIf: (v) => v.mode === 'crack' || v.mode === 'known',
    }),
    known: text('Known plaintext', 'flag{', {
      placeholder: 'flag{',
      hint: 'Text, or hex: followed by bytes',
      showIf: (v) => v.mode === 'known',
    }),
    offset: number('Offset', 0, {
      min: 0,
      hint: 'Byte position where the known text starts',
      showIf: (v) => v.mode === 'known' && !v.everyOffset,
    }),
    everyOffset: bool('Try every offset', false, {
      hint: 'Slide the known text along the data (finds keys up to len−2 bytes)',
      showIf: (v) => v.mode === 'known',
    }),
  },
  examples: [
    {
      label: 'Brute-force a one-byte key',
      input: { hex: '4c464b4d5145444f7548535e4f75524558754359755d4f4b4157' },
      expect: 'flag{one_byte_xor_is_weak}',
    },
    {
      label: 'XOR with a known key',
      input: { hex: '0d5f180c480104412600560016' },
      options: { mode: 'key', key: 'k3y' },
      expect: 'flag{xor_key}',
    },
    {
      label: 'Known plaintext "flag{"',
      input: { hex: '1e03135403041c5c0f012d43140e1b5d0c0a0a4727171d4105' },
      options: { mode: 'known' },
      expect: 'flag{known_plaintext_xor}',
    },
    {
      label: 'Crack a repeating key',
      input: {
        hex: '3b0615070e0c000d024f041d10433d2d3d58050c0a091c581a00041016580b1611420919050f16420e08081111421e0d00000e0e1642490410071c0b49170d074f130c1a450e0a160e170d42090a060e4516071d492b040f021107044506060b1d020b010a5449170d0701581a0c09140a580c15001016580a0c09170216490f0c090a58084326030a0b0811450106080106174c4f2c0106450403190e430c114f1e050202190719040e0c0c08270d0a16160e160a063a1506161a1e4503011c491a0a174f1b080d45100a190d430c164f1606144b',
      },
      options: { mode: 'crack' },
      expect: 'flag{hamming_distance_wins}',
    },
  ],
  run({ bytes }, { mode, keyFormat, key, maxLen, known, offset, everyOffset }) {
    if (!bytes.length) throw new ToolError(T('error.noData'));

    if (mode === 'key') {
      const k = parseKey(key, keyFormat);
      return [{ type: 'bytes', value: xorBytes(bytes, k), filename: 'xor.bin' }];
    }

    if (mode === 'brute') {
      const ranked = bruteForceByte(bytes);
      const best = ranked[0]!;
      const sample = bytes.subarray(0, 60);
      return [
        {
          type: 'bytes',
          label: T('label.bestByte', { hex: toHex(Uint8Array.of(best.key)) }),
          value: xorBytes(bytes, [best.key]),
          filename: `xor-${toHex(Uint8Array.of(best.key))}.bin`,
        },
        {
          type: 'table',
          label: T('label.top'),
          columns: [T('col.key'), T('col.char'), T('col.score'), T('col.preview')],
          rows: ranked
            .slice(0, 20)
            .map((r) => [
              `0x${toHex(Uint8Array.of(r.key))}`,
              r.key > 0x20 && r.key < 0x7f ? String.fromCharCode(r.key) : '·',
              r.score.toFixed(1),
              visible(xorBytes(sample, [r.key])),
            ]),
          highlight: [0],
        },
      ];
    }

    if (mode === 'crack') {
      if (bytes.length < 8) throw new ToolError(T('error.tooLittle'));
      const { candidates, lengths } = crackRepeatingKey(bytes, maxLen);
      const best = candidates[0]!;
      return [
        {
          type: 'bytes',
          label: T('label.bestCrack', { key: keyText(best.key), count: best.key.length }),
          value: xorBytes(bytes, best.key),
          filename: 'xor-cracked.bin',
        },
        { type: 'kv', label: T('label.recovered'), entries: keyEntries(best.key) },
        {
          type: 'table',
          label: T('label.lengths'),
          columns: [
            T('col.length'),
            T('col.distance'),
            T('kv.keyText'),
            T('kv.keyHex'),
            T('col.score'),
            T('col.preview'),
          ],
          rows: candidates.map((c) => [
            c.key.length,
            c.extra.toFixed(3),
            keyText(c.key),
            toHex(c.key),
            c.score.toFixed(1),
            visible(xorBytes(bytes.subarray(0, 60), c.key)),
          ]),
          highlight: [0],
        },
        {
          type: 'note',
          level: 'info',
          text: T('note.otherLengths', {
            lengths: lengths
              .slice(0, 8)
              .map((l) => `${l.length} (${l.distance.toFixed(2)})`)
              .join(', '),
          }),
        },
      ];
    }

    // known plaintext
    const crib = parseKnown(known);
    if (crib.length > bytes.length) throw new ToolError(T('error.cribTooLong'));
    let candidates: KeyCandidate[];
    if (everyOffset) {
      candidates = knownPlaintextAnywhere(bytes, crib, maxLen);
    } else {
      if (offset + crib.length > bytes.length) {
        throw new ToolError(T('error.pastEnd', { offset, known: crib.length, size: bytes.length }));
      }
      candidates = knownPlaintextAt(bytes, crib, offset, maxLen);
    }
    if (!candidates.length) {
      throw new ToolError(everyOffset ? T('error.noOffset') : T('error.inconsistent'));
    }
    const best = candidates[0]!;
    return [
      {
        type: 'bytes',
        label: everyOffset
          ? T('label.bestKnownAt', { key: keyText(best.key), offset: best.extra })
          : T('label.bestKnown', { key: keyText(best.key) }),
        value: xorBytes(bytes, best.key),
        filename: 'xor-known.bin',
      },
      {
        type: 'kv',
        label: T('label.derived'),
        entries: [...keyEntries(best.key), [T('kv.offset'), String(best.extra)]],
      },
      {
        type: 'table',
        label: T('label.candidates'),
        columns: [
          T('kv.offset'),
          T('col.length'),
          T('kv.keyText'),
          T('kv.keyHex'),
          T('col.score'),
          T('col.preview'),
        ],
        rows: candidates
          .slice(0, 12)
          .map((c) => [
            c.extra,
            c.key.length,
            keyText(c.key),
            toHex(c.key),
            c.score.toFixed(1),
            preview(visible(xorBytes(bytes.subarray(0, 60), c.key))),
          ]),
        highlight: [0],
      },
    ];
  },
});
