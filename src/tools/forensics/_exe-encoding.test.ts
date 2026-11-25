import { describe, expect, it } from 'vitest';
import {
  asciiPreview,
  detectLengthHeader,
  DUAL_MNEMONICS,
  type DualMnemonic,
  findFlags,
  latin1,
  packBits,
  scan,
} from './_exe-encoding';

const ALL = new Set<DualMnemonic>(DUAL_MNEMONICS);

/** mov eax, eax instructions encoding each bit: 89 c0 for 0 (MR), 8b c0 for 1 (RM). */
function movStream(bits: readonly (0 | 1)[]): { code: Uint8Array; lengths: number[] } {
  const code: number[] = [];
  for (const b of bits) code.push(b ? 0x8b : 0x89, 0xc0);
  return { code: Uint8Array.from(code), lengths: bits.map(() => 2) };
}

describe('x86 encoding — scan', () => {
  it('reads the direction bit of each reg-reg mov and counts the family', () => {
    const { code, lengths } = movStream([0, 1, 1, 0, 1]);
    const r = scan(code, lengths, 64, ALL);
    expect(r.instructions.map((i) => i.bit)).toEqual([0, 1, 1, 0, 1]);
    expect([r.regReg, r.reversed]).toEqual([5, 3]);
    const mov = r.stats.find((s) => s.mnemonic === 'mov')!;
    expect([mov.normal, mov.reversed]).toEqual([2, 3]);
    expect(r.instructions[0]!.text).toBe('mov eax, eax');
  });

  it('detects each dual ALU family and its direction bit', () => {
    // 01 c3 add ebx,eax (MR, 0) | 03 c3 add eax,ebx (RM, 1) | 31 db xor ebx,ebx (0) | 33 d8 xor ebx,eax (1)
    const code = Uint8Array.from([0x01, 0xc3, 0x03, 0xc3, 0x31, 0xdb, 0x33, 0xd8]);
    const r = scan(code, [2, 2, 2, 2], 32, ALL);
    expect(r.instructions.map((i) => `${i.mnemonic}:${i.bit}`)).toEqual([
      'add:0',
      'add:1',
      'xor:0',
      'xor:1',
    ]);
  });

  it('ignores non-dual opcodes and memory operands (ModRM mod != 3)', () => {
    // c3 ret | 89 00 mov [rax],eax (memory) | 0f 1f 00 nop | 90 nop
    const code = Uint8Array.from([0xc3, 0x89, 0x00, 0x0f, 0x1f, 0x00, 0x90]);
    const r = scan(code, [1, 2, 3, 1], 64, ALL);
    expect(r.regReg).toBe(0);
  });

  it('skips REX and operand-size prefixes to reach the opcode', () => {
    // 48 89 d8 mov rax,rbx (REX.W, MR, 0) | 66 89 d8 mov ax,bx (0) | 48 8b c3 mov rax,rbx (RM, 1)
    const code = Uint8Array.from([0x48, 0x89, 0xd8, 0x66, 0x89, 0xd8, 0x48, 0x8b, 0xc3]);
    const r = scan(code, [3, 3, 3], 64, ALL);
    expect(r.instructions.map((i) => i.bit)).toEqual([0, 0, 1]);
    expect(r.instructions[0]!.text).toBe('mov rax, rbx');
    expect(r.instructions[1]!.text).toBe('mov ax, bx');
    expect(r.instructions[2]!.text).toBe('mov rax, rbx'); // the semantic dual of the first
  });

  it('honours the enabled-families filter', () => {
    const code = Uint8Array.from([0x8b, 0xc0, 0x33, 0xc0]); // mov (1), xor (1)
    const only = scan(code, [2, 2], 64, new Set<DualMnemonic>(['xor']));
    expect(only.instructions.map((i) => i.mnemonic)).toEqual(['xor']);
    // stats still cover every family, so the verdict table is complete
    expect(only.stats.find((s) => s.mnemonic === 'mov')!.reversed).toBe(1);
  });
});

describe('x86 encoding — bit packing', () => {
  it('packs most-significant bit first', () => {
    expect([...packBits([0, 1, 0, 0, 0, 0, 0, 1], true, false)]).toEqual([0x41]); // 'A'
  });
  it('packs least-significant bit first', () => {
    expect([...packBits([0, 1, 0, 0, 0, 0, 0, 1], false, false)]).toEqual([0x82]);
  });
  it('inverts the bits when asked', () => {
    expect([...packBits([0, 1, 0, 0, 0, 0, 0, 1], true, true)]).toEqual([0xbe]);
  });
  it('drops a trailing partial byte', () => {
    expect(packBits([1, 1, 1], true, false).length).toBe(0);
  });
});

describe('x86 encoding — header, preview, flags', () => {
  it('detects a u16 little-endian length header that frames readable text then padding', () => {
    const bytes = Uint8Array.from([9, 0, ...[...'FTF{test}'].map((c) => c.charCodeAt(0)), 0]);
    const [h] = detectLengthHeader(bytes);
    expect(h).toMatchObject({ kind: 'u16le', headerOffset: 0, value: 9, bodyStart: 2 });
    expect(latin1(bytes.subarray(h!.bodyStart, h!.bodyStart + h!.value))).toBe('FTF{test}');
  });
  it('finds the length field at a non-zero offset (framing bytes precede it)', () => {
    const bytes = Uint8Array.from([0x77, 0, 5, 0, ...[...'hello'].map((c) => c.charCodeAt(0)), 0]);
    expect(detectLengthHeader(bytes)[0]).toMatchObject({ headerOffset: 2, value: 5, bodyStart: 4 });
  });
  it('does not invent a header for a wholly readable stream (no delimiter)', () => {
    expect(
      detectLengthHeader(Uint8Array.from([...'A'.repeat(66)].map((c) => c.charCodeAt(0)))),
    ).toEqual([]);
  });
  it('does not invent a header when nothing frames readable text', () => {
    expect(detectLengthHeader(Uint8Array.from([0xff, 0xff, 1, 2, 3]))).toEqual([]);
  });
  it('previews printable bytes and dots the rest', () => {
    expect(asciiPreview(Uint8Array.from([0x41, 0x00, 0x42]))).toBe('A·B');
  });
  it('finds flag shapes', () => {
    expect(findFlags('noise FTF{test} more flag{abc_def} end')).toEqual([
      'FTF{test}',
      'flag{abc_def}',
    ]);
  });
});
