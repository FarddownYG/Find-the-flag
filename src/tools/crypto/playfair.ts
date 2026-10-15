import { bool, defineTool, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { indexOfCoincidence } from '../../lib/english';
import { segmentWords } from '../../lib/readability';
import { frenchQuadTable } from './_fitness-fr';
import {
  buildLayout,
  crypt,
  pairsOf,
  pairUp,
  stripFiller,
  type Digraph,
  type Direction,
  type Layout,
  type Rule,
} from './_playfair';
import { isPlausible, solvePlayfair, type SolveCandidate } from './_playfair-solve';
import {
  foldSymbol,
  keySymbols,
  squareRows,
  toSymbols,
  type SquareKind,
  type SymbolRun,
} from './_square';

const T = toolT('playfair');

/** Digraphs listed in the working table (the cipher itself runs on the whole text). */
const WORKING_ROWS = 150;
/** The key search needs at least this many letters to be worth running. */
const MIN_SOLVE_LETTERS = 30;
/** Evaluations per search effort (see _playfair-solve.ts). */
const EFFORT = { quick: 700_000, normal: 3_000_000, deep: 12_000_000 } as const;

type Grouping = 'none' | 'pairs' | 'fives';

/** A 25-letter square as its five rows, so that it wraps between rows in a narrow cell. */
const fives = (square: string): string => square.match(/.{1,5}/g)?.join(' ') ?? square;

function grouped(pairs: readonly string[], grouping: Grouping): string {
  const letters = pairs.join('');
  if (grouping === 'pairs') return pairs.join(' ');
  if (grouping === 'fives') return letters.match(/.{1,5}/g)?.join(' ') ?? '';
  return letters;
}

function ruleText(rule: Rule, direction: Direction): string {
  switch (rule) {
    case 'row':
      return direction === 'encrypt' ? T('rule.rowEnc') : T('rule.rowDec');
    case 'column':
      return direction === 'encrypt' ? T('rule.columnEnc') : T('rule.columnDec');
    case 'rectangle':
      return T('rule.rectangle');
    case 'swap-row':
      return T('rule.swapRow');
    case 'swap-column':
      return T('rule.swapColumn');
  }
}

/** The squares as one table: side by side, stacked, or the four-square grid. */
function squaresTable(layout: Layout): Output {
  const { size, variant } = layout;
  const heads = Array.from({ length: size }, (_, i) => String(i + 1));
  const rows = (square: readonly string[]) => squareRows(square, size);
  const wide = (left: readonly string[], right: readonly string[]) =>
    rows(left).map((row, r) => [String(r + 1), ...row, '', ...rows(right)[r]!]);
  if (variant === 'playfair') {
    return {
      type: 'table',
      label: T('label.square'),
      columns: ['', ...heads],
      rows: rows(layout.first).map((row, r) => [String(r + 1), ...row]),
    };
  }
  if (variant === 'two-horizontal') {
    return {
      type: 'table',
      label: T('label.squaresHorizontal'),
      columns: ['', ...heads, '', ...heads],
      rows: wide(layout.first, layout.second),
    };
  }
  if (variant === 'two-vertical') {
    const gap = Array.from({ length: size + 1 }, () => '');
    return {
      type: 'table',
      label: T('label.squaresVertical'),
      columns: ['', ...heads],
      rows: [
        ...rows(layout.first).map((row, r) => [String(r + 1), ...row]),
        gap,
        ...rows(layout.second).map((row, r) => [String(r + 1), ...row]),
      ],
    };
  }
  const gap = Array.from({ length: 2 * size + 2 }, () => '');
  return {
    type: 'table',
    label: T('label.squaresFour'),
    columns: ['', ...heads, '', ...heads],
    rows: [...wide(layout.plain, layout.first), gap, ...wide(layout.second, layout.plain)],
  };
}

function workingTable(digraphs: readonly Digraph[], direction: Direction): Output {
  const shown = digraphs.slice(0, WORKING_ROWS);
  const cells = (d: Digraph) =>
    `${d.input[0]} ${d.cells[0][0]},${d.cells[0][1]} · ${d.input[1]} ${d.cells[1][0]},${d.cells[1][1]}`;
  return {
    type: 'table',
    label:
      digraphs.length > shown.length
        ? T('label.workingPart', { shown: shown.length, count: digraphs.length })
        : T('label.working'),
    columns: [
      '#',
      direction === 'encrypt' ? T('col.plainPair') : T('col.cipherPair'),
      T('col.cells'),
      T('col.rule'),
      direction === 'encrypt' ? T('col.cipherPair') : T('col.plainPair'),
    ],
    rows: shown.map((d, i) => [i + 1, d.input, cells(d), ruleText(d.rule, direction), d.output]),
  };
}

/** What was merged or left out of the text, as notes. */
function skipNotes(run: SymbolRun): Output[] {
  const notes: Output[] = [];
  const info = (text: string): Output => ({ type: 'note', level: 'info', text });
  if (run.merged) notes.push(info(T('note.merged', { count: run.merged })));
  if (run.droppedQ) notes.push(info(T('note.droppedQ', { count: run.droppedQ })));
  if (run.droppedDigits) {
    notes.push(info(T('note.droppedDigits', { count: run.droppedDigits })));
  }
  if (run.droppedOther) notes.push(info(T('note.droppedOther', { count: run.droppedOther })));
  return notes;
}

const note = (level: 'info' | 'warn' | 'error' | 'success', text: string): Output => ({
  type: 'note',
  level,
  text,
});

/**
 * A word-split reading of the letters, when most of them fall into dictionary words. Playfair
 * plaintext is read with its filler taken out (HIDXDEN -> HIDDEN), as a reader would.
 */
function wordsGuess(letters: string, lang: 'en' | 'fr', filler: string | null): Output | null {
  const clean = (filler ? stripFiller([...letters], filler).join('') : letters).slice(0, 3000);
  if (clean.length < 8) return null;
  const { words, coverage } = segmentWords(clean, lang);
  if (coverage < 0.6) return null;
  return {
    type: 'text',
    label: T('label.words', { percent: Math.round(coverage * 100) }),
    value: words.join(' ').toUpperCase(),
  };
}

/** The filler as a symbol of the square, or null when it has no place there. */
function usableFiller(kind: SquareKind, filler: string): string | null {
  return foldSymbol(kind, filler.trim().charAt(0))?.symbol ?? null;
}

function fillerSymbol(kind: SquareKind, filler: string): string {
  const f = usableFiller(kind, filler);
  if (!f) throw new ToolError(T('error.filler', { filler: filler.trim() || '·' }));
  return f;
}

function solve(
  input: string,
  kind: SquareKind,
  effort: keyof typeof EFFORT,
  language: 'english' | 'french',
): Output[] {
  if (kind === 'digits') throw new ToolError(T('error.solveDigits'));
  const run = toSymbols(kind, input);
  const codes = Uint8Array.from(run.symbols, (s) => s.charCodeAt(0) - 65);
  if (codes.length < MIN_SOLVE_LETTERS) {
    throw new ToolError(T('error.tooShort', { count: codes.length }));
  }
  const pairs = codes.length >> 1;
  const result = solvePlayfair(codes, {
    kind,
    budget: EFFORT[effort],
    table: language === 'french' ? frenchQuadTable() : undefined,
  });
  const best = result.candidates[0];
  if (!best) throw new ToolError(T('error.tooShort', { count: codes.length }));
  const lang = language === 'french' ? 'fr' : 'en';
  const reliable = result.converged && isPlausible(best.fitness, codes.length);
  const doubles: string[] = [];
  for (let i = 0; i < pairs; i++) {
    if (codes[2 * i] === codes[2 * i + 1]) doubles.push(run.symbols[2 * i]! + run.symbols[2 * i]!);
  }

  const out: Output[] = [
    {
      type: 'text',
      label: reliable ? T('label.bestPlain') : T('label.bestGuess'),
      value: best.plain,
    },
  ];
  // Words are only guessed from a plaintext that reads as language: nonsense would split too.
  const guess = reliable ? wordsGuess(best.plain, lang, 'X') : null;
  if (guess) out.push(guess);
  const fit = best.fitness.toFixed(2);
  if (reliable) {
    out.push(
      note(
        'success',
        language === 'french' ? T('note.readsFrench', { fit }) : T('note.readsEnglish', { fit }),
      ),
    );
  } else if (codes.length < 120) {
    out.push(note('warn', T('note.solveShort', { count: codes.length })));
  } else {
    const tried = result.evaluations;
    out.push(
      note(
        'warn',
        language === 'french'
          ? T('note.solveFailedFr', { count: tried })
          : T('note.solveFailedEn', { count: tried }),
      ),
    );
  }
  if (doubles.length) {
    out.push(note('warn', T('note.doubledPairs', { count: doubles.length, example: doubles[0]! })));
  }
  out.push(...skipNotes(run));
  if (codes.length % 2) out.push(note('info', T('note.oddCipher', { count: codes.length })));
  if (codes.length > 1500) {
    out.push(note('info', T('note.longText', { count: result.searched })));
  }

  const rows = squareRows([...best.square], 5);
  out.push({
    type: 'kv',
    label: reliable ? T('label.keyFound') : T('label.keyBest'),
    entries: [
      [T('kv.square'), fives(best.square)],
      [T('kv.keyword'), best.keyword ?? T('value.noKeyword')],
      [T('kv.fit'), T('value.fit', { fit })],
      [T('kv.letters'), String(codes.length - (codes.length % 2))],
      [T('kv.restarts'), String(result.restarts)],
      [T('kv.evaluations'), String(result.evaluations)],
    ],
  });
  out.push({
    type: 'table',
    label: T('label.square'),
    columns: ['', '1', '2', '3', '4', '5'],
    rows: rows.map((row, r) => [String(r + 1), ...row]),
  });
  out.push({
    type: 'actions',
    label: T('label.useKey'),
    actions: [
      {
        label: T('action.decrypt'),
        options: { mode: 'decrypt', variant: 'playfair', square: kind, key: best.square },
        primary: reliable,
      },
    ],
  });
  const preview = (c: SolveCandidate) => c.plain.slice(0, 30) + (c.plain.length > 30 ? '…' : '');
  out.push({
    type: 'table',
    label: T('label.bestKeys'),
    columns: [
      '#',
      T('col.fit'),
      T('col.square'),
      T('col.keyword'),
      T('col.found'),
      T('col.preview'),
    ],
    rows: result.candidates.map((c, i) => [
      i + 1,
      c.fitness.toFixed(2),
      fives(c.square),
      c.keyword ?? '—',
      c.hits,
      preview(c),
    ]),
    highlight: [0],
  });
  out.push({
    type: 'table',
    label: T('label.progress'),
    columns: [T('col.restart'), T('col.fit')],
    rows: result.runs.slice(0, 40).map((fit, i) => [i + 1, fit.toFixed(2)]),
  });
  return out;
}

export default defineTool({
  id: 'playfair',
  name: 'Playfair / Two-square / Four-square',
  category: 'crypto',
  description:
    'Encrypt or decrypt Playfair, two-square and four-square digraph ciphers, or find a Playfair key with no key at all.',
  tags: [
    'playfair',
    'digraph',
    'digram',
    'polygraphic',
    'two-square',
    'double playfair',
    'four-square',
    'wheatstone',
    'key square',
    'simulated annealing',
    'hill climbing',
    'quadgram',
  ],
  input: 'text',
  placeholder: 'BMODZBXDNABEKUDMUIXMMOUVIF  (key: playfair example)',
  options: {
    mode: toggle('Mode', [
      { value: 'decrypt', label: 'Decrypt' },
      { value: 'encrypt', label: 'Encrypt' },
      { value: 'solve', label: 'Find the key' },
    ]),
    variant: select(
      'Cipher',
      [
        { value: 'playfair', label: 'Playfair' },
        { value: 'two-horizontal', label: 'Two-square, side by side' },
        { value: 'two-vertical', label: 'Two-square, stacked' },
        { value: 'four-square', label: 'Four-square' },
      ],
      'playfair',
    ),
    key: text('Key', '', {
      placeholder: 'playfair example',
      hint: 'A keyword or a whole square; its distinct letters come first, then the rest of the alphabet. Four-square: the top-right square.',
      showIf: (v) => v.mode !== 'solve',
    }),
    key2: text('Second key', '', {
      placeholder: 'keyword',
      hint: 'Right (or bottom, or bottom-left) square. Empty: the first key is used again.',
      showIf: (v) => v.mode !== 'solve' && v.variant !== 'playfair',
    }),
    square: select(
      'Square',
      [
        { value: 'ij', label: '5 × 5, I and J together' },
        { value: 'q', label: '5 × 5, without Q' },
        { value: 'digits', label: '6 × 6, letters and digits' },
      ],
      'ij',
    ),
    filler: text('Filler letter', 'X', {
      hint: 'Splits doubled letters (Playfair) and pads an odd length. If it is the doubled letter itself, Q (or Z) is used there.',
      showIf: (v) => v.mode === 'encrypt' || (v.mode === 'decrypt' && v.tidy === true),
    }),
    groups: select(
      'Output groups',
      [
        { value: 'none', label: 'Continuous' },
        { value: 'pairs', label: 'Pairs' },
        { value: 'fives', label: 'Blocks of five' },
      ],
      'none',
      { showIf: (v) => v.mode !== 'solve' },
    ),
    swap: bool('Swap the letters of each ciphertext pair', false, {
      hint: 'Two-square sources disagree on the order of the two ciphertext letters; try this if the plaintext looks wrong.',
      showIf: (v) =>
        v.mode !== 'solve' && (v.variant === 'two-horizontal' || v.variant === 'two-vertical'),
    }),
    tidy: bool('Also remove the filler', false, {
      hint: 'A guess: drops the filler between two equal letters and at the end. It also removes a real X in words like TAXATION.',
      showIf: (v) => v.mode === 'decrypt' && v.variant === 'playfair',
    }),
    language: toggle(
      'Language of the message',
      [
        { value: 'english', label: 'English' },
        { value: 'french', label: 'French' },
      ],
      undefined,
      { showIf: (v) => v.mode === 'solve' },
    ),
    effort: toggle(
      'Search effort',
      [
        { value: 'quick', label: 'Quick' },
        { value: 'normal', label: 'Normal' },
        { value: 'deep', label: 'Deep' },
      ],
      'normal',
      {
        hint: 'Quick is about a second, Deep up to half a minute. The search stops early once it has found English (or French).',
        showIf: (v) => v.mode === 'solve',
      },
    ),
  },
  examples: [
    {
      label: 'Wikipedia example',
      input: 'BMODZBXDNABEKUDMUIXMMOUVIF',
      options: { key: 'playfair example' },
      expect: 'HIDETHEGOLDINTHETREXESTUMP',
    },
    {
      label: 'Encrypt a sentence',
      input: 'Hide the gold in the tree stump',
      options: { mode: 'encrypt', key: 'playfair example' },
      expect: 'BMODZBXDNABEKUDMUIXMMOUVIF',
    },
    {
      label: 'Doubled letters (BALLOON)',
      input: 'balloon',
      options: { mode: 'encrypt', key: 'monarchy' },
      expect: 'IBSUPMNA',
    },
    {
      label: 'Four-square',
      input: 'HELPMEOBIWANKENOBI',
      options: { mode: 'encrypt', variant: 'four-square', key: 'example', key2: 'keyword' },
      expect: 'FYNFNEHWBXAFFOKHMD',
    },
    {
      label: 'Two-square, side by side',
      input: 'HELPMEOBIWANKENOBI',
      options: { mode: 'encrypt', variant: 'two-horizontal', key: 'example', key2: 'keyword' },
      expect: 'GXAOEMQLIAERGMLPBH',
    },
    {
      label: 'Find the key (English)',
      input:
        'HPFUOATDEFWGZKGFGFDSCQOYDTIKTVAFMCZLLNZKGFROSXOULXGBZFAGHRAROTSUSMRSIKQOGAAOWSCFLVELZFWGPAKRUAWLRSKRNSNQPAFGHTKGSLCRNASUSTROLNZKGFACRUHRHPFRUOTLKTLARWECFADAHLLAFURGGAKBRZOULICLKTMSTASOIGTCRWECHPFGOASRRDKRAGHRAROTCQSRQTSKRAIKLCCNDAAGSDPWUODACQFIOKKZAOHLOSEHTAKBFURADAHPDLNSGSTW',
      options: { mode: 'solve' },
      expect: 'THEMESSAGEYOUAREREADING',
    },
    {
      label: 'Find the key (French)',
      input:
        'QLBYCTQCQCZCBNBUCTQCEGLEOARLOIRQQBALGECOPRCOAMQUQOBCIAQYQBXRAOTKHEEHROTBRLBEORPBBEAOLRAVNAKERQQRKDEGQAPNFVQLGNCGQBUGKCUQEUKQNGKQORFKPRRQAOCSQAORPROQSORQCQWGUECAQCBGQCNAUQGORQTDNTGQQGEBKQQRPNCQHKQFRPFNHKZMRORLLTQAOEUEERUBPTECDNHETLBCEHORZDBNERQBDNORTKRQQBALQRLOMQQBXCLREWER',
      options: { mode: 'solve', language: 'french' },
      expect: 'PERSONNENEVOUSADONNELACLEDECEMESSAGE',
    },
  ],
  detect({ text: t }) {
    const letters = (t ?? '').replace(/\s+/g, '');
    if (letters.length < 60 || letters.length % 2 || !/^[A-Za-z]+$/.test(letters)) return null;
    const up = letters.toUpperCase();
    if (up.includes('J')) return null;
    for (let i = 0; i < up.length; i += 2) if (up[i] === up[i + 1]) return null;
    // Digraph substitution flattens the letter counts: between random (0.038) and English (0.066).
    const ioc = indexOfCoincidence(up);
    if (ioc < 0.038 || ioc > 0.058) return null;
    return { score: 0.3, options: { mode: 'decrypt' as const }, reason: T('detect.pairs') };
  },
  run(input, { mode, variant, key, key2, square, filler, groups, swap, tidy, language, effort }) {
    const kind: SquareKind = square;
    if (mode === 'solve') {
      if (variant !== 'playfair') throw new ToolError(T('error.solveVariant'));
      return solve(input, kind, effort, language);
    }
    const run = toSymbols(kind, input);
    if (!run.symbols.length) throw new ToolError(T('error.noSymbols'));
    const layout = buildLayout(variant, kind, key, key2);
    const out: Output[] = [];
    const notes: Output[] = [];
    if (!keySymbols(kind, key).length) notes.push(note('info', T('note.emptyKey')));
    if (variant !== 'playfair' && !keySymbols(kind, key2).length) {
      notes.push(note('info', T('note.key2Same')));
    }
    if (variant === 'two-horizontal' || variant === 'two-vertical') {
      notes.push(note('info', T('note.twoSquare')));
    }

    if (mode === 'encrypt') {
      const fill = fillerSymbol(kind, filler);
      const prepared = pairUp(run.symbols, variant, kind, fill);
      const digraphs = crypt(layout, 'encrypt', prepared.pairs, swap);
      out.push({
        type: 'text',
        label: T('label.cipher'),
        value: grouped(
          digraphs.map((d) => d.output),
          groups,
        ),
      });
      if (prepared.split.length) {
        const shown = prepared.split
          .slice(0, 6)
          .map((s) => `${s.letter}${s.letter} → ${s.letter}${s.filler}${s.letter}`)
          .join(', ');
        notes.push(note('info', T('note.split', { count: prepared.split.length, list: shown })));
      }
      if (prepared.padding) {
        notes.push(
          note(
            'info',
            T('note.padded', { filler: prepared.padding.filler, letter: prepared.padding.after }),
          ),
        );
      }
      out.push(
        {
          type: 'text',
          label: T('label.prepared'),
          value: prepared.pairs.join(' '),
        },
        ...notes,
        ...skipNotes(run),
        squaresTable(layout),
        workingTable(digraphs, 'encrypt'),
      );
      return out;
    }

    const { pairs, leftover } = pairsOf(run.symbols);
    if (!pairs.length) throw new ToolError(T('error.oddOne'));
    const digraphs = crypt(layout, 'decrypt', pairs, swap);
    const plain = digraphs.map((d) => d.output);
    out.push({
      type: 'text',
      label: T('label.plain'),
      value: grouped(plain, groups),
    });
    if (tidy && variant === 'playfair') {
      const fill = fillerSymbol(kind, filler);
      const cleaned = stripFiller([...plain.join('')], fill).join('');
      out.push({ type: 'text', label: T('label.tidied', { filler: fill }), value: cleaned });
      const g = wordsGuess(cleaned, 'en', null) ?? wordsGuess(cleaned, 'fr', null);
      if (g) out.push(g);
    } else {
      const letters = plain.join('');
      const f = variant === 'playfair' ? usableFiller(kind, filler) : null;
      const g = wordsGuess(letters, 'en', f) ?? wordsGuess(letters, 'fr', f);
      if (g) out.push(g);
    }
    if (leftover !== null)
      notes.push(note('warn', T('note.oddCipher', { count: run.symbols.length })));
    if (variant === 'playfair') {
      const doubles = pairs.filter((p) => p[0] === p[1]);
      if (doubles.length) {
        notes.push(
          note('warn', T('note.doubledPairs', { count: doubles.length, example: doubles[0]! })),
        );
      }
    }
    out.push(...notes, ...skipNotes(run), squaresTable(layout), workingTable(digraphs, 'decrypt'));
    return out;
  },
});
