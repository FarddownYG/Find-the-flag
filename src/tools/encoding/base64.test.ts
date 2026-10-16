import { describe, expect, it } from 'vitest';
import base64 from './base64';

const sample = (text: string) => ({ text, bytes: new TextEncoder().encode(text) });

describe('base64 detect', () => {
  it('suggests real Base64', () => {
    expect(base64.detect!(sample('ZmxhZ3tiYXNlNjR9'))?.score).toBe(0.8);
    expect(base64.detect!(sample('SGVsbG8gd29ybGQ='))?.score).toBe(0.8);
  });

  it('leaves lists of numbers and 0/1 bits to the other tools', () => {
    expect(base64.detect!(sample('106 124 106 173 157 143 164 141 154 175'))).toBeNull();
    expect(base64.detect!(sample('70 84 70 123 100 101 99 125'))).toBeNull();
    expect(base64.detect!(sample('01000110 01010100 01000110'))).toBeNull();
    expect(
      base64.detect!(sample('2511413510842060413510119088141712512283210298218286115709')),
    ).toBeNull();
  });
});
