import { describe, expect, it } from 'vitest';
import { B64URL, fromBase64, toBase64, utf8Encode } from './bytes';

describe('base64 helpers', () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x01]);

  it('encodes standard, padded', () => {
    expect(toBase64(bytes)).toBe('+//+AQ==');
  });

  it('encodes URL-safe, unpadded (JWT style)', () => {
    expect(toBase64(bytes, B64URL, false)).toBe('-__-AQ');
    expect(toBase64(utf8Encode('{"alg":"none"}'), B64URL, false)).toBe('eyJhbGciOiJub25lIn0');
  });

  it('decodes standard and URL-safe, padded or not', () => {
    for (const s of ['+//+AQ==', '+//+AQ', '-__-AQ==', '-__-AQ']) {
      expect([...fromBase64(s)]).toEqual([...bytes]);
    }
  });
});
