import { describe, expect, it } from 'vitest';
import { toHex, utf8Decode } from '../../lib/bytes';
import type { Output } from '../../core/types';
import { resultToText } from '../../core/result-text';
import url, { hasPercentEscape, urlDecode, urlDecodeOnce, urlEncode } from './url';

const dec = (s: string, plus = false, repeat = false) =>
  utf8Decode(urlDecode(s, plus, repeat).bytes);

describe('url encode', () => {
  it('component: keeps only unreserved characters', () => {
    expect(urlEncode('flag{a b/c}~_-.')).toBe('flag%7Ba%20b%2Fc%7D~_-.');
    expect(urlEncode("a=1&b='2'")).toBe('a%3D1%26b%3D%272%27');
  });

  it('component: UTF-8 bytes of non-ASCII characters', () => {
    expect(urlEncode('é')).toBe('%C3%A9');
    expect(urlEncode('✓')).toBe('%E2%9C%93');
    expect(urlEncode('😀')).toBe('%F0%9F%98%80');
  });

  it('uri: keeps reserved characters, encodes spaces, quotes, braces and %', () => {
    expect(urlEncode('https://x.io/a b?q=1&r="2"#top', 'uri')).toBe(
      'https://x.io/a%20b?q=1&r=%222%22#top',
    );
    expect(urlEncode('100%', 'uri')).toBe('100%25');
  });

  it('reserved: only reserved characters and % are touched', () => {
    expect(urlEncode('a b/c?d=é%', 'reserved')).toBe('a b%2Fc%3Fd%3Dé%25');
  });

  it('all: every byte', () => {
    expect(urlEncode('flag', 'all')).toBe('%66%6C%61%67');
    expect(urlEncode('é ', 'all')).toBe('%C3%A9%20');
  });

  it('plus for space (form encoding), except in all-characters mode', () => {
    expect(urlEncode('a b', 'component', true)).toBe('a+b');
    expect(urlEncode('a b', 'all', true)).toBe('%61%20%62');
  });
});

describe('url decode', () => {
  it('decodes escapes in either case and keeps the other characters', () => {
    expect(dec('flag%7Burl%7d%20ok')).toBe('flag{url} ok');
    expect(dec('caf%C3%A9 ✓')).toBe('café ✓');
  });

  it('leaves invalid escapes alone', () => {
    expect(dec('100% sure %zz %4')).toBe('100% sure %zz %4');
    expect(dec('%')).toBe('%');
    expect(dec('%2')).toBe('%2');
    expect(dec('%41')).toBe('A');
  });

  it('plus is a space only when asked', () => {
    expect(dec('a+b%2Bc')).toBe('a+b+c');
    expect(dec('a+b%2Bc', true)).toBe('a b+c');
  });

  it('repeat undoes double and triple encoding, one pass otherwise', () => {
    const triple = 'flag%25257Bx%25255Fy%25257D';
    expect(dec(triple)).toBe('flag%257Bx%255Fy%257D');
    expect(dec(triple, false, true)).toBe('flag{x_y}');
    expect(urlDecode(triple, false, true).passes).toBe(3);
    expect(urlDecode('plain', false, true).passes).toBe(0);
  });

  it('a decoded + stays a plus on the next pass', () => {
    expect(dec('a%252Bb', true, true)).toBe('a+b');
  });

  it('keeps raw bytes when the result is not UTF-8', () => {
    const { bytes } = urlDecode('%FF%FE%00A');
    expect(toHex(bytes)).toBe('fffe0041');
    expect(urlDecodeOnce('%ff').length).toBe(1);
  });

  it('round-trips arbitrary text through every encoding scope', () => {
    const text = 'Flag {é ✓ 😀} a+b c%d/e?f=g&h#i [j] "k" \'l\' ~_-.';
    for (const scope of ['component', 'uri', 'reserved', 'all'] as const) {
      expect(dec(urlEncode(text, scope))).toBe(text);
    }
    expect(dec(urlEncode(text, 'component', true), true)).toBe(text);
  });

  it('hasPercentEscape', () => {
    expect(hasPercentEscape('a%20b')).toBe(true);
    expect(hasPercentEscape('100%')).toBe(false);
  });
});

describe('url tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    url.run(text, {
      mode: 'decode',
      scope: 'component',
      plus: false,
      repeat: false,
      ...options,
    } as never) as Output[];

  it('decodes to a text block', () => {
    expect(run('flag%7Bx%7D')[0]).toEqual({ type: 'text', value: 'flag{x}' });
  });

  it('warns when the result is still encoded', () => {
    const text = resultToText(run('flag%257Bx%257D'));
    expect(text).toContain('Repeat until stable');
    expect(resultToText(run('flag%257Bx%257D', { repeat: true }))).toContain('Decoded 2 times');
  });

  it('says so when there is nothing to decode', () => {
    expect(resultToText(run('plain text'))).toContain('Nothing to decode');
  });

  it('returns bytes plus a note for non-UTF-8 results', () => {
    const out = run('%FF%FE');
    expect(out[0]).toMatchObject({ type: 'bytes' });
    expect(out.some((o) => o.type === 'note')).toBe(true);
  });

  it('points to the Unicode tool for %uXXXX', () => {
    expect(resultToText(run('%u0066%u006c'))).toContain('Unicode escapes tool');
  });

  it('detect: strong for several escapes, double-encoding switches repeat on', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(url.detect!(sample('flag%7Bx%7D%20y'))?.score).toBeGreaterThan(0.85);
    expect(url.detect!(sample('flag%257Bx%257D'))?.options).toMatchObject({ repeat: true });
    expect(url.detect!(sample('nothing here 100%'))).toBeNull();
    expect(url.detect!({ text: null, bytes: new Uint8Array() })).toBeNull();
  });
});
