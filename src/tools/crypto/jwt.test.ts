import {
  createHmac as nodeHmac,
  constants,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { WEAK_SECRETS } from './_jwt-secrets';
import tool from './jwt';

type Opts = Parameters<typeof tool.run>[1];
const defaults: Opts = {
  mode: 'decode',
  alg: 'HS256',
  secret: '',
  secretB64: false,
  publicKey: '',
  extra: '',
};

const run = (input: string, opts: Partial<Opts> = {}): Promise<Output[]> =>
  Promise.resolve(tool.run(input, { ...defaults, ...opts }));
const text = async (input: string, opts: Partial<Opts> = {}) =>
  resultToText(await run(input, opts));

const JWTIO =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');
const segs = (header: object, payload: object) =>
  `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
const hs256 = (header: object, payload: object, secret: string) => {
  const input = segs(header, payload);
  return `${input}.${nodeHmac('sha256', secret).update(input).digest('base64url')}`;
};

function claimsOf(out: Output[]): Map<string, string[]> {
  const t = out.find((o) => o.type === 'table' && o.label === 'Claims');
  if (!t || t.type !== 'table') throw new Error('no claims table');
  return new Map(t.rows.map((r) => [String(r[0]), r.slice(1).map(String)]));
}

describe('jwt decode', () => {
  it('decodes the jwt.io sample', async () => {
    const out = await run(JWTIO);
    const t = resultToText(out);
    expect(t).toContain('"alg": "HS256"');
    expect(t).toContain('"name": "John Doe"');
    const claims = claimsOf(out);
    expect(claims.get('sub')![0]).toBe('1234567890');
    expect(claims.get('iat')![0]).toBe('2018-01-18T01:30:22.000Z');
    expect(claims.get('expired?')![0]).toBe('no exp claim');
    const sig = out.find((o) => o.type === 'text' && o.label?.startsWith('Signature'));
    expect(sig?.type === 'text' && sig.value).toBe(
      '49f94ac7044948c78a285d904f87f0a4c7897f7e8f3a4eb2255fda750b2cc397',
    );
  });

  it('flags the well-known weak secret', async () => {
    expect(await text(JWTIO)).toContain('signed with "your-256-bit-secret"');
  });

  it('does not accuse a token signed with a strong secret', async () => {
    const t = await text(hs256({ alg: 'HS256' }, { a: 1 }, 'x7#Qp9!zL2vR8^mT4wK1'));
    expect(t).not.toMatch(/Weak secret/);
  });

  it('reports expiry against the clock', async () => {
    const past = claimsOf(await run(hs256({ alg: 'HS256' }, { exp: 1000000000 }, 'k')));
    expect(past.get('exp')![0]).toBe('2001-09-09T01:46:40.000Z');
    expect(past.get('exp')![1]).toMatch(/ago/);
    expect(past.get('expired?')![0]).toBe('yes');
    const future = claimsOf(await run(hs256({ alg: 'HS256' }, { exp: 4102444800 }, 'k')));
    expect(future.get('expired?')![0]).toBe('no');
    const notYet = claimsOf(await run(hs256({ alg: 'HS256' }, { nbf: 4102444800 }, 'k')));
    expect(notYet.get('valid yet?')![0]).toBe('no');
  });

  it('notices millisecond timestamps and privilege claims', async () => {
    const claims = claimsOf(
      await run(hs256({ alg: 'HS256' }, { iat: 1516239022000, role: 'user' }, 'k')),
    );
    expect(claims.get('iat')![0]).toBe('2018-01-18T01:30:22.000Z');
    expect(claims.get('iat')![1]).toMatch(/milliseconds/);
    expect(claims.get('role')![1]).toMatch(/privilege/);
  });

  it('warns about alg none and its spellings', async () => {
    const token = `${segs({ alg: 'None', typ: 'JWT' }, { user: 'admin' })}.`;
    const t = await text(token);
    expect(t).toMatch(/unsigned/);
    expect(t).toContain('(empty: unsigned token)');
  });

  it('flags kid, jku, x5u, jwk and x5c as attack surface', async () => {
    const header = {
      alg: 'HS256',
      kid: '../../dev/null',
      jku: 'https://evil.example/jwks.json',
      x5u: 'https://evil.example/cert.pem',
      jwk: { kty: 'oct' },
      x5c: ['AAAA'],
    };
    const t = await text(hs256(header, { a: 1 }, 'x7#Qp9!zL2vR8^mT4wK1'));
    expect(t).toContain('kid is set (../../dev/null)');
    expect(t).toContain('jku is set (https://evil.example/jwks.json)');
    expect(t).toContain('x5u is set');
    expect(t).toContain('jwk is embedded');
    expect(t).toContain('x5c is embedded');
  });

  it('mentions algorithm confusion for asymmetric algs', async () => {
    const t = await text(`${segs({ alg: 'RS256' }, { a: 1 })}.AAAA`);
    expect(t).toMatch(/algorithm confusion/);
  });

  it('finds the token inside a header, a cookie or a JSON body', async () => {
    expect(await text(`Authorization: Bearer ${JWTIO}`)).toContain('John Doe');
    expect(await text(`session=${JWTIO}; Path=/; HttpOnly`)).toContain('John Doe');
    expect(await text(`{"access_token":"${JWTIO}","expires_in":3600}`)).toContain('John Doe');
  });

  it('repairs a token wrapped over several lines', async () => {
    const wrapped = JWTIO.replace(/(.{40})/g, '$1\n');
    expect(await text(wrapped)).toContain('John Doe');
  });

  it('shows a non-JSON payload as text', async () => {
    const token = `${b64u('{"alg":"HS256"}')}.${b64u('just some text')}.AAAA`;
    const t = await text(token);
    expect(t).toContain('just some text');
    expect(t).toMatch(/not a JSON object/);
  });

  it('accepts a token without a signature part', async () => {
    expect(await text(segs({ alg: 'none' }, { a: 1 }))).toContain('"a": 1');
  });

  it('rejects input that is not a token', async () => {
    await expect(run('hello world')).rejects.toBeInstanceOf(ToolError);
    await expect(run('')).rejects.toBeInstanceOf(ToolError);
    await expect(run(`${b64u('not json')}.${b64u('{}')}.AAAA`)).rejects.toThrow(/not JSON/);
    await expect(run('eyJhbGciOiJIUzI1NiJ9.e$$$.sig')).rejects.toBeInstanceOf(ToolError);
  });

  it('explains that a JWE cannot be decoded', async () => {
    await expect(run('eyJhbGciOiJkaXIifQ..AAAA.BBBB.CCCC')).rejects.toThrow(/JWE/);
  });
});

describe('jwt verify (HMAC)', () => {
  it('accepts the right secret and rejects another', async () => {
    const ok = await text(JWTIO, { mode: 'verify', secret: 'your-256-bit-secret' });
    expect(ok).toContain('Signature is valid (HS256)');
    const bad = await text(JWTIO, { mode: 'verify', secret: 'nope' });
    expect(bad).toContain('does NOT match');
  });

  it('detects a tampered payload', async () => {
    const [h, , s] = JWTIO.split('.');
    const forged = `${h}.${b64u('{"sub":"1","admin":true}')}.${s}`;
    expect(await text(forged, { mode: 'verify', secret: 'your-256-bit-secret' })).toContain(
      'does NOT match',
    );
  });

  it('supports HS384 and HS512 and a Base64 secret', async () => {
    const input = segs({ alg: 'HS512', typ: 'JWT' }, { a: 1 });
    const key = Buffer.from('c2VjcmV0LWJ5dGVz', 'base64');
    const token = `${input}.${nodeHmac('sha512', key).update(input).digest('base64url')}`;
    expect(
      await text(token, { mode: 'verify', secret: 'c2VjcmV0LWJ5dGVz', secretB64: true }),
    ).toContain('Signature is valid (HS512)');
    expect(await text(token, { mode: 'verify', secret: 'c2VjcmV0LWJ5dGVz' })).toContain(
      'does NOT match',
    );
    const input384 = segs({ alg: 'HS384' }, { a: 1 });
    const t384 = `${input384}.${nodeHmac('sha384', 'k').update(input384).digest('base64url')}`;
    expect(await text(t384, { mode: 'verify', secret: 'k' })).toContain('valid (HS384)');
  });

  it('asks for the secret and the key', async () => {
    await expect(run(JWTIO, { mode: 'verify' })).rejects.toThrow(/secret/);
    await expect(run(`${segs({ alg: 'RS256' }, {})}.AAAA`, { mode: 'verify' })).rejects.toThrow(
      /public key/,
    );
  });

  it('refuses algorithms it does not know', async () => {
    await expect(
      run(`${segs({ alg: 'HS999' }, {})}.AAAA`, { mode: 'verify', secret: 'x' }),
    ).rejects.toThrow(/Unsupported alg/);
  });

  it('says there is nothing to verify for alg none', async () => {
    const t = await text(`${segs({ alg: 'none' }, {})}.`, { mode: 'verify' });
    expect(t).toMatch(/no signature to verify/);
  });
});

describe('jwt verify (public key)', () => {
  const input = (alg: string) => segs({ alg, typ: 'JWT' }, { sub: 'ctf' });

  const rsaKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaPem = rsaKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const rsaPkcs1 = rsaKeys.publicKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const otherRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const rsToken = (alg: string, hash: string, key: KeyObject, pss = false) => {
    const data = input(alg);
    const sig = nodeSign(
      hash,
      Buffer.from(data),
      pss
        ? {
            key,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: Number(hash.slice(3)) / 8,
          }
        : key,
    );
    return `${data}.${sig.toString('base64url')}`;
  };

  it('verifies RS256 / RS384 / RS512 with a SPKI PEM', async () => {
    for (const bits of ['256', '384', '512']) {
      const token = rsToken(`RS${bits}`, `sha${bits}`, rsaKeys.privateKey);
      const t = await text(token, { mode: 'verify', publicKey: rsaPem });
      expect(t).toContain(`Signature is valid (RS${bits})`);
    }
  });

  it('accepts a PEM pasted on one line, with literal \\n, or as PKCS#1', async () => {
    const token = rsToken('RS256', 'sha256', rsaKeys.privateKey);
    for (const key of [
      rsaPem.replace(/\n/g, ' '),
      rsaPem.replace(/\n/g, '\\n'),
      rsaPem.replace(/\n/g, ''),
      rsaPkcs1,
      rsaPkcs1.replace(/\n/g, ' '),
    ]) {
      expect(await text(token, { mode: 'verify', publicKey: key })).toContain('Signature is valid');
    }
  });

  it('accepts a JWK and picks the key of a JWKS by kid', async () => {
    const token = rsToken('RS256', 'sha256', rsaKeys.privateKey);
    const jwk = rsaKeys.publicKey.export({ format: 'jwk' });
    expect(
      await text(token, { mode: 'verify', publicKey: JSON.stringify({ ...jwk, alg: 'RS256' }) }),
    ).toContain('Signature is valid');
    const other = otherRsa.publicKey.export({ format: 'jwk' });
    const jwks = JSON.stringify({
      keys: [
        { ...other, kid: 'a' },
        { ...jwk, kid: 'b' },
      ],
    });
    const withKid = `${b64u(JSON.stringify({ alg: 'RS256', kid: 'b' }))}.${b64u('{"sub":"ctf"}')}`;
    const sig = nodeSign('sha256', Buffer.from(withKid), rsaKeys.privateKey).toString('base64url');
    expect(await text(`${withKid}.${sig}`, { mode: 'verify', publicKey: jwks })).toContain(
      'Signature is valid',
    );
  });

  it('rejects a signature made with another key', async () => {
    const token = rsToken('RS256', 'sha256', otherRsa.privateKey);
    expect(await text(token, { mode: 'verify', publicKey: rsaPem })).toContain('does NOT match');
  });

  it('verifies PS256 / PS384 / PS512', async () => {
    for (const bits of ['256', '384', '512']) {
      const token = rsToken(`PS${bits}`, `sha${bits}`, rsaKeys.privateKey, true);
      const t = await text(token, { mode: 'verify', publicKey: rsaPem });
      expect(t).toContain(`Signature is valid (PS${bits})`);
    }
  });

  it('verifies ES256 / ES384 / ES512 (raw r||s signatures)', async () => {
    const curves: [string, string, string][] = [
      ['ES256', 'prime256v1', 'sha256'],
      ['ES384', 'secp384r1', 'sha384'],
      ['ES512', 'secp521r1', 'sha512'],
    ];
    for (const [alg, namedCurve, hash] of curves) {
      const keys = generateKeyPairSync('ec', { namedCurve });
      const data = input(alg);
      const sig = nodeSign(hash, Buffer.from(data), {
        key: keys.privateKey,
        dsaEncoding: 'ieee-p1363',
      });
      const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const t = await text(`${data}.${sig.toString('base64url')}`, {
        mode: 'verify',
        publicKey: pem,
      });
      expect(t).toContain(`Signature is valid (${alg})`);
    }
  });

  it('verifies EdDSA (Ed25519)', async () => {
    const keys = generateKeyPairSync('ed25519');
    const data = input('EdDSA');
    const sig = nodeSign(null, Buffer.from(data), keys.privateKey).toString('base64url');
    const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(await text(`${data}.${sig}`, { mode: 'verify', publicKey: pem })).toContain(
      'Signature is valid (EdDSA)',
    );
  });

  it('explains key problems', async () => {
    const token = rsToken('RS256', 'sha256', rsaKeys.privateKey);
    const priv = rsaKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await expect(run(token, { mode: 'verify', publicKey: priv })).rejects.toThrow(/private key/);
    await expect(
      run(token, {
        mode: 'verify',
        publicKey: '-----BEGIN CERTIFICATE----- MIIB -----END CERTIFICATE-----',
      }),
    ).rejects.toThrow(/certificate/);
    await expect(run(token, { mode: 'verify', publicKey: 'not a key' })).rejects.toThrow(
      /Could not read/,
    );
    await expect(run(token, { mode: 'verify', publicKey: '{oops' })).rejects.toBeInstanceOf(
      ToolError,
    );
    // An EC key cannot verify an RSA algorithm.
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const ecPem = ec.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await expect(run(token, { mode: 'verify', publicKey: ecPem })).rejects.toThrow(
      /cannot verify RS256/,
    );
  });
});

describe('jwt sign', () => {
  it('reproduces the jwt.io token byte for byte when re-signing it', async () => {
    const t = await text(JWTIO, { mode: 'sign', alg: 'HS256', secret: 'your-256-bit-secret' });
    expect(t).toContain(JWTIO);
  });

  it('signs a bare payload with a default header', async () => {
    const t = await text('{"user":"admin"}', { mode: 'sign', secret: 'secret' });
    expect(t).toContain(hs256({ alg: 'HS256', typ: 'JWT' }, { user: 'admin' }, 'secret'));
  });

  it('signs {header, payload} JSON, keeping extra header fields', async () => {
    const input = '{"header":{"typ":"JWT","kid":"1"},"payload":{"n":1}}';
    const t = await text(input, { mode: 'sign', alg: 'HS384', secret: 'k' });
    const token = /eyJ[\w.-]+/.exec(t)![0];
    const [h] = token.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
      typ: 'JWT',
      kid: '1',
      alg: 'HS384',
    });
    expect(await text(token, { mode: 'verify', secret: 'k' })).toContain('valid (HS384)');
  });

  it('turns a decoded token into a forged one that verifies', async () => {
    const original = hs256(
      { alg: 'HS256', typ: 'JWT' },
      { user: 'guest', admin: false },
      'letmein',
    );
    const forged = (await text(original, { mode: 'sign', secret: 'letmein' })).match(
      /eyJ[\w.-]+/,
    )![0];
    expect(forged).toBe(original);
  });

  it('writes alg none tokens and the case variants', async () => {
    const out = await run('{"user":"admin"}', { mode: 'sign', alg: 'none' });
    const t = resultToText(out);
    expect(t).toContain('eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ1c2VyIjoiYWRtaW4ifQ.');
    const table = out.find((o) => o.type === 'table');
    const rows = table?.type === 'table' ? table.rows : [];
    expect(rows.map((r) => r[0])).toEqual(['none', 'None', 'NONE', 'nOnE']);
    for (const r of rows) {
      const header = JSON.parse(Buffer.from(String(r[1]).split('.')[0]!, 'base64url').toString());
      expect(header.alg).toBe(r[0]);
      expect(String(r[1]).endsWith('.')).toBe(true);
    }
  });

  it('needs a secret and valid JSON', async () => {
    await expect(run('{"a":1}', { mode: 'sign' })).rejects.toThrow(/secret/);
    await expect(run('{"a":', { mode: 'sign', secret: 'k' })).rejects.toThrow(/JSON/);
    await expect(run('', { mode: 'sign', secret: 'k' })).rejects.toBeInstanceOf(ToolError);
    await expect(run('hello', { mode: 'sign', secret: 'k' })).rejects.toBeInstanceOf(ToolError);
  });
});

describe('jwt crack', () => {
  it('has a sizeable built-in list', () => {
    expect(WEAK_SECRETS.length).toBeGreaterThanOrEqual(150);
    expect(new Set(WEAK_SECRETS).size).toBe(WEAK_SECRETS.length);
    expect(WEAK_SECRETS).toContain('secret');
    expect(WEAK_SECRETS).toContain('your-256-bit-secret');
  });

  it('finds common secrets for every HS size', async () => {
    for (const [alg, algo, secret] of [
      ['HS256', 'sha256', 'password'],
      ['HS384', 'sha384', 'changeme'],
      ['HS512', 'sha512', 'jwt_secret'],
    ] as const) {
      const input = segs({ alg, typ: 'JWT' }, { a: 1 });
      const token = `${input}.${nodeHmac(algo, secret).update(input).digest('base64url')}`;
      expect(await text(token, { mode: 'crack' })).toContain(`Secret found: ${secret}`);
    }
  });

  it('uses extra candidates', async () => {
    const token = hs256({ alg: 'HS256' }, { a: 1 }, 'c0rrect-h0rse');
    expect(await text(token, { mode: 'crack' })).toContain('None of the');
    expect(await text(token, { mode: 'crack', extra: 'foo,c0rrect-h0rse,bar' })).toContain(
      'Secret found: c0rrect-h0rse',
    );
  });

  it('finds an empty secret', async () => {
    const token = hs256({ alg: 'HS256' }, { a: 1 }, '');
    expect(await text(token, { mode: 'crack' })).toContain('The secret is the empty string');
  });

  it('suggests hashcat when nothing matches', async () => {
    const token = hs256({ alg: 'HS256' }, { a: 1 }, 'x7#Qp9!zL2vR8^mT4wK1');
    expect(await text(token, { mode: 'crack' })).toContain('hashcat -m 16500');
  });

  it('only applies to HMAC tokens with a signature', async () => {
    await expect(run(`${segs({ alg: 'RS256' }, {})}.AAAA`, { mode: 'crack' })).rejects.toThrow(
      /HMAC/,
    );
    await expect(run(`${segs({ alg: 'HS256' }, {})}.`, { mode: 'crack' })).rejects.toThrow(
      /no signature/,
    );
    await expect(run(`${segs({ alg: 'none' }, {})}.`, { mode: 'crack' })).rejects.toThrow(/HMAC/);
  });
});

describe('jwt detect', () => {
  it('recognises tokens and nothing else', () => {
    const hit = tool.detect!({ text: JWTIO, bytes: new Uint8Array() });
    expect(hit?.score).toBeGreaterThan(0.9);
    expect(hit?.options).toEqual({ mode: 'decode' });
    expect(tool.detect!({ text: `Bearer ${JWTIO}`, bytes: new Uint8Array() })).not.toBeNull();
    expect(tool.detect!({ text: 'ZmxhZ3t9', bytes: new Uint8Array() })).toBeNull();
    expect(tool.detect!({ text: null, bytes: new Uint8Array() })).toBeNull();
    expect(tool.detect!({ text: 'eyJub3QganNvbiJ9.e30.x', bytes: new Uint8Array() })).toBeNull();
  });
});
