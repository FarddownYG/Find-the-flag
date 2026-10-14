/**
 * Whitespace 0.3 virtual machine: arbitrary-precision stack and heap, call stack, I/O.
 * Semantics follow the reference (Haskell) interpreter, notably floor division.
 */
import { toolT } from '../../i18n/tool-text';
import { grouped, type Parsed } from './_ws-core';

const T = toolT('whitespace-lang');

export interface VmOptions {
  /** Characters the program reads (readchar / readnum), already unescaped. */
  input: string;
  /** Instructions executed before the run is stopped. */
  stepLimit: number;
  /** Characters printed before the run is stopped. */
  outputLimit?: number;
}

export type StopReason = 'end' | 'fell-off' | 'step-limit' | 'output-limit' | 'error';

export interface VmError {
  /** Index of the failing instruction (instrs.length = the unparsable tail). */
  index: number;
  /** Mnemonic of the failing instruction ('invalid' / 'incomplete' for the tail). */
  op: string;
  /** 1-based number of the step that failed (steps executed before it + 1). */
  step: number;
  message: string;
}

export interface VmResult {
  output: string;
  steps: number;
  stack: bigint[];
  heap: Map<bigint, bigint>;
  stopped: StopReason;
  error?: VmError;
  /** Characters printed with a code point that is not a Unicode scalar value (shown as U+FFFD). */
  badChars: number;
  /** Labels marked more than once (the first mark wins, like the reference interpreter). */
  duplicateLabels: string[];
  /** Characters of input consumed. */
  inputUsed: number;
  /** readchar instructions executed with no input left (each stored -1). */
  readsAtEnd: number;
  /**
   * Set when the program ran off its last instruction into a partial instruction code at the very
   * end of the code (typically a lone L from the file's final line break): those tokens.
   */
  partialEnd?: string;
}

const OUTPUT_LIMIT = 1 << 20;
// Each stack or heap entry is a BigInt: 2 million of them is already a few dozen MB.
const STACK_LIMIT = 2_000_000;
const CALL_LIMIT = 1_000_000;
const HEAP_LIMIT = 2_000_000;

const K = {
  push: 0,
  dup: 1,
  copy: 2,
  swap: 3,
  drop: 4,
  slide: 5,
  add: 6,
  sub: 7,
  mul: 8,
  div: 9,
  mod: 10,
  store: 11,
  retrieve: 12,
  label: 13,
  call: 14,
  jump: 15,
  jz: 16,
  jn: 17,
  ret: 18,
  end: 19,
  outchar: 20,
  outnum: 21,
  readchar: 22,
  readnum: 23,
} as const;

const KIND: Record<string, number> = K;

/** Integer division rounding toward negative infinity (Haskell `div`). */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** Remainder with the sign of the divisor (Haskell `mod`). */
export function floorMod(a: bigint, b: bigint): bigint {
  const r = a % b;
  return r !== 0n && r < 0n !== b < 0n ? r + b : r;
}

/** How a label is written in messages and in the disassembly: its S/T letters, "" if empty. */
export const labelText = (label: string) => (label === '' ? '""' : label);

export function execute(parsed: Parsed, opts: VmOptions): VmResult {
  const { instrs, tail } = parsed;
  const n = instrs.length;
  const kinds = new Uint8Array(n);
  const pops = new Uint8Array(n);
  const nums: bigint[] = new Array<bigint>(n).fill(0n);
  const targets = new Int32Array(n).fill(-1);
  const marks = new Map<string, number>();
  const duplicateLabels: string[] = [];
  for (let i = 0; i < n; i++) {
    const ins = instrs[i]!;
    kinds[i] = KIND[ins.op.name]!;
    pops[i] = ins.op.pops;
    if (ins.num !== undefined) nums[i] = ins.num;
    if (ins.op.name === 'label') {
      const l = ins.label!;
      if (marks.has(l)) duplicateLabels.push(l);
      else marks.set(l, i);
    }
  }
  for (let i = 0; i < n; i++) {
    const l = instrs[i]!.label;
    if (l !== undefined && instrs[i]!.op.name !== 'label') targets[i] = marks.get(l) ?? -1;
  }

  const stack: bigint[] = [];
  const heap = new Map<bigint, bigint>();
  const calls: number[] = [];
  const input = Array.from(opts.input);
  const outputLimit = opts.outputLimit ?? OUTPUT_LIMIT;
  const out: string[] = [];
  let outLen = 0;
  let inPos = 0;
  let badChars = 0;
  let readsAtEnd = 0;
  let pc = 0;
  let steps = 0;
  let stopped: StopReason = 'fell-off';
  let error: VmError | undefined;
  let partialEnd: string | undefined;

  // `steps` already counts the failing instruction.
  const fail = (message: string) => {
    stopped = 'error';
    error = { index: pc, op: instrs[pc]!.op.name, step: steps, message };
  };
  const unknownLabel = () => {
    const label = labelText(instrs[pc]!.label!);
    fail(
      tail
        ? T('error.unknownLabelTail', { label, index: n, reason: tail.reason })
        : T('error.unknownLabel', { label }),
    );
  };
  const emit = (s: string) => {
    out.push(s);
    outLen += s.length;
  };

  run: while (true) {
    if (pc >= n) {
      if (tail?.kind === 'partial') partialEnd = tail.raw;
      else if (tail) {
        stopped = 'error';
        error = {
          index: n,
          op: tail.incomplete ? 'incomplete' : 'invalid',
          step: steps + 1,
          message: T('error.unparsable', { reason: tail.reason }),
        };
      }
      break;
    }
    if (steps >= opts.stepLimit) {
      stopped = 'step-limit';
      break;
    }
    if (outLen >= outputLimit) {
      stopped = 'output-limit';
      break;
    }
    steps++;
    const need = pops[pc]!;
    if (stack.length < need) {
      fail(
        T('error.underflow', { count: need, op: instrs[pc]!.op.name, need, depth: stack.length }),
      );
      break;
    }
    switch (kinds[pc]) {
      case K.push:
        stack.push(nums[pc]!);
        break;
      case K.dup:
        stack.push(stack[stack.length - 1]!);
        break;
      case K.copy: {
        const k = nums[pc]!;
        if (k < 0n) {
          fail(T('error.copyNegative', { index: String(k) }));
          break run;
        }
        if (k >= BigInt(stack.length)) {
          fail(
            T('error.copyRange', { count: stack.length, index: String(k), depth: stack.length }),
          );
          break run;
        }
        stack.push(stack[stack.length - 1 - Number(k)]!);
        break;
      }
      case K.swap: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        stack.push(b, a);
        break;
      }
      case K.drop:
        stack.pop();
        break;
      case K.slide: {
        const top = stack.pop()!;
        const k = nums[pc]!;
        if (k > 0n) stack.length -= k > BigInt(stack.length) ? stack.length : Number(k);
        stack.push(top);
        break;
      }
      case K.add:
      case K.sub:
      case K.mul:
      case K.div:
      case K.mod: {
        const b = stack.pop()!;
        const a = stack.pop()!;
        const kind = kinds[pc];
        if ((kind === K.div || kind === K.mod) && b === 0n) {
          fail(T('error.divisionByZero', { a: String(a), op: kind === K.div ? 'div' : 'mod' }));
          break run;
        }
        stack.push(
          kind === K.add
            ? a + b
            : kind === K.sub
              ? a - b
              : kind === K.mul
                ? a * b
                : kind === K.div
                  ? floorDiv(a, b)
                  : floorMod(a, b),
        );
        break;
      }
      case K.store: {
        const value = stack.pop()!;
        const address = stack.pop()!;
        if (heap.size >= HEAP_LIMIT && !heap.has(address)) {
          fail(T('error.heapFull', { max: grouped(HEAP_LIMIT) }));
          break run;
        }
        heap.set(address, value);
        break;
      }
      case K.retrieve:
        stack.push(heap.get(stack.pop()!) ?? 0n);
        break;
      case K.label:
        break;
      case K.call:
        if (targets[pc]! < 0) {
          unknownLabel();
          break run;
        }
        if (calls.length >= CALL_LIMIT) {
          fail(T('error.callDepth', { max: grouped(CALL_LIMIT) }));
          break run;
        }
        calls.push(pc + 1);
        pc = targets[pc]! + 1;
        continue;
      case K.jump:
      case K.jz:
      case K.jn: {
        const kind = kinds[pc];
        if (kind !== K.jump) {
          const v = stack.pop()!;
          if (kind === K.jz ? v !== 0n : v >= 0n) break;
        }
        if (targets[pc]! < 0) {
          unknownLabel();
          break run;
        }
        pc = targets[pc]! + 1;
        continue;
      }
      case K.ret: {
        const back = calls.pop();
        if (back === undefined) {
          fail(T('error.ret'));
          break run;
        }
        pc = back;
        continue;
      }
      case K.end:
        stopped = 'end';
        break run;
      case K.outchar: {
        const v = stack.pop()!;
        const ok = v >= 0n && v <= 0x10ffffn && !(v >= 0xd800n && v <= 0xdfffn);
        if (!ok) badChars++;
        emit(ok ? String.fromCodePoint(Number(v)) : '�');
        break;
      }
      case K.outnum:
        emit(stack.pop()!.toString());
        break;
      case K.readchar: {
        const address = stack.pop()!;
        const ch = input[inPos];
        if (ch !== undefined) inPos++;
        else readsAtEnd++;
        heap.set(address, ch === undefined ? -1n : BigInt(ch.codePointAt(0)!));
        break;
      }
      default: {
        // readnum
        const address = stack.pop()!;
        if (inPos >= input.length) {
          fail(T('error.readnumEmpty'));
          break run;
        }
        let line = '';
        while (inPos < input.length && input[inPos] !== '\n') line += input[inPos++];
        if (inPos < input.length) inPos++;
        const digits = line.trim();
        if (!/^[+-]?\d+$/.test(digits)) {
          fail(T('error.readnumBad', { line: JSON.stringify(line) }));
          break run;
        }
        heap.set(address, BigInt(digits.replace(/^\+/, '')));
      }
    }
    if (stack.length > STACK_LIMIT) {
      fail(T('error.stackFull', { max: grouped(STACK_LIMIT) }));
      break;
    }
    pc++;
  }

  return {
    output: out.join(''),
    steps,
    stack,
    heap,
    stopped,
    error,
    badChars,
    duplicateLabels,
    inputUsed: inPos,
    readsAtEnd,
    partialEnd,
  };
}
