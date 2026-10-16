import { defineTool, select, text } from '../../core/define';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { breakoutChar, detectContexts, type Occurrence, type XssContext } from './_xss-contexts';
import { buildExfil, generatePayloads, SANDBOX_DEMO, type Bypass } from './_xss-payloads';

const T = toolT('xss-workshop');

const DEFAULT_MARKER = 'xMARKERx';
const PLACEHOLDER_URL = 'https://xxxxxxxx.webhook.site';

const contextName = (c: XssContext) => T(`context.${c}`);
const bypassName = (b: Bypass) => T(`bypass.${b}`);

/** One row per reflection: where it landed, and whether a breakout looks possible. */
function contextMode(input: string, marker: string): Output[] {
  const occ = detectContexts(input, marker);
  if (!occ.length) {
    return [{ type: 'note', level: 'warn', text: T('note.markerNotFound', { marker }) }];
  }
  const rows = occ.map((o, i) => [
    i + 1,
    contextName(o.context),
    o.attr ?? '',
    verdict(o),
    o.snippet,
  ]);
  const out: Output[] = [
    { type: 'note', level: 'info', text: T('note.contextIntro', { count: occ.length }) },
    {
      type: 'table',
      columns: [T('col.num'), T('col.context'), T('col.attr'), T('col.verdict'), T('col.snippet')],
      rows,
    },
  ];
  // Offer the payloads for the first reflection's context in one click.
  const first = occ[0]!.context;
  out.push({
    type: 'actions',
    actions: [{ label: T('action.payloads'), options: { mode: 'payloads', context: first } }],
  });
  return out;
}

/** Plain-language read on whether the probe can break out of its context. */
function verdict(o: Occurrence): string {
  if (o.context === 'event-handler') return T('verdict.eventHandler');
  if (o.context === 'js') return T('verdict.directJs');
  if (o.context === 'url') return T('verdict.url');
  const ch = breakoutChar(o.context);
  if (!ch) return T('verdict.review');
  return o.escaping.raw.includes(ch)
    ? T('verdict.breakoutYes', { char: ch })
    : o.escaping.encoded.includes(ch)
      ? T('verdict.breakoutNo', { char: ch })
      : T('verdict.breakoutUntested', { char: ch });
}

function payloadsMode(input: string, context: string, marker: string): Output[] {
  let ctx = context as XssContext | 'auto';
  const notes: Output[] = [];
  if (ctx === 'auto') {
    const occ = detectContexts(input, marker || DEFAULT_MARKER);
    ctx = occ[0]?.context ?? 'html';
    notes.push({
      type: 'note',
      level: 'info',
      text: T('note.usedContext', { context: contextName(ctx) }),
    });
  }
  const payloads = generatePayloads(ctx);
  const out: Output[] = [
    ...notes,
    {
      type: 'table',
      columns: [T('col.payload'), T('col.bypass')],
      rows: payloads.map((p) => [p.payload, bypassName(p.bypass)]),
    },
    { type: 'note', level: 'info', text: T('note.payloadsIntro') },
    {
      type: 'actions',
      actions: [
        {
          label: T('action.sandbox'),
          options: {},
          open: { tool: 'xss-workshop', text: payloads[0]!.payload },
        },
      ],
    },
  ];
  return out;
}

function exfilMode(collector: string): Output[] {
  const url = collector.trim() || PLACEHOLDER_URL;
  const forms = buildExfil(url);
  const out: Output[] = [];
  if (!collector.trim()) out.push({ type: 'note', level: 'warn', text: T('note.exfilFillUrl') });
  for (const f of forms) {
    out.push({ type: 'text', label: T(`exfil.${f.form}`), value: f.payload });
  }
  out.push(
    { type: 'note', level: 'warn', text: T('note.exfilHttpOnly') },
    { type: 'note', level: 'success', text: T('note.exfilNothingSent') },
    { type: 'note', level: 'warn', text: T('note.exfilAuthorized') },
    {
      type: 'actions',
      actions: [
        {
          label: T('action.sandbox'),
          options: {},
          open: { tool: 'xss-workshop', text: forms[0]!.payload },
        },
      ],
    },
  );
  return out;
}

function sandboxMode(input: string): Output[] {
  const payload = input.trim();
  if (!payload) return [{ type: 'note', level: 'warn', text: T('note.sandboxEmpty') }];
  return [
    { type: 'note', level: 'info', text: T('note.sandboxIntro') },
    { type: 'sandbox', payload },
  ];
}

function helpMode(): Output[] {
  const steps = [1, 2, 3, 4, 5, 6].map((n) => `${n}. ${T(`help.step${n}`)}`).join('\n');
  return [
    { type: 'text', label: T('help.stepsTitle'), value: steps },
    { type: 'text', label: T('help.collectorsTitle'), value: T('help.collectors') },
    { type: 'note', level: 'info', text: T('help.httpOnly') },
    { type: 'note', level: 'warn', text: T('help.authorized') },
  ];
}

export default defineTool({
  id: 'xss-workshop',
  name: 'XSS workshop',
  category: 'forensics',
  description:
    'Classify where input is reflected, generate context-aware XSS payloads and a cookie-exfil builder, and run a payload in an isolated sandbox that sends nothing.',
  tags: [
    'xss',
    'cross-site scripting',
    'payload',
    'cookie',
    'exfil',
    'reflection',
    'bypass',
    'waf',
  ],
  input: 'text',
  live: false,
  placeholder: 'Paste the response source with your marker, e.g. <input value="xMARKERx">',
  options: {
    // A select, not a segmented toggle: five options overflow the toggle on a phone.
    mode: select(
      'Mode',
      [
        { value: 'context', label: 'Context' },
        { value: 'payloads', label: 'Payloads' },
        { value: 'exfil', label: 'Exfil' },
        { value: 'sandbox', label: 'Sandbox' },
        { value: 'help', label: 'Help' },
      ],
      'context',
      { segmented: false },
    ),
    marker: text('Marker', DEFAULT_MARKER, {
      hint: 'Inject this where your input is reflected, ideally with a probe: xMARKERx\'"<>',
      showIf: (v) => v.mode === 'context',
    }),
    context: select(
      'Context',
      [
        { value: 'auto', label: 'Auto-detect from the marker' },
        { value: 'html', label: 'HTML text' },
        { value: 'attr-double', label: 'Double-quoted attribute' },
        { value: 'attr-single', label: 'Single-quoted attribute' },
        { value: 'attr-unquoted', label: 'Unquoted attribute' },
        { value: 'tag', label: 'Inside a tag (between attributes)' },
        { value: 'event-handler', label: 'Event handler (on* attribute)' },
        { value: 'url', label: 'URL attribute (href, src…)' },
        { value: 'js', label: 'JavaScript code' },
        { value: 'js-string-single', label: "JavaScript 'string'" },
        { value: 'js-string-double', label: 'JavaScript "string"' },
        { value: 'js-string-template', label: 'JavaScript `template`' },
        { value: 'comment', label: 'HTML comment' },
        { value: 'css', label: 'CSS / style' },
      ],
      'auto',
      { showIf: (v) => v.mode === 'payloads' },
    ),
    collector: text('Collector URL', '', {
      placeholder: PLACEHOLDER_URL,
      hint: 'Your own webhook.site / RequestBin / server URL. The tool never contacts it.',
      showIf: (v) => v.mode === 'exfil',
    }),
  },
  examples: [
    {
      label: 'Detect a double-quoted attribute',
      input: '<input name="q" value="xMARKERx">',
      options: { mode: 'context' },
      expect: 'Double-quoted attribute',
    },
    {
      label: 'Payloads for a quoted attribute',
      input: 'x',
      options: { mode: 'payloads', context: 'attr-double' },
      expect: 'onmouseover',
    },
    {
      label: 'Build a cookie stealer',
      input: 'x',
      options: { mode: 'exfil', collector: 'https://abcd1234.webhook.site' },
      expect: 'document.cookie',
    },
    {
      label: 'Run a payload in the sandbox',
      input: SANDBOX_DEMO,
      options: { mode: 'sandbox' },
      expect: 'onerror',
    },
    {
      label: 'Get a free collector',
      input: 'x',
      options: { mode: 'help' },
      expect: 'webhook.site',
    },
  ],
  detect({ text: sample }) {
    if (!sample) return null;
    if (sample.includes(DEFAULT_MARKER)) {
      return { score: 0.9, options: { mode: 'context' }, reason: T('detect.marker') };
    }
    return null;
  },
  run(input, { mode, marker, context, collector }) {
    switch (mode) {
      case 'context':
        return contextMode(input, marker || DEFAULT_MARKER);
      case 'payloads':
        return payloadsMode(input, context, marker || DEFAULT_MARKER);
      case 'exfil':
        return exfilMode(collector);
      case 'sandbox':
        return sandboxMode(input);
      case 'help':
        return helpMode();
    }
  },
});
