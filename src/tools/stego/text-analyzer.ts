import { defineTool } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { chainedPasses, chainSources, cipherPasses } from './_text-analyzer-ciphers';
import {
  baselineOf,
  foldKey,
  LANG_NAMES,
  makeScorer,
  nearInput,
  oneLine,
  rankScored,
  scorePass,
  STRONG,
  type Family,
  type Pass,
  type Scored,
} from './_text-analyzer-core';
import { encodingPasses } from './_text-analyzer-decode';
import {
  emojiPart,
  findHomoglyphs,
  invisiblePasses,
  replaceHomoglyphs,
  type Homoglyph,
} from './_text-analyzer-hidden';
import { metaEntries, nonAsciiRows, repeats, spacing } from './_text-analyzer-meta';
import { TEXT_CASES } from './_text-analyzer-cases';
import { acrosticPasses, readInput, structurePasses } from './_text-analyzer-read';
import {
  classify,
  codePointLabel,
  embedPayload,
  encodePayload,
  stripInvisible,
} from './_zerowidth';
import { splitLines } from './whitespace';

const TOP = 15;
/** A best result under this score is not promoted to its own block when nothing stands out. */
const WEAK_BLOCK = 25;
const MAX_HOMOGLYPH_ROWS = 200;
/** detect() looks at this much of a pasted text: it runs for every tool on every paste. */
const DETECT_SCAN = 5000;
/** Fewer spaces and tabs than this, with nothing else, cannot hide a message. */
const MIN_WHITESPACE_PAYLOAD = 16;
/** Line and word passes read this much of a very long text (the scores need far less). */
const READ_MAX = 100_000;

const FAMILY_TITLES: Record<Family, string> = {
  acrostic: 'Acrostics and regular picks',
  structure: 'Structured reading (line order, reversals, diagonals, columns)',
  invisible: 'Invisible characters and marks',
  encoding: 'Encodings',
  cipher: 'Classical ciphers',
};
const FAMILIES: Family[] = ['acrostic', 'structure', 'invisible', 'encoding', 'cipher'];

/** Letter picks worth running the ciphers on (an acrostic may itself be ROT13'd). */
const CHAIN_PICKS = new Set([
  'First letter of each line',
  'Last letter of each line',
  'First letter of each word',
  'First letter of each sentence',
  'First letter of each paragraph',
  'Capital letters',
]);

export interface Analysis {
  passes: Pass[];
  scored: Map<Pass, Scored>;
  /** Best first, identical outputs listed once, the input itself never. */
  ranked: Scored[];
  homoglyphs: Homoglyph[];
  /** The visible text the passes read (invisible characters removed, homoglyphs replaced). */
  visible: string;
  /** foldKey() of the visible text: a pass output equal to it is the input itself. */
  inputKey: string;
  /** The line and word passes only read the start of a very long text. */
  truncated: boolean;
}

/** Run every pass on a text and rank the outputs. */
export function analyze(input: string): Analysis {
  const raw = input.replace(/\r\n?/g, '\n');
  const scorer = makeScorer();
  const stripped = stripInvisible(raw, false);
  const homoglyphs = findHomoglyphs(stripped);
  const visible = replaceHomoglyphs(stripped, homoglyphs);
  const base = baselineOf(visible, scorer);
  const head = visible.length > READ_MAX ? visible.slice(0, READ_MAX) : visible;
  const read = readInput(head);

  const acrostics = acrosticPasses(read, scorer);
  const structure = structurePasses(read, scorer);
  const invisible = invisiblePasses(raw, stripped, homoglyphs, scorer);
  const encodings = encodingPasses(visible, scorer);
  const ciphers = cipherPasses(visible, base.score, scorer);
  const sources = chainSources([
    ...invisible,
    // Leet and keyboard swaps rewrite the visible text, which the ciphers already read.
    ...encodings.filter((p) => !/^(?:Leet|Keyboard)/.test(p.label)),
    ...acrostics.filter((p) => CHAIN_PICKS.has(p.label)),
  ]);
  const passes = [
    ...acrostics,
    ...structure,
    ...invisible,
    ...encodings,
    ...ciphers,
    ...chainedPasses(sources, scorer),
  ];
  const scored = new Map<Pass, Scored>();
  passes.forEach((p, i) => {
    const s = scorePass(p, i, base, scorer);
    if (s) scored.set(p, s);
  });
  const ranked = rankScored([...scored.values()], base.key);
  const truncated = head.length < visible.length;
  return { passes, scored, ranked, homoglyphs, visible, inputKey: base.key, truncated };
}

function resultCell(s: Scored | undefined, pass: Pass): string {
  if (pass.result === null) return '—';
  const shown = oneLine(pass.result, 160);
  return s?.reading ? `${shown}  → ${oneLine(s.reading, 100)}` : shown;
}

function familyTable(family: Family, a: Analysis): Output {
  const passes = a.passes.filter((p) => p.family === family);
  const highlight: number[] = [];
  const rows = passes.map((p, i) => {
    const s = a.scored.get(p);
    if (s && s.score >= STRONG) highlight.push(i);
    const same = p.result !== null && foldKey(p.result) === a.inputKey;
    const note = same
      ? 'same as the input'
      : nearInput(p, a.visible)
        ? `nearly the input (most letters unchanged); ${oneLine(p.note, 120)}`
        : oneLine(p.note, 160) || '—';
    return [p.label, resultCell(s, p), s ? s.score.toFixed(1) : '—', note];
  });
  return {
    type: 'table',
    label: FAMILY_TITLES[family],
    columns: ['Pass', 'Result', 'Score', 'Details'],
    rows,
    highlight,
  };
}

function render(a: Analysis, raw: string): Output[] {
  const out: Output[] = [];
  const best = a.ranked[0];
  const strong = a.ranked.filter((s) => s.score >= STRONG);
  if (best && strong.length) {
    const shown = oneLine(best.reading ?? best.result, 80);
    out.push({
      type: 'note',
      level: 'success',
      text: `Most readable: ${best.pass.label} → ${shown}`,
    });
  } else {
    out.push({
      type: 'note',
      level: 'info',
      text: 'Nothing stands out; every pass is listed below',
    });
  }
  // A weak best result is still offered as a block (copy, Send to…), unless it is next to
  // nothing: then the tables say it all.
  if (best && (strong.length || best.score >= WEAK_BLOCK)) {
    const reads = best.reading ? ` · reads “${oneLine(best.reading, 80)}”` : '';
    out.push({
      type: 'text',
      label: `${best.pass.label}${reads}${strong.length ? '' : ' (weak)'}`,
      value: best.result,
    });
  }
  out.push({
    type: 'table',
    label: `Most readable results (French / English readability; ${STRONG}+ is highlighted)`,
    columns: ['Score', 'Pass', 'Result', 'Language'],
    rows: a.ranked
      .slice(0, TOP)
      .map((s) => [
        s.score.toFixed(1),
        s.pass.note ? `${s.pass.label} · ${oneLine(s.pass.note, 70)}` : s.pass.label,
        resultCell(s, s.pass),
        s.lang ? LANG_NAMES[s.lang] : '—',
      ]),
    highlight: a.ranked.slice(0, TOP).flatMap((s, i) => (s.score >= STRONG ? [i] : [])),
  });
  if (a.truncated) {
    out.push({
      type: 'note',
      level: 'info',
      text: `Long text: acrostics and structured readings use its first ${READ_MAX.toLocaleString('en')} characters.`,
    });
  }
  for (const family of FAMILIES) {
    out.push(familyTable(family, a));
    if (family === 'invisible' && a.homoglyphs.length) {
      out.push({
        type: 'table',
        label: 'Homoglyphs (positions in the text without invisible characters)',
        columns: ['Character', 'Looks like', 'Code point', 'Name', 'Position'],
        rows: a.homoglyphs
          .slice(0, MAX_HOMOGLYPH_ROWS)
          .map((h) => [
            h.char,
            h.looksLike,
            codePointLabel(h.cp),
            h.name,
            `line ${h.line}, col ${h.column}`,
          ]),
      });
      const more = a.homoglyphs.length - MAX_HOMOGLYPH_ROWS;
      if (more > 0) {
        out.push({
          type: 'note',
          level: 'info',
          text: `${more.toLocaleString('en')} more lookalike letters not listed (the first ${MAX_HOMOGLYPH_ROWS} are).`,
        });
      }
    }
  }

  const scorer = makeScorer();
  out.push({ type: 'kv', label: 'Statistics', entries: metaEntries(raw, scorer) });
  const nonAscii = nonAsciiRows(raw);
  if (nonAscii.rows.length) {
    out.push({
      type: 'table',
      label: 'Non-ASCII characters (most frequent first)',
      columns: ['Character', 'Code point', 'Name', 'Count', 'First seen'],
      rows: nonAscii.rows,
    });
    if (nonAscii.more) {
      out.push({
        type: 'note',
        level: 'info',
        text: `${nonAscii.more} more non-ASCII characters not listed.`,
      });
    }
  }
  const reps = repeats(a.visible);
  out.push(
    reps.length
      ? {
          type: 'table',
          label: 'Repeated substrings (spacing = GCD of the distances, a key-length hint)',
          columns: ['Pattern', 'Times', 'Positions', 'Spacing'],
          rows: reps.map((r) => [
            `“${r.text}”`,
            String(r.positions.length),
            r.positions.slice(0, 8).join(', ') + (r.positions.length > 8 ? ' …' : ''),
            String(spacing(r.positions)),
          ]),
        }
      : { type: 'note', level: 'info', text: 'No substring of 3+ characters repeats.' },
  );
  return out;
}

// ---------------------------------------------------------------------------------------------
// Examples: the public-domain reference poems, and payloads built with the zero-width encoder

const caseText = (name: string): string => {
  const found = TEXT_CASES.find((c) => c.name === name);
  if (!found) throw new Error(`text-analyzer: no reference case "${name}"`);
  return found.text;
};
const SAND = caseText('Sand to Musset');
const MUSSET = caseText('Musset to Sand');
const ZERO_WIDTH = embedPayload(
  'See you at the usual place tomorrow, bring the documents.',
  encodePayload('flag{zero_width_found}', 'binary').units,
  'spread',
);
const BASE64_INLINE =
  'Thanks for the report. The token is ZmxhZ3t0aGVfYmxvYl93YXNfaW5zaWRlfQ== and it expires tonight.';

/** Cheap look at the start of a pasted text (detect() runs for every tool on every paste). */
const INVISIBLE_HINT = (whole: string): string | null => {
  const text = whole.slice(0, DETECT_SCAN);
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    if (classify(chars[i]!.codePointAt(0)!, false) && !emojiPart(chars, i)) {
      return 'Invisible characters inside';
    }
  }
  // Two trailing spaces are a Markdown line break, not a hidden payload.
  if (splitLines(text).some((l) => l.ws && l.ws !== '  ')) {
    return 'Trailing spaces or tabs on some lines';
  }
  if (findHomoglyphs(text).length) return 'Lookalike letters from another script';
  return null;
};

export default defineTool({
  id: 'text-analyzer',
  name: 'Text analyzer (full scan)',
  category: 'stego',
  description:
    'Paste a text: every hidden-text check runs at once (acrostics, invisible characters, encodings, ciphers) and the most readable results rise to the top.',
  tags: [
    'acrostic',
    'acrostiche',
    'hidden message',
    'texte caché',
    'null cipher',
    'magic',
    'cyberchef',
    'aperisolve',
    'text steganography',
    'zero width',
    'telestich',
    'homoglyph',
    'snow',
    'full scan',
    'poem',
    'multi-tap',
    'keyboard layout',
    'azerty',
    'leet',
  ],
  input: 'text',
  placeholder: 'Paste the text, poem or message to analyse',
  // A few hundred ms for 2 KB (more on the first run, while the word lists are built) and
  // under 2 s for 50 KB: fast enough to follow the typing.
  live: true,
  examples: [
    { label: 'Sand to Musset (acrostic)', input: SAND, expect: 'Cette Nuit' },
    {
      label: 'Musset to Sand',
      input: MUSSET,
      expect: 'Quand Voulez Vous Que Je Couche Avec Vous',
    },
    { label: 'Zero-width message', input: ZERO_WIDTH, expect: 'flag{zero_width_found}' },
    {
      label: 'Base64 inside a sentence',
      input: BASE64_INLINE,
      expect: 'flag{the_blob_was_inside}',
    },
  ],
  detect({ text }) {
    if (!text || !text.trim()) return null;
    const hint = INVISIBLE_HINT(text);
    if (hint) return { score: 0.6, reason: `${hint}: run every hidden-text check` };
    if (text.trim().includes('\n')) return { score: 0.3, reason: 'Run every hidden-text check' };
    return null;
  },
  run(text) {
    if (!text) throw new ToolError('Paste a text to analyse (a poem, a message, a file…).');
    // Spaces and tabs alone can be a payload (stegsnow without its cover text); a few blank
    // lines cannot. Other invisible characters (NBSP, BOM, zero-width) are always analysed.
    if (!/[^ \t\r\n]/.test(text) && (text.match(/[ \t]/g)?.length ?? 0) < MIN_WHITESPACE_PAYLOAD) {
      throw new ToolError(
        'The text is only a few spaces and line breaks: paste a text to analyse (a poem, a message, a file…).',
      );
    }
    return render(analyze(text), text.replace(/\r\n?/g, '\n'));
  },
});
