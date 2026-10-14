/**
 * IDAT order for the PNG chunk surgeon: read a sequence ("3 1 2 4", "3,1,2,4", "3-1-2-4",
 * 0- or 1-based), apply it in either reading, find one in the text chunks, or search for it.
 *
 * Two readings of a sequence s over the IDAT chunks c1..cn (file order):
 *   position→chunk  the i-th number is the chunk that goes to position i: out[i] = c[s_i]
 *   chunk→position  the i-th chunk goes to position s_i:                  out[s_i] = c_i
 * They are inverse permutations; both are tried and the zlib stream decides.
 *
 * A list written with "#" ("#3 #1 #2", what the reorder list writes) names the IDAT chunks in
 * the order they go: it is always read as position→chunk.
 */

export type Reading = 'position' | 'chunk';

export interface SequenceProblem {
  kind: 'empty' | 'count' | 'range' | 'duplicate';
  count?: number;
  expected?: number;
  value?: number;
}

export interface Sequence {
  /** 0-based permutation of the IDAT indices. */
  perm: number[];
  zeroBased: boolean;
}

/** Every integer in the text, in order. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/** "#3 #1 #2": IDAT numbers in the order they go (always position→chunk, never inverted). */
export const isListOrder = (text: string): boolean => /#\s*\d/.test(text);

/** Text that is nothing but a list of numbers (after an optional short label such as "order:"). */
export function isNumberList(text: string, min = 2): boolean {
  const body = text.trim().replace(/^[a-z _-]{1,24}[:=]\s*/i, '');
  if (!/^\d+([\s,;:.\-–—>|/]+\d+)*[\s.]*$/.test(body)) return false;
  return numbersIn(body).length >= min;
}

/** Turn a list of numbers into a permutation of 0..n-1 (1-based when it reads as 1..n). */
export function toPermutation(nums: number[], n: number): Sequence | SequenceProblem {
  if (!nums.length) return { kind: 'empty' };
  if (nums.length !== n) return { kind: 'count', count: nums.length, expected: n };
  const min = Math.min(...nums);
  const zeroBased = min === 0;
  const perm = nums.map((v) => (zeroBased ? v : v - 1));
  const seen = new Set<number>();
  for (let i = 0; i < perm.length; i++) {
    const v = perm[i]!;
    if (v < 0 || v >= n) return { kind: 'range', value: nums[i]!, expected: n };
    if (seen.has(v)) return { kind: 'duplicate', value: nums[i]! };
    seen.add(v);
  }
  return { perm, zeroBased };
}

export const isProblem = (s: Sequence | SequenceProblem): s is SequenceProblem => 'kind' in s;

/** File indices of the IDATs in restored order, for one reading of the permutation. */
export function applyReading(perm: number[], reading: Reading): number[] {
  if (reading === 'position') return perm.slice();
  const out = new Array<number>(perm.length);
  perm.forEach((pos, chunk) => {
    out[pos] = chunk;
  });
  return out;
}

export const otherReading = (r: Reading): Reading => (r === 'position' ? 'chunk' : 'position');

/**
 * Keywords that announce an order hint ("order", "IDAT order", "chunk_order", "Sequence"…).
 * Words that merely contain one ("Border", "Recorder") do not count.
 */
export const HINT_KEYWORD =
  /(^|[^a-z])(re)?order|(^|[^a-z])seq(uence)?($|[^a-z])|idat|(^|[^a-z])perm|shuffle|(^|[^a-z])chunks?($|[^a-z])|(^|[^a-z])index($|[^a-z])|arrange/i;

export interface HintSource {
  /** Index of the text chunk in the list given. */
  text: number;
  keyword: string;
  perm: number[];
  zeroBased: boolean;
  /** True when found by keyword; false when found because the text is a plain number list. */
  byKeyword: boolean;
}

export interface HintMiss {
  text: number;
  keyword: string;
  problem: SequenceProblem;
}

/**
 * Every order hint in the text chunks, best first: those whose keyword announces one (order,
 * sequence, idat…), then any whose text is plainly a list of n numbers. All are worth trying,
 * since a decoy often sits next to the real one.
 */
export function findHints(
  texts: { keyword: string; text: string }[],
  n: number,
): { hints: HintSource[]; misses: HintMiss[] } {
  const misses: HintMiss[] = [];
  const hints: HintSource[] = [];
  for (const byKeyword of [true, false]) {
    for (let i = 0; i < texts.length; i++) {
      const { keyword, text } = texts[i]!;
      const keywordHit = HINT_KEYWORD.test(keyword);
      if (byKeyword !== keywordHit) continue;
      if (!byKeyword && !isNumberList(text, Math.max(2, n))) continue;
      const nums = numbersIn(text);
      const seq = toPermutation(nums, n);
      if (isProblem(seq)) {
        if (byKeyword && nums.length) misses.push({ text: i, keyword, problem: seq });
        continue;
      }
      hints.push({ text: i, keyword, perm: seq.perm, zeroBased: seq.zeroBased, byKeyword });
    }
  }
  return { hints, misses };
}

export interface SearchResult {
  order: number[] | null;
  /** Prefix checks made. */
  tries: number;
  /** The budget ran out before the search space was exhausted. */
  exhausted: boolean;
}

/**
 * Build the order chunk by chunk, keeping only prefixes that still inflate cleanly
 * (`prefixOk`), and accept a complete order only when `fullOk` says the whole stream is
 * valid. Depth-first with backtracking; `first` lists the chunks allowed in position 0.
 */
export function searchOrder(
  n: number,
  first: number[],
  prefixOk: (order: number[]) => boolean,
  fullOk: (order: number[]) => boolean,
  budget: number,
): SearchResult {
  let tries = 0;
  let exhausted = false;
  const used = new Array<boolean>(n).fill(false);
  const order: number[] = [];

  const step = (): boolean => {
    if (order.length === n) {
      tries++;
      return fullOk(order);
    }
    const candidates = order.length === 0 ? first : [...Array(n).keys()];
    for (const c of candidates) {
      if (used[c]) continue;
      if (tries >= budget) {
        exhausted = true;
        return false;
      }
      order.push(c);
      used[c] = true;
      let ok = true;
      if (order.length < n) {
        tries++;
        ok = prefixOk(order);
      }
      if (ok && step()) return true;
      order.pop();
      used[c] = false;
      if (exhausted) return false;
    }
    return false;
  };
  const found = step();
  return { order: found ? order.slice() : null, tries, exhausted };
}
