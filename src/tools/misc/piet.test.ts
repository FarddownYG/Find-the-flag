import { readFileSync } from 'node:fs';
import { encode } from 'fast-png';
import { describe, expect, it } from 'vitest';
import { decodeImageExact } from '../../core/decode-image';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { ImageInput, Output, RgbaImage } from '../../core/types';
import {
  BLACK,
  buildGrid,
  classify,
  detectCodelSize,
  exitCodel,
  kindName,
  nearestKind,
  PALETTE,
  WHITE,
} from './_piet-core';
import {
  commandFor,
  runPiet,
  showChar,
  unescapeInput,
  type Command,
  type PietResult,
} from './_piet-vm';
import tool from './piet';

// ---------- a Piet image builder, written from the specification, not from the code under test ----------

/** The 20 colours as the specification lists them. Tokens: hue letter + l(ight)/n(ormal)/d(ark). */
const HEX: Record<string, string> = {
  rl: 'FFC0C0',
  yl: 'FFFFC0',
  gl: 'C0FFC0',
  cl: 'C0FFFF',
  bl: 'C0C0FF',
  ml: 'FFC0FF',
  rn: 'FF0000',
  yn: 'FFFF00',
  gn: '00FF00',
  cn: '00FFFF',
  bn: '0000FF',
  mn: 'FF00FF',
  rd: 'C00000',
  yd: 'C0C000',
  gd: '00C000',
  cd: '00C0C0',
  bd: '0000C0',
  md: 'C000C0',
  w: 'FFFFFF',
  k: '000000',
  // Not Piet colours: grey, and a fully transparent pixel.
  x: '808080',
};
const HUES = 'rygcbm';
const SHADES = 'lnd';

/** Hue steps and "darker" steps of each command, from the specification's table. */
const DELTA: Record<Command, [number, number]> = {
  push: [0, 1],
  pop: [0, 2],
  add: [1, 0],
  subtract: [1, 1],
  multiply: [1, 2],
  divide: [2, 0],
  mod: [2, 1],
  not: [2, 2],
  greater: [3, 0],
  pointer: [3, 1],
  switch: [3, 2],
  duplicate: [4, 0],
  roll: [4, 1],
  'in(number)': [4, 2],
  'in(char)': [5, 0],
  'out(number)': [5, 1],
  'out(char)': [5, 2],
};
const COMMAND_LIST = Object.keys(DELTA) as Command[];

/** The colour that, entered from `token`, runs `command`. */
function next(token: string, command: Command): string {
  const [dh, ds] = DELTA[command];
  return HUES[(HUES.indexOf(token[0]!) + dh) % 6]! + SHADES[(SHADES.indexOf(token[1]!) + ds) % 3]!;
}

function pixel(token: string): [number, number, number, number] {
  if (token === 't') return [0, 0, 0, 0];
  const hex = HEX[token];
  if (!hex) throw new Error(`unknown token ${token}`);
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
    255,
  ];
}

/** Rows of tokens to pixels, every codel being `codel` x `codel` pixels. */
function image(cells: string[][], codel = 1): RgbaImage {
  const width = cells[0]!.length * codel;
  const height = cells.length * codel;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(pixel(cells[Math.floor(y / codel)]![Math.floor(x / codel)]!), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** Shorthand: grid('rn rn k', 'rn rn bn') */
const grid = (...lines: string[]): string[][] => lines.map((l) => l.trim().split(/\s+/));

type Op = [Command, number];

/**
 * A one-strip program. Op i is the command run when leaving block i, and the size of block i
 * (which is what a push leaves on the stack). The strip runs along row 1; block 0 also owns the
 * start codel (0,0), so its size must be at least 3. The last block is a column of three codels
 * entered through its middle codel only: the pointer can not come back, and the program ends.
 */
function program(ops: Op[]) {
  const sizes = ops.map((o) => o[1]);
  if (sizes[0]! < 3) throw new Error('the first block needs at least 3 codels');
  const tokens = ['rn'];
  for (const [command] of ops) tokens.push(next(tokens.at(-1)!, command));
  const n = ops.length;
  const xs = [0];
  let x = sizes[0]! - 1;
  for (let i = 1; i < n; i++) {
    xs.push(x);
    x += sizes[i]!;
  }
  xs.push(x);
  const cells = [0, 1, 2].map(() => new Array<string>(x + 1).fill('k'));
  cells[0]![0] = tokens[0]!;
  for (let c = 0; c <= sizes[0]! - 2; c++) cells[1]![c] = tokens[0]!;
  for (let i = 1; i < n; i++) {
    for (let c = 0; c < sizes[i]!; c++) cells[1]![xs[i]! + c] = tokens[i]!;
  }
  for (let y = 0; y < 3; y++) cells[y]![x] = tokens[n]!;
  return { cells, xs, tokens };
}

// ---------- running ----------

type Opts = Parameters<typeof tool.run>[1];
const defaults: Opts = {
  codel: 0,
  unknown: 'white',
  input: '',
  steps: 1_000_000,
  trace: 200,
};

const asInput = (image: RgbaImage): ImageInput => ({
  bytes: new Uint8Array(0),
  name: 'test.png',
  image,
});
const exec = async (image: RgbaImage, opts: Partial<Opts> = {}): Promise<Output[]> =>
  tool.run(asInput(image), { ...defaults, ...opts });

function printed(out: Output[]): string {
  const b = out.find((o) => o.type === 'text' && o.label === 'Program output');
  return b && b.type === 'text' ? b.value : '';
}

/** Run through the interpreter directly, for the details the tool report does not carry. */
function play(img: RgbaImage, opts: Partial<Opts> = {}): PietResult {
  const o = { ...defaults, ...opts };
  const { grid: g } = buildGrid(img, { codel: o.codel, unknown: o.unknown });
  return runPiet(g, {
    input: unescapeInput(o.input),
    stepLimit: o.steps,
    traceRows: o.trace,
  });
}

/** What a strip program prints. */
const say = (ops: Op[], opts: Partial<Opts> = {}) => play(image(program(ops).cells), opts).output;

const kvValue = (out: Output[], key: string): string | undefined => {
  for (const o of out) {
    if (o.type !== 'kv') continue;
    const hit = o.entries.find(([k]) => k === key);
    if (hit) return hit[1];
  }
  return undefined;
};

const sample = new Uint8Array(
  readFileSync(new URL('../../../public/samples/esolang-piet-ftf.png', import.meta.url)),
);

// ---------- colours ----------

describe('Piet colours', () => {
  it('knows the 18 colours + white + black of the specification', () => {
    for (const [token, hex] of Object.entries(HEX)) {
      if (token === 'x') continue;
      const hue = HUES.indexOf(token[0]!);
      const kind =
        token === 'w' ? WHITE : token === 'k' ? BLACK : hue * 3 + SHADES.indexOf(token[1]!);
      expect(classify(parseInt(hex, 16)), token).toBe(kind);
      expect(PALETTE[kind], token).toBe(parseInt(hex, 16));
    }
    expect(classify(0x808080)).toBe(-1);
    expect(classify(0xff0001)).toBe(-1);
  });

  it('names colours', () => {
    expect(kindName(classify(0xffc0c0))).toBe('light red');
    expect(kindName(classify(0x00c0c0))).toBe('dark cyan');
    expect(kindName(WHITE)).toBe('white');
    expect(kindName(BLACK)).toBe('black');
  });

  it('maps every colour change to its command (all 17 commands from all 18 colours)', () => {
    for (const from of Object.keys(HEX).filter((t) => t.length === 2 && t !== 'x')) {
      for (const command of COMMAND_LIST) {
        const to = next(from, command);
        const a = classify(parseInt(HEX[from]!, 16));
        const b = classify(parseInt(HEX[to]!, 16));
        expect(commandFor(a, b), `${from} -> ${to}`).toBe(command);
      }
    }
  });

  it('snaps off-palette colours to the nearest one', () => {
    expect(nearestKind(0xfa0505)).toBe(classify(0xff0000));
    expect(nearestKind(0xc2bffd)).toBe(classify(0xc0c0ff));
    expect(nearestKind(0x050505)).toBe(BLACK);
    expect(nearestKind(0xf0f0f0)).toBe(WHITE);
  });
});

// ---------- codel size and blocks ----------

describe('codel size', () => {
  it('detects the largest size that divides every run', () => {
    const cells = program([
      ['push', 3],
      ['out(number)', 1],
    ]).cells;
    for (const size of [1, 2, 3, 4, 7]) {
      const built = buildGrid(image(cells, size), { codel: 0, unknown: 'white' });
      expect(built.codel, `scale ${size}`).toBe(size);
      expect(built.detected).toBe(true);
      expect(built.grid.width).toBe(cells[0]!.length);
      expect(built.grid.height).toBe(3);
    }
  });

  it('is the gcd of the runs, horizontal and vertical', () => {
    // 6x4 pixels. Rows: runs of 4 and 2. Columns: runs of 2, 2 and 4. gcd = 2.
    // prettier-ignore
    const even = Int32Array.from([
      1, 1, 1, 1, 2, 2,
      1, 1, 1, 1, 2, 2,
      3, 3, 3, 3, 2, 2,
      3, 3, 3, 3, 2, 2,
    ]);
    expect(detectCodelSize(6, 4, even)).toBe(2);
    // 4x6 pixels. Rows: runs of 4. Columns: runs of 3 and 3. gcd(4, 3) = 1.
    const tall = Int32Array.from([...Array<number>(12).fill(1), ...Array<number>(12).fill(2)]);
    expect(detectCodelSize(4, 6, tall)).toBe(1);
  });

  it('is 1 for noise and the width/height gcd for a flat picture', () => {
    const noise = new Int32Array(20 * 20);
    let seed = 12345;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = seed % 7;
    }
    expect(detectCodelSize(20, 20, noise)).toBe(1);
    expect(detectCodelSize(12, 8, new Int32Array(96))).toBe(4);
  });

  it('can be set by hand; a ragged edge is ignored', () => {
    const cells = program([
      ['push', 3],
      ['out(number)', 1],
    ]).cells;
    const built = buildGrid(image(cells, 3), { codel: 3, unknown: 'white' });
    expect(built.detected).toBe(false);
    expect(built.cropped).toBe(false);
    // 3 pixels per codel read as 2: the picture is then cut at an even number of codels.
    const ragged = buildGrid(image(cells, 3), { codel: 2, unknown: 'white' });
    expect(ragged.codel).toBe(2);
    expect(ragged.cropped).toBe(true);
    expect(ragged.grid.width).toBe(Math.floor((cells[0]!.length * 3) / 2));
  });

  it('rejects a codel size larger than the picture', async () => {
    await expect(exec(image(grid('rn bn')), { codel: 5 })).rejects.toBeInstanceOf(ToolError);
  });

  it('counts the pixels of a block in codels', () => {
    const cells = program([
      ['push', 5],
      ['out(number)', 1],
    ]).cells;
    const { grid: g } = buildGrid(image(cells, 4), { codel: 0, unknown: 'white' });
    expect([...g.blockSize.slice(0, g.blockCount)].sort((a, b) => a - b)).toEqual([1, 3, 5]);
    // The entry block: 5 codels in an L shape (one above the row, four in the row).
    expect(g.blockSize[g.blockOf[0]!]).toBe(5);
  });

  it('groups 4-connected codels only, not diagonal ones', () => {
    const { grid: g } = buildGrid(image(grid('rn bn', 'bn rn')), { codel: 1, unknown: 'white' });
    expect(g.blockCount).toBe(4);
    expect([...g.blockSize.slice(0, 4)]).toEqual([1, 1, 1, 1]);
  });
});

describe('edge selection', () => {
  it('picks the codel furthest along the DP, then along the CC (all 8 cases)', () => {
    const { grid: g } = buildGrid(image(grid('rn rn rn', 'rn rn rn')), {
      codel: 1,
      unknown: 'white',
    });
    const at = (x: number, y: number) => y * 3 + x;
    // DP: 0 right, 1 down, 2 left, 3 up. CC: 0 left (counter-clockwise), 1 right (clockwise).
    expect(exitCodel(g, 0, 0, 0)).toBe(at(2, 0));
    expect(exitCodel(g, 0, 0, 1)).toBe(at(2, 1));
    expect(exitCodel(g, 0, 1, 0)).toBe(at(2, 1));
    expect(exitCodel(g, 0, 1, 1)).toBe(at(0, 1));
    expect(exitCodel(g, 0, 2, 0)).toBe(at(0, 1));
    expect(exitCodel(g, 0, 2, 1)).toBe(at(0, 0));
    expect(exitCodel(g, 0, 3, 0)).toBe(at(0, 0));
    expect(exitCodel(g, 0, 3, 1)).toBe(at(2, 0));
  });

  it('works on a block that is not a rectangle', () => {
    // L shape: (0,0) (0,1) (1,1). Right edge is x=1 (one codel); bottom edge is y=1 (two).
    const { grid: g } = buildGrid(image(grid('rn k', 'rn rn')), { codel: 1, unknown: 'white' });
    const at = (x: number, y: number) => y * 2 + x;
    expect(exitCodel(g, 0, 0, 0)).toBe(at(1, 1));
    expect(exitCodel(g, 0, 1, 0)).toBe(at(1, 1)); // down, CC left = to the right
    expect(exitCodel(g, 0, 1, 1)).toBe(at(0, 1)); // down, CC right = to the left
    expect(exitCodel(g, 0, 3, 0)).toBe(at(0, 0)); // up, CC left = to the left
  });
});

// ---------- the 17 commands ----------

describe('commands', () => {
  it('push and out(number): the value is the size of the block that was left', () => {
    expect(
      say([
        ['push', 5],
        ['out(number)', 1],
      ]),
    ).toBe('5');
    expect(
      say([
        ['push', 12],
        ['out(number)', 1],
      ]),
    ).toBe('12');
  });

  it('pop', () => {
    expect(
      say([
        ['push', 5],
        ['push', 7],
        ['pop', 1],
        ['out(number)', 1],
      ]),
    ).toBe('5');
  });

  it('add, subtract, multiply (second from top is the left operand)', () => {
    const arith = (command: Command, a: number, b: number) =>
      say([
        ['push', a],
        ['push', b],
        [command, 1],
        ['out(number)', 1],
      ]);
    expect(arith('add', 3, 4)).toBe('7');
    expect(arith('subtract', 9, 4)).toBe('5');
    expect(arith('subtract', 4, 9)).toBe('-5');
    expect(arith('multiply', 6, 7)).toBe('42');
  });

  it('divide truncates toward zero; mod has the sign of the divisor', () => {
    const arith = (command: Command, a: number, b: number) =>
      say([
        ['push', a],
        ['push', b],
        [command, 1],
        ['out(number)', 1],
      ]);
    expect(arith('divide', 9, 4)).toBe('2');
    expect(arith('mod', 7, 3)).toBe('1');
    // -7 = 3 - 10
    const minusSeven = (command: Command, d: number) =>
      say([
        ['push', 3],
        ['push', 10],
        ['subtract', 1],
        ['push', d],
        [command, 1],
        ['out(number)', 1],
      ]);
    expect(minusSeven('divide', 2)).toBe('-3');
    expect(minusSeven('mod', 3)).toBe('2');
    // 7 mod -3 = -2 (-3 = 3 - 6)
    expect(
      say([
        ['push', 7],
        ['push', 3],
        ['push', 6],
        ['subtract', 1],
        ['mod', 1],
        ['out(number)', 1],
      ]),
    ).toBe('-2');
  });

  it('ignores a division or modulo by zero and leaves the stack alone', () => {
    for (const command of ['divide', 'mod'] as const) {
      const ops: Op[] = [
        ['push', 5],
        ['push', 3],
        ['push', 3],
        ['subtract', 1], // 3 - 3 = 0
        [command, 1],
        ['out(number)', 1],
      ];
      const r = play(image(program(ops).cells));
      expect(r.output, command).toBe('0');
      expect(r.ignored).toBe(1);
      expect(r.stack).toEqual([5n]);
    }
  });

  it('not', () => {
    const not = (times: number) =>
      say([
        ['push', 3],
        ...Array.from({ length: times }, (): Op => ['not', 1]),
        ['out(number)', 1],
      ]);
    expect(not(1)).toBe('0');
    expect(not(2)).toBe('1');
    expect(not(3)).toBe('0');
  });

  it('greater', () => {
    const gt = (a: number, b: number) =>
      say([
        ['push', a],
        ['push', b],
        ['greater', 1],
        ['out(number)', 1],
      ]);
    expect(gt(5, 3)).toBe('1');
    expect(gt(3, 5)).toBe('0');
    expect(gt(4, 4)).toBe('0');
  });

  it('duplicate', () => {
    expect(
      say([
        ['push', 4],
        ['duplicate', 1],
        ['add', 1],
        ['out(number)', 1],
      ]),
    ).toBe('8');
  });

  it('roll: the top value is the number of rolls, the one below it the depth', () => {
    // Stack 4 5 6 (top), then the depth, then the number of rolls; print what is left, top first.
    const roll = (depth: Op[], rolls: Op[]) =>
      say([
        ['push', 4],
        ['push', 5],
        ['push', 6],
        ...depth,
        ...rolls,
        ['roll', 1],
        ['out(number)', 1],
        ['out(number)', 1],
        ['out(number)', 1],
      ]);
    const push = (n: number): Op[] => [['push', n]];
    const minusOne: Op[] = [
      ['push', 3],
      ['push', 4],
      ['subtract', 1], // 3 - 4
    ];
    // One roll to depth 3 buries the top value 3 deep: [4,5,6] -> [6,4,5]. Top first: 5 4 6.
    expect(roll(push(3), push(1))).toBe('546');
    // Two rolls: [4,5,6] -> [6,4,5] -> [5,6,4]. Top first: 4 6 5.
    expect(roll(push(3), push(2))).toBe('465');
    // Minus one roll goes the other way: [4,5,6] -> [5,6,4]. Top first: 4 6 5.
    expect(roll(push(3), minusOne)).toBe('465');
    // Depth 2 swaps the top two: [4,6,5]. Top first: 5 6 4.
    expect(roll(push(2), push(1))).toBe('564');
    // A full turn, or none: nothing moves.
    expect(roll(push(3), push(3))).toBe('654');
    // Depth 1 never moves anything either.
    expect(roll(push(1), push(1))).toBe('654');
  });

  it('roll with depth 2 and 1 roll is the usual swap', () => {
    expect(
      say([
        ['push', 4],
        ['push', 5],
        ['push', 2],
        ['push', 1],
        ['roll', 1],
        ['out(number)', 1],
        ['out(number)', 1],
      ]),
    ).toBe('45');
  });

  it('ignores a roll with a negative depth, or deeper than the stack, leaving the stack alone', () => {
    const rolled = (depth: Op[]) =>
      play(
        image(
          program([
            ['push', 4],
            ['push', 5],
            ['push', 6],
            ...depth,
            ['push', 1], // one roll
            ['roll', 1],
            ['pop', 1],
          ]).cells,
        ),
      );
    // Depth 5 > the 3 values left after popping the two arguments: ignored; pop removes the 1.
    const deep = rolled([['push', 5]]);
    expect(deep.ignored).toBe(1);
    expect(deep.stack).toEqual([4n, 5n, 6n, 5n]);
    // Depth 3 - 4 = -1: ignored; pop removes the 1.
    const negative = rolled([
      ['push', 3],
      ['push', 4],
      ['subtract', 1],
    ]);
    expect(negative.ignored).toBe(1);
    expect(negative.stack).toEqual([4n, 5n, 6n, -1n]);
  });

  it('in(number) reads like scanf: blanks, a sign, digits; the rest stays', () => {
    const ops: Op[] = [
      ['in(number)', 3],
      ['out(number)', 1],
      ['in(char)', 1],
      ['out(char)', 1],
    ];
    expect(say(ops, { input: '42' })).toBe('42');
    expect(say(ops, { input: '  -17x' })).toBe('-17x');
    expect(say(ops, { input: '+8\\n' })).toBe('8\n');
    // No number: the command is ignored, and so is the print that needed its result.
    const none = play(
      image(
        program([
          ['in(number)', 3],
          ['out(number)', 1],
        ]).cells,
      ),
      { input: 'abc' },
    );
    expect(none.ignored).toBe(2);
    expect(none.output).toBe('');
  });

  it('in(char) and out(char) use Unicode code points', () => {
    const echo: Op[] = [
      ['in(char)', 3],
      ['out(char)', 1],
    ];
    expect(say(echo, { input: 'Q' })).toBe('Q');
    expect(say(echo, { input: 'é' })).toBe('é');
    expect(say(echo, { input: '\\u20ac' })).toBe('€');
    expect(say(echo, { input: '😀' })).toBe('😀');
    const asNumber = say(
      [
        ['in(char)', 3],
        ['out(number)', 1],
      ],
      { input: 'A' },
    );
    expect(asNumber).toBe('65');
    // Nothing to read: ignored.
    expect(say(echo, { input: '' })).toBe('');
  });

  it('out(char) of something that is not a code point prints U+FFFD', () => {
    const r = play(
      image(
        program([
          ['push', 3],
          ['push', 5],
          ['subtract', 1], // -2
          ['out(char)', 1],
        ]).cells,
      ),
    );
    expect(r.output).toBe('�');
    expect(r.badChars).toBe(1);
  });

  it('ignores commands that need more values than the stack holds', () => {
    const r = play(
      image(
        program([
          ['push', 5],
          ['add', 1],
          ['out(number)', 1],
          ['out(number)', 1],
        ]).cells,
      ),
    );
    // add had one value: ignored. out(number) prints 5, the second one finds an empty stack.
    expect(r.output).toBe('5');
    expect(r.ignored).toBe(2);
  });

  it('keeps integers of any size', () => {
    const squarings: Op[] = [['push', 9]];
    for (let i = 0; i < 5; i++) squarings.push(['duplicate', 1], ['multiply', 1]);
    expect(say([...squarings, ['out(number)', 1]])).toBe((9n ** 32n).toString());
  });
});

describe('pointer and switch', () => {
  /**
   * The strip, with a block E patched next to the block reached after the last command: E
   * prints, the next strip block (command `pop`) does not. Which one runs tells where the DP
   * and CC pointed.
   */
  function steer(setup: Op[], place: 'up' | 'down') {
    const p = program([...setup, ['pop', 1]]);
    const reached = setup.length; // the block entered by the last setup command
    const x = p.xs[reached]!;
    const e = next(p.tokens[reached]!, 'out(number)');
    p.cells[place === 'up' ? 0 : 2]![x] = e;
    return play(image(p.cells), { trace: 20, steps: setup.length + 1 });
  }
  const lastCommand = (r: PietResult) => r.trace.at(-1)!.command;

  it('pointer turns the DP clockwise: 1 = down, 3 = up, 4 = no change', () => {
    const down: Op[] = [
      ['push', 7],
      ['push', 1],
      ['pointer', 1],
    ];
    expect(lastCommand(steer(down, 'down'))).toBe('out(number)');
    expect(steer(down, 'down').output).toBe('7');
    // Pointing down at a wall, the pointer turns until it finds a way (here back to the left).
    expect(lastCommand(steer(down, 'up'))).not.toBe('out(number)');

    const three: Op[] = [
      ['push', 7],
      ['push', 3],
      ['pointer', 1],
    ];
    expect(lastCommand(steer(three, 'up'))).toBe('out(number)');
    expect(lastCommand(steer(three, 'down'))).not.toBe('out(number)');

    const four: Op[] = [
      ['push', 7],
      ['push', 4],
      ['pointer', 1],
    ];
    expect(lastCommand(steer(four, 'up'))).toBe('pop');
    expect(lastCommand(steer(four, 'down'))).toBe('pop');

    // 5 = one full turn and a quarter.
    const five: Op[] = [
      ['push', 7],
      ['push', 5],
      ['pointer', 1],
    ];
    expect(lastCommand(steer(five, 'down'))).toBe('out(number)');
  });

  it('pointer with a negative value turns counter-clockwise', () => {
    const minusOne: Op[] = [
      ['push', 7],
      ['push', 3],
      ['push', 4],
      ['subtract', 1], // 3 - 4 = -1
      ['pointer', 1],
    ];
    expect(lastCommand(steer(minusOne, 'up'))).toBe('out(number)');
    expect(lastCommand(steer(minusOne, 'down'))).not.toBe('out(number)');
  });

  it('switch toggles the CC once per odd value', () => {
    /**
     * Block D, entered by the switch, is two codels tall. Going right, its top codel leads to E
     * (prints), its bottom codel to the strip (pop). CC left picks the top one.
     */
    function viaSwitch(n: number) {
      const p = program([
        ['push', 7],
        ['push', n],
        ['switch', 1],
        ['pop', 1],
        ['pop', 1],
      ]);
      const d = p.xs[3]!;
      p.cells[0]![d] = p.tokens[3]!;
      p.cells[0]![d + 1] = next(p.tokens[3]!, 'out(number)');
      return play(image(p.cells), { trace: 20, steps: 4 });
    }
    expect(viaSwitch(2).trace.at(-1)!.command).toBe('out(number)'); // CC left, still
    expect(viaSwitch(1).trace.at(-1)!.command).toBe('pop'); // CC right
    expect(viaSwitch(3).trace.at(-1)!.command).toBe('pop');
    expect(viaSwitch(2).output).toBe('7');
    expect(viaSwitch(1).output).toBe('');
  });
});

// ---------- white, black, termination ----------

describe('white', () => {
  const ops: Op[] = [
    ['push', 3],
    ['push', 2],
    ['push', 6],
    ['add', 1],
    ['out(number)', 1],
  ];

  it('runs no command when it slides across white into a block', () => {
    const p = program(ops);
    // Without white: 3 2 6 are pushed and the add makes 8.
    expect(play(image(p.cells)).output).toBe('8');
    // Block 1 turned white: the first two commands vanish, only push 6 runs; add has one value.
    for (let c = 0; c < ops[1]![1]; c++) p.cells[1]![p.xs[1]! + c] = 'w';
    const r = play(image(p.cells));
    expect(r.output).toBe('6');
    expect(r.trace[0]!.command).toBe('(white)');
    expect(r.trace[0]!.value).toBe('slid over 2 white codels');
    expect(r.trace[1]!.command).toBe('push');
  });

  it('starts in white when the top-left codel is white', () => {
    for (const pad of ['w', 't']) {
      // Two pad columns, white on the first row only, so the only way is along the white row.
      const p = program(ops);
      const two = p.cells.map((row, y) => [y === 0 ? pad : 'k', y === 0 ? pad : 'k', ...row]);
      const r = play(image(two));
      expect(r.output, pad).toBe('8');
      expect(r.trace[0]!.command).toBe('(white)');
      expect(r.trace[0]!.value).toBe('slid over 1 white codel');
      // One pad column: the first move goes straight from white into the block.
      const one = p.cells.map((row, y) => [y === 0 ? pad : 'k', ...row]);
      const r1 = play(image(one));
      expect(r1.output, pad).toBe('8');
      expect(r1.trace[0]!.value).toBe('left white, no command');
    }
  });

  it('ends up in white when it is walled in, and turns DP and CC together there', () => {
    // A block, then white up to the edge: the pointer slides in, bounces, and slides back.
    const r = play(image(grid('rn rn rn w w')), { steps: 6 });
    expect(r.trace[0]!.command).toBe('(white)');
    expect(r.trace[0]!.value).toBe('stopped in white after 2 codels');
    expect(r.stop).toBe('step-limit');
  });

  it('turns both pointers at once when white is blocked', () => {
    // In white at the right edge (4,0): blocked going right -> DP down and CC right; blocked going
    // down -> DP left and CC left; then it slides back to the block. Two turns, not four.
    const r = play(image(grid('rn rn rn w w')), { steps: 2, trace: 5 });
    expect(r.blockedTurns).toBe(2);
    expect(r.trace[1]).toMatchObject({ x: 4, y: 0, dp: 2, cc: 0, command: '(white)' });
    expect(r.trace[1]!.value).toBe('slid over 1 white codel');
  });

  it('terminates a white dead end only through the step limit (like every interpreter)', async () => {
    const out = await exec(image(grid('rn rn rn w w')), { steps: 100 });
    expect(resultToText(out)).toContain('Step limit reached (100 steps)');
  });
});

describe('termination', () => {
  it('ends after eight blocked attempts in a row', () => {
    const r = play(image(grid('rn')));
    expect(r.stop).toBe('ended');
    expect(r.steps).toBe(0);
    expect(r.blockedTurns).toBe(8);
    // Eight turns bring the pointers back where they were.
    expect([r.dp, r.cc]).toEqual([0, 0]);
  });

  it('ends a strip program when the last block can not be left', () => {
    const r = play(
      image(
        program([
          ['push', 3],
          ['out(number)', 1],
        ]).cells,
      ),
    );
    expect(r.stop).toBe('ended');
    expect(r.steps).toBe(2);
    expect(r.output).toBe('3');
  });

  it('does not start when the top-left codel is black', async () => {
    const r = play(image(grid('k rn')));
    expect(r.stop).toBe('black-start');
    const text = resultToText(await exec(image(grid('k rn'))));
    expect(text).toContain('Termination: The top-left codel is black');
  });

  it('stops a loop at the step limit', async () => {
    // Two blocks side by side: the pointer bounces between them for ever.
    const r = play(image(grid('rn bn')), { steps: 50 });
    expect(r.stop).toBe('step-limit');
    expect(r.steps).toBe(50);
    const text = resultToText(await exec(image(grid('rn bn')), { steps: 50 }));
    expect(text).toContain('Step limit reached (50 steps)');
  });

  it('alternates the CC and the DP on blocked attempts, as the specification and npiet do', () => {
    // A 2x2 block with black to its right. Attempt 1 (DP right, CC left) is blocked: the CC
    // toggles. Attempt 2 (DP right, CC right) is blocked: the DP turns, the CC stays on right.
    // Attempt 3 (DP down, CC right) leaves from the bottom-left codel, (0,1), into gn.
    const r = play(image(grid('rn rn k', 'rn rn k', 'gn bn k')), { steps: 1 });
    expect(r.blockedTurns).toBe(2);
    expect(r.trace[0]).toMatchObject({ x: 0, y: 1, dp: 1, cc: 1, command: 'divide' });
    expect(r.x).toBe(0);
  });

  it('chooses the codel with the CC when the DP finds an edge of two', () => {
    // Block A is 2x2. Its right edge has (2,0), black, and (2,1), free: CC left (top codel) is
    // blocked, so the CC flips to right (bottom codel), and the pointer moves on to B (push 4),
    // then C (print it).
    const b = next('rn', 'push');
    const c = next(b, 'out(number)');
    const r = play(image(grid('rn rn k k', `rn rn ${b} ${c}`)), { steps: 2, trace: 5 });
    expect(r.blockedTurns).toBe(1);
    expect(r.trace[0]).toMatchObject({
      x: 1,
      y: 1,
      dp: 0,
      cc: 1,
      command: 'push',
      value: 'pushed 4',
    });
    expect(r.trace[1]!.command).toBe('out(number)');
    expect(r.output).toBe('4');
  });
});

// ---------- the tool ----------

describe('Piet tool', () => {
  it('prints FTF for the sample, with codel size 4 detected', async () => {
    const png = decodeImageExact(sample)!;
    expect(png).not.toBeNull();
    const out = await tool.run(
      { bytes: sample, name: 'esolang-piet-ftf.png', image: png },
      defaults,
    );
    expect(printed(out)).toBe('FTF');
    expect(kvValue(out, 'Codel size')).toBe('4 px (detected)');
    expect(kvValue(out, 'Image')).toBe('152 x 28 px = 38 x 7 codels');
    expect(kvValue(out, 'Colour blocks')).toBe('7');
    expect(kvValue(out, 'Steps')).toBe('6');
    expect(kvValue(out, 'Termination')).toContain('Program ended');
    expect(kvValue(out, 'Stack at end')).toBe('empty');
  });

  it('shows a readable trace of the sample', async () => {
    const png = decodeImageExact(sample)!;
    const out = await tool.run({ bytes: sample, image: png }, defaults);
    const table = out.find((o) => o.type === 'table');
    expect(table).toBeDefined();
    if (table?.type !== 'table') return;
    expect(table.label).toBe('Trace (6 steps)');
    expect(table.columns).toEqual([
      'Step',
      'Codel (x, y)',
      'DP / CC',
      'Command',
      'Value',
      'Stack top',
    ]);
    expect(table.rows.map((r) => [r[0], r[3], r[4]])).toEqual([
      [1, 'push', 'pushed 70'],
      [2, 'out(char)', "printed 'F'"],
      [3, 'push', 'pushed 84'],
      [4, 'out(char)', "printed 'T'"],
      [5, 'push', 'pushed 70'],
      [6, 'out(char)', "printed 'F'"],
    ]);
    // First move leaves the top-right of block 0; the stack top after it is 70.
    expect(table.rows[0]).toEqual([
      1,
      '(9, 0)',
      'right / left',
      'push',
      'pushed 70',
      '70 (1 on stack)',
    ]);
    expect(table.rows[1]![5]).toBe('empty');
  });

  it('gets the wrong answer if the codel size is wrong, which is why detection matters', async () => {
    const png = decodeImageExact(sample)!;
    const run = async (codel: number) =>
      printed(await tool.run({ bytes: sample, image: png }, { ...defaults, codel, steps: 10_000 }));
    expect(await run(4)).toBe('FTF');
    expect(await run(1)).not.toBe('FTF');
    expect(await run(2)).not.toBe('FTF');
  });

  it('limits the trace and says so', async () => {
    const png = decodeImageExact(sample)!;
    const out = await tool.run({ bytes: sample, image: png }, { ...defaults, trace: 3 });
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows.length).toBe(3);
    expect(table?.type === 'table' && table.label).toBe('Trace (first 3 of 6 steps)');
    const none = await tool.run({ bytes: sample, image: png }, { ...defaults, trace: 0 });
    expect(none.some((o) => o.type === 'table')).toBe(false);
  });

  it('reads the Input option', async () => {
    const cells = program([
      ['in(number)', 3],
      ['in(number)', 1],
      ['add', 1],
      ['out(number)', 1],
    ]).cells;
    const out = await exec(image(cells), { input: '20 22' });
    expect(printed(out)).toBe('42');
    expect(kvValue(out, 'Input read')).toBe('5 of 5 characters');
  });

  it('unescapes the Input option', () => {
    expect(unescapeInput('a\\nb\\tc\\0d\\\\e')).toBe('a\nb\tc\0d\\e');
    expect(unescapeInput('\\x41\\u0042')).toBe('AB');
    expect(unescapeInput('no escapes \\q')).toBe('no escapes \\q');
  });

  it('shows characters in the trace', () => {
    expect(showChar('A')).toBe("'A'");
    expect(showChar('\n')).toBe("'\\n'");
    expect(showChar(' ')).toBe("'space'");
    expect(showChar('\u0001')).toBe('U+0001');
  });

  it('says so when nothing is printed', async () => {
    const out = await exec(image(grid('rn')));
    expect(out.some((o) => o.type === 'text')).toBe(false);
    expect(resultToText(out)).toContain('The program ran but printed nothing.');
    expect(resultToText(out)).toContain('never left the first block');
  });

  it('handles other colours as white, black or nearest', async () => {
    const ops: Op[] = [
      ['push', 3],
      ['push', 2],
      ['push', 6],
      ['add', 1],
      ['out(number)', 1],
    ];
    // Block 1 painted grey: not a Piet colour.
    const p = program(ops);
    for (let c = 0; c < 2; c++) p.cells[1]![p.xs[1]! + c] = 'x';
    const img = image(p.cells);
    const asWhite = await exec(img, { unknown: 'white' });
    expect(printed(asWhite)).toBe('6');
    expect(resultToText(asWhite)).toContain('2 codels (');
    expect(resultToText(asWhite)).toContain('not one of the 20 Piet colours, treated as white');
    const asBlack = await exec(img, { unknown: 'black' });
    expect(printed(asBlack)).toBe('');
    expect(resultToText(asBlack)).toContain('treated as black');
  });

  it('recovers a program from slightly off colours with "Nearest"', async () => {
    const cells = program([
      ['push', 70],
      ['out(char)', 1],
      ['push', 84],
      ['out(char)', 1],
      ['push', 70],
      ['out(char)', 1],
    ]).cells;
    const exact = image(cells);
    const off = { ...exact, data: new Uint8ClampedArray(exact.data) };
    for (let i = 0; i < off.data.length; i += 4) {
      off.data[i] = Math.min(255, off.data[i]! + 5);
      off.data[i + 1] = Math.max(0, off.data[i + 1]! - 4);
      off.data[i + 2] = Math.min(255, off.data[i + 2]! + 3);
    }
    expect(printed(await exec(exact))).toBe('FTF');
    expect(printed(await exec(off, { unknown: 'nearest', steps: 1000 }))).toBe('FTF');
    expect(printed(await exec(off, { unknown: 'white', steps: 1000 }))).toBe('');
    expect(printed(await exec(off, { unknown: 'black', steps: 1000 }))).toBe('');
  });

  it('composites transparent pixels over white', () => {
    const { grid: g } = buildGrid(image(grid('t rn')), { codel: 1, unknown: 'black' });
    // Fully transparent = white, even when "other colours" are black.
    expect(g.kinds[0]).toBe(WHITE);
  });

  it('rejects an empty image', async () => {
    await expect(
      exec({ width: 0, height: 0, data: new Uint8ClampedArray(0) }),
    ).rejects.toBeInstanceOf(ToolError);
  });
});

// ---------- regression cases from independent verification ----------
// Every picture below is built in this file from the specification's colour table.

/** 7 * 10 = 70 "F"; + 14 = 84 "T"; - 14 = 70 "F". */
const FTF_OPS: Op[] = [
  ['push', 7],
  ['push', 10],
  ['multiply', 1],
  ['duplicate', 1],
  ['out(char)', 1],
  ['push', 14],
  ['add', 1],
  ['duplicate', 1],
  ['out(char)', 1],
  ['push', 14],
  ['subtract', 1],
  ['out(char)', 1],
];
const ftfCells = () => program(FTF_OPS).cells;

/**
 * A one-row program whose last token is a column of three codels entered through its middle one:
 * the pointer can not come back out of it, so the program ends there. The first block gets one
 * more codel above its first one (the start codel is the top-left one), so it is one bigger.
 */
function trapped(row: string): string[][] {
  const cells = row.trim().split(/\s+/);
  const last = cells.pop()!;
  const walls = cells.map(() => 'k');
  return [
    [cells[0]!, ...walls.slice(1), last],
    [...cells, last],
    [...walls, last],
  ];
}

describe('Piet conformance programs', () => {
  const run = async (cells: string[][], codel = 1, opts: Partial<Opts> = {}) =>
    printed(await exec(image(cells, codel), opts));

  it('pushes the size of a block and prints it as a number (codel 1)', async () => {
    // rl x5 -> rn: push 5 -> md (an L of three codels): out(number). Black under the first block.
    expect(await run(grid('rl rl rl rl rl rn md', 'k k k k k md md'))).toBe('5');
  });

  it('prints FTF at codel size 1, and at 3 and 5 with the size detected', async () => {
    expect(await run(ftfCells())).toBe('FTF');
    expect(await run(ftfCells(), 3)).toBe('FTF');
    expect(await run(ftfCells(), 5)).toBe('FTF');
    expect(await run(ftfCells(), 10)).toBe('FTF');
    const text = resultToText(await exec(image(ftfCells(), 3)));
    expect(text).toContain('Codel size: 3 px (detected)');
  });

  it('takes the codel size from the Codel size option when it is set by hand', async () => {
    expect(await run(ftfCells(), 3, { codel: 3 })).toBe('FTF');
    const text = resultToText(await exec(image(ftfCells(), 3), { codel: 3 }));
    expect(text).toContain('Codel size: 3 px (set manually)');
  });

  it('reads a picture drawn with 3 pixel codels as 1 pixel codels when told so, and gets it wrong', async () => {
    expect(await run(ftfCells(), 3, { codel: 1 })).not.toBe('FTF');
  });

  it('runs no command when it slides through white', async () => {
    // rn -> w w -> rl would be "pop" if white were skipped; after the slide rl -> mn prints.
    const cells = trapped('rl rl rl rl rl rn w w rl mn');
    expect(await run(cells)).toBe('6'); // the first block is 5 codels + the start codel above
    expect(await run(cells, 3)).toBe('6');
  });

  it('treats colours that are not Piet colours as white, black, or the nearest colour', async () => {
    HEX.q = 'F01010'; // not a Piet colour, but closest to normal red
    const grey = trapped('rl rl rl rl rl rn x x rl mn');
    expect(await run(grey)).toBe('6'); // grey = white: the slide works as in the white case
    expect(await run(grey, 1, { unknown: 'black' })).toBe(''); // walls: nothing is printed
    const almostRed = trapped('rl rl rl rl rl q md');
    expect(await run(almostRed, 1, { unknown: 'nearest' })).toBe('6');
    expect(await run(almostRed)).toBe(''); // white: the slide into md runs no command
    expect(await run(almostRed, 1, { unknown: 'black' })).toBe('');
  });

  it('pointer turns the DP clockwise: a green decoy on the right is skipped', async () => {
    // A (7) -> B push 7 -> C push 1 -> D: pointer pops 1, DP right -> down. D is two codels
    // tall; below it the block E prints the 7 as a number. Going on to the right instead would
    // reach G, which prints a character.
    const cells = grid(
      'rl rl rl rl rl rl rl rn rd cl gd',
      'k k k k k k k k k cl k',
      'k k k k k k k k gn gn gn',
    );
    expect(await run(cells)).toBe('7');
    expect(await run(cells, 3)).toBe('7');
  });

  it('switch toggles the CC: with it, the exit is the bottom codel of a column of three', async () => {
    // rl (5) -> rn push 5 -> rd push 1 -> cn: switch pops 1, so the CC goes to "right". The
    // column cn leaves through its bottom codel (CC right when moving right) into out(number).
    // Without the toggle it would leave at the top into the out(char) decoy.
    const cells = grid('rl k k k k k cn gl', 'rl rl rl rl rn rd cn k', 'k k k k k k cn gd');
    expect(await run(cells)).toBe('5');
    expect(await run(cells, 2)).toBe('5');
  });

  it('reads characters and numbers from the Input option', async () => {
    const char: Op[] = [
      ['in(char)', 3],
      ['out(char)', 1],
    ];
    const number: Op[] = [
      ['in(number)', 3],
      ['out(number)', 1],
    ];
    expect(await run(program(char).cells, 1, { input: 'Z' })).toBe('Z');
    expect(await run(program(number).cells, 1, { input: '42' })).toBe('42');
  });

  it('does arithmetic in the specified operand order, rolls, and prints negatives', async () => {
    const arithmetic: Op[] = [
      ['push', 7],
      ['push', 3],
      ['mod', 1],
      ['out(number)', 1], // 7 mod 3 = 1
      ['push', 7],
      ['push', 2],
      ['divide', 1],
      ['out(number)', 1], // 7 / 2 = 3
      ['push', 3],
      ['push', 7],
      ['greater', 1],
      ['not', 1],
      ['out(number)', 1], // 3 > 7 is 0, not 0 is 1
    ];
    expect(await run(program(arithmetic).cells)).toBe('131');

    const roll: Op[] = [
      ['push', 3],
      ['pop', 1],
      ['push', 1],
      ['push', 2],
      ['push', 3],
      ['push', 3],
      ['push', 1],
      ['roll', 1], // depth 3, one roll: 1 2 3 -> 3 1 2
      ['out(number)', 1],
      ['out(number)', 1],
      ['out(number)', 1],
    ];
    expect(await run(program(roll).cells)).toBe('213');

    const subtract: Op[] = [
      ['push', 9],
      ['push', 4],
      ['subtract', 1],
      ['out(number)', 1], // 9 - 4
      ['push', 1],
      ['push', 3],
      ['subtract', 1],
      ['out(number)', 1], // 1 - 3
    ];
    expect(await run(program(subtract).cells)).toBe('5-2');
  });

  it('counts the codels of a 2 x 2 block', async () => {
    expect(await run(grid('rl rl k md', 'rl rl rn md', 'k k k md'))).toBe('4');
  });

  it('survives commands without enough values, a division by zero, and tiny pictures', async () => {
    const emptyStack: Op[] = [
      ['pop', 3],
      ['out(number)', 1],
      ['push', 3],
      ['out(number)', 1],
    ];
    expect(await run(program(emptyStack).cells)).toBe('3');

    const divideByZero: Op[] = [
      ['push', 3],
      ['push', 1],
      ['push', 1],
      ['subtract', 1], // 1 - 1 = 0
      ['divide', 1], // 3 / 0 is ignored
      ['push', 2],
      ['out(number)', 1],
    ];
    const out = await exec(image(program(divideByZero).cells));
    expect(printed(out)).toBe('2');
    expect(kvValue(out, 'Ignored commands')).toBe('1');

    expect(play(image(grid('rn'))).stop).toBe('ended');
    const white = play(image(grid('w w w', 'w w w', 'w w w')), { steps: 1000 });
    expect(['ended', 'step-limit']).toContain(white.stop);
  });

  it('stops two blocks that bounce for ever at the step limit', async () => {
    const text = resultToText(await exec(image(grid('rn bn')), { steps: 500 }));
    expect(text).toContain('Step limit reached (500 steps)');
  });

  it('shows no trace table when Trace rows is 0', async () => {
    const out = await exec(image(grid('rl rl rl rl rl rn md', 'k k k k k md md')), { trace: 0 });
    expect(printed(out)).toBe('5');
    expect(out.some((o) => o.type === 'table')).toBe(false);
  });
});

describe('Piet triage', () => {
  const png = (cells: string[][], codel: number): Uint8Array => {
    const { width, height, data } = image(cells, codel);
    return encode({ width, height, data, channels: 4, depth: 8 });
  };
  const detect = (bytes: Uint8Array, name: string) => tool.detect?.({ text: null, bytes, name });
  const ftf = ftfCells;

  it('suggests Piet for a picture made only of Piet colours, whatever it is called', () => {
    for (const codel of [1, 10]) {
      for (const name of ['prog.png', 'chall.png', 'a.png']) {
        const d = detect(png(ftf(), codel), name);
        expect(d, `${name} x${codel}`).not.toBeNull();
        expect(d!.score).toBeGreaterThanOrEqual(0.6);
      }
    }
  });

  it('recognises the FTF sample picture', () => {
    expect(detect(sample, 'esolang-piet-ftf.png')!.score).toBeGreaterThanOrEqual(0.7);
    expect(detect(sample, 'unnamed.png')!.score).toBeGreaterThanOrEqual(0.7);
  });

  it('is surer when the file name says Piet too', () => {
    const plain = detect(png(ftf(), 4), 'chall.png')!;
    for (const name of ['piet.png', 'hello_piet.png']) {
      expect(detect(png(ftf(), 4), name)!.score).toBeGreaterThan(plain.score);
    }
  });

  it('keeps to the file name for files it can not look into', () => {
    expect(detect(new Uint8Array([1, 2, 3, 4]), 'piet.ppm')!.score).toBe(0.6);
    expect(detect(new Uint8Array([1, 2, 3, 4]), 'program.ppm')).toBeNull();
  });

  it('stays quiet about noise, plain black and white pictures and a damaged PNG', () => {
    let seed = 12345;
    const noise = Array.from({ length: 30 }, () =>
      Array.from({ length: 30 }, () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return (seed >>> 16) % 2 === 0 ? 'x' : 'k';
      }),
    );
    expect(detect(png(noise, 1), 'noise.png')).toBeNull();
    expect(detect(png(grid('w w k w', 'k w w k'), 8), 'scan.png')).toBeNull();
    const damaged = png(ftf(), 4).slice(0, 60);
    expect(detect(damaged, 'x.png')).toBeNull();
  });
});
