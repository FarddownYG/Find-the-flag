import { describe, expect, it } from 'vitest';
import { toBase64, utf8Encode } from '../../lib/bytes';
import { parseHtml, regions } from './_web-source-html';
import { nameClass, secretLike, shannon, subwords, valueClass } from './_web-source-hits';
import { scanDocs, type Finding, type Kind, type ScanDoc } from './_web-source-secrets';

// Token-like test values are assembled from pieces: no scanner should mistake this file for a leak.
const AWS = `${'AKIA'}IOSFODNN7EXAMPLE`;
const GITHUB = `${'ghp'}_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
const GOOGLE = `${'AIza'}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q`;
const STRIPE = `${'sk_'}${'live_'}Xx9Yy8Zz7Ww6Vv5Uu4Tt3Ss2`;
const SLACK = `${'xo'}${'xb-'}123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx`;
const PEM_HEADER = `${'-----BEGIN '}${'RSA PRIVATE KEY-----'}`;
const PEM_FOOTER = `${'-----END '}${'RSA PRIVATE KEY-----'}`;

const b64url = (json: string) =>
  toBase64(utf8Encode(json)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (header: object, payload: object, sig = 'c2lnbmF0dXJl') =>
  [b64url(JSON.stringify(header)), b64url(JSON.stringify(payload)), sig].join('.');

function scan(text: string, doc: Partial<ScanDoc> = {}, deps = false): Finding[] {
  return scanDocs([{ name: null, text, dependency: false, lang: 'js', ...doc }], { deps }).findings;
}
const matches = (f: Finding[]) => f.map((x) => x.match);
const find = (f: Finding[], kind: Kind) => f.find((x) => x.kinds.includes(kind));

describe('names and values', () => {
  it('splits identifiers into words', () => {
    expect(subwords('adminPassword')).toEqual(['admin', 'password']);
    expect(subwords('API_KEY')).toEqual(['api', 'key']);
    expect(subwords('XMLHttpRequestToken')).toEqual(['xml', 'http', 'request', 'token']);
  });

  it('classifies names: strong, weak or neither', () => {
    for (const n of [
      'password',
      'DB_PASS',
      'adminPwd',
      'authToken',
      'clientSecret',
      'apiKey',
      'SECRET_KEY',
      'privateKey',
      'flag',
    ])
      expect(nameClass(n), n).toBe('strong');
    for (const n of ['key', 'cacheKey', 'api']) expect(nameClass(n), n).toBe('weak');
    for (const n of ['passenger', 'compass', 'monkey', 'username', 'label', 'tokenizer']) {
      expect(nameClass(n), n).toBeNull();
    }
  });

  it('classifies values', () => {
    expect(valueClass('hunter2')).toBe('secret');
    expect(valueClass('Tr0ub4dor&3')).toBe('secret');
    expect(valueClass('Enter your password')).toBe('label');
    expect(valueClass('Password')).toBe('label');
    expect(valueClass('/api/token')).toBe('path');
    expect(valueClass('https://x.test/a')).toBe('path');
    for (const v of ['', 'ab', 'undefined', 'same-origin', '********', '${PASSWORD}', '<b>x</b>']) {
      expect(valueClass(v), v).toBe('empty');
    }
    expect(secretLike('abc')).toBe(false);
    expect(secretLike('default')).toBe(false);
    expect(secretLike('A1B2C3')).toBe(true);
    expect(secretLike('p@ssw0rd!')).toBe(true);
  });

  it('computes Shannon entropy in bits per character', () => {
    expect(shannon('')).toBe(0);
    expect(shannon('aaaa')).toBe(0);
    expect(shannon('abcd')).toBeCloseTo(2, 5);
    expect(shannon('abcdefgh')).toBeCloseTo(3, 5);
  });
});

describe('flags', () => {
  it('finds prefix{…} flags anywhere, with the site-wide pattern', () => {
    const f = scan('const a = 1;\nconst msg = "well done flag{js_is_open}";\n');
    expect(matches(f)).toEqual(['flag{js_is_open}']);
    expect(f[0]!.severity).toBe('high');
    expect(f[0]).toMatchObject({ line: 2, col: 24 });
    expect(matches(scan('// FTF{in_a_comment}'))).toEqual(['FTF{in_a_comment}']);
  });

  it('keeps a lookalike (a custom prefix) only when it is in a string or comment, and rare', () => {
    expect(matches(scan('const f = "RM{custom_one}";'))).toEqual(['RM{custom_one}']);
    // In code, `try{foo()}` and `a{b}` are not flags.
    expect(scan('function f(){try{foo()}catch(e){bar()}}')).toEqual([]);
    // Doc-comment tags are not flags either.
    expect(scan('/** @type{!Array<number>} */ var x;')).toEqual([]);
    // Many lookalikes: noise.
    const many = Array.from({ length: 6 }, (_, i) => `var s${i} = "ab${i}{value${i}}";`).join('\n');
    expect(find(scan(many), 'flag')).toBeUndefined();
  });

  it('does not take CSS for flags, and only known prefixes count in a dependency', () => {
    expect(scan('a{color:red}b{margin:0}', { lang: 'text', css: true })).toEqual([]);
    expect(matches(scan('flag{known} RM{custom}', { dependency: true }))).toEqual(['flag{known}']);
  });
});

describe('key formats', () => {
  it.each([
    ['aws', AWS, 'AWS access key ID'],
    ['github', GITHUB, 'GitHub token'],
    ['google', GOOGLE, 'Google API key'],
    ['stripe', STRIPE, 'Stripe live secret key'],
    ['slack', SLACK, 'Slack token'],
  ] as const)('%s', (kind, value, service) => {
    const f = scan(`const k = "${value}";`);
    const hit = find(f, kind);
    expect(hit, kind).toBeDefined();
    expect(hit!.match).toBe(value);
    expect(hit!.info.service).toBe(service);
    expect(hit!.severity).toBe('high');
  });

  it('knows GitHub fine-grained tokens and a Stripe test key (less severe)', () => {
    expect(
      find(scan(`x = "${'github_pat'}_${'A1b2C3d4E5f6G7h8I9j0K1_'}"`), 'github'),
    ).toBeDefined();
    const test = find(scan(`x = "${'sk_'}${'test_'}Xx9Yy8Zz7Ww6Vv5Uu4Tt3Ss2"`), 'stripe');
    expect(test?.severity).toBe('medium');
  });

  it('finds a PEM private key header and sizes the body', () => {
    const body = 'MIIEowIBAAKCAQEA'.repeat(8);
    const f = scan(`k = \`${PEM_HEADER}\n${body}\n${PEM_FOOTER}\``);
    const hit = find(f, 'pem');
    expect(hit?.info.service).toBe('RSA PRIVATE KEY');
    expect(Number(hit?.info.bytes)).toBeGreaterThan(100);
    // A certificate or a public key is not a private key.
    expect(find(scan(`${'-----BEGIN '}${'PUBLIC KEY-----'}\nMIIB\n`), 'pem')).toBeUndefined();
  });

  it('finds credentials in a URL, but not a placeholder', () => {
    const hit = find(scan('db = "postgres://admin:s3cr3t@db.internal.test/app";'), 'credentials');
    expect(hit?.info).toMatchObject({ name: 'admin', value: 's3cr3t' });
    expect(
      find(scan('db = "postgres://user:password@localhost/app";'), 'credentials'),
    ).toBeUndefined();
    expect(find(scan('u = "https://example.test/path";'), 'credentials')).toBeUndefined();
  });

  it('finds Bearer and Basic headers, decoding the latter', () => {
    const bearer = find(scan('h = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";'), 'bearer');
    expect(bearer?.info.service).toBe('Bearer');
    const basic = find(scan(`h = "Basic ${toBase64(utf8Encode('admin:hunter2'))}";`), 'bearer');
    expect(basic?.info).toMatchObject({ service: 'Basic', decoded: 'admin:hunter2' });
    expect(find(scan('h = "Basic ZGVmYXVsdA==";'), 'bearer')).toBeUndefined(); // "default": no user:pass
  });
});

describe('JSON Web Tokens', () => {
  it('finds a JWT and decodes its header and payload', () => {
    const token = jwt({ alg: 'HS256', typ: 'JWT' }, { sub: '42', role: 'admin' });
    const hit = find(scan(`const t = '${token}';`), 'jwt');
    expect(hit?.match).toBe(token);
    expect(hit?.info.header).toBe('{"alg":"HS256","typ":"JWT"}');
    expect(hit?.info.payload).toBe('{"sub":"42","role":"admin"}');
    expect(hit?.severity).toBe('high');
  });

  it('reads a token with an empty signature (alg none) and a payload that is not JSON', () => {
    const none = find(scan(`t = "${jwt({ alg: 'none' }, { u: 1 }, '')}";`), 'jwt');
    expect(none?.info.header).toBe('{"alg":"none"}');
    const odd = `${b64url('{"alg":"HS256"}')}.${b64url('plain words')}`.replace('.', '.eyJ');
    expect(scan(`t = "${odd}.sig";`).length).toBeGreaterThanOrEqual(0); // never throws
  });

  it('ignores something that only starts like one', () => {
    expect(find(scan('x = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9";'), 'jwt')).toBeUndefined(); // two parts
    expect(find(scan('x = "eyJnotjson.eyJnotjsoneither.sig";'), 'jwt')).toBeUndefined();
  });

  it('does not report the entropy of a token it already explains', () => {
    const f = scan(
      `const t = '${jwt({ alg: 'HS256', typ: 'JWT' }, { user: 'admin', role: 'owner' })}';`,
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.kinds).toEqual(['jwt']);
  });
});

describe('assignments', () => {
  const one = (text: string, doc: Partial<ScanDoc> = {}) =>
    scan(text, doc).filter((f) => f.kinds.includes('assign'));

  it('finds a secret-like name given a literal, in every common shape', () => {
    const shapes: [string, string][] = [
      ['const password = "hunter2";', 'password'],
      ["var adminPwd = 'p4ssw0rd!';", 'adminPwd'],
      ['config.dbPass = "s3cret-db";', 'dbPass'],
      ['const o = { token: "abc-123-xyz" };', 'token'],
      ['{"api_key": "k_9f8e7d6c"}', 'api_key'],
      ['const s = process.env.AUTH_TOKEN || "dev-token-77";', 'AUTH_TOKEN'],
      ['localStorage.setItem("auth", "ab12cd34");', 'auth'],
      ['const token: string = "typed-secret-1";', 'token'],
      ['this.clientSecret = "cs_live_demo";', 'clientSecret'],
    ];
    for (const [text, name] of shapes) {
      const f = one(text);
      expect(f, text).toHaveLength(1);
      expect(f[0]!.info.name, text).toBe(name);
      expect(f[0]!.severity, text).toBe('high');
    }
  });

  it('puts the match on the value, with line and column', () => {
    const f = one('// header\nconst password = "hunter2";\n');
    expect(f[0]).toMatchObject({ match: '"hunter2"', line: 2, col: 18 });
    expect(f[0]!.before).toBe('const password = ');
    expect(f[0]!.after).toBe(';');
  });

  it('reads escapes in the value', () => {
    expect(one('const password = "\\x68unter2";')[0]!.info.name).toBe('password');
  });

  it('keeps labels, paths and masks quiet or low', () => {
    expect(one('const passwordLabel = "Enter your password";')[0]!.severity).toBe('low');
    expect(one('const tokenUrl = "/api/auth/token";')[0]!.severity).toBe('low');
    for (const t of [
      'const password = "";',
      'const password = "********";',
      'const password = "password";',
      'const token = "${TOKEN}";',
      'const token = `${make()}`;',
      "fetch(u, { credentials: 'same-origin' });",
      'const isToken = "true";',
      'const names = ["flag", "token"];',
      'const monkey = "banana7";',
    ]) {
      expect(one(t), t).toEqual([]);
    }
  });

  it('lets a bare key or api count only when the value looks generated', () => {
    expect(one('const key = "main";')).toEqual([]);
    expect(one('const cacheKey = "iterationTypes";')).toEqual([]);
    const generated = one('const apiKeyId = "x7Fq92LmZ0aB";');
    expect(generated).toHaveLength(1);
    expect(generated[0]!.severity).toBe('high'); // apiKeyId has the qualifier api + key
    expect(one('const key = "q7Fq92LmZ0";')[0]!.severity).toBe('medium');
  });

  it('finds a number kept under a password-like name', () => {
    const f = one('const pin = 424242; var passcode = 8675309; var token = 12345678;');
    expect(f.map((x) => [x.info.name, x.match])).toEqual([
      ['pin', '424242'],
      ['passcode', '8675309'],
    ]);
  });

  it('reads `secret: VALUE` in a comment and `PASSWORD=value` in a plain file', () => {
    const c = one('// secret: TEST_FLAG_123\n');
    expect(c[0]).toMatchObject({ match: 'TEST_FLAG_123', line: 1, col: 12 });
    expect(c[0]!.info).toMatchObject({ name: 'secret', via: 'comment' });
    expect(one('/* admin password = Sup3rSecret */')[0]!.match).toBe('Sup3rSecret');
    const env = one('# config\nDB_PASSWORD=hunter22\nDEBUG=true\nexport API_TOKEN="abc-9987"\n', {
      lang: 'text',
    });
    expect(env.map((x) => [x.info.name, x.match])).toEqual([
      ['DB_PASSWORD', 'hunter22'],
      ['API_TOKEN', 'abc-9987'],
    ]);
    expect(env[0]!.info.via).toBe('line');
  });
});

describe('comparisons with a literal', () => {
  const cmp = (text: string) => scan(text).filter((f) => f.kinds.includes('compare'));

  it('finds a password check, whichever side the literal is on', () => {
    for (const text of [
      'if (password === "letmein") go();',
      'if ("letmein" == password) go();',
      'if (input.pass != "letmein") fail();',
      "if (document.getElementById('pw').value === 'letmein') go();",
      'if ($("#password").val() == "letmein") go();',
      'return secret !== "letmein";',
    ]) {
      const f = cmp(text);
      expect(f, text).toHaveLength(1);
      expect(f[0]!.match.replace(/["']/g, ''), text).toBe('letmein');
      expect(f[0]!.severity, text).toBe('high');
    }
  });

  it('shows what it was compared with, and the operator', () => {
    const f = cmp('if (user.password === "s3cret") ok();');
    expect(f[0]!.info).toMatchObject({ name: 'user.password', op: '===' });
  });

  it('notes the hash family when the literal is a hex digest', () => {
    const f = cmp('if (md5(password) == "5f4dcc3b5aa765d61d8327deb882cf99") ok();');
    expect(f[0]!.info.hash).toBe('MD5 / NTLM');
  });

  it('needs a secret-like value next to weaker names', () => {
    expect(cmp('if (code === "A1B2C3") ok();')).toHaveLength(1);
    expect(cmp('if (code === "default") ok();')).toEqual([]);
    expect(cmp('if (e.key === "Enter") ok();')).toEqual([]);
    expect(cmp('if (user.role === "administrator") ok();')).toEqual([]);
  });

  it('leaves typeof checks, trivial values and ordinary comparisons alone', () => {
    for (const t of [
      'if (typeof password === "string") x();',
      'if (token === undefined) x();',
      'if (type === "button") x();',
      'if (password === "") x();',
      'const same = a === "letmein";',
      'if (name == "abcdef") x();',
    ]) {
      expect(cmp(t), t).toEqual([]);
    }
  });
});

describe('strings written as escapes, and char codes', () => {
  it('decodes a string hidden as \\x escapes, and a flag inside it', () => {
    const hex = [...'flag{esc_aped}'].map((c) => `\\x${c.charCodeAt(0).toString(16)}`).join('');
    const f = scan(`var s = "${hex}";`);
    expect(f).toHaveLength(1);
    expect(f[0]!.kinds).toEqual(expect.arrayContaining(['flag', 'escaped']));
    expect(f[0]!.info.decoded).toBe('flag{esc_aped}');
    expect(f[0]!.severity).toBe('high');
  });

  it('does not call an ordinary string with a newline escape obfuscated', () => {
    expect(scan('var s = "line one\\nline two\\ttabbed\\\\";')).toEqual([]);
    expect(scan('var re = "\\\\{\\\\/\\\\*";')).toEqual([]);
  });

  it('decodes String.fromCharCode calls and ignores non-text', () => {
    const f = scan('var s = String.fromCharCode(112, 97, 115, 115, 119, 111, 114, 100);');
    expect(f[0]!.kinds[0]).toBe('charcode');
    expect(f[0]!.info.decoded).toBe('password');
    expect(f[0]!.severity).toBe('high');
    const flag = scan('var s = String.fromCharCode(...[70, 84, 70, 123, 120, 121, 125]);');
    expect(flag[0]!.kinds).toEqual(expect.arrayContaining(['charcode', 'flag']));
    expect(scan('var s = String.fromCharCode(1, 2, 3, 4, 5);')).toEqual([]);
    expect(scan('var s = String.fromCharCode(x, y, z, w);')).toEqual([]);
  });
});

describe('base64 and hex blobs', () => {
  it('decodes printable base64, and reports a flag inside it', () => {
    const f = scan(`const hint = atob('${toBase64(utf8Encode('the door code is 4242'))}');`);
    expect(f[0]!.kinds).toEqual(['blob']);
    expect(f[0]!.info).toMatchObject({ via: 'base64', decoded: 'the door code is 4242' });
    const flag = scan(`x = "${toBase64(utf8Encode('FTF{b64_in_js}'))}";`);
    expect(flag[0]!.kinds).toEqual(expect.arrayContaining(['flag', 'blob']));
    expect(flag[0]!.severity).toBe('high');
  });

  it('decodes printable hex', () => {
    const hex = [...'hello world, hex'].map((c) => c.charCodeAt(0).toString(16)).join('');
    const f = scan(`var h = "${hex}";`);
    expect(f[0]!.info).toMatchObject({ via: 'hex', decoded: 'hello world, hex' });
  });

  it('names the file type of a base64 image or archive', () => {
    const png = new Uint8Array(80).fill(0x41);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const f = scan(`var img = "${toBase64(png)}";`);
    expect(f[0]!.kinds[0]).toBe('blob');
    expect(f[0]!.info.fileType).toMatch(/PNG/i);
    expect(f[0]!.severity).toBe('low');
  });

  it('ignores identifiers, short strings and numbers', () => {
    expect(
      scan('var a = "getOwnPropertyDescriptors"; var b = "SGVsbG8="; var c = "1234567890123456";'),
    ).toEqual([]);
  });

  it('does not call base64 of binary noise a blob (it may still be a random-looking string)', () => {
    const noise = toBase64(Uint8Array.from({ length: 24 }, (_, i) => 0x80 + i));
    const f = scan(`var n = "${noise}";`);
    expect(find(f, 'blob')).toBeUndefined();
    expect(f.every((x) => x.kinds[0] === 'entropy')).toBe(true);
  });
});

describe('high-entropy strings', () => {
  const random = 'q8Zr2LmX9aB4cD7eF1gH5jK3nP6sT0vW'; // 32 mixed characters

  it('finds a long random-looking string', () => {
    const f = scan(`var blob = "${random}";`);
    const hit = find(f, 'entropy');
    expect(hit).toBeDefined();
    expect(Number(hit!.info.entropy)).toBeGreaterThanOrEqual(4);
    expect(hit!.severity).toBe('medium');
  });

  it('honours the thresholds: 20 characters and 4 bits', () => {
    expect(find(scan(`x = "${random.slice(0, 19)}";`), 'entropy')).toBeUndefined();
    expect(find(scan(`x = "${random.slice(0, 20)}";`), 'entropy')).toBeDefined();
    expect(find(scan(`x = "${'aB3'.repeat(11)}";`), 'entropy')).toBeUndefined(); // repetitive: low entropy
  });

  it('skips what is long but not random', () => {
    for (const s of [
      'An_element_access_expression_should_take_an_argument_1011',
      '_0_modifier_cannot_appear_on_class_elements_of_this_kind_1031',
      'this.props.someVeryLongPropertyName',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
      'https://cdn.example.test/lib/v1.2.3/bundle.min.js',
      '/static/js/chunks/vendors~main.4f2a9c1b.chunk.js',
      'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC',
      'the quick brown fox jumps over 13 lazy dogs',
      'createDocumentFragmentFromString',
      `${random}${random}${random}${random}${random}`, // over 128: data, not a key
    ]) {
      expect(find(scan(`var s = "${s}";`), 'entropy'), s).toBeUndefined();
    }
    expect(find(scan('var s = `${a}-${b}-${c}-${d}-${e}-${f}`;'), 'entropy')).toBeUndefined();
  });

  it('reads plain text and HTML token by token', () => {
    const f = scan(`<p>token ${random} end</p>`, { lang: 'text' });
    expect(find(f, 'entropy')?.match).toBe(random);
  });
});

describe('keywords in comments', () => {
  const kw = (text: string, doc: Partial<ScanDoc> = {}) =>
    scan(text, doc).filter((f) => f.kinds.includes('keyword'));

  it('flags a comment that mentions a password, a secret, a token or an API key', () => {
    for (const text of [
      '// the password is checked on the server',
      '/* secret handshake */',
      '// TODO remove the token',
      '// uses the API key from the environment',
      '// the secret_key rotates',
    ]) {
      const f = kw(text);
      expect(f, text).toHaveLength(1);
      expect(f[0]!.severity).toBe('low');
    }
  });

  it('gives the bare words pass, key and api only a weak hint, in comments', () => {
    for (const [text, word] of [
      ['// you can pass several arguments', 'pass'],
      ['// press any key to continue', 'key'],
      ['// the api endpoint', 'api'],
    ] as const) {
      const f = kw(text);
      expect(f, text).toHaveLength(1);
      expect(f[0]!.severity).toBe('low');
      expect(f[0]!.match).toBe(word);
    }
  });

  it('does not take longer words, or a mention in code, for a keyword', () => {
    for (const text of [
      '// keyboard shortcuts for the passenger list',
      '// a compass and an apiary',
      'const password_hint_shown = true;',
    ]) {
      expect(kw(text), text).toEqual([]);
    }
  });

  it('is not repeated for a line that has a better finding', () => {
    const f = scan('// password: letmein99');
    expect(f).toHaveLength(1);
    expect(f[0]!.kinds).toEqual(['assign']);
  });

  it('is capped, so prose cannot fill the list', () => {
    const prose = Array.from({ length: 200 }, (_, i) => `// the password rule number ${i}`).join(
      '\n',
    );
    expect(kw(prose).length).toBeLessThanOrEqual(40);
  });

  it('caps the weak words much lower, and leaves room for the real keywords', () => {
    const weak = Array.from({ length: 100 }, (_, i) => `// pass the value ${i}`).join('\n');
    expect(kw(weak)).toHaveLength(12);
    const mixed = `${weak}\n// the password is checked on the server`;
    expect(kw(mixed).some((f) => f.match === 'password')).toBe(true);
  });
});

describe('how findings are merged and ranked', () => {
  it('merges overlapping hits into one row that lists every reason', () => {
    const f = scan(`const password = "flag{in_a_password}";`);
    expect(f).toHaveLength(1);
    expect(f[0]!.kinds).toEqual(['flag', 'assign']);
    expect(f[0]!.info.name).toBe('password');
  });

  it('ranks high before medium before low, then by position', () => {
    const f = scan(
      [
        '// the password is long',
        `const t = "${toBase64(utf8Encode('printable base64 text'))}";`,
        'const secret = "hunter22";',
      ].join('\n'),
    );
    expect(f.map((x) => x.severity)).toEqual(['high', 'medium', 'low']);
    expect(f.map((x) => x.line)).toEqual([3, 2, 1]);
  });

  it('numbers lines and columns from the start of the document', () => {
    const f = scan('a\nb\n  password = "zz9988";');
    expect(f[0]).toMatchObject({ line: 3, col: 14 });
  });

  it('cuts a very long match, and shows only the header of a key block', () => {
    const codes = Array.from({ length: 80 }, (_, i) => 97 + (i % 26)).join(', ');
    const f = scan(`var s = String.fromCharCode(${codes}); var t = 1;`);
    expect(f[0]!.match.endsWith('…')).toBe(true);
    expect(f[0]!.match.length).toBeLessThanOrEqual(161);
    expect(f[0]!.after).toBe('');
    const pem = scan(`${PEM_HEADER}\n${'A'.repeat(500)}\n${PEM_FOOTER}`);
    expect(pem[0]!.match).toBe(PEM_HEADER);
  });

  it('does not report a random-looking string over 128 characters as a key', () => {
    expect(
      find(scan(`x = "${'q8Zr2LmX9aB4cD7eF1gH5jK3nP6sT0vW'.repeat(5)}";`), 'entropy'),
    ).toBeUndefined();
  });
});

describe('dependencies and limits', () => {
  const code =
    'const password = "hunter22"; // the password is stored\nconst k = "flag{dep_flag}";';

  it('give only the strong checks unless asked', () => {
    const dep = scan(code, { dependency: true });
    expect(matches(dep)).toEqual(['flag{dep_flag}']);
    const all = scan(code, { dependency: true }, true);
    expect(all.some((f) => f.kinds.includes('assign'))).toBe(true);
  });

  it('keep a key format even in a dependency', () => {
    expect(find(scan(`var k = "${AWS}";`, { dependency: true }), 'aws')).toBeDefined();
  });

  it('are listed after the cap with a count of what was left out', () => {
    const strings = Array.from(
      { length: 40 },
      (_, i) =>
        `var s${i} = "${'q8Zr2LmX9aB4cD7eF1gH5jK3nP6sT0vW'.split('').reverse().join('')}${i}${i}";`,
    );
    const result = scanDocs(
      [{ name: 'data.js', text: strings.join('\n'), dependency: false, lang: 'js' }],
      { deps: false },
    );
    const entropy = result.findings.filter((f) => f.kinds[0] === 'entropy');
    expect(entropy).toHaveLength(12);
    expect(result.trimmed).toBe(28);
  });

  it('read only the start of a huge file', () => {
    const big = `${'var a = 1;\n'.repeat(900_000)}var password = "late-secret-1";`;
    const result = scanDocs([{ name: null, text: big, dependency: false, lang: 'js' }], {
      deps: false,
    });
    expect(result.cut).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('stay fast on a few megabytes of code', () => {
    const line = 'function f(a,b){return a===b?"x"+a:b.toString(16)}var s="plain string";\n';
    const text = `${line.repeat(40_000)}var password = "found-me-77";`;
    const t0 = performance.now();
    const f = scan(text);
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(f.map((x) => x.match)).toEqual(['"found-me-77"']);
  });
});

describe('HTML documents', () => {
  const page = [
    '<!doctype html><html><head><style>a{color:red}</style></head><body>',
    '<!-- TODO: remove FTF{in_a_comment} -->',
    '<!-- admin password: hunter22 -->',
    '<form><input type="hidden" name="csrf" value="9f8e7d6c5b4a3f2e">',
    '<input type="hidden" name="session_token" value="demo-token-8841">',
    '<input type="password" name="pass" placeholder="Password"></form>',
    '<div data-api-key="K-1234-ABCD" data-theme="dark"></div>',
    '<meta name="secret" content="meta-secret-1">',
    '<button onclick="if (pw.value === \'tapped-1\') go()">go</button>',
    '<script>var adminPassword = "inline-pw-9";</script>',
    '</body></html>',
  ].join('\n');

  const scanPage = (html: string) =>
    scanDocs(
      [{ name: null, text: html, dependency: false, lang: 'html', html: regions(parseHtml(html)) }],
      {
        deps: false,
      },
    ).findings;

  it('reads comments, hidden fields, data attributes, meta tags, handlers and inline scripts', () => {
    const f = scanPage(page);
    const found = new Map(f.map((x) => [x.match.replace(/["']/g, ''), x.kinds[0]]));
    expect(found.get('FTF{in_a_comment}')).toBe('flag');
    expect(found.get('hunter22')).toBe('assign');
    expect(found.get('demo-token-8841')).toBe('assign');
    expect(found.get('9f8e7d6c5b4a3f2e')).toBe('hidden');
    expect(found.get('K-1234-ABCD')).toBe('assign');
    expect(found.get('meta-secret-1')).toBe('assign');
    expect(found.get('tapped-1')).toBe('compare');
    expect(found.get('inline-pw-9')).toBe('assign');
    // Not a finding: a style rule, an ordinary data attribute, an empty field.
    expect([...found.keys()].join(' ')).not.toMatch(/color|dark/);
  });

  it('positions refer to the whole page, scripts included', () => {
    const f = scanPage(page);
    const inline = f.find((x) => x.match === '"inline-pw-9"')!;
    expect(inline.line).toBe(10);
    expect(page.split('\n')[inline.line - 1]!.slice(inline.col - 1, inline.col + 10)).toBe(
      '"inline-pw-',
    );
  });
});
