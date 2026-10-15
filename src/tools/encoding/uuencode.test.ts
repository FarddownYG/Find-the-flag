import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { fromHex, toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import uu, { modeString, safeName, uuDecode, uuDecodeStrict, uuEncode } from './uuencode';

// Made with the independent Python implementation (binascii.b2a_uu, the C code behind the
// removed "uu" module) from seeded random bytes, 45 bytes per line, a backtick for zero. The
// xxencode column is the same 6-bit values written in the xxencode alphabet.
const PYTHON_UU: [string, string, string][] = [
  ['', '', ''],
  ['3a', '!.@``', '-CU++'],
  ['0a57', '""E<`', '00ZQ+'],
  ['edadb5', '#[:VU', '1vOqp'],
  ['21b9f09d', '$(;GPG0``', '26PbkbE++'],
  ['23c64e4196', '%(\\9.098`', '36wNCENM+'],
  [
    '5a4bde85df4f94a4c87b928b2503c853887ecbe8392cd07806dcf7ca8510885c0881e6d357abaa5d3b292fe8',
    'L6DO>A=]/E*3(>Y*+)0/(4XA^R^@Y+-!X!MSWRH40B%P(@>;35ZNJ73LI+^@`',
    'gKYjSVRxDZ8H6St897ED6IsVymyUt9B-s-hnrmcIEW3k6USPHJuieLHgd9yU+',
  ],
  [
    '4d5b3b0a0f40fa61ab1e036a2dbc1c9a7d3d24b9810b633168882ef36e2e68d1acfe55733accb09a081c2d9647',
    'M35L["@]`^F&K\'@-J+;P<FGT])+F!"V,Q:(@N\\VXN:-&L_E5S.LRPF@@<+99\'',
    'hHJgv0Ux+ya4f5UBe9PkQabox79a-0qAlO6UiwqsiOB4gzZJnCgmkaUUQ9NN5',
  ],
  [
    'dad25cd563010fb0ebef41fcfe6b3dd8bf0963d98868a32d5e61fec0ca7e33184f2013d64cd17f0502cc5e93dcbc',
    "MVM)<U6,!#[#K[T'\\_FL]V+\\)8]F(:*,M7F'^P,I^,QA/(!/63-%_!0+,7I/<\n!O```",
    'hqh7QpKA-1v1fvo5wzagxq9w7Mxa6O8AhLa5ykAdyAlVD6-DKHB3z-E9ALdDQ\n-j+++',
  ],
  [
    'a8be77e12a2f5089c34a5806203622bd8901df3a0ed9999892a56ae8765a9747e4b05200252bfc72086f21f949f37522650e359682ee1bf2786a4d7c2b2471efa1404c5aaab1b6c10b345ba89e0ee7f6ba9de741c475bec3f278',
    "MJ+YWX2HO4(G#2E@&(#8BO8D!WSH.V9F8DJ5JZ'9:ET?DL%(`)2O\\<@AO(?E)\nM\\W4B90XUEH+N&_)X:DU\\*R1Q[Z%`3%JJL;;!\"S1;J)X.Y_:ZG>=!Q'6^P_)X",
    'he9trsGcjI6b1GZU461MWjMY-rncCqNaMYeJeu5NOZoTYg36+7GjwQUVj6TZ7\nhwrIWNEspZc9i4z7sOYpw8mFlvu3+H3eegPP-0nFPe7sCtzOubSR-l5Kykz7s',
  ],
  [
    'c4fc4692d9213d6499d12f32a5d92858354fc5b2b65a3f2521e5d1f8479926c11cec1db3caa85fd8ecde1e26ac31fc028e9a7c9a22e9db4c52cb2f15c8beefb35983a6ea3a43f3f43f7cc2320e3d51e8951e90be75d64f0360de2ec6b97c4129116b1d6b',
    'MQ/Q&DMDA/629T2\\RI=DH6#5/Q;*V6C\\E(>71^$>9)L$<[!VSRJA?V.S>\'B:L\nM,?P"CII\\FB+IVTQ2RR\\5R+[OLUF#INHZ0_/T/WS",@X]4>B5\'I"^==9/`V#>\n*+L:Y?$$I$6L=:P``',
    'hlDl4YhYVDKGNoGwmdRYcK1JDlP8qKXwZ6SLFy2SN7g2Qv-qnmeVTqCnS5WOg\nhATk0XddwaW9dqolGmmwJm9vjgpa1dicuEzDoDrn0AUsxISWJ5d0yRRND+q1S\n89gOtT22d2KgROk++',
  ],
  [
    '8b018a700c37257bab207071cfc756e5ca2cc057623f13250cb6a7c6633eee8b264f15c1ba520aa04aa713ba86a8fc66ae50b395e37e23d39022a63e7b5ea81fdb5e173d156b6cd913a01cdbcd58dec3c1f276e42d62f30c0fbfd2b5b177327aebb3c167a92288887861c990a4d7041e0c50db402678d7fc624ff387e873ccfab0f49cc1bbe7510f57e5ec202feca2b5b34111ba5e1f',
    "MBP&*<`PW)7NK('!QS\\=6Y<HLP%=B/Q,E#+:GQF,^[HLF3Q7!NE(*H$JG$[J&\nMJ/QFKE\"SE>-^(].0(J8^>UZH']M>%ST5:VS9$Z`<V\\U8WL/!\\G;D+6+S#`^_\nMTK6Q=S)ZZ[/!9ZDBB(AX8<F0I-<$'@Q0VT`F>-?\\8D_SA^ASS/JP])S!N^=1\n/#U?E[\"`O[**ULT$1NEX?",
    'hWk48Q+kr7Lif65-lnwRKtQcgk3RWDlAZ19OblaAyvcgaHlL-iZ68c2eb2ve4\nheDlafZ0nZSBy6xCE6eMySpuc5xhS3noJOqnN2u+QqwpMrgD-wbPY9K9n1+yz\nhofKlRn7uuvD-NuYWW6VsMQaEdBQ25UlEqo+aSBTwMYznVyVnnDekx7n-iyRF\nD1pTZv0+jv88pgo2FiZsT',
  ],
];

const decodeBare = (text: string, fmt: 'uu' | 'xx' | 'auto' = 'auto') =>
  toHex(uuDecode(text, fmt)[0]!.bytes);

describe('uuencode', () => {
  it('Wikipedia: "Cat" is #0V%T', () => {
    expect(uuEncode(utf8Encode('Cat'), { name: 'cat.txt' })).toBe(
      'begin 644 cat.txt\n#0V%T\n`\nend',
    );
    expect(utf8Decode(uuDecode('begin 644 cat.txt\n#0V%T\n`\nend')[0]!.bytes)).toBe('Cat');
  });

  it.each(PYTHON_UU)('matches the Python reference for %s', (hex, uuLines) => {
    expect(uuEncode(fromHex(hex), { header: false })).toBe(uuLines);
    if (hex) expect(decodeBare(uuLines, 'uu')).toBe(hex);
  });

  it.each(PYTHON_UU)(
    'xxencode of %s uses the same values with the xxencode alphabet',
    (hex, _uu, xx) => {
      expect(uuEncode(fromHex(hex), { header: false, format: 'xx' })).toBe(xx);
      if (hex) expect(decodeBare(xx, 'xx')).toBe(hex);
    },
  );

  it('frames the lines with begin, the zero-length line and end', () => {
    const text = uuEncode(utf8Encode('Cat'), { name: 'my file.txt', mode: '600' });
    expect(text).toBe('begin 600 my file.txt\n#0V%T\n`\nend');
    const s = uuDecode(text)[0]!;
    expect([s.name, s.mode, s.format, s.lines]).toEqual(['my file.txt', '600', 'uu', 1]);
    expect(uuEncode(new Uint8Array(), { name: 'e' })).toBe('begin 644 e\n`\nend');
    expect(uuEncode(utf8Encode('Cat'), { format: 'xx' })).toBe('begin 644 data.bin\n1Eq3o\n+\nend');
  });

  it('the traditional space for zero, and a backtick, are both read', () => {
    const data = Uint8Array.of(0, 0, 0, 1, 2, 3, 0, 0, 0, 0);
    const space = uuEncode(data, { header: false, backtick: false });
    const tick = uuEncode(data, { header: false, backtick: true });
    expect(space).toBe('*     0(#        '); // Python: binascii.b2a_uu(data, backtick=False)
    expect(tick).toBe('*`````0(#````````'); // Python: binascii.b2a_uu(data, backtick=True)
    expect(decodeBare(space)).toBe(toHex(data));
    expect(decodeBare(tick)).toBe(toHex(data));
    expect(uuEncode(data, { name: 'z', backtick: false })).toBe(`begin 644 z\n${space}\n \nend`);
  });

  it('line length: 45 bytes by default, 1 to 63 on request', () => {
    const data = Uint8Array.from({ length: 200 }, (_, i) => (i * 7 + 3) & 255);
    const lines45 = uuEncode(data, { header: false }).split('\n');
    expect(lines45).toHaveLength(5);
    expect(lines45[0]!.length).toBe(61);
    expect(lines45[0]![0]).toBe('M');
    const lines63 = uuEncode(data, { header: false, lineBytes: 63 }).split('\n');
    expect(lines63[0]![0]).toBe('_');
    expect(lines63[0]!.length).toBe(85);
    expect(uuEncode(data, { header: false, lineBytes: 999 }).split('\n')[0]![0]).toBe('_');
    expect(uuEncode(data, { header: false, lineBytes: 0 }).split('\n')).toHaveLength(200);
    for (const per of [1, 2, 7, 44, 63]) {
      expect(decodeBare(uuEncode(data, { header: false, lineBytes: per }))).toBe(toHex(data));
    }
  });

  it('round-trips random binary of many lengths in both alphabets, framed or bare', () => {
    let seed = 1983;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8;
    for (const len of [1, 2, 3, 4, 44, 45, 46, 89, 90, 91, 500, 3000]) {
      const data = Uint8Array.from({ length: len }, () => rnd() & 0xff);
      for (const format of ['uu', 'xx'] as const) {
        for (const header of [true, false]) {
          const text = uuEncode(data, { format, header });
          expect(toHex(uuDecode(text, format)[0]!.bytes)).toBe(toHex(data));
          expect(toHex(uuDecode(text, 'auto')[0]!.bytes)).toBe(toHex(data));
        }
      }
    }
  });

  it('uuencode -m: a base64 body between begin-base64 and ====', () => {
    expect(uuEncode(utf8Encode('Cat'), { format: 'base64', name: 'cat.txt' })).toBe(
      'begin-base64 644 cat.txt\nQ2F0\n====',
    );
    const s = uuDecode('begin-base64 644 cat.txt\nQ2F0\n====')[0]!;
    expect([utf8Decode(s.bytes), s.name, s.format]).toEqual(['Cat', 'cat.txt', 'base64']);
    const long = Uint8Array.from({ length: 200 }, (_, i) => i);
    expect(toHex(uuDecode(uuEncode(long, { format: 'base64' }))[0]!.bytes)).toBe(toHex(long));
  });
});

describe('uudecode: reading real-world text', () => {
  const FRAMED = 'begin 644 cat.txt\n#0V%T\n`\nend';

  it('skips a mail around the file, and several files in one text', () => {
    const mail = `From: a@example.org\nSubject: x\n\nhere you go\n${FRAMED}\n\nthanks\n-- \nsig`;
    expect(utf8Decode(uuDecode(mail)[0]!.bytes)).toBe('Cat');
    const two = `${FRAMED}\nnoise\nbegin 755 dog.sh\n#1&]G\n\`\nend\n`;
    const sections = uuDecode(two);
    expect(sections.map((s) => [s.name, s.mode, utf8Decode(s.bytes)])).toEqual([
      ['cat.txt', '644', 'Cat'],
      ['dog.sh', '755', 'Dog'],
    ]);
  });

  it('CRLF line ends, blank lines and blanks added after a line are harmless', () => {
    expect(utf8Decode(uuDecode('begin 644 cat.txt\r\n#0V%T  \r\n\r\n`\r\nend\r\n')[0]!.bytes)).toBe(
      'Cat',
    );
  });

  it('reads a begin line without a name', () => {
    expect(uuDecode('begin 644\n#0V%T\n`\nend')[0]!.name).toBeNull();
  });

  it('lines stripped of their trailing blanks are refused, or restored when lenient', () => {
    const data = Uint8Array.of(0, 0, 0, 1, 2, 3, 0, 0, 0, 0);
    const stripped = uuEncode(data, { header: false, backtick: false }).trimEnd();
    expect(() => uuDecode(stripped)).toThrow(
      /Line 1: the length character "\*" says 10 bytes \(16 characters\), but the line has 8/,
    );
    const r = uuDecode(stripped, 'auto', true)[0]!;
    expect(toHex(r.bytes)).toBe(toHex(data));
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.line).toBe(1);
  });

  it('a bad character names the line and column, in the alphabet that looks right', () => {
    // a lower-case letter in uuencode (it has none) ...
    expect(() => uuDecode('#0V%t', 'uu')).toThrow(
      /Line 1, column 5: "t" is not in the uuencode alphabet/,
    );
    // ... and the same text read as xxencode says the other thing
    expect(() => uuDecode('begin 644 x\n#0V%T\n`\nend', 'xx')).toThrow(
      /Line 2, column 1: "#" is not in the xxencode alphabet/,
    );
    // auto: the alphabet that fits most lines is the one the error is about ...
    expect(() => uuDecode('#0V%T\n#0V%t')).toThrow(/Line 2, column 5: "t" is not in the uuencode/);
    // a tie on the lines that fit: the alphabet that gets furthest before its first bad character
    expect(() => uuDecode('begin 644 x\n#0V%t\n`\nend')).toThrow(
      /Line 2, column 5: "t" is not in the uuencode alphabet/,
    );
    // ... and when that is a tie too, lower-case letters mean xxencode
    expect(() => uuDecode('-ab!d')).toThrow(
      /Line 1, column 4: "!" is not in the xxencode alphabet/,
    );
  });

  it('a line longer than its length character says is refused too', () => {
    expect(() => uuDecode('#0V%TX')).toThrow(/says 3 bytes \(4 characters\), but the line has 5/);
    expect(utf8Decode(uuDecode('#0V%TX', 'auto', true)[0]!.bytes)).toBe('Cat');
  });

  it('an empty text, or only begin and end, is an empty file', () => {
    expect(uuDecode('begin 644 e\n`\nend')[0]!.bytes).toHaveLength(0);
    expect(uuDecode('')[0]!.bytes).toHaveLength(0);
  });
});

describe('uuDecodeStrict (Auto-decode and triage)', () => {
  const text =
    'The quick brown fox jumps over the lazy dog. FTF{bare_uu_lines} is hidden in plain sight.';

  it('framed text always, bare lines when they all fit and carry 12+ bytes', () => {
    expect(utf8Decode(uuDecodeStrict(uuEncode(utf8Encode(text)), 'uu')!)).toBe(text);
    expect(utf8Decode(uuDecodeStrict(uuEncode(utf8Encode(text), { header: false }), 'uu')!)).toBe(
      text,
    );
    expect(
      utf8Decode(
        uuDecodeStrict(uuEncode(utf8Encode(text), { header: false, format: 'xx' }), 'xx')!,
      ),
    ).toBe(text);
    expect(uuDecodeStrict('#0V%T', 'uu')).toBeNull(); // 3 bytes of a bare line: too little
  });

  it('ordinary text is not uuencode', () => {
    for (const s of [
      'HELLO WORLD THIS IS A TEST MESSAGE',
      '#HASHTAG',
      'The quick brown fox jumps over the lazy dog.',
      '1 2 3 4 5 6 7 8 9 10 11 12 13 14',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      '',
    ]) {
      expect(uuDecodeStrict(s, 'uu')).toBeNull();
    }
  });
});

describe('uuencode tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}, name?: string) =>
    uu.run({ bytes: utf8Encode(text), name }, {
      mode: 'decode',
      format: 'auto',
      lenient: false,
      writeAs: 'uu',
      header: true,
      name: '',
      fileMode: '644',
      lineBytes: 45,
      backtick: true,
      ...options,
    } as never) as Output[];

  it('decodes to a file with its name, and tells the details', () => {
    const out = run('begin 644 cat.txt\n#0V%T\n`\nend');
    expect(out[0]).toMatchObject({ type: 'bytes', filename: 'cat.txt' });
    const kv = out.find((o) => o.type === 'kv') as { entries: [string, string][] };
    expect(kv.entries).toEqual([
      ['Format', 'uuencode'],
      ['File name', 'cat.txt'],
      ['Mode', '644 (rw-r--r--)'],
      ['Lines', '1'],
      ['Size', '3 B'],
    ]);
  });

  it('several files in one text: a table and the files to download', () => {
    const out = run('begin 644 a.txt\n#0V%T\n`\nend\nbegin 600 b\n#1&]G\n`\nend');
    const files = out.find((o) => o.type === 'files') as { files: { name: string }[] };
    expect(files.files.map((f) => f.name)).toEqual(['a.txt', 'b']);
    expect(resultToText(out)).toContain('b\t600\tuuencode\t3 B');
  });

  it('the name from the begin line cannot carry a path or control characters', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('C:\\Users\\a\\x.png')).toBe('x.png');
    expect(safeName('a\u0001b\u007fc')).toBe('abc');
    expect(safeName('..')).toBe('decoded.bin');
    expect(safeName(null)).toBe('decoded.bin');
    expect(modeString('644')).toBe('rw-r--r--');
    expect(modeString('0755')).toBe('rwxr-xr-x');
  });

  it('encodes with the name, mode and options, and takes the name of an opened file', () => {
    expect(resultToText(run('Cat', { mode: 'encode', name: 'cat.txt' }))).toBe(
      'begin 644 cat.txt\n#0V%T\n`\nend',
    );
    expect(resultToText(run('Cat', { mode: 'encode' }, 'opened.bin'))).toContain(
      'begin 644 opened.bin',
    );
    expect(resultToText(run('Cat', { mode: 'encode' }))).toContain('begin 644 data.bin');
    expect(resultToText(run('Cat', { mode: 'encode', header: false }))).toBe('#0V%T');
    expect(resultToText(run('Cat', { mode: 'encode', writeAs: 'xx', fileMode: '0600' }))).toBe(
      'begin 0600 data.bin\n1Eq3o\n+\nend',
    );
    expect(resultToText(run('Cat', { mode: 'encode', writeAs: 'base64', name: 'c' }))).toBe(
      'begin-base64 644 c\nQ2F0\n====',
    );
    expect(() => run('Cat', { mode: 'encode', fileMode: '999' })).toThrow(
      /not three or four octal digits/,
    );
  });

  it('rejects empty input and reports bad lines as ToolError', () => {
    expect(() => run('  ')).toThrow(ToolError);
    expect(() => run('#0V%t', { format: 'uu' })).toThrow(/column 5/);
  });

  it('keeps going on bad lines when asked, and lists them', () => {
    const out = resultToText(run('#0V%TX', { lenient: true }));
    expect(out).toContain('Cat');
    expect(out).toContain('says 3 bytes');
  });

  it('detect: a begin line, or bare lines that fit, not ordinary text', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(uu.detect!(sample('begin 644 cat.txt\n#0V%T\n`\nend'))?.score).toBeGreaterThan(0.9);
    const bare = uuEncode(utf8Encode('The quick brown fox jumps over the lazy dog, twice.'), {
      header: false,
    });
    expect(uu.detect!(sample(bare))?.score).toBeGreaterThan(0.6);
    expect(uu.detect!(sample('hello world'))).toBeNull();
    expect(uu.detect!(sample('#0V%T'))).toBeNull();
  });
});
