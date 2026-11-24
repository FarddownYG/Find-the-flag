import { describe, expect, it } from 'vitest';
import { defaultOptions } from '../../core/registry';
import type { Output, ToolResult } from '../../core/types';
import tool from './symbol-words';

type Opts = Partial<ReturnType<typeof defaultOptions>>;
const run = (input: string, opts: Opts = {}): ToolResult =>
  tool.run(input, { ...defaultOptions(tool as never), ...opts } as never) as ToolResult;
const decoded = (out: Output[]) =>
  out.find((o): o is Extract<Output, { type: 'text' }> => o.type === 'text')?.value ?? '';
const notes = (out: Output[]) => out.flatMap((o) => (o.type === 'note' ? [o.text] : [])).join('\n');
const mappingRows = (out: Output[]) => {
  const t = out.find(
    (o): o is Extract<Output, { type: 'table' }> =>
      o.type === 'table' && /→ digit|chiffre|数字|цифра|अंक/.test(o.label ?? ''),
  );
  return new Map((t?.rows ?? []).map((r) => [String(r[0]), Number(r[1])]));
};

/** A fictional script with a base64 "FTF{test}" (RlRGe3Rlc3R9); homemade, never challenge material.
 *  Rich enough in common letters + newlines that every nibble value is pinned, so the unlocked
 *  solver has a unique optimum = the true text. */
const SCRIPT =
  'function makeKey(block) {\n  const key = block.split("").map(function (tok) {\n    return tok.charCodeAt(0);\n  });\n  const back = atob("RlRGe3Rlc3R9");\n  return key.length + back;\n}\n';
const WORDS16 =
  'alfa bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa'.split(
    ' ',
  );

/** Encode bytes as base-2^bits, MSB-first, mapping digit value -> token via `words` (words[v]). */
function toDigits(plain: string, bits: number): number[] {
  const digits: number[] = [];
  let acc = 0;
  let have = 0;
  for (const b of [...plain].map((c) => c.charCodeAt(0))) {
    acc = (acc << 8) | b;
    have += 8;
    while (have >= bits) {
      have -= bits;
      digits.push((acc >> have) & ((1 << bits) - 1));
    }
  }
  return digits;
}
const encode = (plain: string, bits: number, words: string[]) =>
  toDigits(plain, bits)
    .map((d) => words[d])
    .join(' ');

/** A fixed, non-identity permutation so "order of appearance" is NOT the answer. */
const shuffle = (words: string[], seed: number) => {
  const a = [...words];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

describe('symbol-word decoder — solving', () => {
  it('recovers a hex-encoded script exactly with a shuffled 16-word mapping (fixed seed)', () => {
    const ct = encode(SCRIPT, 4, shuffle(WORDS16, 7));
    const out = run(ct, { reading: 'solver' });
    expect(decoded(out)).toBe(SCRIPT);
    expect(decoded(out)).toContain('RlRGe3Rlc3R9'); // base64 of FTF{test}
  }, 30000);

  it('recovers a base-2 (two-word) encoding exactly', () => {
    const ct = encode(SCRIPT, 1, ['nil', 'une']);
    expect(decoded(run(ct, { reading: 'solver' }))).toBe(SCRIPT);
  }, 30000);

  it('recovers a base-4 encoding exactly', () => {
    const ct = encode(SCRIPT, 2, ['wa', 'wb', 'wc', 'wd']);
    expect(decoded(run(ct, { reading: 'solver' }))).toBe(SCRIPT);
  }, 30000);

  it('decodes a base64 (6-bit) encoding via order of appearance', () => {
    // Prepend digits 0..63 so all 64 values exist and first appear in numeric order; the
    // appearance-order reading is then the identity and recovers the script byte-for-byte.
    const digits = [...Array.from({ length: 64 }, (_, v) => v), ...toDigits(SCRIPT, 6)];
    const ct = digits.map((d) => `k${d}`).join(' ');
    const out = run(ct, { reading: 'cipher' });
    expect(decoded(out)).toContain(SCRIPT); // the 64-digit preamble is 48 whole bytes, so SCRIPT stays aligned
    expect(decoded(out)).toContain('RlRGe3Rlc3R9');
  });
});

describe('symbol-word decoder — readings and locks', () => {
  it('uses order of appearance without the solver when it already reads', () => {
    // Binary: the first byte is 'f' (0x66, MSB 0), so value 0 appears before value 1 and the
    // appearance-order reading is exactly the identity — no search needed.
    const ct = encode(SCRIPT, 1, ['zero', 'one']);
    const out = run(ct); // auto
    const label = out.find((o) => o.type === 'text')?.label ?? '';
    expect(decoded(out)).toBe(SCRIPT);
    expect(label).toMatch(/appearance|apparition|出现|появления|प्रकट/); // chose appearance, not search
  });

  it('respects locked symbols', () => {
    const words = shuffle(WORDS16, 7);
    const ct = encode(SCRIPT, 4, words);
    // words[d] is the token for digit d, so lock three tokens to their true digits.
    const lockSpec = `${words[3]}=3 ${words[10]}=10 ${words[14]}=14`;
    const map = mappingRows(run(ct, { reading: 'solver', locks: lockSpec }));
    expect(map.get(words[3]!)).toBe(3);
    expect(map.get(words[10]!)).toBe(10);
    expect(map.get(words[14]!)).toBe(14);
  }, 30000);
});

describe('symbol-word decoder — edge cases', () => {
  it('warns on empty input without crashing', () => {
    const out = run('');
    expect(notes(out)).toMatch(/distinct token|token distinct|不同记号|различных|भिन्न/);
    expect(decoded(out)).toBe('');
  });

  it('warns on a single distinct token', () => {
    expect(notes(run('same same same same'))).toMatch(
      /distinct token|token distinct|不同记号|различных|भिन्न/,
    );
  });

  it('explains a non-power-of-two vocabulary and offers substitution', () => {
    const out = run('a b c a b c a b c a b c'); // 3 distinct
    expect(notes(out)).toMatch(/power of two|puissance de 2|2 की घात|степень двойки|2 的幂/);
    expect(out.some((o) => o.type === 'actions')).toBe(true);
    expect(() => run('x y z w v u t s x y z w v u t s')).not.toThrow(); // 6 distinct, no crash
  });
});
