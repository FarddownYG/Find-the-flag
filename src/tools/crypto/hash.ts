import {
  adler32,
  blake2b,
  blake3,
  crc32,
  keccak,
  md4,
  md5,
  ripemd160,
  sha1,
  sha224,
  sha256,
  sha3,
  sha384,
  sha512,
  whirlpool,
  xxhash64,
} from 'hash-wasm';
import { defineTool, bool, text } from '../../core/define';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import type { Output } from '../../core/types';
import { concatBytes, fromBase64, fromHex, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import { createHmac, type HmacAlgo } from './_hmac';

interface Algo {
  name: string;
  run: (data: Uint8Array) => Promise<string>;
}

/** Windows NTLM hashes are MD4 over the UTF-16LE form of the password. */
function utf16le(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

const ALGOS: Algo[] = [
  { name: 'MD5', run: md5 },
  { name: 'MD4', run: md4 },
  { name: 'NTLM', run: (d) => md4(utf16le(utf8Decode(d))) },
  { name: 'SHA-1', run: sha1 },
  { name: 'SHA-224', run: sha224 },
  { name: 'SHA-256', run: sha256 },
  { name: 'SHA-384', run: sha384 },
  { name: 'SHA-512', run: sha512 },
  { name: 'SHA3-224', run: (d) => sha3(d, 224) },
  { name: 'SHA3-256', run: (d) => sha3(d, 256) },
  { name: 'SHA3-384', run: (d) => sha3(d, 384) },
  { name: 'SHA3-512', run: (d) => sha3(d, 512) },
  { name: 'Keccak-256', run: (d) => keccak(d, 256) },
  { name: 'Keccak-512', run: (d) => keccak(d, 512) },
  { name: 'RIPEMD-160', run: ripemd160 },
  { name: 'BLAKE2b-256', run: (d) => blake2b(d, 256) },
  { name: 'BLAKE2b-512', run: (d) => blake2b(d, 512) },
  { name: 'BLAKE3', run: (d) => blake3(d) },
  { name: 'Whirlpool', run: whirlpool },
  { name: 'CRC32', run: (d) => crc32(d) },
  { name: 'Adler-32', run: adler32 },
  { name: 'xxHash64', run: (d) => xxhash64(d) },
];

const HMACS: { name: string; algo: HmacAlgo }[] = [
  { name: 'HMAC-MD5', algo: 'md5' },
  { name: 'HMAC-SHA1', algo: 'sha1' },
  { name: 'HMAC-SHA256', algo: 'sha256' },
  { name: 'HMAC-SHA384', algo: 'sha384' },
  { name: 'HMAC-SHA512', algo: 'sha512' },
];

type Row = [name: string, hex: string];

async function digests(data: Uint8Array): Promise<Row[]> {
  return Promise.all(ALGOS.map(async (a): Promise<Row> => [a.name, await a.run(data)]));
}

async function hmacs(data: Uint8Array, key: Uint8Array): Promise<Row[]> {
  return Promise.all(
    HMACS.map(async (h): Promise<Row> => {
      const mac = await createHmac(h.algo);
      return [h.name, toHex(mac(key, data))];
    }),
  );
}

/** Accepts hex (with 0x, colons, spaces, "hash  filename" lines) or Base64 and returns lowercase hex. */
function normalizeExpected(raw: string): string {
  const token = raw.trim().split(/\s+/)[0] ?? '';
  const hexish = token.replace(/^0x/i, '').replace(/:/g, '');
  if (/^[0-9a-f]+$/i.test(hexish)) {
    const hex = hexish.toLowerCase();
    return hex.length < 8 ? hex.padStart(8, '0') : hex;
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(token) && token.length >= 8) {
    return toHex(fromBase64(token));
  }
  throw new ToolError(T('error.notHex', { example: '5d41402abc4b2a76b9719d911017c592' }));
}

const T = toolT('hash');

const withNewline = (b: Uint8Array) => concatBytes(b, Uint8Array.of(10));
const withoutNewline = (b: Uint8Array) =>
  b.length > 0 && b[b.length - 1] === 10
    ? b.subarray(0, b.length > 1 && b[b.length - 2] === 13 ? b.length - 2 : b.length - 1)
    : null;

export default defineTool({
  id: 'hash',
  name: 'Hash / checksum',
  category: 'crypto',
  description:
    'MD5, SHA-1/2/3, NTLM, RIPEMD, BLAKE, Whirlpool, CRC32 and more in one run, with HMAC and compare.',
  tags: [
    'md5',
    'sha1',
    'sha256',
    'sha512',
    'sha3',
    'keccak',
    'ntlm',
    'md4',
    'ripemd',
    'blake2',
    'blake3',
    'whirlpool',
    'crc32',
    'adler32',
    'xxhash',
    'checksum',
    'digest',
    'hmac',
    'md5sum',
    'sha256sum',
  ],
  input: 'bytes',
  placeholder: 'hello',
  live: true,
  options: {
    hmacKey: text('HMAC key', '', {
      placeholder: 'optional: adds HMAC-MD5/SHA1/SHA256/SHA384/SHA512',
    }),
    keyHex: bool('Key is hex', false, {
      showIf: (v) => v.hmacKey !== '',
      hint: 'Read the HMAC key as hex bytes instead of UTF-8 text',
    }),
    expected: text('Compare with', '', {
      placeholder: 'paste a known hash to find its algorithm',
      hint: 'Hex or Base64. Tells you which algorithm (and HMAC) produces exactly this value.',
    }),
    uppercase: bool('Uppercase hex', false),
  },
  examples: [
    {
      label: 'MD5 of "hello"',
      input: 'hello',
      expect: '5d41402abc4b2a76b9719d911017c592',
    },
    {
      label: 'NTLM of a password',
      input: 'password',
      expect: '8846f7eaee8fb117ad06bdd830b7586c',
    },
    {
      label: 'Which algorithm is this?',
      input: 'hello',
      options: { expected: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
      expect: 'Matches SHA-256',
    },
    {
      label: 'HMAC with a key',
      input: 'The quick brown fox jumps over the lazy dog',
      options: { hmacKey: 'key' },
      expect: '80070713463e7749b90c2dc24911e275',
    },
  ],
  async run({ bytes }, { hmacKey, keyHex, expected, uppercase }) {
    const fmt = (h: string) => (uppercase ? h.toUpperCase() : h);
    const plain = await digests(bytes);
    const macs = hmacKey ? await hmacs(bytes, keyHex ? fromHex(hmacKey) : utf8Encode(hmacKey)) : [];
    const out: Output[] = [];

    const target = expected.trim() ? normalizeExpected(expected) : null;
    const matchIdx = (rows: Row[]) =>
      rows.flatMap(([, hex], i) => (target !== null && hex === target ? [i] : []));
    const plainHits = matchIdx(plain);
    const macHits = matchIdx(macs);

    out.push({
      type: 'table',
      label: T('label.digests', { count: bytes.length }),
      columns: [T('col.algorithm'), T('col.hash')],
      rows: plain.map(([n, h]) => [n, fmt(h)]),
      highlight: plainHits,
    });
    if (macs.length) {
      out.push({
        type: 'table',
        label: 'HMAC',
        columns: [T('col.algorithm'), T('col.hash')],
        rows: macs.map(([n, h]) => [n, fmt(h)]),
        highlight: macHits,
      });
    }

    if (target !== null) {
      const names = [...plainHits.map((i) => plain[i]![0]), ...macHits.map((i) => macs[i]![0])];
      if (names.length) {
        out.push({
          type: 'note',
          level: 'success',
          text: T('note.matches', { names: names.join(' / ') }),
        });
      } else {
        out.push(...(await explainMiss(bytes, target, plain, macs.length > 0)));
      }
    }
    return out;
  },
});

/** No row matched: say what the length allows, and whether a stray newline is the culprit. */
async function explainMiss(
  bytes: Uint8Array,
  target: string,
  plain: Row[],
  hadKey: boolean,
): Promise<Output[]> {
  const out: Output[] = [];
  const variants: [string, Uint8Array][] = [[T('variant.added'), withNewline(bytes)]];
  const trimmed = withoutNewline(bytes);
  if (trimmed) variants.push([T('variant.removed'), trimmed]);
  for (const [what, data] of variants) {
    const hit = (await digests(data)).filter(([, h]) => h === target).map(([n]) => n);
    if (hit.length) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.newline', { names: hit.join(' / '), what }),
      });
      return out;
    }
  }
  const sameSize = plain.filter(([, h]) => h.length === target.length).map(([n]) => n);
  const size = T('text.size', { digits: target.length, bits: target.length * 4 });
  out.push({
    type: 'note',
    level: 'warn',
    text: sameSize.length
      ? T(hadKey ? 'note.noMatchSameSizeKey' : 'note.noMatchSameSizeHmac', {
          size,
          names: sameSize.join(', '),
        })
      : T('note.noMatchSize', { size }),
  });
  return out;
}
