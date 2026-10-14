import { ToolError } from '../../core/errors';
import { ByteSink, grouped, InputStream, makeRng, type RunResult } from './_esolang-common';

/**
 * Befunge-93: the program is a grid of 80 columns by 25 lines, the instruction pointer moves over
 * it (leaving one edge it comes back on the opposite one) and the language keeps a stack.
 *
 * Choices where the language leaves room:
 *  - popping an empty stack gives 0;
 *  - division or modulo by zero pushes 0 (the original asks the user) and is counted;
 *  - `g` outside the grid gives 0 and `p` outside the grid does nothing (both counted);
 *  - `&` and `~` read the Program input; at the end of it they push -1;
 *  - `,` prints the low 8 bits, `.` prints the number and a space;
 *  - `?` picks the direction with a seeded generator, so a run is repeatable;
 *  - any other character is a no-op.
 */
export const BEFUNGE_WIDTH = 80;
export const BEFUNGE_HEIGHT = 25;
const STACK_MAX = 1 << 23;

/** Parse the source into the playfield (character codes, row by row). Throws if it does not fit. */
export function loadBefunge(src: string): Int32Array {
  const lines = src.split(/\r\n|\r|\n/).map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) throw new ToolError('Paste a Befunge-93 program (a grid of characters).');
  if (lines.length > BEFUNGE_HEIGHT) {
    throw new ToolError(
      `Befunge-93 programs have at most ${BEFUNGE_HEIGHT} lines, but this one has ${lines.length}. It may be written for Befunge-98 or another language.`,
    );
  }
  const grid = new Int32Array(BEFUNGE_WIDTH * BEFUNGE_HEIGHT).fill(32);
  for (let y = 0; y < lines.length; y++) {
    const line = lines[y]!;
    if (line.length > BEFUNGE_WIDTH) {
      throw new ToolError(
        `Befunge-93 programs are at most ${BEFUNGE_WIDTH} columns wide, but line ${y + 1} has ${line.length} characters. It may be written for Befunge-98 or another language.`,
      );
    }
    for (let x = 0; x < line.length; x++) grid[y * BEFUNGE_WIDTH + x] = line.charCodeAt(x);
  }
  return grid;
}

/** Every character that does something outside string mode (digits, operators, p g & ~ @ ...). */
const COMMAND_CHARS = new Set<number>(
  Array.from('0123456789+-*/%!`><^v?_|":\\$.,#pg&~@', (ch) => ch.charCodeAt(0)),
);

/** > < ^ v ? _ | */
const TURNS = new Set<number>([62, 60, 94, 118, 63, 95, 124]);

/** What a run touched, for telling a real program from text that merely contains an `@`. */
export interface BefungeProbe {
  /** Per cell: 0 never reached, 1 run as an instruction, 2 pushed in string mode, 3 reached but no instruction. */
  seen: Uint8Array;
  /** Direction changes executed (> < ^ v ? _ |). */
  turns: number;
}

export function runBefunge(
  src: string,
  input: Uint8Array,
  stepLimit: number,
  seed: number,
  probe?: BefungeProbe,
): RunResult {
  const grid = loadBefunge(src);
  const rng = makeRng(seed);
  const stream = new InputStream(input);
  const sink = new ByteSink();
  const stack: number[] = [];
  const pop = (): number => stack.pop() ?? 0;

  let x = 0;
  let y = 0;
  let dx = 1;
  let dy = 0;
  let stringMode = false;
  let steps = 0;
  let divisionsByZero = 0;
  let outsideGrid = 0;
  let stopped: RunResult['stopped'] = 'finished';
  const notes: string[] = [];

  run: for (;;) {
    if (steps >= stepLimit) {
      stopped = 'step-limit';
      break;
    }
    steps++;
    const cmd = grid[y * BEFUNGE_WIDTH + x]!;
    let skip = false;
    if (probe && (stringMode || cmd !== 32) && probe.seen[y * BEFUNGE_WIDTH + x] === 0) {
      probe.seen[y * BEFUNGE_WIDTH + x] = stringMode ? 2 : COMMAND_CHARS.has(cmd) ? 1 : 3;
    }
    if (stringMode) {
      if (cmd === 34) stringMode = false;
      else stack.push(cmd);
    } else {
      switch (cmd) {
        case 48:
        case 49:
        case 50:
        case 51:
        case 52:
        case 53:
        case 54:
        case 55:
        case 56:
        case 57: // 0-9
          stack.push(cmd - 48);
          break;
        case 43: {
          // +
          const a = pop();
          stack.push((pop() + a) | 0);
          break;
        }
        case 45: {
          // -
          const a = pop();
          stack.push((pop() - a) | 0);
          break;
        }
        case 42: {
          // *
          const a = pop();
          stack.push(Math.imul(pop(), a));
          break;
        }
        case 47: {
          // /
          const a = pop();
          const b = pop();
          if (a === 0) {
            divisionsByZero++;
            stack.push(0);
          } else {
            stack.push((b / a) | 0);
          }
          break;
        }
        case 37: {
          // %
          const a = pop();
          const b = pop();
          if (a === 0) {
            divisionsByZero++;
            stack.push(0);
          } else {
            stack.push((b % a) | 0);
          }
          break;
        }
        case 33: // !
          stack.push(pop() === 0 ? 1 : 0);
          break;
        case 96: {
          // `
          const a = pop();
          stack.push(pop() > a ? 1 : 0);
          break;
        }
        case 62: // >
          dx = 1;
          dy = 0;
          break;
        case 60: // <
          dx = -1;
          dy = 0;
          break;
        case 94: // ^
          dx = 0;
          dy = -1;
          break;
        case 118: // v
          dx = 0;
          dy = 1;
          break;
        case 63: {
          // ?
          const dir = Math.floor(rng() * 4);
          dx = dir === 0 ? 1 : dir === 1 ? -1 : 0;
          dy = dir === 2 ? -1 : dir === 3 ? 1 : 0;
          break;
        }
        case 95: // _
          dx = pop() === 0 ? 1 : -1;
          dy = 0;
          break;
        case 124: // |
          dx = 0;
          dy = pop() === 0 ? 1 : -1;
          break;
        case 34: // "
          stringMode = true;
          break;
        case 58: {
          // :
          const a = pop();
          stack.push(a, a);
          break;
        }
        case 92: {
          // \
          const a = pop();
          const b = pop();
          stack.push(a, b);
          break;
        }
        case 36: // $
          pop();
          break;
        case 46: // .
          if (!sink.pushAscii(`${pop()} `)) {
            stopped = 'output-limit';
            break run;
          }
          break;
        case 44: // ,
          if (!sink.push(pop())) {
            stopped = 'output-limit';
            break run;
          }
          break;
        case 35: // #
          skip = true;
          break;
        case 112: {
          // p
          const py = pop();
          const px = pop();
          const value = pop();
          if (px >= 0 && px < BEFUNGE_WIDTH && py >= 0 && py < BEFUNGE_HEIGHT) {
            grid[py * BEFUNGE_WIDTH + px] = value;
          } else {
            outsideGrid++;
          }
          break;
        }
        case 103: {
          // g
          const gy = pop();
          const gx = pop();
          if (gx >= 0 && gx < BEFUNGE_WIDTH && gy >= 0 && gy < BEFUNGE_HEIGHT) {
            stack.push(grid[gy * BEFUNGE_WIDTH + gx]!);
          } else {
            outsideGrid++;
            stack.push(0);
          }
          break;
        }
        case 38: // &
          stack.push(stream.nextInt() ?? -1);
          break;
        case 126: // ~
          stack.push(stream.next());
          break;
        case 64: // @
          break run;
        default: // space and every unknown character
          break;
      }
    }
    if (probe && !stringMode && TURNS.has(cmd)) probe.turns++;
    if (stack.length > STACK_MAX) {
      stopped = 'error';
      notes.push(
        `The stack grew past ${grouped(STACK_MAX)} values after ${grouped(steps)} steps: the program pushes without ever popping.`,
      );
      break;
    }
    x += dx;
    y += dy;
    if (skip) {
      x += dx;
      y += dy;
    }
    x = ((x % BEFUNGE_WIDTH) + BEFUNGE_WIDTH) % BEFUNGE_WIDTH;
    y = ((y % BEFUNGE_HEIGHT) + BEFUNGE_HEIGHT) % BEFUNGE_HEIGHT;
  }
  if (divisionsByZero > 0) {
    notes.push(
      `Division or modulo by zero happened ${grouped(divisionsByZero)} time(s); 0 was pushed each time (the original Befunge asks the user for a result).`,
    );
  }
  if (outsideGrid > 0) {
    notes.push(
      `p or g used coordinates outside the ${BEFUNGE_WIDTH}x${BEFUNGE_HEIGHT} grid ${grouped(outsideGrid)} time(s): g pushed 0 and p did nothing.`,
    );
  }
  return { output: sink.bytes(), steps, stopped, notes };
}

/** What a probe run of a program that reached its `@` found. */
export interface BefungeProfile {
  /** Cells run as instructions, cells read in string mode, cells reached that are no instruction. */
  commands: number;
  data: number;
  unknown: number;
  turns: number;
  /** Bytes the program printed on its own (the input is empty). */
  printed: number;
}

/**
 * Run the source for a short while with no input. Null unless it loads as a Befunge-93 grid and
 * ends by reaching `@` (the `@` may be written by the program itself with `p`).
 */
export function profileBefunge(src: string): BefungeProfile | null {
  if (!src.includes('@') && !src.includes('p')) return null;
  const probe: BefungeProbe = { seen: new Uint8Array(BEFUNGE_WIDTH * BEFUNGE_HEIGHT), turns: 0 };
  try {
    const run = runBefunge(src, new Uint8Array(0), 50_000, 1, probe);
    if (run.stopped !== 'finished') return null;
    const count = (kind: number) => probe.seen.reduce((n, k) => n + (k === kind ? 1 : 0), 0);
    return {
      commands: count(1),
      data: count(2),
      unknown: count(3),
      turns: probe.turns,
      printed: run.output.length,
    };
  } catch (e) {
    if (e instanceof ToolError) return null;
    throw e;
  }
}

/**
 * True if the source is Befunge-93 and not text that merely holds an `@`: it must end at `@`, and
 * most of what it runs must be instructions or string data (e-mail addresses, shell lines and
 * prose run through a few letters that are no instruction, so they do not qualify). `strict` is
 * for guessing from pasted text: the program must also print something and be long enough to
 * mean it.
 */
export function looksLikeBefunge(src: string, strict = false): boolean {
  const p = profileBefunge(src);
  if (!p) return false;
  const total = p.commands + p.data + p.unknown;
  if (total === 0 || p.unknown > (strict ? 0.1 : 0.25) * total) return false;
  return !strict || (p.printed > 0 && p.commands + p.data >= 6);
}
