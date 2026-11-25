// Generates public/samples/x86-stego.bin: a blob of 32-bit x86 machine code (never run) that hides
// a message in the ENCODING of register-register instructions, the channel read by the Executable
// analyzer's "Instruction encoding" view (src/tools/forensics/_exe-encoding.ts).
//
// Scheme: each reg-reg mov/ALU instruction carries one bit, in file order, most-significant bit
// first: 0 = normal opcode (89, 01, 31 ...), 1 = reversed opcode (8b, 03, 33 ...). The bit stream is
// a one-byte length (u8) then the message, then normal-form (0) padding so the body ends on a
// non-readable byte. Plain one-byte instructions (push/pop/nop) are interleaved as camouflage.
// Deterministic: fixed LCG, no Date/random.
//
//   node scripts/gen-samples-x86.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MESSAGE = 'FTF{x86_encoded}';
const out = fileURLToPath(new URL('../public/samples/x86-stego.bin', import.meta.url));

let seed = 0x5eed1234;
const rnd = (n) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (seed >>> 16) % n;
};

const msg = new TextEncoder().encode(MESSAGE);
const bytes = [msg.length, ...msg, 0, 0, 0, 0];
const bits = bytes.flatMap((b) => Array.from({ length: 8 }, (_, j) => (b >> (7 - j)) & 1));

// Base (MR, direction bit 0) 32-bit opcodes: add or adc sbb and sub xor cmp, mov.
const BASE = [0x01, 0x09, 0x11, 0x19, 0x21, 0x29, 0x31, 0x39, 0x89];
const code = [0x55, 0x90]; // push ebp; nop (not dual-form, so the bit stream starts at the payload)
for (const bit of bits) {
  if (rnd(4) === 0) code.push([0x90, 0x50, 0x58, 0x53, 0x5b][rnd(5)]);
  const base = BASE[rnd(BASE.length)];
  const modrm = 0xc0 | (rnd(8) << 3) | rnd(8);
  code.push(bit ? base | 2 : base, modrm);
}
code.push(0x5d, 0xc3); // pop ebp; ret

const blob = Uint8Array.from(code);
writeFileSync(out, blob);
console.log(`x86-stego.bin: ${blob.length} bytes, ${bits.length} hidden bits`);
