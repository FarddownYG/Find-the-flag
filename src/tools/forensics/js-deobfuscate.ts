import { bool, defineTool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { registeredTools } from '../../core/tool-list';
import type { Output } from '../../core/types';
import { toolName, toolT } from '../../i18n/tool-text';
import { beautify } from './_js-deobf-beautify';
import { COMPILE_TYPES } from './_js-deobf-hooks';
import { runSandbox, type SandboxResult } from './_js-deobf-run';
import { peel, type PeelResult, type PeelRule } from './_js-deobf-static';

const T = toolT('js-deobfuscate');

/** The longest script taken (the peel and the sandbox read all of it). */
export const MAX_INPUT = 2_000_000;
/** The most that is re-indented, and the most of one block that is shown. */
const BEAUTIFY_LIMIT = 400_000;
const SHOW_LIMIT = 200_000;
/** Layers shown as a block of their own (all of them are in the table). */
const LAYER_BLOCKS = 40;
const PASS_BLOCKS = 6;
const CELL = 90;
/** Blocked URLs and dialog texts are the point of that table: they get more room. */
const EVENT_CELL = 600;

const RULE_KEY: Record<PeelRule, string> = {
  escapes: 'rule.escapes',
  concat: 'rule.concat',
  unescape: 'rule.unescape',
  uri: 'rule.uri',
  fromCharCode: 'rule.fromCharCode',
  atob: 'rule.atob',
  eval: 'rule.eval',
};

/** Layer types that are decoders: their output is the interesting side. */
const DECODERS = new Set(['unescape', 'atob', 'decodeURIComponent']);
/** Text the script wrote to the page it does not have: the input is what matters. */
const WRITERS = new Set(['document.write', 'document.writeln']);

/** The sandbox renames the word `import` to a stub; show the code as it was written. */
const asWritten = (s: string): string => s.replace(/__imp__/g, 'import');

const cell = (s: string, max = CELL): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

function clip(s: string): { value: string; cut: number } {
  return s.length > SHOW_LIMIT
    ? { value: s.slice(0, SHOW_LIMIT), cut: s.length - SHOW_LIMIT }
    : { value: s, cut: 0 };
}

/** Long code on few lines: the kind a minifier or an obfuscator makes. */
const looksMinified = (code: string): boolean =>
  code.length > 120 && code.split('\n').length < code.length / 100;

/** The code, re-indented when asked (and when it is long and cramped), and cut for display. */
function codeBlock(label: string, code: string, pretty: boolean): Output[] {
  const text =
    pretty && code.length <= BEAUTIFY_LIMIT && looksMinified(code)
      ? beautify(code).replace(/\n+$/, '')
      : code;
  const { value, cut } = clip(text);
  const out: Output[] = [{ type: 'text', label, value }];
  if (cut > 0) out.push({ type: 'note', level: 'info', text: T('note.cut', { count: cut }) });
  return out;
}

/** Buttons that take the code to the tools that decode what is left, and to the other mode. */
function nextSteps(code: string, otherMode: 'static' | 'sandbox'): Output {
  const byId = new Map(registeredTools().map((t) => [t.id, t] as const));
  const actions: Extract<Output, { type: 'actions' }>['actions'] = [];
  for (const id of ['unicode-escape', 'charcode', 'base64']) {
    const tool = byId.get(id);
    if (!tool) continue;
    actions.push({
      label: T('open', { tool: toolName(tool) }),
      options: {},
      open: { tool: id, text: code },
    });
  }
  actions.unshift({
    label: otherMode === 'sandbox' ? T('action.sandbox') : T('action.peel'),
    options: { mode: otherMode },
    primary: otherMode === 'sandbox',
  });
  return { type: 'actions', actions };
}

/** Where a script that is still inside a file comes from: the two analyzers that extract it. */
function analyzers(): Output[] {
  const byId = new Map(registeredTools().map((t) => [t.id, t] as const));
  const pdf = byId.get('pdf-analyzer');
  const exe = byId.get('exe-analyzer');
  if (!pdf || !exe) return [];
  return [
    {
      type: 'note',
      level: 'info',
      text: T('note.sources', { pdf: toolName(pdf), exe: toolName(exe) }),
    },
    {
      type: 'actions',
      actions: [pdf, exe].map((tool) => ({
        label: T('open', { tool: toolName(tool) }),
        options: {},
        open: { tool: tool.id, text: '' },
      })),
    },
  ];
}

// ---------- static ----------

function staticReport(text: string, pretty: boolean): Output[] {
  const r: PeelResult = peel(text);
  const out: Output[] = [{ type: 'note', level: 'info', text: T('note.static') }];
  if (!r.changed) {
    out.push({ type: 'note', level: 'warn', text: T('note.nothingToPeel') });
    out.push(...codeBlock(T('label.input'), text, pretty));
    out.push(nextSteps(text, 'sandbox'));
    out.push(...analyzers());
    return out;
  }
  const count = r.rounds.reduce((n, round) => n + round.steps.reduce((m, s) => m + s.count, 0), 0);
  out.push({
    type: 'kv',
    entries: [
      [T('kv.passes'), String(r.rounds.length)],
      [T('kv.replacements'), String(count)],
      [T('kv.size'), `${text.length} → ${r.code.length}`],
    ],
  });
  out.push({
    type: 'table',
    label: T('label.passes'),
    columns: [T('col.pass'), T('col.rule'), T('col.count'), T('col.size')],
    rows: r.rounds.flatMap((round) =>
      round.steps.map((s) => [round.round, T(RULE_KEY[s.rule]), s.count, round.size]),
    ),
  });
  if (r.stop === 'rounds') out.push({ type: 'note', level: 'warn', text: T('note.stopRounds') });
  if (r.stop === 'work') out.push({ type: 'note', level: 'warn', text: T('note.stopWork') });
  // Each pass, so the layers can be followed one by one (the last one is the result below).
  const middle = r.rounds.slice(0, -1).slice(0, PASS_BLOCKS);
  for (const round of middle) {
    out.push({
      type: 'text',
      label: T('label.pass', { n: round.round }),
      value: round.code.length >= 4000 ? `${round.code}…` : round.code,
    });
  }
  out.push(...codeBlock(T('label.peeled'), r.code, pretty));
  if (/\b(?:eval|Function)\s*\(/.test(r.code)) {
    out.push({ type: 'note', level: 'warn', text: T('note.dynamicLeft') });
  }
  out.push(nextSteps(r.code, 'sandbox'));
  out.push(...analyzers());
  return out;
}

// ---------- sandbox ----------

function layerBlocks(res: SandboxResult): Output[] {
  const out: Output[] = [];
  res.layers.slice(0, LAYER_BLOCKS).forEach((layer, i) => {
    const n = i + 1;
    const decoder = DECODERS.has(layer.type);
    const writer = WRITERS.has(layer.type);
    const key = decoder ? 'label.layerDecoded' : writer ? 'label.layerWritten' : 'label.layerCode';
    out.push({
      type: 'text',
      label: T(key, { n, type: layer.type }),
      value: asWritten(decoder ? layer.output : layer.input),
    });
    // What a compiled function returned is often the next layer (Function("return '…'")()).
    if (!decoder && !writer && layer.output && layer.output !== 'undefined') {
      out.push({
        type: 'text',
        label: T('label.layerReturned', { n, type: layer.type }),
        value: asWritten(layer.output),
      });
    }
    if (layer.error) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.layerError', { n, type: layer.type, error: asWritten(layer.error) }),
      });
    }
  });
  return out;
}

async function sandboxReport(text: string, timeout: number, pretty: boolean): Promise<Output[]> {
  const res = await runSandbox(text, { timeoutMs: timeout });
  if (res.failure) throw new ToolError(T('error.sandbox', { reason: res.failure }));
  const out: Output[] = [];

  const sinks = res.events.filter((e) => e.kind === 'sink');
  const ended = res.timedOut
    ? T('kv.endedTimeout')
    : res.scriptError
      ? T('kv.endedError')
      : T('kv.endedClean');
  out.push({
    type: 'kv',
    entries: [
      [T('kv.layers'), String(res.layers.length + res.dropped)],
      [T('kv.ran'), `${res.ms} ms`],
      [T('kv.limit'), `${timeout} ms`],
      [T('kv.ended'), ended],
      [T('kv.blocked'), String(sinks.length)],
    ],
  });
  if (res.timedOut) {
    out.push({ type: 'note', level: 'warn', text: T('note.timeout', { ms: timeout }) });
  } else if (res.scriptError) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.scriptError', { error: asWritten(res.scriptError) }),
    });
  }
  if (res.warnings.length > 0) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.warnings', { list: res.warnings.slice(0, 5).join('; ') }),
    });
  }
  if (res.layers.length === 0) {
    // Nothing to show is only worth a word when nothing else was caught either.
    if (!res.timedOut && res.events.length === 0) {
      out.push({ type: 'note', level: 'info', text: T('note.noLayers') });
    }
  } else {
    const failed = res.layers.some((l) => l.error);
    out.push({
      type: 'table',
      label: T('label.layers'),
      columns: [
        T('col.num'),
        T('col.type'),
        T('col.input'),
        T('col.output'),
        ...(failed ? [T('col.error')] : []),
      ],
      rows: res.layers.map((l, i) => [
        i + 1,
        l.type,
        cell(asWritten(l.input)),
        cell(asWritten(l.output)),
        ...(failed ? [cell(asWritten(l.error))] : []),
      ]),
    });
    out.push(...layerBlocks(res));
    if (res.layers.length > LAYER_BLOCKS) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.moreLayers', { count: res.layers.length - LAYER_BLOCKS }),
      });
    }
    if (res.dropped > 0) {
      out.push({ type: 'note', level: 'info', text: T('note.dropped', { count: res.dropped }) });
    }
  }

  const finalCode = asWritten(res.finalCode);
  if (finalCode) {
    if (res.layers.some((l) => COMPILE_TYPES.includes(l.type))) {
      out.push(...codeBlock(T('label.final'), finalCode, pretty));
      // What the script compiled last may itself still be escaped or split: peel it too.
      const again = peel(finalCode);
      if (again.changed) {
        out.push(...codeBlock(T('label.finalPeeled'), again.code, pretty));
      }
    } else {
      // Nothing was compiled: this is the last text it decoded or wrote (maybe HTML, not code).
      out.push(...codeBlock(T('label.lastText'), finalCode, false));
    }
  }

  if (res.events.length > 0) {
    out.push({
      type: 'table',
      label: T('label.events'),
      columns: [T('col.event'), T('col.detail')],
      rows: res.events.map((e) => [
        `${T(`kind.${e.kind}`)} · ${e.name}`,
        cell(asWritten(e.detail), EVENT_CELL),
      ]),
    });
  }
  if (sinks.length > 0) out.push({ type: 'note', level: 'success', text: T('note.sinks') });

  out.push({ type: 'note', level: 'info', text: T('note.design') });
  out.push({ type: 'note', level: 'info', text: T('note.limits') });
  out.push(nextSteps(finalCode || text, 'static'));
  out.push(...analyzers());
  return out;
}

export default defineTool({
  id: 'js-deobfuscate',
  name: 'JavaScript deobfuscator (sandbox)',
  category: 'forensics',
  description:
    'Peel obfuscated JavaScript layer by layer: read it (escapes, fromCharCode, atob, unescape) or run it once in a network-less sandbox that records every eval, Function, atob and unescape.',
  tags: [
    'javascript',
    'js',
    'deobfuscate',
    'deobfuscator',
    'obfuscated',
    'eval',
    'unpack',
    'packer',
    'jsfuck',
    'jjencode',
    'aaencode',
    'beautify',
    'sandbox',
    'atob',
    'fromcharcode',
    'unescape',
    'function constructor',
    'de4js',
    'deobfuscateur',
  ],
  input: 'text',
  placeholder: 'eval(atob("YWxlcnQoMSk="))   ·   Function("return \\x61")()   ·   paste a script',
  live: false,
  options: {
    mode: toggle(
      'Mode',
      [
        { value: 'static', label: 'Peel (nothing is run)' },
        { value: 'sandbox', label: 'Run in the sandbox' },
      ],
      'static',
      {
        hint: 'Peel only reads the code. Run in the sandbox executes the script once in a throwaway worker with the network cut off, and records every eval, Function, atob, unescape and decodeURIComponent call.',
      },
    ),
    timeout: toggle(
      'Time limit',
      [
        { value: '200', label: '0.2 s' },
        { value: '500', label: '0.5 s' },
        { value: '1000', label: '1 s' },
        { value: '2000', label: '2 s' },
      ],
      '1000',
      {
        hint: 'The sandbox is stopped by force after this long, whatever the script is doing.',
        showIf: (v) => v.mode === 'sandbox',
      },
    ),
    beautify: bool('Re-indent the result', true, {
      hint: 'Only white space changes; strings, comments and line breaks stay. Code that is short or already readable is left as it is.',
    }),
  },
  examples: [
    {
      label: 'Peel escapes, fromCharCode, atob and joined strings (nothing is run)',
      input: { sample: 'js-deobf-static.txt' },
      expect: 'FTF{static_peel}',
    },
    {
      label: 'Function(Function(…)()) chain, run in the sandbox',
      input: { sample: 'js-deobf-layers.txt' },
      options: { mode: 'sandbox' },
      expect: 'FTF{hooked_function}',
    },
    {
      label: 'eval(atob(eval(atob(…)))) two levels, run in the sandbox',
      input: { sample: 'js-deobf-nested-eval.txt' },
      options: { mode: 'sandbox' },
      expect: 'FTF{nested_eval}',
    },
    {
      label: 'Octal escapes inside a Function chain (a=p)',
      input: `Function(Function("return '\\141\\75\\160'")())()`,
      options: { mode: 'sandbox' },
      expect: 'a=p',
    },
    {
      label: '(0)["constructor"]["constructor"] is caught like Function',
      input: `var code = (0)['constructor']['constructor']("return 'FTF{' + 6 * 7 + '}'");\nconsole.log(code());`,
      options: { mode: 'sandbox' },
      expect: 'FTF{42}',
    },
    {
      label: 'A fetch is blocked and recorded, never sent',
      input: `fetch("https://example.invalid/beacon?id=7").catch(function () {});\nalert("FTF{no_request}");`,
      options: { mode: 'sandbox' },
      expect: 'https://example.invalid/beacon?id=7',
    },
    {
      label: 'An endless loop is cut at the time limit',
      input: 'while (true) {}',
      options: { mode: 'sandbox', timeout: '200' },
      expect: 'was reached and the sandbox was stopped',
    },
  ],
  detect({ text }) {
    if (!text || text.length < 24 || text.length > 500_000) return null;
    const head = text.slice(0, 20_000);
    const calls = (
      head.match(
        /\b(?:eval|Function|atob|unescape|decodeURIComponent)\s*\(|String\s*\.\s*fromCharCode\s*\(/g,
      ) ?? []
    ).length;
    const escapes = (head.match(/\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\[0-3][0-7]{2}/g) ?? [])
      .length;
    const compact = head.replace(/\s+/g, '');
    const symbols = (compact.match(/[[\]()!+]/g) ?? []).length;
    if (compact.length >= 60 && symbols / compact.length > 0.85) {
      return { score: 0.6, options: { mode: 'static' }, reason: T('detect.symbols') };
    }
    if (calls === 0 || !/[;(){}=]/.test(head)) return null;
    const score = Math.min(0.6, 0.38 + calls * 0.06 + (escapes >= 4 ? 0.1 : 0));
    return {
      score,
      options: { mode: 'static' },
      reason: T('detect.calls', { count: calls }),
    };
  },
  async run(text, { mode, timeout, beautify: pretty }) {
    if (!text.trim()) throw new ToolError(T('error.empty'));
    if (text.length > MAX_INPUT) {
      throw new ToolError(T('error.tooBig', { size: text.length, max: MAX_INPUT }));
    }
    return mode === 'sandbox'
      ? sandboxReport(text, Number(timeout), pretty)
      : staticReport(text, pretty);
  },
});
