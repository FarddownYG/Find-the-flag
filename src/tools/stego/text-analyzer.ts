import { defineTool } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { getLocale } from '../../i18n/index';
import { toolT } from '../../i18n/tool-text';
import { chainedPasses, chainSources, cipherPasses } from './_text-analyzer-ciphers';
import {
  baselineOf,
  foldKey,
  langName,
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

const T = toolT('text-analyzer');

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

const FAMILY_TITLES: Record<Family, () => string> = {
  acrostic: () => T('family.acrostic'),
  structure: () => T('family.structure'),
  invisible: () => T('family.invisible'),
  encoding: () => T('family.encoding'),
  cipher: () => T('family.cipher'),
};
const FAMILIES: Family[] = ['acrostic', 'structure', 'invisible', 'encoding', 'cipher'];

/** Labels of the letter picks worth running the ciphers on (an acrostic may itself be ROT13'd). */
const chainPicks = () =>
  new Set([
    T('pass.firstLetterOfLine'),
    T('pass.lastLetterOfLine'),
    T('pass.firstLetterOfWord'),
    T('pass.firstLetterOfSentence'),
    T('pass.firstLetterOfParagraph'),
    T('pass.capitals'),
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
  const rewrites = new Set([T('pass.leet'), T('pass.layout')]);
  const picks = chainPicks();
  const sources = chainSources([
    ...invisible,
    // Leet and keyboard swaps rewrite the visible text, which the ciphers already read.
    ...encodings.filter((p) => !rewrites.has(p.label)),
    ...acrostics.filter((p) => picks.has(p.label)),
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
      ? T('note.sameAsInput')
      : nearInput(p, a.visible)
        ? T('note.nearlyInput', { note: oneLine(p.note, 120) })
        : oneLine(p.note, 160) || '—';
    return [p.label, resultCell(s, p), s ? s.score.toFixed(1) : '—', note];
  });
  return {
    type: 'table',
    label: FAMILY_TITLES[family](),
    columns: [T('col.pass'), T('col.result'), T('col.score'), T('col.details')],
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
      text: T('text.mostReadable', { pass: best.pass.label, result: shown }),
    });
  } else {
    out.push({ type: 'note', level: 'info', text: T('text.nothingStandsOut') });
  }
  // A weak best result is still offered as a block (copy, Send to…), unless it is next to
  // nothing: then the tables say it all.
  if (best && (strong.length || best.score >= WEAK_BLOCK)) {
    const pass = best.pass.label;
    const reading = best.reading ? oneLine(best.reading, 80) : null;
    const weak = !strong.length;
    out.push({
      type: 'text',
      label:
        reading === null
          ? weak
            ? T('label.bestWeak', { pass })
            : pass
          : weak
            ? T('label.bestReadsWeak', { pass, reading })
            : T('label.bestReads', { pass, reading }),
      value: best.result,
    });
  }
  out.push({
    type: 'table',
    label: T('label.ranked', { strong: STRONG }),
    columns: [T('col.score'), T('col.pass'), T('col.result'), T('col.language')],
    rows: a.ranked
      .slice(0, TOP)
      .map((s) => [
        s.score.toFixed(1),
        s.pass.note ? `${s.pass.label} · ${oneLine(s.pass.note, 70)}` : s.pass.label,
        resultCell(s, s.pass),
        s.lang ? langName(s.lang) : '—',
      ]),
    highlight: a.ranked.slice(0, TOP).flatMap((s, i) => (s.score >= STRONG ? [i] : [])),
  });
  if (a.truncated) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('text.truncated', { max: READ_MAX.toLocaleString(getLocale()) }),
    });
  }
  for (const family of FAMILIES) {
    out.push(familyTable(family, a));
    if (family === 'invisible' && a.homoglyphs.length) {
      out.push({
        type: 'table',
        label: T('label.homoglyphs'),
        columns: [
          T('col.character'),
          T('col.looksLike'),
          T('col.codePoint'),
          T('col.name'),
          T('col.position'),
        ],
        rows: a.homoglyphs
          .slice(0, MAX_HOMOGLYPH_ROWS)
          .map((h) => [
            h.char,
            h.looksLike,
            codePointLabel(h.cp),
            h.name,
            T('value.position', { line: h.line, column: h.column }),
          ]),
      });
      const more = a.homoglyphs.length - MAX_HOMOGLYPH_ROWS;
      if (more > 0) {
        out.push({
          type: 'note',
          level: 'info',
          text: T('text.moreHomoglyphs', {
            count: more,
            more: more.toLocaleString(getLocale()),
            max: MAX_HOMOGLYPH_ROWS,
          }),
        });
      }
    }
  }

  const scorer = makeScorer();
  out.push({ type: 'kv', label: T('label.statistics'), entries: metaEntries(raw, scorer) });
  const nonAscii = nonAsciiRows(raw);
  if (nonAscii.rows.length) {
    out.push({
      type: 'table',
      label: T('label.nonAscii'),
      columns: [
        T('col.character'),
        T('col.codePoint'),
        T('col.name'),
        T('col.count'),
        T('col.firstSeen'),
      ],
      rows: nonAscii.rows,
    });
    if (nonAscii.more) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('text.moreNonAscii', { count: nonAscii.more }),
      });
    }
  }
  const reps = repeats(a.visible);
  out.push(
    reps.length
      ? {
          type: 'table',
          label: T('label.repeats'),
          columns: [T('col.pattern'), T('col.times'), T('col.positions'), T('col.spacing')],
          rows: reps.map((r) => [
            `“${r.text}”`,
            String(r.positions.length),
            r.positions.slice(0, 8).join(', ') + (r.positions.length > 8 ? ' …' : ''),
            String(spacing(r.positions)),
          ]),
        }
      : { type: 'note', level: 'info', text: T('text.noRepeats') },
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

/**
 * Cheap look at the start of a pasted text (detect() runs for every tool on every paste): the
 * detect() reason when something is hidden there.
 */
const INVISIBLE_HINT = (whole: string): string | null => {
  const text = whole.slice(0, DETECT_SCAN);
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    if (classify(chars[i]!.codePointAt(0)!, false) && !emojiPart(chars, i)) {
      return T('detect.invisible');
    }
  }
  // Two trailing spaces are a Markdown line break, not a hidden payload.
  if (splitLines(text).some((l) => l.ws && l.ws !== '  ')) return T('detect.trailing');
  if (findHomoglyphs(text).length) return T('detect.homoglyphs');
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
    if (hint) return { score: 0.6, reason: hint };
    if (text.trim().includes('\n')) return { score: 0.3, reason: T('detect.multiline') };
    return null;
  },
  run(text) {
    if (!text) throw new ToolError(T('error.empty'));
    // Spaces and tabs alone can be a payload (stegsnow without its cover text); a few blank
    // lines cannot. Other invisible characters (NBSP, BOM, zero-width) are always analysed.
    if (!/[^ \t\r\n]/.test(text) && (text.match(/[ \t]/g)?.length ?? 0) < MIN_WHITESPACE_PAYLOAD) {
      throw new ToolError(T('error.onlySpaces'));
    }
    return render(analyze(text), text.replace(/\r\n?/g, '\n'));
  },
});
