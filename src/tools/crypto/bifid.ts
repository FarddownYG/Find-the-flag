import { defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import {
  bifidGrid,
  blockSizes,
  fractionate,
  joinBlocks,
  trifidGrid,
  trifidSymbol,
  type Block,
  type Direction,
  type Grid,
} from './_bifid';
import { preview } from './_classical';
import { rankScore } from './_fitness';
import { squareRows, toSymbols, type SquareKind, type SymbolRun } from './_square';

const T = toolT('bifid');

/** Blocks listed in the coordinates table, and characters shown per cell. */
const BLOCK_ROWS = 100;
const CELL_CHARS = 160;
/** Longest period tried by "Find the period", and how many candidates are listed. */
const MAX_PERIOD = 60;
const CANDIDATES = 12;

type Grouping = 'none' | 'fives';

function grouped(letters: string, grouping: Grouping): string {
  return grouping === 'fives' ? (letters.match(/.{1,5}/g)?.join(' ') ?? '') : letters;
}

const note = (level: 'info' | 'warn' | 'error' | 'success', text: string): Output => ({
  type: 'note',
  level,
  text,
});

/** The grid as a table: a square with its row and column numbers, a cube layer by layer. */
function gridTable(grid: Grid): Output {
  const { side, symbols } = grid;
  const heads = Array.from({ length: side }, (_, i) => String(i + 1));
  if (grid.kind === 'bifid') {
    return {
      type: 'table',
      label: T('label.square'),
      columns: ['', ...heads],
      rows: squareRows(symbols, side).map((row, r) => [String(r + 1), ...row]),
    };
  }
  const rows: string[][] = [];
  for (let layer = 0; layer < side; layer++) {
    squareRows(symbols.slice(layer * 9, layer * 9 + 9), 3).forEach((row, r) => {
      rows.push([String(layer + 1), String(r + 1), ...row]);
    });
  }
  return {
    type: 'table',
    label: T('label.cube'),
    columns: [T('col.layer'), T('col.row'), ...heads],
    rows,
  };
}

/** Digits cut into groups of `size`: "4433353243" -> "44 33 35 32 43". */
const groupDigits = (digits: readonly number[], size: number): string => {
  const parts: string[] = [];
  for (let i = 0; i < digits.length; i += size) parts.push(digits.slice(i, i + size).join(''));
  return parts.join(' ');
};

const cut = (s: string): string => (s.length > CELL_CHARS ? `${s.slice(0, CELL_CHARS)}…` : s);

/** The coordinate lines of every block: what the cipher actually does, one row per block. */
function blocksTable(grid: Grid, blocks: readonly Block[], direction: Direction): Output[] {
  const { dims } = grid;
  const lineNames =
    dims === 2
      ? [T('col.rows'), T('col.columns')]
      : [T('col.layers'), T('col.rows'), T('col.columns')];
  const read = dims === 2 ? T('col.pairs') : T('col.triples');
  const encrypting = direction === 'encrypt';
  const shown = blocks.slice(0, BLOCK_ROWS);
  const rows = shown.map((b, i) => {
    const lines = b.lines.map((line) => cut(line.join('')));
    const stream = cut(groupDigits(b.stream, dims));
    return encrypting
      ? [i + 1, cut(b.input.join('')), ...lines, stream, cut(b.output.join(''))]
      : [i + 1, cut(b.input.join('')), stream, ...lines, cut(b.output.join(''))];
  });
  const columns = encrypting
    ? ['#', T('col.plain'), ...lineNames, read, T('col.cipher')]
    : ['#', T('col.cipher'), read, ...lineNames, T('col.plain')];
  const out: Output[] = [
    {
      type: 'table',
      label:
        blocks.length > shown.length
          ? T('label.blocksPart', { shown: shown.length, count: blocks.length })
          : T('label.blocks'),
      columns,
      rows,
    },
  ];
  const wide = blocks.some((b) => b.output.length > CELL_CHARS);
  if (wide) out.push(note('info', T('note.cut', { count: CELL_CHARS })));
  return out;
}

function skipNotes(run: Pick<SymbolRun, 'merged' | 'droppedQ' | 'droppedDigits' | 'droppedOther'>) {
  const out: Output[] = [];
  if (run.merged) out.push(note('info', T('note.merged', { count: run.merged })));
  if (run.droppedQ) out.push(note('info', T('note.droppedQ', { count: run.droppedQ })));
  if (run.droppedDigits)
    out.push(note('info', T('note.droppedDigits', { count: run.droppedDigits })));
  if (run.droppedOther) out.push(note('info', T('note.droppedOther', { count: run.droppedOther })));
  return out;
}

/** The text as symbols of the grid, with a count of what was merged or left out. */
function readSymbols(
  cipher: 'bifid' | 'trifid',
  square: SquareKind,
  extra: string,
  input: string,
): { symbols: string[]; run: SymbolRun } {
  if (cipher === 'bifid') {
    const run = toSymbols(square, input);
    return { symbols: run.symbols, run };
  }
  const symbols: string[] = [];
  let droppedDigits = 0;
  let droppedOther = 0;
  for (const ch of input) {
    const s = trifidSymbol(extra, ch);
    if (s) symbols.push(s);
    else if (ch >= '0' && ch <= '9') droppedDigits++;
    else if (!/\s/.test(ch)) droppedOther++;
  }
  return { symbols, run: { symbols, merged: 0, droppedQ: 0, droppedDigits, droppedOther } };
}

function checkExtra(extra: string): string {
  const ch = [...extra.trim()][0];
  if (!ch || /[A-Za-z]/.test(ch)) throw new ToolError(T('error.symbol'));
  return ch;
}

function checkPeriod(period: number): number {
  if (!Number.isFinite(period) || period < 0) throw new ToolError(T('error.period'));
  return Math.floor(period);
}

export default defineTool({
  id: 'bifid',
  name: 'Bifid / Trifid',
  category: 'crypto',
  description:
    "Delastelle's Bifid and Trifid ciphers with a keyed square or cube and a period: encrypt, decrypt, or find the period.",
  tags: [
    'bifid',
    'trifid',
    'delastelle',
    'fractionation',
    'fractionating',
    'polybius',
    'period',
    'keyed square',
    'cube',
    'polygraphic',
  ],
  input: 'text',
  placeholder: 'UAEOLWRINS  (key: BGWKZQPNDSIOAXEFCLUMTHYVR)',
  options: {
    cipher: toggle('Cipher', [
      { value: 'bifid', label: 'Bifid (square)' },
      { value: 'trifid', label: 'Trifid (cube)' },
    ]),
    mode: toggle('Mode', [
      { value: 'decrypt', label: 'Decrypt' },
      { value: 'encrypt', label: 'Encrypt' },
      { value: 'periods', label: 'Find the period' },
    ]),
    key: text('Key', '', {
      placeholder: 'BGWKZQPNDSIOAXEFCLUMTHYVR',
      hint: 'A keyword or a whole square (cube); its distinct symbols come first, then the rest of the alphabet.',
    }),
    square: select(
      'Square',
      [
        { value: 'ij', label: '5 × 5, I and J together' },
        { value: 'q', label: '5 × 5, without Q' },
        { value: 'digits', label: '6 × 6, letters and digits' },
      ],
      'ij',
      { showIf: (v) => v.cipher === 'bifid' },
    ),
    symbol: text('27th symbol', '+', {
      hint: 'The cube holds the 26 letters and one more symbol (+ or . are usual). It may be in the key, and in the text.',
      showIf: (v) => v.cipher === 'trifid',
    }),
    period: number('Period', 0, {
      min: 0,
      step: 1,
      hint: '0 = the whole message is one block. Otherwise the text is cut into blocks of this many letters.',
      showIf: (v) => v.mode !== 'periods',
    }),
    groups: select(
      'Output groups',
      [
        { value: 'none', label: 'Continuous' },
        { value: 'fives', label: 'Blocks of five' },
      ],
      'none',
    ),
  },
  examples: [
    {
      label: 'Wikipedia Bifid',
      input: 'UAEOLWRINS',
      options: { key: 'BGWKZQPNDSIOAXEFCLUMTHYVR' },
      expect: 'FLEEATONCE',
    },
    {
      label: 'Encrypt with period 5',
      input: 'Defend the east wall of the castle',
      options: { mode: 'encrypt', key: 'PHQGMEAYLNOFDXKRCVSZWBUTI', period: 5 },
      expect: 'FFYHMKHYCPLIASHADTRLHCCHLBLR',
    },
    {
      label: 'Trifid (Wikipedia)',
      input: 'FMJFVOISSUFTFPUFEQQC',
      options: { cipher: 'trifid', key: 'felixmariedelastelle', period: 5 },
      expect: 'AIDETOILECIELTAIDERA',
    },
    {
      label: 'Trifid with the 27th symbol',
      input: 'meet+at+the+bridge',
      options: { cipher: 'trifid', mode: 'encrypt', key: 'lighthouse', symbol: '+' },
      expect: 'ASUGKA+KMNLCNKMEME',
    },
    {
      label: 'Find the period (key known)',
      input:
        'LULRQCCOWUAIXFMOMCZVSMLGNSRRELULTQLBAESVEZPNCCCLGWMIFIYNUOCOXWIGILVKMIIICEHXFMLLNWZRUOEHPMZBUIETFPEUUTKSRIMWHNWLEINOSIPLSITQNFENNEVNKGLNUCVRMLOIZRZIOEQPVVWOBUIGWQCCROQTSANQKUWDEEDMVUOIZEYQENMLTRSR',
      options: { mode: 'periods', key: 'lighthouse' },
      expect: 'THESIGNALWASSENTATMIDNIGHT',
    },
  ],
  run(input, { cipher, mode, key, square, symbol, period, groups }) {
    const extra = cipher === 'trifid' ? checkExtra(symbol) : '+';
    const grid = cipher === 'bifid' ? bifidGrid(square, key) : trifidGrid(extra, key);
    const { symbols, run } = readSymbols(cipher, square, extra, input);
    if (!symbols.length) throw new ToolError(T('error.noSymbols'));
    const notes = skipNotes(run);

    if (mode === 'periods') {
      const lengths = new Set<number>([0]);
      for (let p = 2; p <= Math.min(MAX_PERIOD, symbols.length - 1); p++) lengths.add(p);
      const candidates = [...lengths].map((p) => {
        const text = joinBlocks(fractionate(grid, symbols, p, 'decrypt'));
        return { period: p, text, score: rankScore(text) };
      });
      candidates.sort((a, b) => b.score - a.score || a.period - b.period);
      const best = candidates[0]!;
      const top = candidates.slice(0, CANDIDATES);
      return [
        {
          type: 'text',
          label: T('label.bestPeriod', {
            period: best.period === 0 ? T('value.whole') : String(best.period),
          }),
          value: best.text,
        },
        {
          type: 'table',
          label: T('label.periods'),
          columns: [T('col.period'), T('col.score'), T('col.result')],
          rows: top.map((c) => [
            c.period === 0 ? T('value.whole') : c.period,
            c.score.toFixed(1),
            preview(c.text, 60),
          ]),
          highlight: [0],
        },
        {
          type: 'actions',
          label: T('label.usePeriod'),
          actions: [
            {
              label: T('action.usePeriod', {
                period: best.period === 0 ? T('value.whole') : String(best.period),
              }),
              options: { mode: 'decrypt', period: best.period },
              primary: true,
            },
          ],
        },
        note('info', T('note.scored')),
        ...notes,
        gridTable(grid),
      ];
    }

    const direction: Direction = mode;
    const p = checkPeriod(period);
    const blocks = fractionate(grid, symbols, p, direction);
    const out: Output[] = [
      {
        type: 'text',
        label: direction === 'encrypt' ? T('label.cipher') : T('label.plain'),
        value: grouped(joinBlocks(blocks), groups),
      },
    ];
    if (p === 1) out.push(note('warn', T('note.period1')));
    if (p > 1 && p < symbols.length && blockSizes(symbols.length, p).length > 1) {
      out.push(
        note('info', T('note.blocks', { period: p, count: blockSizes(symbols.length, p).length })),
      );
    }
    out.push(...notes, gridTable(grid), ...blocksTable(grid, blocks, direction));
    return out;
  },
});
