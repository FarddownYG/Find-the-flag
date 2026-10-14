import { md5, md4, sha1, sha256, sha512 } from 'hash-wasm';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { utf8Encode } from '../../lib/bytes';
import { FORMATS, ciscoType7, confidenceLabel, identify } from './_hash-formats';
import tool from './hash-identify';

const run = async (input: string): Promise<Output[]> => tool.run(input, {});
const names = (input: string) => identify(input).candidates.map((c) => c.name);
const top = (input: string) => identify(input).candidates[0];

describe('hash database', () => {
  it('knows at least 45 formats with unique names', () => {
    expect(FORMATS.length).toBeGreaterThanOrEqual(45);
    const all = FORMATS.map((f) => f.name);
    expect(new Set(all).size).toBe(all.length);
  });

  it('uses only well-formed hashcat / John values', () => {
    for (const f of FORMATS) {
      if (f.hc) expect(f.hc, f.name).toMatch(/^\d{1,5}\b/);
      expect(f.w, f.name).toBeGreaterThan(0);
      expect(f.w, f.name).toBeLessThanOrEqual(99);
    }
  });
});

describe('plain hex digests', () => {
  it('ranks 32 hex as MD5, then NTLM, MD4, LM', () => {
    const list = names('5f4dcc3b5aa765d61d8327deb882cf99');
    expect(list.slice(0, 4)).toEqual(['MD5', 'NTLM', 'MD4', 'LM']);
    const md5Row = top('5f4dcc3b5aa765d61d8327deb882cf99')!;
    expect(md5Row.hashcat).toBe('0');
    expect(md5Row.john).toBe('raw-md5');
  });

  it('prefers NTLM / LM for capitalised 32 hex', () => {
    expect(top('8846F7EAEE8FB117AD06BDD830B7586C')!.name).toBe('NTLM');
  });

  it('recognises the empty LM hash', () => {
    const t = identify('AAD3B435B51404EEAAD3B435B51404EE');
    expect(t.candidates[0]!.name).toBe('LM');
    expect(t.known).toMatch(/LM of the empty password/);
  });

  it.each([
    ['da39a3ee5e6b4b0d3255bfef95601890afd80709', 'SHA-1', '100'],
    ['d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f', 'SHA-224', '1300'],
    ['5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', 'SHA-256', '1400'],
    [
      '38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b',
      'SHA-384',
      '10800',
    ],
    [
      'b109f3bbbc244eb82441917ed06d618b9008dd09b3befd1b5e07394c706a8bb980b1d7785e5976ec049b46df5f1326af5a2ea6d103fd07c95385ffab0cacbc86',
      'SHA-512',
      '1700',
    ],
    ['cbf43926', 'CRC-32', '11500'],
  ])('%s is %s', (hash, name, mode) => {
    const best = top(hash)!;
    expect(best.name).toBe(name);
    expect(best.hashcat).toBe(mode);
  });

  it('lists the SHA-3 and Keccak siblings for a 64 hex digest', () => {
    const list = names('a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
    expect(list[0]).toBe('SHA-256');
    expect(list).toContain('SHA3-256');
    expect(list).toContain('Keccak-256');
    expect(list.indexOf('SHA3-256')).toBeLessThan(list.indexOf('Keccak-256'));
  });

  it('tells SHA-512 from Whirlpool, SHA3-512 and BLAKE2b', () => {
    const list = names('0'.repeat(128));
    expect(list.slice(0, 2)).toEqual(['SHA-512', 'Whirlpool']);
    for (const n of ['SHA3-512', 'Keccak-512', 'BLAKE2b-512']) expect(list).toContain(n);
  });

  it('ignores the case of hex digits', () => {
    expect(top('DA39A3EE5E6B4B0D3255BFEF95601890AFD80709')!.name).toBe('SHA-1');
  });

  it('has no candidate for lengths no hash uses', () => {
    expect(identify('abc123def4567').candidates.map((c) => c.name)).not.toContain('MD5');
    expect(identify('0123456789abcdef0123456789abcdef0').candidates).toHaveLength(0);
  });
});

describe('prefixed and structured formats', () => {
  const cases: [string, string, string][] = [
    ['$2a$05$LhayLxezLhK1LhWvKxCyLOj0j1u.Kj0jZ0pEmm134uzrQlFvQJLF6', 'bcrypt', '3200'],
    ['$2y$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'bcrypt', '3200'],
    ['$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW', 'bcrypt', '3200'],
    ['$1$28772684$iEwNOgGugqO9.bIz5sk8k/', 'md5crypt ($1$) · Cisco IOS type 5', '500'],
    ['$apr1$71850310$gh9m4xcAn3MGxogwX/ztb.', 'Apache apr1 (md5)', '1600'],
    [
      '$5$rounds=5000$GX7BopJZJxPc/KEK$le16UF8I2Anb.rOrn22AUPWvzUETDGefUmAV8AZkGcD',
      'sha256crypt ($5$)',
      '7400',
    ],
    [
      '$6$52450745$k5ka2p8bFuSmoVT1tzOyyuaREkkKBcCNqoDKzYiJL9RaE8yMnPgh2XzzF0NDrUhgrcLwg78xs1w5pJiypEdFX/',
      'sha512crypt ($6$)',
      '1800',
    ],
    ['$P$984478476IagS59wHZvyQMArzfx58u.', 'phpass (WordPress / Joomla >= 2.5)', '400'],
    ['$H$984478476IagS59wHZvyQMArzfx58u.', 'phpass (phpBB3 / generic)', '400'],
    ['$S$C33783772bRXEx1aCsvY.dqgaaSu76XmVlKrW9Qu8IQlvxHlmzLf', 'Drupal 7 ($S$)', '7900'],
    [
      '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObGv6sc3XDe8gg',
      'Argon2 (i / d / id)',
      '34000',
    ],
    [
      '$y$j9T$F5Jx5fExrKuPp53xLKQ..1$X3DX6M94c7o.9agCG9G317fhZg9SqC.5i5rd.RhAtQ7',
      'yescrypt ($y$)',
      '',
    ],
    [
      'pbkdf2_sha256$10000$KOQ3sAQiJnS5$Zd2L8Ip0fJ2PQmw4MgBhfFMWK3TZoDvU8SDgjyzYp3k=',
      'Django PBKDF2-SHA256',
      '10000',
    ],
    ['*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19', 'MySQL 4.1+ (MySQL5)', '300'],
    ['606717496665bcba', 'MySQL323 (old_password)', '200'],
    ['{SHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=', 'LDAP {SHA} (SHA-1, Base64)', '101'],
    ['{SSHA}Ro3tVyKQ2gPjaS7oLBrqhkBMT2VzYWx0', 'LDAP {SSHA} (salted SHA-1)', '111'],
    ['0x01004086CEB6BF932BC4151A1AF1F13CD17301D70816A8886908', 'MSSQL 2005', '132'],
    ['S:8F2D65FB5547B71C8DA3760F10960428CD307B1C6271691FC55C1F56554A', 'Oracle 11g (S:)', '112'],
    [
      '$DCC2$10240#tom#e4e938d12fe5974dc42a90120bd9c90f',
      'Domain Cached Credentials 2 (MS Cache v2)',
      '2100',
    ],
    ['md5a6343a68d964ca596d9752250d54bb8a', 'PostgreSQL md5', '12'],
    [
      '$8$TnGX/fE4KGHOVU$pEhnEvxrvaynpi8j4f.EMHr6M.FzU8xnZnBr/tJdFWk',
      'Cisco type 8 (PBKDF2-SHA256)',
      '9200',
    ],
    [
      '$9$2MJBozw/9R3UsU$2lFhcKvpghcyw8deP25GOfyZaagyUOGBymkryvOdfo6',
      'Cisco type 9 (scrypt)',
      '9300',
    ],
    ['_J9..K0AyUubDrfOgO4s', 'BSDi extended DES crypt (_)', '12400'],
    ['rVRHEOw9s0nsQ', 'descrypt (traditional DES crypt)', '1500'],
  ];

  it.each(cases)('%s', (hash, name, mode) => {
    const best = top(hash);
    expect(best?.name).toBe(name);
    expect(best?.hashcat).toBe(mode);
    expect(best!.confidence).toBeGreaterThanOrEqual(55);
  });

  it('identifies challenge / response captures', () => {
    const v1 =
      'u4-netntlm::kNS:338d08f8e26de93300000000000000000000000000000000:9526fb8c23a90751cdd619b6cea564742e1e4bf33006ba41:cb8086049ec4736c';
    expect(top(v1)).toMatchObject({ name: 'NetNTLMv1 (challenge / response)', hashcat: '5500' });
    const v2 =
      'admin::N46iSNekpT:08ca45b7d7ea58ee:88dcbe4446168966a153a0064958dac6:5c7830315c7830310000000000000b45c67103d07d7b95acd12ffa11230e0000000052920b85f78d013c31cdb3b92f5d765c783030';
    expect(top(v2)).toMatchObject({ name: 'NetNTLMv2 (challenge / response)', hashcat: '5600' });
  });

  it('identifies every Kerberos flavour', () => {
    const modes: [string, string][] = [
      ['$krb5tgs$23$*user$realm$test/spn*$63386d22$891ad31d', '13100'],
      ['$krb5tgs$17$user$realm$aabbcc$ddeeff', '19600'],
      ['$krb5tgs$18$user$realm$aabbcc$ddeeff', '19700'],
      ['$krb5asrep$23$user@REALM:aabbcc$ddeeff', '18200'],
      ['$krb5pa$23$user$REALM$salt$aabbcc', '7500'],
      ['$krb5pa$18$user$REALM$aabbcc', '19900'],
    ];
    for (const [hash, mode] of modes) expect(top(hash)?.hashcat, hash).toBe(mode);
    expect(top('$krb5tgs$23$*u$r$s*$aa$bb')!.john).toBe('krb5tgs');
  });

  it('identifies a Windows dump line', () => {
    const t = identify(
      'Administrator:500:aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb117ad06bdd830b7586c:::',
    );
    expect(t.candidates[0]!.name).toMatch(/pwdump/);
    expect(t.candidates[0]!.hashcat).toContain('1000');
  });

  it('treats an LM:NT pair as NTLM material', () => {
    const t = identify('aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb117ad06bdd830b7586c');
    expect(names(t.hash)).toContain('LM:NT pair (pwdump / secretsdump)');
  });

  it('flags JWTs and points to the JWT tool', async () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(top(jwt)).toMatchObject({ name: 'JSON Web Token (JWT)', hashcat: '16500' });
    expect(resultToText(await run(jwt))).toContain('JWT tool');
  });

  it('recognises hashes extracted from files', () => {
    expect(top('$zip2$*0*1*0*abcd*1234*5*aa*bb*$/zip2$')!.hashcat).toBe('13600');
    expect(top('$rar5$16$aabbcc$15$ddee$8$ff')!.name).toBe('RAR5 archive');
    expect(top('$keepass$*2*60000*0*aa*bb')!.hashcat).toBe('13400');
    expect(top('$office$*2013*100000*256*16*aa*bb*cc')!.john).toBe('office');
    expect(top('$7z$0$19$0$$8$aa$1$2$3$4')!.hashcat).toBe('11600');
  });

  it('flags Base64-wrapped digests and shows the hex', () => {
    const md5b64 = Buffer.from('5f4dcc3b5aa765d61d8327deb882cf99', 'hex').toString('base64');
    const m = identify(md5b64).candidates[0]!;
    expect(m.name).toBe('Base64 of an MD5 / MD4 / NTLM digest');
    expect(m.note).toBe('decodes to hex 5f4dcc3b5aa765d61d8327deb882cf99');
    const sha1b64 = Buffer.from('5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8', 'hex').toString(
      'base64',
    );
    expect(top(sha1b64)!.name).toBe('Base64 of a SHA-1 digest');
    const sha256b64 = Buffer.from(
      '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
      'hex',
    ).toString('base64');
    expect(top(sha256b64)!.name).toBe('Base64 of a SHA-256 digest');
    const sha512b64 = Buffer.from('ab'.repeat(64), 'hex').toString('base64');
    expect(top(sha512b64)!.name).toBe('Base64 of a SHA-512 digest');
  });
});

describe('salted and wrapped input', () => {
  it('suggests salted constructions for hash:salt', () => {
    const list = names('5f4dcc3b5aa765d61d8327deb882cf99:s4lt');
    expect(list[0]).toBe('md5($pass.$salt) · Joomla < 2.5.18');
    expect(list).toContain('md5($salt.$pass)');
    expect(list).toContain('HMAC-MD5 (key = $pass)');
    expect(names(`${'a'.repeat(40)}:salt`)[0]).toBe('sha1($pass.$salt)');
    expect(names(`${'a'.repeat(64)}:salt`)[0]).toBe('sha256($pass.$salt)');
    expect(names(`${'a'.repeat(128)}:salt`)[0]).toBe('sha512($pass.$salt)');
  });

  it('reads /etc/shadow lines', () => {
    const line =
      'root:$6$52450745$k5ka2p8bFuSmoVT1tzOyyuaREkkKBcCNqoDKzYiJL9RaE8yMnPgh2XzzF0NDrUhgrcLwg78xs1w5pJiypEdFX/:19000:0:99999:7:::';
    const t = identify(line);
    expect(t.candidates[0]!.name).toBe('sha512crypt ($6$)');
    expect(t.hash.startsWith('$6$')).toBe(true);
    expect(t.context.join()).toContain('user "root"');
  });

  it('explains locked shadow accounts', () => {
    const t = identify('daemon:*:19000:0:99999:7:::');
    expect(t.candidates).toHaveLength(0);
    expect(t.context.join()).toMatch(/no password hash/);
    const locked = identify(
      'bob:!$6$52450745$k5ka2p8bFuSmoVT1tzOyyuaREkkKBcCNqoDKzYiJL9RaE8yMnPgh2XzzF0NDrUhgrcLwg78xs1w5pJiypEdFX/:19000:0:99999:7:::',
    );
    expect(locked.candidates[0]!.name).toBe('sha512crypt ($6$)');
    expect(locked.context.join()).toMatch(/locked/);
  });

  it('strips a user: prefix or suffix', () => {
    const a = identify('admin:5f4dcc3b5aa765d61d8327deb882cf99');
    expect(a.hash).toBe('5f4dcc3b5aa765d61d8327deb882cf99');
    expect(a.candidates[0]!.name).toBe('MD5');
    expect(a.context.join()).toContain('admin');
    const b = identify('$2a$05$LhayLxezLhK1LhWvKxCyLOj0j1u.Kj0jZ0pEmm134uzrQlFvQJLF6:bob');
    expect(b.candidates[0]!.name).toBe('bcrypt');
  });

  it('recognises famous digests, checked against real computation', async () => {
    const enc = utf8Encode;
    const cases: [string, string][] = [
      [await md5(enc('')), 'MD5 of the empty string'],
      [await sha1(enc('')), 'SHA-1 of the empty string'],
      [await sha256(enc('')), 'SHA-256 of the empty string'],
      [await sha512(enc('')), 'SHA-512 of the empty string'],
      [await md5(enc('password')), 'MD5 of "password"'],
      [await sha1(enc('password')), 'SHA-1 of "password"'],
      [await sha256(enc('password')), 'SHA-256 of "password"'],
      [await md5(enc('123456')), 'MD5 of "123456"'],
      [await md5(enc('admin')), 'MD5 of "admin"'],
      [await md4(new Uint8Array(0)), 'NTLM of the empty password'],
      [await md4(new Uint8Array(Buffer.from('password', 'utf16le'))), 'NTLM of "password"'],
    ];
    for (const [hash, known] of cases) expect(identify(hash).known, hash).toBe(known);
  });
});

describe('Cisco type 7', () => {
  it('decodes the classic example', () => {
    expect(ciscoType7('02050D480809')).toBe('cisco');
    expect(ciscoType7('070C285F4D06')).toBe('cisco');
    expect(ciscoType7('zz')).toBeNull();
    expect(ciscoType7('9900')).toBeNull();
  });

  it('shows the password in the notes', () => {
    const best = top('02050D480809')!;
    expect(best.name).toBe('Cisco type 7 (reversible)');
    expect(best.note).toBe('Not a hash: decodes to "cisco"');
  });

  it('does not mistake ordinary digests for type 7', () => {
    expect(top('0cc175b9c0f1b6a831c399e269772661')!.name).toBe('MD5');
  });
});

describe('confidence labels', () => {
  it('maps numbers to words', () => {
    expect(confidenceLabel(99)).toBe('Certain');
    expect(confidenceLabel(85)).toBe('Very likely');
    expect(confidenceLabel(60)).toBe('Likely');
    expect(confidenceLabel(35)).toBe('Possible');
    expect(confidenceLabel(5)).toBe('Unlikely');
  });
});

describe('hash-identify tool', () => {
  it('prints one table per line with the expected columns', async () => {
    const out = await run(
      '5f4dcc3b5aa765d61d8327deb882cf99\nda39a3ee5e6b4b0d3255bfef95601890afd80709',
    );
    const tables = out.filter((o) => o.type === 'table');
    expect(tables).toHaveLength(2);
    const first = tables[0]!;
    expect(first.type === 'table' && first.columns.slice(0, 4)).toEqual([
      'Candidate',
      'Hashcat -m',
      'John format',
      'Confidence',
    ]);
    expect(first.type === 'table' && first.rows[0]![0]).toBe('MD5');
    expect(first.type === 'table' && first.highlight).toEqual([0]);
    expect(resultToText(out)).toContain('Line 2');
  });

  it('skips blank lines and CRLF', async () => {
    const out = await run('\r\n5f4dcc3b5aa765d61d8327deb882cf99\r\n\r\n');
    expect(out.filter((o) => o.type === 'table')).toHaveLength(1);
  });

  it('warns on strings that are not hashes', async () => {
    const out = await run('hello world, this is not a hash');
    expect(out[0]).toMatchObject({ type: 'note', level: 'warn' });
    expect(resultToText(out)).toMatch(/no known hash format/);
  });

  it('shows a locked account instead of a table', async () => {
    expect(resultToText(await run('daemon:*:19000:0:99999:7:::'))).toMatch(/no password hash/);
  });

  it('switches to a summary table for long lists', async () => {
    const many = Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(32, 'a')).join('\n');
    const out = await run(many);
    const table = out.find((o) => o.type === 'table');
    expect(table?.type === 'table' && table.rows).toHaveLength(40);
    expect(table?.type === 'table' && table.columns).toContain('Best guess');
  });

  it('rejects empty input', async () => {
    await expect(run('')).rejects.toBeInstanceOf(ToolError);
    await expect(run('  \n \n')).rejects.toBeInstanceOf(ToolError);
  });

  describe('detect', () => {
    const detect = (text: string | null) => tool.detect!({ text, bytes: new Uint8Array() });

    it('is confident about hex digests and crypt strings', () => {
      expect(detect('5f4dcc3b5aa765d61d8327deb882cf99')!.score).toBeGreaterThan(0.8);
      expect(
        detect('$2a$05$LhayLxezLhK1LhWvKxCyLOj0j1u.Kj0jZ0pEmm134uzrQlFvQJLF6')!.score,
      ).toBeGreaterThan(0.9);
    });

    it('stays quiet for prose, short strings and tokens', () => {
      expect(detect('hello world')).toBeNull();
      expect(detect('deadbeef')).toBeNull();
      expect(detect(null)).toBeNull();
      expect(detect('eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.c2ln'.padEnd(40, 'x'))).toBeNull();
    });
  });
});
