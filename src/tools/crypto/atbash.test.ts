import { describe, expect, it } from 'vitest';
import { resultToText } from '../../core/result-text';
import tool, { atbash } from './atbash';
import { PROSE_A } from './_sample-text';

const run = (text: string, digits = false) => resultToText(tool.run(text, { digits }) as never);

describe('atbash', () => {
  it('mirrors the alphabet and keeps case and punctuation', () => {
    expect(atbash('ABCXYZ abcxyz')).toBe('ZYXCBA zyxcba');
    expect(atbash('Hello, World!')).toBe('Svool, Dliow!');
  });

  it('is its own inverse', () => {
    expect(atbash(atbash(PROSE_A))).toBe(PROSE_A);
    expect(atbash(atbash('flag{R0und_Tr1p_42}', true), true)).toBe('flag{R0und_Tr1p_42}');
  });

  it('leaves digits alone unless asked', () => {
    expect(atbash('a0z9')).toBe('z0a9');
    expect(atbash('a0z9', true)).toBe('z9a0');
  });

  it('decodes a flag through the tool', () => {
    expect(run('uozt{zgyzhs_rh_hvou_rmevihv}')).toBe('flag{atbash_is_self_inverse}');
  });

  it('does not touch non-ASCII letters', () => {
    expect(atbash('é ß ж')).toBe('é ß ж');
  });

  it('detects mirrored flags', () => {
    const d = tool.detect?.({ text: 'uozt{zgyzhs}', bytes: new Uint8Array() });
    expect(d?.score).toBeGreaterThan(0.5);
    expect(tool.detect?.({ text: 'hello there', bytes: new Uint8Array() })).toBeNull();
  });
});
