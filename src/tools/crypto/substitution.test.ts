import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import { makeRng } from './_classical';
import { PROSE_A, PROSE_B } from './_sample-text';
import tool, { autoSolve, parseSubstitutionKey, substitutionApply } from './substitution';

type Opts = Parameters<typeof tool.run>[1];
const run = (text: string, options: Partial<Opts> = {}): ToolResult =>
  tool.run(text, { mode: 'solve', direction: 'decrypt', key: '', ...options }) as ToolResult;

/** Random cipher alphabet (plain a..z -> letters), deterministic per seed. */
function randomAlphabet(seed: number): string {
  const rng = makeRng(seed);
  const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  for (let i = 25; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [letters[i], letters[j]] = [letters[j]!, letters[i]!];
  }
  return letters.join('');
}

const encrypt = (text: string, alphabet: string) =>
  substitutionApply(text, parseSubstitutionKey(alphabet), 'encrypt').text;

const lettersOf = (s: string) => s.replace(/[^a-z]/gi, '').toLowerCase();

function accuracy(plain: string, guess: string): number {
  const a = lettersOf(plain);
  const b = lettersOf(guess);
  let ok = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) ok++;
  return ok / a.length;
}

describe('substitution key mode', () => {
  const KEYBOARD = 'QWERTYUIOPASDFGHJKLZXCVBNM';

  it('encrypts and decrypts with a 26-letter alphabet, keeping case and punctuation', () => {
    const enc = encrypt('Flag{Hello, World}', KEYBOARD);
    expect(enc).toBe('Ysqu{Itssg, Vgksr}');
    expect(substitutionApply(enc, parseSubstitutionKey(KEYBOARD), 'decrypt').text).toBe(
      'Flag{Hello, World}',
    );
  });

  it('accepts pairs in several spellings and a partial alphabet with _', () => {
    expect(parseSubstitutionKey('a=q, b:w c->e')[0]).toBe(16);
    const p = parseSubstitutionKey('QW_RT' + '_'.repeat(21));
    expect(p.slice(0, 5)).toEqual([16, 22, -1, 17, 19]);
    expect(p.filter((x) => x >= 0)).toHaveLength(4);
  });

  it('marks unknown letters in a partial key', () => {
    const out = resultToText(run('Xli Qymgo', { mode: 'key', key: 't=x, h=l, e=i' }));
    expect(out).toContain('the QYMGO');
    expect(out).toContain('3 of 26 letters are in the key');
    expect(out).toContain('lowercase = decrypted, UPPERCASE = not in the key yet.');
  });

  it('rejects malformed or contradictory keys', () => {
    expect(() => parseSubstitutionKey('')).toThrow(ToolError);
    expect(() => parseSubstitutionKey('abc')).toThrow(/not a valid pair/);
    expect(() => parseSubstitutionKey('a=b, a=c')).toThrow(/two different cipher letters/);
    expect(() => parseSubstitutionKey('a=b, c=b')).toThrow(/used for two plain letters/);
    expect(() => parseSubstitutionKey('AABCDEFGHIJKLMNOPQRSTUVWXY')).toThrow(/two plain letters/);
    expect(() => run('', { mode: 'key', key: 'a=b' })).toThrow(ToolError);
  });
});

describe('substitution auto-solve', () => {
  it('solves 300+ letters of English with >= 95% of the letters right, in well under 2 s', () => {
    const cases: [string, number][] = [
      [PROSE_A, 11],
      [PROSE_B, 12],
      [PROSE_A.slice(0, 380), 13],
      [PROSE_B.slice(0, 380), 14],
    ];
    for (const [plain, seed] of cases) {
      expect(lettersOf(plain).length).toBeGreaterThan(300);
      const cipher = encrypt(plain, randomAlphabet(seed));
      const t0 = performance.now();
      const sol = autoSolve(cipher);
      const ms = performance.now() - t0;
      expect(accuracy(plain, sol.text)).toBeGreaterThanOrEqual(0.95);
      expect(ms).toBeLessThan(2000);
    }
  });

  it('solves public-domain prose and shouting capitals too', () => {
    const dickens =
      'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of ' +
      'foolishness, it was the epoch of belief, it was the epoch of incredulity, it was the season of Light, ' +
      'it was the season of Darkness, it was the spring of hope, it was the winter of despair, we had ' +
      'everything before us, we had nothing before us, we were all going direct to Heaven, we were all ' +
      'going direct the other way.';
    const orders =
      'THE ENEMY ATTACKS AT DAWN FROM THE NORTHERN RIDGE WITH THREE HUNDRED INFANTRY AND ARTILLERY SUPPORT. ' +
      'HOLD THE BRIDGE AT ALL COSTS UNTIL REINFORCEMENTS ARRIVE FROM THE SOUTH. DESTROY ALL DOCUMENTS BEFORE ' +
      'LEAVING THE HEADQUARTERS AND CONFIRM RECEIPT OF THIS MESSAGE BY RADIO IMMEDIATELY.';
    for (const [plain, seed] of [
      [dickens, 41],
      [orders, 42],
    ] as const) {
      const sol = autoSolve(encrypt(plain, randomAlphabet(seed)));
      expect(sol.text).toBe(plain);
    }
  });

  it('still gets most of a short (about 150 letter) message', () => {
    const plain = PROSE_B.slice(0, 190);
    const sol = autoSolve(encrypt(plain, randomAlphabet(21)));
    expect(accuracy(plain, sol.text)).toBeGreaterThanOrEqual(0.85);
  });

  it('is deterministic', () => {
    const cipher = encrypt(PROSE_A, randomAlphabet(5));
    const a = resultToText(run(cipher));
    const b = resultToText(run(cipher));
    expect(a).toBe(b);
  });

  it('keeps case, punctuation and digits, and returns a usable key', () => {
    const plain = 'The 3 old men, who lived by the sea, said: "' + PROSE_A.slice(0, 340) + '"';
    const alphabet = randomAlphabet(33);
    const cipher = encrypt(plain, alphabet);
    const sol = autoSolve(cipher);
    expect(sol.text).toBe(plain);
    // The reported key, fed back to Key mode, decrypts to the same text.
    const key = resultToText(run(cipher)).match(/Cipher alphabet: (\S+)/)![1]!;
    const back = resultToText(run(cipher, { mode: 'key', key: key.replace(/_/g, '?') }));
    expect(back).toContain(plain);
  });

  it('breaks a cryptogram that hides a flag', () => {
    const plain =
      'Congratulations on cracking a substitution cipher without knowing the key. Every letter was ' +
      'swapped for another, but English leaves fingerprints everywhere: the most common letters, the ' +
      'little words, the doubled consonants. Hill climbing found the key from those hints alone, and ' +
      'your reward is flag{substitution_solved_by_hill_climbing}. Keep that trick handy for the next puzzle.';
    const out = resultToText(run(encrypt(plain, randomAlphabet(99)).toLowerCase()));
    expect(out).toContain('flag{substitution_solved_by_hill_climbing}');
    expect(out).toContain('reads like English');
  });

  it('warns on short text and refuses tiny text', () => {
    const out = resultToText(
      run(encrypt('the quick brown fox jumps over the lazy dog', randomAlphabet(2))),
    );
    expect(out).toContain('Only 35 letters');
    expect(() => run('abc def')).toThrow(/Only 6 letters/);
    expect(() => run('1234')).toThrow(ToolError);
  });
});
