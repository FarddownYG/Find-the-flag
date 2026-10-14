import { describe, expect, it } from 'vitest';
import { lazyFile, prepareInput } from './prepare';
import type { LazyFile } from './types';

describe('lazy file input', () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);

  it('reads slices on demand and clamps to the file', async () => {
    const f = lazyFile(new Blob([bytes]), 'x.bin');
    expect(f.size).toBe(1000);
    expect([...(await f.read(10, 3))]).toEqual([10, 11, 12]);
    expect((await f.read(995, 100)).length).toBe(5);
    expect((await f.read(5000, 10)).length).toBe(0);
    expect((await f.read(-5, 2)).length).toBe(0); // [−5, −3) lies before the file
    expect([...(await f.read(-1, 2))]).toEqual([0]);
  });

  it('turns pasted bytes or a Blob into a LazyFile', async () => {
    const a = (await prepareInput('file', { bytes, name: 'a.bin' })) as LazyFile;
    expect(a.size).toBe(1000);
    expect(a.name).toBe('a.bin');
    const b = (await prepareInput('file', { file: new Blob([bytes]) })) as LazyFile;
    expect([...(await b.read(999, 1))]).toEqual([231]);
  });

  it('reads a Blob fully for tools that need bytes', async () => {
    const v = (await prepareInput('bytes', { file: new Blob([bytes]) })) as { bytes: Uint8Array };
    expect(v.bytes.length).toBe(1000);
  });
});
