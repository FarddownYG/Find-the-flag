import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectText } from './_analyze-text';
import { ALPHABET6, hollowayTable } from '../tools/stego/_holloway-table';
import type { Finding } from './analyze';

const enc = new TextEncoder();

/** A by-hand Holloway encoder (spec + shared table only), for the pipeline test below. */
function encodeHolloway(secret: string, cover: string): string {
  const table = hollowayTable();
  const bits: number[] = [];
  for (const ch of secret) {
    const idx = ALPHABET6.indexOf(ch);
    if (idx < 0) throw new Error(`secret char not in ALPHABET6: ${JSON.stringify(ch)}`);
    for (let b = 5; b >= 0; b--) bits.push((idx >> b) & 1);
  }
  let bi = 0;
  let out = '';
  for (const ch of cover) {
    const entry = table.get(ch);
    if (!entry) {
      out += ch;
      continue;
    }
    let value = 0;
    for (let k = 0; k < entry.bits; k++) value = (value << 1) | (bits[bi++] ?? 0);
    out += value === 0 ? entry.base : String.fromCodePoint(entry.alts[value - 1]!);
  }
  if (bi < bits.length) throw new Error('cover too short to carry the secret');
  return out;
}
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

  it('surfaces a flag hidden with the Holloway homoglyph scheme', async () => {
    // The homoglyphs carry the hex of the flag (ALPHABET6 is lowercase, so a flag rides a layer).
    const flag = 'flag{h0ll0w4y}';
    const payload = Buffer.from(flag, 'utf8').toString('hex');
    const cover = (
      'The quick brown fox jumps over the lazy dog while the sun slowly sets behind the ' +
      'old stone bridge near our quiet village as the tired farmers walk home along the river. '
    ).repeat(4);
    const stego = encodeHolloway(payload, cover);
    const f = await detectText(enc.encode(stego));
    expect(flags(confirmed(f))).toEqual([flag]);
    expect(f[0]?.detail).toMatch(/holloway/);
  });

  it('reports a readable Holloway message as probable, not confirmed', async () => {
    const secret = 'meet me at the old bridge at noon';
    const cover = (
      'The quick brown fox jumps over the lazy dog while the sun slowly sets behind the ' +
      'old stone bridge near our quiet village as the tired farmers walk home along the river. '
    ).repeat(6);
    const stego = encodeHolloway(secret, cover);
    const f = await detectText(enc.encode(stego));
    expect(confirmed(f)).toEqual([]);
    expect(f.some((x) => x.confidence === 'probable' && /holloway/.test(x.detail ?? ''))).toBe(
      true,
    );
  });

  it('plain prose yields no Holloway finding', async () => {
    expect(await detectText(enc.encode(PROSE))).toEqual([]);
  });
});
