import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Output } from '../../core/types';
import { concatBytes, latin1Encode } from '../../lib/bytes';
const cat = (parts: Uint8Array[]) => concatBytes(...parts);
import { crc32 } from '../../lib/signatures';
import { parsePng, PNG_SIGNATURE } from './_png';
import { filesOf, notes, run, tableOf } from './_png-surgeon-kit';

// --- A tiny homemade APNG builder. No challenge material: all text is made up in the test. ---

const u32 = (n: number) =>
  Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u16 = (n: number) => Uint8Array.of((n >>> 8) & 255, n & 255);

function chunk(type: string, data: Uint8Array, badCrc = false): Uint8Array {
  const body = cat([latin1Encode(type), data]);
  const crc = badCrc ? (crc32(body) ^ 0x55555555) >>> 0 : crc32(body);
  return cat([u32(data.length), body, u32(crc)]);
}

const W = 4;
const H = 4;
// A valid grayscale 4×4 image stream (one filter byte + W samples per row), all zero.
const FRAME_ZLIB = zlibSync(new Uint8Array(H * (1 + W)));
const IHDR_DATA = cat([u32(W), u32(H), Uint8Array.of(8, 0, 0, 0, 0)]);

type Carrier = 'delayNum' | 'xOffset';

function fctl(seq: number, value: number, carrier: Carrier): Uint8Array {
  const delayNum = carrier === 'delayNum' ? value : 10;
  const x = carrier === 'xOffset' ? value : 0;
  return cat([
    u32(seq),
    u32(W),
    u32(H),
    u32(x),
    u32(0), // y
    u16(delayNum),
    u16(10), // delay_den (constant)
    Uint8Array.of(0, 0), // dispose, blend
  ]);
}

interface ApngOpts {
  carrier?: Carrier;
  badFctlCrc?: boolean;
  tail?: Uint8Array;
  truncate?: number;
}

/** Build an APNG whose `carrier` field spells `values` (one per frame). */
function buildApng(values: number[], opts: ApngOpts = {}): Uint8Array {
  const carrier = opts.carrier ?? 'delayNum';
  const parts: Uint8Array[] = [new Uint8Array(PNG_SIGNATURE)];
  parts.push(chunk('IHDR', IHDR_DATA));
  parts.push(chunk('acTL', cat([u32(values.length), u32(0)])));
  let seq = 0;
  values.forEach((v, i) => {
    parts.push(chunk('fcTL', fctl(seq++, v, carrier), opts.badFctlCrc));
    if (i === 0) parts.push(chunk('IDAT', FRAME_ZLIB));
    else parts.push(chunk('fdAT', cat([u32(seq++), FRAME_ZLIB])));
  });
  parts.push(chunk('IEND', new Uint8Array(0)));
  if (opts.tail) parts.push(opts.tail);
  const file = cat(parts);
  return opts.truncate ? file.subarray(0, opts.truncate) : file;
}

const bytesOf = (s: string) => [...s].map((c) => c.charCodeAt(0));
const pictures = (out: Output[]) =>
  out.filter((o): o is Extract<Output, { type: 'picture' }> => o.type === 'picture');
const CHANNELS = 'Per-frame fields (possible hidden channel)';

describe('APNG hidden channel', () => {
  it('reads a message hidden in delay_num and surfaces it as a probable lead', () => {
    const msg = 'TEST:hello';
    const out = run(
      buildApng(bytesOf(msg), { carrier: 'delayNum', badFctlCrc: true }),
      {},
      'anim.png',
    );
    expect(notes(out)).toContain(msg); // probable-lead note carries the decoded text
    const t = tableOf(out, CHANNELS);
    const row = t?.rows.find((r) => r[0] === 'delay_num');
    expect(row?.[2]).toBe(msg); // "As text" column
    expect(t?.highlight?.length).toBe(1); // only the carrier row is flagged readable
  });

  it('reads the same message hidden in x_offset', () => {
    const msg = 'TEST:hello';
    const out = run(
      buildApng(bytesOf(msg), { carrier: 'xOffset', badFctlCrc: true }),
      {},
      'anim.png',
    );
    expect(notes(out)).toContain(msg);
    const row = tableOf(out, CHANNELS)?.rows.find((r) => r[0] === 'x_offset');
    expect(row?.[3]).toBe('yes');
  });

  it('does not flag a constant or noisy field as a lead', () => {
    // Random-looking small values that do not spell printable text.
    const out = run(buildApng([3, 200, 17, 1, 0, 250, 9], { carrier: 'delayNum' }), {}, 'anim.png');
    const t = tableOf(out, CHANNELS);
    expect(t?.highlight ?? []).toEqual([]); // nothing readable
    expect(notes(out)).not.toMatch(/probable lead/i);
  });
});

describe('APNG chunks and frames', () => {
  it('decodes acTL and fcTL into the chunk table and lists the broken fcTL CRCs', () => {
    const out = run(buildApng(bytesOf('ABCDE'), { badFctlCrc: true }), {}, 'anim.png');
    const chunks = tableOf(out, 'Chunks');
    const actl = chunks?.rows.find((r) => r[2] === 'acTL');
    expect(String(actl?.[5])).toMatch(/5 frames/); // Info column decoded
    const fctls = chunks?.rows.filter((r) => r[2] === 'fcTL') ?? [];
    expect(fctls).toHaveLength(5);
    expect(fctls.every((r) => /BAD/.test(String(r[4])))).toBe(true); // every fcTL CRC flagged
    expect(fctls.every((r) => /frame seq/.test(String(r[5])))).toBe(true); // fcTL fields decoded
  });

  it('rebuilds each frame as a standalone, parseable PNG', () => {
    const out = run(buildApng(bytesOf('ABCD')), {}, 'anim.png');
    const pics = pictures(out);
    expect(pics).toHaveLength(4);
    for (const p of pics) {
      expect(p.mime).toBe('image/png');
      const parsed = parsePng(p.data);
      expect(parsed).not.toBeNull();
      expect(parsed?.chunks.every((c) => c.crcOk)).toBe(true);
      expect(parsed?.chunks[0]?.type).toBe('IHDR');
    }
  });

  it('repairs the broken CRCs into a file that re-reads cleanly', () => {
    const out = run(buildApng(bytesOf('ABCDE'), { badFctlCrc: true }), {}, 'anim.png');
    const fixed = filesOf(out).find((f) => f.name.endsWith('-repaired.png'))?.data;
    expect(fixed).toBeTruthy();
    const parsed = parsePng(fixed!);
    expect(parsed?.chunks.every((c) => c.crcOk)).toBe(true); // no bad CRC left
    expect(parsed?.chunks.filter((c) => c.type === 'fcTL')).toHaveLength(5); // order preserved
  });
});

describe('APNG robustness', () => {
  it('surfaces data appended after IEND', () => {
    const tail = latin1Encode('SECRET-TAIL-DATA');
    const out = run(buildApng(bytesOf('ABC'), { tail }), {}, 'anim.png');
    const all = out
      .map((o) =>
        o.type === 'note'
          ? o.text
          : o.type === 'text'
            ? o.value
            : o.type === 'table'
              ? JSON.stringify(o.rows)
              : '',
      )
      .join('\n');
    expect(all).toMatch(/SECRET-TAIL|after IEND|trailing/i);
  });

  it('does not throw on a truncated APNG', () => {
    const full = buildApng(bytesOf('ABCDEFGH'), { badFctlCrc: true });
    expect(() =>
      run(full.subarray(0, Math.floor(full.length * 0.6)), {}, 'anim.png'),
    ).not.toThrow();
  });
});
