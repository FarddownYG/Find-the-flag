import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import tool, {
  compile,
  detectLanguage,
  execute,
  fromBrainfuck,
  inputBytes,
  textToBrainfuck,
  toBrainfuck,
} from './esolang';

const HELLO =
  '++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.';

type Opts = Parameters<typeof tool.run>[1];
const defaults: Opts = { mode: 'run', language: 'auto', input: '', steps: 10_000_000 };

async function run(src: string, opts: Partial<Opts> = {}) {
  return tool.run(src, { ...defaults, ...opts });
}
async function output(src: string, opts: Partial<Opts> = {}): Promise<Uint8Array> {
  const out = await run(src, opts);
  const block = out.find((o: Output) => o.type === 'bytes');
  return block && block.type === 'bytes' ? block.value : new Uint8Array();
}
const bf = (src: string, input = '', limit = 10_000_000) =>
  execute(compile(src, toBrainfuck(src, 'brainfuck')), utf8Encode(input), limit);

describe('Brainfuck', () => {
  it('runs the canonical Hello World program', async () => {
    expect(utf8Decode(await output(HELLO))).toBe('Hello World!\n');
  });

  it('runs loops, comments and nested loops', async () => {
    expect(utf8Decode(await output('++++++++[>++++++++<-]>+.'))).toBe('A');
    expect(utf8Decode(await output('Print B: ++++++++[>++++++++<-]>++. (done)'))).toBe('B');
    // 5 * 5 * 3 + 2 = 77 = "M"
    expect(utf8Decode(await output('+++[>+++++[>+++++<-]<-]>>++.'))).toBe('M');
  });

  it('wraps cells at 8 bits', () => {
    expect(Array.from(bf('-.').output)).toEqual([255]);
    expect(Array.from(bf(`${'+'.repeat(256)}.`).output)).toEqual([0]);
    expect(Array.from(bf(`${'+'.repeat(257)}.`).output)).toEqual([1]);
    expect(Array.from(bf('-+.').output)).toEqual([0]);
  });

  it('moves the pointer, and cells start at zero', () => {
    expect(Array.from(bf('>+++<.>.').output)).toEqual([0, 3]);
  });

  it('reads input, then zeros at the end of it', () => {
    expect(Array.from(bf(',.,.,.', 'ab').output)).toEqual([97, 98, 0]);
    expect(utf8Decode(bf(',[.,]', 'echo this').output)).toBe('echo this');
  });

  it('counts source instructions exactly, even though runs are folded', () => {
    expect(bf('+++.').steps).toBe(4);
    expect(bf('++[-]').steps).toBe(7);
    expect(bf('[+]').steps).toBe(1);
    expect(bf('+++>>><<<-').steps).toBe(10);
  });

  it('stops infinite loops at the step limit and keeps the output so far', async () => {
    const out = await run('++++++++[>++++++++<-]>+.[]', { steps: 5000 });
    expect(utf8Decode(await output('++++++++[>++++++++<-]>+.[]', { steps: 5000 }))).toBe('A');
    const text = resultToText(out);
    expect(text).toContain('Stopped at the step limit (5 000 steps)');
    expect(out.some((o) => o.type === 'note' && o.level === 'warn')).toBe(true);
  });

  it('applies the default 10 000 000 step limit quickly', async () => {
    const t0 = Date.now();
    const out = await run('-[>-[>-[>-<-]<-]<-]');
    expect(resultToText(out)).toContain('10 000 000 steps');
    expect(resultToText(out)).toContain('Stopped at the step limit');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('reports unmatched brackets with a position', async () => {
    await expect(run('+]')).rejects.toThrow(/Unmatched "\]" at line 1, column 2/);
    await expect(run('++\n[[]')).rejects.toThrow(/Unmatched "\[" at line 2, column 1/);
    await expect(run('+]')).rejects.toThrow(ToolError);
  });

  it('refuses to walk off the left end of the tape', async () => {
    await expect(run('<+')).rejects.toThrow(/left of the first cell/);
  });

  it('refuses a program without instructions', async () => {
    await expect(run('hello world')).rejects.toThrow(/No Brainfuck instructions/);
  });

  it('reports the work done', async () => {
    const text = resultToText(await run(HELLO));
    expect(text).toContain('Brainfuck (auto-detected)');
    expect(text).toMatch(/\d+ steps executed, 13 byte\(s\) printed/);
    expect(resultToText(await run('+', { language: 'brainfuck' }))).toContain(
      'finished without printing anything',
    );
  });

  it('grows the tape to the right', () => {
    expect(Array.from(bf(`${'>'.repeat(40_000)}+.`).output)).toEqual([1]);
  });
});

describe('Program input option', () => {
  it('passes text, with \\n and \\xNN escapes', async () => {
    expect(utf8Decode(await output(',[.,]', { input: 'flag{in}' }))).toBe('flag{in}');
    expect(Array.from(inputBytes('a\\n\\x41\\\\\\0'))).toEqual([97, 10, 65, 92, 0]);
    expect(Array.from(await output(',.', { input: '\\xff' }))).toEqual([255]);
    expect(utf8Decode(inputBytes('é'))).toBe('é');
  });
});

describe('Ook! and Short Ook', () => {
  const pairs: [string, string][] = [
    ['Ook. Ook?', '>'],
    ['Ook? Ook.', '<'],
    ['Ook. Ook.', '+'],
    ['Ook! Ook!', '-'],
    ['Ook! Ook.', '.'],
    ['Ook. Ook!', ','],
    ['Ook! Ook?', '['],
    ['Ook? Ook!', ']'],
  ];

  it('maps every Ook! word pair to its Brainfuck instruction', () => {
    for (const [ook, instruction] of pairs) {
      expect(toBrainfuck(ook, 'ook').code).toBe(instruction);
    }
    expect(toBrainfuck('Ook? Ook?', 'ook').code).toBe('');
    expect(toBrainfuck('ook. OOK. ook! Ook.', 'ook').code).toBe('+.');
  });

  it('maps every Short Ook pair too', () => {
    const short: [string, string][] = [
      ['.?', '>'],
      ['?.', '<'],
      ['..', '+'],
      ['!!', '-'],
      ['!.', '.'],
      ['.!', ','],
      ['!?', '['],
      ['?!', ']'],
    ];
    for (const [s, instruction] of short)
      expect(toBrainfuck(s, 'short-ook').code).toBe(instruction);
    expect(toBrainfuck('.. .. !. \n', 'short-ook').code).toBe('++.');
  });

  it('runs Hello World written in Ook!, Short Ook and Brainfuck alike', async () => {
    for (const language of ['ook', 'short-ook', 'brainfuck'] as const) {
      const program = fromBrainfuck(HELLO, language);
      expect(utf8Decode(await output(program))).toBe('Hello World!\n');
      expect(detectLanguage(program)).toBe(language);
    }
  });

  it('runs a hand-written Ook! program with prose around it', async () => {
    const program = `Print an A: ${'Ook. Ook. '.repeat(65)}Ook! Ook. (that is 65 plus signs and a dot)`;
    expect(utf8Decode(await output(program))).toBe('A');
  });

  it('honours an explicit language over detection', async () => {
    // As Brainfuck this has two '.' instructions; as Short Ook it is '!.' once per pair.
    expect(Array.from(await output('!.', { language: 'short-ook' }))).toEqual([0]);
    expect(resultToText(await run('!.', { language: 'short-ook' }))).toContain('Short Ook:');
  });

  it('complains about an unpaired word', async () => {
    await expect(run('Ook. Ook. Ook!')).rejects.toThrow(/pairs of symbols.*no partner/);
    await expect(run('..!', { language: 'short-ook' })).rejects.toThrow(ToolError);
  });

  it('reports unmatched brackets in Ook! with a position', async () => {
    await expect(run('Ook! Ook?')).rejects.toThrow(/Unmatched "\[" at line 1, column 1/);
  });
});

describe('language detection', () => {
  it('tells the three dialects apart', () => {
    expect(detectLanguage('Ook. Ook? Ook! Ook!')).toBe('ook');
    expect(detectLanguage('.?.. !!\n!. .!')).toBe('short-ook');
    expect(detectLanguage('+[>+<-].')).toBe('brainfuck');
    expect(detectLanguage('...')).toBe('brainfuck');
    expect(detectLanguage('')).toBe('brainfuck');
  });

  it('suggests the tool for pasted programs only', () => {
    const detect = (text: string | null) =>
      tool.detect?.({ text, bytes: new Uint8Array(text?.length ?? 4) }) ?? null;
    expect(detect(HELLO)?.score).toBeGreaterThanOrEqual(0.85);
    expect(detect(HELLO)?.options).toEqual({ language: 'brainfuck' });
    expect(detect(fromBrainfuck(HELLO, 'ook'))?.options).toEqual({ language: 'ook' });
    expect(detect(fromBrainfuck(HELLO, 'short-ook'))?.options).toEqual({ language: 'short-ook' });
    expect(detect('hello, this is plain English text with no code in it.')).toBeNull();
    expect(detect('.- -... -.-. -.. . ..-. --.')).toBeNull(); // Morse code
    expect(detect('[1, 2, 3, 4, 5, 6, 7, 8, 9]')).toBeNull();
    expect(detect('+++')).toBeNull();
    expect(detect(null)).toBeNull();
  });
});

describe('Text → Brainfuck', () => {
  const printed = (program: string) => bf(program).output;

  it('prints every byte value, one at a time', () => {
    for (let b = 0; b < 256; b++) {
      expect(Array.from(printed(textToBrainfuck(Uint8Array.of(b))))).toEqual([b]);
    }
  });

  it('round-trips sentences, repeated letters and arbitrary bytes', () => {
    const samples = [
      'flag{brainfuck_is_fun}',
      'Hello, World!\n',
      'aaaaaaaaaaaaaaaaaaaa',
      'ZZZ zzz AAA aaa',
      'héllo wörld ✓',
      '',
    ];
    for (const s of samples) {
      const bytes = utf8Encode(s);
      expect(utf8Decode(printed(textToBrainfuck(bytes)))).toBe(s);
    }
    let seed = 12345;
    const random = Uint8Array.from({ length: 500 }, () => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed >> 16;
    });
    expect(Array.from(printed(textToBrainfuck(random)))).toEqual(Array.from(random));
  });

  it('is much shorter than one + per unit', () => {
    const program = textToBrainfuck(utf8Encode('flag{brainfuck_is_fun}'));
    expect(program.length).toBeLessThan(300);
    expect(/^[-+<>[\].]+$/.test(program)).toBe(true);
  });

  it('works through the tool in every dialect', async () => {
    for (const language of ['auto', 'brainfuck', 'ook', 'short-ook'] as const) {
      const out = await run('flag{generated}', { mode: 'generate', language });
      const block = out.find((o: Output) => o.type === 'text');
      expect(block).toBeDefined();
      const program = block && block.type === 'text' ? block.value : '';
      expect(utf8Decode(await output(program))).toBe('flag{generated}');
    }
    expect(resultToText(await run('hi', { mode: 'generate' }))).toContain('Brainfuck program');
    expect(resultToText(await run('hi', { mode: 'generate', language: 'ook' }))).toContain(
      'Ook! program',
    );
  });

  it('asks for text when there is none', async () => {
    await expect(run('', { mode: 'generate' })).rejects.toThrow(ToolError);
  });
});
