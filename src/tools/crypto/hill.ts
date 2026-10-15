import { defineTool, number, select, text, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { preview } from './_classical';
import { fitness, rankScore } from './_fitness';
import { frenchQuadTable } from './_fitness-fr';
import {
  HILL_ALPHABETS,
  MAX_SIZE,
  applyBlocks,
  blockingPrimes,
  chunk,
  invert,
  identity,
  isParsed,
  matrixWord,
  multiply,
  parseKey,
  readText,
  solveKnown,
  transpose,
  writeText,
  type HillAlphabet,
  type Matrix,
} from './_hill';
import { CRACK_LETTERS, crackFitness, crackHill2 } from './_hill-crack';

const T = toolT('hill');

/** Blocks listed in the working table. */
const WORKING_ROWS = 60;
/** The 2 x 2 search needs this many letters to be worth running. */
const MIN_CRACK_LETTERS = 16;
/** Candidate keys listed when the known text does not fix the key. */
const CANDIDATE_ROWS = 12;

const note = (level: 'info' | 'warn' | 'error' | 'success', text: string): Output => ({
  type: 'note',
  level,
  text,
});

/** The symbols of the alphabet, with the space made visible. */
const showSymbols = (a: HillAlphabet): string => a.symbols.replace(/ /g, '␣');

function matrixTable(label: string, a: Matrix): Output {
  return {
    type: 'table',
    label,
    columns: ['', ...a.map((_, j) => String(j + 1))],
    rows: a.map((row, i) => [String(i + 1), ...row.map(String)]),
  };
}

/** The key as the option text that reproduces it (numbers work with every alphabet). */
const keyText = (a: Matrix): string => a.flat().join(' ');

interface KeyInfo {
  /** The matrix as the user gave it. */
  key: Matrix;
  /** The matrix acting on column vectors (the key, or its transpose with the row convention). */
  effective: Matrix;
  n: number;
  form: 'numbers' | 'letters';
}

function readKey(key: string, alphabet: HillAlphabet, convention: 'column' | 'row'): KeyInfo {
  const parsed = parseKey(key, alphabet);
  if (!isParsed(parsed)) {
    if (parsed.problem === 'empty') throw new ToolError(T('error.emptyKey'));
    if (parsed.problem === 'count')
      throw new ToolError(T('error.keyCount', { count: parsed.count }));
    throw new ToolError(T('error.keySize', { n: parsed.n, max: MAX_SIZE }));
  }
  const effective = convention === 'row' ? transpose(parsed.matrix) : parsed.matrix;
  return { key: parsed.matrix, effective, n: parsed.n, form: parsed.form };
}

/** What the key is: its size, determinant, whether it has an inverse, and why not. */
function keyFacts(
  info: KeyInfo,
  alphabet: HillAlphabet,
): { out: Output[]; inverse: Matrix | null } {
  const m = alphabet.modulus;
  const inv = invert(info.key, m);
  const entries: [string, string][] = [
    [T('kv.size'), `${info.n} × ${info.n}`],
    [T('kv.alphabet'), `${showSymbols(alphabet)} (${m})`],
  ];
  if (info.form === 'letters' || alphabet.id === 'az') {
    entries.push([T('kv.keyword'), matrixWord(info.key, alphabet).replace(/ /g, '␣')]);
  }
  entries.push(
    [T('kv.det'), `${inv.det} (mod ${m})`],
    [T('kv.gcd'), `gcd(${inv.det}, ${m}) = ${inv.gcd}`],
    [T('kv.invertible'), inv.inverse ? T('value.yes') : T('value.no')],
  );
  if (inv.inverse) {
    const product = multiply(info.key, inv.inverse, m);
    const ok = JSON.stringify(product) === JSON.stringify(identity(info.n));
    entries.push([T('kv.check'), ok ? T('value.checkOk', { m }) : T('value.checkBad', { m })]);
  }
  const out: Output[] = [
    matrixTable(T('label.key'), info.key),
    { type: 'kv', label: T('label.facts'), entries },
  ];
  if (inv.inverse) out.push(matrixTable(T('label.inverse'), inv.inverse));
  return { out, inverse: inv.inverse };
}

function noInverseNote(info: KeyInfo, alphabet: HillAlphabet, encrypting: boolean): Output {
  const m = alphabet.modulus;
  const { det, gcd } = invert(info.key, m);
  const params = {
    det,
    m,
    gcd,
    primes: blockingPrimes(det, m).join(', '),
  };
  // A warning, not an error: the explanation is the result (examples must not end in an error).
  return note('warn', encrypting ? T('note.noInverseEnc', params) : T('note.noInverse', params));
}

function workingTable(
  steps: ReturnType<typeof applyBlocks>,
  alphabet: HillAlphabet,
  matrixLabel: string,
): Output {
  const word = (v: readonly number[]) =>
    v
      .map((x) => alphabet.symbols[x]!)
      .join('')
      .replace(/ /g, '␣');
  const shown = steps.slice(0, WORKING_ROWS);
  return {
    type: 'table',
    label:
      steps.length > shown.length
        ? T('label.workingPart', { shown: shown.length, count: steps.length })
        : T('label.working'),
    columns: [
      '#',
      T('col.block'),
      T('col.vector'),
      T('col.product', { matrix: matrixLabel }),
      T('col.reduced'),
      T('col.result'),
    ],
    rows: shown.map((s, i) => [
      i + 1,
      word(s.input),
      s.input.join(' '),
      s.raw.join(' '),
      s.output.join(' '),
      word(s.output),
    ]),
  };
}

function fillerValue(alphabet: HillAlphabet, filler: string): number {
  const i = alphabet.symbols.indexOf(filler.trim().charAt(0).toUpperCase());
  if (i < 0 || !filler.trim())
    throw new ToolError(T('error.filler', { filler: filler.trim() || '·' }));
  return i;
}

function transformText(
  input: string,
  info: KeyInfo,
  alphabet: HillAlphabet,
  encrypting: boolean,
  filler: string,
): Output[] {
  const m = alphabet.modulus;
  const { slots, values } = readText(input, alphabet);
  if (!values.length) throw new ToolError(T('error.noSymbols'));
  const facts = keyFacts(info, alphabet);
  const inverseOfEffective = invert(info.effective, m).inverse;
  const n = info.n;
  const out: Output[] = [];

  if (!encrypting && !inverseOfEffective) {
    return [noInverseNote(info, alphabet, false), ...facts.out];
  }
  const matrix = encrypting ? info.effective : inverseOfEffective!;
  let padded = values;
  const rest = values.length % n;
  const notes: Output[] = [];
  if (encrypting && rest) {
    const f = fillerValue(alphabet, filler);
    padded = [...values, ...new Array<number>(n - rest).fill(f)];
    notes.push(note('info', T('note.padded', { count: n - rest, filler: alphabet.symbols[f]! })));
  } else if (!encrypting && rest) {
    notes.push(note('warn', T('note.leftover', { count: rest, n })));
  }
  const steps = applyBlocks(padded, matrix, m);
  const result = writeText(
    slots,
    steps.flatMap((s) => s.output),
    alphabet,
    alphabet.id === 'az',
  );
  out.push({
    type: 'text',
    label: encrypting ? T('label.cipher') : T('label.plain'),
    value: result,
  });
  if (encrypting && !facts.inverse) out.push(noInverseNote(info, alphabet, true));
  if (alphabet.id !== 'az') out.push(note('info', T('note.caseLost')));
  out.push(...notes, ...facts.out);
  out.push(workingTable(steps, alphabet, encrypting ? 'K' : 'K⁻¹'));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Known plaintext

function knownPlaintext(
  input: string,
  knownText: string,
  offset: number,
  size: number,
  alphabet: HillAlphabet,
  convention: 'column' | 'row',
): Output[] {
  const m = alphabet.modulus;
  const n = Math.floor(size);
  if (!Number.isFinite(n) || n < 2 || n > MAX_SIZE)
    throw new ToolError(T('error.size', { max: MAX_SIZE }));
  const cipher = readText(input, alphabet);
  const known = readText(knownText, alphabet).values;
  if (!cipher.values.length) throw new ToolError(T('error.noSymbols'));
  if (!known.length) throw new ToolError(T('error.noKnown'));
  const start = Math.max(0, Math.floor(offset));
  if (start >= cipher.values.length) {
    throw new ToolError(T('error.offset', { offset: start, count: cipher.values.length }));
  }

  /** The blocks that the known text covers when it starts at letter `at` of the ciphertext. */
  const blocksFor = (at: number) => {
    const skip = (n - (at % n)) % n;
    const plain = known.slice(skip);
    const ciph = cipher.values.slice(at + skip);
    const count = Math.min(Math.floor(plain.length / n), Math.floor(ciph.length / n));
    return {
      count,
      plain: chunk(plain.slice(0, count * n), n),
      cipher: chunk(ciph.slice(0, count * n), n),
    };
  };
  const used = blocksFor(start);
  if (used.count < n) {
    throw new ToolError(T('error.cribShort', { blocks: used.count, n, need: n * n }));
  }

  const result = solveKnown(used.plain, used.cipher, m);
  const out: Output[] = [];
  const cipherValues = cipher.values;

  /** The full decryption with a key given as acting on column vectors. */
  const decryptWith = (effective: Matrix): string | null => {
    const inv = invert(effective, m).inverse;
    if (!inv) return null;
    const usable = cipherValues.length - (cipherValues.length % n);
    const steps = applyBlocks(cipherValues.slice(0, usable), inv, m);
    return writeText(
      cipher.slots,
      steps.flatMap((s) => s.output),
      alphabet,
      alphabet.id === 'az',
    );
  };
  const shownKey = (effective: Matrix): Matrix =>
    convention === 'row' ? transpose(effective) : effective;
  const decryptAction = (effective: Matrix): Output => ({
    type: 'actions',
    label: T('label.useKey'),
    actions: [
      {
        label: T('action.decrypt'),
        options: {
          mode: 'decrypt',
          key: keyText(shownKey(effective)),
          alphabet: alphabet.id,
          convention,
        },
        primary: true,
      },
    ],
  });

  if (result.status === 'none') {
    // Maybe the known text starts at another place of a block: say which alignments would fit.
    const fits: number[] = [];
    for (let a = 0; a < n; a++) {
      const at = start - (start % n) + a;
      if (at === start || at >= cipherValues.length) continue;
      const alt = blocksFor(at);
      if (alt.count >= n && solveKnown(alt.plain, alt.cipher, m).status !== 'none') fits.push(at);
    }
    out.push(note('error', T('note.noFit', { n, blocks: used.count })));
    if (fits.length) out.push(note('info', T('note.otherOffset', { offsets: fits.join(', ') })));
    return out;
  }

  const deficient = result.ranks.filter((r) => r.rank < n);
  const independent = deficient.length === 0;

  if (result.status === 'too-many') {
    out.push(note('warn', T('note.tooMany', { n })));
    if (!independent) out.push(note('warn', rankNote(deficient, n, m)));
    return out;
  }
  if (!result.keys.length) {
    out.push(note('error', T('note.noInvertible', { n })));
    if (!independent) out.push(note('warn', rankNote(deficient, n, m)));
    return out;
  }

  // The key (or the keys), best reading first. Many keys are ranked on the start of the text
  // with the quadgram score (cheap), and the best few on the whole text.
  const prefixScore = (k: Matrix): number => {
    const inv = invert(k, m).inverse!;
    const head = cipherValues.slice(
      0,
      Math.min(200, cipherValues.length - (cipherValues.length % n)),
    );
    return fitness(
      applyBlocks(head, inv, m)
        .flatMap((s) => s.output)
        .map((v) => alphabet.symbols[v]!)
        .join(''),
    );
  };
  const preliminary =
    result.keys.length > 1
      ? result.keys
          .map((k) => ({ k, s: prefixScore(k) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, CANDIDATE_ROWS)
          .map((x) => x.k)
      : result.keys;
  const scored = preliminary
    .map((k) => {
      const text = decryptWith(k)!;
      return { key: k, text, score: preliminary.length > 1 ? rankScore(text) : 0 };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const unique = scored.length === 1;

  out.push({ type: 'text', label: T('label.plain'), value: best.text });
  out.push(
    unique
      ? note('success', T('note.recovered', { n, blocks: used.count }))
      : note('warn', T('note.several', { count: result.keys.length, fits: result.fits })),
  );
  if (!independent) out.push(note('warn', rankNote(deficient, n, m)));
  const shown = shownKey(best.key);
  out.push(matrixTable(T('label.keyFound'), shown));
  const inverse = invert(best.key, m);
  out.push({
    type: 'kv',
    label: T('label.facts'),
    entries: [
      [T('kv.size'), `${n} × ${n}`],
      [T('kv.keyword'), matrixWord(shown, alphabet).replace(/ /g, '␣')],
      [T('kv.numbers'), keyText(shown)],
      [T('kv.det'), `${inverse.det} (mod ${m})`],
      [T('kv.blocks'), String(used.count)],
    ],
  });
  out.push(matrixTable(T('label.inverse'), shownKey(inverse.inverse!)));
  out.push(decryptAction(best.key));
  if (!unique) {
    out.push({
      type: 'table',
      label: T('label.candidates'),
      columns: ['#', T('col.score'), T('col.keyword'), T('col.numbers'), T('col.result')],
      rows: scored
        .slice(0, CANDIDATE_ROWS)
        .map((c, i) => [
          i + 1,
          c.score.toFixed(1),
          matrixWord(shownKey(c.key), alphabet).replace(/ /g, '␣'),
          keyText(shownKey(c.key)),
          preview(c.text, 30),
        ]),
      highlight: [0],
    });
  }
  return out;
}

function rankNote(deficient: { prime: number; rank: number }[], n: number, m: number): string {
  return T('note.notIndependent', {
    details: deficient.map((d) => `mod ${d.prime}: ${d.rank} / ${n}`).join(', '),
    m,
  });
}

// ---------------------------------------------------------------------------------------------
// Ciphertext only, 2 x 2

function crack(
  input: string,
  alphabet: HillAlphabet,
  convention: 'column' | 'row',
  language: 'english' | 'french',
): Output[] {
  if (alphabet.id !== 'az') throw new ToolError(T('error.bruteAlphabet'));
  const { slots, values } = readText(input, alphabet);
  if (values.length < MIN_CRACK_LETTERS) {
    throw new ToolError(T('error.tooShort', { count: values.length }));
  }
  const table = language === 'french' ? frenchQuadTable() : undefined;
  const result = crackHill2(values, { table });
  const best = result.candidates[0]!;
  const second = result.candidates[1];
  const fit = crackFitness(best.score, result.letters);
  const gap = second ? fit - crackFitness(second.score, result.letters) : 1;
  const reliable = fit > -5.2 && gap > 0.15;

  const usable = values.length - (values.length % 2);
  const decrypt = (matrix: Matrix): string =>
    writeText(
      slots,
      applyBlocks(values.slice(0, usable), matrix, 26).flatMap((s) => s.output),
      alphabet,
      true,
    );
  const keyOf = (decrypting: Matrix): Matrix => {
    const k = invert(decrypting, 26).inverse!;
    return convention === 'row' ? transpose(k) : k;
  };

  const out: Output[] = [
    {
      type: 'text',
      label: reliable ? T('label.plain') : T('label.bestGuess'),
      value: decrypt(best.matrix),
    },
  ];
  const fitText = fit.toFixed(2);
  if (reliable) {
    out.push(
      note(
        'success',
        language === 'french'
          ? T('note.readsFrench', { fit: fitText })
          : T('note.readsEnglish', { fit: fitText }),
      ),
    );
  } else {
    out.push(
      note(
        'warn',
        language === 'french'
          ? T('note.noReadFrench', { fit: fitText })
          : T('note.noReadEnglish', { fit: fitText }),
      ),
    );
  }
  if (values.length % 2) out.push(note('info', T('note.leftover', { count: 1, n: 2 })));
  if (values.length > CRACK_LETTERS)
    out.push(note('info', T('note.firstLetters', { count: result.letters })));

  const key = keyOf(best.matrix);
  out.push(matrixTable(T('label.keyFound'), key));
  out.push({
    type: 'kv',
    label: T('label.facts'),
    entries: [
      [T('kv.keyword'), matrixWord(key, alphabet)],
      [T('kv.numbers'), keyText(key)],
      [T('kv.fit'), T('value.fit', { fit: fitText })],
      [T('kv.tried'), String(result.tried)],
    ],
  });
  out.push({
    type: 'actions',
    label: T('label.useKey'),
    actions: [
      {
        label: T('action.decrypt'),
        options: { mode: 'decrypt', key: keyText(key), alphabet: 'az', convention },
        primary: reliable,
      },
    ],
  });
  out.push({
    type: 'table',
    label: T('label.candidates'),
    columns: ['#', T('col.fit'), T('col.keyword'), T('col.numbers'), T('col.result')],
    rows: result.candidates.map((c, i) => {
      const k = keyOf(c.matrix);
      const text = applyBlocks(values.slice(0, 40), c.matrix, 26)
        .flatMap((step) => step.output)
        .map((v) => alphabet.symbols[v]!)
        .join('');
      return [
        i + 1,
        crackFitness(c.score, result.letters).toFixed(2),
        matrixWord(k, alphabet),
        keyText(k),
        text,
      ];
    }),
    highlight: [0],
  });
  out.push(note('info', T('note.only2x2')));
  return out;
}

export default defineTool({
  id: 'hill',
  name: 'Hill cipher',
  category: 'crypto',
  description:
    'Encrypt or decrypt with a Hill key matrix and see why a key has no inverse, recover the key from known plaintext, or crack a 2×2 Hill cipher with no key.',
  tags: [
    'hill',
    'hill cipher',
    'matrix cipher',
    'lester hill',
    'linear algebra',
    'key matrix',
    'determinant',
    'inverse matrix',
    'known plaintext',
    'polygraphic',
    'mod 26',
  ],
  input: 'text',
  placeholder: 'HIAT  (key: DDCF  or  3 3 2 5)',
  options: {
    mode: toggle('Mode', [
      { value: 'decrypt', label: 'Decrypt' },
      { value: 'encrypt', label: 'Encrypt' },
      { value: 'known', label: 'Recover the key' },
      { value: 'brute', label: 'Crack 2×2' },
    ]),
    key: text('Key matrix', '', {
      placeholder: 'GYBNQKURP   or   6 24 1 13 16 10 20 17 15',
      hint: 'n × n numbers (separated by spaces or commas, row by row) or a keyword of n² symbols (4, 9, 16, 25 or 36). Brackets are ignored.',
      showIf: (v) => v.mode === 'decrypt' || v.mode === 'encrypt',
    }),
    alphabet: select(
      'Alphabet',
      [
        { value: 'az', label: 'A–Z (mod 26)' },
        { value: 'az29', label: 'A–Z, space . , (mod 29)' },
        { value: 'az37', label: 'A–Z, 0–9, space (mod 37)' },
      ],
      'az',
    ),
    convention: toggle('Vectors', [
      { value: 'column', label: 'Columns: C = K·P' },
      { value: 'row', label: 'Rows: C = P·K' },
    ]),
    filler: text('Padding letter', 'X', {
      hint: 'Added at the end when the text does not fill the last block.',
      showIf: (v) => v.mode === 'encrypt',
    }),
    known: text('Known plaintext', '', {
      placeholder: 'the plaintext of the first letters, e.g. FLAG…',
      hint: 'Plain letters that sit under the ciphertext from the letter below. n × n letters are needed for an n × n key.',
      showIf: (v) => v.mode === 'known',
    }),
    offset: number('Known text starts at letter', 0, {
      min: 0,
      step: 1,
      hint: 'Position in the ciphertext (0 = the first letter) where the known plaintext begins.',
      showIf: (v) => v.mode === 'known',
    }),
    size: number('Matrix size n', 2, {
      min: 2,
      max: MAX_SIZE,
      step: 1,
      showIf: (v) => v.mode === 'known',
    }),
    language: toggle(
      'Language of the message',
      [
        { value: 'english', label: 'English' },
        { value: 'french', label: 'French' },
      ],
      undefined,
      { showIf: (v) => v.mode === 'brute' },
    ),
  },
  examples: [
    {
      label: 'Wikipedia 3×3: ACT → POH',
      input: 'ACT',
      options: { mode: 'encrypt', key: 'GYBNQKURP' },
      expect: 'POH',
    },
    {
      label: 'Decrypt with the inverse',
      input: 'POH',
      options: { key: 'GYBNQKURP' },
      expect: 'ACT',
    },
    {
      label: '2×2 with the key as numbers',
      input: 'HELP',
      options: { mode: 'encrypt', key: '3 3 2 5' },
      expect: 'HIAT',
    },
    {
      label: 'A key that cannot decrypt',
      input: 'ABCD',
      options: { key: '2 4 6 8' },
      expect: 'not invertible',
    },
    {
      label: 'Recover the key from a known start',
      input:
        'MMDPHHRKDFXCISYYUFBBDAJNNYSETELXWKGGQMFQQGJYTUVYRWEVOXLDVRGQEWJWKHOOKJVJAJNUGOLTJMMWQPUBBAKIRIORFNPTJDFNVZQDTKOUNAQTSWDFWARSPYAJNQQUUGXCTJAHTGYENUDOAYAJNVIXQMFITBVXMCMLBUMLXWCUHVEYWARQNNSYXLAJPSI',
      options: { mode: 'known', known: 'EVERYNIGH', size: 3 },
      expect: 'EVERYNIGHTTHEKEEPEROFTHEOLDLIGHTHOUSE',
    },
    {
      label: 'Known start that is not independent',
      input: 'AJNUGOLTJIHBMWGGPSZQFRWEVOXLDVRGQJKYISYYUFBBDAJNNYSETELXWKGGREDGMO',
      options: { mode: 'known', known: 'THESIGNAL', size: 3 },
      expect: 'not independent mod 26',
    },
    {
      label: 'Crack a 2×2 cipher (no key)',
      input:
        'RCJGHIXYYEZLXLWMNEHSTPCXZKIZNZUGHSHGROZMHLNGLMGZNTTPDSUGBAXYXIBTXOLIHQTPBTYINNENNNJHNNHGUDMUHULMGZUQPUZKQWYZZKFKBAELMSUBGZEINETABGIBMMIQJIRYMTUTTDZZTABAMUBRJCYVLSTVZKPSIBRPLHAGWHWGSYJIOWDVHJXLZBISFJXCRYBAEDCWBTYIHULTBRCWDVALZKCCBH',
      options: { mode: 'brute' },
      expect: 'NOBODYREMEMBERSWHOBUILTTHEBRIDGE',
    },
  ],
  run(
    input,
    { mode, key, alphabet: alphabetId, convention, filler, known, offset, size, language },
  ) {
    const alphabet = HILL_ALPHABETS[alphabetId];
    if (mode === 'known') return knownPlaintext(input, known, offset, size, alphabet, convention);
    if (mode === 'brute') return crack(input, alphabet, convention, language);
    const info = readKey(key, alphabet, convention);
    return transformText(input, info, alphabet, mode === 'encrypt', filler);
  },
});
