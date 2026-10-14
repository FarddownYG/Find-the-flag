import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareInput } from '../../core/prepare';
import type { ImageInput } from '../../core/types';
import tool, { combine } from './image-combine';

const load = async (name: string) =>
  (await prepareInput('image', {
    bytes: new Uint8Array(
      readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)),
    ),
    name,
  })) as ImageInput;

describe('image-combine', () => {
  it('XOR of twin images lights exactly the changed pixels', async () => {
    const a = await load('stego-twin-a.png');
    const b = await load('stego-twin-b.png');
    const r = combine(a.image, b.image, 'xor', true);
    expect(r.differing).toBeGreaterThan(100);
    // Every lit pixel is green-only (the message lives in the green LSB).
    for (let i = 0; i < r.image.data.length; i += 4) {
      expect(r.image.data[i]).toBe(0);
      expect(r.image.data[i + 2]).toBe(0);
    }
    expect(r.box?.minX).toBe(4);
  });

  it('identical images report no difference', async () => {
    const a = await load('stego-twin-a.png');
    const r = combine(a.image, a.image, 'diff', true);
    expect(r.differing).toBe(0);
    expect(r.box).toBeNull();
  });

  it('asks for the second image', async () => {
    const a = await load('stego-twin-a.png');
    expect(() => tool.run(a, { other: null, op: 'xor', amplify: true })).toThrow(/Second image/);
  });
});
