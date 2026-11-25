import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { utf8Decode, utf8Encode } from '../../lib/bytes';
import { buildCtx, DECODERS, TRANSFORMS } from './_decoders';

const run = (name: string, input: string | Uint8Array): string | null => {
  const step = DECODERS.find((s) => s.name === name);
  if (!step) throw new Error(`no step ${name}`);
  const out = step.run(buildCtx(typeof input === 'string' ? utf8Encode(input) : input));
  return out ? utf8Decode(out) : null;
};

describe('buildCtx', () => {
  it('trims text input and keeps the raw text', () => {
    const c = buildCtx(utf8Encode('  hello \n'));
    expect(c.textLike).toBe(true);
    expect(c.t).toBe('hello');
    expect(c.raw).toBe('  hello \n');
  });

  it('leaves text empty for binary input', () => {
    const c = buildCtx(new Uint8Array([0xff, 0x00, 0x01, 0x80]));
    expect(c.textLike).toBe(false);
    expect(c.t).toBe('');
    expect(c.raw).toBe('');
  });
});

describe('steps', () => {
  it('decodes base64', () => {
    expect(run('base64', 'SGVsbG8gd29ybGQ=')).toBe('Hello world');
  });

  it('decodes hex', () => {
    expect(run('hex', '48656c6c6f2c20435446')).toBe('Hello, CTF');
  });

  it('inflates gzip and ignores plain text', () => {
    expect(run('gzip', gzipSync(utf8Encode('squeeze me')))).toBe('squeeze me');
    expect(run('gzip', 'just plain text')).toBeNull();
  });

  it('transforms include rot13', () => {
    const rot13 = TRANSFORMS.find((s) => s.name === 'rot13');
    const out = rot13?.run(buildCtx(utf8Encode('synt')));
    expect(out && utf8Decode(out)).toBe('flag');
  });
});

describe('registry', () => {
  it('keeps a stable step order', () => {
    expect(DECODERS.map((s) => s.name)).toMatchInlineSnapshot(`
      [
        "gzip",
        "zlib",
        "inflate",
        "base64",
        "base32",
        "base45",
        "base36",
        "base26",
        "base58",
        "bubblebabble",
        "base100",
        "base62",
        "base62 (0-9a-zA-Z)",
        "ascii85",
        "z85",
        "base85",
        "base91",
        "hex",
        "binary",
        "charcode",
        "charcode (bytes)",
        "charcode (octal)",
        "braille",
        "braille (8-dot bytes)",
        "nato",
        "punycode",
        "uudecode",
        "xxdecode",
        "mime message",
        "mime words",
        "quoted-printable",
        "url",
        "html entities",
        "unicode escapes",
        "morse",
      ]
    `);
    expect(TRANSFORMS.map((s) => s.name)).toMatchInlineSnapshot(`
      [
        "rot13",
        "rot47",
        "atbash",
        "reverse",
        "reverse → rot13",
        "reverse → rot47",
        "reverse → atbash",
      ]
    `);
  });
});
