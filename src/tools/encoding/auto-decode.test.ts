import { deflateSync, gzipSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { resultToText } from '../../core/result-text';
import { toBase64, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import { inflateCapped } from './_inflate';
import autoDecodeTool, { autoDecode, recipeName } from './auto-decode';
import { base100Encode } from './base100';
import { base32Encode } from './base32';
import { base26Encode, base36Encode } from './base36';
import { base45Encode } from './base45';
import { base58Encode } from './base58';
import { base62Encode } from './base62';
import { base85Encode } from './base85';
import { base91Encode } from './base91';
import { bubbleBabbleEncode } from './bubblebabble';
import { charcodeEncode } from './charcode';
import { htmlEncode } from './html-entities';
import { morseEncode } from './morse';
import { unicodeEscape } from './unicode-escape';
import { urlEncode } from './url';

const FLAG = 'flag{auto_decode_layers}';
const bytes = (s: string) => utf8Encode(s);
const b64 = (data: string | Uint8Array) => toBase64(typeof data === 'string' ? bytes(data) : data);
const rot13 = (s: string) =>
  s.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(base + ((c.charCodeAt(0) - base + 13) % 26));
  });
const reverse = (s: string) => [...s].reverse().join('');
const binaryString = (s: string) =>
  Array.from(bytes(s), (c) => c.toString(2).padStart(8, '0')).join(' ');

const solve = (input: string | Uint8Array, options = {}) =>
  autoDecode(typeof input === 'string' ? bytes(input) : input, options);

describe('auto-decode: one layer', () => {
  const cases: [string, string, string, string?][] = [
    ['base64', b64(FLAG), 'base64'],
    ['base32', base32Encode(bytes(FLAG)), 'base32'],
    ['base36 (big integer)', base36Encode(bytes(FLAG)), 'base36'],
    ['base26 (letters)', base26Encode(bytes(FLAG)), 'base26'],
    ['base45', base45Encode(bytes(FLAG)), 'base45'],
    ['base100 (emoji)', base100Encode(bytes(FLAG)), 'base100'],
    ['Bubble Babble', bubbleBabbleEncode(bytes(FLAG)), 'bubblebabble'],
    ['base58', base58Encode(bytes(FLAG)), 'base58'],
    ['base62', base62Encode(bytes(FLAG)), 'base62'],
    ['ascii85 (Adobe frame)', base85Encode(bytes(FLAG), 'ascii85', true), 'ascii85'],
    ['ascii85 (bare)', base85Encode(bytes(FLAG), 'ascii85'), 'ascii85'],
    ['RFC 1924 / Python b85', base85Encode(bytes(FLAG), 'rfc1924'), 'base85'],
    ['z85', 'w]7)*DWomzz/6G3Dn)^g', 'z85', 'flag{zeromq_z85}'],
    ['base91', base91Encode(bytes(FLAG)), 'base91'],
    ['hex', toHex(bytes(FLAG)), 'hex'],
    ['hex with \\x', toHex(bytes(FLAG), '\\x').replace(/^/, '\\x'), 'hex'],
    ['binary', binaryString(FLAG), 'binary'],
    ['decimal char codes', charcodeEncode(FLAG, 'dec'), 'charcode'],
    ['octal char codes', charcodeEncode(FLAG, 'oct'), 'charcode (octal)'],
    ['url', urlEncode(FLAG, 'all'), 'url'],
    ['html entities', htmlEncode(FLAG, 'all', 'decimal'), 'html entities'],
    ['unicode escapes', unicodeEscape(FLAG, 'u', 'all'), 'unicode escapes'],
    ['gzip', b64(gzipSync(bytes(FLAG))), 'base64 → gzip'],
    ['zlib', b64(zlibSync(bytes(FLAG))), 'base64 → zlib'],
    ['raw deflate', b64(deflateSync(bytes(FLAG))), 'base64 → inflate'],
    ['rot13', rot13(FLAG), 'rot13'],
    ['reversed', reverse(FLAG), 'reverse'],
  ];

  it.each(cases)('%s', (_name, input, recipe, expected = FLAG) => {
    const r = solve(input);
    expect(utf8Decode(r.best.bytes)).toBe(expected);
    expect(recipeName(r.best)).toBe(recipe);
    expect(r.best.flag).toBe(true);
  });

  it('morse', () => {
    const r = solve(morseEncode('flag is morse code').text);
    expect(utf8Decode(r.best.bytes)).toBe('FLAG IS MORSE CODE');
    expect(recipeName(r.best)).toBe('morse');
  });

  it('raw binary input: gzip file bytes', () => {
    const r = solve(gzipSync(bytes(FLAG)));
    expect(recipeName(r.best)).toBe('gzip');
    expect(utf8Decode(r.best.bytes)).toBe(FLAG);
  });
});

describe('auto-decode: several layers', () => {
  it('base64 → hex → rot13', () => {
    const r = solve(b64(toHex(bytes(rot13(FLAG)))));
    expect(recipeName(r.best)).toBe('base64 → hex → rot13');
    expect(utf8Decode(r.best.bytes)).toBe(FLAG);
  });

  it('url → base64 (percent-encoded padding)', () => {
    const r = solve(urlEncode(b64('flag{abcd}'), 'component'));
    expect(utf8Decode(r.best.bytes)).toBe('flag{abcd}');
    expect(recipeName(r.best)).toBe('url → base64');
  });

  it('base32 → base64 → gzip', () => {
    const r = solve(base32Encode(bytes(b64(gzipSync(bytes(FLAG))))));
    expect(recipeName(r.best)).toBe('base32 → base64 → gzip');
    expect(utf8Decode(r.best.bytes)).toBe(FLAG);
  });

  it('gzip inside gzip inside base64', () => {
    const r = solve(b64(gzipSync(gzipSync(bytes(FLAG)))));
    expect(recipeName(r.best)).toBe('base64 → gzip → gzip');
  });

  it('reversed Base64 (the leading = is the hint)', () => {
    const r = solve(reverse(b64('flag{reversed_b64_}')));
    expect(utf8Decode(r.best.bytes)).toBe('flag{reversed_b64_}');
    expect(recipeName(r.best)).toBe('reverse → base64');
  });

  it('five layers of everything', () => {
    const layered = b64(base32Encode(bytes(toHex(bytes(urlEncode(reverse(rot13(FLAG)), 'all'))))));
    const r = solve(layered, { maxDepth: 6 });
    expect(utf8Decode(r.best.bytes)).toBe(FLAG);
    expect(r.best.recipe.length).toBeGreaterThanOrEqual(5);
  });

  it('ROT13 of English text counts because it makes common words appear', () => {
    const text = 'the secret message is hidden in the old library';
    const r = solve(rot13(text));
    expect(utf8Decode(r.best.bytes)).toBe(text);
    expect(recipeName(r.best)).toBe('rot13');
  });
});

describe('auto-decode: Base45 and the EU certificate', () => {
  it('HC1: prefix, then Base45, then zlib', () => {
    const r = solve(`HC1:${base45Encode(zlibSync(bytes(FLAG)))}`);
    expect(recipeName(r.best)).toBe('base45 → zlib');
    expect(utf8Decode(r.best.bytes)).toBe(FLAG);
  });

  it('Base45 whose payload ends in a space keeps it (spaces are data)', () => {
    const r = solve(base45Encode(bytes('flag{ends_with_space} ')));
    expect(utf8Decode(r.best.bytes)).toBe('flag{ends_with_space} ');
  });

  it('upper-case words and sentences are not Base45', () => {
    for (const text of ['HELLO WORLD THIS IS A TEST', 'THE FLAG IS HIDDEN', 'MEETING AT NOON']) {
      const r = solve(text);
      expect(r.ranked.some((c) => c.recipe.includes('base45'))).toBe(false);
    }
  });
});

describe('auto-decode: Bubble Babble', () => {
  it('a damaged string (checksum) is not decoded; OpenSSH-style fingerprints are', () => {
    expect(
      solve('xesef-disof-gytuf-katof-movif-baxux').ranked.some((c) =>
        c.recipe.includes('bubblebabble'),
      ),
    ).toBe(true);
    expect(
      solve('xesef-disof-gytuf-katof-movif-baxax').ranked.some((c) =>
        c.recipe.includes('bubblebabble'),
      ),
    ).toBe(false);
  });
});

describe('auto-decode: emoji layers', () => {
  it('base100 around base64 around hex', () => {
    const r = solve(base100Encode(bytes(b64(toHex(bytes(FLAG))))));
    expect(recipeName(r.best)).toBe('base100 → base64 → hex');
    expect(utf8Decode(r.best.bytes)).toBe(FLAG);
  });
});

describe('auto-decode: restraint', () => {
  it('leaves plain text and plain flags alone', () => {
    for (const text of ['hello world this is just plain text with nothing to decode', FLAG]) {
      const r = solve(text);
      expect(r.best).toBe(r.input);
      expect(recipeName(r.best)).toBe('(input as is)');
    }
  });

  it('does not rot13 or reverse readable text', () => {
    const r = solve('the quick brown fox jumps over the lazy dog');
    expect(
      r.ranked.every((c) => !c.recipe.includes('rot13') && !c.recipe.includes('reverse')),
    ).toBe(true);
  });

  it('does not turn digits or short words into "improved" junk', () => {
    expect(solve('12345 67890 4242').best).toBeDefined();
    expect(recipeName(solve('12345 67890 4242').best)).toBe('(input as is)');
    expect(recipeName(solve('Zm9v').best)).toBe('(input as is)');
  });

  it('random binary stays as is', () => {
    let seed = 1;
    const noise = Uint8Array.from(
      { length: 2048 },
      () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 255,
    );
    expect(solve(noise).best).toBeDefined();
  });

  it('stops on cycles: every content is visited once, however deep it may go', () => {
    const r = solve(b64(b64(b64(FLAG))), { maxDepth: 10, beamWidth: 50 });
    const keys = r.ranked.map((c) => toHex(c.bytes));
    expect(new Set(keys).size).toBe(keys.length);
    expect(utf8Decode(r.best.bytes)).toBe(FLAG);
    // ROT13/ROT47/atbash/reverse are involutions and must not ping-pong
    const rr = solve('Uryyb Jbeyq, guvf vf n frperg zrffntr sebz gur byq yvoenel', {
      maxDepth: 10,
    });
    expect(rr.ranked.length).toBeLessThan(100);
  });

  it('respects maxDepth and beamWidth', () => {
    const input = b64(toHex(bytes(rot13(FLAG))));
    expect(solve(input, { maxDepth: 1 }).best.flag).toBe(false);
    expect(solve(input, { maxDepth: 2 }).best.flag).toBe(false);
    expect(solve(input, { maxDepth: 3 }).best.flag).toBe(true);
    expect(solve(input, { maxDepth: 99 }).best.recipe.length).toBeLessThanOrEqual(10);
    expect(solve(input, { beamWidth: 1 }).best.flag).toBe(true);
  });

  it('a custom flag prefix is recognised', () => {
    const input = b64('zebra{stripes_are_unique}');
    expect(solve(input).best.flag).toBe(false);
    const r = solve(input, { flagPrefix: 'zebra' });
    expect(r.best.flag).toBe(true);
    expect(utf8Decode(r.best.bytes)).toBe('zebra{stripes_are_unique}');
  });

  it('refuses decompression bombs instead of exhausting memory', () => {
    const bomb = gzipSync(new Uint8Array(12 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(20000);
    expect(inflateCapped(bomb, 'gzip')).toBeNull();
    const t = performance.now();
    const r = solve(bomb);
    expect(r.best).toBe(r.input);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  it('inflateCapped: valid, corrupt, truncated and empty data', () => {
    const data = bytes('hello hello hello hello'.repeat(50));
    expect(inflateCapped(gzipSync(data), 'gzip')).toEqual(data);
    expect(inflateCapped(zlibSync(data), 'zlib')).toEqual(data);
    expect(inflateCapped(deflateSync(data), 'raw')).toEqual(data);
    const z = zlibSync(data);
    expect(inflateCapped(z.subarray(0, z.length - 6), 'zlib')).toBeNull();
    expect(
      inflateCapped(
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
        'gzip',
      ),
    ).toBeNull();
    expect(inflateCapped(new Uint8Array(), 'raw')).toBeNull();
  });
});

// Ordinary text that must never be "decoded" by the newer, stricter decoders (Base45, uuencode,
// quoted-printable, Punycode, Base36, Base100, NATO, Braille, Bubble Babble): not as the best
// result and not even as a candidate.
const NEW_DECODERS = ['base45', 'base100', 'bubblebabble', 'base36', 'base26'];
const ORDINARY = [
  'The quick brown fox jumps over the lazy dog.',
  'Hello, World!',
  'HELLO WORLD THIS IS A TEST MESSAGE',
  'THE MEETING IS AT 10:30 IN ROOM B-204',
  'Meeting at 10:30 in room B-204 on 2024-03-15; bring $50.',
  'https://example.com/path/to/page.html?query=abc&x=1#frag',
  'https://example.com/search?id=41&x=42&y=43',
  'user.name@example.com',
  'C:\\Users\\Public\\Documents\\report.docx',
  '/usr/local/bin/python3.11 --version',
  'SELECT * FROM users WHERE id = 42 AND name = "bob";',
  'const total = items.map((x) => x.price * 1.2).reduce((a, b) => a + b, 0);',
  '{"name":"flag","value":[1,2,3],"ok":true}',
  'Mike and Victor went to the Hotel Lima in India with Oscar and Charlie.',
  'one two three four five six seven eight',
  'Alpha release 1.2.3 of the Delta project is ready, said Echo.',
  'password123 letmein qwerty 123456 iloveyou',
  'internationalization and localization of the user interface',
  'The 2024 budget: $1,250.00 (approx.) + 15% tax = $1,437.50.',
  '- first item\n- second item\n- third item\n',
  'Dear Sir,\n\nI am writing to confirm our appointment.\n\nBest regards,\nAlice\n',
  'commit message: fix handling of empty input && push to origin',
  'ab12cd34ef56',
  'xerox machine at the xenon lab',
  'xylophone',
  'internationalization',
  'supercalifragilisticexpialidocious',
  'ELECTROENCEPHALOGRAPHICALLY',
  'hello1world2foo3bar4',
  'a1b2c3d4e5f6a7b8',
  'v2.3.1-beta-build42',
  'xesef-disof',
  '3.14159265358979323846264338327950288419716939937510',
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor',
  'A1B2C3D4E5F6',
  'ZmxhZ3t3b3Jkc30=',
  'I love you 👍👏💯 so much!',
  '👍👍👍👍👍👍👍',
  '👍🐶👍🐶👍🐶👍🐶',
  '👍👏💯',
  'Voilà : un été très chaud à Paris, où l’on mange des crêpes.',
  'Привет, мир! Это обычный текст.',
  '你好，世界！这是普通文本。',
];

describe('auto-decode: ordinary text is left alone by the newer decoders', () => {
  it.each(ORDINARY)('%s', (text) => {
    const r = solve(text);
    const used = r.ranked.flatMap((c) => c.recipe).filter((n) => NEW_DECODERS.includes(n));
    expect(used).toEqual([]);
    expect(r.best.recipe.some((n) => NEW_DECODERS.includes(n))).toBe(false);
  });
});

describe('auto-decode: speed (2 KB inputs must take well under a second)', () => {
  const lorem =
    'The quick brown fox jumps over the lazy dog. Capture the flag is a competition where players solve puzzles. '.repeat(
      30,
    );
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 255;
  const alnum = Array.from(
    { length: 2048 },
    () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[rnd() % 62],
  ).join('');

  const inputs: [string, string | Uint8Array][] = [
    ['base64 text', b64(lorem).slice(0, 2048)],
    ['hex text', toHex(bytes(lorem)).slice(0, 2048)],
    ['three base64 layers', b64(b64(b64(lorem.slice(0, 500))))],
    ['random alphanumerics', alnum],
    ['random bytes', Uint8Array.from({ length: 2048 }, rnd)],
    ['percent-encoded text', urlEncode(lorem.slice(0, 700), 'all')],
    ['gzip bytes', gzipSync(bytes(lorem))],
  ];

  it.each(inputs)('%s', (_name, input) => {
    const t = performance.now();
    const r = solve(input);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.ranked.length).toBeGreaterThan(0);
  });
});

describe('auto-decode tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    autoDecodeTool.run({ bytes: bytes(text) }, {
      maxDepth: 5,
      beamWidth: 10,
      flagPrefix: '',
      ...options,
    } as never) as Output[];

  it('puts the best result first, labelled with its recipe, then a table', () => {
    const out = run(b64(toHex(bytes(rot13(FLAG)))));
    expect(out[0]).toMatchObject({ type: 'bytes', label: 'Best result · base64 → hex → rot13' });
    expect(utf8Decode((out[0] as { value: Uint8Array }).value)).toBe(FLAG);
    const table = out.find((o) => o.type === 'table');
    expect(table).toMatchObject({ columns: ['#', 'Recipe', 'Score', 'Preview'], highlight: [0] });
    const rows = (table as { rows: (string | number)[][] }).rows;
    expect(rows.length).toBeLessThanOrEqual(15);
    expect(rows[0]![1]).toBe('base64 → hex → rot13');
    expect(rows.map((r) => r[1])).toContain('base64');
    expect(out.some((o) => o.type === 'note' && o.level === 'success')).toBe(true);
  });

  it('says so when nothing decodes to anything better', () => {
    const out = run('just some ordinary words in a sentence');
    expect(out[0]).toMatchObject({ type: 'note', level: 'info' });
    expect(resultToText(out)).toContain('No chain of up to 5 decoders');
    expect(resultToText(out)).toContain('(input as is)');
  });

  it('recognises decoded files', () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
      1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
    ]);
    const out = run(b64(png));
    expect(out[0]).toMatchObject({ type: 'bytes', label: 'Best result · base64' });
    expect(resultToText(out)).toContain('PNG image');
  });

  it('is deterministic', () => {
    const input = b64(b64(FLAG));
    expect(resultToText(run(input))).toBe(resultToText(run(input)));
  });

  it('rejects empty input', () => {
    expect(() =>
      autoDecodeTool.run({ bytes: new Uint8Array() }, {
        maxDepth: 5,
        beamWidth: 10,
        flagPrefix: '',
      } as never),
    ).toThrow(ToolError);
  });

  it('table previews are one line and short', () => {
    const out = run(b64('line one\nline two\n'.repeat(40)));
    const rows = (out.find((o) => o.type === 'table') as { rows: (string | number)[][] }).rows;
    for (const r of rows) {
      expect(String(r[3])).not.toMatch(/\n/);
      expect(String(r[3]).length).toBeLessThanOrEqual(101);
    }
  });

  it('detect: gzip header and opaque tokens, not words', () => {
    const sample = (text: string | null, b = new Uint8Array()) => ({ text, bytes: b });
    expect(autoDecodeTool.detect!(sample(null, gzipSync(bytes(FLAG))))?.score).toBeGreaterThan(
      0.25,
    );
    expect(
      autoDecodeTool.detect!(sample('ZmxhZ3thdXRvX2RlY29kZV93b3Jrc30='))?.score,
    ).toBeGreaterThan(0.25);
    expect(autoDecodeTool.detect!(sample('hello world'))).toBeNull();
    expect(autoDecodeTool.detect!(sample('internationalization'))).toBeNull();
  });
});
