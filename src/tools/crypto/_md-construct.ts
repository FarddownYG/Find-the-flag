/**
 * Resumable Merkle–Damgård hashes (MD5, SHA-1, SHA-256, SHA-512) implemented from scratch so the
 * internal state can be *set* from a known digest and the message-length counter continued. That
 * is what a length-extension attack needs and what a hashing library never exposes. These are used
 * only by the hash-extender tool; the normal hash tool keeps using hash-wasm. Everything runs in
 * the browser on bytes the user provides — nothing is sent anywhere.
 *
 * Each algorithm is a Merkle–Damgård construction: an internal state is updated block by block,
 * and the final digest is that state once a padding (a 0x80 byte, zeros, then the message bit
 * length) has rounded the message up to a whole number of blocks. Because the digest *is* the
 * state, an attacker who knows H(secret‖message) and the length of secret‖message can keep hashing
 * from there — the construction has no idea where the real message ended.
 */

export type MdAlgo = 'md5' | 'sha1' | 'sha256' | 'sha512';

export interface MdSpec {
  /** Bytes per compression block (64 for all but SHA-512, which uses 128). */
  readonly blockBytes: number;
  /** Digest length in bytes. */
  readonly digestBytes: number;
  /** Size of the trailing message-length field, in bytes (8, or 16 for SHA-512). */
  readonly lengthBytes: number;
  /** Length field byte order: SHA-* big-endian, MD5 little-endian. */
  readonly lengthBE: boolean;
  /** Parse a digest back into internal state. */
  stateFromDigest(d: Uint8Array): unknown;
  /** Serialise internal state to the digest bytes. */
  digestFromState(s: unknown): Uint8Array;
  /** Fresh initial state. */
  initState(): unknown;
  /** Compress one block (blockBytes long) at buf[off…] into the state, in place. */
  compress(s: unknown, buf: Uint8Array, off: number): void;
}

// ---------- 32-bit helpers ----------

const rotl32 = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;
const rotr32 = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

// ---------- MD5 ----------

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  return k;
})();

const md5: MdSpec = {
  blockBytes: 64,
  digestBytes: 16,
  lengthBytes: 8,
  lengthBE: false,
  initState: () => new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]),
  stateFromDigest(d) {
    const s = new Uint32Array(4);
    for (let i = 0; i < 4; i++) {
      s[i] =
        (d[i * 4]! | (d[i * 4 + 1]! << 8) | (d[i * 4 + 2]! << 16) | (d[i * 4 + 3]! << 24)) >>> 0;
    }
    return s;
  },
  digestFromState(s) {
    const st = s as Uint32Array;
    const out = new Uint8Array(16);
    for (let i = 0; i < 4; i++) {
      out[i * 4] = st[i]! & 0xff;
      out[i * 4 + 1] = (st[i]! >>> 8) & 0xff;
      out[i * 4 + 2] = (st[i]! >>> 16) & 0xff;
      out[i * 4 + 3] = (st[i]! >>> 24) & 0xff;
    }
    return out;
  },
  compress(s, buf, off) {
    const st = s as Uint32Array;
    const m = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      m[i] = (buf[j]! | (buf[j + 1]! << 8) | (buf[j + 2]! << 16) | (buf[j + 3]! << 24)) >>> 0;
    }
    let [a, b, c, d] = [st[0]!, st[1]!, st[2]!, st[3]!];
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + MD5_K[i]! + m[g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl32(f, MD5_S[i]!)) >>> 0;
    }
    st[0] = (st[0]! + a) >>> 0;
    st[1] = (st[1]! + b) >>> 0;
    st[2] = (st[2]! + c) >>> 0;
    st[3] = (st[3]! + d) >>> 0;
  },
};

// ---------- SHA-1 ----------

const sha1: MdSpec = {
  blockBytes: 64,
  digestBytes: 20,
  lengthBytes: 8,
  lengthBE: true,
  initState: () => new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]),
  stateFromDigest(d) {
    const s = new Uint32Array(5);
    for (let i = 0; i < 5; i++) {
      s[i] =
        ((d[i * 4]! << 24) | (d[i * 4 + 1]! << 16) | (d[i * 4 + 2]! << 8) | d[i * 4 + 3]!) >>> 0;
    }
    return s;
  },
  digestFromState(s) {
    const st = s as Uint32Array;
    const out = new Uint8Array(20);
    for (let i = 0; i < 5; i++) {
      out[i * 4] = (st[i]! >>> 24) & 0xff;
      out[i * 4 + 1] = (st[i]! >>> 16) & 0xff;
      out[i * 4 + 2] = (st[i]! >>> 8) & 0xff;
      out[i * 4 + 3] = st[i]! & 0xff;
    }
    return out;
  },
  compress(s, buf, off) {
    const st = s as Uint32Array;
    const w = new Uint32Array(80);
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((buf[j]! << 24) | (buf[j + 1]! << 16) | (buf[j + 2]! << 8) | buf[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 80; i++) w[i] = rotl32(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let [a, b, c, d, e] = [st[0]!, st[1]!, st[2]!, st[3]!, st[4]!];
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl32(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = t;
    }
    st[0] = (st[0]! + a) >>> 0;
    st[1] = (st[1]! + b) >>> 0;
    st[2] = (st[2]! + c) >>> 0;
    st[3] = (st[3]! + d) >>> 0;
    st[4] = (st[4]! + e) >>> 0;
  },
};

// ---------- SHA-256 ----------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const sha256: MdSpec = {
  blockBytes: 64,
  digestBytes: 32,
  lengthBytes: 8,
  lengthBE: true,
  initState: () =>
    new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
      0x5be0cd19,
    ]),
  stateFromDigest(d) {
    const s = new Uint32Array(8);
    for (let i = 0; i < 8; i++) {
      s[i] =
        ((d[i * 4]! << 24) | (d[i * 4 + 1]! << 16) | (d[i * 4 + 2]! << 8) | d[i * 4 + 3]!) >>> 0;
    }
    return s;
  },
  digestFromState(s) {
    const st = s as Uint32Array;
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = (st[i]! >>> 24) & 0xff;
      out[i * 4 + 1] = (st[i]! >>> 16) & 0xff;
      out[i * 4 + 2] = (st[i]! >>> 8) & 0xff;
      out[i * 4 + 3] = st[i]! & 0xff;
    }
    return out;
  },
  compress(s, buf, off) {
    const st = s as Uint32Array;
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((buf[j]! << 24) | (buf[j + 1]! << 16) | (buf[j + 2]! << 8) | buf[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15]!, 7) ^ rotr32(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr32(w[i - 2]!, 17) ^ rotr32(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [st[0]!, st[1]!, st[2]!, st[3]!, st[4]!, st[5]!, st[6]!, st[7]!];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const add = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) st[i] = (st[i]! + add[i]!) >>> 0;
  },
};

// ---------- SHA-512 (64-bit words via BigInt) ----------

const MASK64 = (1n << 64n) - 1n;
const rotr64 = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & MASK64;

const SHA512_K: bigint[] = [
  '0x428a2f98d728ae22',
  '0x7137449123ef65cd',
  '0xb5c0fbcfec4d3b2f',
  '0xe9b5dba58189dbbc',
  '0x3956c25bf348b538',
  '0x59f111f1b605d019',
  '0x923f82a4af194f9b',
  '0xab1c5ed5da6d8118',
  '0xd807aa98a3030242',
  '0x12835b0145706fbe',
  '0x243185be4ee4b28c',
  '0x550c7dc3d5ffb4e2',
  '0x72be5d74f27b896f',
  '0x80deb1fe3b1696b1',
  '0x9bdc06a725c71235',
  '0xc19bf174cf692694',
  '0xe49b69c19ef14ad2',
  '0xefbe4786384f25e3',
  '0x0fc19dc68b8cd5b5',
  '0x240ca1cc77ac9c65',
  '0x2de92c6f592b0275',
  '0x4a7484aa6ea6e483',
  '0x5cb0a9dcbd41fbd4',
  '0x76f988da831153b5',
  '0x983e5152ee66dfab',
  '0xa831c66d2db43210',
  '0xb00327c898fb213f',
  '0xbf597fc7beef0ee4',
  '0xc6e00bf33da88fc2',
  '0xd5a79147930aa725',
  '0x06ca6351e003826f',
  '0x142929670a0e6e70',
  '0x27b70a8546d22ffc',
  '0x2e1b21385c26c926',
  '0x4d2c6dfc5ac42aed',
  '0x53380d139d95b3df',
  '0x650a73548baf63de',
  '0x766a0abb3c77b2a8',
  '0x81c2c92e47edaee6',
  '0x92722c851482353b',
  '0xa2bfe8a14cf10364',
  '0xa81a664bbc423001',
  '0xc24b8b70d0f89791',
  '0xc76c51a30654be30',
  '0xd192e819d6ef5218',
  '0xd69906245565a910',
  '0xf40e35855771202a',
  '0x106aa07032bbd1b8',
  '0x19a4c116b8d2d0c8',
  '0x1e376c085141ab53',
  '0x2748774cdf8eeb99',
  '0x34b0bcb5e19b48a8',
  '0x391c0cb3c5c95a63',
  '0x4ed8aa4ae3418acb',
  '0x5b9cca4f7763e373',
  '0x682e6ff3d6b2b8a3',
  '0x748f82ee5defb2fc',
  '0x78a5636f43172f60',
  '0x84c87814a1f0ab72',
  '0x8cc702081a6439ec',
  '0x90befffa23631e28',
  '0xa4506cebde82bde9',
  '0xbef9a3f7b2c67915',
  '0xc67178f2e372532b',
  '0xca273eceea26619c',
  '0xd186b8c721c0c207',
  '0xeada7dd6cde0eb1e',
  '0xf57d4f7fee6ed178',
  '0x06f067aa72176fba',
  '0x0a637dc5a2c898a6',
  '0x113f9804bef90dae',
  '0x1b710b35131c471b',
  '0x28db77f523047d84',
  '0x32caab7b40c72493',
  '0x3c9ebe0a15c9bebc',
  '0x431d67c49c100d4c',
  '0x4cc5d4becb3e42b6',
  '0x597f299cfc657e2a',
  '0x5fcb6fab3ad6faec',
  '0x6c44198c4a475817',
].map((h) => BigInt(h));

const SHA512_INIT: bigint[] = [
  '0x6a09e667f3bcc908',
  '0xbb67ae8584caa73b',
  '0x3c6ef372fe94f82b',
  '0xa54ff53a5f1d36f1',
  '0x510e527fade682d1',
  '0x9b05688c2b3e6c1f',
  '0x1f83d9abfb41bd6b',
  '0x5be0cd19137e2179',
].map((h) => BigInt(h));

const sha512: MdSpec = {
  blockBytes: 128,
  digestBytes: 64,
  lengthBytes: 16,
  lengthBE: true,
  initState: () => SHA512_INIT.slice(),
  stateFromDigest(d) {
    const s: bigint[] = [];
    for (let i = 0; i < 8; i++) {
      let v = 0n;
      for (let b = 0; b < 8; b++) v = (v << 8n) | BigInt(d[i * 8 + b]!);
      s.push(v);
    }
    return s;
  },
  digestFromState(s) {
    const st = s as bigint[];
    const out = new Uint8Array(64);
    for (let i = 0; i < 8; i++) {
      let v = st[i]!;
      for (let b = 7; b >= 0; b--) {
        out[i * 8 + b] = Number(v & 0xffn);
        v >>= 8n;
      }
    }
    return out;
  },
  compress(s, buf, off) {
    const st = s as bigint[];
    const w: bigint[] = new Array(80);
    for (let i = 0; i < 16; i++) {
      let v = 0n;
      for (let b = 0; b < 8; b++) v = (v << 8n) | BigInt(buf[off + i * 8 + b]!);
      w[i] = v;
    }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr64(w[i - 15]!, 1n) ^ rotr64(w[i - 15]!, 8n) ^ (w[i - 15]! >> 7n);
      const s1 = rotr64(w[i - 2]!, 19n) ^ rotr64(w[i - 2]!, 61n) ^ (w[i - 2]! >> 6n);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) & MASK64;
    }
    let [a, b, c, d, e, f, g, h] = st;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr64(e!, 14n) ^ rotr64(e!, 18n) ^ rotr64(e!, 41n);
      const ch = (e! & f!) ^ (~e! & MASK64 & g!);
      const t1 = (h! + S1 + ch + SHA512_K[i]! + w[i]!) & MASK64;
      const S0 = rotr64(a!, 28n) ^ rotr64(a!, 34n) ^ rotr64(a!, 39n);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) & MASK64;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & MASK64;
    }
    const add = [a!, b!, c!, d!, e!, f!, g!, h!];
    for (let i = 0; i < 8; i++) st[i] = (st[i]! + add[i]!) & MASK64;
  },
};

export const SPECS: Record<MdAlgo, MdSpec> = { md5, sha1, sha256, sha512 };

// ---------- padding and the construction ----------

/**
 * The Merkle–Damgård padding appended to a message of `msgLen` bytes: a 0x80 byte, zeros, then the
 * message bit length in the algorithm's length field. The glue padding of a length-extension
 * attack is exactly this computed for the original secret‖message length.
 */
export function mdPadding(spec: MdSpec, msgLen: number): Uint8Array {
  const rem = msgLen % spec.blockBytes;
  // One 0x80, then zeros up to the length field, crossing into the next block if needed.
  let padLen = spec.blockBytes - rem;
  if (padLen < 1 + spec.lengthBytes) padLen += spec.blockBytes;
  const pad = new Uint8Array(padLen);
  pad[0] = 0x80;
  const bitLen = BigInt(msgLen) * 8n;
  // The length field occupies the last `lengthBytes` of the padding.
  const start = padLen - spec.lengthBytes;
  if (spec.lengthBE) {
    for (let i = spec.lengthBytes - 1, v = bitLen; i >= 0; i--, v >>= 8n) {
      pad[start + i] = Number(v & 0xffn);
    }
  } else {
    for (let i = 0, v = bitLen; i < spec.lengthBytes; i++, v >>= 8n) {
      pad[start + i] = Number(v & 0xffn);
    }
  }
  return pad;
}

/** Normal hash of a full message — used to cross-check the construction against hash-wasm. */
export function mdHash(algo: MdAlgo, msg: Uint8Array): Uint8Array {
  const spec = SPECS[algo];
  const state = spec.initState();
  const pad = mdPadding(spec, msg.length);
  const buf = new Uint8Array(msg.length + pad.length);
  buf.set(msg);
  buf.set(pad, msg.length);
  for (let off = 0; off < buf.length; off += spec.blockBytes) spec.compress(state, buf, off);
  return spec.digestFromState(state);
}

export interface Extension {
  /** The glue padding to splice between the original message and the appended data. */
  glue: Uint8Array;
  /** The forged digest H(secret ‖ original ‖ glue ‖ append), hex. */
  forgedDigest: Uint8Array;
}

/**
 * The core of the attack. Given the known digest of `secret‖original`, the total length of
 * `secret‖original` in bytes, and the bytes to append, resume hashing from the digest's state and
 * finalise. Returns the glue padding and the forged digest. The forged message the server will
 * accept is `original ‖ glue ‖ append`.
 */
export function extend(
  algo: MdAlgo,
  knownDigest: Uint8Array,
  priorLen: number,
  append: Uint8Array,
): Extension {
  const spec = SPECS[algo];
  if (knownDigest.length !== spec.digestBytes) {
    throw new Error(`digest must be ${spec.digestBytes} bytes for ${algo}`);
  }
  const glue = mdPadding(spec, priorLen);
  const priorConsumed = priorLen + glue.length; // block-aligned
  const total = priorConsumed + append.length;
  const finalPad = mdPadding(spec, total);
  const buf = new Uint8Array(append.length + finalPad.length); // multiple of blockBytes
  buf.set(append);
  buf.set(finalPad, append.length);
  const state = spec.stateFromDigest(knownDigest);
  for (let off = 0; off < buf.length; off += spec.blockBytes) spec.compress(state, buf, off);
  return { glue, forgedDigest: spec.digestFromState(state) };
}
