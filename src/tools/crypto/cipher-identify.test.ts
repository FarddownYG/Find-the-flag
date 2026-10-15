import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { TOOLS } from '../../core/registry';
import type { Output, ToolResult } from '../../core/types';
import { printableRatio, toBase64, toHex, utf8Encode } from '../../lib/bytes';
import { ENGLISH, FRENCH } from './_cipher-identify-corpus';
import { rankFamilies, type FamilyId } from './_cipher-identify-rank';
import {
  buildSamples,
  inFives,
  lettersOf,
  makeSample,
  type Kind,
} from './_cipher-identify-samples';
import { analyse, IOC_REFERENCE } from './_cipher-identify-stats';
import { PROSE_A, PROSE_B } from './_sample-text';
import { RAW, SALTED_PBKDF2 } from './_symmetric-examples';
import tool from './cipher-identify';

const en: Record<string, string> = JSON.parse(
  readFileSync(new URL('../../i18n/locales/en.json', import.meta.url), 'utf8'),
);

type Table = Extract<Output, { type: 'table' }>;
type Actions = Extract<Output, { type: 'actions' }>;
type Note = Extract<Output, { type: 'note' }>;
type Kv = Extract<Output, { type: 'kv' }>;

const run = async (text: string, language: 'auto' | 'en' | 'fr' = 'auto'): Promise<ToolResult> =>
  tool.run(text, { language });
const tableOf = (result: ToolResult, label: string): Table => {
  const t = result.find((o): o is Table => o.type === 'table' && (o.label ?? '').startsWith(label));
  if (!t) throw new Error(`no table "${label}"`);
  return t;
};
/** The ranking table, each row with the reasons listed under it (the first four have them). */
const ranking = (result: ToolResult) =>
  tableOf(result, 'Ranking').rows.map((r, i) => {
    const block = result.find(
      (o): o is Kv => o.type === 'kv' && (o.label ?? '').startsWith(`${i + 1}. `),
    );
    return {
      name: String(r[1]),
      fit: parseInt(String(r[2]), 10),
      why: block ? block.entries.map(([, v]) => v).join(' · ') : '',
    };
  });
/** Every button of the result, in order. */
const buttons = (result: ToolResult) =>
  result.filter((o): o is Actions => o.type === 'actions').flatMap((o) => o.actions);
const notes = (result: ToolResult) =>
  result.filter((o): o is Note => o.type === 'note').map((o) => o.text);

/** Rank (1-based) of the first listed candidate whose name contains `part`, or 99. */
const rankOf = (result: ToolResult, part: string): number => {
  const i = ranking(result).findIndex((r) => r.name.includes(part));
  return i < 0 ? 99 : i + 1;
};

// ------------------------------------------------------------------------------------------
// The measures, on texts small enough to count by hand

describe('statistics', () => {
  it('index of coincidence: sum of n(n-1) over N(N-1)', () => {
    expect(analyse('AAAA').ioc).toBe(1);
    // A twice, B twice: (2 + 2) / (4 * 3)
    expect(analyse('ABAB').ioc).toBeCloseTo(4 / 12, 12);
    expect(analyse('ABCD').ioc).toBe(0);
  });

  it('references are the usual ones', () => {
    expect(IOC_REFERENCE.en).toBeCloseTo(0.066, 2);
    expect(IOC_REFERENCE.fr).toBeCloseTo(0.078, 2);
    expect(IOC_REFERENCE.random).toBeCloseTo(0.0385, 3);
  });

  it('entropy of a fair coin is one bit; of one symbol, none', () => {
    expect(analyse('ABABABAB').entropy).toBeCloseTo(1, 12);
    expect(analyse('AAAA').entropy).toBe(0);
  });

  it('periodic IoC: a period-2 text has IoC 1 in its columns', () => {
    const s = analyse('AB'.repeat(30));
    expect(s.period[1]!.ioc).toBe(1);
    expect(s.period[0]!.ioc).toBeLessThan(0.6);
  });

  it('Kasiski: the distance between repeats of ABC is 6, divisible by 2, 3 and 6', () => {
    const s = analyse('ABCXYZABCQRSABC');
    expect(s.kasiski.repeats).toBe(2);
    const votes = Object.fromEntries(s.kasiski.rows.map((r) => [r.factor, r.votes]));
    expect(votes).toMatchObject({ 2: 2, 3: 2, 6: 2 });
    expect(s.kasiski.longest).toBe(3);
  });

  it('doubled letters are counted inside pairs (even offsets) and between them', () => {
    const s = analyse('AABCCDEFFG');
    // AA at 0-1 is inside a pair; CC at 3-4 and FF at 7-8 straddle two pairs.
    expect(s.doubles).toMatchObject({ total: 3, inPairs: 1, between: 2 });
  });

  it('pairs read from the start repeat more than pairs shifted by one letter', () => {
    const s = analyse('THEXTHEXTHEXTHEXTHEXTHEXTHEX');
    expect(s.align2.aligned).toBeGreaterThan(s.align2.shifted);
  });

  it('shape checks: missing letters, divisors, coordinates, A D F G V X, two symbols', () => {
    expect(analyse('ABCDEFGHIKLMNOPQRSTUVWXYZ'.repeat(4)).missing).toEqual(['J']);
    expect(analyse('ABCDEFGHIJ').divisors).toEqual([2, 5, 10]);
    const pairs = analyse('11 23 55 41 32');
    expect(pairs.digitsOnly && pairs.coordinatePairs).toBe(true);
    expect(analyse('11 23 77').coordinatePairs).toBe(false);
    expect(analyse('ADFGXXGFDA').adfgvx).toEqual(['A', 'D', 'F', 'G', 'X']);
    expect(analyse('ABBA ABAB').twoSymbols).toEqual(['A', 'B']);
    expect(analyse('01101 001').twoSymbols).toEqual(['0', '1']);
    expect(analyse('HELLO WORLD').twoSymbols).toBeNull();
  });

  it('accented letters count as their base letter', () => {
    expect(analyse('éèêà').counts[4]).toBe(3);
    expect(analyse('éèêà').letters).toBe(4);
  });

  it('English plain text matches English, French plain text matches French', () => {
    const e = analyse(ENGLISH[0]!, 'auto');
    expect(e.lang).toBe('en');
    expect(e.excess.en).toBeLessThan(0.15);
    expect(e.excess.fr).toBeGreaterThan(e.excess.en);
    const f = analyse(FRENCH[0]!, 'auto');
    expect(f.lang).toBe('fr');
    expect(f.ioc).toBeGreaterThan(0.07);
  });

  it('a Caesar shift is found as the best simple key', () => {
    const s = analyse(
      'WKH TXLFN EURZQ IRA MXPSV RYHU WKH ODCB GRJ WKLV VHQWHQFH KDV HQRXJK OHWWHUV WR VKRZ D VKLIW',
    );
    expect(s.caesar.b).toBe(3);
    expect(s.caesar.read).toBeGreaterThan(25);
  });
});

// ------------------------------------------------------------------------------------------
// The ranking of families on ciphertexts made with the project's own tools

/** Each cipher kind and the family that must be ranked for it. */
const EXPECTED: [Kind, FamilyId, 'sure' | 'ambiguous' | 'partial'][] = [
  ['caesar', 'caesar', 'sure'],
  ['atbash', 'atbash', 'sure'],
  ['affine', 'affine', 'sure'],
  ['substitution', 'substitution', 'sure'],
  ['vigenere', 'vigenere', 'sure'],
  ['beaufort', 'vigenere', 'sure'],
  // Letter statistics cannot tell an Autokey or a rotor machine from a long Vigenère key.
  ['autokey', 'vigenere', 'ambiguous'],
  ['columnar', 'transposition', 'sure'],
  ['rail-fence', 'transposition', 'sure'],
  ['playfair', 'playfair', 'sure'],
  ['bifid', 'bifid', 'sure'],
  ['adfgx', 'adfgx', 'sure'],
  ['adfgvx', 'adfgx', 'sure'],
  ['hill', 'hill', 'sure'],
  // 100 trigrams repeat too rarely to show a 3 x 3 key every time: a hint when they do.
  ['hill3', 'hill', 'partial'],
  ['enigma', 'flat', 'ambiguous'],
];

const TEXTS = [...ENGLISH, ...FRENCH];
const VARIANTS = [0, 1, 2, 3];
const LAYOUTS = ['continuous', 'fives'] as const;

describe('ranking of the families, 300 letters', () => {
  const table: Record<string, { n: number; ranks: Record<number, number>; worst: string }> = {};

  describe.each(EXPECTED)('%s', (kind, family, certainty) => {
    it(`ranks ${family} ${certainty === 'sure' ? 'first' : certainty === 'partial' ? 'in the top 3 most of the time' : 'in the top 3'}`, async () => {
      const ranks: number[] = [];
      const misses: string[] = [];
      for (const variant of VARIANTS) {
        for (const [ti, text] of TEXTS.entries()) {
          for (const layout of LAYOUTS) {
            const ct = await makeSample(kind, text, variant, layout);
            const families = rankFamilies(analyse(ct));
            const rank = families.findIndex((f) => f.id === family) + 1 || 99;
            ranks.push(rank);
            if (rank > 1) {
              misses.push(
                `variant ${variant} text ${ti} ${layout}: rank ${rank}: ${families
                  .slice(0, 3)
                  .map((f) => `${f.id} ${f.score}`)
                  .join(', ')}`,
              );
            }
          }
        }
      }
      const counts: Record<number, number> = {};
      for (const r of ranks) counts[Math.min(r, 4)] = (counts[Math.min(r, 4)] ?? 0) + 1;
      table[kind] = { n: ranks.length, ranks: counts, worst: misses[0] ?? '' };
      // Always in the top 3; for the sure ones also first almost every time.
      if (certainty === 'partial') {
        expect(ranks.filter((r) => r <= 3).length / ranks.length).toBeGreaterThanOrEqual(0.8);
      } else {
        expect(Math.max(...ranks), misses.join('\n')).toBeLessThanOrEqual(3);
      }
      if (certainty === 'sure') {
        expect(ranks.filter((r) => r === 1).length / ranks.length).toBeGreaterThanOrEqual(0.95);
      }
    });
  });

  it('prints the rank table', () => {
    const lines = EXPECTED.map(([kind, family]) => {
      const t = table[kind];
      if (!t) return `${kind}: not run`;
      const c = (r: number) => String(t.ranks[r] ?? 0).padStart(3);
      return `${kind.padEnd(13)} -> ${family.padEnd(13)} n=${t.n}  rank1 ${c(1)}  rank2 ${c(2)}  rank3 ${c(3)}  worse ${c(4)}`;
    });
    console.info(`Rank of the right family, 300 letters:\n${lines.join('\n')}`);
    expect(lines).toHaveLength(EXPECTED.length);
  });
});

describe('ranking in natural layout (spaces and punctuation kept)', () => {
  it.each([
    ['caesar', 'Caesar / ROT shift'],
    ['atbash', 'Atbash'],
    ['affine', 'Affine cipher'],
    ['substitution', 'Monoalphabetic substitution'],
  ] as const)('%s on prose with spaces and punctuation', async (kind, name) => {
    for (const [ti, text] of TEXTS.entries()) {
      const ct = await makeSample(kind, text, ti, 'natural');
      expect(ct).toMatch(/[ ,.]/);
      const result = await run(ct);
      expect(rankOf(result, name), `${kind} text ${ti}: ${ct.slice(0, 60)}`).toBeLessThanOrEqual(2);
    }
  });
});

describe('plain language', () => {
  it.each(ENGLISH.map((t, i) => [i, t] as const))(
    'English passage %i reads as plain language',
    async (_i, text) => {
      const result = await run(text);
      expect(ranking(result)[0]!.name).toContain('Plain language');
      expect(notes(result)[0]).toContain('plain language');
    },
  );

  it.each(FRENCH.map((t, i) => [i, t] as const))(
    'French passage %i reads as plain language',
    async (_i, text) => {
      const result = await run(text);
      expect(ranking(result)[0]!.name).toContain('Plain language');
      expect(ranking(result)[0]!.why).toContain('French');
    },
  );

  it('English prose with the spaces removed is still plain language', async () => {
    const result = await run(lettersOf(PROSE_B, 400));
    expect(ranking(result)[0]!.name).toContain('Plain language');
  });

  it('a transposed text is not mistaken for plain language', async () => {
    const result = await run(await makeSample('columnar', PROSE_A, 0, 'fives'));
    expect(ranking(result)[0]!.name).toContain('Transposition');
    expect(rankOf(result, 'Plain language')).toBe(99);
  });
});

// ------------------------------------------------------------------------------------------
// Encodings come from the registry's detect(), and come first when they decode to text

describe('encodings', () => {
  const plain = PROSE_A.slice(0, 200);

  it('Base64 text decodes to readable text and is listed first', async () => {
    const result = await run(await makeSample('base64', PROSE_A));
    const rows = ranking(result);
    expect(rows[0]!.name).toBe('Encoding: Base64');
    expect(rows[0]!.why).toContain('decodes to: The old lighthouse keeper');
    expect(notes(result)[0]).toContain('encoding rather than a cipher');
  });

  it('hex text', async () => {
    const result = await run(await makeSample('hex', PROSE_A));
    expect(ranking(result)[0]!.name).toBe('Encoding: Hex');
  });

  it('letters of a cipher are not taken for Base64 just because the characters fit', async () => {
    for (const kind of ['vigenere', 'playfair', 'columnar'] as const) {
      const result = await run(await makeSample(kind, PROSE_A, 0, 'continuous'));
      expect(ranking(result).map((r) => r.name)).not.toContain('Encoding: Base64');
      expect(rankOf(result, 'Base64')).toBe(99);
    }
  });

  it('URL-encoded, binary, Morse, HTML entities and Unicode escapes', async () => {
    const samples: [string, string, string][] = [
      [
        'URL',
        '%48%65%6c%6c%6f%20%74%68%65%20%77%6f%72%6c%64%2c%20%74%68%69%73%20%69%73%20%74%65%78%74',
        'URL',
      ],
      [
        'binary',
        '01001000 01100101 01101100 01101100 01101111 00100000 01110111 01101111 01110010 01101100 01100100',
        'Binary',
      ],
      ['Morse', '.... . .-.. .-.. --- / .-- --- .-. .-.. -..', 'Morse'],
      ['HTML', '&#72;&#101;&#108;&#108;&#111;&#32;&#119;&#111;&#114;&#108;&#100;', 'HTML'],
      [
        'Unicode',
        '\\u0048\\u0065\\u006c\\u006c\\u006f\\u0020\\u0077\\u006f\\u0072\\u006c\\u0064',
        'Unicode',
      ],
    ];
    for (const [label, input, name] of samples) {
      const result = await run(input);
      expect(ranking(result)[0]!.name, label).toContain(name);
    }
  });

  it('a chain of decoders is found by Auto-decode (base64 of hex)', async () => {
    const inner = toHex(utf8Encode(plain));
    const result = await run(toBase64(utf8Encode(inner)));
    const top = ranking(result)[0]!;
    expect(top.fit).toBeGreaterThanOrEqual(90);
    expect(top.why).toContain('Auto-decode finds');
  });

  it('a hash is named by the hash identifier, not guessed as a cipher', async () => {
    const result = await run('5d41402abc4b2a76b9719d911017c592');
    expect(ranking(result)[0]!.name).toContain('Hash identifier');
  });

  it('a Playfair-looking ciphertext keeps the Playfair tool rule and the statistics together', async () => {
    const result = await run(await makeSample('playfair', PROSE_A, 0, 'fives'));
    const top = ranking(result)[0]!;
    expect(top.name).toBe('Playfair / Two-square / Four-square');
    expect(top.why).toContain('recognises the shape');
    expect(top.why).toContain('no letter is doubled inside any of the');
  });

  it('digits 1-5 in pairs are Polybius coordinates', async () => {
    const polybius = await makeSample('polybius', PROSE_A, 1);
    expect(polybius).toMatch(/^[1-5]+$/);
    expect(rankOf(await run(polybius), 'Polybius')).toBe(1);
    const spaced = await makeSample('polybius', PROSE_A, 0);
    expect(rankOf(await run(spaced), 'Polybius')).toBe(1);
  });

  it('Bacon: two symbols in a multiple of 5', async () => {
    for (const variant of [0, 1]) {
      const result = await run(await makeSample('bacon', PROSE_A, variant));
      expect(rankOf(result, 'Bacon'), `variant ${variant}`).toBe(1);
    }
  });

  it('Bacon hidden in letter case', async () => {
    const letters = lettersOf(PROSE_A, 40);
    let bits = 0x5a5a5a5a;
    let cased = '';
    for (const ch of letters) {
      cased += bits & 1 ? ch : ch.toLowerCase();
      bits = (bits * 1103515245 + 12345) >>> 0;
      bits ^= bits >>> 7;
    }
    const result = await run(cased);
    expect(rankOf(result, 'Bacon')).toBeLessThanOrEqual(2);
  });

  it('Nihilist numbers are recognised by the Nihilist tool', async () => {
    const nihilist = await makeSample('nihilist', PROSE_A, 0);
    const result = await run(nihilist);
    expect(rankOf(result, 'Nihilist')).toBeLessThanOrEqual(2);
  });

  it('ADFGX with the coordinates not transposed is a Polybius square, not ADFGX', async () => {
    // Each letter of the plaintext becomes two coordinate letters, read in order.
    const plainPairs = (await makeSample('polybius', PROSE_A, 1))
      .replace(/1/g, 'A')
      .replace(/2/g, 'D')
      .replace(/3/g, 'F')
      .replace(/4/g, 'G')
      .replace(/5/g, 'X');
    const result = await run(plainPairs);
    expect(rankOf(result, 'Polybius')).toBeLessThanOrEqual(2);
    expect(rankOf(result, 'Polybius')).toBeLessThan(rankOf(result, 'ADFGX'));
  });
});

describe('bytes behind an encoding', () => {
  it('AES output in hex: random-looking, a whole number of blocks', async () => {
    // 96 bytes: too long for any hash, a whole number of 16-byte blocks.
    const result = await run(RAW.aes128cbc + RAW.aes256cbc + RAW.aes192cbc + RAW.tdes3cbc);
    const rows = ranking(result);
    expect(rows[0]!.name).toBe('Symmetric ciphers');
    expect(rows[0]!.why).toContain('multiple of 16');
    expect(rows.map((r) => r.name)).not.toContain('Hash identifier');
  });

  it('32 random bytes in hex are as likely a SHA-256 as an AES block pair: both are listed', async () => {
    const result = await run(RAW.aes128cbc);
    expect(rankOf(result, 'Hash identifier')).toBeLessThanOrEqual(2);
    expect(rankOf(result, 'Symmetric ciphers')).toBeLessThanOrEqual(2);
  });

  it('an OpenSSL Salted__ blob is named by the Symmetric ciphers tool', async () => {
    const result = await run(SALTED_PBKDF2);
    expect(ranking(result)[0]!.name).toBe('Symmetric ciphers');
  });

  it('single-byte XOR in hex is found with its key', async () => {
    const bytes = utf8Encode(PROSE_A.slice(0, 120)).map((b) => b ^ 0x5a);
    const result = await run(toHex(bytes));
    const top = ranking(result)[0]!;
    expect(top.name).toBe('XOR');
    expect(top.why).toContain('0x5a');
  });

  it('repeating-key XOR in hex is listed as XOR', async () => {
    const result = await run(await makeSample('xor-hex', PROSE_A, 0));
    expect(rankOf(result, 'XOR')).toBeLessThanOrEqual(2);
  });
});

// ------------------------------------------------------------------------------------------
// The output, its honesty, its buttons

describe('output', () => {
  it('says that short texts give weak evidence', async () => {
    const result = await run('KHOOR ZRUOG');
    expect(notes(result).some((n) => n.includes('Only 10 letters'))).toBe(true);
    const long = await run(await makeSample('vigenere', PROSE_A, 0, 'fives'));
    expect(notes(long).some((n) => n.includes('Only '))).toBe(false);
  });

  it('always says that statistics only point in a direction', async () => {
    for (const text of [PROSE_A, 'KHOOR ZRUOG', await makeSample('playfair', PROSE_A, 0)]) {
      const result = await run(text);
      expect(notes(result).some((n) => n.includes('Statistics only point in a direction'))).toBe(
        true,
      );
    }
  });

  it('lists the statistics asked for, each with a line saying what it means', async () => {
    const result = await run(await makeSample('vigenere', PROSE_A, 0, 'fives'));
    const kv = (label: string) =>
      result.find((o): o is Kv => o.type === 'kv' && (o.label ?? '').startsWith(label))!;
    const stats = kv('Statistics');
    const names = stats.entries.map(([k]) => k);
    for (const name of [
      'Length',
      'Alphabet used',
      'Distinct symbols',
      'Index of coincidence',
      'Chi-squared vs English / French',
      'Entropy',
    ]) {
      expect(names).toContain(name);
    }
    const checks = kv('Quick checks');
    for (const [name, text] of [...stats.entries, ...checks.entries]) {
      // The value, a dash, then a sentence saying what it means.
      const [, meaning] = text.split(' — ');
      expect(meaning?.length ?? 0, name).toBeGreaterThan(20);
    }
    const checkNames = checks.entries.map(([k]) => k);
    for (const name of [
      'Doubled letters',
      'Even length',
      '25 letters, J missing',
      'Digit pairs 11–55',
      'Length divisible by',
      'Only A D F G V X',
      'Only two symbols',
    ]) {
      expect(checkNames).toContain(name);
    }
    const ioc = stats.entries.find(([k]) => k === 'Index of coincidence')!;
    expect(ioc[1]).toMatch(/English 0\.067 · French 0\.078 · random 0\.038/);
    const periods = tableOf(result, 'Index of coincidence by period');
    expect(periods.rows).toHaveLength(20);
    // A key of 5 lifts the columns of 5, 10, 15 and 20.
    for (const p of [5, 10, 15, 20]) expect(Number(periods.rows[p - 1]![1])).toBeGreaterThan(0.055);
    expect(Number(periods.rows[0]![1])).toBeLessThan(0.05);
    expect(tableOf(result, 'Kasiski').rows.length).toBeGreaterThan(0);
  });

  it('does not read a key length into plain language', async () => {
    const result = await run(ENGLISH[0]!.slice(0, 160));
    const stats = result.find((o): o is Kv => o.type === 'kv' && (o.label ?? '') === 'Statistics')!;
    const row = stats.entries.find(([k]) => k === 'Likely key length (periodic IoC)')!;
    expect(row[1].startsWith('none')).toBe(true);
  });

  it('opens the right tools, with options those tools really have', async () => {
    const byId = new Map(TOOLS.map((t) => [t.id, t] as const));
    const seen = new Set<string>();
    const samples: string[] = [
      ...(await Promise.all(EXPECTED.map(([kind]) => makeSample(kind, PROSE_B, 1, 'fives')))),
      await makeSample('base64', PROSE_B),
      await makeSample('polybius', PROSE_B, 1),
      await makeSample('bacon', PROSE_B, 0),
      await makeSample('nihilist', PROSE_B, 0),
      RAW.aes128cbc + RAW.aes256cbc + RAW.aes192cbc + RAW.tdes3cbc,
    ];
    for (const text of samples) {
      const result = await run(text);
      const all = buttons(result);
      expect(all.length, text.slice(0, 40)).toBeGreaterThanOrEqual(1);
      expect(all.filter((a) => a.primary)).toHaveLength(1);
      expect(all[0]!.primary).toBe(true);
      for (const a of all) {
        const open = a.open;
        expect(open, a.label).toBeDefined();
        const target = byId.get(open!.tool);
        expect(target, `tool ${open!.tool}`).toBeDefined();
        expect(open!.text).toBe(text);
        expect(a.label).toMatch(/Open in /);
        seen.add(open!.tool);
        for (const [key, value] of Object.entries(a.options)) {
          const spec = target!.options?.[key];
          expect(spec, `${open!.tool} has no option ${key}`).toBeDefined();
          if (spec!.type === 'select') {
            expect(
              spec!.choices.map((c) => c.value),
              `${open!.tool}.${key}`,
            ).toContain(value);
          } else if (spec!.type === 'number') expect(typeof value).toBe('number');
          else if (spec!.type === 'bool') expect(typeof value).toBe('boolean');
          else expect(typeof value).toBe('string');
        }
      }
    }
    // The families point to these tools.
    for (const id of [
      'caesar',
      'atbash',
      'affine',
      'substitution',
      'vigenere',
      'columnar',
      'rail-fence',
      'playfair',
      'bifid',
      'adfgvx',
      'hill',
      'enigma',
      'polybius',
      'bacon',
      'base64',
      'symmetric',
      'frequency',
    ]) {
      expect(seen.has(id), `a button opens ${id}`).toBe(true);
    }
  });

  it('the first button opens the top family with the options that fit it', async () => {
    const first = async (text: string) => buttons(await run(text))[0]!;
    expect(await first(await makeSample('playfair', PROSE_A, 0))).toMatchObject({
      open: { tool: 'playfair' },
      options: { mode: 'solve', variant: 'playfair', language: 'english' },
    });
    expect(await first(await makeSample('vigenere', PROSE_A, 0))).toMatchObject({
      open: { tool: 'vigenere' },
      options: { mode: 'crack', variant: 'vigenere' },
    });
    expect(await first(await makeSample('caesar', PROSE_A, 0))).toMatchObject({
      open: { tool: 'caesar' },
      options: { mode: 'brute' },
    });
    expect(await first(await makeSample('adfgx', PROSE_A, 0))).toMatchObject({
      open: { tool: 'adfgvx' },
      options: { variant: 'adfgx', mode: 'decrypt' },
    });
    expect(await first(await makeSample('base64', PROSE_A, 0))).toMatchObject({
      open: { tool: 'base64' },
      options: { mode: 'decode' },
    });
    // The language option of this tool goes on to the solvers.
    const ct = await makeSample('playfair', FRENCH[0]!, 0);
    const french = buttons(await tool.run(ct, { language: 'fr' }))[0]!;
    expect(french.options).toMatchObject({ language: 'french' });
  });

  it('does not take the language option for granted', async () => {
    const ct = await makeSample('caesar', FRENCH[1]!, 0);
    const auto = ranking(await run(ct, 'auto'))[0]!;
    expect(auto.name).toContain('Caesar');
    expect(auto.why).toContain('French');
    const forced = ranking(await run(ct, 'en'))[0]!;
    expect(forced.why).toContain('English');
  });

  it('refuses an empty text with a sentence', async () => {
    await expect(run('   \n ')).rejects.toBeInstanceOf(ToolError);
  });

  it('copes with text that is not a cipher at all', async () => {
    for (const text of ['!!!???', '日本語のテキスト', '1', 'a', '😀😀😀', '0000000000']) {
      const result = await run(text);
      expect(notes(result).length).toBeGreaterThan(0);
    }
  });

  it('handles a very long text in reasonable time', async () => {
    const big = lettersOf(PROSE_A.repeat(800), 250_000);
    const t0 = performance.now();
    const result = await run(big);
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(notes(result).some((n) => n.includes('first 100,000 characters'))).toBe(true);
  });

  it('every message it can show exists in English', async () => {
    const files = [
      'cipher-identify.ts',
      '_cipher-identify-rank.ts',
      '_cipher-identify-report.ts',
      '_cipher-identify-encodings.ts',
    ];
    const keys = new Set<string>();
    for (const file of files) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/\bT\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]!);
      for (const m of src.matchAll(/key:\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]!);
      for (const m of src.matchAll(/'(reason\.[a-zA-Z0-9_.]+)'/g)) keys.add(m[1]!);
    }
    for (const id of ['caesar', 'atbash', 'affine']) keys.add(`reason.${id}.fit`);
    keys.delete('detect.letters');
    keys.add('detect.letters');
    expect(keys.size).toBeGreaterThan(100);
    const missing = [...keys].filter((k) => !(`tool.cipher-identify.${k}` in en));
    expect(missing).toEqual([]);
  });
});

describe('triage', () => {
  const detect = (text: string) => tool.detect!({ text, bytes: utf8Encode(text) });

  it('offers itself for a ciphertext of letters, not for prose', async () => {
    expect(detect(await makeSample('vigenere', PROSE_A, 0, 'fives'))?.score).toBeGreaterThanOrEqual(
      0.4,
    );
    expect(detect(await makeSample('columnar', PROSE_A, 0))?.score).toBeGreaterThanOrEqual(0.4);
    expect(detect(PROSE_A)).toBeNull();
    expect(detect(FRENCH[0]!)).toBeNull();
    expect(detect('hello')).toBeNull();
    expect(detect('12 34 56')).toBeNull();
  });
});

describe('sample files', () => {
  it('are the ones the tools make', async () => {
    const built = await buildSamples(PROSE_A);
    for (const [name, text] of Object.entries(built)) {
      const file = readFileSync(
        new URL(`../../../public/samples/${name}`, import.meta.url),
        'utf8',
      );
      expect(file, name).toBe(text);
    }
  });

  it('every example runs and says what it should', async () => {
    const opts = { language: 'auto' } as const;
    for (const ex of tool.examples) {
      const text =
        typeof ex.input === 'string'
          ? ex.input
          : 'sample' in ex.input
            ? readFileSync(
                new URL(`../../../public/samples/${ex.input.sample}`, import.meta.url),
                'utf8',
              )
            : '';
      const result = await tool.run(text, { ...opts, ...ex.options } as never);
      const flat = result
        .map((o) => (o.type === 'table' ? o.rows.flat().join(' ') : 'text' in o ? o.text : ''))
        .join('\n');
      expect(flat, ex.label).toContain(ex.expect);
    }
  });
});

describe('plaintexts are what the tests say', () => {
  it('the corpus passages are long enough and differ', () => {
    for (const t of [...ENGLISH, ...FRENCH])
      expect(lettersOf(t).length).toBeGreaterThanOrEqual(300);
    expect(new Set([...ENGLISH, ...FRENCH]).size).toBe(ENGLISH.length + FRENCH.length);
    expect(printableRatio(utf8Encode(inFives('ABCDEFGHIJ')))).toBe(1);
  });
});
