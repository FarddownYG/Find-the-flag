import {
  createMD5,
  createSHA1,
  createSHA256,
  createSHA384,
  createSHA512,
  type IHasher,
} from 'hash-wasm';

/** Hash functions HMAC is offered for. Block sizes are those of the underlying compression function. */
export type HmacAlgo = 'md5' | 'sha1' | 'sha256' | 'sha384' | 'sha512';

const BLOCK: Record<HmacAlgo, number> = {
  md5: 64,
  sha1: 64,
  sha256: 64,
  sha384: 128,
  sha512: 128,
};

const FACTORY: Record<HmacAlgo, () => Promise<IHasher>> = {
  md5: createMD5,
  sha1: createSHA1,
  sha256: createSHA256,
  sha384: createSHA384,
  sha512: createSHA512,
};

export type Hmac = (key: Uint8Array, message: Uint8Array) => Uint8Array;

/**
 * HMAC (RFC 2104) on top of one reusable hash-wasm hasher. Synchronous once created, so a
 * wordlist loop does not pay for a new WASM instance per candidate, and it works on pages that
 * are not a secure context (where `crypto.subtle` does not exist).
 */
export async function createHmac(algo: HmacAlgo): Promise<Hmac> {
  const hasher = await FACTORY[algo]();
  const block = BLOCK[algo];
  return (key, message) => {
    let k = key;
    if (k.length > block) {
      hasher.init();
      hasher.update(k);
      k = hasher.digest('binary');
    }
    const inner = new Uint8Array(block).fill(0x36);
    const outer = new Uint8Array(block).fill(0x5c);
    for (let i = 0; i < k.length; i++) {
      inner[i] = inner[i]! ^ k[i]!;
      outer[i] = outer[i]! ^ k[i]!;
    }
    hasher.init();
    hasher.update(inner);
    hasher.update(message);
    const innerDigest = hasher.digest('binary');
    hasher.init();
    hasher.update(outer);
    hasher.update(innerDigest);
    return hasher.digest('binary');
  };
}
