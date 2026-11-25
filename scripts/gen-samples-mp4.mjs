// Generates public/samples/mp4-encrypted-mdat.mp4. Deterministic. Everything is made up.
//
//   node scripts/gen-samples-mp4.mjs
//
// A structurally valid minimal MP4 (ftyp, moov{mvhd,trak{tkhd,mdia{mdhd,hdlr,minf{stbl}}}}, mdat).
// The sample tables reference ONLY the last 40 KiB of mdat. The first 1.9 MiB of mdat is
// high-entropy random bytes (fixed PRNG, no magic) that no sample references: it simulates an
// encrypted container (TCSteg / VeraCrypt) hidden in the media data. There is no readable flag.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('../public/samples/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const HIDDEN = 1900 * 1024; // unreferenced random region
const TAIL = 40 * 1024; // referenced samples
const NSAMP = 40;
const SSIZE = TAIL / NSAMP; // 1024 bytes each

const u32 = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u16 = (n) => Uint8Array.of((n >>> 8) & 255, n & 255);
const cat = (...a) => {
  const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of a) {
    o.set(x, p);
    p += x.length;
  }
  return o;
};
const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const zeros = (n) => new Uint8Array(n);
const box = (type, ...p) => {
  const body = cat(...p);
  return cat(u32(8 + body.length), str(type), body);
};
const full = (type, ver, flags, ...p) => box(type, Uint8Array.of(ver, 0, 0, flags), ...p);

// xorshift32, fixed seed; bytes taken from the high-quality upper bits of a mixed output
let s = 0x2545f491;
const next = () => {
  s ^= s << 13;
  s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5;
  s >>>= 0;
  return s;
};
const rnd = new Uint8Array(HIDDEN);
for (let i = 0; i < HIDDEN; i += 4) {
  const v = Math.imul(next(), 0x9e3779b1) >>> 0;
  for (let k = 0; k < 4 && i + k < HIDDEN; k++) rnd[i + k] = (v >>> (24 - 8 * k)) & 255;
}
// dummy samples: a repeating low-entropy ramp
const tail = new Uint8Array(TAIL);
for (let i = 0; i < TAIL; i++) tail[i] = (i % SSIZE) & 0x3f;

const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('mp41'));
const matrix = cat(u32(0x10000), zeros(12), u32(0x10000), zeros(12), u32(0x40000000));
const mvhd = full(
  'mvhd',
  0,
  0,
  zeros(8),
  u32(1000),
  u32(NSAMP * 1000),
  u32(0x10000),
  u16(0x100),
  zeros(10),
  matrix,
  zeros(24),
  u32(2),
);
const tkhd = full(
  'tkhd',
  0,
  3,
  zeros(8),
  u32(1),
  zeros(4),
  u32(NSAMP * 1000),
  zeros(8),
  u16(0),
  u16(0),
  u16(0),
  u16(0),
  matrix,
  u32(320 << 16),
  u32(240 << 16),
);
const mdhd = full('mdhd', 0, 0, zeros(8), u32(1000), u32(NSAMP * 1000), u16(0x55c4), u16(0));
const hdlr = full('hdlr', 0, 0, zeros(4), str('vide'), zeros(12), str('FTF\0'));
const vmhd = full('vmhd', 0, 1, zeros(8));
const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
const stsd = full(
  'stsd',
  0,
  0,
  u32(1),
  box(
    'avc1',
    zeros(6),
    u16(1),
    zeros(16),
    u16(320),
    u16(240),
    u32(0x480000),
    u32(0x480000),
    zeros(4),
    u16(1),
    zeros(32),
    u16(0x18),
    u16(0xffff),
  ),
);
const stts = full('stts', 0, 0, u32(1), u32(NSAMP), u32(1000));
const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(NSAMP), u32(1));
const stsz = full(
  'stsz',
  0,
  0,
  u32(0),
  u32(NSAMP),
  ...Array.from({ length: NSAMP }, () => u32(SSIZE)),
);
const mk = (stco) => {
  const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
  const moov = box(
    'moov',
    mvhd,
    box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', vmhd, dinf, stbl))),
  );
  return moov;
};
const stcoOf = (off) => full('stco', 0, 0, u32(1), u32(off));
const moovLen = mk(stcoOf(0)).length;
const mdatStart = ftyp.length + moovLen; // offset of the mdat box header
const payloadStart = mdatStart + 8;
const firstSample = payloadStart + HIDDEN;
const moov = mk(stcoOf(firstSample));
const mdat = box('mdat', rnd, tail);
const out = cat(ftyp, moov, mdat);
writeFileSync(outDir + 'mp4-encrypted-mdat.mp4', out);
console.log(
  `mp4-encrypted-mdat.mp4 ${out.length} bytes; hidden region offset ${payloadStart} size ${HIDDEN}; samples at ${firstSample}..${out.length}`,
);
