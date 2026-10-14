/**
 * Piet, part 2: the interpreter.
 *
 * Standard semantics (David Morgan-Mar's specification), with the usual choices where it is
 * silent, all documented here because the traces depend on them:
 *  - The stack holds arbitrary-size integers (BigInt), so factorials and powers do not overflow.
 *  - A command that cannot run (stack underflow, division by zero, a bad roll depth, no input
 *    left to read) is ignored: it changes nothing, not even the stack.
 *  - divide truncates toward zero; mod takes the sign of the divisor (so -7 mod 3 = 2).
 *  - In white, a blocked slide toggles the CC and turns the DP at the same time. In a colour
 *    block the failed attempts alternate, as the specification and npiet have them: the first
 *    toggles the CC, the second turns the DP (leaving the CC alone), the third toggles the CC
 *    again, and so on.
 *  - in(number) reads like scanf("%d"): it skips blanks, takes an optional sign and digits, and
 *    stops at the first other character (which stays in the input).
 */
import { BLACK, colourChange, DX, DY, exitCodel, WHITE, type PietGrid } from './_piet-core';

export const COMMANDS = [
  null,
  'push',
  'pop',
  'add',
  'subtract',
  'multiply',
  'divide',
  'mod',
  'not',
  'greater',
  'pointer',
  'switch',
  'duplicate',
  'roll',
  'in(number)',
  'in(char)',
  'out(number)',
  'out(char)',
] as const;
export type Command = Exclude<(typeof COMMANDS)[number], null>;

/** The command run when moving from a colour to another (index = hue steps * 3 + shade steps). */
export function commandFor(from: number, to: number): Command | null {
  const { hue, shade } = colourChange(from, to);
  return COMMANDS[hue * 3 + shade] ?? null;
}

export const DP_NAMES = ['right', 'down', 'left', 'up'] as const;
export const CC_NAMES = ['left', 'right'] as const;

/** Consecutive blocked attempts after which the program ends. */
export const MAX_ATTEMPTS = 8;
export const OUTPUT_LIMIT = 1_000_000;
export const STACK_LIMIT = 2_000_000;

export type Stop = 'ended' | 'step-limit' | 'output-limit' | 'stack-limit' | 'black-start';

export interface RunOptions {
  input: string;
  stepLimit: number;
  /** How many steps to record in the trace. */
  traceRows: number;
}

export interface TraceRow {
  step: number;
  /** Codel the move started from, and the pointers at that moment. */
  x: number;
  y: number;
  dp: number;
  cc: number;
  command: string;
  value: string;
  /** Top of the stack after the step ('' when empty) and its depth. */
  top: string;
  depth: number;
}

export interface PietResult {
  output: string;
  /** Moves between blocks (a slide across white is one move). */
  steps: number;
  stop: Stop;
  trace: TraceRow[];
  /** Final stack, bottom first. */
  stack: bigint[];
  x: number;
  y: number;
  dp: number;
  cc: number;
  inWhite: boolean;
  ignored: number;
  blockedTurns: number;
  inputRead: number;
  inputTotal: number;
  badChars: number;
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0', '\\': '\\' };

/** The Input option: \n \r \t \0 \\ \xNN and \uXXXX stand for one character each. */
export function unescapeInput(s: string): string {
  return s.replace(
    /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|([nrt0\\]))/g,
    (_whole: string, x?: string, u?: string, c?: string) =>
      x !== undefined || u !== undefined
        ? String.fromCharCode(parseInt((x ?? u)!, 16))
        : ESCAPES[c!]!,
  );
}

/** A character for the trace: quoted when printable, a name or code point otherwise. */
export function showChar(ch: string): string {
  const cp = ch.codePointAt(0)!;
  const named: Record<number, string> = { 10: '\\n', 13: '\\r', 9: '\\t', 0: '\\0', 32: 'space' };
  const name = named[cp];
  if (name !== undefined) return `'${name}'`;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0) || cp === 0xfffd) {
    return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `'${ch}'`;
}

const BLANKS = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

/** scanf("%d") on code points starting at `from`; null when there is no number. */
function readNumber(chars: string[], from: number): { value: bigint; next: number } | null {
  let i = from;
  while (i < chars.length && BLANKS.has(chars[i]!)) i++;
  let sign = '';
  if (chars[i] === '-' || chars[i] === '+') sign = chars[i++]!;
  const digitsAt = i;
  while (i < chars.length && chars[i]! >= '0' && chars[i]! <= '9') i++;
  if (i === digitsAt) return null;
  return { value: BigInt(sign + chars.slice(digitsAt, i).join('')), next: i };
}

const BINARY_SYMBOL: Record<string, string> = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
  mod: 'mod',
  greater: '>',
};

export function runPiet(grid: PietGrid, o: RunOptions): PietResult {
  const { width: W, height: H, kinds, blockOf, blockKind, blockSize } = grid;
  const chars = Array.from(o.input);
  let inPos = 0;
  const stack: bigint[] = [];
  const out: string[] = [];
  let outLength = 0;
  const trace: TraceRow[] = [];
  let dp = 0;
  let cc = 0;
  let steps = 0;
  let attempts = 0;
  let blockedTurns = 0;
  let ignored = 0;
  let badChars = 0;
  let inWhite = false;
  let pos = 0;
  let block = blockOf[0]!;
  let stop: Stop = 'ended';

  const finish = (): PietResult => {
    let x = 0;
    let y = 0;
    if (stop !== 'black-start') {
      const at = inWhite ? pos : exitCodel(grid, block, dp, cc);
      x = at % W;
      y = (at - x) / W;
    }
    return {
      output: out.join(''),
      steps,
      stop,
      trace,
      stack,
      x,
      y,
      dp,
      cc,
      inWhite,
      ignored,
      blockedTurns,
      inputRead: inPos,
      inputTotal: chars.length,
      badChars,
    };
  };

  const first = kinds[0]!;
  if (first === BLACK) {
    stop = 'black-start';
    return finish();
  }
  if (first === WHITE) inWhite = true;

  /** Run one command; returns the trace "value" text (only built when `tracing`). */
  const apply = (cmd: Command, size: number, tracing: boolean): string => {
    const skip = (why: string): string => {
      ignored++;
      return tracing ? `ignored: ${why}` : '';
    };
    const len = stack.length;
    switch (cmd) {
      case 'push':
        stack.push(BigInt(size));
        return tracing ? `pushed ${size}` : '';
      case 'pop': {
        if (len < 1) return skip('empty stack');
        const v = stack.pop()!;
        return tracing ? `popped ${v}` : '';
      }
      case 'add':
      case 'subtract':
      case 'multiply':
      case 'divide':
      case 'mod':
      case 'greater': {
        if (len < 2) return skip('needs two values');
        const a = stack[len - 1]!;
        const b = stack[len - 2]!;
        let r: bigint;
        if (cmd === 'add') r = b + a;
        else if (cmd === 'subtract') r = b - a;
        else if (cmd === 'multiply') r = b * a;
        else if (cmd === 'greater') r = b > a ? 1n : 0n;
        else {
          if (a === 0n) return skip(cmd === 'divide' ? 'division by zero' : 'modulo by zero');
          if (cmd === 'divide') r = b / a;
          else {
            r = b % a;
            // The remainder takes the sign of the divisor.
            if (r !== 0n && (r > 0n ? a < 0n : a > 0n)) r += a;
          }
        }
        stack.length = len - 2;
        stack.push(r);
        return tracing ? `${b} ${BINARY_SYMBOL[cmd]} ${a} = ${r}` : '';
      }
      case 'not': {
        if (len < 1) return skip('empty stack');
        const v = stack[len - 1]!;
        stack[len - 1] = v === 0n ? 1n : 0n;
        return tracing ? `not ${v} = ${stack[len - 1]}` : '';
      }
      case 'pointer': {
        if (len < 1) return skip('empty stack');
        const n = stack.pop()!;
        dp = (dp + Number(((n % 4n) + 4n) % 4n)) & 3;
        return tracing ? `${n}: DP ${DP_NAMES[dp]}` : '';
      }
      case 'switch': {
        if (len < 1) return skip('empty stack');
        const n = stack.pop()!;
        if (n % 2n !== 0n) cc ^= 1;
        return tracing ? `${n}: CC ${CC_NAMES[cc]}` : '';
      }
      case 'duplicate': {
        if (len < 1) return skip('empty stack');
        stack.push(stack[len - 1]!);
        return tracing ? `${stack[len - 1]}` : '';
      }
      case 'roll': {
        if (len < 2) return skip('needs two values');
        // The first value popped is the number of rolls, the second the depth.
        const rolls = stack[len - 1]!;
        const depth = stack[len - 2]!;
        if (depth < 0n) return skip('negative depth');
        if (depth > BigInt(len - 2)) return skip('depth larger than the stack');
        stack.length = len - 2;
        const d = Number(depth);
        if (d > 1) {
          const r = Number(((rolls % depth) + depth) % depth);
          if (r > 0) {
            // One roll sends the top value to depth d and lifts the d-1 below it.
            const part = stack.splice(stack.length - d, d);
            for (let i = 0; i < d; i++) stack.push(part[(i - r + d) % d]!);
          }
        }
        return tracing ? `depth ${depth}, ${rolls} roll${rolls === 1n ? '' : 's'}` : '';
      }
      case 'in(number)': {
        const got = readNumber(chars, inPos);
        if (!got) return skip(inPos >= chars.length ? 'no input left' : 'no number in the input');
        inPos = got.next;
        stack.push(got.value);
        return tracing ? `read ${got.value}` : '';
      }
      case 'in(char)': {
        if (inPos >= chars.length) return skip('no input left');
        const ch = chars[inPos++]!;
        stack.push(BigInt(ch.codePointAt(0)!));
        return tracing ? `read ${showChar(ch)}` : '';
      }
      case 'out(number)': {
        if (len < 1) return skip('empty stack');
        const text = String(stack.pop()!);
        out.push(text);
        outLength += text.length;
        return tracing ? `printed ${text}` : '';
      }
      case 'out(char)': {
        if (len < 1) return skip('empty stack');
        const v = stack.pop()!;
        const valid = v >= 0n && v <= 0x10ffffn && !(v >= 0xd800n && v <= 0xdfffn);
        const ch = valid ? String.fromCodePoint(Number(v)) : '�';
        if (!valid) badChars++;
        out.push(ch);
        outLength += ch.length;
        return tracing
          ? `printed ${showChar(ch)}${valid ? '' : ` (${v} is not a code point)`}`
          : '';
      }
    }
  };

  for (;;) {
    if (steps >= o.stepLimit) {
      stop = 'step-limit';
      break;
    }
    const from = inWhite ? pos : exitCodel(grid, block, dp, cc);
    const fx = from % W;
    const fy = (from - fx) / W;
    const nx = fx + DX[dp]!;
    const ny = fy + DY[dp]!;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H || kinds[ny * W + nx] === BLACK) {
      blockedTurns++;
      if (inWhite) {
        dp = (dp + 1) & 3;
        cc ^= 1;
      } else if (attempts % 2 === 0) {
        cc ^= 1;
      } else {
        dp = (dp + 1) & 3;
      }
      // Eight turns bring both pointers back to where they were when the program got stuck.
      if (++attempts >= MAX_ATTEMPTS) break;
      continue;
    }
    attempts = 0;
    steps++;
    const startDp = dp;
    const startCc = cc;
    const tracing = trace.length < o.traceRows;
    let commandName = '';
    let value = '';

    if (kinds[ny * W + nx] === WHITE) {
      // Slide straight on through white until something that is not white.
      let wx = nx;
      let wy = ny;
      let crossed = 1;
      for (;;) {
        const ax = wx + DX[dp]!;
        const ay = wy + DY[dp]!;
        if (ax < 0 || ay < 0 || ax >= W || ay >= H || kinds[ay * W + ax] !== WHITE) break;
        wx = ax;
        wy = ay;
        crossed++;
      }
      const lx = wx + DX[dp]!;
      const ly = wy + DY[dp]!;
      const lands = lx >= 0 && ly >= 0 && lx < W && ly < H && kinds[ly * W + lx] !== BLACK;
      if (lands) {
        block = blockOf[ly * W + lx]!;
        inWhite = false;
      } else {
        pos = wy * W + wx;
        inWhite = true;
      }
      if (tracing) {
        commandName = '(white)';
        value = lands
          ? `slid over ${crossed} white codel${crossed === 1 ? '' : 's'}`
          : `stopped in white after ${crossed} codel${crossed === 1 ? '' : 's'}`;
      }
    } else {
      const next = blockOf[ny * W + nx]!;
      if (inWhite) {
        inWhite = false;
        if (tracing) {
          commandName = '(white)';
          value = 'left white, no command';
        }
      } else {
        const cmd = commandFor(blockKind[block]!, blockKind[next]!);
        if (cmd) {
          value = apply(cmd, blockSize[block]!, tracing);
          commandName = cmd;
        }
      }
      block = next;
    }

    if (tracing) {
      trace.push({
        step: steps,
        x: fx,
        y: fy,
        dp: startDp,
        cc: startCc,
        command: commandName,
        value,
        top: stack.length ? String(stack[stack.length - 1]) : '',
        depth: stack.length,
      });
    }
    if (outLength >= OUTPUT_LIMIT) {
      stop = 'output-limit';
      break;
    }
    if (stack.length >= STACK_LIMIT) {
      stop = 'stack-limit';
      break;
    }
  }
  return finish();
}
