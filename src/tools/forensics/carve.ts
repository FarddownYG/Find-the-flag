import { defineTool, bool, text } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { tOr } from '../../i18n';
import { signatureName, slug, toolT } from '../../i18n/tool-text';
import { printableRatio } from '../../lib/bytes';
import { matchesAt, SIGNATURES, type Signature } from '../../lib/signatures';

const T = toolT('carve');

/** One file found inside the input. `end` is exclusive and never past the buffer. */
export interface Embedded {
  start: number;
  end: number;
  sig: Signature;
  /** How the end was found, in plain words. */
  how: string;
  /** True when the end comes from the file's own structure rather than a guess. */
  exact: boolean;
  /** True when the structure says the file is longer than the data we have. */
  truncated: boolean;
}

export interface CarveSettings {
  /** Also report the file that starts at offset 0. */
  container: boolean;
  /** Also report files found inside other recognised files. */
  nested: boolean;
  /** Restrict to these signature ids / extensions (empty = everything). */
  only: Set<string>;
}

export interface CarveResult {
  found: Embedded[];
  /** Matches skipped because they sit inside another recognised file. */
  nestedSkipped: number;
  /** The recognised file at offset 0, if any (reported or not). */
  container: Embedded | null;
  /** More matches existed than the cap allows. */
  capped: boolean;
}

const MAX_FOUND = 1000;

interface Anchor {
  sig: Signature;
  /** Index inside `magic` of the byte the scan looks for. */
  k: number;
}

/** Signatures that can be carved: strong magics, plus weak ones that bring their own check. */
export const isCarvable = (s: Signature) => !s.weak || s.valid !== undefined;

/** Anchor on a byte that is rare in real data: 0x00 and 0xFF are everywhere in binaries. */
function anchorIndex(sig: Signature): number {
  const rare = sig.magic.findIndex((m) => m !== null && m !== 0 && m !== 0xff);
  if (rare >= 0) return rare;
  const nonZero = sig.magic.findIndex((m) => m !== null && m !== 0);
  return nonZero >= 0 ? nonZero : sig.magic.findIndex((m) => m !== null);
}

function buildTable(sigs: Signature[]): (Anchor[] | undefined)[] {
  const table: (Anchor[] | undefined)[] = new Array<Anchor[] | undefined>(256).fill(undefined);
  for (const sig of sigs) {
    const k = anchorIndex(sig);
    if (k < 0) continue;
    const byte = sig.magic[k]!;
    (table[byte] ??= []).push({ sig, k });
  }
  return table;
}

export const strength = (s: Signature) =>
  (s.weak ? 0 : 1000) + s.magic.filter((m) => m !== null).length + (s.end ? 1 : 0);

const DEFAULT_TABLE = buildTable(SIGNATURES.filter(isCarvable));

/** A signature's own end rule in the user's language (the Binary analyzer translates them). */
const endHowText = (endHow: string) => tOr(`tool.binary-analyzer.end.${slug(endHow)}`, endHow);

/** Every offset where a carvable signature matches and passes its sanity check. */
export function scan(
  b: Uint8Array,
  only: Set<string> = new Set(),
): { start: number; sig: Signature }[] {
  const table =
    only.size === 0
      ? DEFAULT_TABLE
      : buildTable(SIGNATURES.filter((s) => isCarvable(s) && (only.has(s.id) || only.has(s.ext))));
  const best = new Map<number, { start: number; sig: Signature }>();
  const n = b.length;
  for (let i = 0; i < n; i++) {
    const list = table[b[i]!];
    if (list === undefined) continue;
    for (const { sig, k } of list) {
      const start = i - k - (sig.offset ?? 0);
      if (start < 0 || !matchesAt(b, sig, start)) continue;
      if (sig.valid && !sig.valid(b, start)) continue;
      const prev = best.get(start);
      if (!prev || strength(sig) > strength(prev.sig)) best.set(start, { start, sig });
    }
  }
  return [...best.values()].sort((a, c) => a.start - c.start);
}

/** Find every embedded file and work out where each one ends. */
export function carveAll(b: Uint8Array, settings: CarveSettings): CarveResult {
  const hits = scan(b, settings.only);
  const found: Embedded[] = [];
  let covered = 0;
  let nestedSkipped = 0;
  let container: Embedded | null = null;
  let capped = false;

  for (let h = 0; h < hits.length; h++) {
    const { start, sig } = hits[h]!;
    const inside = start < covered;
    if (inside && !settings.nested) {
      nestedSkipped++;
      continue;
    }
    let end = sig.end ? sig.end(b, start) : null;
    let truncated = false;
    if (end !== null && end <= start) end = null;
    const exact = end !== null;
    let how = sig.endHow ? endHowText(sig.endHow) : T('how.structure');
    if (end !== null && end > b.length) {
      truncated = true;
      end = b.length;
      how = T('how.truncated', { how });
    }
    if (end === null) {
      const next = hits.slice(h + 1).find((x) => x.start > start);
      end = next ? next.start : b.length;
      how = next ? T('how.next') : T('how.eof');
    }
    const item: Embedded = { start, end, sig, how, exact, truncated };
    if (start === 0 && !inside) {
      container = item;
      if (exact) covered = Math.max(covered, end);
      if (!settings.container) continue;
    } else if (exact && !inside) {
      covered = Math.max(covered, end);
    }
    if (found.length >= MAX_FOUND) {
      capped = true;
      break;
    }
    found.push(item);
  }
  return { found, nestedSkipped, container, capped };
}

const hex8 = (n: number) => n.toString(16).padStart(8, '0');

/** "ZIP archive (also docx, xlsx...)" -> "ZIP archive" for running text. */
const shortName = (sig: Signature) => signatureName(sig).replace(/\s*[(（].*$/, '');

/** "zip, png .gz" -> set of lower-case names; unknown names are an error. */
function parseTypes(raw: string): Set<string> {
  const names = raw
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((x) => x.replace(/^\./, ''))
    .filter(Boolean);
  const known = new Set(SIGNATURES.flatMap((s) => [s.id, s.ext.toLowerCase()]));
  const unknown = names.filter((x) => !known.has(x));
  if (unknown.length) {
    const exts = [...new Set(SIGNATURES.filter(isCarvable).map((s) => s.ext))].sort();
    // Each language quotes and lists the names its own way: "a", "b" · « a », « b » · “a”、“b”.
    const types = unknown
      .map((type) => T('value.quotedType', { type }))
      .join(T('value.typeSeparator'));
    throw new ToolError(T('error.unknownType', { types, exts: exts.slice(0, 24).join(', ') }));
  }
  return new Set(names);
}

export default defineTool({
  id: 'carve',
  name: 'Carve embedded files',
  category: 'forensics',
  description:
    'Find files hidden inside other files by their magic bytes, work out where each ends, and extract them.',
  tags: [
    'binwalk',
    'foremost',
    'scalpel',
    'extract',
    'embedded',
    'appended',
    'polyglot',
    'trailing data',
    'file carving',
    'steghide',
  ],
  input: 'bytes',
  placeholder: 'Drop any file — an image with a ZIP behind it, a memory dump, a firmware…',
  options: {
    container: bool('Include the container', false, {
      hint: 'Also carve the file that starts at offset 0 (normally that is the input itself).',
    }),
    nested: bool('Include nested matches', false, {
      hint: 'Also list files found inside other recognised files, e.g. every entry of a ZIP.',
    }),
    types: text('Only these types', '', {
      placeholder: 'zip, png, gz … (empty = everything)',
      hint: 'File extensions or signature ids, separated by commas.',
    }),
  },
  examples: [
    {
      label: 'PNG with a ZIP glued after it',
      input: { sample: 'forensics-polyglot.png' },
      expect: 'ZIP archive',
    },
    {
      label: 'Also carve the PNG itself',
      input: { sample: 'forensics-polyglot.png' },
      options: { container: true },
      expect: 'IEND chunk',
    },
    {
      label: 'Only look for PNG files',
      input: { sample: 'forensics-polyglot.png' },
      options: { container: true, types: 'png' },
      expect: 'PNG image',
    },
  ],
  run({ bytes }, { container, nested, types }) {
    if (bytes.length === 0) throw new ToolError(T('error.empty'));
    const only = parseTypes(types);
    const {
      found,
      nestedSkipped,
      container: first,
      capped,
    } = carveAll(bytes, { container, nested, only });
    const out: Output[] = [];

    // Data after the end of the file that starts at offset 0: the classic "appended" trick.
    let trailingFrom: number | null = null;
    if (first?.exact && !first.truncated && first.end < bytes.length) {
      trailingFrom = first.end;
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.trailing', {
          name: shortName(first.sig),
          end: first.end,
          hex: `0x${first.end.toString(16)}`,
          count: bytes.length - first.end,
        }),
      });
    }

    const files: { name: string; data: Uint8Array; note?: string }[] = [];
    for (const f of found) {
      files.push({
        // slice(): a view would drag the whole input along when the result crosses a worker.
        name: `${hex8(f.start)}.${f.sig.ext}`,
        data: bytes.slice(f.start, f.end),
        note: `${signatureName(f.sig)} · ${f.how}`,
      });
    }
    // Trailing bytes nobody recognised (a plain-text flag, a key...) are worth keeping too.
    if (trailingFrom !== null && !found.some((f) => f.start >= trailingFrom)) {
      files.push({
        name: `trailing-${hex8(trailingFrom)}.bin`,
        data: bytes.slice(trailingFrom),
        note: T('file.trailing'),
      });
    }

    if (found.length > 0) {
      out.push({
        type: 'table',
        label: T('label.embedded'),
        columns: [
          T('col.offset'),
          T('col.hex'),
          T('col.type'),
          T('col.size'),
          T('col.endsAt'),
          T('col.endFoundBy'),
        ],
        rows: found.map((f) => [
          f.start,
          `0x${f.start.toString(16)}`,
          signatureName(f.sig),
          f.end - f.start,
          `0x${f.end.toString(16)}`,
          f.how,
        ]),
        highlight: found.flatMap((f, i) => (f.start > 0 && f.exact ? [i] : [])),
      });
    }
    if (files.length > 0) out.push({ type: 'files', label: T('label.carvedFiles'), files });
    if (found.length === 0 && files.length === 0) {
      out.push({
        type: 'note',
        level: 'info',
        text: first
          ? first.exact
            ? T('note.single', { name: shortName(first.sig) })
            : T('note.singleNoEnd', { name: shortName(first.sig) })
          : only.size
            ? T('note.noneTypes', { count: bytes.length })
            : T('note.none', { count: bytes.length }),
      });
    }
    if (nestedSkipped > 0) {
      out.push({
        type: 'note',
        level: 'info',
        text:
          found.length > 0
            ? T('note.nestedAbove', { count: nestedSkipped })
            : first
              ? T('note.nestedInput', { count: nestedSkipped, name: shortName(first.sig) })
              : T('note.nestedOther', { count: nestedSkipped }),
      });
    }
    if (capped) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.capped', { count: found.length }),
      });
    }
    return out;
  },
  detect({ bytes }) {
    if (bytes.length < 32) return null;
    // Bounded: triage must stay cheap even for a big file.
    const head = bytes.subarray(0, Math.min(bytes.length, 4 << 20));
    const { found, container } = carveAll(head, {
      container: false,
      nested: false,
      only: new Set(),
    });
    const sizeKnown = head.length === bytes.length;
    if (found.length > 0) {
      const f = found[0]!;
      return {
        score: printableRatio(head) > 0.97 ? 0.45 : 0.65,
        reason: T('detect.found', { name: signatureName(f.sig), offset: f.start }),
        options: { container: false },
      };
    }
    if (sizeKnown && container?.exact && !container.truncated && container.end < bytes.length) {
      return {
        score: 0.6,
        reason: T('detect.trailing', { count: bytes.length - container.end }),
      };
    }
    return null;
  },
});
