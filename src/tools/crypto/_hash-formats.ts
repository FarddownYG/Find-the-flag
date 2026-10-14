import { fromBase64, toHex } from '../../lib/bytes';

/**
 * Hash-format database for the identifier. Each format is a regex over one hash string plus a
 * plausibility weight (0-100) used to order candidates that share the same shape. Hashcat modes and
 * John the Ripper format names are only filled in when they are known to be right: an empty value
 * means "no direct support, convert the hash first" and is shown as a dash.
 */
export interface Candidate {
  name: string;
  /** hashcat -m value(s), or '' */
  hashcat: string;
  /** John the Ripper --format value(s), or '' */
  john: string;
  /** 0-100 */
  confidence: number;
  note: string;
}

interface Format {
  name: string;
  re: RegExp;
  /** Base plausibility, 0-100. */
  w: number;
  hc?: string;
  jtr?: string;
  note?: string | ((s: string) => string);
  /** Per-string correction added to `w`. */
  adj?: (s: string) => number;
  /** Marks the JSON Web Token format so the tool can point at the JWT tool. */
  jwt?: true;
}

const hex = (n: number | string) => new RegExp(`^[0-9a-f]{${n}}$`, 'i');
const C = '[./A-Za-z0-9]';
const B = '[A-Za-z0-9+/]';

/** Dumps print LM / NTLM in capitals, most other tools print lowercase. */
const shouting = (s: string) => /[A-F]/.test(s) && !/[a-f]/.test(s);

const b64Hex = (s: string) => {
  try {
    return `decodes to hex ${toHex(fromBase64(s))}`;
  } catch {
    return '';
  }
};

const CISCO7_KEY = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';

/** Cisco "type 7" passwords are an XOR with a fixed key, so they can simply be decoded. */
export function ciscoType7(s: string): string | null {
  const m = s.match(/^(\d\d)((?:[0-9a-f]{2})+)$/i);
  if (!m) return null;
  const seed = Number(m[1]);
  if (seed > 15) return null;
  const body = m[2]!;
  let out = '';
  for (let i = 0; i < body.length / 2; i++) {
    const byte = parseInt(body.substr(i * 2, 2), 16);
    out += String.fromCharCode(byte ^ CISCO7_KEY.charCodeAt((seed + i) % CISCO7_KEY.length));
  }
  return /^[\x20-\x7e]+$/.test(out) ? out : null;
}

const saltLen = (s: string) => s.slice(s.indexOf(':') + 1).length;

function kerberos(): Format[] {
  const out: Format[] = [];
  const etype: [string, string][] = [
    ['23', 'RC4-HMAC'],
    ['17', 'AES128'],
    ['18', 'AES256'],
  ];
  const modes: Record<string, [string, string, string]> = {
    tgs: ['13100', '19600', '19700'],
    asrep: ['18200', '32100', '32200'],
    pa: ['7500', '19800', '19900'],
  };
  const kinds: [string, string, string][] = [
    ['tgs', 'Kerberos 5 TGS-REP (Kerberoast)', 'krb5tgs'],
    ['asrep', 'Kerberos 5 AS-REP (AS-REP roast)', 'krb5asrep'],
    ['pa', 'Kerberos 5 AS-REQ pre-auth', 'krb5pa-md5'],
  ];
  for (const [kind, label, jtr] of kinds) {
    etype.forEach(([e, cipher], i) => {
      out.push({
        name: `${label}, etype ${e} (${cipher})`,
        re: new RegExp(`^\\$krb5${kind}\\$${e}\\$`),
        w: 99,
        hc: modes[kind]![i]!,
        jtr: e === '23' ? jtr : '',
      });
    });
  }
  return out;
}

export const FORMATS: readonly Format[] = [
  // ---------- 4 / 8 hex: checksums ----------
  { name: 'CRC-16', re: hex(4), w: 50 },
  { name: 'CRC-32', re: hex(8), w: 70, hc: '11500', jtr: 'crc32' },
  { name: 'Adler-32', re: hex(8), w: 45 },
  { name: 'CRC-32C / xxHash32 / MurmurHash3 / FNV-1a (32-bit)', re: hex(8), w: 20 },

  // ---------- 16 hex ----------
  { name: 'MySQL323 (old_password)', re: hex(16), w: 55, hc: '200', jtr: 'mysql' },
  { name: 'Half MD5 (middle 16 hex of an MD5)', re: hex(16), w: 35, hc: '5100' },
  {
    name: 'Oracle 7-10g (DES)',
    re: hex(16),
    w: 38,
    hc: '3100',
    jtr: 'oracle',
    note: 'hashcat wants hash:USERNAME',
    adj: (s) => (shouting(s) ? 12 : 0),
  },
  { name: 'CRC-64 / xxHash64 / FNV-1a (64-bit)', re: hex(16), w: 25 },
  {
    name: 'LM half (7 characters of a Windows LM hash)',
    re: hex(16),
    w: 20,
    adj: (s) => (shouting(s) ? 15 : 0),
  },

  // ---------- 32 hex ----------
  {
    name: 'MD5',
    re: hex(32),
    w: 85,
    hc: '0',
    jtr: 'raw-md5',
    adj: (s) => (shouting(s) ? -8 : 0),
  },
  {
    name: 'NTLM',
    re: hex(32),
    w: 70,
    hc: '1000',
    jtr: 'nt',
    note: 'Windows NT hash: MD4 of the UTF-16LE password',
    adj: (s) => (shouting(s) ? 10 : 0),
  },
  { name: 'MD4', re: hex(32), w: 40, hc: '900', jtr: 'raw-md4' },
  {
    name: 'LM',
    re: hex(32),
    w: 35,
    hc: '3000',
    jtr: 'lm',
    note: 'Two independent 7-character halves, so each half is cracked separately',
    adj: (s) => (shouting(s) ? 25 : 0) + (/^aad3b435b51404ee/i.test(s) ? 40 : 0),
  },
  { name: 'md5(md5($pass))', re: hex(32), w: 25, hc: '2600', jtr: 'dynamic_2' },
  {
    name: 'Domain Cached Credentials (MS Cache v1)',
    re: hex(32),
    w: 18,
    hc: '1100',
    jtr: 'mscash',
    note: 'hashcat wants hash:USERNAME',
  },
  { name: 'RAdmin v2.x', re: hex(32), w: 10, hc: '9900', jtr: 'radmin' },
  { name: 'MD2 / RIPEMD-128 / Haval-128 / Snefru-128', re: hex(32), w: 5 },

  // ---------- 40 hex ----------
  { name: 'SHA-1', re: hex(40), w: 90, hc: '100', jtr: 'raw-sha1' },
  { name: 'RIPEMD-160', re: hex(40), w: 35, hc: '6000', jtr: 'ripemd-160' },
  { name: 'sha1(sha1($pass))', re: hex(40), w: 20, hc: '4500' },
  {
    name: 'MySQL 4.1+ without its leading *',
    re: hex(40),
    w: 15,
    hc: '300',
    jtr: 'mysql-sha1',
    note: 'MySQL5 hashes are written *HEX in capitals; add the *',
  },
  { name: 'Tiger-160 / Haval-160', re: hex(40), w: 5 },

  // ---------- 48 hex ----------
  { name: 'Tiger-192 / Haval-192', re: hex(48), w: 30 },
  {
    name: 'macOS 10.4-10.6 (salted SHA-1)',
    re: hex(48),
    w: 20,
    hc: '122',
    jtr: 'xsha',
    note: '8 hex salt + SHA-1',
  },

  // ---------- 56 hex ----------
  { name: 'SHA-224', re: hex(56), w: 85, hc: '1300', jtr: 'raw-sha224' },
  { name: 'SHA3-224', re: hex(56), w: 35, hc: '17300', jtr: 'raw-sha3' },
  { name: 'Keccak-224', re: hex(56), w: 30, hc: '17700', jtr: 'raw-keccak' },
  { name: 'SHA-512/224 / Haval-224', re: hex(56), w: 8 },

  // ---------- 64 hex ----------
  { name: 'SHA-256', re: hex(64), w: 90, hc: '1400', jtr: 'raw-sha256' },
  { name: 'SHA3-256', re: hex(64), w: 35, hc: '17400', jtr: 'raw-sha3' },
  {
    name: 'Keccak-256',
    re: hex(64),
    w: 30,
    hc: '17800',
    jtr: 'raw-keccak-256',
    note: 'Ethereum uses Keccak-256',
  },
  { name: 'BLAKE2s-256 / BLAKE3', re: hex(64), w: 14 },
  { name: 'GOST R 34.11-94', re: hex(64), w: 15, hc: '6900', jtr: 'gost' },
  { name: 'Streebog-256 (GOST R 34.11-2012)', re: hex(64), w: 12, hc: '11700', jtr: 'Stribog-256' },
  { name: 'SM3 / SHA-512/256 / RIPEMD-256 / Snefru-256 / Haval-256', re: hex(64), w: 6 },

  // ---------- 80 / 96 / 128 / 136 hex ----------
  { name: 'RIPEMD-320', re: hex(80), w: 40 },
  { name: 'SHA-384', re: hex(96), w: 90, hc: '10800', jtr: 'raw-sha384' },
  { name: 'SHA3-384', re: hex(96), w: 35, hc: '17500', jtr: 'raw-sha3' },
  { name: 'Keccak-384', re: hex(96), w: 30, hc: '17900', jtr: 'raw-keccak' },
  { name: 'SHA-512', re: hex(128), w: 90, hc: '1700', jtr: 'raw-sha512' },
  { name: 'Whirlpool', re: hex(128), w: 45, hc: '6100', jtr: 'whirlpool' },
  { name: 'SHA3-512', re: hex(128), w: 35, hc: '17600', jtr: 'raw-sha3' },
  { name: 'Keccak-512', re: hex(128), w: 30, hc: '18000', jtr: 'raw-keccak' },
  { name: 'BLAKE2b-512', re: hex(128), w: 30, hc: '600', jtr: 'raw-blake2' },
  {
    name: 'Streebog-512 (GOST R 34.11-2012)',
    re: hex(128),
    w: 12,
    hc: '11800',
    jtr: 'Stribog-512',
  },
  { name: 'Skein-512 / SHA-512 variants', re: hex(128), w: 5 },
  {
    name: 'macOS 10.7 (salted SHA-512)',
    re: hex(136),
    w: 65,
    hc: '1722',
    jtr: 'xsha512',
    note: '8 hex salt + SHA-512',
  },

  // ---------- hex digest + salt ----------
  {
    name: 'LM:NT pair (pwdump / secretsdump)',
    re: /^[0-9a-f]{32}:[0-9a-f]{32}$/i,
    w: 62,
    hc: '1000',
    jtr: 'nt',
    note: 'Crack the second half as NTLM. aad3b435b51404ee… means LM is disabled',
  },
  {
    name: 'md5($pass.$salt) · Joomla < 2.5.18',
    re: /^[0-9a-f]{32}:.+$/i,
    w: 55,
    hc: '10 / 11',
    jtr: 'dynamic_4',
    adj: (s) => (/^[A-Za-z0-9]{32}$/.test(s.slice(33)) ? 10 : 0),
  },
  { name: 'md5($salt.$pass)', re: /^[0-9a-f]{32}:.+$/i, w: 48, hc: '20', jtr: 'dynamic_3' },
  {
    name: 'md5(md5($pass).$salt) · vBulletin / IPB / MyBB',
    re: /^[0-9a-f]{32}:.+$/i,
    w: 30,
    hc: '2611 / 2711 / 2811',
    adj: (s) => (saltLen(s) === 3 || saltLen(s) === 30 ? 18 : -15),
  },
  { name: 'HMAC-MD5 (key = $pass)', re: /^[0-9a-f]{32}:.+$/i, w: 30, hc: '50', jtr: 'hmac-md5' },
  {
    name: 'Domain Cached Credentials (hash:username)',
    re: /^[0-9a-f]{32}:[^:\s]+$/i,
    w: 20,
    hc: '1100',
    jtr: 'mscash',
  },
  { name: 'sha1($pass.$salt)', re: /^[0-9a-f]{40}:.+$/i, w: 55, hc: '110' },
  { name: 'sha1($salt.$pass)', re: /^[0-9a-f]{40}:.+$/i, w: 48, hc: '120' },
  { name: 'HMAC-SHA1 (key = $pass)', re: /^[0-9a-f]{40}:.+$/i, w: 30, hc: '150', jtr: 'hmac-sha1' },
  { name: 'SMF (sha1(lower($user).$pass))', re: /^[0-9a-f]{40}:[^:\s]+$/i, w: 15, hc: '121' },
  { name: 'sha256($pass.$salt)', re: /^[0-9a-f]{64}:.+$/i, w: 55, hc: '1410' },
  { name: 'sha256($salt.$pass)', re: /^[0-9a-f]{64}:.+$/i, w: 48, hc: '1420' },
  {
    name: 'HMAC-SHA256 (key = $pass)',
    re: /^[0-9a-f]{64}:.+$/i,
    w: 30,
    hc: '1450',
    jtr: 'hmac-sha256',
  },
  { name: 'sha512($pass.$salt)', re: /^[0-9a-f]{128}:.+$/i, w: 55, hc: '1710' },
  { name: 'sha512($salt.$pass)', re: /^[0-9a-f]{128}:.+$/i, w: 48, hc: '1720' },
  {
    name: 'HMAC-SHA512 (key = $pass)',
    re: /^[0-9a-f]{128}:.+$/i,
    w: 30,
    hc: '1750',
    jtr: 'hmac-sha512',
  },

  // ---------- Unix crypt family ----------
  {
    name: 'bcrypt',
    re: new RegExp(`^\\$2[abxy]?\\$\\d\\d\\$${C}{53}$`),
    w: 99,
    hc: '3200',
    jtr: 'bcrypt',
    note: 'Slow by design: use a targeted wordlist',
  },
  {
    name: 'bcrypt (Django wrapper)',
    re: new RegExp(`^bcrypt(_sha256)?\\$\\$?2[abxy]\\$\\d\\d\\$${C}{53}$`),
    w: 95,
    hc: '3200',
    jtr: 'bcrypt',
    note: 'Drop the "bcrypt$" prefix first (bcrypt_sha256 pre-hashes the password)',
  },
  {
    name: 'md5crypt ($1$) · Cisco IOS type 5',
    re: new RegExp(`^\\$1\\$[^$]{0,8}\\$${C}{22}$`),
    w: 99,
    hc: '500',
    jtr: 'md5crypt',
  },
  {
    name: 'Apache apr1 (md5)',
    re: new RegExp(`^\\$apr1\\$[^$]{0,8}\\$${C}{22}$`),
    w: 99,
    hc: '1600',
    jtr: 'md5crypt (handles $apr1$)',
    note: '.htpasswd',
  },
  {
    name: 'sha256crypt ($5$)',
    re: new RegExp(`^\\$5\\$(rounds=\\d+\\$)?[^$]{0,16}\\$${C}{43}$`),
    w: 99,
    hc: '7400',
    jtr: 'sha256crypt',
  },
  {
    name: 'sha512crypt ($6$)',
    re: new RegExp(`^\\$6\\$(rounds=\\d+\\$)?[^$]{0,16}\\$${C}{86}$`),
    w: 99,
    hc: '1800',
    jtr: 'sha512crypt',
    note: 'Default /etc/shadow hash on most Linux distributions',
  },
  {
    name: 'yescrypt ($y$)',
    re: new RegExp(`^\\$y\\$${C}+\\$${C}*\\$${C}{43}$`),
    w: 99,
    jtr: 'yescrypt',
    note: 'Default in recent Debian / Ubuntu / Fedora shadow files. John only',
  },
  {
    name: 'scrypt ($7$)',
    re: new RegExp(`^\\$7\\$${C}{11,}\\$${C}{43}$`),
    w: 99,
    jtr: 'scrypt',
  },
  {
    name: 'scrypt (hashcat SCRYPT:N:r:p:salt:hash)',
    re: /^SCRYPT:\d+:\d+:\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
    w: 99,
    hc: '8900',
  },
  {
    name: 'Argon2 (i / d / id)',
    re: new RegExp(`^\\$argon2(id|i|d)\\$(v=\\d+\\$)?m=\\d+,t=\\d+,p=\\d+\\$${B}+\\$${B}+$`),
    w: 99,
    hc: '34000',
    jtr: 'argon2',
  },
  {
    name: 'sha1crypt ($sha1$)',
    re: new RegExp(`^\\$sha1\\$\\d+\\$${C}{0,64}\\$${C}{28}$`),
    w: 99,
    hc: '15100',
    jtr: 'sha1crypt',
  },
  {
    name: 'phpass (WordPress / Joomla >= 2.5)',
    re: new RegExp(`^\\$P\\$${C}{31}$`),
    w: 98,
    hc: '400',
    jtr: 'phpass',
  },
  {
    name: 'phpass (phpBB3 / generic)',
    re: new RegExp(`^\\$H\\$${C}{31}$`),
    w: 98,
    hc: '400',
    jtr: 'phpass',
  },
  {
    name: 'Drupal 7 ($S$)',
    re: new RegExp(`^\\$S\\$${C}{52}$`),
    w: 99,
    hc: '7900',
    jtr: 'drupal7',
  },
  {
    name: 'descrypt (traditional DES crypt)',
    re: new RegExp(`^${C}{13}$`),
    w: 60,
    hc: '1500',
    jtr: 'descrypt',
    note: 'First 2 characters are the salt. Only the first 8 password characters count',
    adj: (s) => (/^[0-9a-f]{13}$/i.test(s) ? -45 : 0),
  },
  {
    name: 'BSDi extended DES crypt (_)',
    re: new RegExp(`^_${C}{19}$`),
    w: 97,
    hc: '12400',
    jtr: 'bsdicrypt',
  },
  {
    name: 'Cisco PIX / ASA MD5',
    re: new RegExp(`^${C}{16}$`),
    w: 62,
    hc: '2400',
    jtr: 'pix-md5',
    note: 'ASA hashes need hash:USERNAME with -m 2410',
    adj: (s) => (/^[0-9a-f]{16}$/i.test(s) ? -45 : 0),
  },

  // ---------- Django, Flask, passlib, PBKDF2 ----------
  {
    name: 'Django PBKDF2-SHA256',
    re: /^pbkdf2_sha256\$\d+\$[^$]+\$[A-Za-z0-9+/]+=*$/,
    w: 99,
    hc: '10000',
    jtr: 'django',
  },
  { name: 'Django PBKDF2-SHA1', re: /^pbkdf2_sha1\$\d+\$[^$]+\$[A-Za-z0-9+/]+=*$/, w: 99 },
  {
    name: 'Django salted SHA-1 / MD5',
    re: /^(sha1|md5)\$[^$]*\$[0-9a-f]{32,40}$/i,
    w: 97,
    hc: '124 (sha1 only)',
    jtr: 'dynamic_25',
  },
  {
    name: 'Flask / Werkzeug PBKDF2',
    re: /^pbkdf2:(sha1|sha256|sha512):\d+\$[^$]+\$[0-9a-f]+$/i,
    w: 99,
    hc: '10900 / 12000 / 12100 after conversion',
    note: 'Convert to hashcat form sha256:iterations:base64(salt):base64(hash)',
  },
  { name: 'Flask / Werkzeug scrypt', re: /^scrypt:\d+:\d+:\d+\$[^$]+\$[0-9a-f]+$/i, w: 99 },
  {
    name: 'PBKDF2-HMAC (passlib, $pbkdf2-shaN$)',
    re: new RegExp(`^\\$pbkdf2(-sha1|-sha256|-sha512)?\\$\\d+\\$${C}+\\$${C}+$`),
    w: 99,
    hc: '10900 / 12000 / 12100 after conversion',
    jtr: 'pbkdf2-hmac-sha256 / -sha1 / -sha512',
  },
  {
    name: 'PBKDF2-HMAC (hashcat shaN:iter:salt:hash)',
    re: /^sha(1|256|512):\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
    w: 98,
    hc: '12000 (sha1) / 10900 (sha256) / 12100 (sha512)',
  },
  {
    name: 'macOS 10.8+ (PBKDF2-SHA512, $ml$)',
    re: /^\$ml\$\d+\$[0-9a-f]+\$[0-9a-f]+$/i,
    w: 99,
    hc: '7100',
    jtr: 'pbkdf2-hmac-sha512',
  },
  {
    name: 'GRUB 2 PBKDF2-SHA512',
    re: /^grub\.pbkdf2\.sha512\.\d+\.[0-9a-f]+\.[0-9a-f]+$/i,
    w: 99,
    hc: '7200',
  },
  {
    name: 'Atlassian PBKDF2 ({PKCS5S2})',
    re: new RegExp(`^\\{PKCS5S2\\}${B}+=*$`),
    w: 99,
    hc: '12001',
  },

  // ---------- Cisco ----------
  {
    name: 'Cisco type 7 (reversible)',
    re: /^(0\d|1[0-5])(?:[0-9a-f]{2}){2,}$/i,
    w: 55,
    note: (s) => {
      const plain = ciscoType7(s);
      return plain === null ? 'Not decodable as type 7' : `Not a hash: decodes to "${plain}"`;
    },
    adj: (s) =>
      ciscoType7(s) === null
        ? -50
        : [8, 16, 32, 40, 48, 56, 64, 96, 128].includes(s.length)
          ? -45
          : 30,
  },
  {
    name: 'Cisco type 8 (PBKDF2-SHA256)',
    re: new RegExp(`^\\$8\\$${C}{14}\\$${C}{43}$`),
    w: 99,
    hc: '9200',
  },
  {
    name: 'Cisco type 9 (scrypt)',
    re: new RegExp(`^\\$9\\$${C}{14}\\$${C}{43}$`),
    w: 99,
    hc: '9300',
  },
  {
    name: 'Cisco type 4 (SHA-256)',
    re: new RegExp(`^${C}{43}$`),
    w: 55,
    hc: '5700',
    note: 'Cisco\'s Base64 alphabet starts with "./"',
  },

  // ---------- databases ----------
  {
    name: 'MySQL 4.1+ (MySQL5)',
    re: /^\*[0-9a-f]{40}$/i,
    w: 98,
    hc: '300',
    jtr: 'mysql-sha1',
  },
  {
    name: 'PostgreSQL md5',
    re: /^md5[0-9a-f]{32}$/i,
    w: 68,
    hc: '12',
    jtr: 'postgres',
    note: 'md5(password.username): drop "md5" and give hash:USERNAME',
  },
  {
    name: 'MSSQL 2000',
    re: /^0x0100[0-9a-f]{88}$/i,
    w: 98,
    hc: '131',
    jtr: 'mssql',
  },
  { name: 'MSSQL 2005', re: /^0x0100[0-9a-f]{48}$/i, w: 98, hc: '132', jtr: 'mssql05' },
  { name: 'MSSQL 2012 / 2014', re: /^0x0200[0-9a-f]{136}$/i, w: 98, hc: '1731', jtr: 'mssql12' },
  { name: 'Oracle 11g (S:)', re: /^S:[0-9a-f]{60}$/i, w: 98, hc: '112', jtr: 'oracle11' },
  {
    name: 'Oracle 12c+ (T:)',
    re: /^(T:)?[0-9a-f]{160}$/i,
    w: 80,
    hc: '12300',
    jtr: 'oracle12c',
    adj: (s) => (s.startsWith('T:') ? 18 : 0),
  },

  // ---------- LDAP and Base64 digests ----------
  {
    name: 'LDAP {SHA} (SHA-1, Base64)',
    re: new RegExp(`^\\{SHA\\}${B}{27}=$`),
    w: 99,
    hc: '101',
    jtr: 'nsldap',
    note: (s) => b64Hex(s.slice(5)),
  },
  {
    name: 'LDAP {SSHA} (salted SHA-1)',
    re: new RegExp(`^\\{SSHA\\}${B}{32,}={0,2}$`),
    w: 99,
    hc: '111',
    jtr: 'nsldaps',
  },
  {
    name: 'LDAP {SSHA256}',
    re: new RegExp(`^\\{SSHA256\\}${B}{48,}={0,2}$`),
    w: 99,
    hc: '1411',
  },
  {
    name: 'LDAP {SSHA512}',
    re: new RegExp(`^\\{SSHA512\\}${B}{96,}={0,2}$`),
    w: 99,
    hc: '1711',
    jtr: 'ssha512',
  },
  {
    name: 'LDAP {MD5}',
    re: new RegExp(`^\\{MD5\\}${B}{22}==$`),
    w: 99,
    note: (s) => b64Hex(s.slice(5)),
  },
  { name: 'LDAP {SMD5} (salted MD5)', re: new RegExp(`^\\{SMD5\\}${B}{27,}={0,2}$`), w: 99 },
  {
    name: 'Base64 of an MD5 / MD4 / NTLM digest',
    re: new RegExp(`^${B}{22}==$`),
    w: 70,
    note: b64Hex,
  },
  {
    name: 'Base64 of a SHA-1 digest',
    re: new RegExp(`^${B}{27}=$`),
    w: 72,
    hc: '101 (with the {SHA} prefix)',
    note: b64Hex,
  },
  {
    name: 'Base64 of a SHA-256 digest',
    re: new RegExp(`^${B}{43}=$`),
    w: 72,
    note: b64Hex,
  },
  {
    name: 'Base64 of a SHA-256 digest (unpadded)',
    re: new RegExp(`^${B}{43}$`),
    w: 30,
    note: b64Hex,
  },
  {
    name: 'Base64 of a SHA-384 digest',
    re: new RegExp(`^${B}{64}$`),
    w: 25,
    note: b64Hex,
  },
  {
    name: 'Base64 of a SHA-512 digest',
    re: new RegExp(`^${B}{86}==$`),
    w: 72,
    note: b64Hex,
  },

  // ---------- Windows and Kerberos ----------
  {
    name: 'pwdump / secretsdump line (user:rid:LM:NT:::)',
    re: /^[^:\s]*:\d+:[0-9a-f]{32}:[0-9a-f]{32}:::?.*$/i,
    w: 99,
    hc: '1000 (NT field) · 3000 (LM field)',
    jtr: 'nt · lm',
    note: 'Crack the 4th field as NTLM; the 3rd is LM (aad3b435b51404ee… = disabled)',
  },
  {
    name: 'NetNTLMv1 (challenge / response)',
    re: /^[^:\s]+::[^:]*:[0-9a-f]{48}:[0-9a-f]{48}:[0-9a-f]{16}$/i,
    w: 97,
    hc: '5500',
    jtr: 'netntlm',
    note: 'Captured with Responder / Inveigh',
  },
  {
    name: 'NetNTLMv2 (challenge / response)',
    re: /^[^:\s]+::[^:]*:[0-9a-f]{16}:[0-9a-f]{32}:[0-9a-f]{32,}$/i,
    w: 97,
    hc: '5600',
    jtr: 'netntlmv2',
    note: 'Captured with Responder / Inveigh',
  },
  {
    name: 'Domain Cached Credentials 2 (MS Cache v2)',
    re: /^\$DCC2\$\d+#[^#]+#[0-9a-f]{32}$/i,
    w: 99,
    hc: '2100',
    jtr: 'mscash2',
  },
  ...kerberos(),

  // ---------- tokens and files ----------
  {
    name: 'JSON Web Token (JWT)',
    re: /^eyJ[\w-]+\.eyJ[\w-]*\.[\w-]*$/,
    w: 99,
    hc: '16500',
    note: 'Use the JWT tool to decode, verify, forge or crack it',
    jwt: true,
  },
  { name: 'ZIP archive (WinZip AES, zip2john)', re: /^\$zip2\$\*/, w: 99, hc: '13600', jtr: 'zip' },
  {
    name: 'ZIP archive (PKZIP, zip2john)',
    re: /^\$pkzip2?\$/,
    w: 99,
    hc: '17200 - 17230',
    jtr: 'pkzip',
  },
  { name: 'RAR5 archive', re: /^\$rar5\$/, w: 99, hc: '13000', jtr: 'rar5' },
  { name: 'RAR3 archive', re: /^\$RAR3\$/, w: 99, hc: '12500 / 23700', jtr: 'rar' },
  { name: '7-Zip archive', re: /^\$7z\$/, w: 99, hc: '11600', jtr: '7z' },
  { name: 'PDF document', re: /^\$pdf\$/, w: 99, hc: '10400 - 10700', jtr: 'pdf' },
  { name: 'MS Office document', re: /^\$office\$/, w: 99, hc: '9400 - 9600', jtr: 'office' },
  { name: 'KeePass database', re: /^\$keepass\$/, w: 99, hc: '13400', jtr: 'keepass' },
  { name: 'Bitcoin / Litecoin wallet.dat', re: /^\$bitcoin\$/, w: 99, hc: '11300', jtr: 'bitcoin' },
  {
    name: 'Ansible Vault',
    re: /^(\$ansible\$|\$ANSIBLE_VAULT;)/,
    w: 99,
    hc: '16900',
    jtr: 'ansible',
  },
  { name: 'BitLocker volume', re: /^\$bitlocker\$/, w: 99, hc: '22100', jtr: 'bitlocker' },
  { name: 'WPA / WPA2 handshake (hc22000)', re: /^WPA\*0[12]\*/, w: 99, hc: '22000' },
  { name: 'SSH private key (ssh2john)', re: /^\$sshng\$/, w: 99, jtr: 'ssh' },
];

/** Hashes people meet constantly: the digest of the empty string and of a few notorious passwords. */
const KNOWN: Record<string, string> = {
  d41d8cd98f00b204e9800998ecf8427e: 'MD5 of the empty string',
  da39a3ee5e6b4b0d3255bfef95601890afd80709: 'SHA-1 of the empty string',
  d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f: 'SHA-224 of the empty string',
  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855: 'SHA-256 of the empty string',
  '38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b':
    'SHA-384 of the empty string',
  cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e:
    'SHA-512 of the empty string',
  '31d6cfe0d16ae931b73c59d7e0c089c0': 'NTLM of the empty password',
  aad3b435b51404eeaad3b435b51404ee: 'LM of the empty password (LM is disabled)',
  aad3b435b51404ee: 'LM half of the empty password',
  '5f4dcc3b5aa765d61d8327deb882cf99': 'MD5 of "password"',
  '5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8': 'SHA-1 of "password"',
  '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8': 'SHA-256 of "password"',
  '8846f7eaee8fb117ad06bdd830b7586c': 'NTLM of "password"',
  e10adc3949ba59abbe56e057f20f883e: 'MD5 of "123456"',
  '21232f297a57a5a743894a0e4a801fc3': 'MD5 of "admin"',
};

export interface Identification {
  /** The string that was actually analysed (a shadow / user:hash line is cut down to the hash). */
  hash: string;
  /** What was stripped or understood, e.g. 'shadow entry of user "root"'. */
  context: string[];
  /** The same messages as i18n keys (tool.hash-identify.context.*) for the UI. */
  contextKeys: { key: string; params?: Record<string, string> }[];
  candidates: Candidate[];
  /** Set when the hash is a famous value. */
  known?: string;
}

function classify(s: string): Candidate[] {
  const found: { candidate: Candidate; order: number }[] = [];
  FORMATS.forEach((f, order) => {
    if (!f.re.test(s)) return;
    const score = f.w + (f.adj ? f.adj(s) : 0);
    if (score <= 0) return;
    found.push({
      order,
      candidate: {
        name: f.name,
        hashcat: f.hc ?? '',
        john: f.jtr ?? '',
        confidence: Math.min(99, score),
        note: typeof f.note === 'function' ? f.note(s) : (f.note ?? ''),
      },
    });
  });
  // Equal confidence keeps the order of the database above.
  return found
    .sort((a, b) => b.candidate.confidence - a.candidate.confidence || a.order - b.order)
    .map((x) => x.candidate);
}

export function confidenceLabel(c: number): string {
  if (c >= 95) return 'Certain';
  if (c >= 80) return 'Very likely';
  if (c >= 55) return 'Likely';
  if (c >= 30) return 'Possible';
  return 'Unlikely';
}

const LOCKED = new Set(['', '*', '!', '!!', 'x', 'NP', 'LK', '*LK*']);

export function identify(line: string): Identification {
  const raw = line.trim();
  const context: string[] = [];
  const contextKeys: Identification['contextKeys'] = [];
  const say = (english: string, key: string, params?: Record<string, string>) => {
    context.push(english);
    contextKeys.push({ key, params });
  };

  // /etc/shadow: user:hash:lastchange:min:max:warn:...
  const shadow = raw.match(/^([^:\s]+):([^:]*):(\d*):(\d*):(\d*):(\d*):/);
  if (shadow && !/^\d+$/.test(shadow[2]!) && !/^[0-9a-f]{32}$/i.test(shadow[2]!)) {
    let hash = shadow[2]!;
    say(`/etc/shadow entry of user "${shadow[1]}"`, 'shadow', { user: shadow[1]! });
    if (LOCKED.has(hash)) {
      say('this account has no password hash (locked, or password login disabled)', 'noHash');
      return { hash, context, contextKeys, candidates: [] };
    }
    if (hash.startsWith('!') && hash.length > 1) {
      say('the leading "!" means the account is locked; the hash itself is intact', 'locked');
      hash = hash.slice(1);
    }
    return {
      hash,
      context,
      contextKeys,
      candidates: classify(hash),
      known: KNOWN[hash.toLowerCase()],
    };
  }

  const direct = classify(raw);
  const strong = direct.some((c) => c.confidence >= 30);
  if (strong || !raw.includes(':')) {
    return { hash: raw, context, contextKeys, candidates: direct, known: KNOWN[raw.toLowerCase()] };
  }

  // user:hash and hash:user are both common in dumps and CTF files.
  const fields = raw.split(':');
  const tries: [string, string, string, string][] = [
    [fields.slice(1).join(':'), 'user:hash', fields[0]!, 'userHash'],
    [fields[fields.length - 1]!, 'user:hash', fields.slice(0, -1).join(':'), 'userHash'],
    [fields.slice(0, -1).join(':'), 'hash:user', fields[fields.length - 1]!, 'hashUser'],
  ];
  for (const [candidate, layout, user, key] of tries) {
    const found = classify(candidate.trim());
    if (found.some((c) => c.confidence >= 30)) {
      say(`read as ${layout}, user "${user}"`, key, { user });
      return {
        hash: candidate.trim(),
        context,
        contextKeys,
        candidates: found,
        known: KNOWN[candidate.trim().toLowerCase()],
      };
    }
  }
  return { hash: raw, context, contextKeys, candidates: direct, known: KNOWN[raw.toLowerCase()] };
}
