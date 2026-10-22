/**
 * Turns the PHP analysis into output blocks. Everything shown comes from the pasted code (snippets,
 * paths, sink names) or from a translated catalogue of advice; nothing is markup and nothing is a
 * link the page would follow. The per-class advice (why it is exploitable, the payload *family*,
 * the fix) lives in the i18n catalogue under `class.<cls>.*`. Exploitation stays educational.
 */
import { registeredTools } from '../../core/tool-list';
import type { Output } from '../../core/types';
import { toolName, toolT } from '../../i18n/tool-text';
import type { Analysis, Finding, Severity, VulnClass } from './_php-analyze';

const T = toolT('php-audit');

const SEV_LABEL: Record<Severity, string> = {
  P0: 'sev.P0',
  P1: 'sev.P1',
  P2: 'sev.P2',
  P3: 'sev.P3',
};

const classTitle = (cls: VulnClass): string => T(`class.${cls}.title`);

/** Short extra-flag notes appended to a finding's detail. */
function extraNotes(f: Finding): string[] {
  const out: string[] = [];
  for (const flag of (f.extra ?? '').split(/\s+/).filter(Boolean)) {
    switch (flag) {
      case 'rfi':
        out.push(T('extra.rfi'));
        break;
      case 'lfi-wrappers':
        out.push(T('extra.wrappers'));
        break;
      case 'nullbyte':
        out.push(T('extra.nullbyte'));
        break;
      case 'weak-sanitizer':
        out.push(T('extra.weak'));
        break;
      case '0e':
        out.push(T('extra.magic'));
        break;
      case 'php7':
        out.push(T('extra.php7'));
        break;
    }
  }
  return out;
}

function summary(a: Analysis): Output {
  const count = (s: Severity) => a.findings.filter((f) => f.severity === s).length;
  const entries: [string, string][] = [
    [
      T('kv.total'),
      a.findings.length
        ? T('kv.totalValue', {
            count: a.findings.length,
            p0: count('P0'),
            p1: count('P1'),
            p2: count('P2') + count('P3'),
          })
        : T('kv.none'),
    ],
  ];
  if (a.safe.length) entries.push([T('kv.refuted'), String(a.safe.length)]);
  return { type: 'kv', label: T('label.summary'), entries };
}

function findingsTable(a: Analysis): Output {
  const rows = a.findings.map((f, i) => [
    i + 1,
    T(SEV_LABEL[f.severity]),
    classTitle(f.cls),
    f.line,
    f.sink ?? '—',
    T(`conf.${f.confidence}`),
    f.snippet,
  ]);
  return {
    type: 'table',
    label: T('label.findings', { count: a.findings.length }),
    columns: [
      T('col.index'),
      T('col.severity'),
      T('col.class'),
      T('col.line'),
      T('col.sink'),
      T('col.confidence'),
      T('col.snippet'),
    ],
    rows,
    highlight: a.findings.flatMap((f, i) => (f.severity === 'P0' ? [i] : [])),
  };
}

/** One readable block per finding: the why, the payload family, the fix. */
function detailBlock(a: Analysis): Output {
  const parts: string[] = [];
  for (const [i, f] of a.findings.entries()) {
    const lines = [
      `${i + 1}. [${T(SEV_LABEL[f.severity])}] ${classTitle(f.cls)} — ${T('word.line')} ${f.line}`,
      `   ${f.snippet}`,
    ];
    if (f.path) lines.push(`   ${T('word.path')}: ${f.path}`);
    lines.push(`   ${T('word.why')}: ${T(`class.${f.cls}.why`)}`);
    const extras = extraNotes(f);
    if (extras.length) lines.push(`   ${extras.join(' ')}`);
    lines.push(`   ${T('word.technique')}: ${T(`class.${f.cls}.technique`)}`);
    lines.push(`   ${T('word.fix')}: ${T(`class.${f.cls}.fix`)}`);
    lines.push(`   ${T('word.confidence')}: ${T(`conf.${f.confidence}`)}`);
    parts.push(lines.join('\n'));
  }
  return { type: 'text', label: T('label.details'), value: parts.join('\n\n') };
}

function refutedBlock(a: Analysis): Output[] {
  if (!a.safe.length) return [];
  const lines = a.safe.map(
    (s) => `${s.sink}() — ${T('word.line')} ${s.line} — ${T('safe.by', { by: s.by })}`,
  );
  return [
    {
      type: 'text',
      label: T('label.refuted'),
      value: `${T('safe.intro')}\n${lines.join('\n')}`,
    },
  ];
}

function versionBlocks(a: Analysis): Output[] {
  if (!a.versionBanner) return [];
  return [
    { type: 'note', level: 'info', text: T('note.version', { version: a.versionBanner }) },
    { type: 'note', level: 'warn', text: T('note.php2shell') },
  ];
}

function magicBlock(a: Analysis): Output[] {
  if (!a.magicMethods.length) return [];
  if (!a.findings.some((f) => f.cls === 'unserialize')) return [];
  return [
    { type: 'note', level: 'info', text: T('note.magic', { methods: a.magicMethods.join(', ') }) },
  ];
}

/** Chain to the web source analyzer: dump the source over LFI, decode, read it there. */
function crossLink(a: Analysis): Output[] {
  if (!a.findings.some((f) => f.cls === 'lfi')) return [];
  const out: Output[] = [{ type: 'note', level: 'info', text: T('note.chain') }];
  const tools = registeredTools();
  const base64 = tools.find((t) => t.id === 'base64');
  const web = tools.find((t) => t.id === 'web-source');
  const actions: Extract<Output, { type: 'actions' }>['actions'] = [];
  if (base64)
    actions.push({
      label: T('action.open', { tool: toolName(base64) }),
      options: {},
      open: { tool: 'base64', text: '' },
    });
  if (web)
    actions.push({
      label: T('action.open', { tool: toolName(web) }),
      options: {},
      open: { tool: 'web-source', text: '' },
    });
  if (actions.length) out.push({ type: 'actions', label: T('label.related'), actions });
  return out;
}

export function buildReport(a: Analysis): Output[] {
  if (!a.isPhp) {
    return [{ type: 'note', level: 'warn', text: T('note.notPhp') }];
  }
  const out: Output[] = [summary(a)];
  out.push(...versionBlocks(a));
  if (!a.findings.length) {
    out.push({ type: 'note', level: 'success', text: T('note.clean') });
  } else {
    out.push(findingsTable(a));
    out.push(detailBlock(a));
  }
  out.push(...magicBlock(a));
  out.push(...refutedBlock(a));
  out.push(...crossLink(a));
  if (a.capped)
    out.push({ type: 'note', level: 'warn', text: T('note.capped', { count: a.capped }) });
  out.push({ type: 'note', level: 'info', text: T('note.static') });
  return out;
}
