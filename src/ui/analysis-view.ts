/**
 * The analysis report, drawn top to bottom in layers: the verdict (one sentence), then the
 * findings by confidence, each with its proof, how to redo it by hand and the lesson behind the
 * technique, then what was checked, and a button that copies a Markdown writeup. The explanation
 * comes first; the evidence is one click away, never in the way.
 */
import type { AnalysisResult, Confidence, Finding } from '../core/analyze';
import { t } from '../i18n';
import { toolName } from '../i18n/tool-text';
import { getTool } from '../core/registry';
import {
  analysisWriteup,
  checkLabel,
  hasInputOffset,
  isLimit,
  kindLabel,
  lessonText,
  orderOf,
  rawFor,
  redoFor,
  tierLabel,
  TIERS,
  verdictText,
  whereText,
  type AnalysisSource,
} from './analysis-lessons';
import { copyText, h } from './dom';
import { flagged, hexView, type OutputContext } from './outputs';

/** Findings drawn per tier before "show more": big archives yield hundreds of nodes. */
const TIER_PAGE = 20;
/** Findings opened by default in a tier. */
const OPEN_FIRST = 3;
/** Bytes of a region shown as proof. */
const PROOF_BYTES = 256;

const button = (label: string, onclick: () => void, cls = 'btn btn-ghost'): HTMLButtonElement =>
  h('button', { type: 'button', class: cls, onclick }, label);

function proofBlock(f: Finding, ctx: OutputContext, source?: AnalysisSource): HTMLElement | null {
  const parts: (HTMLElement | null)[] = [];
  if (f.flag) parts.push(h('p', { class: 'an-flag' }, ...flagged(f.flag, ctx)));
  const where = whereText(f);
  if (f.detail || where) {
    parts.push(h('p', { class: 'an-meta' }, [f.detail, where].filter(Boolean).join(' · ')));
  }
  if (source && hasInputOffset(f)) {
    const start = f.offset ?? 0;
    const slice = source.bytes.subarray(start, start + Math.min(f.size ?? 0, PROOF_BYTES));
    if (slice.length) {
      parts.push(
        h(
          'p',
          { class: 'an-proof-label' },
          t('ui.analysis.proofBytes', { offset: start, bytes: slice.length }),
        ),
        hexView(slice),
      );
    }
  }
  const real = parts.filter((p): p is HTMLElement => p !== null);
  return real.length ? h('div', { class: 'an-proof' }, ...real) : null;
}

function redoBlock(f: Finding, ctx: OutputContext, source?: AnalysisSource): HTMLElement | null {
  const redo = redoFor(f, source);
  const buttons = source
    ? redo.open.flatMap((target) => {
        const tool = getTool(target.tool);
        if (!tool) return [];
        return [
          button(t('ui.analysis.openIn', { tool: toolName(tool) }), () =>
            ctx.pipe(target.tool, rawFor(target, source), target.options),
          ),
        ];
      })
    : [];
  if (!buttons.length && !redo.commands.length) return null;
  const command = redo.commands.join('\n');
  const copy: HTMLButtonElement = button(t('ui.out.copy'), () => void copyText(command, copy));
  return h(
    'div',
    { class: 'an-redo' },
    h('h4', { class: 'an-h4' }, t('ui.analysis.redo')),
    buttons.length ? h('div', { class: 'action-row an-buttons' }, ...buttons) : null,
    redo.commands.length
      ? h(
          'div',
          { class: 'an-cmd' },
          h('p', { class: 'an-proof-label' }, t('ui.analysis.orTerminal')),
          h('pre', { class: 'an-code' }, command),
          copy,
        )
      : null,
  );
}

function findingCard(
  f: Finding,
  ctx: OutputContext,
  source: AnalysisSource | undefined,
  open: boolean,
): HTMLElement {
  return h(
    'li',
    { class: 'an-item' },
    h(
      'details',
      { class: `an-finding an-finding-${f.confidence}`, open },
      h(
        'summary',
        { class: 'an-summary' },
        h('span', { class: `an-chip an-chip-${f.confidence}` }, tierLabel(f.confidence)),
        h('span', { class: 'an-kind' }, kindLabel(f.kind)),
        h('span', { class: 'an-title' }, f.flag ? '' : f.title),
      ),
      h(
        'div',
        { class: 'an-body' },
        proofBlock(f, ctx, source),
        redoBlock(f, ctx, source),
        h(
          'div',
          { class: 'an-lesson' },
          h('h4', { class: 'an-h4' }, t('ui.analysis.lesson')),
          h('p', null, lessonText(f.kind)),
        ),
      ),
    ),
  );
}

function tierSection(
  tier: Confidence,
  findings: Finding[],
  ctx: OutputContext,
  source: AnalysisSource | undefined,
): HTMLElement {
  const list = h('ol', { class: 'an-list' });
  /** The first few are open; the rest are one line each until clicked. */
  let drawn = 0;
  const draw = (items: Finding[]) =>
    items.forEach((f) =>
      list.append(findingCard(f, ctx, source, tier !== 'candidate' && drawn++ < OPEN_FIRST)),
    );
  draw(findings.slice(0, TIER_PAGE));
  const more = findings.length - TIER_PAGE;
  const showMore: HTMLButtonElement | null =
    more > 0
      ? button(t('ui.analysis.showMore', { more }), () => {
          draw(findings.slice(TIER_PAGE));
          showMore?.remove();
        })
      : null;
  return h(
    'section',
    { class: `an-tier an-tier-${tier}`, 'aria-label': tierLabel(tier) },
    h(
      'h3',
      { class: 'an-h3' },
      h('span', { class: `an-chip an-chip-${tier}` }, tierLabel(tier)),
      h('span', { class: 'an-count' }, String(findings.length)),
    ),
    h('p', { class: 'an-tier-help' }, t(`ui.analysis.tierHelp.${tier}`)),
    list,
    showMore,
  );
}

function checklistSection(result: AnalysisResult): HTMLElement {
  const done = result.checklist.filter((c) => !isLimit(c));
  const limits = result.checklist.filter(isLimit);
  return h(
    'section',
    { class: 'an-checked' },
    h('h3', { class: 'an-h3' }, t('ui.analysis.checked')),
    h('ul', { class: 'an-checks' }, ...done.map((c) => h('li', null, checkLabel(c)))),
    limits.length
      ? h(
          'details',
          { class: 'an-rejected' },
          h('summary', null, t('ui.analysis.rejected', { n: limits.length })),
          h('ul', { class: 'an-checks' }, ...limits.map((c) => h('li', null, checkLabel(c)))),
        )
      : null,
  );
}

function writeupSection(result: AnalysisResult, source?: AnalysisSource): HTMLElement {
  const hasFlag = result.findings.some((f) => f.flag);
  const include = h('input', { type: 'checkbox', id: 'an-include-flag' });
  const copy: HTMLButtonElement = button(
    t('ui.analysis.copyWriteup'),
    () => void copyText(analysisWriteup({ result, source, includeFlag: include.checked }), copy),
  );
  return h(
    'section',
    { class: 'an-writeup' },
    copy,
    hasFlag
      ? h(
          'label',
          { class: 'an-check', for: 'an-include-flag' },
          include,
          h('span', null, t('ui.analysis.includeFlag')),
        )
      : null,
  );
}

/** The layered report for one analysis result. `source` enables proofs and "open in" buttons. */
export function renderAnalysis(
  result: AnalysisResult,
  ctx: OutputContext,
  source?: AnalysisSource,
): HTMLElement {
  const counts = TIERS.map((tier) =>
    result.findings
      .filter((f) => f.confidence === tier)
      .sort((a, b) => orderOf(a.kind) - orderOf(b.kind)),
  );
  const sub = [
    result.format
      ? t('ui.analysis.format', { format: result.format })
      : t('ui.analysis.formatUnknown'),
    t('ui.analysis.checkCount', { count: result.checklist.length }),
  ].join(' · ');
  return h(
    'section',
    { class: 'an', 'aria-label': t('ui.analysis.title') },
    h(
      'header',
      { class: 'an-verdict' },
      h('p', { class: 'an-eyebrow' }, t('ui.analysis.verdictHeading')),
      h('p', { class: 'an-sentence' }, verdictText(result)),
      h('p', { class: 'an-sub' }, sub),
    ),
    ...TIERS.map((tier, i) =>
      counts[i]?.length ? tierSection(tier, counts[i] ?? [], ctx, source) : null,
    ),
    result.findings.length ? null : h('p', { class: 'empty' }, t('ui.analysis.none')),
    checklistSection(result),
    writeupSection(result, source),
  );
}
