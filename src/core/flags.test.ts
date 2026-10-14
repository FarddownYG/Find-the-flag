import { describe, expect, it } from 'vitest';
import { buildFlagRegex, findFlags, selectFlags } from './flags';

const re = buildFlagRegex();

describe('flags', () => {
  it('finds common formats', () => {
    const text = 'x flag{a_b} y picoCTF{c0d3} z HTB{w1n}';
    expect(findFlags(text, re).map((f) => f.value)).toEqual([
      'flag{a_b}',
      'picoCTF{c0d3}',
      'HTB{w1n}',
    ]);
  });

  it('prefers known prefixes over brute-force lookalikes', () => {
    const text = 'zfua{lin13} flag{rot13} djye{pmr13} kqfl{wty13}';
    expect([...selectFlags(text, re)]).toEqual(['flag{rot13}']);
  });

  it('drops generic matches when there are many', () => {
    expect(selectFlags('aa{x1} bb{x2} cc{x3} dd{x4}', re).size).toBe(0);
    expect([...selectFlags('ENSIBS{hello}', re)]).toEqual(['ENSIBS{hello}']);
  });

  it('drops characters glued in front of flag{, but keeps other formats whole', () => {
    const text = 'Fflag{streamed} sQr{%=i~} monkey{abc} picoCTF{c0d3} 9xFLAG{up}';
    const spans = findFlags(text, re);
    expect(spans.map((f) => f.value)).toEqual([
      'flag{streamed}',
      'sQr{%=i~}',
      'monkey{abc}',
      'picoCTF{c0d3}',
      'FLAG{up}',
    ]);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe('flag{streamed}');
    expect([...selectFlags(text, re)]).toEqual(['flag{streamed}', 'picoCTF{c0d3}', 'FLAG{up}']);
  });

  it('keeps a custom pattern match as it is', () => {
    const custom = String.raw`redflag\{[a-z]+\}`;
    const r = buildFlagRegex(custom);
    expect(findFlags('see redflag{abc} and xflag{def}', r).map((f) => f.value)).toEqual([
      'redflag{abc}',
      'flag{def}',
    ]);
  });

  it('honours a custom pattern', () => {
    const custom = String.raw`RM\[[a-z]+\]`;
    const r = buildFlagRegex(custom);
    expect([...selectFlags('noise RM[gg] aa{1} bb{2} cc{3} dd{4}', r, custom)]).toEqual(['RM[gg]']);
  });
});
