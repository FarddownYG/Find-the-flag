import { bool, defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { flagForm, preview } from './_classical';
import { rankScore as rankText } from './_fitness';
import {
  allRoutes,
  columnarPermutation,
  EXHAUSTIVE_MAX,
  gridRows,
  identityKey,
  orderToDigits,
  orderToLetters,
  parseColumnKey,
  permute,
  routePermutation,
  solveColumnar,
  unpermute,
  type ColumnKey,
  type Corner,
  type Route,
  type RouteFamily,
} from './_transposition';

const T = toolT('columnar');

type Method = 'columnar' | 'double' | 'myszkowski' | 'route' | 'scytale';
type Mode = 'solve' | 'decrypt' | 'encrypt';
type Chars = 'nospace' | 'letters' | 'all';

interface Settings {
  method: Method;
  mode: Mode;
  key: string;
  key2: string;
  grid: 'incomplete' | 'complete';
  pad: string;
  route: RouteFamily;
  corner: Corner;
  spin: 'cw' | 'ccw';
  way: 'in' | 'out';
  width: number;
  rows: number;
  columns: number;
  inverse: boolean;
  chars: Chars;
  group: boolean;
  maxKey: number;
}

const KEY_METHODS: readonly Method[] = ['columnar', 'double', 'myszkowski'];
const MIN_LETTERS = 20;
/** Keys this close (average log10 per quadgram) to the best are shown as alternatives. */
const SIBLING_GAP = 0.02;
/** Long candidates are ranked on their first letters only: the score needs no more. */
const SCORE_SAMPLE = 4000;
const rankScore = (plain: string): number =>
  rankText(plain.length > SCORE_SAMPLE ? plain.slice(0, SCORE_SAMPLE) : plain);

/** Display caps: a long text never turns into a page-sized table. */
const MAX_ROWS = 40;
const MAX_COLS = 40;

/** The characters the grid is made of. */
export function toCells(input: string, chars: Chars): string[] {
  const out: string[] = [];
  for (const ch of input) {
    if (chars === 'all') {
      if (ch === ' ' || !/\s/.test(ch)) out.push(ch);
    } else if (chars === 'letters') {
      if (/[\p{L}\p{N}]/u.test(ch)) out.push(ch);
    } else if (!/\s/.test(ch)) out.push(ch);
  }
  return out;
}

function padCells(cells: string[], width: number, pad: string): string[] {
  const missing = (width - (cells.length % width)) % width;
  return missing ? [...cells, ...Array.from({ length: missing }, () => pad)] : cells;
}

function groupFives(s: string): string {
  return s.replace(/(.{5})(?=.)/gu, '$1 ');
}

// ----------------------------------------------------------------------- routes

const routeOf = (o: Pick<Settings, 'route' | 'corner' | 'spin' | 'way'>): Route => ({
  family: o.route,
  corner: o.corner,
  clockwise: o.spin === 'cw',
  outward: o.way === 'out',
});

function routeLabel(r: Route): string {
  const corner = T(`route.corner.${r.corner}`);
  const dir = T(r.clockwise ? 'route.dir.cw' : 'route.dir.ccw');
  switch (r.family) {
    case 'spiral':
      return T(r.outward ? 'route.spiralOut' : 'route.spiralIn', { corner, dir });
    case 'snake-rows':
      return T('route.snakeRows', { corner });
    case 'snake-columns':
      return T('route.snakeColumns', { corner });
    case 'rows':
      return T('route.rows', { corner });
    case 'columns':
      return T('route.columns', { corner });
  }
}

/** Option values that select a route (for the "use this" buttons). */
const routeOptions = (r: Route): Record<string, unknown> => ({
  route: r.family,
  corner: r.corner,
  spin: r.clockwise ? 'cw' : 'ccw',
  way: r.outward ? 'out' : 'in',
});

// ------------------------------------------------------------------ transposing

interface Step {
  perm: Uint32Array;
  /** Shown above the grid of this step. */
  kind: 'key' | 'route' | 'scytale';
  key?: ColumnKey;
  myszkowski?: boolean;
  width: number;
  route?: Route;
}

function keyGrid(grid: string[], step: Step, label: string): Output[] {
  const key = step.key!;
  const width = key.symbols.length;
  const shown = Math.min(width, MAX_COLS);
  const { rows, total } = gridRows(grid, width, MAX_ROWS);
  const ranks = step.myszkowski ? key.groupRank : key.rank;
  const out: Output[] = [
    {
      type: 'table',
      label,
      columns: ['', ...key.symbols.slice(0, shown)],
      rows: [
        ['#', ...ranks.slice(0, shown).map(String)],
        ...rows.map((r, i) => [String(i + 1), ...r.slice(0, shown)]),
      ].map((r) => [...r, ...Array.from({ length: shown + 1 - r.length }, () => '')]),
    },
  ];
  if (total > MAX_ROWS || width > MAX_COLS) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.truncated', { rows: Math.min(total, MAX_ROWS), cols: shown }),
    });
  }
  return out;
}

function routeGrids(grid: string[], step: Step, labels: { cells: string; order: string }) {
  const width = step.width;
  const { rows, total } = gridRows(grid, width, MAX_ROWS);
  const shown = Math.min(width, MAX_COLS);
  const header = ['', ...Array.from({ length: shown }, (_, i) => String(i + 1))];
  const pad = (r: (string | number)[]) => [
    ...r,
    ...Array.from({ length: shown + 1 - r.length }, () => ''),
  ];
  // Position of every cell in the reading order.
  const position = new Array<number>(grid.length);
  step.perm.forEach((cell, k) => {
    position[cell] = k + 1;
  });
  const out: Output[] = [
    {
      type: 'table',
      label: labels.cells,
      columns: header,
      rows: rows.map((r, i) => pad([String(i + 1), ...r.slice(0, shown)])),
    },
    {
      type: 'table',
      label: labels.order,
      columns: header,
      rows: Array.from({ length: rows.length }, (_, i) =>
        pad([
          String(i + 1),
          ...Array.from({ length: Math.min(width, grid.length - i * width, shown) }, (_, c) =>
            String(position[i * width + c]),
          ),
        ]),
      ),
    },
  ];
  if (total > MAX_ROWS || width > MAX_COLS) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.truncated', { rows: Math.min(total, MAX_ROWS), cols: shown }),
    });
  }
  return out;
}

function transpose(cells: string[], o: Settings): Output[] {
  const encrypt = o.mode === 'encrypt';
  const complete = o.grid === 'complete';
  const pad = [...o.pad][0] ?? 'X';
  const notes: Output[] = [];

  // The keys, in the order the cipher applies them when encrypting.
  const keys: { key: ColumnKey; myszkowski: boolean }[] = [];
  if (KEY_METHODS.includes(o.method)) {
    const first = parseColumnKey(o.key);
    if (o.method === 'double') {
      const second = o.key2.trim() ? parseColumnKey(o.key2) : first;
      if (!o.key2.trim()) notes.push({ type: 'note', level: 'info', text: T('note.sameKey') });
      keys.push({ key: first, myszkowski: false }, { key: second, myszkowski: false });
    } else {
      keys.push({ key: first, myszkowski: o.method === 'myszkowski' });
    }
  }

  const stepFor = (length: number, index: number): Step => {
    if (o.method === 'route') {
      if (!Number.isInteger(o.width) || o.width < 2) throw new ToolError(T('error.width'));
      const route = routeOf(o);
      return {
        perm: routePermutation(length, o.width, route),
        kind: 'route',
        width: o.width,
        route,
      };
    }
    if (o.method === 'scytale') {
      let columns = Math.floor(o.columns);
      if (!(columns >= 2)) {
        if (!(o.rows >= 2)) throw new ToolError(T('error.rows'));
        columns = Math.ceil(length / Math.floor(o.rows));
      }
      const key = identityKey(Math.max(1, columns));
      return { perm: columnarPermutation(length, key), kind: 'scytale', key, width: columns };
    }
    const { key, myszkowski } = keys[index]!;
    return {
      perm: columnarPermutation(length, key, myszkowski),
      kind: 'key',
      key,
      myszkowski,
      width: key.symbols.length,
    };
  };

  const count = keys.length > 1 ? keys.length : 1;
  const sequence = Array.from({ length: count }, (_, i) => (encrypt ? i : count - 1 - i));
  const grids: Output[] = [];
  let current = cells;
  let middle: string[] | null = null;
  let padded = 0;
  for (const [position, index] of sequence.entries()) {
    let step = stepFor(current.length, index);
    if (complete && step.kind === 'key') {
      if (encrypt) {
        const before = current.length;
        current = padCells(current, step.width, pad);
        padded += current.length - before;
        step = stepFor(current.length, index);
      } else if (current.length % step.width) {
        throw new ToolError(
          T('error.notComplete', { length: current.length, columns: step.width }),
        );
      }
    }
    // Forward: out[k] = in[perm[k]]. The side written row by row is the input, else the output.
    const forward = encrypt !== o.inverse;
    const out = forward ? permute(current, step.perm) : unpermute(current, step.perm);
    const written = forward ? current : out;
    if (step.kind === 'route') {
      grids.push(
        ...routeGrids(written, step, {
          cells: T(o.inverse ? 'label.routeGridCipher' : 'label.routeGridPlain'),
          order: T('label.readingOrder', { route: routeLabel(step.route!) }),
        }),
      );
    } else {
      const label =
        count > 1
          ? T('label.gridStep', { step: position + 1 })
          : T(o.inverse ? 'label.gridCipher' : 'label.gridPlain');
      grids.push(...keyGrid(written, step, label));
    }
    if (position === 0 && count > 1) middle = out;
    current = out;
  }

  const result = current.join('');
  const blocks: Output[] = [
    { type: 'text', value: encrypt && o.group ? groupFives(result) : result },
  ];
  if (!encrypt) {
    const flag = /[{}]/.test(result) ? null : flagForm(result);
    if (flag) blocks.push({ type: 'text', label: T('label.flag'), value: flag });
  }
  if (middle) blocks.push({ type: 'text', label: T('label.middle'), value: middle.join('') });
  if (padded) {
    notes.push({ type: 'note', level: 'info', text: T('note.padded', { padded, pad }) });
  }
  if (o.method === 'route' && current.length % o.width) {
    notes.push({
      type: 'note',
      level: 'info',
      text: T('note.routeIncomplete', { last: current.length % o.width, columns: o.width }),
    });
  }
  return [...blocks, ...grids, ...notes];
}

// ------------------------------------------------------------------------ solving

interface Ranked {
  plain: string;
  score: number;
}

function reliableNote(best: number, letters: number): Output {
  return best > 55 && letters >= MIN_LETTERS
    ? { type: 'note', level: 'success', text: T('note.readable') }
    : { type: 'note', level: 'warn', text: T('note.notReadable') };
}

function solveKey(cells: string[], o: Settings): Output[] {
  const maxKey = Math.max(2, Math.min(24, Math.floor(o.maxKey)));
  const sol = solveColumnar(cells, { maxLength: maxKey });
  if (sol.letters < MIN_LETTERS) {
    throw new ToolError(T('error.tooShort', { letters: sol.letters, min: MIN_LETTERS }));
  }
  const best = sol.candidates[0];
  if (!best) throw new ToolError(T('error.noCandidate'));
  // The winning length with the keys that score almost as well (an incomplete grid has look-alikes
  // that put the first letters of the message at the end), then the best key of each other length.
  const siblings = sol.candidates.filter(
    (c) => c.length === best.length && c.fitness >= best.fitness - SIBLING_GAP,
  );
  const seenLengths = new Set<number>();
  const top = sol.candidates
    .filter((c) => {
      if (siblings.includes(c)) return true;
      if (seenLengths.has(c.length) || c.length === best.length) return false;
      seenLengths.add(c.length);
      return true;
    })
    .slice(0, 14);
  const digits = orderToDigits(best.order);
  const out: Output[] = [
    {
      type: 'text',
      label: T('label.best', { columns: best.length, key: digits }),
      value: best.plain,
    },
    {
      type: 'actions',
      actions: [
        {
          label: T('action.decrypt', { key: digits }),
          options: { method: 'columnar', mode: 'decrypt', key: digits, grid: 'incomplete' },
          primary: true,
        },
        ...siblings.slice(1, 4).map((c) => ({
          label: T('action.sibling', { start: c.plain.slice(0, 14) }),
          options: {
            method: 'columnar',
            mode: 'decrypt',
            key: orderToDigits(c.order),
            grid: 'incomplete',
          },
        })),
      ],
    },
    {
      type: 'table',
      label: T('label.keys'),
      columns: [T('col.columns'), T('col.key'), T('col.word'), T('col.fit'), T('col.text')],
      rows: top.map((c) => [
        c.length,
        orderToDigits(c.order),
        orderToLetters(c.order) ?? '',
        c.fitness.toFixed(3),
        preview(c.plain, 64),
      ]),
      highlight: [0],
    },
  ];
  if (siblings.length > 1) out.push({ type: 'note', level: 'info', text: T('note.siblings') });
  out.push(reliableNote(rankScore(best.plain), sol.letters));
  out.push({
    type: 'note',
    level: 'info',
    text:
      sol.reached < 2
        ? T('note.nothingSearched')
        : sol.reached > EXHAUSTIVE_MAX
          ? T('note.searchedClimb', { exhaustive: EXHAUSTIVE_MAX, max: sol.reached })
          : T('note.searched', { max: sol.reached }),
  });
  if (sol.stopped) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.stopped', { reached: sol.reached || 1 }),
    });
  }
  out.push({ type: 'note', level: 'info', text: T('note.standardOnly') });
  return out;
}

/** Widths worth trying: the divisors of the length (full grid), else every width. */
function candidateWidths(length: number): number[] {
  const divisors: number[] = [];
  for (let w = 2; w <= Math.min(length / 2, 400); w++) if (length % w === 0) divisors.push(w);
  if (divisors.length) return divisors;
  return Array.from({ length: Math.max(0, Math.min(length - 1, 60) - 1) }, (_, i) => i + 2);
}

function solveRoute(cells: string[], o: Settings): Output[] {
  if (cells.length < 6) throw new ToolError(T('error.tooShort', { letters: cells.length, min: 6 }));
  const widths = o.width >= 2 ? [Math.floor(o.width)] : candidateWidths(cells.length);
  const rows: (Ranked & { route: Route; width: number; inverse: boolean })[] = [];
  const seen = new Set<string>();
  for (const width of widths) {
    for (const route of allRoutes()) {
      const perm = routePermutation(cells.length, width, route);
      for (const inverse of [false, true]) {
        const plain = (inverse ? permute(cells, perm) : unpermute(cells, perm)).join('');
        if (seen.has(plain)) continue;
        seen.add(plain);
        rows.push({ plain, score: rankScore(plain), route, width, inverse });
      }
    }
  }
  rows.sort((a, b) => b.score - a.score || a.width - b.width);
  const best = rows[0]!;
  return [
    {
      type: 'text',
      label: T('label.bestRoute', { route: routeLabel(best.route), width: best.width }),
      value: best.plain,
    },
    {
      type: 'actions',
      actions: [
        {
          label: T('action.useRoute'),
          options: {
            method: 'route',
            mode: 'decrypt',
            width: best.width,
            inverse: best.inverse,
            ...routeOptions(best.route),
          },
          primary: true,
        },
      ],
    },
    {
      type: 'table',
      label: T('label.routes', { total: rows.length }),
      columns: [T('col.score'), T('col.width'), T('col.direction'), T('col.route'), T('col.text')],
      rows: rows
        .slice(0, 15)
        .map((r) => [
          r.score.toFixed(1),
          r.width,
          T(r.inverse ? 'dir.reversed' : 'dir.standard'),
          routeLabel(r.route),
          preview(r.plain, 64),
        ]),
      highlight: [0],
    },
    reliableNote(best.score, cells.length),
    {
      type: 'note',
      level: 'info',
      text:
        o.width >= 2
          ? T('note.widthGiven', { width: Math.floor(o.width) })
          : T('note.widthsTried', { length: cells.length }),
    },
  ];
}

function solveScytale(cells: string[]): Output[] {
  if (cells.length < 6) throw new ToolError(T('error.tooShort', { letters: cells.length, min: 6 }));
  const rows: (Ranked & { columns: number; rows: number })[] = [];
  const seen = new Set<string>();
  const maxColumns = Math.min(Math.floor(cells.length / 2), 200);
  for (let columns = 2; columns <= maxColumns; columns++) {
    const plain = unpermute(cells, columnarPermutation(cells.length, identityKey(columns))).join(
      '',
    );
    if (seen.has(plain)) continue;
    seen.add(plain);
    rows.push({ plain, score: rankScore(plain), columns, rows: Math.ceil(cells.length / columns) });
  }
  rows.sort((a, b) => b.score - a.score || a.columns - b.columns);
  const best = rows[0]!;
  return [
    {
      type: 'text',
      label: T('label.bestScytale', { rows: best.rows, columns: best.columns }),
      value: best.plain,
    },
    {
      type: 'actions',
      actions: [
        {
          label: T('action.useScytale'),
          options: { method: 'scytale', mode: 'decrypt', rows: best.rows, columns: best.columns },
          primary: true,
        },
      ],
    },
    {
      type: 'table',
      label: T('label.scytales', { total: rows.length }),
      columns: [T('col.rows'), T('col.columns'), T('col.score'), T('col.text')],
      rows: rows
        .slice(0, 15)
        .map((r) => [r.rows, r.columns, r.score.toFixed(1), preview(r.plain, 64)]),
      highlight: [0],
    },
    reliableNote(best.score, cells.length),
  ];
}

export default defineTool({
  id: 'columnar',
  name: 'Columnar transposition',
  category: 'crypto',
  description:
    'Columnar, double columnar, Myszkowski, route / spiral and scytale transpositions: encrypt, decrypt, or solve a columnar cipher without its key (English).',
  tags: [
    'transposition',
    'columnar',
    'column transposition',
    'double transposition',
    'myszkowski',
    'route cipher',
    'spiral',
    'scytale',
    'skytale',
    'key order',
    'permutation',
    'grid',
    'anagram',
  ],
  input: 'text',
  placeholder: 'EVLNEACDTKESEAQROFOJDEECUWIREE',
  options: {
    method: select(
      'Method',
      [
        { value: 'columnar', label: 'Columnar' },
        { value: 'double', label: 'Double columnar' },
        { value: 'myszkowski', label: 'Myszkowski' },
        { value: 'route', label: 'Route / spiral' },
        { value: 'scytale', label: 'Scytale' },
      ],
      'columnar',
    ),
    mode: toggle(
      'Mode',
      [
        { value: 'solve', label: 'Solve (no key)' },
        { value: 'decrypt', label: 'Decrypt' },
        { value: 'encrypt', label: 'Encrypt' },
      ],
      'solve',
    ),
    key: text('Key', '', {
      placeholder: 'ZEBRAS   or   3 1 4 2',
      hint: 'A word (A before B, repeated letters read left to right) or the reading order of the columns',
      showIf: (v) => KEY_METHODS.includes(v.method as Method) && v.mode !== 'solve',
    }),
    key2: text('Second key', '', {
      placeholder: 'empty = same as the first key',
      showIf: (v) => v.method === 'double' && v.mode !== 'solve',
    }),
    grid: toggle(
      'Grid',
      [
        { value: 'incomplete', label: 'Incomplete (as is)' },
        { value: 'complete', label: 'Complete (padded)' },
      ],
      undefined,
      {
        hint: 'Complete: the last row is filled with a padding character when encrypting',
        showIf: (v) => KEY_METHODS.includes(v.method as Method) && v.mode !== 'solve',
      },
    ),
    pad: text('Padding character', 'X', {
      showIf: (v) =>
        KEY_METHODS.includes(v.method as Method) && v.mode === 'encrypt' && v.grid === 'complete',
    }),
    route: select(
      'Route',
      [
        { value: 'spiral', label: 'Spiral' },
        { value: 'snake-rows', label: 'Rows back and forth' },
        { value: 'snake-columns', label: 'Columns back and forth' },
        { value: 'columns', label: 'Columns' },
        { value: 'rows', label: 'Rows' },
      ],
      'spiral',
      { showIf: (v) => v.method === 'route' && v.mode !== 'solve' },
    ),
    corner: select(
      'Start corner',
      [
        { value: 'tl', label: 'Top left' },
        { value: 'tr', label: 'Top right' },
        { value: 'bl', label: 'Bottom left' },
        { value: 'br', label: 'Bottom right' },
      ],
      'tl',
      { showIf: (v) => v.method === 'route' && v.mode !== 'solve' },
    ),
    spin: toggle(
      'Rotation',
      [
        { value: 'cw', label: 'Clockwise' },
        { value: 'ccw', label: 'Counter-clockwise' },
      ],
      undefined,
      { showIf: (v) => v.method === 'route' && v.mode !== 'solve' && v.route === 'spiral' },
    ),
    way: toggle(
      'Spiral path',
      [
        { value: 'in', label: 'Inward' },
        { value: 'out', label: 'Outward' },
      ],
      undefined,
      {
        hint: 'Outward: starts in the centre and ends on the corner',
        showIf: (v) => v.method === 'route' && v.mode !== 'solve' && v.route === 'spiral',
      },
    ),
    width: number('Grid width', 0, {
      min: 0,
      max: 500,
      hint: 'Columns of the grid. In Solve, 0 tries every width',
      showIf: (v) => v.method === 'route',
    }),
    rows: number('Rows', 0, {
      min: 0,
      max: 500,
      hint: 'Letters around the rod (turns of the strip)',
      showIf: (v) => v.method === 'scytale' && v.mode !== 'solve',
    }),
    columns: number('Columns', 0, {
      min: 0,
      max: 500,
      hint: '0 = worked out from the rows and the length',
      showIf: (v) => v.method === 'scytale' && v.mode !== 'solve',
    }),
    inverse: bool('Run the permutation backwards', false, {
      hint: 'For ciphers that write along the key order or the route and read the rows',
      showIf: (v) => v.method !== 'scytale' && v.mode !== 'solve',
    }),
    chars: select(
      'Characters in the grid',
      [
        { value: 'nospace', label: 'Everything but spaces' },
        { value: 'letters', label: 'Letters and digits only' },
        { value: 'all', label: 'Every character, spaces included' },
      ],
      'nospace',
    ),
    group: bool('Group in fives', false, { showIf: (v) => v.mode === 'encrypt' }),
    maxKey: number('Longest key to try', 9, {
      min: 2,
      max: 24,
      hint: 'Up to 9 every order is tried; longer keys are searched by hill climbing',
      showIf: (v) => v.method === 'columnar' && v.mode === 'solve',
    }),
  },
  examples: [
    {
      label: 'Solve without the key',
      input:
        'mtbendhergnerpanolreadbunthoamkeeelbpeetedrsiadsoioostntlamogeenpeflnrkaeehapetrfrbecd{sy}inouaselesagtwlu_deflaetlehioirmoic__stdotn',
      options: { mode: 'solve' },
      expect: 'flag{columns_in_key_order}',
    },
    {
      label: 'Decrypt with the key ZEBRAS',
      input: 'EVLNE ACDTK ESEAQ ROFOJ DEECU WIREE',
      options: { mode: 'decrypt', key: 'ZEBRAS', grid: 'complete' },
      expect: 'WEAREDISCOVEREDFLEEATONCEQKJEU',
    },
    {
      label: 'Encrypt (incomplete grid)',
      input: 'WE ARE DISCOVERED FLEE AT ONCE',
      options: { mode: 'encrypt', key: 'ZEBRAS' },
      expect: 'EVLNACDTESEAROFODEECWIREE',
    },
    {
      label: 'Double transposition',
      input: 'CAEENSOIAEDRLEFWEDREEVTOC',
      options: { method: 'double', mode: 'decrypt', key: 'ZEBRAS', key2: 'STRIPE' },
      expect: 'WEAREDISCOVEREDFLEEATONCE',
    },
    {
      label: 'Myszkowski key TOMATO',
      input: 'ROFOA CDTED SEEEA CWEIV RLENE',
      options: { method: 'myszkowski', mode: 'decrypt', key: 'TOMATO' },
      expect: 'WEAREDISCOVEREDFLEEATONCE',
    },
    {
      label: 'Scytale with 4 rows',
      input: 'IRYYATBHMVAEHEDLURLP',
      options: { method: 'scytale', mode: 'decrypt', rows: 4 },
      expect: 'IAMHURTVERYBADLYHELP',
    },
    {
      label: 'Spiral readout',
      input: 'readths{leog}ko__stisfirgatuorpflari',
      options: { method: 'route', mode: 'decrypt', width: 6 },
      expect: 'readthisfirstflag{spiral_route_ok}go',
    },
    {
      label: 'Try every route',
      input: 'readths{leog}ko__stisfirgatuorpflari',
      options: { method: 'route', mode: 'solve' },
      expect: 'readthisfirstflag{spiral_route_ok}go',
    },
  ],
  run(input, o) {
    const cells = toCells(input, o.chars);
    if (!cells.length) throw new ToolError(T('error.noText'));
    if (o.mode === 'solve') {
      if (o.method === 'columnar') return solveKey(cells, o);
      if (o.method === 'route') return solveRoute(cells, o);
      if (o.method === 'scytale') return solveScytale(cells);
      throw new ToolError(T('error.solveMethod'));
    }
    return transpose(cells, o);
  },
});
