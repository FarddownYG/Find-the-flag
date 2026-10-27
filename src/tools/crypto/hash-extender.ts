import { defineTool, number, select, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import { toolT } from '../../i18n/tool-text';
import type { Output } from '../../core/types';
import { fromHex, toHex, utf8Encode } from '../../lib/bytes';
import { extend, SPECS, type MdAlgo } from './_md-construct';

const T = toolT('hash-extender');

const ALGO_BY_HEXLEN: Record<number, MdAlgo> = {
  32: 'md5',
  40: 'sha1',
  64: 'sha256',
  128: 'sha512',
};
const MAX_CANDIDATES = 64;
const MAX_DETAIL = 12;

/** RFC 3986 unreserved bytes stay as-is; everything else is percent-encoded (how you send it). */
function urlEncodeBytes(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    const unreserved =
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x30 && b <= 0x39) || // 0-9
      b === 0x2d ||
      b === 0x2e ||
      b === 0x5f ||
      b === 0x7e; // - . _ ~
    out += unreserved ? String.fromCharCode(b) : `%${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/** Decode a text field: plain UTF-8 with \xHH, \0, \n, \r, \t, \\ escapes, or raw hex. */
function decodeField(value: string, encoding: 'text' | 'hex', what: string): Uint8Array {
  if (encoding === 'hex') {
    const clean = value.replace(/0x/gi, '').replace(/[\s:,_-]/g, '');
    if (clean === '') return new Uint8Array(0);
    if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2 !== 0) {
      throw new ToolError(T('err.badHex', { what }));
    }
    return fromHex(clean);
  }
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '\\' && i + 1 < value.length) {
      const n = value[i + 1]!;
      if (n === 'x' && /^[0-9a-f]{2}$/i.test(value.slice(i + 2, i + 4))) {
        out.push(parseInt(value.slice(i + 2, i + 4), 16));
        i += 3;
        continue;
      }
      const simple: Record<string, number> = { '0': 0, n: 10, r: 13, t: 9, '\\': 92 };
      if (n in simple) {
        out.push(simple[n]!);
        i += 1;
        continue;
      }
    }
    // Encode this character as UTF-8.
    for (const byte of utf8Encode(c)) out.push(byte);
  }
  return Uint8Array.from(out);
}

export default defineTool({
  id: 'hash-extender',
  name: 'Hash length extension',
  category: 'crypto',
  description:
    'Forge a valid H(secret ‖ message ‖ padding ‖ your data) from a known MD5/SHA-1/SHA-256/SHA-512 hash and the message, without knowing the secret. 100% offline.',
  tags: [
    'hash length extension',
    'length extension',
    'hashpump',
    'hash_extender',
    'hpump',
    'merkle-damgard',
    'merkle damgard',
    'md5',
    'sha1',
    'sha256',
    'sha512',
    'secret prefix mac',
    'mac bypass',
    'glue padding',
    'padding attack',
    'forge signature',
    'extend',
  ],
  input: 'text',
  placeholder: 'Data to append, e.g. &admin=true',
  options: {
    algo: select(
      'Hash',
      [
        { value: 'auto', label: 'Auto (by length)' },
        { value: 'md5', label: 'MD5' },
        { value: 'sha1', label: 'SHA-1' },
        { value: 'sha256', label: 'SHA-256' },
        { value: 'sha512', label: 'SHA-512' },
      ],
      'auto',
      {
        hint: 'Auto reads the algorithm from the hex length (32 MD5, 40 SHA-1, 64 SHA-256, 128 SHA-512).',
      },
    ),
    digest: {
      type: 'text',
      label: 'Known hash (hex)',
      default: '',
      placeholder: 'the hex digest of secret ‖ message',
    },
    original: {
      type: 'text',
      label: 'Known message',
      default: '',
      placeholder: 'the part after the secret you already know, e.g. user=guest',
      hint: 'The bytes that follow the secret in what was hashed. The secret itself stays unknown.',
    },
    encoding: toggle('Message format', ['text', 'hex'], 'text', {
      hint: 'How the known message and the data to append are read. Text allows \\xHH, \\n, \\t, \\0 escapes.',
    }),
    keyLenMin: number('Secret length (bytes)', 8, { min: 0, max: 4096 }),
    keyLenMax: number('…up to', 8, {
      min: 0,
      max: 4096,
      hint: 'Set higher than the secret length to try a range when you do not know it exactly.',
    }),
  },
  examples: [
    {
      // Self-contained: this hash is sha256("SECRET" + "user=guest&role=guest"); the tool never
      // sees the secret, only its length (6).
      label: 'Forge an admin cookie (SHA-256)',
      input: '&role=admin',
      options: {
        algo: 'sha256',
        digest: '2d120c2f55e232a16d8004c59903da7e54c9753d3db7dc1885b490ca302bbfb4',
        original: 'user=guest&role=guest',
        keyLenMin: 6,
        keyLenMax: 6,
      },
      expect: 'role%3dadmin',
    },
    {
      label: 'Try a range of secret lengths (MD5)',
      input: '&admin=1',
      options: {
        algo: 'md5',
        digest: 'a6a94665f46348b03c97e63d5c0eb545',
        original: 'count=10',
        keyLenMin: 8,
        keyLenMax: 16,
      },
      expect: 'Secret length',
    },
  ],
  run(input, opts) {
    const digestHex = opts.digest.trim().replace(/^0x/i, '').replace(/\s+/g, '');
    if (!digestHex) throw new ToolError(T('err.noDigest'));
    if (!/^[0-9a-f]+$/i.test(digestHex) || digestHex.length % 2 !== 0) {
      throw new ToolError(T('err.badHex', { what: T('word.digest') }));
    }
    let algo = opts.algo as 'auto' | MdAlgo;
    if (algo === 'auto') {
      const inferred = ALGO_BY_HEXLEN[digestHex.length];
      if (!inferred) throw new ToolError(T('err.algoFromLen', { len: digestHex.length }));
      algo = inferred;
    }
    const spec = SPECS[algo];
    if (digestHex.length !== spec.digestBytes * 2) {
      throw new ToolError(
        T('err.digestLen', {
          algo: algo.toUpperCase(),
          bytes: spec.digestBytes,
          got: digestHex.length / 2,
        }),
      );
    }
    const knownDigest = fromHex(digestHex);
    const original = decodeField(opts.original, opts.encoding, T('word.message'));
    const append = decodeField(input, opts.encoding, T('word.append'));

    let lo = Math.floor(opts.keyLenMin);
    let hi = Math.floor(opts.keyLenMax);
    if (hi < lo) [lo, hi] = [hi, lo];
    if (lo < 0) lo = 0;
    const capped = hi - lo + 1 > MAX_CANDIDATES;
    if (capped) hi = lo + MAX_CANDIDATES - 1;

    const out: Output[] = [{ type: 'note', level: 'info', text: T('note.intro') }];

    const rows: (string | number)[][] = [];
    const details: Output[] = [];
    for (let keyLen = lo; keyLen <= hi; keyLen++) {
      const priorLen = keyLen + original.length;
      const { glue, forgedDigest } = extend(algo, knownDigest, priorLen, append);
      const message = new Uint8Array(original.length + glue.length + append.length);
      message.set(original);
      message.set(glue, original.length);
      message.set(append, original.length + glue.length);
      const hashHex = toHex(forgedDigest);
      const url = urlEncodeBytes(message);
      rows.push([keyLen, hashHex, url]);
      if (details.length < MAX_DETAIL * 2) {
        details.push({
          type: 'text',
          label: T('label.detail', { len: keyLen }),
          value: [
            `${T('word.forgedHash')}: ${hashHex}`,
            `${T('word.messageUrl')}: ${url}`,
            `${T('word.messageHex')}: ${toHex(message)}`,
            `${T('word.glueLen')}: ${glue.length}`,
          ].join('\n'),
        });
        details.push({
          type: 'bytes',
          label: T('label.messageBytes', { len: keyLen }),
          value: message,
          filename: `forged-${algo}-k${keyLen}.bin`,
        });
      }
    }

    out.push({
      type: 'kv',
      label: T('label.summary'),
      entries: [
        [T('kv.algo'), algo.toUpperCase()],
        [T('kv.candidates'), String(rows.length)],
      ],
    });
    out.push({
      type: 'table',
      label: T('label.candidates'),
      columns: [T('col.keyLen'), T('col.forgedHash'), T('col.message')],
      rows,
      highlight: rows.length === 1 ? [0] : [],
    });
    out.push(...details);
    if (capped)
      out.push({ type: 'note', level: 'warn', text: T('note.capped', { count: MAX_CANDIDATES }) });
    out.push({ type: 'note', level: 'warn', text: T('note.works') });
    out.push({ type: 'note', level: 'info', text: T('note.howto') });
    out.push({ type: 'note', level: 'info', text: T('note.static') });
    return out;
  },
});
