/**
 * What the analysis page says about each finding, apart from the DOM: the verdict sentence, the
 * lesson of each technique, how to redo the step by hand (a tool to open, or a terminal command),
 * how the checklist is sorted and the Markdown writeup. Findings carry language-free codes
 * (`kind`, `confidence`); every word comes from the `ui.analysis.*` keys.
 */
import type { AnalysisResult, Confidence, Finding } from '../core/analyze';
import type { RawInput } from '../core/prepare';
import { buildWriteup, codeBlock, FLAG_MASK, type WriteupSection } from '../core/writeup';
import { t, tOr } from '../i18n';
import { formatSize, utf8Decode } from '../lib/bytes';

/** The analysed input: its bytes (for the proof) and how to hand it to another tool. */
export interface AnalysisSource {
  bytes: Uint8Array;
  name?: string;
  raw: RawInput;
}

/** A tool to open on the finding, with the option values to preselect. */
export interface OpenTarget {
  tool: string;
  options?: Record<string, unknown>;
  /** What the tool reads: the file's bytes (default) or its text. */
  as?: 'bytes' | 'text';
}

export interface Redo {
  open: OpenTarget[];
  /** Terminal commands that do the same by hand. */
  commands: string[];
}

export const TIERS: readonly Confidence[] = ['confirmed', 'probable', 'candidate'];

/** Kinds that have a lesson of their own; anything else falls back to its family or "other". */
const KINDS = new Set([
  'flag',
  'encrypted',
  'post-eof',
  'gap',
  'high-entropy',
  'container',
  'carved',
  'embedded',
  'decoded',
  'symbol-words',
  'cipher-hint',
  'stego-lsb',
  'stego-lsb-zone',
  'stego-pvd',
  'stego-pit',
  'stego-statistics',
  'stego-audio-lsb',
  'stego-x86-encoding',
]);

/** The key suffix of a kind's label and lesson ("stego-emd" -> "stego", anything else -> "other"). */
export function canonicalKind(kind: string): string {
  if (KINDS.has(kind)) return kind;
  return kind.startsWith('stego-') ? 'stego' : 'other';
}

export const kindLabel = (kind: string): string =>
  tOr(`ui.analysis.kind.${canonicalKind(kind)}`, kind);
export const lessonText = (kind: string): string => t(`ui.analysis.lesson.${canonicalKind(kind)}`);
export const tierLabel = (tier: Confidence): string => t(`ui.analysis.tier.${tier}`);

/** The part of a node title before its "(format, how)" suffix: the path of what was found. */
const pathOf = (title: string): string => title.replace(/\s+\([^()]*\)$/, '');

// ---------- verdict ----------

/** Order of kinds inside a tier when picking the strongest finding (lower is stronger). */
const KIND_ORDER = [
  'flag',
  'encrypted',
  'post-eof',
  'carved',
  'embedded',
  'decoded',
  'stego',
  'symbol-words',
  'cipher-hint',
  'gap',
  'high-entropy',
  'container',
];
export const orderOf = (kind: string): number => {
  const c = canonicalKind(kind);
  const base = c.startsWith('stego-') ? 'stego' : c;
  const i = KIND_ORDER.indexOf(base);
  return i < 0 ? KIND_ORDER.length : i;
};

/** The finding the verdict is about: strongest tier first, then the most telling kind. */
export function strongest(result: AnalysisResult): Finding | undefined {
  let best: Finding | undefined;
  for (const f of result.findings) {
    if (!best) {
      best = f;
      continue;
    }
    const a = TIERS.indexOf(f.confidence);
    const b = TIERS.indexOf(best.confidence);
    if (a < b || (a === b && orderOf(f.kind) < orderOf(best.kind))) best = f;
  }
  return best;
}

/** One sentence that says what the file is hiding: the key and its parameters. */
export function verdictOf(result: AnalysisResult): { key: string; params: Record<string, string> } {
  const f = strongest(result);
  if (!f) return { key: 'ui.analysis.verdict.none', params: {} };
  const certain = f.confidence === 'confirmed';
  if (f.kind === 'flag' && f.flag)
    return { key: 'ui.analysis.verdict.flag', params: { flag: f.flag } };
  if (f.kind === 'encrypted') {
    return f.size === undefined
      ? { key: 'ui.analysis.verdict.encryptedWhole', params: {} }
      : { key: 'ui.analysis.verdict.encrypted', params: { size: formatSize(f.size) } };
  }
  if (f.kind === 'post-eof' && f.size !== undefined) {
    return { key: 'ui.analysis.verdict.postEof', params: { size: formatSize(f.size) } };
  }
  if (certain && ['carved', 'embedded', 'decoded'].includes(f.kind)) {
    return { key: 'ui.analysis.verdict.file', params: { path: pathOf(f.title) } };
  }
  return {
    key: 'ui.analysis.verdict.lead',
    params: { kind: kindLabel(f.kind), tier: tierLabel(f.confidence) },
  };
}

export const verdictText = (result: AnalysisResult): string => {
  const v = verdictOf(result);
  return t(v.key, v.params);
};

// ---------- redo ----------

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const hex = (n: number): string => `0x${n.toString(16)}`;

/** Kinds whose offset is relative to the analysed input itself (not to a parent node). */
const INPUT_LEVEL = new Set(['post-eof', 'gap', 'high-entropy', 'encrypted']);
export const hasInputOffset = (f: Finding): boolean =>
  INPUT_LEVEL.has(f.kind) && f.offset !== undefined && f.size !== undefined;

/** The tool that finds the same thing, from the method an image detector recorded. */
function toolForMethod(detail: string | undefined): OpenTarget | undefined {
  const method = (detail ?? '').split(/[:\s(]/)[0];
  switch (method) {
    case 'lsb':
    case 'lsb-zone':
      return { tool: 'lsb' };
    case 'pvd':
      return { tool: 'pvd' };
    case 'pit':
      return { tool: 'pit' };
    case 'symbol-words':
      return { tool: 'symbol-words', as: 'text' };
    default:
      return undefined;
  }
}

/** How to redo a finding by hand: tools to open on it and the same step in a terminal. */
export function redoFor(f: Finding, source?: AnalysisSource): Redo {
  const file = source?.name ? quote(source.name) : 'FILE';
  const open: OpenTarget[] = [];
  const commands: string[] = [];
  const at = f.offset;
  const size = f.size;
  const region = (): Record<string, unknown> => ({
    start: String(at ?? 0),
    length: String(Math.min(size ?? 256, 4096)),
  });

  switch (canonicalKind(f.kind)) {
    case 'post-eof':
      open.push({ tool: 'hexdump', options: region() });
      if (at !== undefined) commands.push(`tail -c +${at + 1} ${file} > tail.bin && file tail.bin`);
      commands.push(`binwalk ${file}`);
      break;
    case 'encrypted':
      if (at !== undefined && size !== undefined) {
        open.push({ tool: 'hexdump', options: region() }, { tool: 'entropy' });
        commands.push(
          `binwalk -E ${file}`,
          `tail -c +${at + 1} ${file} | head -c ${size} > region.bin && ent region.bin`,
        );
      } else open.push({ tool: 'angecryption' });
      break;
    case 'gap':
    case 'high-entropy':
      open.push({ tool: 'hexdump', options: region() }, { tool: 'entropy' });
      if (at !== undefined) commands.push(`xxd -s ${at} -l 256 ${file}`);
      commands.push(`binwalk -E ${file}`);
      break;
    case 'container':
    case 'carved':
    case 'embedded':
    case 'decoded':
      open.push({ tool: 'extract' });
      commands.push(`binwalk -e ${file}`);
      break;
    case 'flag': {
      const viaMethod = toolForMethod(f.detail);
      open.push(viaMethod ?? { tool: 'extract' });
      if (viaMethod?.tool === 'lsb') commands.push(`zsteg -a ${file}`);
      else if (!viaMethod) commands.push(`binwalk -e ${file}`, `strings -a ${file} | grep -i flag`);
      break;
    }
    case 'stego-lsb':
    case 'stego-lsb-zone':
      open.push({ tool: 'lsb' });
      commands.push(`zsteg -a ${file}`);
      break;
    case 'stego-pvd':
      open.push({ tool: 'pvd' });
      break;
    case 'stego-pit':
      open.push({ tool: 'pit' });
      break;
    case 'stego-statistics':
      open.push({ tool: 'steganalysis' });
      commands.push(`zsteg -a ${file}`);
      break;
    case 'stego-audio-lsb':
      open.push({ tool: 'audio-stego' });
      break;
    case 'stego-x86-encoding':
      open.push({ tool: 'exe-analyzer' });
      commands.push(`objdump -d ${file}`);
      break;
    case 'symbol-words':
      open.push({ tool: 'symbol-words', as: 'text' });
      break;
    case 'cipher-hint':
      open.push({ tool: 'cipher-identify', as: 'text' });
      break;
    default:
      open.push({ tool: 'extract' });
      commands.push(`binwalk ${file}`);
  }
  return { open, commands };
}

/** The input to hand a tool: the whole file (or its text for the tools that read text). */
export function rawFor(target: OpenTarget, source: AnalysisSource): RawInput {
  if (target.as === 'text') return { text: utf8Decode(source.bytes.subarray(0, 200_000)) };
  return source.raw;
}

// ---------- checklist ----------

/** A checklist entry that says something was NOT done (skipped, failed, cut short). */
export const isLimit = (code: string): boolean =>
  /skipped|failed|unparsed|truncated/.test(code.split(':')[0] ?? code);

/** "detector-run:image" -> "Detector run: image detectors" in the active language. */
export function checkLabel(code: string): string {
  const [base = code, arg = ''] = code.split(/:(.*)/s);
  if (base === 'detector-run' || base === 'detector-failed') {
    return t(`ui.analysis.check.${base}`, { arg: tOr(`ui.analysis.detector.${arg}`, arg) });
  }
  if (base === 'format-identified') return t('ui.analysis.check.format-identified', { arg });
  return tOr(`ui.analysis.check.${base}${arg ? `.${arg}` : ''}`, code);
}

// ---------- writeup ----------

/** Where a finding sits, as text: "offset 0x2f2 (754), 1.86 MiB". */
export function whereText(f: Finding): string {
  if (f.offset === undefined && f.size === undefined) return '';
  if (f.offset === undefined) return formatSize(f.size ?? 0);
  const at = `${hex(f.offset)} (${f.offset})`;
  return f.size === undefined
    ? t('ui.analysis.whereAt', { offset: at })
    : t('ui.analysis.whereAtSize', { offset: at, size: formatSize(f.size) });
}

export interface WriteupInput {
  result: AnalysisResult;
  source?: AnalysisSource;
  includeFlag: boolean;
}

/** The Markdown writeup. Flags stay out of it unless asked for. */
export function analysisWriteup({ result, source, includeFlag }: WriteupInput): string {
  const flags = [...new Set(result.findings.flatMap((f) => (f.flag ? [f.flag] : [])))];
  const hide = (s: string): string =>
    includeFlag ? s : flags.reduce((acc, flag) => acc.split(flag).join(FLAG_MASK), s);

  const findings = result.findings
    .map((f) => {
      const redo = redoFor(f, source);
      const lines = [
        `- **${tierLabel(f.confidence)}**, ${kindLabel(f.kind)}: ${f.title}`,
        f.detail ? `  - ${f.detail}` : '',
        whereText(f) ? `  - ${whereText(f)}` : '',
        `  - ${lessonText(f.kind)}`,
      ].filter(Boolean);
      return redo.commands.length
        ? `${lines.join('\n')}\n\n${codeBlock('sh', redo.commands.join('\n'))}\n`
        : lines.join('\n');
    })
    .join('\n');

  const sections: WriteupSection[] = [
    { heading: t('ui.analysis.verdictHeading'), body: verdictText(result) },
    { heading: t('ui.analysis.findingsHeading'), body: findings || t('ui.analysis.none') },
    {
      heading: t('ui.analysis.checked'),
      body: result.checklist.map((c) => `- ${checkLabel(c)}`).join('\n'),
    },
  ].map((s) => ({ heading: s.heading, body: hide(s.body) }));

  return buildWriteup(sections, {
    title: t('ui.analysis.writeupTitle', { name: source?.name ?? t('ui.analysis.unnamed') }),
    flag: flags[0],
    includeFlag,
    flagLabel: t('ui.analysis.flagLabel'),
  });
}
