import { defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import { assemble, disassemble, hideInCover, linesOfCode, textToProgram } from './_ws-asm';
import { grouped, parse, tokenCounts, toWhitespace, type Parsed } from './_ws-core';
import {
  decodeSource,
  extractAll,
  extractTrailing,
  markInvisible,
  reveal,
  revealInline,
  summarizeLines,
  type Extraction,
} from './_ws-extract';
import {
  atLimit,
  attempt,
  attemptSummary,
  BARE_CHOICES,
  best,
  candidates,
  clip,
  EXTRACT_CHOICES,
  extractLabel,
  hasCode,
  isClean,
  isHit,
  pick,
  pickForListing,
  printsText,
  type Attempt,
  type Candidate,
  type ExtractOptions,
} from './_ws-pick';
import { execute, labelText } from './_ws-vm';

const T = toolT('whitespace-lang');

const STEP_LIMIT_MAX = 500_000_000;
const DETECT_STEPS = 20_000;
/** Disassemble + Auto: the short trial run each extraction gets, so that nothing runs for long. */
const LISTING_STEPS = 20_000;
const TABLE_ROWS = 300;

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0', '\\': '\\' };

/** The Input and marker options: \n \r \t \0 \\ \xNN \uXXXX and \u{...} stand for one character. */
export function unescapeInput(s: string): string {
  return s.replace(
    /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|([nrt0\\]))/g,
    (whole: string, x?: string, ub?: string, u4?: string, c?: string) => {
      const h = x ?? ub ?? u4;
      if (h !== undefined) {
        const cp = parseInt(h, 16);
        return cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
      }
      return ESCAPES[c!]!;
    },
  );
}

const q = (s: string) => JSON.stringify(s);
/** A sentence followed by the space that separates it from the next one ('' stays ''). */
const sentence = (s: string) => (s ? `${s} ` : '');

/** "The "line ends" extraction gives the same program. " */
function sameText(a: Candidate): string {
  if (!a.same.length) return '';
  const names = a.same.map(q).join(` ${T('text.and')} `);
  return sentence(T('text.same', { count: a.same.length, names }));
}

/** The warning of an auto run where no extraction prints text cleanly. */
function noHitNote(chosen: Attempt, attempts: Attempt[]): Output {
  const tried = attempts.map(attemptSummary).join('; ');
  const r = chosen.result;
  const text =
    r.error && printsText(chosen)
      ? T('note.noHitError', { key: chosen.key, output: q(clip(r.output, 40)), tried })
      : T('note.noHit', { key: chosen.key, tried });
  return { type: 'note', level: 'warn', text };
}

const printedLength = (a: Attempt) => [...a.result.output.trim()].length;

/**
 * Printed enough to compete with the chosen output: a fragment of 1-3 characters is what noise
 * prints by chance (unless the chosen output is that short too).
 */
const substantial = (a: Attempt, chosen: Attempt) =>
  printedLength(a) >= Math.min(4, printedLength(chosen));

/** First note of an auto run: where the program is, or that no extraction works. */
function autoNote(chosen: Attempt, attempts: Attempt[]): Output[] {
  const out: Output[] = [];
  if (!isHit(chosen)) return [noHitNote(chosen, attempts)];
  const failed = attempts.filter((a) => a.result.stopped === 'error').length;
  const does = atLimit(chosen)
    ? chosen.result.stopped === 'step-limit'
      ? T('text.doesStepLimit')
      : T('text.doesOutputLimit')
    : T('text.doesClean');
  const counts = { count: attempts.length, n: attempts.length, failed, does };
  const tried =
    attempts.length === 1
      ? chosen.same.length
        ? ''
        : sentence(T('text.noOther'))
      : sentence(failed ? T('text.triedFailed', counts) : T('text.tried', counts));
  out.push({
    type: 'note',
    level: 'info',
    text: T('note.auto', {
      desc: chosen.desc,
      same: sameText(chosen),
      tried,
      how: chosen.how,
    }),
  });
  const others = attempts.filter(
    (a) =>
      a !== chosen &&
      isHit(a) &&
      substantial(a, chosen) &&
      a.result.output !== chosen.result.output,
  );
  if (others.length) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.others', {
        list: others.map(attemptSummary).join('; '),
        option: T('options.extract.label'),
      }),
    });
  }
  return out;
}

/** First note of an explicit run. */
function explicitNote(chosen: Attempt, attempts: Attempt[], o: ExtractOptions): Output {
  let text = T('note.readFrom', { desc: chosen.desc });
  if (attempts.length > 1) {
    const both = {
      start: q(o.start),
      other: attempts
        .filter((a) => a !== chosen)
        .map(attemptSummary)
        .join('; '),
    };
    text += ` ${isHit(chosen) ? T('text.bothPrints', both) : T('text.bothReadable', both)}`;
  }
  return { type: 'note', level: 'info', text };
}

function errorNote(a: Attempt, auto: boolean): Output {
  const e = a.result.error!;
  const option = T('options.extract.label');
  const hint = a.result.output
    ? T('text.printedBefore')
    : auto
      ? T('text.nothingBefore', { option })
      : T('text.nothingBeforeOrAuto', { option });
  const at = { index: e.index, op: e.op, step: grouped(e.step), message: e.message };
  return {
    type: 'note',
    level: 'error',
    text: `${T('note.error', at)} ${hint}`,
  };
}

/** Notes about how a run ended, beyond plain success or an error. */
function runNotes(a: Attempt, input: string): Output[] {
  const r = a.result;
  const notes: Output[] = [];
  if (r.readsAtEnd && !input) {
    notes.push({
      type: 'note',
      level: 'info',
      text: T('note.readsAtEnd', {
        reads: grouped(r.readsAtEnd),
        input: T('options.input.label'),
      }),
    });
  }
  if (r.stopped === 'step-limit') {
    notes.push({
      type: 'note',
      level: 'warn',
      text: T('note.stepLimit', { steps: grouped(r.steps) }),
    });
  } else if (r.stopped === 'output-limit') {
    notes.push({
      type: 'note',
      level: 'warn',
      text: T('note.outputLimit', { length: grouped(r.output.length) }),
    });
  } else if (r.stopped === 'fell-off') {
    notes.push({
      type: 'note',
      level: 'warn',
      text: r.partialEnd ? T('note.fellOffPartial', { tokens: r.partialEnd }) : T('note.fellOff'),
    });
  }
  const t = a.parsed.tail;
  if (t && r.stopped !== 'error' && !r.partialEnd) {
    notes.push({
      type: 'note',
      level: 'info',
      text: T('note.tail', {
        count: t.raw.length,
        n: grouped(t.raw.length),
        index: a.parsed.instrs.length - 1,
        reason: t.reason,
      }),
    });
  }
  if (r.duplicateLabels.length) {
    notes.push({
      type: 'note',
      level: 'warn',
      text: T('note.duplicateLabels', {
        count: r.duplicateLabels.length,
        labels: r.duplicateLabels.map(labelText).join(', '),
      }),
    });
  }
  if (r.badChars) {
    notes.push({
      type: 'note',
      level: 'warn',
      text: T('note.badChars', { count: r.badChars, n: grouped(r.badChars) }),
    });
  }
  if (a.endFound === false) {
    notes.push({ type: 'note', level: 'warn', text: T('note.endMissing') });
  }
  return notes;
}

/** The program output block(s): what it printed, and a view with its invisible characters. */
function outputBlocks(a: Attempt): Output[] {
  const r = a.result;
  if (!r.output) {
    return r.stopped === 'error'
      ? []
      : [{ type: 'note', level: 'info', text: T('note.printedNothing') }];
  }
  const out: Output[] = [
    {
      type: 'text',
      label: r.stopped === 'error' ? T('label.outputBeforeError') : T('label.output'),
      value: r.output,
    },
  ];
  const marked = markInvisible(r.output);
  if (marked.count) {
    out.push(
      {
        type: 'note',
        level: 'warn',
        text: T('note.invisible', { count: marked.count, n: grouped(marked.count) }),
      },
      { type: 'text', label: T('label.outputMarked'), value: marked.text },
    );
  }
  return out;
}

function revealBlocks(src: string, table: boolean): Output[] {
  const r = reveal(src);
  const out: Output[] = [
    {
      type: 'text',
      label: T('label.revealed'),
      value: r.truncated ? `${r.text}\n${T('text.truncated')}` : r.text,
    },
  ];
  if (r.special.size) {
    const list = [...r.special].map(([name, n]) => `⟨${name}⟩ ×${n}`).join(', ');
    out.unshift({
      type: 'note',
      level: 'info',
      text: T('note.unusual', { list }),
    });
  }
  const lines = summarizeLines(src);
  const withText = lines.filter((l) => l.visible.trim()).length;
  const withWs = lines.filter((l) => l.trailing).length;
  if (table && lines.length >= 2 && withText >= 1 && withWs >= 1) {
    const counts = { with: withWs, total: lines.length, rows: TABLE_ROWS };
    out.push({
      type: 'table',
      label:
        lines.length > TABLE_ROWS
          ? T('label.trailingTableCut', counts)
          : T('label.trailingTable', counts),
      columns: [T('col.line'), T('col.visible'), T('col.trailingCount'), T('col.trailingLetters')],
      rows: lines
        .slice(0, TABLE_ROWS)
        .map((l) => [
          l.line,
          clip(revealInline(l.visible), 48),
          l.trailing.length,
          clip(l.trailing, 32),
        ]),
    });
  }
  return out;
}

/** "17 (S 9, T 3, L 5)", or "17 tokens (S 9, T 3, L 5)" with the unit. */
function countsText(code: string, unit = false): string {
  const c = tokenCounts(code);
  const parts = { n: grouped(code.length), s: grouped(c.s), t: grouped(c.t), l: grouped(c.l) };
  return unit
    ? T('text.tokens', { count: code.length, ...parts })
    : `${parts.n} (S ${parts.s}, T ${parts.t}, L ${parts.l})`;
}

function stats(a: Attempt): Output {
  const r = a.result;
  const entries: [string, string][] = [
    [T('kv.extraction'), a.key],
    [T('kv.tokens'), countsText(a.extraction.code)],
    [T('kv.instructions'), grouped(a.parsed.instrs.length)],
    [T('kv.steps'), grouped(r.steps)],
    [T('kv.stackDepth'), grouped(r.stack.length)],
    [T('kv.heap'), grouped(r.heap.size)],
  ];
  if (r.stack.length) {
    const top = r.stack.slice(-8).reverse().map(String).join(', ');
    entries.push([T('kv.stack'), r.stack.length > 8 ? `${top}, …` : top]);
  }
  if (r.inputUsed) entries.push([T('kv.inputRead'), grouped(r.inputUsed)]);
  return { type: 'kv', label: T('label.run'), entries };
}

interface RunOptions extends ExtractOptions {
  input: string;
  steps: number;
}

function stepLimit(steps: number): number {
  if (!Number.isFinite(steps) || steps < 1) {
    throw new ToolError(T('error.stepLimit'));
  }
  return Math.min(Math.floor(steps), STEP_LIMIT_MAX);
}

function runProgram(src: string, o: RunOptions): Output[] {
  const { chosen, attempts } = pick(src, o, unescapeInput(o.input), stepLimit(o.steps));
  const out: Output[] =
    o.extract === 'auto' ? autoNote(chosen, attempts) : [explicitNote(chosen, attempts, o)];
  if (chosen.result.error) out.push(errorNote(chosen, o.extract === 'auto'));
  out.push(...runNotes(chosen, o.input), ...outputBlocks(chosen));
  out.push({
    type: 'text',
    label: T('label.disassembly'),
    value: disassemble(chosen.parsed, chosen.extraction.lines),
  });
  out.push(...revealBlocks(src, chosen.trailing || !isHit(chosen)));
  out.push(stats(chosen));
  return out;
}

/** Explicit Disassemble mode does not run: of two marker variants, show the one that parses. */
function parsedBest(list: Candidate[]): Candidate & { parsed: Parsed } {
  const parsed = list.map((c) => ({ ...c, parsed: parse(c.extraction.code) }));
  return parsed.find((c) => !c.parsed.tail) ?? parsed[0]!;
}

function disassembleOnly(src: string, o: RunOptions): Output[] {
  const out: Output[] = [];
  let view: Candidate & { parsed: Parsed };
  if (o.extract === 'auto') {
    const { chosen, attempts, by } = pickForListing(src, o, LISTING_STEPS);
    view = chosen;
    const trial = T('text.trial', { steps: grouped(LISTING_STEPS) });
    if (by === 'parse') {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.autoParse', {
          trial,
          desc: chosen.desc,
          same: sameText(chosen),
          how: chosen.how,
          tried: attempts.map(attemptSummary).join('; '),
        }),
      });
    } else out.push(...autoNote(chosen, attempts));
    out.push({ type: 'note', level: 'info', text: T('note.disasmTrial', { trial }) });
    if (chosen.result.error) {
      const e = chosen.result.error;
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.disasmError', {
          index: e.index,
          op: e.op,
          step: grouped(e.step),
          message: e.message,
        }),
      });
    }
  } else {
    const list = candidates(src, o).filter(hasCode);
    if (!list.length) throw new ToolError(T('error.noCodeExtraction'));
    view = parsedBest(list);
    out.push({ type: 'note', level: 'info', text: T('note.readFromNotRun', { desc: view.desc }) });
    if (view.endFound === false) {
      out.push({ type: 'note', level: 'warn', text: T('note.endMissing') });
    }
  }
  out.push(...revealBlocks(src, view.trailing));
  out.push({
    type: 'text',
    label: T('label.disassembly'),
    value: disassemble(view.parsed, view.extraction.lines),
  });
  const labels = new Set(
    view.parsed.instrs.filter((i) => i.op.name === 'label').map((i) => i.label),
  );
  out.push({
    type: 'kv',
    label: T('label.program'),
    entries: [
      [T('kv.extraction'), view.key],
      [T('kv.tokens'), countsText(view.extraction.code)],
      [T('kv.instructions'), grouped(view.parsed.instrs.length)],
      [T('kv.labels'), grouped(labels.size)],
      [
        T('kv.parsing'),
        view.parsed.tail
          ? T('value.stopsEarly', { reason: view.parsed.tail.reason })
          : T('value.complete'),
      ],
    ],
  });
  return out;
}

/** Run a freshly made program to prove it works; problems are reported as notes. */
function testRun(extraction: Extraction, input: string, steps: number): Output[] {
  const r = execute(parse(extraction.code), {
    input: unescapeInput(input),
    stepLimit: Math.min(Math.max(1, Math.floor(steps) || 1), STEP_LIMIT_MAX),
  });
  const out: Output[] = [];
  if (r.output) out.push({ type: 'text', label: T('label.testOutput'), value: r.output });
  if (r.error) {
    const { index, op, message } = r.error;
    out.push({ type: 'note', level: 'warn', text: T('note.testError', { index, op, message }) });
  } else if (r.stopped === 'step-limit') {
    out.push({ type: 'note', level: 'warn', text: T('note.testStepLimit') });
  } else if (!r.output) {
    out.push({ type: 'note', level: 'info', text: T('note.testNothing') });
  }
  return out;
}

const runs = (v: Record<string, unknown>) => v.mode === 'run' || v.mode === 'disasm';
const runsCode = (v: Record<string, unknown>) => v.mode === 'run' || v.mode === 'assemble';

export default defineTool({
  id: 'whitespace-lang',
  name: 'Whitespace (esolang)',
  category: 'misc',
  description:
    'Reveal spaces, tabs and invisible characters, pull a Whitespace program out of a cover text (all whitespace, line ends, between markers, or S/T/L letters), run it and disassemble it. Also assembles mnemonics and turns text into a program.',
  tags: [
    'whitespace',
    'whitespace language',
    'esolang',
    'esoteric',
    'interpreter',
    'spaces tabs',
    'trailing whitespace',
    'invisible',
    'reveal whitespace',
    'disassembler',
    'assembler',
    'wspace',
  ],
  input: 'bytes',
  placeholder:
    'Paste a Whitespace program or the text that hides one (a poem whose lines end in spaces and tabs...)',
  options: {
    mode: toggle(
      'Mode',
      [
        { value: 'run', label: 'Run' },
        { value: 'disasm', label: 'Disassemble' },
        { value: 'assemble', label: 'Assemble' },
        { value: 'generate', label: 'Text → Whitespace' },
      ],
      'run',
      {
        hint: `Run executes the program and also shows its disassembly. Disassemble only lists the instructions, without running them (for a program that waits for input or never stops); with Auto, each extraction gets a ${grouped(LISTING_STEPS)}-step trial run without input to choose one.`,
      },
    ),
    extract: select('Program is in', EXTRACT_CHOICES, 'auto', {
      hint: 'Auto runs every extraction (between the markers if they appear, line ends, S/T/L letters, all whitespace) and keeps the one that runs cleanly and prints text.',
      showIf: runs,
    }),
    bareLines: select('Lines without trailing spaces/tabs', BARE_CHOICES, 'count', {
      hint: 'A title or blank lines before the coded stanza: "Count from the first coded line". Lines between coded ones that carry no code: "Skip".',
      showIf: (v) => runs(v) && (v.extract === 'trailing' || v.extract === 'markers-trailing'),
    }),
    start: text('Start marker', 'BEGIN', {
      hint: 'Case-sensitive; \\n and other escapes work. Empty = from the beginning. An occurrence inside a longer word (BEGINNER) is passed over. Auto mode tries these markers too; a marker alone on its line is handled.',
      showIf: (v) =>
        runs(v) &&
        (v.extract === 'auto' || v.extract === 'markers' || v.extract === 'markers-trailing'),
    }),
    end: text('End marker', 'END', {
      hint: 'First occurrence after the start marker that is not inside a longer word (LEGEND). Empty = to the end.',
      showIf: (v) =>
        runs(v) &&
        (v.extract === 'auto' || v.extract === 'markers' || v.extract === 'markers-trailing'),
    }),
    input: text('Input', '', {
      placeholder: '42\\nhello',
      hint: 'Read by readchar (one character, -1 at the end) and readnum (one line). \\n, \\t, \\xNN and \\u{...} escapes work.',
      showIf: runsCode,
    }),
    steps: number('Step limit', 5_000_000, {
      min: 1,
      max: STEP_LIMIT_MAX,
      step: 1_000_000,
      hint: 'Stops infinite loops; the output printed so far is still shown.',
      showIf: runsCode,
    }),
    cover: text('Cover text', '', {
      placeholder: 'Roses are red\\nViolets are blue',
      hint: 'Hide the program in the trailing whitespace of these lines (\\n separates lines; empty lines are added if it is too short). Empty = a bare program.',
      showIf: (v) => v.mode === 'generate',
    }),
  },
  examples: [
    { label: 'FTF program', input: { sample: 'esolang-ftf.ws' }, expect: 'FTF' },
    { label: 'Hidden in a poem', input: { sample: 'esolang-ftf-poem.txt' }, expect: 'FTF' },
    {
      label: 'Interleaved with text',
      input: { sample: 'esolang-ftf-interleaved.txt' },
      expect: 'FTF',
    },
    {
      label: 'Between markers',
      input: { sample: 'esolang-ftf-markers.txt' },
      options: { extract: 'markers', start: 'BEGIN', end: 'END' },
      expect: 'FTF',
    },
    {
      label: 'S/T/L letters',
      input: 'SSSTSSSTTSL TLSS SSSTSTSTSSL TLSS SSSTSSSTTSL TLSS LLL',
      expect: 'FTF',
    },
    {
      label: 'Disassemble the poem',
      input: { sample: 'esolang-ftf-poem.txt' },
      options: { mode: 'disasm', extract: 'trailing' },
      expect: 'call TS',
    },
    {
      label: 'Assemble',
      input:
        "push 'F'\noutchar\npush 84  ; 'T'\noutchar\npush 0x46\noutchar\npush 10\noutchar\nend",
      options: { mode: 'assemble' },
      expect: 'FTF',
    },
    {
      label: 'Text → Whitespace',
      input: 'FTF',
      options: { mode: 'generate' },
      expect: '···→···→→·⏎',
    },
  ],
  detect({ text: sample, bytes }) {
    const src = decodeSource(bytes.subarray(0, 1 << 18)).text;
    // Run every extraction briefly: a program that runs cleanly and prints text is near certain.
    const list = candidates(src, {
      extract: 'auto',
      bareLines: 'count',
      start: 'BEGIN',
      end: 'END',
    }).filter(hasCode);
    const hits = list.map((c) => attempt(c, '', DETECT_STEPS)).filter(isHit);
    if (hits.length) {
      const top = best(hits);
      const printed = top.result.output.trim();
      return {
        score: isClean(top) && [...printed].length >= 2 ? 0.9 : 0.6,
        options: { mode: 'run', extract: 'auto' },
        reason: T('detect.program', { key: top.key, output: q(clip(printed, 40)) }),
      };
    }
    const n = Math.min(bytes.length, 1 << 20);
    let s = 0;
    let t = 0;
    let l = 0;
    let cr = 0;
    for (let i = 0; i < n; i++) {
      const b = bytes[i];
      if (b === 0x20) s++;
      else if (b === 0x09) t++;
      else if (b === 0x0a) l++;
      else if (b === 0x0d) cr++;
    }
    if (s + t + l >= 20 && s && t && l && (s + t + l + cr) / n >= 0.6) {
      return {
        score: 0.8,
        options: { mode: 'run', extract: 'auto' },
        reason: T('detect.blank'),
      };
    }
    if (!sample) return null;
    const lines = summarizeLines(sample.slice(0, 1 << 20)).filter((x) => x.visible.trim());
    const ending = lines.filter((x) => x.trailing);
    if (
      ending.length >= 4 &&
      ending.length / lines.length >= 0.3 &&
      ending.some((x) => x.trailing.includes('T'))
    ) {
      return {
        score: 0.55,
        options: { mode: 'run', extract: 'auto' },
        reason: T('detect.lineEnds', { ending: ending.length, lines: lines.length }),
      };
    }
    return null;
  },
  run({ bytes }, o) {
    if (o.mode === 'assemble') {
      const code = assemble(utf8Decode(bytes));
      const ws = toWhitespace(code);
      const parsed = parse(code);
      return [
        {
          type: 'note',
          level: 'success',
          text: T('note.assembled', {
            instructions: grouped(parsed.instrs.length),
            tokens: countsText(code, true),
          }),
        },
        {
          type: 'bytes',
          label: T('label.wsProgram'),
          value: utf8Encode(ws),
          filename: 'program.ws',
        },
        { type: 'text', label: T('label.revealedProgram'), value: reveal(ws).text },
        ...testRun({ code, lines: linesOfCode(code) }, o.input, o.steps),
        { type: 'text', label: T('label.disassembly'), value: disassemble(parsed) },
      ];
    }
    if (o.mode === 'generate') {
      const message = utf8Decode(bytes);
      if (!message) throw new ToolError(T('error.generateEmpty'));
      const { code, listing } = textToProgram(message);
      const cover = unescapeInput(o.cover);
      const hidden = cover ? hideInCover(code, cover) : null;
      const result = hidden ? hidden.text : toWhitespace(code);
      const notes: Output[] = [
        {
          type: 'note',
          level: 'success',
          text: T('note.generated', {
            count: [...message].length,
            characters: grouped([...message].length),
            instructions: grouped(parse(code).instrs.length),
            tokens: countsText(code, true),
          }),
        },
      ];
      if (hidden) {
        const { linesUsed, linesAdded, linesCleaned } = hidden;
        notes.push({
          type: 'note',
          level: 'info',
          text: T('note.hidden', {
            lines: T('text.coverLines', { count: linesUsed, n: grouped(linesUsed) }),
            added: linesAdded
              ? T('text.coverAdded', { count: linesAdded, n: grouped(linesAdded) })
              : '',
            cleaned: linesCleaned
              ? T('text.coverCleaned', { count: linesCleaned, n: grouped(linesCleaned) })
              : '',
            choice: extractLabel('trailing'),
          }),
        });
      }
      const extraction = hidden ? extractTrailing(result, 'count') : extractAll(result);
      return [
        ...notes,
        {
          type: 'bytes',
          label: hidden ? T('label.coverWithProgram') : T('label.wsProgram'),
          value: utf8Encode(result),
          filename: hidden ? 'hidden.txt' : 'program.ws',
        },
        {
          type: 'text',
          label: T('label.revealedShort'),
          value: reveal(result).text,
        },
        ...testRun(extraction, '', 2 * [...message].length + 10),
        { type: 'text', label: T('label.assembly'), value: listing },
      ];
    }
    const decoded = decodeSource(bytes);
    const src = decoded.text;
    if (!src) throw new ToolError(T('error.emptyInput'));
    const opts: RunOptions = {
      ...o,
      start: unescapeInput(o.start),
      end: unescapeInput(o.end),
    };
    const out = o.mode === 'disasm' ? disassembleOnly(src, opts) : runProgram(src, opts);
    if (decoded.why) {
      out.unshift({
        type: 'note',
        level: 'info',
        text: T('note.encoding', { encoding: decoded.encoding, why: decoded.why }),
      });
    }
    return out;
  },
});
