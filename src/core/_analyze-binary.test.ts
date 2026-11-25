import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectBinary } from './_analyze-binary';

const sample = (name: string) => new Uint8Array(readFileSync(`public/samples/${name}`));
const confirmed = (f: { confidence: string }[]) => f.filter((x) => x.confidence === 'confirmed');
const flags = (f: { flag?: string }[]) => f.map((x) => x.flag).filter(Boolean);

/** Deterministic pseudo-random bytes (an LCG), so the test never depends on the clock. */
function noise(n: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  return Uint8Array.from({ length: n }, () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  });
}

/** A minimal x86-64 ELF with one executable .text section holding `text`. */
function elf(text: Uint8Array, machine = 62): Uint8Array {
  const shstr = Uint8Array.from('\0.text\0.shstrtab\0', (c) => c.charCodeAt(0));
  const textOff = 64;
  const shstrOff = textOff + text.length;
  const shoff = (shstrOff + shstr.length + 7) & ~7;
  const buf = new Uint8Array(shoff + 3 * 64);
  const dv = new DataView(buf.buffer);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  dv.setUint16(16, 2, true);
  dv.setUint16(18, machine, true);
  dv.setUint32(20, 1, true);
  dv.setBigUint64(40, BigInt(shoff), true);
  dv.setUint16(52, 64, true);
  dv.setUint16(58, 64, true);
  dv.setUint16(60, 3, true);
  dv.setUint16(62, 2, true);
  buf.set(text, textOff);
  buf.set(shstr, shstrOff);
  const sh = (i: number, nm: number, type: number, flags: number, off: number, size: number) => {
    const b = shoff + i * 64;
    dv.setUint32(b, nm, true);
    dv.setUint32(b + 4, type, true);
    dv.setBigUint64(b + 8, BigInt(flags), true);
    dv.setBigUint64(b + 24, BigInt(off), true);
    dv.setBigUint64(b + 32, BigInt(size), true);
    dv.setBigUint64(b + 48, 1n, true);
  };
  sh(1, 1, 1, 0x6, textOff, text.length);
  sh(2, 7, 3, 0, shstrOff, shstr.length);
  return buf;
}

/** `mov eax,eax` stream carrying `msg` behind a u16-LE length, then normal-form padding. */
function encode(msg: string): Uint8Array {
  const body = [...msg].map((c) => c.charCodeAt(0));
  const payload = [body.length & 0xff, body.length >> 8, ...body];
  const out: number[] = [];
  for (const byte of payload) {
    for (let j = 7; j >= 0; j--) out.push((byte >> j) & 1 ? 0x8b : 0x89, 0xc0);
  }
  for (let k = 0; k < 8; k++) out.push(0x89, 0xc0);
  out.push(0xc3);
  return Uint8Array.from(out);
}

describe('detectBinary', () => {
  it('x86-stego.bin yields a confirmed FTF{x86_encoded}', async () => {
    const f = await detectBinary(sample('x86-stego.bin'), 'x86-stego.bin');
    expect(flags(f)).toContain('FTF{x86_encoded}');
    expect(f.find((x) => x.flag)?.confidence).toBe('confirmed');
  });

  it('reads the executable section of an ELF', async () => {
    const f = await detectBinary(elf(encode('FTF{in_an_elf}')), 'a.out');
    expect(flags(f)).toContain('FTF{in_an_elf}');
    expect(f.find((x) => x.flag)?.offset).toBe(64);
  });

  it('confirms nothing on a random blob', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(confirmed(await detectBinary(noise(20000, seed)))).toEqual([]);
    }
  });

  it('confirms nothing on normal code (every instruction in the normal form)', async () => {
    const code = Uint8Array.from([...Array(400)].flatMap(() => [0x89, 0xc0]));
    expect(await detectBinary(code)).toEqual([]);
    expect(await detectBinary(elf(code))).toEqual([]);
  });

  it('confirms nothing on a few reversed forms, plain text or tiny input', async () => {
    const few = Uint8Array.from([
      ...[...Array(200)].flatMap(() => [0x89, 0xc0]),
      ...[...Array(3)].flatMap(() => [0x8b, 0xc0]),
    ]);
    expect(await detectBinary(few)).toEqual([]);
    expect(
      await detectBinary(new TextEncoder().encode('just some plain text, nothing in it')),
    ).toEqual([]);
    expect(await detectBinary(new Uint8Array(4))).toEqual([]);
  });

  it('says nothing about a non-x86 ELF', async () => {
    expect(await detectBinary(elf(encode('FTF{not_x86}'), 0xb7))).toEqual([]);
  });

  it('does not confirm other fixtures that are not code', async () => {
    for (const file of ['clean-photo.jpg', 'clean-doc.pdf', 'clean-video.mp4']) {
      expect(confirmed(await detectBinary(sample(file), file))).toEqual([]);
    }
  });
});
