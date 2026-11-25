import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectText } from './_analyze-text';
import type { Finding } from './analyze';

const enc = new TextEncoder();
const sample = (name: string) => new Uint8Array(readFileSync(`public/samples/${name}`));
const confirmed = (f: Finding[]): Finding[] => f.filter((x) => x.confidence === 'confirmed');
const flags = (f: Finding[]) => f.map((x) => x.flag).filter(Boolean);

const PROSE =
  'The old lighthouse keeper climbed the spiral stairs every evening, long before the first ' +
  'ships appeared on the horizon. He carried a lantern, a loaf of bread and a battered notebook, ' +
  'and he wrote down the weather, the tides and the names of the vessels that passed by.';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('detectText on the fixtures', () => {
  it('symbol-words.txt yields a confirmed FTF{symbol_words}', async () => {
    const f = await detectText(sample('symbol-words.txt'), 'symbol-words.txt');
    expect(flags(confirmed(f))).toEqual(['FTF{symbol_words}']);
  });

  it('a base64 text embedding a flag yields that flag', async () => {
    const f = await detectText(enc.encode(b64('note to self: FTF{text_chain_b64}')));
    expect(flags(confirmed(f))).toEqual(['FTF{text_chain_b64}']);
  });

  it('base64 inside hex yields the flag through both layers', async () => {
    const hex = Buffer.from(b64('FTF{two_layers_ok}'), 'utf8').toString('hex');
    const f = await detectText(enc.encode(hex));
    expect(flags(confirmed(f))).toEqual(['FTF{two_layers_ok}']);
  });

  it('plain English prose has no confirmed finding', async () => {
    expect(confirmed(await detectText(enc.encode(PROSE)))).toEqual([]);
    expect(await detectText(enc.encode(PROSE))).toEqual([]);
  });

  it('a flag sitting in the clear is not reported as recovered', async () => {
    const f = await detectText(enc.encode('Welcome. FTF{in_the_clear}'));
    expect(confirmed(f)).toEqual([]);
  });

  it('binary data is left to the other detectors', async () => {
    expect(await detectText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0xff]))).toEqual(
      [],
    );
    expect(await detectText(new Uint8Array(0))).toEqual([]);
  });

  it('a Caesar ciphertext gets a cipher hint, never confirmed', async () => {
    const f = await detectText(sample('cipher-identify-caesar.txt'));
    expect(confirmed(f)).toEqual([]);
    expect(f.some((x) => x.kind === 'cipher-hint' && x.title === 'caesar')).toBe(true);
  });

  it('the other cipher-identify samples never yield a confirmed finding', async () => {
    for (const n of ['vigenere', 'playfair', 'columnar', 'adfgx']) {
      expect(confirmed(await detectText(sample(`cipher-identify-${n}.txt`)))).toEqual([]);
    }
  });
});
