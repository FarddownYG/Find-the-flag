import { describe, expect, it } from 'vitest';
import { PdfDoc } from './_pdf-doc';
import { permissionsAllowed, readEncrypt, unlock } from './_pdf-crypt';
import { isDict, parseValue } from './_pdf-lex';
import { ENCRYPTED_VECTORS } from './_pdf-vectors';

async function encryptOf(name: string) {
  const v = ENCRYPTED_VECTORS[name]!;
  const doc = await PdfDoc.open(v.bytes, { passwords: v.password ? [v.password] : [] });
  return { doc, enc: doc.encrypt!, v };
}

describe('standard security handler', () => {
  // The dictionaries below were written by pypdf; each parameter is what its encrypt() promised.
  it.each([
    ['rc4-40', 1, 2, 40],
    ['rc4-128', 2, 3, 128],
    ['aes-128', 4, 4, 128],
    ['aes-256-r5', 5, 5, 256],
    ['aes-256', 5, 6, 256],
  ])('reads the /Encrypt dictionary of %s (V %i, R %i, %i bits)', async (name, v, r, bits) => {
    const { enc } = await encryptOf(name as string);
    expect(enc.filter).toBe('Standard');
    expect(enc.v).toBe(v);
    expect(enc.r).toBe(r);
    expect(v === 5 ? 256 : enc.bits).toBe(bits);
    expect(enc.supported).toBe(true);
    expect(enc.o.length).toBe(v === 5 ? 48 : 32);
    expect(enc.u.length).toBe(v === 5 ? 48 : 32);
    if (v === 4) expect(enc.filters.map((f) => [f.name, f.cfm])).toEqual([['StdCF', 'AESV2']]);
    if (v === 5) expect(enc.filters.map((f) => f.cfm)).toEqual(['AESV3']);
  });

  it('decodes the permission bits of /P (Table 22)', () => {
    expect(permissionsAllowed(-4)).toEqual([
      'print',
      'modify',
      'copy',
      'annotate',
      'fillForms',
      'accessibility',
      'assemble',
      'printHighQuality',
    ]);
    expect(permissionsAllowed(4)).toEqual(['print']);
    expect(permissionsAllowed(0)).toEqual([]);
  });

  it('reads crypt filter lengths given in bytes or in bits', () => {
    const dict = parseValue(
      '<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /A << /CFM /V2 /Length 16 >> /B << /CFM /AESV2 /Length 128 >> >> /StmF /A /StrF /B /P -4 /O <00> /U <00> >>',
    );
    if (!isDict(dict)) throw new Error('not a dict');
    const enc = readEncrypt(dict, new Uint8Array(0), (x) => x);
    expect(enc.filters.map((f) => [f.name, f.method, f.bits])).toEqual([
      ['A', 'rc4', 128],
      ['B', 'aes128', 128],
    ]);
    expect([enc.stmF, enc.strF]).toEqual(['A', 'B']);
  });

  it('refuses another security handler or unknown versions without trying', async () => {
    const pub = parseValue('<< /Filter /Adobe.PubSec /V 4 >>');
    if (!isDict(pub)) throw new Error('not a dict');
    const enc = readEncrypt(pub, new Uint8Array(0), (x) => x);
    expect(enc.supported).toBe(false);
    expect(await unlock(enc, [''])).toEqual({
      ok: false,
      reason: 'unsupported',
      detail: 'security handler Adobe.PubSec',
    });
    const odd = parseValue('<< /Filter /Standard /V 9 /R 12 >>');
    if (!isDict(odd)) throw new Error('not a dict');
    expect(
      (
        await unlock(
          readEncrypt(odd, new Uint8Array(0), (x) => x),
          [''],
        )
      ).ok,
    ).toBe(false);
  });

  it('tries the empty password first and then the ones given, and rejects the owner password', async () => {
    const pw = await encryptOf('rc4-128-pw');
    const bad = await unlock(pw.enc, ['', 'x', 'owner-secret']);
    expect(bad).toMatchObject({ ok: false, reason: 'password' });
    const good = await unlock(pw.enc, ['x', 'hunter2']);
    expect(good).toMatchObject({ ok: true, password: 'given' });
    const empty = await encryptOf('rc4-128');
    expect(await unlock(empty.enc, ['ignored'])).toMatchObject({ ok: true, password: 'empty' });
  });

  it('checks the /Perms block of AES-256 files', async () => {
    const { enc } = await encryptOf('aes-256');
    const ok = await unlock(enc, ['']);
    expect(ok).toMatchObject({ ok: true, warning: null });
    const tampered = { ...enc, perms: Uint8Array.from(enc.perms!, (b) => b ^ 1) };
    expect(await unlock(tampered, [''])).toMatchObject({ ok: true, warning: 'perms' });
  });

  it('decrypts with the file key and leaves streams with an Identity crypt filter alone', async () => {
    const { doc } = await encryptOf('aes-128');
    const dec = doc.decryptor!;
    const stream = doc.records.find((r) => r.stream && r.num !== 0)!;
    const raw = doc.rawBytes(stream);
    const plain = dec.stream(stream.num, stream.gen, raw, { cryptName: null, metadata: false });
    expect(new TextDecoder().decode(plain)).toContain('FTF{aes_128}');
    expect(
      dec.stream(stream.num, stream.gen, raw, { cryptName: 'Identity', metadata: false }),
    ).toEqual(raw);
  });
});
