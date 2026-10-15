/**
 * DES and Triple DES (FIPS 46-3 / NIST SP 800-67), written out from the standard's tables.
 * The vetted AES/ChaCha library has no DES, so it is implemented here and checked against the
 * published known-answer vectors (see symmetric.test.ts). Obsolete cipher, kept for CTFs.
 *
 * Bit numbers in the tables are the standard's: 1 = most significant bit.
 */
import type { BlockCipher } from './_modes';

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64,
  56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53,
  45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37,
  5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2,
  42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

/** Permutation applied to the S-box outputs. */
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13,
  30, 6, 22, 11, 4, 25,
];

const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60,
  52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21,
  13, 5, 28, 20, 12, 4,
];

const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52,
  31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

/** S1..S8, each 4 rows of 16 values, row-major. */
const SBOX: number[][] = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11,
    9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5,
    11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10,
    6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2,
    11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12,
    11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4,
    15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1,
    10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9,
    4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10,
    3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6,
    15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14,
    0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10,
    11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12,
    2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9,
    5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11,
    0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13,
    15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

/**
 * S-box j followed by the P permutation, as one lookup: SP[j][6-bit input] is the 32-bit value
 * that box contributes to the round function (the boxes' output bits never overlap).
 */
const SP: Uint32Array[] = SBOX.map((box, j) => {
  const table = new Uint32Array(64);
  for (let v = 0; v < 64; v++) {
    const row = ((v >> 4) & 2) | (v & 1);
    const col = (v >> 1) & 15;
    const pre = (box[row * 16 + col]! << (28 - 4 * j)) >>> 0;
    let out = 0;
    for (let i = 0; i < 32; i++) out |= ((pre >>> (32 - P[i]!)) & 1) << (31 - i);
    table[v] = out >>> 0;
  }
  return table;
});

/** Apply a 64-bit permutation table to the block (hi, lo). */
function permute64(hi: number, lo: number, table: readonly number[]): [number, number] {
  let oh = 0;
  let ol = 0;
  for (let i = 0; i < 64; i++) {
    const p = table[i]! - 1;
    const bit = p < 32 ? (hi >>> (31 - p)) & 1 : (lo >>> (63 - p)) & 1;
    if (i < 32) oh |= bit << (31 - i);
    else ol |= bit << (63 - i);
  }
  return [oh >>> 0, ol >>> 0];
}

/** The 16 round keys of one 8-byte key (parity bits are ignored), as 8 six-bit groups each. */
function schedule(key: Uint8Array): Uint8Array[] {
  const bits: number[] = [];
  for (let i = 0; i < 64; i++) bits.push((key[i >> 3]! >> (7 - (i & 7))) & 1);
  const cd = PC1.map((p) => bits[p - 1]!);
  let c = cd.slice(0, 28);
  let d = cd.slice(28);
  const out: Uint8Array[] = [];
  for (let r = 0; r < 16; r++) {
    const s = SHIFTS[r]!;
    c = [...c.slice(s), ...c.slice(0, s)];
    d = [...d.slice(s), ...d.slice(0, s)];
    const cdr = [...c, ...d];
    const k = new Uint8Array(8);
    for (let g = 0; g < 8; g++) {
      let v = 0;
      for (let b = 0; b < 6; b++) v = (v << 1) | cdr[PC2[g * 6 + b]! - 1]!;
      k[g] = v;
    }
    out.push(k);
  }
  return out;
}

/** The 16 Feistel rounds. Returns [R16, L16], the "pre-output" block before the final permutation. */
function rounds(
  l: number,
  r: number,
  ks: readonly Uint8Array[],
  decrypt: boolean,
): [number, number] {
  for (let i = 0; i < 16; i++) {
    const k = ks[decrypt ? 15 - i : i]!;
    // E expansion: six bits per S-box out of a rotated copy of R.
    const a = ((r >>> 1) | (r << 31)) >>> 0;
    const f =
      SP[0]![((a >>> 26) & 63) ^ k[0]!]! |
      SP[1]![((a >>> 22) & 63) ^ k[1]!]! |
      SP[2]![((a >>> 18) & 63) ^ k[2]!]! |
      SP[3]![((a >>> 14) & 63) ^ k[3]!]! |
      SP[4]![((a >>> 10) & 63) ^ k[4]!]! |
      SP[5]![((a >>> 6) & 63) ^ k[5]!]! |
      SP[6]![((a >>> 2) & 63) ^ k[6]!]! |
      SP[7]![(((a & 15) << 2) | (a >>> 30)) ^ k[7]!]!;
    const next = (l ^ f) >>> 0;
    l = r;
    r = next;
  }
  return [r, l];
}

const load = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

function store(b: Uint8Array, o: number, v: number): void {
  b[o] = v >>> 24;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

/**
 * Run the keys in `stages` over one block: each stage is a key schedule and a direction. Between
 * two stages the final and initial permutations cancel, so they are only applied at the ends.
 */
function run(block: Uint8Array, stages: readonly { ks: Uint8Array[]; decrypt: boolean }[]): void {
  let [l, r] = permute64(load(block, 0), load(block, 4), IP);
  for (const s of stages) {
    [l, r] = rounds(l, r, s.ks, s.decrypt);
  }
  // `rounds` returns the pre-output block R16 L16, which is what FP takes (and, for the next
  // stage, what IP would give back).
  const [hi, lo] = permute64(l, r, FP);
  store(block, 0, hi);
  store(block, 4, lo);
}

/** Single DES: 8-byte key (the 8 parity bits are ignored), 8-byte blocks. */
export class Des implements BlockCipher {
  readonly blockSize = 8;
  private readonly ks: Uint8Array[];

  constructor(key: Uint8Array) {
    if (key.length !== 8) throw new RangeError('DES needs an 8-byte key');
    this.ks = schedule(key);
  }

  encryptBlock(block: Uint8Array): void {
    run(block, [{ ks: this.ks, decrypt: false }]);
  }

  decryptBlock(block: Uint8Array): void {
    run(block, [{ ks: this.ks, decrypt: true }]);
  }
}

/** Triple DES (EDE): 24-byte key (keying option 1) or 16-byte key (K3 = K1, keying option 2). */
export class TripleDes implements BlockCipher {
  readonly blockSize = 8;
  private readonly k1: Uint8Array[];
  private readonly k2: Uint8Array[];
  private readonly k3: Uint8Array[];

  constructor(key: Uint8Array) {
    if (key.length !== 16 && key.length !== 24) {
      throw new RangeError('3DES needs a 16-byte or 24-byte key');
    }
    this.k1 = schedule(key.subarray(0, 8));
    this.k2 = schedule(key.subarray(8, 16));
    this.k3 = key.length === 24 ? schedule(key.subarray(16, 24)) : this.k1;
  }

  encryptBlock(block: Uint8Array): void {
    run(block, [
      { ks: this.k1, decrypt: false },
      { ks: this.k2, decrypt: true },
      { ks: this.k3, decrypt: false },
    ]);
  }

  decryptBlock(block: Uint8Array): void {
    run(block, [
      { ks: this.k3, decrypt: true },
      { ks: this.k2, decrypt: false },
      { ks: this.k1, decrypt: true },
    ]);
  }
}
