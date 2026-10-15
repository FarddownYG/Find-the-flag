/**
 * How "Hidden Unicode text" shows a scan: the text with its invisible characters and lookalike
 * letters marked, the rows of the tables. No translated text in here: the tool file passes it in.
 */
import { classify, codePointLabel } from './_zerowidth';
import { kindOfFlag, type Flag, type Kind, type Scan } from './_unicode-hidden-scan';
import type { UnicodeData } from './_unicode-lookup';

/** The marker text of a character: ZWSP, TAG a, CR, U+0600. */
export function markerLabel(cp: number): string {
  const c = classify(cp, true);
  if (!c) return codePointLabel(cp);
  if (c.abbr.startsWith('TAG:')) return `TAG ${c.abbr.slice(4)}`;
  if (c.abbr === 'LANGTAG') return 'LANG TAG';
  if (c.abbr === 'ENDTAG') return 'CANCEL TAG';
  return c.abbr;
}

/** Like markerLabel, with the tag characters as one kind (TAG) and the variation selectors as one (VS). */
export function groupLabel(cp: number): string {
  const label = markerLabel(cp);
  if (label.startsWith('TAG ')) return 'TAG';
  return /^VS\d+$/.test(label) ? 'VS' : label;
}

function fromRange(cps: Uint32Array, from: number, to: number): string {
  let out = '';
  for (let i = from; i < to; i += 8192) {
    out += String.fromCodePoint(...cps.subarray(i, Math.min(to, i + 8192)));
  }
  return out;
}

export interface MarkedOptions {
  /** Characters of output before the text is cut. */
  max: number;
  /** A run of more than 6 marks, summarised: "⟨hidden run: 64 characters (ZWSP×30 ZWNJ×34)⟩". */
  run(count: number, parts: string): string;
  /** The end of a cut text: how many characters were left out. */
  cut(left: number): string;
}

/**
 * The text with every invisible, control and unusual space character replaced by a ⟨MARKER⟩, so
 * that the position of a payload shows. Runs of more than 6 marks are summarised.
 */
export function markedText(scan: Scan, opts: MarkedOptions): string {
  const { cps, flagIndex } = scan;
  const n = cps.length;
  const out: string[] = [];
  let size = 0;
  let f = 0;
  let i = 0;
  while (i < n && size < opts.max) {
    if (f < flagIndex.length && flagIndex[f] === i) {
      let g = f;
      while (g + 1 < flagIndex.length && flagIndex[g + 1] === flagIndex[g]! + 1) g++;
      let piece: string;
      if (g - f + 1 <= 6) {
        piece = '';
        for (let k = f; k <= g; k++) piece += `⟨${markerLabel(cps[flagIndex[k]!]!)}⟩`;
      } else {
        const tally = new Map<string, number>();
        for (let k = f; k <= g; k++) {
          const label = groupLabel(cps[flagIndex[k]!]!);
          tally.set(label, (tally.get(label) ?? 0) + 1);
        }
        const parts = [...tally].map(([label, count]) => `${label}×${count}`).join(' ');
        piece = `⟨${opts.run(g - f + 1, parts)}⟩`;
      }
      out.push(piece);
      size += piece.length;
      i = flagIndex[g]! + 1;
      f = g + 1;
    } else {
      const end = Math.min(f < flagIndex.length ? flagIndex[f]! : n, i + (opts.max - size) + 1);
      const piece = fromRange(cps, i, end);
      out.push(piece);
      size += piece.length;
      i = end;
    }
  }
  return i < n ? out.join('') + opts.cut(n - i) : out.join('');
}

/**
 * The text with every lookalike letter wrapped in ⟨ ⟩ ("mark") or replaced by the character it
 * imitates ("normalize"), cut after `max` characters.
 */
export function glyphText(
  scan: Scan,
  opts: Pick<MarkedOptions, 'max' | 'cut'>,
  mode: 'mark' | 'normalize',
): string {
  const { cps, hitIndex, hitLetter } = scan;
  const n = cps.length;
  const out: string[] = [];
  let size = 0;
  let h = 0;
  let i = 0;
  while (i < n && size < opts.max) {
    if (h < hitIndex.length && hitIndex[h] === i) {
      const piece = mode === 'mark' ? `⟨${String.fromCodePoint(cps[i]!)}⟩` : hitLetter[h]!;
      out.push(piece);
      size += piece.length;
      i++;
      h++;
    } else {
      const end = Math.min(h < hitIndex.length ? hitIndex[h]! : n, i + (opts.max - size) + 1);
      const piece = fromRange(cps, i, end);
      out.push(piece);
      size += piece.length;
      i = end;
    }
  }
  return i < n ? out.join('') + opts.cut(n - i) : out.join('');
}

/** The text without the characters that can carry data (invisible and control), cut after `max`. */
export function visibleText(scan: Scan, opts: Pick<MarkedOptions, 'max' | 'cut'>): string {
  const { cps, flagIndex, flagKind } = scan;
  const n = cps.length;
  const carriers = flagIndex.filter((_, k) => {
    const kind = kindOfFlag(flagKind[k]!);
    return kind === 'invisible' || kind === 'control';
  });
  const out: string[] = [];
  let size = 0;
  let c = 0;
  let i = 0;
  while (i < n && size < opts.max) {
    if (carriers[c] === i) {
      i++;
      c++;
      continue;
    }
    const end = Math.min(c < carriers.length ? carriers[c]! : n, i + (opts.max - size) + 1);
    const piece = fromRange(cps, i, end);
    out.push(piece);
    size += piece.length;
    i = end;
  }
  return i < n ? out.join('') + opts.cut(n - i) : out.join('');
}

// ---------- table rows ----------

export interface Row {
  index: number;
  cp: number;
  kind: Kind;
  /** For an invisible, control or space character: why it was set apart. */
  flag?: Flag;
  /** For a lookalike: the ASCII character it imitates. */
  imitates?: string;
}

/**
 * The first `max` occurrences to list: the findings (invisible, control, space, lookalike) in
 * text order, then the characters that belong where they are, then the other non-ASCII ones.
 */
export function occurrenceRows(scan: Scan, max: number): { rows: Row[]; total: number } {
  const rows: Row[] = [];
  const { flagIndex, flagKind, hitIndex, hitLetter, cps } = scan;
  let f = 0;
  let h = 0;
  const nextFinding = (): boolean => {
    while (f < flagIndex.length && kindOfFlag(flagKind[f]!) === 'inplace') f++;
    const fi = f < flagIndex.length ? flagIndex[f]! : Infinity;
    const hi = h < hitIndex.length ? hitIndex[h]! : Infinity;
    if (fi === Infinity && hi === Infinity) return false;
    if (fi < hi) {
      rows.push({ index: fi, cp: cps[fi]!, kind: kindOfFlag(flagKind[f]!), flag: flagKind[f]! });
      f++;
    } else {
      rows.push({
        index: hi,
        cp: cps[hi]!,
        kind: 'homoglyph',
        imitates: hitLetter[h]!,
      });
      h++;
    }
    return true;
  };
  while (rows.length < max && nextFinding());
  for (let k = 0; k < flagIndex.length && rows.length < max; k++) {
    if (kindOfFlag(flagKind[k]!) !== 'inplace') continue;
    rows.push({
      index: flagIndex[k]!,
      cp: cps[flagIndex[k]!]!,
      kind: 'inplace',
      flag: flagKind[k]!,
    });
  }
  let hit = 0;
  for (const index of scan.otherIndex) {
    if (rows.length >= max) break;
    while (hit < hitIndex.length && hitIndex[hit]! < index) hit++;
    if (hitIndex[hit] === index) continue; // it became a lookalike: listed above
    rows.push({ index, cp: cps[index]!, kind: 'other' });
  }
  const c = scan.counts;
  return { rows, total: c.invisible + c.control + c.space + c.inplace + c.homoglyph + c.other };
}

/** The character shown in a table cell: itself, or its marker when it would not show. */
export function charCell(cp: number, kind: Kind, data: UnicodeData): string {
  if (kind === 'invisible' || kind === 'control' || kind === 'space' || kind === 'inplace') {
    return `⟨${markerLabel(cp)}⟩`;
  }
  const category = data.category(cp);
  if (category === 'Cn' || category === 'Co' || category === 'Cs') return '·';
  if (category[0] === 'M') return `◌${String.fromCodePoint(cp)}`; // dotted circle + mark
  return String.fromCodePoint(cp);
}
