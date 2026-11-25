import { describe, expect, it } from 'vitest';
import type { Output } from '../../core/types';
import { run } from './_exe-test-kit';

/** A minimal x86-64 ELF with a single executable .text section holding `text`. */
function buildEncodedElf(text: Uint8Array, machine = 62): Uint8Array {
  const shstr = Uint8Array.from('\0.text\0.shstrtab\0', (c) => c.charCodeAt(0));
  const textOff = 64;
  const shstrOff = textOff + text.length;
  const shoff = (shstrOff + shstr.length + 7) & ~7;
  const buf = new Uint8Array(shoff + 3 * 64);
  const dv = new DataView(buf.buffer);
  const w16 = (o: number, v: number) => dv.setUint16(o, v, true);
  const w32 = (o: number, v: number) => dv.setUint32(o, v, true);
  const w64 = (o: number, v: number) => dv.setBigUint64(o, BigInt(v), true);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0); // ELF64, little-endian
  w16(16, 2); // ET_EXEC
  w16(18, machine);
  w32(20, 1);
  w64(40, shoff); // e_shoff
  w16(52, 64); // e_ehsize
  w16(58, 64); // e_shentsize
  w16(60, 3); // e_shnum
  w16(62, 2); // e_shstrndx
  buf.set(text, textOff);
  buf.set(shstr, shstrOff);
  const sh = (
    i: number,
    name: number,
    type: number,
    flags: number,
    offset: number,
    size: number,
  ) => {
    const b = shoff + i * 64;
    w32(b, name);
    w32(b + 4, type);
    w64(b + 8, flags);
    w64(b + 24, offset);
    w64(b + 32, size);
    w64(b + 48, 1); // align
  };
  sh(1, 1, 1, 0x6, textOff, text.length); // .text PROGBITS, ALLOC|EXECINSTR
  sh(2, 7, 3, 0, shstrOff, shstr.length); // .shstrtab STRTAB
  return buf;
}

/** Encode a message behind a u16-LE length header as a stream of mov eax,eax (89 c0 / 8b c0),
 *  followed by a byte of normal-form padding so the length header is framed by a non-text byte. */
function encode(msg: string, { msbFirst = true, invert = false } = {}): Uint8Array {
  const body = [...msg].map((c) => c.charCodeAt(0));
  const payload = [body.length & 0xff, (body.length >> 8) & 0xff, ...body];
  const out: number[] = [];
  for (const byte of payload) {
    for (let j = 0; j < 8; j++) {
      const bit = (msbFirst ? byte >> (7 - j) : byte >> j) & 1;
      out.push((invert ? bit ^ 1 : bit) ? 0x8b : 0x89, 0xc0);
    }
  }
  for (let k = 0; k < 8; k++) out.push(0x89, 0xc0); // padding -> a 0x00 byte after the body
  out.push(0xc3); // ret
  return Uint8Array.from(out);
}

const noteText = (r: Output[]) => r.flatMap((o) => (o.type === 'note' ? [o.text] : [])).join('\n');
const textOf = (r: Output[], label: string) =>
  r.find((o): o is Extract<Output, { type: 'text' }> => o.type === 'text' && o.label === label)
    ?.value ?? '';
const decoded = (r: Output[]) => textOf(r, 'Decoded message');
const body = (r: Output[]) => textOf(r, 'Framed message body');

describe('exe-analyzer — instruction-encoding channel', () => {
  it('detects the anomaly and recovers the message and its length header', async () => {
    const r = await run(buildEncodedElf(encode('FTF{test}')), { view: 'encoding' });
    const notes = noteText(r);
    expect(notes).toMatch(/Hidden channel likely/);
    expect(notes).toMatch(/Length header: u16le at offset 0, value 9/);
    expect(notes).toMatch(/Flag found: FTF\{test\}/);
    expect(decoded(r)).toContain('FTF{test}'); // the full stream is shown
    expect(body(r)).toBe('FTF{test}'); // the framed body is the clean message
  });

  it('reports no anomaly when every instruction is in the normal form', async () => {
    const text = Uint8Array.from([...Array(200)].flatMap(() => [0x89, 0xc0]));
    const r = await run(buildEncodedElf(text), { view: 'encoding' });
    expect(noteText(r)).toMatch(/No anomaly/);
    expect(noteText(r)).not.toMatch(/Flag found/);
    expect(decoded(r)).toBe(''); // nothing extracted
  });

  it('calls a few reversed forms unusual but too few to carry a message', async () => {
    const text = Uint8Array.from([
      ...[...Array(200)].flatMap(() => [0x89, 0xc0]),
      ...[...Array(3)].flatMap(() => [0x8b, 0xc0]),
    ]);
    const r = await run(buildEncodedElf(text), { view: 'encoding' });
    expect(noteText(r)).toMatch(/A few reversed forms/);
    expect(decoded(r)).toBe('');
  });

  it('does not claim a channel on a packed / high-entropy section', async () => {
    let s = 0x12345678;
    const text = Uint8Array.from({ length: 6000 }, () => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return (s >>> 16) & 0xff;
    });
    const r = await run(buildEncodedElf(text), { view: 'encoding' });
    expect(noteText(r)).toMatch(/packed or encrypted/);
    expect(noteText(r)).not.toMatch(/Hidden channel likely/);
  });

  it('recovers an LSB-first, inverted stream when told so', async () => {
    const elf = buildEncodedElf(encode('FTF{test}', { msbFirst: false, invert: true }));
    expect(decoded(await run(elf, { view: 'encoding', bitOrder: 'lsb', invert: true }))).toContain(
      'FTF{test}',
    );
    expect(decoded(await run(elf, { view: 'encoding' }))).not.toContain('FTF{test}');
  });

  it('reads the bits only from the chosen families', async () => {
    const r = await run(buildEncodedElf(encode('FTF{test}')), {
      view: 'encoding',
      families: 'mov',
    });
    expect(decoded(r)).toContain('FTF{test}');
  });

  it('says plainly when the binary is not x86', async () => {
    const r = await run(buildEncodedElf(encode('FTF{test}'), 0xb7), { view: 'encoding' });
    expect(noteText(r)).toMatch(/not an x86/);
  });

  it('says plainly when there is no executable section', async () => {
    const r = await run(buildEncodedElf(new Uint8Array(0)), { view: 'encoding' });
    expect(noteText(r)).toMatch(/No executable section/);
  });
});
