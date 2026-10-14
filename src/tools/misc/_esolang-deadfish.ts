import { ByteSink, type RunResult } from './_esolang-common';

/**
 * Deadfish: one accumulator, starting at 0, and four commands. Everything else in the source is
 * ignored. XKCD Deadfish is the same language with other letters.
 *
 *            Deadfish   XKCD
 *  add 1        i        x
 *  subtract 1   d        d
 *  square       s        k
 *  output       o        c
 *
 * Famous quirk, kept on purpose: after every add / subtract / square, an accumulator of exactly
 * 256 or -1 is reset to 0. The accumulator is a 32-bit signed integer, so it wraps on overflow
 * (what the original C interpreter does in practice).
 */
export type DeadfishVariant = 'deadfish' | 'xkcd-deadfish';

const LETTERS: Record<DeadfishVariant, { inc: string; dec: string; square: string; out: string }> =
  {
    deadfish: { inc: 'i', dec: 'd', square: 's', out: 'o' },
    'xkcd-deadfish': { inc: 'x', dec: 'd', square: 'k', out: 'c' },
  };

export interface DeadfishResult extends RunResult {
  /** Every value the program printed, in order. */
  values: number[];
}

/**
 * How `o` prints: `numbers` is the language as specified (the value in decimal, then a newline),
 * `chars` prints the value as a byte (the "Deadfish~" convention, handy for hidden messages).
 */
export function runDeadfish(
  src: string,
  variant: DeadfishVariant,
  stepLimit: number,
  format: 'numbers' | 'chars',
): DeadfishResult {
  const letters = LETTERS[variant];
  const sink = new ByteSink();
  const values: number[] = [];
  let acc = 0;
  let steps = 0;
  let stopped: RunResult['stopped'] = 'finished';
  for (const raw of src) {
    const ch = raw.toLowerCase();
    if (ch === letters.out) {
      if (steps >= stepLimit) {
        stopped = 'step-limit';
        break;
      }
      steps++;
      values.push(acc);
      if (!(format === 'numbers' ? sink.pushAscii(`${acc}\n`) : sink.push(acc))) {
        stopped = 'output-limit';
        break;
      }
      continue;
    }
    if (ch !== letters.inc && ch !== letters.dec && ch !== letters.square) continue;
    if (steps >= stepLimit) {
      stopped = 'step-limit';
      break;
    }
    steps++;
    if (ch === letters.inc) acc = (acc + 1) | 0;
    else if (ch === letters.dec) acc = (acc - 1) | 0;
    else acc = Math.imul(acc, acc);
    if (acc === 256 || acc === -1) acc = 0;
  }
  return { output: sink.bytes(), steps, stopped, values };
}

/** Which Deadfish spelling, if any, is this source written in (every letter is a command). */
export function deadfishVariantOf(src: string): DeadfishVariant | null {
  const compact = src.replace(/\s+/g, '').toLowerCase();
  if (compact.length < 3) return null;
  if (/^[idso]+$/.test(compact) && compact.includes('o') && /[is]/.test(compact)) return 'deadfish';
  if (/^[xdkc]+$/.test(compact) && compact.includes('c') && /[xk]/.test(compact)) {
    return 'xkcd-deadfish';
  }
  return null;
}

/** A Deadfish program that prints exactly these values (shortest route, reset quirk included). */
export function valuesToDeadfish(values: readonly number[], variant: DeadfishVariant): string {
  const letters = LETTERS[variant];
  // Shortest command sequence between any two accumulator values 0..255, by breadth first search.
  const route = (from: number, to: number): string => {
    if (from === to) return '';
    const seen = new Map<number, string>([[from, '']]);
    let frontier = [from];
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const v of frontier) {
        const path = seen.get(v)!;
        const moves: [string, number][] = [
          [letters.inc, v + 1],
          [letters.dec, v - 1],
          [letters.square, v * v],
        ];
        for (const [letter, raw] of moves) {
          const w = raw === 256 || raw === -1 ? 0 : raw;
          if (w < 0 || w > 4096 || seen.has(w)) continue;
          seen.set(w, path + letter);
          if (w === to) return path + letter;
          next.push(w);
        }
      }
      frontier = next;
    }
    return letters.inc.repeat(to); // unreachable for 0..255, kept as a safe fallback
  };
  let program = '';
  let acc = 0;
  for (const v of values) {
    program += `${route(acc, v)}${letters.out}`;
    acc = v;
  }
  return program;
}
