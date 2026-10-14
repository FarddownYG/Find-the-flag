import { ToolError } from '../../core/errors';
import { ByteSink, grouped, InputStream, lineCol, type RunResult } from './_esolang-common';

/**
 * COW (BigZaphod). Twelve three-letter instructions, numbered 0-11. The memory is a row of
 * 32-bit signed cells that grows to the right, plus one register used by MMM.
 *
 *    0 moo  end of loop: go back to the matching MOO (which tests the cell again)
 *    1 mOo  move left            2 moO  move right
 *    3 mOO  run the cell's value as an instruction number; a value that is no instruction (3
 *           itself, below 0 or above 11) ends the program, as the language says
 *    4 Moo  cell is 0: read a byte into it; otherwise print it as a character
 *    5 MOo  cell - 1             6 MoO  cell + 1
 *    7 MOO  start of loop: when the cell is 0 jump past the matching moo
 *    8 OOO  cell = 0
 *    9 MMM  register empty: copy the cell into it; otherwise paste it into the cell and empty it
 *   10 OOM  print the cell as a decimal number (no separator)
 *   11 oom  read a decimal number into the cell
 */
export const COW_WORDS = [
  'moo',
  'mOo',
  'moO',
  'mOO',
  'Moo',
  'MOo',
  'MoO',
  'MOO',
  'OOO',
  'MMM',
  'OOM',
  'oom',
] as const;
const COW_CODE = new Map<string, number>(COW_WORDS.map((word, code) => [word, code]));
const COW_PATTERN = new RegExp(COW_WORDS.join('|'), 'g');

const MOO_END = 0;
const MOO_START = 7;
const TAPE_START = 30_000;
const TAPE_MAX = 1 << 22;

export interface CowTokens {
  ops: Uint8Array;
  /** Offset of each instruction in the source (for error messages). */
  at: number[];
}

/** Every exact COW instruction, in order. Spaces are optional, anything else is a comment. */
export function tokenizeCow(src: string): CowTokens {
  const ops: number[] = [];
  const at: number[] = [];
  for (const m of src.matchAll(COW_PATTERN)) {
    ops.push(COW_CODE.get(m[0])!);
    at.push(m.index);
  }
  return { ops: Uint8Array.from(ops), at };
}

export function runCow(src: string, input: Uint8Array, stepLimit: number): RunResult {
  const { ops, at } = tokenizeCow(src);

  // Loops as written in the program. (An instruction run through mOO is matched on the fly.)
  const partner = new Int32Array(ops.length).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i] === MOO_START) {
      open.push(i);
    } else if (ops[i] === MOO_END) {
      const start = open.pop();
      if (start === undefined) {
        throw new ToolError(
          `Unmatched "moo" at ${lineCol(src, at[i]!)}: there is no "MOO" to go back to. Remove it or add the missing "MOO".`,
        );
      }
      partner[start] = i;
      partner[i] = start;
    }
  }
  const dangling = open.pop();
  if (dangling !== undefined) {
    throw new ToolError(
      `Unmatched "MOO" at ${lineCol(src, at[dangling]!)}: the loop is never closed. Add the missing "moo".`,
    );
  }

  const backToMoo = (from: number): number => {
    let depth = 0;
    for (let j = from - 1; j >= 0; j--) {
      if (ops[j] === MOO_END) depth++;
      else if (ops[j] === MOO_START && depth-- === 0) return j;
    }
    throw new ToolError('A "moo" run by mOO has no "MOO" before it to go back to.');
  };

  const stream = new InputStream(input);
  const sink = new ByteSink();
  let tape = new Int32Array(TAPE_START);
  let ptr = 0;
  let register: number | null = null;
  let pc = 0;
  let steps = 0;
  let stopped: RunResult['stopped'] = 'finished';
  const notes: string[] = [];

  run: while (pc < ops.length) {
    if (steps >= stepLimit) {
      stopped = 'step-limit';
      break;
    }
    steps++;
    let code = ops[pc]!;
    const viaCell = code === 3;
    if (viaCell) {
      const value = tape[ptr]!;
      if (value < 0 || value > 11 || value === 3) {
        // The language says an invalid command exits the program. Whatever was printed stays.
        notes.push(
          `mOO ran the cell value ${value} as an instruction after ${grouped(steps)} steps, but COW instructions are numbered 0 to 11${value === 3 ? ' (3 is mOO itself, which would run for ever)' : ''}: the program ends there, as the language says.`,
        );
        break run;
      }
      code = value;
    }
    switch (code) {
      case MOO_END:
        pc = viaCell ? backToMoo(pc) : partner[pc]!; // run the MOO again: it tests the cell
        continue run;
      case 1:
        if (--ptr < 0) {
          throw new ToolError(
            `The pointer moved left of the first cell after ${grouped(steps)} steps. COW memory starts at the first cell and only grows to the right.`,
          );
        }
        break;
      case 2:
        if (++ptr >= tape.length) {
          if (ptr >= TAPE_MAX) {
            throw new ToolError(
              `The pointer ran past ${grouped(TAPE_MAX)} cells after ${grouped(steps)} steps: the program is probably looping forever to the right.`,
            );
          }
          const grown = new Int32Array(Math.min(TAPE_MAX, Math.max(tape.length * 2, ptr + 1)));
          grown.set(tape);
          tape = grown;
        }
        break;
      case 4:
        if (tape[ptr] === 0) {
          tape[ptr] = Math.max(stream.next(), 0);
        } else if (!sink.push(tape[ptr]!)) {
          stopped = 'output-limit';
          break run;
        }
        break;
      case 5:
        tape[ptr] = tape[ptr]! - 1;
        break;
      case 6:
        tape[ptr] = tape[ptr]! + 1;
        break;
      case MOO_START:
        // Run through mOO the cell holds 7, so only a MOO written in the program can skip.
        if (tape[ptr] === 0) {
          pc = partner[pc]! + 1;
          continue run;
        }
        break;
      case 8:
        tape[ptr] = 0;
        break;
      case 9:
        if (register === null) {
          register = tape[ptr]!;
        } else {
          tape[ptr] = register;
          register = null;
        }
        break;
      case 10:
        if (!sink.pushAscii(String(tape[ptr]))) {
          stopped = 'output-limit';
          break run;
        }
        break;
      default: // 11, oom
        tape[ptr] = stream.nextInt() ?? 0;
    }
    pc++;
  }
  return { output: sink.bytes(), steps, stopped, notes };
}
