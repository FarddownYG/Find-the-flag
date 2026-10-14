import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ToolResult } from '../../core/types';
import { parseLetterKey } from './_classical';
import { PROSE_A, PROSE_B } from './_sample-text';
import tool, { crackVigenere, vigenereTransform, type Variant } from './vigenere';

const k = (s: string) => parseLetterKey(s);

const run = (text: string, options: Partial<Parameters<typeof tool.run>[1]>): ToolResult =>
  tool.run(text, {
    mode: 'decrypt',
    variant: 'vigenere',
    key: '',
    maxLen: 20,
    lettersOnly: true,
    ...options,
  }) as ToolResult;

describe('vigenere', () => {
  it('matches the classic ATTACKATDAWN / LEMON vector', () => {
    expect(vigenereTransform('ATTACKATDAWN', k('LEMON'), 'vigenere', false)).toBe('LXFOPVEFRNHR');
    expect(vigenereTransform('LXFOPVEFRNHR', k('LEMON'), 'vigenere', true)).toBe('ATTACKATDAWN');
  });

  it('preserves case and punctuation and only advances the key on letters', () => {
    const enc = vigenereTransform('Attack at dawn!', k('LEMON'), 'vigenere', false);
    expect(enc).toBe('Lxfopv ef rnhr!');
    expect(vigenereTransform(enc, k('LEMON'), 'vigenere', true)).toBe('Attack at dawn!');
  });

  it('can let spaces and punctuation consume key letters', () => {
    const enc = vigenereTransform('ab cd', k('bcde'), 'vigenere', false, false);
    // keys by character position: a0=b b1=c ' '2=d (consumed) c3=e d4=b
    expect(enc).toBe('bd ge');
    expect(vigenereTransform(enc, k('bcde'), 'vigenere', true, false)).toBe('ab cd');
  });

  it('Beaufort is its own inverse and matches a hand-computed vector', () => {
    const enc = vigenereTransform('ATTACKATDAWN', k('LEMON'), 'beaufort', false);
    expect(enc).toBe('LLTOLBETLNPR');
    expect(vigenereTransform(enc, k('LEMON'), 'beaufort', true)).toBe('ATTACKATDAWN');
  });

  it('Autokey matches the published MEET AT THE FOUNTAIN / KILT vector', () => {
    const enc = vigenereTransform('meet at the fountain', k('KILT'), 'autokey', false);
    expect(enc).toBe('wmpm mx xae yhbryoca');
    expect(vigenereTransform(enc, k('KILT'), 'autokey', true)).toBe('meet at the fountain');
  });

  it('round-trips real text for every variant', () => {
    for (const v of ['vigenere', 'beaufort', 'autokey'] as const) {
      const enc = vigenereTransform(PROSE_B, k('Hidden Key'), v, false);
      expect(enc).not.toBe(PROSE_B);
      expect(vigenereTransform(enc, k('Hidden Key'), v, true)).toBe(PROSE_B);
    }
  });

  it('decrypts through the tool and rejects an empty key', () => {
    expect(resultToText(run('LXFOPVEFRNHR', { key: 'lemon' }))).toBe('ATTACKATDAWN');
    expect(() => run('LXFOPVEFRNHR', { key: '' })).toThrow(ToolError);
    expect(() => run('LXFOPVEFRNHR', { key: '1234' })).toThrow(/at least one letter/);
    expect(() => run('1234 5678', { key: 'abc' })).toThrow(ToolError);
  });
});

describe('vigenere crack', () => {
  const cases: [Variant, string, string][] = [
    ['vigenere', 'LEMON', PROSE_A],
    ['vigenere', 'CRYPTOGRAPHY', PROSE_B],
    ['vigenere', 'KEY', PROSE_B],
    ['vigenere', 'FLAGGER', PROSE_A],
    ['beaufort', 'LANTERN', PROSE_A],
    ['beaufort', 'SECRET', PROSE_B],
    ['autokey', 'QUEEN', PROSE_A],
    ['autokey', 'PRIMER', PROSE_B],
  ];

  it.each(cases)('recovers the %s key %s from real English', (variant, key, plain) => {
    const cipher = vigenereTransform(plain, k(key), variant, false);
    const { candidates } = crackVigenere(cipher, variant, 20);
    expect(candidates[0]!.key).toBe(key);
    expect(candidates[0]!.text).toBe(plain);
    const out = resultToText(run(cipher, { mode: 'crack', variant }));
    expect(out).toContain(`key ${key} (length ${key.length})`);
    expect(out).toContain(plain.slice(0, 80));
  });

  it('reduces a repeated key to its period', () => {
    const cipher = vigenereTransform(PROSE_A, k('LEMONLEMON'), 'vigenere', false);
    expect(crackVigenere(cipher, 'vigenere', 20).candidates[0]!.key).toBe('LEMON');
  });

  it('cracks a short flag-bearing message', () => {
    const plain =
      'Congratulations, you broke the cipher without ever knowing the key. The flag is ' +
      'flag{kasiski_would_be_proud} and it was hiding in plain sight, so keep your frequency ' +
      'tables handy for the next challenge.';
    const cipher = vigenereTransform(plain, k('raven'), 'vigenere', false);
    expect(crackVigenere(cipher, 'vigenere', 20).candidates[0]!.key).toBe('RAVEN');
  });

  it('works when the key advances over spaces too', () => {
    const cipher = vigenereTransform(PROSE_B, k('WINTER'), 'vigenere', false, false);
    const { candidates } = crackVigenere(cipher, 'vigenere', 20, false);
    expect(candidates[0]!.key).toBe('WINTER');
    expect(candidates[0]!.text).toBe(PROSE_B);
  });

  it('shows a ranked table, IoC and a Kasiski hint', () => {
    const cipher = vigenereTransform(PROSE_A, k('LEMON'), 'vigenere', false);
    const blocks = run(cipher, { mode: 'crack' });
    const table = blocks.find((b) => b.type === 'table');
    expect(table?.type === 'table' && table.columns).toEqual([
      'Length',
      'Key',
      'Avg IoC',
      'Score',
      'Result',
    ]);
    expect(table?.type === 'table' && table.rows[0]!.slice(0, 2)).toEqual([5, 'LEMON']);
    expect(resultToText(blocks)).toContain('Kasiski');
  });

  it('asks for more text when the ciphertext is too short', () => {
    expect(() => run('LXFOPVEFRNHR', { mode: 'crack' })).toThrow(/longer ciphertext/);
  });
});
