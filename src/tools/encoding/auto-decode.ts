import { bool, defineTool, number, text as textOption } from '../../core/define';
import { ToolError } from '../../core/errors';
import { DEFAULT_FLAG_PATTERN } from '../../core/flags';
import type { Output } from '../../core/types';
import { buildWriteup, codeBlock, FLAG_MASK, kvTable, mdTable } from '../../core/writeup';
import { toolT } from '../../i18n/tool-text';
import { formatSize, printableRatio, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import { chiSquared, plaintextScore } from '../../lib/english';
import { analyse, buildCtx, DECODERS, strongSignature, TRANSFORMS } from './_decoders';
import type { Ctx, Info, Step } from './_decoders';

const T = toolT('auto-decode');

// ---------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------

/**
 * Longest prefix of a candidate given to plaintextScore (its flag-token regex is quadratic on
 * long runs of letters and digits). Flag tokens are searched in a longer prefix, FLAG_SCAN.
 */
const SAMPLE = 4096;
const FLAG_SCAN = 1024 * 1024;
const GENERIC_FLAG = new RegExp(DEFAULT_FLAG_PATTERN);
const KNOWN_FLAG =
  /(?:^|[^A-Za-z0-9_])(?:flag|[A-Za-z0-9]*ctf|htb|thm|key|secret)\{[^{}\s]{2,200}\}/i;
const FLAG_BONUS = 60;
const GENERIC_FLAG_BONUS = 20;
const FILE_BONUS = 90;
/** A transform (ROT13, reverse...) must also raise the score by at least this much. */
const TRANSFORM_GAIN = 5;
/** Stop after this many decoder runs' worth of bytes (keeps huge inputs from hanging). */
const WORK_BUDGET = 64_000_000;
const MAX_CANDIDATES = 4000;

function scoreOf(
  bytes: Uint8Array,
  info: Info,
  prefixRe: RegExp | null,
): { score: number; flag: boolean } {
  if (bytes.length === 0) return { score: -1, flag: false };
  const text = info.text ?? utf8Decode(bytes.subarray(0, SAMPLE));
  let score = plaintextScore(text.length > SAMPLE ? text.slice(0, SAMPLE) : text);
  const scan = text.length > FLAG_SCAN ? text.slice(0, FLAG_SCAN) : text;
  let flag = false;
  if (prefixRe?.test(scan) || KNOWN_FLAG.test(scan)) {
    score += FLAG_BONUS;
    flag = true;
  } else if (GENERIC_FLAG.test(scan)) {
    score += GENERIC_FLAG_BONUS;
  }
  if (!info.textLike && strongSignature(bytes)) score += FILE_BONUS;
  return { score, flag };
}

/** Reversed Base64 starts with its padding: the one case where "reverse" is kept on faith. */
const looksLikeReversedBase64 = (t: string) => /^={1,2}[A-Za-z0-9+/_-]{6,}$/.test(t);

const COMMON_WORDS = new Set(
  (
    'the be to of and a in that have it for not on with he as you do at this but his by from they we ' +
    'say her she or an will my one all would there their what so up out if about who get which go me ' +
    'when make can like time no just him know take people into year your good some could them see ' +
    'other than then now look only come its over think also back after use two how our work first well ' +
    'way even new want because any these give day most us is are was were been has had flag ctf hello ' +
    'world secret message password key here where find hidden challenge welcome congratulations'
  ).split(' '),
);

/** Distinct common words (3+ letters) and the share of all letters they cover. */
function englishness(text: string): { words: number; coverage: number } {
  const found = new Set<string>();
  let covered = 0;
  let total = 0;
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    total += w.length;
    if (w.length >= 3 && COMMON_WORDS.has(w)) {
      found.add(w);
      covered += w.length;
    }
  }
  return { words: found.size, coverage: total ? covered / total : 0 };
}

const letterCount = (text: string) => (text.match(/[A-Za-z]/g) ?? []).length;

/**
 * Should a transform (ROT13, reverse...) be kept? Only when it clearly turns gibberish into
 * something readable: a new flag, several common English words where there were none, or a
 * long text whose letter statistics became English.
 */
function transformHelps(parent: Candidate, child: Candidate): boolean {
  if (child.score < parent.score + TRANSFORM_GAIN) return false;
  if (child.flag) return !parent.flag;
  if (child.text === null || parent.text === null) return false;
  const after = englishness(child.text);
  if (
    after.words >= 2 &&
    after.coverage >= 0.25 &&
    after.coverage > englishness(parent.text).coverage + 0.15
  ) {
    return true;
  }
  return (
    letterCount(child.text) >= 60 &&
    chiSquared(child.text) < 50 &&
    chiSquared(parent.text) > 2 * chiSquared(child.text)
  );
}

// ---------------------------------------------------------------------------------------------
// Beam search
// ---------------------------------------------------------------------------------------------

export interface Candidate {
  bytes: Uint8Array;
  /** Step names from the input to this candidate; empty for the input itself. */
  recipe: string[];
  score: number;
  /** A flag-looking token with a known (or the chosen) prefix was found. */
  flag: boolean;
  text: string | null;
  textLike: boolean;
}

export interface AutoDecodeOptions {
  maxDepth?: number;
  beamWidth?: number;
  /** Extra flag prefix, e.g. "picoCTF": text containing `picoCTF{` gets the flag bonus. */
  flagPrefix?: string;
}

export interface AutoDecodeResult {
  input: Candidate;
  /** Highest score; the input itself when nothing decoded to something more readable. */
  best: Candidate;
  /** All candidates (input included), best first, ties broken by shorter recipe. */
  ranked: Candidate[];
  explored: number;
}

function keyOf(b: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i]!, 0x01000193);
    h2 = (Math.imul(h2, 33) + b[i]!) | 0;
  }
  return `${b.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

/** Speculative step: any failure just means "not this encoding". */
function attempt(step: Step, ctx: Ctx): Uint8Array | null {
  try {
    const out = step.run(ctx);
    return out && out.length ? out : null;
  } catch {
    return null;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Beam search over decoders: every level applies all decoders to the `beamWidth` best
 * candidates of the previous level. Content already seen is never expanded twice (cycles),
 * a level that produces a flag ends the search. Deterministic: bounded by a work budget,
 * not by time.
 */
export function autoDecode(bytes: Uint8Array, opts: AutoDecodeOptions = {}): AutoDecodeResult {
  const maxDepth = Math.max(1, Math.min(10, Math.floor(opts.maxDepth ?? 5)));
  const beamWidth = Math.max(1, Math.min(50, Math.floor(opts.beamWidth ?? 10)));
  const prefix = opts.flagPrefix?.trim();
  const prefixRe = prefix ? new RegExp(`${escapeRe(prefix)}\\{[^{}]{1,200}\\}`, 'i') : null;

  const make = (b: Uint8Array, recipe: string[]): Candidate => {
    const info = analyse(b);
    const { score, flag } = scoreOf(b, info, prefixRe);
    return { bytes: b, recipe, score, flag, text: info.text, textLike: info.textLike };
  };

  const input = make(bytes, []);
  const seen = new Set<string>([keyOf(bytes)]);
  const all: Candidate[] = [input];
  let frontier: Candidate[] = [input];
  let work = 0;

  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: Candidate[] = [];
    for (const node of frontier) {
      if (work > WORK_BUDGET || all.length > MAX_CANDIDATES) break;
      work += node.bytes.length * (DECODERS.length + TRANSFORMS.length);
      const ctx = buildCtx(node.bytes);
      const accept = (step: Step, requireGain: boolean) => {
        const out = attempt(step, ctx);
        if (!out) return;
        const k = keyOf(out);
        if (seen.has(k)) return;
        const child = make(out, [...node.recipe, step.name]);
        const faith = step.name === 'reverse' && looksLikeReversedBase64(ctx.t);
        if (requireGain && !faith && !transformHelps(node, child)) return;
        seen.add(k);
        next.push(child);
      };
      for (const step of DECODERS) accept(step, false);
      if (node.textLike && node.bytes.length <= 200_000)
        for (const step of TRANSFORMS) accept(step, true);
    }
    all.push(...next);
    if (next.some((c) => c.flag)) break;
    frontier = [...next].sort((a, b) => b.score - a.score).slice(0, beamWidth);
  }

  const ranked = [...all].sort((a, b) => b.score - a.score || a.recipe.length - b.recipe.length);
  return { input, best: ranked[0]!, ranked, explored: seen.size };
}

// ---------------------------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------------------------

const arrow = ' → ';
export const recipeName = (c: Candidate): string =>
  c.recipe.length ? c.recipe.join(arrow) : T('value.inputAsIs');

function previewOf(c: Candidate): string {
  if (c.textLike && c.text !== null) {
    const flat = c.text.replace(/\s+/g, ' ').trim();
    return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat;
  }
  const sig = strongSignature(c.bytes);
  const head = toHex(c.bytes.subarray(0, 12), ' ');
  const p = { size: formatSize(c.bytes.length), hex: head };
  return sig ? T('value.binaryFile', { ...p, type: sig }) : T('value.binary', p);
}

const GENERIC_FLAG_ALL = new RegExp(DEFAULT_FLAG_PATTERN, 'g');

/** The flag-looking token of a candidate (the first one), if its text has one. */
function flagOf(c: Candidate, prefix: string | undefined): string | undefined {
  if (!c.flag || c.text === null) return undefined;
  const p = prefix?.trim();
  if (p) {
    const own = new RegExp(`${escapeRe(p)}\\{[^{}]{1,200}\\}`, 'i').exec(c.text)?.[0];
    if (own) return own;
  }
  return new RegExp(DEFAULT_FLAG_PATTERN).exec(c.text)?.[0];
}

/** A one-line preview for the writeup; flags are masked before the cut so none leaks in part. */
function writeupPreview(c: Candidate, includeFlag: boolean): string {
  if (!includeFlag && c.textLike && c.text !== null) {
    return previewOf({ ...c, text: c.text.replace(GENERIC_FLAG_ALL, FLAG_MASK) });
  }
  return previewOf(c);
}

/** The "how I found it" Markdown, fed with the recipe and ranking the tool already shows. */
function writeupOutput(
  result: AutoDecodeResult,
  shown: Candidate[],
  prefix: string | undefined,
  includeFlag: boolean,
): Output {
  const { best, input, explored } = result;
  const steps = best.recipe.map((name, i) => [i + 1, name]);
  const sections = [
    {
      heading: T('writeup.summary'),
      body: kvTable(
        [
          [T('writeup.recipe'), recipeName(best)],
          [T('writeup.steps'), String(best.recipe.length)],
          [
            T('writeup.size'),
            `${formatSize(input.bytes.length)} → ${formatSize(best.bytes.length)}`,
          ],
          [T('writeup.explored'), String(explored)],
        ],
        [T('writeup.item'), T('writeup.value')],
      ),
    },
    ...(steps.length
      ? [{ heading: T('writeup.chain'), body: mdTable(['#', T('col.recipe')], steps) }]
      : []),
    { heading: T('writeup.result'), body: codeBlock('', writeupPreview(best, includeFlag)) },
    {
      heading: T('label.top'),
      body: mdTable(
        ['#', T('col.recipe'), T('col.score'), T('col.preview')],
        shown.map((c, i) => [
          i + 1,
          recipeName(c),
          c.score.toFixed(1),
          writeupPreview(c, includeFlag),
        ]),
      ),
    },
    { heading: T('writeup.technique'), body: T('writeup.how') },
  ];
  return {
    type: 'text',
    label: T('label.writeup'),
    value: buildWriteup(sections, {
      title: T('writeup.title'),
      flag: flagOf(best, prefix),
      includeFlag,
      flagLabel: T('writeup.flag'),
    }),
  };
}

export default defineTool({
  id: 'auto-decode',
  name: 'Auto-decode (magic)',
  category: 'encoding',
  description:
    'Try chains of decoders (Base64/32/58/85, hex, binary, URL, gzip, ROT13...) and show the most readable result.',
  tags: [
    'magic',
    'cyberchef',
    'auto',
    'automatic',
    'detect encoding',
    'identify',
    'multi-layer',
    'nested',
    'decode everything',
    'what is this',
  ],
  input: 'bytes',
  placeholder:
    'Paste anything encoded: H4sIAAAAAAAA/0vLzE5U... or 666c61677b... or %66%6c%61%67 ...',
  options: {
    maxDepth: number('Max depth', 5, {
      min: 1,
      max: 10,
      hint: 'How many decoding steps may be chained (base64 → hex → rot13 is 3).',
    }),
    beamWidth: number('Beam width', 10, {
      min: 1,
      max: 50,
      hint: 'How many of the best candidates are expanded at each level. Raise it if nothing is found.',
    }),
    flagPrefix: textOption('Flag prefix', '', {
      placeholder: 'picoCTF (optional)',
      hint: 'Candidates containing prefix{...} win. flag{...} and common CTF prefixes are always recognised.',
    }),
    writeup: bool('Copy-ready writeup (Markdown)', false, {
      hint: 'Add a Markdown "how I found it" report you can paste into a CTF writeup.',
    }),
    includeFlag: bool('Include the flag in the writeup', false, {
      hint: 'Off by default so the writeup can be shared without spoiling the flag.',
      showIf: (v) => v.writeup === true,
    }),
  },
  examples: [
    {
      label: 'Base64',
      input: 'ZmxhZ3thdXRvX2RlY29kZV93b3Jrc30=',
      expect: 'flag{auto_decode_works}',
    },
    {
      label: 'Three layers: base64, hex, rot13',
      input: 'NzM3OTZlNzQ3YjY3NzU2NTcyNzI1Zjc5NmU2YzcyNjU2NjVmNzE3MjcyNjM3ZA==',
      expect: 'flag{three_layers_deep}',
    },
    {
      label: 'Which decoders were used',
      input: 'NzM3OTZlNzQ3YjY3NzU2NTcyNzI1Zjc5NmU2YzcyNjU2NjVmNzE3MjcyNjM3ZA==',
      expect: 'base64 → hex → rot13',
    },
    {
      label: 'gzip inside base64',
      input: 'H4sIAAAAAAAC/0vLSUyvTq/KLIjPzItPSixONTMBsZJL0moBb4JJzhsAAAA=',
      expect: 'flag{gzip_in_base64_in_ctf}',
    },
    {
      label: 'Percent-encoded, then reversed',
      input: '%7D%65%73%72%65%76%65%72%5F%65%68%74%7B%67%61%6C%66',
      expect: 'flag{the_reverse}',
    },
  ],
  detect({ text, bytes }) {
    if (bytes.length >= 20 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return { score: 0.5, reason: T('detect.gzip') };
    }
    const t = text?.trim() ?? '';
    if (t.length < 12 || t.length > 100000 || /\s/.test(t) || /^[a-z]+$/i.test(t)) return null;
    if (printableRatio(utf8Encode(t)) < 1) return null;
    return { score: 0.3, reason: T('detect.token') };
  },
  run({ bytes }, { maxDepth, beamWidth, flagPrefix, writeup, includeFlag }) {
    if (!bytes.length) throw new ToolError(T('error.empty'));
    const result = autoDecode(bytes, { maxDepth, beamWidth, flagPrefix });
    const { best, input, ranked, explored } = result;
    const out: Output[] = [];

    if (best === input) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.nothing', { depth: maxDepth, count: explored }),
      });
    } else {
      out.push({
        type: 'bytes',
        label: T('label.best', { recipe: recipeName(best) }),
        value: best.bytes,
        filename: 'decoded.bin',
      });
      const sig = best.textLike ? null : strongSignature(best.bytes);
      out.push(
        best.flag
          ? { type: 'note', level: 'success', text: T('note.flag') }
          : sig
            ? {
                type: 'note',
                level: 'info',
                text: T('note.file', { type: sig }),
              }
            : { type: 'note', level: 'info', text: T('note.tried', { count: explored }) },
      );
    }

    const shown = ranked.filter((c) => c === input || c.score >= 20 || c.flag).slice(0, 15);
    if (shown.length > 1 || best === input) {
      out.push({
        type: 'table',
        label: T('label.top'),
        columns: ['#', T('col.recipe'), T('col.score'), T('col.preview')],
        rows: shown.map((c, i) => [i + 1, recipeName(c), c.score.toFixed(1), previewOf(c)]),
        highlight: [0],
      });
    }
    if (writeup) out.push(writeupOutput(result, shown, flagPrefix, includeFlag));
    return out;
  },
});
