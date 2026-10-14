import { bool, defineTool, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import {
  classify,
  codePointLabel,
  codePointsOf,
  decodeAll,
  embedPayload,
  encodePayload,
  isTagChar,
  isVariationSelector,
  stripInvisible,
  type Candidate,
  type EncodeScheme,
  type Placement,
  type SpecialChar,
} from './_zerowidth';

/** Rows of the per-occurrence table before it is cut off. */
const MAX_ROWS = 400;

interface Occurrence {
  /** 0-based index in code points. */
  index: number;
  line: number;
  column: number;
  cp: number;
  info: SpecialChar;
}

function scan(textValue: string, includeSpaces: boolean) {
  const cps = codePointsOf(textValue);
  const found: Occurrence[] = [];
  let line = 1;
  let column = 1;
  cps.forEach((cp, index) => {
    const info = classify(cp, includeSpaces);
    if (info) found.push({ index, line, column, cp, info });
    if (cp === 10) {
      line++;
      column = 1;
    } else column++;
  });
  return { cps, found };
}

/** The visible text with every invisible character replaced by a ⟦MARKER⟧; long runs are summarised. */
function withMarkers(cps: number[], found: Occurrence[]): string {
  const byIndex = new Map(found.map((o) => [o.index, o]));
  let out = '';
  for (let i = 0; i < cps.length; i++) {
    const first = byIndex.get(i);
    if (!first) {
      out += String.fromCodePoint(cps[i]!);
      continue;
    }
    const run: Occurrence[] = [];
    let j = i;
    for (let o = byIndex.get(j); o; o = byIndex.get(j)) {
      run.push(o);
      j++;
    }
    if (run.length <= 6) out += run.map((o) => `⟦${o.info.abbr}⟧`).join('');
    else {
      const tally = new Map<string, number>();
      for (const o of run) tally.set(o.info.abbr, (tally.get(o.info.abbr) ?? 0) + 1);
      const parts = [...tally.entries()].map(([abbr, n]) => `${abbr}×${n}`).join(' ');
      out += `⟦${run.length} hidden: ${parts}⟧`;
    }
    i = j - 1;
  }
  return out;
}

function hints(found: Occurrence[]): string[] {
  const out: string[] = [];
  const kinds = (pred: (o: Occurrence) => boolean) => found.filter(pred).length;
  const tags = kinds((o) => isTagChar(o.cp));
  const vs = kinds((o) => isVariationSelector(o.cp));
  const zw = kinds(
    (o) => o.info.kind === 'invisible' && !isTagChar(o.cp) && !isVariationSelector(o.cp),
  );
  const distinct = new Set(found.filter((o) => o.info.kind === 'invisible').map((o) => o.cp)).size;
  if (tags)
    out.push('Unicode tag characters: ASCII text hidden as invisible tags (Decode reads it).');
  if (vs >= 2 && vs !== found.filter((o) => o.cp === 0xfe0f).length) {
    out.push('Variation selectors: possibly bytes smuggled after a character (Decode tries it).');
  }
  if (zw >= 8 && distinct >= 2)
    out.push('A run of zero-width characters: a binary or base-4 payload (Decode tries it).');
  if (found.length === 1 && found[0]!.index === 0 && found[0]!.cp === 0xfeff) {
    out.push('Only a byte order mark at the start: harmless.');
  }
  if (found.some((o) => (o.cp >= 0x202a && o.cp <= 0x202e) || (o.cp >= 0x2066 && o.cp <= 0x2069))) {
    out.push(
      'Bidirectional controls: the text may display in a different order than it is stored.',
    );
  }
  if (found.some((o) => o.info.kind === 'space')) {
    out.push('Unusual spaces: ordinary vs no-break/thin spaces can encode bits.');
  }
  if (found.some((o) => o.info.kind === 'control'))
    out.push('Control characters hide in the text.');
  return out;
}

/** Plain-looking text (no controls or replacement characters)? Then show it as text, not bytes. */
function looksTextual(value: string): boolean {
  if (!value.length) return false;
  let ok = 0;
  let total = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    total++;
    if (
      cp === 9 ||
      cp === 10 ||
      cp === 13 ||
      (cp >= 0x20 && cp !== 0x7f && cp !== 0xfffd && !(cp >= 0x80 && cp < 0xa0))
    )
      ok++;
  }
  return ok / total >= 0.9;
}

function preview(value: string, max = 70): string {
  const clean = [...value].map((ch) => (ch.codePointAt(0)! < 0x20 ? '·' : ch)).join('');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function reveal(input: string, includeSpaces: boolean): Output[] {
  const { cps, found } = scan(input, includeSpaces);
  if (!found.length) {
    return [
      {
        type: 'note',
        level: 'success',
        text: `No invisible or unusual characters in these ${cps.length} characters. If you expected some, the app you copied from may have stripped them: try downloading the file instead.`,
      },
    ];
  }
  const types = new Map<number, { info: SpecialChar; count: number }>();
  for (const o of found) {
    const t = types.get(o.cp) ?? { info: o.info, count: 0 };
    t.count++;
    types.set(o.cp, t);
  }
  let runs = 0;
  let longest = 0;
  let current = 0;
  const at = new Set(found.map((o) => o.index));
  for (let i = 0; i < cps.length; i++) {
    if (at.has(i)) {
      if (!current) runs++;
      current++;
      longest = Math.max(longest, current);
    } else current = 0;
  }
  const entries: [string, string][] = [
    [
      'Characters',
      `${cps.length} (${cps.length - found.length} ordinary, ${found.length} invisible or unusual)`,
    ],
    ['Different kinds', String(types.size)],
    ['Runs', `${runs} (longest ${longest} in a row)`],
  ];
  const note = hints(found);
  if (note.length) entries.push(['Looks like', note.join(' ')]);

  const out: Output[] = [
    { type: 'kv', label: 'Summary', entries },
    {
      type: 'text',
      label: 'Text with the invisible characters marked',
      value: withMarkers(cps, found),
    },
    { type: 'text', label: 'Visible text only', value: stripInvisible(input, includeSpaces) },
    {
      type: 'table',
      label: 'What is in there',
      columns: ['Code point', 'Name', 'Count', 'Kind'],
      rows: [...types.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0] - b[0])
        .map(([cp, t]) => [codePointLabel(cp), t.info.name, t.count, t.info.kind]),
    },
    {
      type: 'table',
      label: found.length > MAX_ROWS ? `Where (first ${MAX_ROWS} of ${found.length})` : 'Where',
      columns: ['Position', 'Line:column', 'Code point', 'Name'],
      rows: found
        .slice(0, MAX_ROWS)
        .map((o) => [o.index, `${o.line}:${o.column}`, codePointLabel(o.cp), o.info.name]),
    },
  ];
  return out;
}

function decode(input: string): Output[] {
  const { found } = scan(input, true);
  if (!found.length) {
    throw new ToolError(
      'No invisible characters found in the text. Paste it with the hidden characters included (some apps strip them when copying), or switch to Reveal to inspect the text.',
    );
  }
  const candidates: Candidate[] = decodeAll(input);
  const visible = stripInvisible(input, true);
  if (!candidates.length) {
    return [
      {
        type: 'note',
        level: 'warn',
        text: 'Invisible characters are present but no known scheme produced text. Switch to Reveal to see which characters they are.',
      },
      { type: 'text', label: 'Visible text only', value: visible },
    ];
  }
  const best = candidates[0]!;
  const out: Output[] = [];
  const label = `Best reading · ${best.scheme}`;
  out.push(
    looksTextual(best.text)
      ? { type: 'text', label, value: best.text }
      : { type: 'bytes', label, value: best.bytes, filename: 'hidden.bin' },
  );
  if (best.score < 35 || !looksTextual(best.text)) {
    out.push({
      type: 'note',
      level: 'warn',
      text: 'None of the readings looks like plain text. The payload may be encrypted or compressed, or use a scheme not covered here: check the other readings below.',
    });
  }
  out.push({
    type: 'table',
    label: 'Every reading, most readable first',
    columns: ['Rank', 'Scheme', 'Mapping', 'Score', 'Result'],
    rows: candidates
      .slice(0, 12)
      .map((c, i) => [i + 1, c.scheme, c.detail, c.score.toFixed(1), preview(c.text)]),
    highlight: [0],
  });
  out.push({
    type: 'text',
    label: 'Visible text with the invisible characters removed',
    value: visible,
  });
  return out;
}

const SCHEME_LABELS: { value: EncodeScheme; label: string }[] = [
  { value: 'binary', label: 'Binary (ZWSP=0, ZWNJ=1)' },
  { value: '330k', label: '330k tool (base 4)' },
  { value: 'tags', label: 'Unicode tags (ASCII)' },
  { value: 'variation', label: 'Variation selectors' },
];

function encode(
  cover: string,
  secret: string,
  scheme: EncodeScheme,
  placement: Placement,
): Output[] {
  if (!secret) throw new ToolError('Type the message to hide in the "Secret message" option.');
  if (!cover.trim())
    throw new ToolError('Type the cover text (the visible sentence) in the input box.');
  const { units, chars } = encodePayload(secret, scheme);
  const result = embedPayload(cover, units, placement);
  const back = decodeAll(result)[0];
  const ok = back?.text === secret;
  return [
    {
      type: 'note',
      level: 'success',
      text: `Hidden ${[...secret].length} characters using ${chars} invisible characters. Copy the text below: it looks like the cover text.`,
    },
    { type: 'text', label: 'Stego text (copy all of it)', value: result },
    ok
      ? {
          type: 'note',
          level: 'success',
          text: 'Round-trip check passed: decoding returns the secret.',
        }
      : {
          type: 'note',
          level: 'warn',
          text: 'Round-trip check failed: the cover text already contains invisible characters that confuse the decoder. Use Reveal to clean it first.',
        },
  ];
}

const demoCover = 'Nothing to see here, just an ordinary sentence about the weather.';
const demoBinary = embedPayload(
  demoCover,
  encodePayload('flag{zero_width_whispers}', 'binary').units,
  'after-first',
);
const demo330k = embedPayload(
  'The quick brown fox jumps over the lazy dog',
  encodePayload('flag{330k_compatible}', '330k').units,
  'spread',
);
const demoTags = embedPayload(
  'Totally normal message, nothing attached 🙂',
  encodePayload('flag{tags_are_invisible}', 'tags').units,
  'end',
);

export default defineTool({
  id: 'zero-width',
  name: 'Zero-width / invisible text',
  category: 'stego',
  description:
    'Find invisible Unicode characters in text, decode the message they hide, or hide your own.',
  tags: [
    'zero width',
    'zwsp',
    'zwnj',
    'invisible',
    'unicode steganography',
    'tag characters',
    'variation selector',
    'holloway steg',
    '330k',
    'bidi',
  ],
  input: 'text',
  placeholder:
    'Paste text that may contain invisible characters (copy it with the hidden characters)',
  options: {
    mode: toggle('Mode', [
      { value: 'reveal', label: 'Reveal' },
      { value: 'decode', label: 'Decode' },
      { value: 'encode', label: 'Encode' },
    ]),
    spaces: bool('Flag unusual spaces', true, {
      hint: 'No-break, thin, em spaces and the like',
      showIf: (v) => v.mode === 'reveal',
    }),
    scheme: select('Hide with', SCHEME_LABELS, 'binary', { showIf: (v) => v.mode === 'encode' }),
    placement: select(
      'Place it',
      [
        { value: 'after-first', label: 'After the first character' },
        { value: 'end', label: 'At the end' },
        { value: 'spread', label: 'Spread through the text' },
      ],
      'after-first',
      { showIf: (v) => v.mode === 'encode' },
    ),
    secret: text('Secret message', '', {
      placeholder: 'flag{...}',
      showIf: (v) => v.mode === 'encode',
    }),
  },
  examples: [
    {
      label: 'Reveal invisible characters',
      input: demoBinary,
      expect: 'ZERO WIDTH SPACE',
    },
    {
      label: 'Decode binary ZWSP/ZWNJ',
      input: demoBinary,
      options: { mode: 'decode' },
      expect: 'flag{zero_width_whispers}',
    },
    {
      label: 'Decode 330k-style text',
      input: demo330k,
      options: { mode: 'decode' },
      expect: 'flag{330k_compatible}',
    },
    {
      label: 'Decode Unicode tags',
      input: demoTags,
      options: { mode: 'decode' },
      expect: 'flag{tags_are_invisible}',
    },
    {
      label: 'Hide a message',
      input: 'Meet me at the usual place at noon.',
      options: { mode: 'encode', secret: 'flag{hidden_in_plain_sight}', placement: 'end' },
      expect: 'Round-trip check passed',
    },
  ],
  detect({ text: t }) {
    if (!t) return null;
    const { found } = scan(t, false);
    const invisible = found.filter((o) => o.info.kind === 'invisible');
    if (!invisible.length) return null;
    if (invisible.length === 1 && invisible[0]!.index === 0 && invisible[0]!.cp === 0xfeff)
      return null;
    const payload = invisible.length >= 8 || invisible.some((o) => isTagChar(o.cp));
    return {
      score: payload ? 0.9 : 0.5,
      options: { mode: payload ? 'decode' : 'reveal' },
      reason: `${invisible.length} invisible character${invisible.length === 1 ? '' : 's'} in the text`,
    };
  },
  run(input, { mode, spaces, scheme, placement, secret }) {
    if (mode === 'encode') return encode(input, secret, scheme, placement);
    if (mode === 'decode') return decode(input);
    return reveal(input, spaces);
  },
});
