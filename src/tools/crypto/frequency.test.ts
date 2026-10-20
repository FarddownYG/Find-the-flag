import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import { registeredTools, setRegisteredTools } from '../../core/tool-list';
import type { AnyTool, ToolResult } from '../../core/types';
import { parseLetterKey } from './_classical';
import { PROSE_A, PROSE_B } from './_sample-text';
import cipherIdentify from './cipher-identify';
import tool, { analyse } from './frequency';
import { vigenereTransform } from './vigenere';

const run = (text: string, options: Partial<Parameters<typeof tool.run>[1]> = {}): ToolResult =>
  tool.run(text, { top: 10, across: false, ...options }) as ToolResult;

const caesar = (text: string, n: number) =>
  text.replace(/[a-z]/gi, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(base + ((ch.charCodeAt(0) - base + n) % 26));
  });

describe('frequency', () => {
  it('computes exact counts, percentages and IoC', () => {
    const out = resultToText(run('AABBBC'));
    expect(out).toContain('Index of coincidence: 0.2667');
    expect(out).toContain('Letters: 6');
    expect(out).toContain('Distinct letters: 3');
    expect(out).toContain('B\t3\t50.0\t1.5\t+48.5');
    expect(out).toContain('A\t2\t33.3\t8.2\t+25.1');
    expect(out).toContain('C\t1\t16.7\t2.8\t+13.9');
    // sorted by count
    expect(out.indexOf('B\t3')).toBeLessThan(out.indexOf('A\t2'));
    expect(out).toContain('Cipher order: BAC');
  });

  it('calls English text plain English / transposition', () => {
    for (const t of [PROSE_A, PROSE_B]) {
      const r = analyse(t);
      expect(r.ioc).toBeGreaterThan(0.06);
      expect(r.verdict.text).toContain('plain English or a transposition');
      expect(r.keyLength).toBeNull();
    }
  });

  it('calls a shifted text monoalphabetic', () => {
    for (const n of [3, 13]) {
      const r = analyse(caesar(PROSE_B, n));
      expect(r.ioc).toBeGreaterThan(0.06);
      expect(r.verdict.text).toContain('monoalphabetic substitution');
    }
  });

  it('calls Vigenère text polyalphabetic and estimates the key length', () => {
    for (const [key, len] of [
      ['KEY', 3],
      ['LEMON', 5],
      ['CIPHERS', 7],
    ] as const) {
      const r = analyse(vigenereTransform(PROSE_A, parseLetterKey(key), 'vigenere', false));
      expect(r.ioc).toBeLessThan(0.05);
      expect(r.verdict.text).toContain('polyalphabetic');
      expect(r.keyLength).toBe(len);
    }
  });

  it('counts n-grams inside words, or across spaces on request', () => {
    const within = resultToText(run('hello hello'));
    expect(within).toContain('HE\t2\t');
    expect(within).toContain('LL\t2\t');
    expect(within).not.toContain('OH\t');
    const across = resultToText(run('ab ab', { across: true }));
    expect(across).toContain('AB\t2\t');
    expect(across).toContain('BA\t1\t');
    expect(resultToText(run('ab ab'))).not.toContain('BA\t1\t');
  });

  it('lists doubled letters and trigrams', () => {
    const out = resultToText(run('The committee will meet; the committee will decide.'));
    expect(out).toContain('Doubled letters');
    expect(out).toMatch(/TT\t2\t/);
    expect(out).toMatch(/MM\t2\t/);
    expect(out).toMatch(/THE\t2\t/);
  });

  it('warns that tiny samples are not reliable', () => {
    expect(analyse('HELLO WORLD').verdict.text).toContain('Only 10 letters');
  });

  it('rejects text without letters', () => {
    expect(() => run('1234 !?')).toThrow(ToolError);
    expect(() => run('')).toThrow(/No letters/);
  });
});

describe('frequency cross-link', () => {
  it('offers the cipher identifier for a real block of text, not a few letters', () => {
    const prev = registeredTools();
    setRegisteredTools([tool, cipherIdentify] as AnyTool[]);
    try {
      expect(resultToText(run(PROSE_A))).toContain('Open in');
      expect(resultToText(run('AB CD'))).not.toContain('Open in');
    } finally {
      setRegisteredTools(prev);
    }
  });
});
