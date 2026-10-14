import { defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
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

/** "The "line ends" extraction gives the same program. " */
function sameText(a: Candidate): string {
  if (!a.same.length) return '';
  const names = a.same.map(q).join(' and ');
  return `The ${names} extraction${a.same.length > 1 ? 's give' : ' gives'} the same program. `;
}

const HIDDEN_ANOTHER_WAY = 'or hides it another way (other markers? S/T/L letters?)';

/** The warning of an auto run where no extraction prints text cleanly. */
function noHitNote(chosen: Attempt, attempts: Attempt[]): Output {
  const tried = attempts.map(attemptSummary).join('; ');
  const r = chosen.result;
  const text =
    r.error && printsText(chosen)
      ? `Auto: no extraction gives a program that runs without an error and prints text. The closest, ${chosen.key}, printed ${q(clip(r.output, 40))} and then stopped with an error (below): if that output looks right, the program itself fails there (does it need Input?); if not, this text probably does not hide a Whitespace program, ${HIDDEN_ANOTHER_WAY}. Tried: ${tried}.`
      : `Auto: no extraction gives a program that runs without an error and prints text, so this text probably does not hide a Whitespace program, ${HIDDEN_ANOTHER_WAY}. Tried: ${tried}. Shown below: ${chosen.key}, the closest.`;
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
    ? `prints text until the ${chosen.result.stopped === 'step-limit' ? 'step' : 'output'} limit stops it`
    : 'runs without an error and prints text';
  const tried =
    attempts.length === 1
      ? chosen.same.length
        ? ''
        : 'No other extraction finds spaces or tabs. '
      : `${attempts.length} different extractions tried${failed ? ` (${failed} stopped with an error)` : ''}; this one ${does}. `;
  out.push({
    type: 'note',
    level: 'info',
    text: `Auto: the program is in ${chosen.desc}. ${sameText(chosen)}${tried}By hand: ${chosen.how}.`,
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
      text: `Other extractions also print text: ${others.map(attemptSummary).join('; ')}. Choose one in "Program is in" to see it.`,
    });
  }
  return out;
}

/** First note of an explicit run. */
function explicitNote(chosen: Attempt, attempts: Attempt[], o: ExtractOptions): Output {
  let text = `Program read from ${chosen.desc}.`;
  if (attempts.length > 1) {
    text += ` The line break after ${q(o.start)} was tried both as layout and as code; this one ${isHit(chosen) ? 'prints text' : 'gives the most readable output'} (the other: ${attempts
      .filter((a) => a !== chosen)
      .map(attemptSummary)
      .join('; ')}).`;
  }
  return { type: 'note', level: 'info', text };
}

function errorNote(a: Attempt, auto: boolean): Output {
  const e = a.result.error!;
  const hint = a.result.output
    ? ' What it printed before is shown below.'
    : ` Nothing was printed before it: the program may not be in this extraction (try another "Program is in" choice${auto ? '' : ', or Auto'}).`;
  return {
    type: 'note',
    level: 'error',
    text: `The program stopped with an error at instruction #${e.index} (${e.op}), step ${grouped(e.step)}: ${e.message}.${hint}`,
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
      text: `The program read characters (readchar ×${grouped(r.readsAtEnd)}) but the Input option is empty, so each read gave -1 (end of input). If it waits for something, type it in Input.`,
    });
  }
  if (r.stopped === 'step-limit') {
    notes.push({
      type: 'note',
      level: 'warn',
      text: `Stopped at the step limit (${grouped(r.steps)} instructions executed): the program probably loops forever, or needs a higher limit. Output so far is shown.`,
    });
  } else if (r.stopped === 'output-limit') {
    notes.push({
      type: 'note',
      level: 'warn',
      text: `Stopped after ${grouped(r.output.length)} characters of output: the program probably prints forever.`,
    });
  } else if (r.stopped === 'fell-off') {
    notes.push({
      type: 'note',
      level: 'warn',
      text: r.partialEnd
        ? `The program ran off its last instruction without an end (LLL), into a partial instruction at the very end of the code (${r.partialEnd}), usually the final line break of the file. Everything up to there was run.`
        : 'The program ran off its last instruction without an end (LLL). Everything up to there was run; a missing end often means the extraction cut the program short.',
    });
  }
  const t = a.parsed.tail;
  if (t && r.stopped !== 'error' && !r.partialEnd) {
    notes.push({
      type: 'note',
      level: 'info',
      text: `${grouped(t.raw.length)} token(s) after the last complete instruction (#${a.parsed.instrs.length - 1}) were never reached: ${t.reason}.`,
    });
  }
  if (r.duplicateLabels.length) {
    notes.push({
      type: 'note',
      level: 'warn',
      text: `Label(s) marked more than once: ${r.duplicateLabels.map(labelText).join(', ')}. The first mark wins.`,
    });
  }
  if (r.badChars) {
    notes.push({
      type: 'note',
      level: 'warn',
      text: `${grouped(r.badChars)} outchar value(s) were not valid Unicode code points (negative, above U+10FFFF, or a surrogate) and print as �. The reference interpreter stops with an error there; this tool prints � and goes on, so that the rest of the output is not lost.`,
    });
  }
  if (a.endFound === false) {
    notes.push({
      type: 'note',
      level: 'warn',
      text: 'The end marker was not found after the start marker: the program runs to the end of the text.',
    });
  }
  return notes;
}

/** The program output block(s): what it printed, and a view with its invisible characters. */
function outputBlocks(a: Attempt): Output[] {
  const r = a.result;
  if (!r.output) {
    return r.stopped === 'error'
      ? []
      : [{ type: 'note', level: 'info', text: 'The program ran but printed nothing.' }];
  }
  const out: Output[] = [
    {
      type: 'text',
      label: r.stopped === 'error' ? 'Output before the error' : 'Program output',
      value: r.output,
    },
  ];
  const marked = markInvisible(r.output);
  if (marked.count) {
    out.push(
      {
        type: 'note',
        level: 'warn',
        text: `The output contains ${grouped(marked.count)} control or invisible character(s) (NUL, BEL...) that do not show: they are written ⟨NAME⟩ below.`,
      },
      { type: 'text', label: 'Output, invisible characters shown', value: marked.text },
    );
  }
  return out;
}

function revealBlocks(src: string, table: boolean): Output[] {
  const r = reveal(src);
  const out: Output[] = [
    {
      type: 'text',
      label: 'Revealed text (· space, → tab, ⏎ line feed, ␍ carriage return)',
      value: r.truncated ? `${r.text}\n… (truncated)` : r.text,
    },
  ];
  if (r.special.size) {
    const list = [...r.special].map(([name, n]) => `⟨${name}⟩ ×${n}`).join(', ');
    out.unshift({
      type: 'note',
      level: 'info',
      text: `Unusual invisible characters: ${list}. Whitespace ignores them (comments), but they may hide another message: try the zero-width tool.`,
    });
  }
  const lines = summarizeLines(src);
  const withText = lines.filter((l) => l.visible.trim()).length;
  const withWs = lines.filter((l) => l.trailing).length;
  if (table && lines.length >= 2 && withText >= 1 && withWs >= 1) {
    const cut = lines.length > TABLE_ROWS ? `, first ${TABLE_ROWS} shown` : '';
    out.push({
      type: 'table',
      label: `Trailing whitespace per line (${withWs} of ${lines.length} lines have some${cut})`,
      columns: ['Line', 'Visible text', 'Trailing count', 'Trailing S/T'],
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

/** "17 (S 9, T 3, L 5)", or "17 tokens (S 9, T 3, L 5)" with a unit. */
function countsText(code: string, unit = ''): string {
  const c = tokenCounts(code);
  return `${grouped(code.length)}${unit} (S ${grouped(c.s)}, T ${grouped(c.t)}, L ${grouped(c.l)})`;
}

function stats(a: Attempt): Output {
  const r = a.result;
  const entries: [string, string][] = [
    ['Extraction', a.key],
    ['Tokens', countsText(a.extraction.code)],
    ['Instructions', grouped(a.parsed.instrs.length)],
    ['Steps', grouped(r.steps)],
    ['Stack depth at end', grouped(r.stack.length)],
    ['Heap cells', grouped(r.heap.size)],
  ];
  if (r.stack.length) {
    const top = r.stack.slice(-8).reverse().map(String).join(', ');
    entries.push(['Stack (top first)', r.stack.length > 8 ? `${top}, …` : top]);
  }
  if (r.inputUsed) entries.push(['Input characters read', grouped(r.inputUsed)]);
  return { type: 'kv', label: 'Run', entries };
}

interface RunOptions extends ExtractOptions {
  input: string;
  steps: number;
}

function stepLimit(steps: number): number {
  if (!Number.isFinite(steps) || steps < 1) {
    throw new ToolError('The step limit must be a positive number.');
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
    label: 'Disassembly',
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
    const trial = `a short trial run (${grouped(LISTING_STEPS)} steps, no input)`;
    if (by === 'parse') {
      out.push({
        type: 'note',
        level: 'info',
        text: `Auto: no extraction prints text in ${trial}; the program is probably in ${chosen.desc}: it parses to the end, every label it uses is marked and it does input or output. ${sameText(chosen)}By hand: ${chosen.how}. Tried: ${attempts.map(attemptSummary).join('; ')}.`,
      });
    } else out.push(...autoNote(chosen, attempts));
    out.push({
      type: 'note',
      level: 'info',
      text: `Disassemble does not run the program; Auto only gave each extraction ${trial} to choose one.`,
    });
    if (chosen.result.error) {
      const e = chosen.result.error;
      out.push({
        type: 'note',
        level: 'warn',
        text: `Run: instruction #${e.index} (${e.op}), step ${grouped(e.step)}: ${e.message}.`,
      });
    }
  } else {
    const list = candidates(src, o).filter(hasCode);
    if (!list.length) throw new ToolError('No spaces or tabs found in this extraction.');
    view = parsedBest(list);
    out.push({ type: 'note', level: 'info', text: `Program read from ${view.desc} (not run).` });
    if (view.endFound === false) {
      out.push({
        type: 'note',
        level: 'warn',
        text: 'The end marker was not found after the start marker: the program runs to the end of the text.',
      });
    }
  }
  out.push(...revealBlocks(src, view.trailing));
  out.push({
    type: 'text',
    label: 'Disassembly',
    value: disassemble(view.parsed, view.extraction.lines),
  });
  const labels = new Set(
    view.parsed.instrs.filter((i) => i.op.name === 'label').map((i) => i.label),
  );
  out.push({
    type: 'kv',
    label: 'Program',
    entries: [
      ['Extraction', view.key],
      ['Tokens', countsText(view.extraction.code)],
      ['Instructions', grouped(view.parsed.instrs.length)],
      ['Labels', grouped(labels.size)],
      ['Parsing', view.parsed.tail ? `stops early: ${view.parsed.tail.reason}` : 'complete'],
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
  if (r.output) out.push({ type: 'text', label: 'Program output (test run)', value: r.output });
  if (r.error) {
    out.push({
      type: 'note',
      level: 'warn',
      text: `Test run stopped at instruction #${r.error.index} (${r.error.op}): ${r.error.message}.`,
    });
  } else if (r.stopped === 'step-limit') {
    out.push({ type: 'note', level: 'warn', text: 'Test run stopped at the step limit.' });
  } else if (!r.output) {
    out.push({ type: 'note', level: 'info', text: 'Test run: the program printed nothing.' });
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
        reason: `A Whitespace program in ${top.key} prints ${q(clip(printed, 40))}`,
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
        reason: 'Mostly spaces, tabs and line feeds',
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
        reason: `${ending.length} of ${lines.length} lines end in spaces/tabs (a Whitespace program may hide there)`,
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
          text: `Assembled ${grouped(parsed.instrs.length)} instructions into ${countsText(code, ' tokens')}.`,
        },
        {
          type: 'bytes',
          label: 'Whitespace program',
          value: utf8Encode(ws),
          filename: 'program.ws',
        },
        { type: 'text', label: 'Revealed program', value: reveal(ws).text },
        ...testRun({ code, lines: linesOfCode(code) }, o.input, o.steps),
        { type: 'text', label: 'Disassembly', value: disassemble(parsed) },
      ];
    }
    if (o.mode === 'generate') {
      const message = utf8Decode(bytes);
      if (!message) throw new ToolError('Type the text the program should print.');
      const { code, listing } = textToProgram(message);
      const cover = unescapeInput(o.cover);
      const hidden = cover ? hideInCover(code, cover) : null;
      const result = hidden ? hidden.text : toWhitespace(code);
      const notes: Output[] = [
        {
          type: 'note',
          level: 'success',
          text: `${grouped([...message].length)} character(s) became ${grouped(parse(code).instrs.length)} instructions, ${countsText(code, ' tokens')}.`,
        },
      ];
      if (hidden) {
        notes.push({
          type: 'note',
          level: 'info',
          text: `Hidden in the trailing whitespace of ${grouped(hidden.linesUsed)} line(s) of the cover${hidden.linesAdded ? `, and of ${grouped(hidden.linesAdded)} empty line(s) added after it because it was too short (every line feed of the program needs its own line)` : ''}${hidden.linesCleaned ? `; ${grouped(hidden.linesCleaned)} cover line(s) had their own trailing whitespace removed` : ''}. Read it back with "${EXTRACT_CHOICES.find((c) => c.value === 'trailing')!.label}".`,
        });
      }
      const extraction = hidden ? extractTrailing(result, 'count') : extractAll(result);
      return [
        ...notes,
        {
          type: 'bytes',
          label: hidden ? 'Cover text with the program' : 'Whitespace program',
          value: utf8Encode(result),
          filename: hidden ? 'hidden.txt' : 'program.ws',
        },
        {
          type: 'text',
          label: 'Revealed (· space, → tab, ⏎ line feed)',
          value: reveal(result).text,
        },
        ...testRun(extraction, '', 2 * [...message].length + 10),
        { type: 'text', label: 'Assembly', value: listing },
      ];
    }
    const decoded = decodeSource(bytes);
    const src = decoded.text;
    if (!src) throw new ToolError('Paste a Whitespace program, or open the file that hides one.');
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
        text: `The file was read as ${decoded.encoding}: ${decoded.why}.`,
      });
    }
    return out;
  },
});
