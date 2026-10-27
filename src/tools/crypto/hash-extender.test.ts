import { md5, sha1, sha256, sha512 } from 'hash-wasm';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { defaultOptions } from '../../core/registry';
import type { Output, ToolResult } from '../../core/types';
import { fromHex, toHex, utf8Encode } from '../../lib/bytes';
import { extend, mdHash, type MdAlgo } from './_md-construct';
import tool from './hash-extender';

const ORACLE: Record<MdAlgo, (b: Uint8Array) => Promise<string>> = {
  md5,
  sha1,
  sha256,
  sha512,
};
const enc = (s: string) => utf8Encode(s);
const run = (input: string, opts: Record<string, unknown> = {}): ToolResult =>
  tool.run(input, { ...defaultOptions(tool as never), ...opts } as never) as ToolResult;
const table = (r: ToolResult) =>
  r.find((o): o is Extract<Output, { type: 'table' }> => o.type === 'table')!;

// Message lengths that straddle the block / length-field boundaries of each algorithm.
const LENS = [0, 1, 3, 55, 56, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 200];

describe('the Merkle–Damgård construction matches hash-wasm', () => {
  for (const algo of ['md5', 'sha1', 'sha256', 'sha512'] as const) {
    it(`${algo}: plain hashing is byte-exact`, async () => {
      for (const n of LENS) {
        const msg = enc('a'.repeat(n));
        expect(toHex(mdHash(algo, msg)), `${algo} len ${n}`).toBe(await ORACLE[algo](msg));
      }
    });
  }
});

describe('length extension is accepted by the real hash', () => {
  for (const algo of ['md5', 'sha1', 'sha256', 'sha512'] as const) {
    it(`${algo}: a forged digest verifies against H(secret ‖ forged message)`, async () => {
      for (const [secret, original, append] of [
        ['secretkey', 'user=bob&role=user', '&role=admin'],
        ['', 'nosecret', 'tail'],
        ['x'.repeat(40), 'amount=1', '&amount=999999'],
        ['keykeykeykeykey!', 'a', '\x00\x80\xff'],
      ] as const) {
        const known = fromHex(await ORACLE[algo](enc(secret + original)));
        const { glue, forgedDigest } = extend(
          algo,
          known,
          secret.length + original.length,
          enc(append),
        );
        const forged = new Uint8Array([...enc(secret), ...enc(original), ...glue, ...enc(append)]);
        expect(toHex(forgedDigest), `${algo} secret=${secret.length}`).toBe(
          await ORACLE[algo](forged),
        );
      }
    });
  }
});

describe('the tool', () => {
  it('forges a hash the real server would accept (example 1)', async () => {
    const secret = 'SECRET';
    const original = 'user=guest&role=guest';
    const digest = await sha256(enc(secret + original));
    const r = run('&role=admin', {
      algo: 'sha256',
      digest,
      original,
      encoding: 'text',
      keyLenMin: secret.length,
      keyLenMax: secret.length,
    });
    const [, forgedHash, url] = table(r).rows[0] as [number, string, string];
    // Rebuild the message the attacker sends and hash secret ‖ message as the server would.
    const glueAndAppend = url.replace(/%([0-9a-f]{2})/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    );
    const serverInput = new Uint8Array([
      ...enc(secret),
      ...[...glueAndAppend].map((c) => c.charCodeAt(0)),
    ]);
    expect(forgedHash).toBe(await sha256(serverInput));
    expect(url).toContain('role%3dadmin');
  });

  it('reads the algorithm from the digest length (auto)', () => {
    const digest = 'a'.repeat(40); // 40 hex = SHA-1
    const kv = run('x', { algo: 'auto', digest, original: 'm' }).find((o) => o.type === 'kv');
    expect(kv && kv.type === 'kv' && kv.entries.some(([, v]) => v === 'SHA1')).toBe(true);
  });

  it('produces one candidate per secret length in a range', () => {
    const r = run('&admin=1', {
      algo: 'md5',
      digest: 'a6a94665f46348b03c97e63d5c0eb545',
      original: 'count=10',
      keyLenMin: 8,
      keyLenMax: 16,
    });
    expect(table(r).rows).toHaveLength(9);
  });

  it('accepts hex-encoded message and append', async () => {
    const secret = 'topsecret';
    const original = utf8Encode('id=7');
    const append = new Uint8Array([0x00, 0x01, 0xff]);
    const digest = await sha1(new Uint8Array([...utf8Encode(secret), ...original]));
    const r = run(toHex(append), {
      algo: 'sha1',
      digest,
      original: toHex(original),
      encoding: 'hex',
      keyLenMin: secret.length,
      keyLenMax: secret.length,
    });
    const [, forgedHash, url] = table(r).rows[0] as [number, string, string];
    const glueAndAppend = url.replace(/%([0-9a-f]{2})/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    );
    const serverInput = new Uint8Array([
      ...utf8Encode(secret),
      ...[...glueAndAppend].map((c) => c.charCodeAt(0)),
    ]);
    expect(forgedHash).toBe(await sha1(serverInput));
  });

  it('rejects a missing, malformed or wrong-length digest', () => {
    expect(() => run('x', { algo: 'sha256', digest: '' })).toThrow(ToolError);
    expect(() => run('x', { algo: 'sha256', digest: 'nothex!!' })).toThrow(ToolError);
    expect(() => run('x', { algo: 'sha256', digest: 'ab' })).toThrow(ToolError);
    expect(() => run('x', { algo: 'auto', digest: 'abcdef' })).toThrow(ToolError); // length 6 → no algo
  });

  it('says plainly it is offline and names the hashes it does not break', () => {
    const notes = run('x', {
      algo: 'md5',
      digest: 'a6a94665f46348b03c97e63d5c0eb545',
      original: 'm',
    })
      .filter((o) => o.type === 'note')
      .map((o) => (o.type === 'note' ? o.text : ''))
      .join('\n');
    expect(notes).toContain('offline');
    expect(notes).toContain('HMAC');
  });

  it('runs every example to its expected text', () => {
    for (const ex of tool.examples) {
      const input = typeof ex.input === 'string' ? ex.input : '';
      const text = run(input, (ex.options ?? {}) as Record<string, unknown>)
        .map((o) => {
          if (o.type === 'note') return o.text;
          if (o.type === 'text') return `${o.label ?? ''}\n${o.value}`;
          if (o.type === 'table')
            return [o.label, ...o.rows.map((row) => row.join(' '))].join('\n');
          if (o.type === 'kv') return o.entries.map(([k, v]) => `${k}: ${v}`).join('\n');
          return '';
        })
        .join('\n');
      expect(text, ex.label).toContain(ex.expect);
    }
  });
});
