import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { toHex, utf8Decode, utf8Encode } from '../../lib/bytes';
import qp, {
  decodeEncodedWords,
  encodeWords,
  hasEncodedWords,
  looksLikeQp,
  qpDecode,
  qpEncode,
  splitMessage,
} from './quoted-printable';

const dec = (s: string) => utf8Decode(qpDecode(s).bytes);
const enc = (s: string, opts = {}) => qpEncode(utf8Encode(s), opts);

// Made with the independent Python implementation (binascii.b2a_qp, the C code behind the
// "quopri" module): the same text, the same lines, soft breaks in the same places.
const PYTHON_QP: [string, string][] = [
  [
    "Now's the time for all folk to come to the aid of their country.",
    "Now's the time for all folk to come to the aid of their country.",
  ],
  [
    "J'interdis aux marchands de vanter trop leurs marchandises. Car ils se font vite pédagogues et t'enseignent comme but ce qui n'est par essence qu'un moyen, et te trompant ainsi sur la route à suivre les voilà bientôt qui te dégradent, car si leur musique est vulgaire ils te fabriquent pour te la vendre une âme vulgaire.\n— Antoine de Saint-Exupéry, Citadelle (1948)",
    "J'interdis aux marchands de vanter trop leurs marchandises. Car ils se font=\n vite p=C3=A9dagogues et t'enseignent comme but ce qui n'est par essence qu=\n'un moyen, et te trompant ainsi sur la route =C3=A0 suivre les voil=C3=A0 b=\nient=C3=B4t qui te d=C3=A9gradent, car si leur musique est vulgaire ils te =\nfabriquent pour te la vendre une =C3=A2me vulgaire.\n=E2=80=94 Antoine de Saint-Exup=C3=A9ry, Citadelle (1948)",
  ],
  [
    'a = b + c; price: 5€  \ntab\there \t\nend ',
    'a =3D b + c; price: 5=E2=82=AC =20\ntab\there =09\nend=20',
  ],
  [
    'naïve café déjà vu — “quotes” and ‘more’\nsecond line\n\nthird after blank',
    'na=C3=AFve caf=C3=A9 d=C3=A9j=C3=A0 vu =E2=80=94 =E2=80=9Cquotes=E2=80=9D a=\nnd =E2=80=98more=E2=80=99\nsecond line\n\nthird after blank',
  ],
  [
    'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxéyyyyyyyyyy',
    'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=\n=C3=A9yyyyyyyyyy',
  ],
  [
    'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
  ],
  [
    'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\nshort',
    'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\nshort',
  ],
  [
    'éééééééééééééééééééééééééééééééééééééééé',
    '=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=\n=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=\n=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=\n=A9=C3=A9=C3=A9',
  ],
  ['tab at end\t', 'tab at end=09'],
  ['=equals= at start =3D and =', '=3Dequals=3D at start =3D3D and =3D'],
  [
    'emoji 😀 and CJK 日本語 and cyrillic Привет',
    'emoji =F0=9F=98=80 and CJK =E6=97=A5=E6=9C=AC=E8=AA=9E and cyrillic =D0=9F=\n=D1=80=D0=B8=D0=B2=D0=B5=D1=82',
  ],
  [
    'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwéééwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
    'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww=C3=\n=A9=C3=A9=C3=A9wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww=\nwwwwwwwwww',
  ],
];

describe('quoted-printable: decoding', () => {
  it('RFC 2045 section 6.7 (rule 5): soft line breaks', () => {
    // The RFC's own example: "Now's the time for all folk to come to the aid of their country."
    expect(dec("Now's the time =\nfor all folk to come=\n to the aid of their country.")).toBe(
      "Now's the time for all folk to come to the aid of their country.",
    );
  });

  it('reads =XX (capitals or lower case) and counts the lower-case ones', () => {
    const r = qpDecode('caf=C3=A9 =e2=82=ac =3D');
    expect(utf8Decode(r.bytes)).toBe('café € =');
    expect(r.lowercase).toBe(2); // =e2 and =ac (=82 has no letter to be lower case)
  });

  it('a soft break may be followed by blanks; blanks at the end of a line are dropped', () => {
    expect(dec('abc=  \ndef')).toBe('abcdef');
    expect(dec('abc  \r\ndef \t\nghi  ')).toBe('abc\r\ndef\nghi');
    expect(dec('abc=')).toBe('abc'); // a "=" at the very end is a soft break too
    expect(qpDecode('a=\nb=\nc').softBreaks).toBe(2);
  });

  it('keeps hard line breaks as they were written, CRLF or LF', () => {
    expect(dec('a\r\nb\nc')).toBe('a\r\nb\nc');
    expect(dec('')).toBe('');
    expect(dec('\n\n')).toBe('\n\n');
  });

  it('a "=" that starts no escape is kept, listed with its line and column, or refused when strict', () => {
    const r = qpDecode('ok =Zz here\nand =G');
    expect(utf8Decode(r.bytes)).toBe('ok =Zz here\nand =G');
    expect(r.problems).toEqual([
      { line: 1, column: 4, text: '=Zz' },
      { line: 2, column: 5, text: '=G' },
    ]);
    expect(() => qpDecode('one\ntwo =Q1 three', true)).toThrow(ToolError);
    expect(() => qpDecode('one\ntwo =Q1 three', true)).toThrow(/"=Q1" at line 2, column 5/);
  });

  it('non-ASCII characters in the text are copied as UTF-8 and counted', () => {
    const r = qpDecode('café=C3=A9');
    expect(utf8Decode(r.bytes)).toBe('caféé');
    expect(r.nonAscii).toBe(1);
  });

  it.each(PYTHON_QP)('decodes the Python encoding of %j', (text, encoded) => {
    // Trailing blanks are not data in QP, so the originals that end in a blank use =20 / =09
    expect(dec(encoded)).toBe(text);
  });
});

describe('quoted-printable: encoding', () => {
  it.each(PYTHON_QP)('matches the Python reference for %j', (text, encoded) => {
    expect(enc(text)).toBe(encoded);
  });

  it('never makes a line longer than 76 characters and never cuts an =XX', () => {
    let seed = 2045;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8;
    for (let n = 0; n < 60; n++) {
      const data = Uint8Array.from({ length: 50 + (rnd() % 400) }, () => {
        const r = rnd() % 10;
        return r < 6 ? 97 + (rnd() % 26) : rnd() & 0xff;
      });
      const text = qpEncode(data, { binary: true });
      for (const line of text.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(76);
        // a line is whole tokens: letters and "=XX", then perhaps one "=" (the soft break)
        expect(line.replace(/=$/, '')).toMatch(/^(?:[^=]|=[0-9A-F]{2})*$/);
      }
      expect(toHex(qpDecode(text).bytes)).toBe(toHex(data));
    }
  });

  it('binary mode encodes CR and LF; text mode keeps them as line breaks', () => {
    expect(enc('a\nb')).toBe('a\nb');
    expect(enc('a\r\nb')).toBe('a\nb');
    expect(enc('a\nb', { binary: true })).toBe('a=0Ab');
    expect(enc('a\r\nb', { binary: true })).toBe('a=0D=0Ab');
    expect(enc('a\r\nb', { eol: '\r\n' })).toBe('a\r\nb');
  });

  it('a blank at the end of a line, or of the text, is encoded; the others stay', () => {
    expect(enc('a b \nc\t')).toBe('a b=20\nc=09');
    expect(enc(' ')).toBe('=20');
  });

  it('honours a shorter line length and the line end', () => {
    const text = enc('abcdefghijklmnopqrstuvwxyz'.repeat(3), { lineLength: 20, eol: '\r\n' });
    const lines = text.split('\r\n');
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(20);
    expect(dec(text.replace(/\r\n/g, '\n'))).toBe('abcdefghijklmnopqrstuvwxyz'.repeat(3));
  });

  it('round-trips random binary data in binary mode', () => {
    for (const len of [0, 1, 2, 75, 76, 77, 300, 2000]) {
      const data = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
      expect(toHex(qpDecode(qpEncode(data, { binary: true })).bytes)).toBe(toHex(data));
    }
  });
});

describe('MIME encoded words (RFC 2047)', () => {
  // RFC 2047 section 8 ("Examples"); Python's email.header gives the same readings.
  const RFC_2047: [string, string][] = [
    ['=?ISO-8859-1?Q?Keld_J=F8rn_Simonsen?=', 'Keld Jørn Simonsen'],
    ['=?ISO-8859-1?Q?Andr=E9?=', 'André'],
    [
      '=?ISO-8859-1?B?SWYgeW91IGNhbiByZWFkIHRoaXMgeW8=?= =?ISO-8859-2?B?dSB1bmRlcnN0YW5kIHRoZSBleGFtcGxlLg==?=',
      'If you can read this you understand the example.',
    ],
    ['(=?ISO-8859-1?Q?a?=)', '(a)'],
    ['(=?ISO-8859-1?Q?a?= b)', '(a b)'],
    ['(=?ISO-8859-1?Q?a?= =?ISO-8859-1?Q?b?=)', '(ab)'],
    ['(=?ISO-8859-1?Q?a?=  =?ISO-8859-1?Q?b?=)', '(ab)'],
    ['(=?ISO-8859-1?Q?a?=\r\n =?ISO-8859-1?Q?b?=)', '(ab)'],
    ['(=?ISO-8859-1?Q?a_b?=)', '(a b)'],
    ['(=?ISO-8859-1?Q?a?= =?ISO-8859-2?Q?_b?=)', '(a b)'],
    ['=?US-ASCII?Q?Keith_Moore?= <moore@cs.utk.edu>', 'Keith Moore <moore@cs.utk.edu>'],
    ['=?UTF-8?B?w6nDqcOp?= plain =?utf-8?q?caf=C3=A9_cr=C3=A8me?=', 'ééé plain café crème'],
  ];

  it.each(RFC_2047)('%j', (word, text) => {
    expect(decodeEncodedWords(word).text).toBe(text);
  });

  it('decodes neighbouring words of one charset together: a character cut in two comes out whole', () => {
    // "é" is C3 A9 in UTF-8: the first word ends after C3, the second starts with A9
    expect(decodeEncodedWords('=?UTF-8?Q?caf=C3?= =?UTF-8?Q?=A9_ok?=').text).toBe('café ok');
    expect(decodeEncodedWords('=?UTF-8?B?w6k=?= =?ISO-8859-1?Q?=E9?=').text).toBe('éé');
  });

  it('tells each word, charset and encoding; a language tag is accepted', () => {
    const r = decodeEncodedWords('x =?utf-8*fr?Q?caf=C3=A9?= y =?UTF-8?B?4pyT?=');
    expect(r.text).toBe('x café y ✓');
    expect(r.words.map((w) => [w.charset, w.encoding, w.text, w.pos])).toEqual([
      ['utf-8', 'Q', 'café', 3],
      ['UTF-8', 'B', '✓', 30],
    ]);
  });

  it('a word that cannot be decoded is kept, an unknown charset is read as Windows-1252', () => {
    expect(decodeEncodedWords('=?UTF-8?Q?bad=Z?=').text).toBe('=?UTF-8?Q?bad=Z?=');
    expect(decodeEncodedWords('=?UTF-8?Q?bad=Z?=').words[0]!.text).toBeNull();
    const r = decodeEncodedWords('=?x-made-up?Q?caf=E9?=');
    expect(r.text).toBe('café');
    expect(r.badCharsets).toEqual(['x-made-up']);
    expect(hasEncodedWords('no words =? here ?=')).toBe(false);
  });

  it('writes words of at most 75 characters that decode back, cut between characters', () => {
    const text = 'Résumé du drapeau ✓ '.repeat(8) + '😀'.repeat(20);
    for (const enc of ['Q', 'B'] as const) {
      const out = encodeWords(text, enc, 'UTF-8', (ch) => utf8Encode(ch));
      for (const w of out.split(' ')) expect(w.length).toBeLessThanOrEqual(75);
      expect(out.split(' ').length).toBeGreaterThan(3);
      expect(decodeEncodedWords(out).text).toBe(text);
    }
  });

  it('Q words keep only the safe characters and write a blank as an underscore', () => {
    expect(encodeWords('Café crème ✓', 'Q', 'UTF-8', (c) => utf8Encode(c))).toBe(
      '=?UTF-8?Q?Caf=C3=A9_cr=C3=A8me_=E2=9C=93?=',
    );
    expect(encodeWords('a=b?c_d', 'Q', 'UTF-8', (c) => utf8Encode(c))).toBe(
      '=?UTF-8?Q?a=3Db=3Fc=5Fd?=',
    );
    expect(encodeWords('Café', 'B', 'UTF-8', (c) => utf8Encode(c))).toBe('=?UTF-8?B?Q2Fmw6k=?=');
  });
});

describe('whole messages', () => {
  const MAIL = [
    'Subject: =?UTF-8?B?UsOpc3Vtw6k=?=',
    'Content-Type: text/plain; charset="iso-8859-1"',
    ' format=flowed',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Caf=E9 cr=E8me',
    '',
  ].join('\n');

  it('splits headers from the body, only when the top really looks like headers', () => {
    expect(splitMessage(MAIL)?.body).toBe('Caf=E9 cr=E8me\n');
    expect(splitMessage('Hello: caf=C3=A9\n\nsecond paragraph')?.head).toBe('Hello: caf=C3=A9');
    expect(splitMessage('Just text\n\nmore text')).toBeNull();
    expect(splitMessage('Not: a header\nbut text\n\nmore')).toBeNull();
    expect(splitMessage('no blank line: here')).toBeNull();
  });
});

describe('looksLikeQp (Auto-decode and triage)', () => {
  it('quoted-printable text: soft breaks, or two or more bytes QP exists for', () => {
    for (const s of [
      'caf=C3=A9 cr=C3=A8me',
      "Now's the time =\nfor all folk to come=\n to the aid of their country.",
      'a =3D b and =3D c',
      '=66=6C=61=67=7B=71=70=7D',
    ]) {
      expect(looksLikeQp(s)).toBe(true);
    }
  });

  it('ordinary text with an "=" is not', () => {
    for (const s of [
      'id=41&x=42&y=43',
      'https://example.com/?a=1&b=AB',
      'x = 3D and y = 4',
      'caf=e9',
      'ZmxhZ3t3b3Jkc30=',
      'a==b',
      'key=ABCDEF&token=1A2B3C',
      'one =C3 is not enough',
      'no equals here at all',
      '',
    ]) {
      expect(looksLikeQp(s)).toBe(false);
    }
  });
});

describe('quoted-printable tool', () => {
  const run = (text: string, options: Record<string, unknown> = {}) =>
    qp.run({ bytes: utf8Encode(text) }, {
      mode: 'decode',
      form: 'auto',
      strict: false,
      encodeAs: 'body',
      charset: 'auto',
      binary: false,
      eol: 'lf',
      lineLength: 76,
      ...options,
    } as never) as Output[];

  it('decodes a body, in UTF-8 and in another charset', () => {
    expect(resultToText(run('Caf=C3=A9 =3D 5=E2=82=AC'))).toBe('Café = 5€');
    expect(resultToText(run('Caf=E9', { charset: 'iso-8859-1' }))).toBe('Café');
    // not UTF-8: automatic mode falls back to Windows-1252 and says so
    const auto = resultToText(run('Caf=E9'));
    expect(auto).toContain('Café');
    expect(auto).toContain('Windows-1252');
    expect(resultToText(run('=C3=A9', { charset: 'utf-8' }))).toBe('é');
  });

  it('decodes encoded words, and a header with the table of words', () => {
    const out = run('Subject: =?UTF-8?B?4pyT?= and =?ISO-8859-1?Q?caf=E9?=');
    expect(out[0]).toEqual({ type: 'text', value: 'Subject: ✓ and café' });
    expect((out[1] as { rows: string[][] }).rows).toEqual([
      ['UTF-8', 'B', '✓'],
      ['ISO-8859-1', 'Q', 'café'],
    ]);
  });

  it('a message: header words and body together, with the charset of the header', () => {
    const mail = [
      'From: a@example.org',
      'Subject: =?UTF-8?B?UsOpc3Vtw6k=?=',
      'Content-Type: text/plain; charset=iso-8859-1',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=E9 cr=E8me =3D ok=',
      ' ok',
    ].join('\n');
    const text = resultToText(run(mail));
    expect(text).toContain('Subject: Résumé');
    expect(text).toContain('Café crème = ok ok');
    expect(text).toContain('iso-8859-1');
    expect(text).not.toContain('=E9');
  });

  it('a body with "=" in its headers does not report invalid escapes', () => {
    const text = resultToText(run('Content-Type: text/plain; charset="utf-8"\n\nCaf=C3=A9'));
    expect(text).toContain('Café');
    expect(text).not.toContain('Invalid');
  });

  it('reports invalid escapes with the first line and column, or fails when strict', () => {
    const out = resultToText(run('one\nbad =Zz here =C3=A9'));
    expect(out).toContain('Invalid escapes kept as written: 1');
    expect(out).toContain('"=Zz" at line 2, column 5');
    expect(() => run('one\nbad =Zz here', { strict: true })).toThrow(/line 2, column 5/);
  });

  it('form: words only or body only', () => {
    expect(run('=?UTF-8?Q?=C3=A9?= =C3=A9', { form: 'words' })[0]).toEqual({
      type: 'text',
      value: 'é =C3=A9',
    });
    // as a body, the word is not an encoded word: "=?" is invalid and the final "=" a soft break
    const body = resultToText(run('=?UTF-8?Q?x?=', { form: 'body' }));
    expect(body).toContain('=?UTF-8?Q?x?');
    expect(body).toContain('Invalid escapes kept as written: 1');
  });

  it('encodes a body, as encoded words, in Latin-1, and with CRLF', () => {
    expect(resultToText(run('Café: 5€ = cinq', { mode: 'encode' }))).toBe(
      'Caf=C3=A9: 5=E2=82=AC =3D cinq',
    );
    expect(resultToText(run('Café', { mode: 'encode', charset: 'iso-8859-1' }))).toBe('Caf=E9');
    expect(resultToText(run('Café ✓', { mode: 'encode', encodeAs: 'q' }))).toBe(
      '=?UTF-8?Q?Caf=C3=A9_=E2=9C=93?=',
    );
    expect(
      resultToText(run('Café', { mode: 'encode', encodeAs: 'b', charset: 'iso-8859-1' })),
    ).toBe('=?ISO-8859-1?B?Q2Fm6Q==?=');
    expect(resultToText(run('a\nb', { mode: 'encode', eol: 'crlf' }))).toBe('a\r\nb');
    expect(() => run('✓', { mode: 'encode', charset: 'iso-8859-1' })).toThrow(/"✓" at position 1/);
    expect(() => run('x', { mode: 'encode', charset: 'koi8-r' })).toThrow(/Cannot write/);
  });

  it('rejects empty input', () => {
    expect(() => run('  ')).toThrow(ToolError);
  });

  it('detect: encoded words and quoted-printable, not ordinary text', () => {
    const sample = (text: string) => ({ text, bytes: new Uint8Array() });
    expect(qp.detect!(sample('Subject: =?UTF-8?B?4pyT?='))?.score).toBeGreaterThan(0.8);
    expect(qp.detect!(sample('caf=C3=A9 cr=C3=A8me'))?.score).toBeGreaterThan(0.7);
    expect(qp.detect!(sample('id=41&x=42'))).toBeNull();
    expect(qp.detect!(sample('hello world'))).toBeNull();
  });
});
