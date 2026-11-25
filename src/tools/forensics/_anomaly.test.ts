import { describe, expect, it } from 'vitest';
import { concatBytes, latin1Encode } from '../../lib/bytes';
import { scanAnomalies } from './_anomaly';

/** Uniformly random bytes (mulberry32), deterministic. */
function random(length: number, seed = 0x1badf00d): Uint8Array {
  const out = new Uint8Array(length);
  let a = seed >>> 0;
  for (let i = 0; i < length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}

/** Low-entropy, text-like filler. */
function text(length: number): Uint8Array {
  const unit = latin1Encode('The quick brown fox jumps over the lazy dog. ');
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = unit[i % unit.length]!;
  return out;
}

const KIB = 1024;
const MIB = 1024 * KIB;
const kinds = (f: { kind: string }[]) => f.map((x) => x.kind);

describe('scanAnomalies: encrypted-region verdict', () => {
  it('flags a 1 MiB uncovered high-entropy block at the right offset', () => {
    const head = text(256 * KIB);
    const buf = concatBytes(head, random(MIB), text(64 * KIB));
    const f = scanAnomalies(buf, [
      { start: 0, end: head.length, label: 'text' },
      { start: head.length + MIB, end: buf.length },
    ]);
    const enc = f.filter((x) => x.kind === 'encrypted');
    expect(enc).toHaveLength(1);
    expect(enc[0]).toMatchObject({ confidence: 'probable', offset: 256 * KIB, size: MIB });
    expect(enc[0]!.title).toContain('VeraCrypt');
  });

  it('flags a raw file that is random from start to end when nothing is covered', () => {
    const f = scanAnomalies(random(MIB, 7), []);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'encrypted', confidence: 'probable', offset: 0, size: MIB });
  });

  it('finds it between two covered ranges, with no duplicate gap or entropy finding', () => {
    const a = text(8 * KIB);
    const mid = random(128 * KIB, 3);
    const b = text(8 * KIB);
    const f = scanAnomalies(concatBytes(a, mid, b), [
      { start: 0, end: 8 * KIB },
      { start: 8 * KIB + 128 * KIB, end: 144 * KIB },
    ]);
    expect(kinds(f)).toEqual(['encrypted']);
    expect(f[0]).toMatchObject({ offset: 8 * KIB, size: 128 * KIB });
  });

  it('needs the offset or the size aligned to 512', () => {
    // Head 260000 bytes (%512 = 416) and tail 1040000 bytes (%512 = 128): neither is aligned.
    const odd = concatBytes(text(260000), random(1040000, 11));
    expect(kinds(scanAnomalies(odd, [{ start: 0, end: 260000 }]))).not.toContain('encrypted');
    // Same random tail starting at 262144 (a multiple of 512): flagged.
    const even = concatBytes(text(262144), random(1040000, 11));
    expect(kinds(scanAnomalies(even, [{ start: 0, end: 262144 }]))).toContain('encrypted');
  });

  it('stays below 64 KiB: a small random block is only a weak high-entropy hint', () => {
    const buf = concatBytes(text(64 * KIB), random(32 * KIB, 5), text(64 * KIB));
    const f = scanAnomalies(buf, [
      { start: 0, end: 64 * KIB },
      { start: 96 * KIB, end: buf.length },
    ]);
    expect(f.length).toBeGreaterThan(0);
    expect(kinds(f)).not.toContain('encrypted');
    expect(f.every((x) => x.confidence === 'candidate')).toBe(true);
  });

  it('does not call it encrypted when a known signature opens the region', () => {
    const gzipLike = Uint8Array.of(0x1f, 0x8b, 0x08, 0x00);
    const body = random(MIB, 9);
    body.set(gzipLike, 0);
    const f = scanAnomalies(body, []);
    expect(kinds(f)).not.toContain('encrypted');
    expect(f.every((x) => x.confidence === 'candidate')).toBe(true);
  });
});

describe('scanAnomalies: nothing to report', () => {
  it('reports nothing for a fully covered buffer, even a high-entropy one', () => {
    const buf = random(MIB, 21);
    expect(scanAnomalies(buf, [{ start: 0, end: buf.length, label: 'jpeg' }])).toEqual([]);
  });

  it('reports nothing when covered ranges overlap and tile the file', () => {
    const buf = concatBytes(text(4 * KIB), random(256 * KIB, 4), text(4 * KIB));
    const cover = [
      { start: 0, end: 100 * KIB },
      { start: 50 * KIB, end: buf.length },
    ];
    expect(scanAnomalies(buf, cover)).toEqual([]);
  });

  it('reports nothing for a low-entropy buffer with nothing covered', () => {
    expect(scanAnomalies(text(MIB), [])).toEqual([]);
  });

  it('never calls a low-entropy buffer encrypted or high-entropy, even with gaps', () => {
    const f = scanAnomalies(text(MIB), [
      { start: 0, end: 100 },
      { start: 200, end: 300 },
    ]);
    expect(kinds(f)).not.toContain('encrypted');
    expect(kinds(f)).not.toContain('high-entropy');
  });

  it('handles empty input and out-of-range or inverted covered ranges', () => {
    expect(scanAnomalies(new Uint8Array(0), [])).toEqual([]);
    const buf = text(1000);
    const f = scanAnomalies(buf, [
      { start: -50, end: 5000 },
      { start: 700, end: 100 },
    ]);
    expect(f).toEqual([]);
  });

  it('never emits confirmed, whatever the input', () => {
    const inputs = [random(MIB, 1), concatBytes(text(2000), random(300 * KIB, 2)), text(5000)];
    for (const buf of inputs) {
      for (const cover of [[], [{ start: 0, end: 1000 }], [{ start: 0, end: buf.length }]]) {
        for (const x of scanAnomalies(buf, cover)) expect(x.confidence).not.toBe('confirmed');
      }
    }
  });
});

describe('scanAnomalies: post-EOF and gaps', () => {
  it('reports data after the end of an offset-0 container', () => {
    const container = text(1000);
    const tail = latin1Encode('hidden: appended after the logical end of the container');
    const f = scanAnomalies(concatBytes(container, tail), [{ start: 0, end: 1000, label: 'png' }]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      kind: 'post-eof',
      confidence: 'probable',
      offset: 1000,
      size: tail.length,
    });
    expect(f[0]!.title).toContain('png');
  });

  it('ignores zero or constant padding after the container', () => {
    const buf = concatBytes(text(1000), new Uint8Array(3096));
    expect(scanAnomalies(buf, [{ start: 0, end: 1000 }])).toEqual([]);
  });

  it('only calls a short tail a candidate', () => {
    const f = scanAnomalies(concatBytes(text(1000), latin1Encode('abc!')), [
      { start: 0, end: 1000 },
    ]);
    expect(f[0]).toMatchObject({ kind: 'post-eof', confidence: 'candidate', size: 4 });
  });

  it('maps a gap between covered ranges and skips padding gaps', () => {
    const buf = concatBytes(text(100), text(500), text(400));
    const f = scanAnomalies(buf, [
      { start: 0, end: 100 },
      { start: 600, end: 1000 },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'gap', confidence: 'candidate', offset: 100, size: 500 });
    const padded = concatBytes(text(100), new Uint8Array(500), text(400));
    expect(
      scanAnomalies(padded, [
        { start: 0, end: 100 },
        { start: 600, end: 1000 },
      ]),
    ).toEqual([]);
  });

  it('does not report gaps when nothing is covered (the whole file would be one gap)', () => {
    expect(scanAnomalies(text(5000), [])).toEqual([]);
  });
});

describe('scanAnomalies: entropy runs', () => {
  it('reports an uncovered high-entropy run below the encrypted size as a candidate', () => {
    const buf = concatBytes(text(16 * KIB), random(24 * KIB, 8), text(16 * KIB));
    const f = scanAnomalies(buf, [
      { start: 0, end: 16 * KIB },
      { start: 40 * KIB, end: buf.length },
    ]);
    const run = f.find((x) => x.kind === 'high-entropy');
    expect(run).toMatchObject({ confidence: 'candidate', offset: 16 * KIB, size: 24 * KIB });
  });

  it('does not report a high-entropy run that a parser covers', () => {
    const buf = concatBytes(text(16 * KIB), random(24 * KIB, 8), text(16 * KIB));
    expect(scanAnomalies(buf, [{ start: 0, end: buf.length }])).toEqual([]);
  });
});
