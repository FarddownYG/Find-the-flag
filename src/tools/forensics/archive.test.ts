import { readFileSync } from 'node:fs';
import { gzipSync, strFromU8, strToU8, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { concatBytes, indexOfBytes, u32le, utf8Encode } from '../../lib/bytes';
import { crc32 } from '../../lib/signatures';
import archive, { safeName, sniff } from './archive';
import { COMMENTED_ZIP, ENCRYPTED_ZIP, GNU_TAR_GZ, PAX_TAR_GZ, STREAMED_ZIP } from './_realfiles';
import { buildTar, buildZip, le, noise, tarEntry, type ZipEntrySpec } from './_fixtures';
import { cp437Decode } from './_zip';
import { zipCryptoEncrypt } from './_zipcrypto';

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

const run = (bytes: Uint8Array, opts: Record<string, unknown> = {}, name?: string) =>
  archive.run({ bytes, name }, { password: '', recursive: true, ...opts } as never);

const call = (bytes: Uint8Array, opts: Record<string, unknown> = {}, name?: string) =>
  Promise.resolve().then(() => run(bytes, opts, name));

function part<T extends Output['type']>(out: Output[], type: T): Extract<Output, { type: T }> {
  const found = out.find((o) => o.type === type);
  if (!found) throw new Error(`no ${type} block in ${out.map((o) => o.type).join(',')}`);
  return found as Extract<Output, { type: T }>;
}
const rows = (out: Output[]) => part(out, 'table').rows;
const filesOf = (out: Output[]) => part(out, 'files').files;
const entry = (out: Output[], key: string) => part(out, 'kv').entries.find(([k]) => k === key)?.[1];
const notes = (out: Output[]) =>
  out.flatMap((o) => (o.type === 'note' ? [`${o.level}: ${o.text}`] : []));
const fileText = (out: Output[], name: string) => {
  const f = filesOf(out).find((x) => x.name === name);
  if (!f)
    throw new Error(
      `no file ${name}: ${filesOf(out)
        .map((x) => x.name)
        .join(', ')}`,
    );
  return strFromU8(f.data);
};

const encrypt = (password: string) => (payload: Uint8Array, crc: number) => {
  const header = new Uint8Array(12);
  header.set(noise(11, 5));
  header[11] = crc >>> 24;
  return zipCryptoEncrypt(concatBytes(header, payload), utf8Encode(password));
};

describe('archive: the samples', () => {
  it('opens a ZIP hidden behind a PNG, at its real offset', async () => {
    const bytes = sample('forensics-polyglot.png');
    const out = await run(bytes);
    const zipAt = indexOfBytes(bytes, [0x50, 0x4b, 0x03, 0x04]);
    expect(entry(out, 'ZIP starts at')).toMatch(new RegExp(`^offset ${zipAt} `));
    expect(rows(out).map((r) => r[0])).toEqual(['flag.txt']);
    expect(fileText(out, 'flag.txt')).toBe('flag{binwalk_found_me}');
    expect(rows(out)[0]![4]).toMatch(/ok$/);
    expect(out.some((o) => o.type === 'text' && o.value === 'flag{binwalk_found_me}')).toBe(true);
  });

  it('unpacks zip > tar.gz > text and lists every layer', async () => {
    const out = await run(sample('forensics-nested.zip'));
    expect(entry(out, 'Archive comment')).toBe('layer 1 of 3');
    expect(rows(out).map((r) => r[0])).toEqual([
      'readme.txt',
      'inner.tar.gz',
      'inner.tar.gz/notes/flag.txt',
    ]);
    expect(rows(out)[1]![7]).toBe('one more layer');
    expect(fileText(out, 'inner.tar.gz/notes/flag.txt')).toBe('flag{matryoshka_archive}\n');
    expect(filesOf(out).find((f) => f.name === 'inner.tar.gz')?.note).toMatch(/another archive/);
  });

  it('stops at one level when asked, with a pointer to run it again', async () => {
    const out = await run(sample('forensics-nested.zip'), { recursive: false });
    expect(rows(out)).toHaveLength(2);
    expect(notes(out).join('\n')).toMatch(/inner\.tar\.gz" contains another archive/);
    expect(filesOf(out).map((f) => f.name)).toEqual(['readme.txt', 'inner.tar.gz']);
    // ...and the extracted layer opens by itself
    const layer = filesOf(out).find((f) => f.name === 'inner.tar.gz')!;
    const again = await run(layer.data, { recursive: false });
    expect(rows(again)[0]![0]).toBe('notes/flag.txt');
  });

  it('asks for the password, then decrypts with it', async () => {
    const bytes = sample('forensics-zipcrypto.zip');
    const locked = await run(bytes);
    expect(rows(locked).map((r) => [r[0], r[5]])).toEqual([
      ['readme.txt', 'no'],
      ['flag.txt', 'ZipCrypto'],
    ]);
    expect(rows(locked)[1]![8]).toMatch(/encrypted with ZipCrypto/);
    expect(filesOf(locked).map((f) => f.name)).toEqual(['readme.txt']);
    expect(notes(locked).join('\n')).toMatch(/warn: 1 encrypted entry \(ZipCrypto\)/);

    const open = await run(bytes, { password: 'infected' });
    expect(fileText(open, 'flag.txt')).toBe('flag{zip_crypto}');
    expect(rows(open)[1]![5]).toBe('ZipCrypto (decrypted)');
    expect(rows(open)[1]![4]).toMatch(/ok$/);
  });

  it('says the password is wrong instead of returning garbage', async () => {
    for (const password of ['wrong', 'Infected', 'infected ', 'x']) {
      const out = await run(sample('forensics-zipcrypto.zip'), { password });
      expect(notes(out).join('\n')).toMatch(/error: Wrong password: 1 encrypted entry/);
      expect(filesOf(out).map((f) => f.name)).toEqual(['readme.txt']);
      expect(rows(out)[1]![8]).toMatch(/wrong password/);
    }
  });
});

describe('archive: ZIPs made by real tools', () => {
  it('decrypts Info-ZIP output (data descriptor, time-based check byte)', async () => {
    const out = await run(ENCRYPTED_ZIP, { password: 'hunter2' });
    expect(fileText(out, 'flag.txt')).toBe('flag{real_zip_tool}');
    const bad = await run(ENCRYPTED_ZIP, { password: 'hunter3' });
    expect(bad.some((o) => o.type === 'files')).toBe(false);
    expect(notes(bad).join('\n')).toMatch(/Wrong password/);
  });

  it('reads comments, folders and sizes', async () => {
    const out = await run(COMMENTED_ZIP);
    expect(entry(out, 'Archive comment')).toBe('archive comment: flag{zip_comment}');
    expect(entry(out, 'Entries')).toBe('2 (2 files, 0 folders)');
    expect(rows(out).map((r) => [r[0], r[1]])).toEqual([
      ['hello.txt', 36],
      ['sub/deep.txt', 12],
    ]);
    expect(fileText(out, 'sub/deep.txt')).toBe('in a folder\n');
    expect(rows(out)[0]![6]).toMatch(/^20\d\d-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });

  it('reads a streamed ZIP whose sizes follow the data', async () => {
    const out = await run(STREAMED_ZIP);
    expect(fileText(out, 'stream1.txt')).toBe('streamed entry one '.repeat(5));
    expect(fileText(out, 'stream2.txt')).toBe('second streamed entry '.repeat(5));
    expect(notes(out).filter((n) => n.startsWith('warn'))).toEqual([]);
    // without its central directory it is rebuilt from the local headers
    const cdAt = indexOfBytes(STREAMED_ZIP, [0x50, 0x4b, 0x01, 0x02]);
    const recovered = await run(STREAMED_ZIP.subarray(0, cdAt));
    expect(entry(recovered, 'Central directory')).toMatch(/missing/);
    expect(fileText(recovered, 'stream2.txt')).toBe('second streamed entry '.repeat(5));
  });

  it('reads GNU tar (long names, symlinks) and pax tar inside gzip', async () => {
    const gnu = await run(GNU_TAR_GZ);
    expect(entry(gnu, 'Format')).toBe('TAR.GZ (tar inside gzip)');
    const long = `${'d'.repeat(60)}/sub/${'n'.repeat(60)}.txt`;
    expect(rows(gnu).map((r) => r[0])).toEqual(['short.txt', 'link', long]);
    expect(rows(gnu)[1]![8]).toMatch(/-> short\.txt; symlink 0777/);
    expect(fileText(gnu, long)).toBe('long name file\n');
    const pax = await run(PAX_TAR_GZ);
    expect(rows(pax).map((r) => r[0])).toEqual(['short.txt', long]);
    expect(fileText(pax, 'short.txt')).toBe('x\n');
  });
});

describe('archive: ZIP details', () => {
  const flagFile: ZipEntrySpec = { name: 'flag.txt', data: strToU8('flag{inside}') };

  it('shows hidden bytes between entries', async () => {
    const zip = buildZip([
      { ...flagFile, trailer: strToU8('SECRET-DATA-HERE-123') },
      { name: 'b.txt', data: strToU8('bbbb') },
    ]);
    const out = await run(zip);
    expect(notes(out).join('\n')).toMatch(
      /warn: 20 bytes at offset \d+ \(0x[0-9a-f]+\) between "flag.txt" and "b.txt" belong to no entry/,
    );
    expect(fileText(out, 'b.txt')).toBe('bbbb');
  });

  it('decrypts stored and deflated entries, and a password with accents', async () => {
    const zip = buildZip([
      {
        name: 'stored.txt',
        data: strToU8('flag{stored_secret}'),
        method: 0,
        encrypt: encrypt('pässwörd'),
      },
      {
        name: 'deflated.txt',
        data: strToU8('flag{deflated_secret} '.repeat(20)),
        encrypt: encrypt('pässwörd'),
      },
      { name: 'open.txt', data: strToU8('not encrypted') },
    ]);
    const out = await run(zip, { password: 'pässwörd' });
    expect(fileText(out, 'stored.txt')).toBe('flag{stored_secret}');
    expect(fileText(out, 'deflated.txt')).toBe('flag{deflated_secret} '.repeat(20));
    expect(fileText(out, 'open.txt')).toBe('not encrypted');
    expect(rows(out).map((r) => r[5])).toEqual([
      'ZipCrypto (decrypted)',
      'ZipCrypto (decrypted)',
      'no',
    ]);
  });

  it('reads a zip64 archive (sentinel values in the classic end record)', async () => {
    const plain = buildZip([
      { name: 'one.txt', data: strToU8('first') },
      { name: 'two.txt', data: strToU8('second') },
    ]);
    const eocdAt = indexOfBytes(plain, [0x50, 0x4b, 0x05, 0x06]);
    const cdSize = u32le(plain, eocdAt + 12);
    const cdOffset = u32le(plain, eocdAt + 16);
    const record = concatBytes(
      le(0x06064b50, 4),
      le(44, 8),
      le(45, 2),
      le(45, 2),
      le(0, 4),
      le(0, 4),
      le(2, 8),
      le(2, 8),
      le(cdSize, 8),
      le(cdOffset, 8),
    );
    const locator = concatBytes(le(0x07064b50, 4), le(0, 4), le(eocdAt, 8), le(1, 4));
    const eocd = concatBytes(
      le(0x06054b50, 4),
      le(0, 4),
      le(0xffff, 2),
      le(0xffff, 2),
      le(0xffffffff, 4),
      le(0xffffffff, 4),
      le(0, 2),
    );
    const zip64 = concatBytes(plain.subarray(0, eocdAt), record, locator, eocd);
    const out = await run(concatBytes(noise(50, 2), zip64));
    expect(entry(out, 'Format')).toBe('ZIP archive (zip64)');
    expect(rows(out).map((r) => r[0])).toEqual(['one.txt', 'two.txt']);
    expect(fileText(out, 'two.txt')).toBe('second');
    expect(notes(out).filter((n) => n.startsWith('warn'))).toEqual([]);
  });

  it('notes data after the archive and names that differ in the local header', async () => {
    const zip = buildZip([{ name: 'flag.txt', data: strToU8('flag{x}') }]).slice();
    const out = await run(concatBytes(zip, strToU8('APPENDED')));
    expect(entry(out, 'After the archive')).toMatch(/^8 more bytes from offset \d+/);
    const at = indexOfBytes(zip, strToU8('flag.txt'));
    zip.set(strToU8('flax'), at);
    const tampered = await run(zip);
    expect(rows(tampered)[0]![0]).toBe('flag.txt');
    expect(rows(tampered)[0]![8]).toContain('local header names it "flax.txt"');
  });

  it('prefers the Unicode Path extra field, and shows symlinks and AES strength', async () => {
    const name = strToU8('cafe.txt');
    const upath = concatBytes(Uint8Array.of(1), le(crc32(name), 4), strToU8('café.txt'));
    const aesExtra = concatBytes(
      le(0x9901, 2),
      le(7, 2),
      le(2, 2),
      strToU8('AE'),
      Uint8Array.of(3),
      le(8, 2),
    );
    const out = await run(
      buildZip([
        {
          name: 'cafe.txt',
          data: strToU8('x'),
          utf8: false,
          extra: concatBytes(le(0x7075, 2), le(upath.length, 2), upath),
        },
        { name: 'ln', data: strToU8('target.txt'), method: 0, unixMode: 0o120777 },
        { name: 'secret.bin', data: strToU8('zzzz'), aes: true, extra: aesExtra },
      ]),
    );
    expect(rows(out)[0]![0]).toBe('café.txt');
    expect(rows(out)[0]![8]).toContain('name from the Unicode Path extra field');
    expect(rows(out)[1]![8]).toContain('links to target.txt');
    expect(filesOf(out).map((f) => f.name)).toEqual(['café.txt']);
    expect(rows(out)[2]![5]).toBe('AES-256');
    expect(rows(out)[2]![3]).toBe('AES + deflate');
  });

  it('lists unknown extra fields with their content', async () => {
    const extra = concatBytes(le(0x1337, 2), le(17, 2), strToU8('flag{extra_field}'));
    const out = await run(buildZip([{ ...flagFile, extra }]));
    expect(rows(out)[0]![8]).toContain('unknown 0x1337 (17 bytes: "flag{extra_field}")');
  });

  it('decodes UTF-8 and code page 437 names', async () => {
    const out = await run(
      buildZip([
        { name: 'héllo.txt', data: strToU8('a') },
        {
          name: '',
          rawName: Uint8Array.of(0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74),
          utf8: false,
          data: strToU8('b'),
        },
      ]),
    );
    expect(rows(out).map((r) => r[0])).toEqual(['héllo.txt', 'café.txt']);
    expect(cp437Decode(Uint8Array.of(0x80, 0xe1, 0xff))).toBe('Çß\u00a0');
    expect(cp437Decode(Uint8Array.from({ length: 128 }, (_, i) => 128 + i))).toHaveLength(128);
  });

  it('never extracts outside: ../ and absolute paths are cleaned and flagged', async () => {
    const out = await run(
      buildZip([
        { name: '../../etc/cron.d/evil', data: strToU8('x') },
        { name: '/abs/path.txt', data: strToU8('y') },
        { name: 'C:\\win\\file.txt', data: strToU8('z') },
      ]),
    );
    expect(filesOf(out).map((f) => f.name)).toEqual([
      'etc/cron.d/evil',
      'abs/path.txt',
      'win/file.txt',
    ]);
    expect(filesOf(out).every((f) => f.note?.includes('outside the folder'))).toBe(true);
    expect(rows(out)[0]![0]).toBe('../../etc/cron.d/evil');
    expect(safeName('a/./b//c')).toEqual({ name: 'a/b/c', unsafe: false });
    expect(safeName('..')).toEqual({ name: 'unnamed', unsafe: true });
    expect(safeName('a\u0001b').name).toBe('a?b');
  });

  it('points out WinZip AES instead of failing', async () => {
    const out = await run(
      buildZip([
        { ...flagFile, aes: true },
        { name: 'ok.txt', data: strToU8('fine') },
      ]),
    );
    expect(rows(out)[0]![5]).toBe('AES');
    expect(rows(out)[0]![8]).toMatch(/WinZip AES encryption is not supported yet/);
    expect(notes(out).join('\n')).toMatch(
      /warn: 1 entry uses WinZip AES encryption, which is not supported yet/,
    );
    expect(fileText(out, 'ok.txt')).toBe('fine');
  });

  it('reports a CRC mismatch but still gives the data', async () => {
    const zip = buildZip([{ name: 'a.txt', data: strToU8('0123456789'), method: 0 }]).slice();
    zip[30 + 5 + 3] = zip[30 + 5 + 3]! ^ 0xff; // a data byte of the stored entry
    const out = await run(zip);
    expect(rows(out)[0]![8]).toMatch(/CRC-32 mismatch/);
    expect(filesOf(out)).toHaveLength(1);
  });

  it('survives a cut-off archive: entries before the cut are recovered', async () => {
    const zip = buildZip([
      { name: 'one.txt', data: strToU8('first '.repeat(40)) },
      { name: 'two.txt', data: strToU8('second '.repeat(40)) },
    ]);
    const second = indexOfBytes(zip, strToU8('two.txt')) - 30;
    const out = await run(zip.subarray(0, second + 40));
    expect(entry(out, 'Central directory')).toMatch(/missing/);
    expect(fileText(out, 'one.txt')).toBe('first '.repeat(40));
  });

  it('opens a stored ZIP-in-ZIP and ZIPs behind ZIPs', async () => {
    const inner = buildZip([{ name: 'in.txt', data: strToU8('flag{inner}') }]);
    const outer = buildZip([{ name: 'inner.zip', data: inner, method: 0 }]);
    const out = await run(concatBytes(noise(300, 3), outer));
    expect(fileText(out, 'inner.zip/in.txt')).toBe('flag{inner}');
  });

  it('copes with many entries', async () => {
    const many = buildZip(
      Array.from({ length: 3000 }, (_, i) => ({
        name: `f${i}.txt`,
        data: strToU8(`n${i}`),
        method: 0 as const,
      })),
    );
    const t0 = performance.now();
    const out = await run(many);
    expect(rows(out)).toHaveLength(3000);
    expect(fileText(out, 'f2999.txt')).toBe('n2999');
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe('archive: GZIP, TAR, zlib, deflate', () => {
  it('reads GZIP with its header fields and warns about trailing data', async () => {
    const gz = gzipSync(strToU8('flag{from_gzip}'), {
      filename: 'secret.txt',
      mtime: 1700000000000,
    });
    const out = await run(concatBytes(gz, strToU8('TRAILING-JUNK')));
    expect(entry(out, 'Format')).toBe('GZIP');
    expect(entry(out, 'Original name')).toBe('secret.txt');
    expect(entry(out, 'Modified')).toBe('2023-11-14 22:13:20Z');
    expect(fileText(out, 'secret.txt')).toBe('flag{from_gzip}');
    expect(notes(out).join('\n')).toMatch(/warn: 13 bytes follow the GZIP stream/);
  });

  it('names a nameless gzip after the input file, and joins members', async () => {
    const two = concatBytes(
      gzipSync(strToU8('part one, '), { mtime: 0 }),
      gzipSync(strToU8('part two'), { mtime: 0 }),
    );
    const out = await run(two, {}, 'notes.txt.gz');
    expect(entry(out, 'Format')).toBe('GZIP (2 members)');
    expect(fileText(out, 'notes.txt')).toBe('part one, part two');
  });

  it('warns when the gzip trailer does not match', async () => {
    const gz = gzipSync(strToU8('integrity matters'), { mtime: 0 }).slice();
    gz[gz.length - 8] = gz[gz.length - 8]! ^ 1; // CRC-32
    const out = await run(gz);
    expect(notes(out).join('\n')).toMatch(/CRC-32 or size in the GZIP trailer does not match/);
    expect(filesOf(out)).toHaveLength(1);
  });

  it('lists a plain TAR and hands over every file', async () => {
    const tar = buildTar([
      ['a.txt', strToU8('alpha')],
      ['dir/b.txt', strToU8('beta '.repeat(300))],
    ]);
    const out = await run(concatBytes(tar, strToU8('after')));
    expect(entry(out, 'Format')).toBe('TAR archive');
    expect(entry(out, 'Entries')).toBe('2 (2 files, 0 folders)');
    expect(rows(out)[1]).toEqual([
      'dir/b.txt',
      1500,
      '-',
      'stored (tar)',
      expect.stringMatching(/^[0-9a-f]{8}$/),
      '-',
      '2023-11-14 22:13:20Z',
      '',
      expect.stringContaining('file 0644 user/group'),
    ]);
    expect(fileText(out, 'dir/b.txt')).toBe('beta '.repeat(300));
    expect(notes(out).join('\n')).toMatch(/5 bytes follow the end of the TAR/);
  });

  it('shows a directory entry of a TAR without making a file of it', async () => {
    const tar = concatBytes(
      tarEntry('folder/', new Uint8Array(0), '5'),
      tarEntry('folder/x.txt', strToU8('x')),
      new Uint8Array(1024),
    );
    const out = await run(tar);
    expect(rows(out).map((r) => r[0])).toEqual(['folder/', 'folder/x.txt']);
    expect(filesOf(out).map((f) => f.name)).toEqual(['folder/x.txt']);
  });

  it('opens zlib streams and raw deflate, and checks the Adler-32', async () => {
    const z = await run(zlibSync(strToU8('flag{zlib_ok}')));
    expect(entry(z, 'Format')).toBe('zlib stream');
    expect(fileText(z, 'data')).toBe('flag{zlib_ok}');
    expect(rows(z)[0]![8]).toBe('Adler-32 ok');
    const raw = await run(inflateRawFixture('flag{raw_deflate}'));
    expect(entry(raw, 'Format')).toBe('raw deflate stream (no header)');
    expect(fileText(raw, 'data')).toBe('flag{raw_deflate}');
  });

  it('reads gzip inside zlib inside zip, level by level', async () => {
    const layered = buildZip([
      {
        name: 'a.gz',
        data: gzipSync(zlibSync(strToU8('flag{deep}')), { filename: 'b.z', mtime: 0 }),
        method: 0,
      },
    ]);
    const out = await run(layered);
    expect(fileText(out, 'a.gz/b.z/b')).toBe('flag{deep}');
  });
});

describe('archive: recognising and refusing', () => {
  it('sniffs the formats it supports', () => {
    expect(sniff(sample('forensics-nested.zip'))).toBe('zip');
    expect(sniff(sample('forensics-polyglot.png'))).toBe('zip-embedded');
    expect(sniff(sample('forensics-polyglot.png'), true)).toBeNull();
    expect(sniff(gzipSync(strToU8('x')))).toBe('gzip');
    expect(sniff(buildTar([['a', strToU8('b')]]))).toBe('tar');
    expect(sniff(zlibSync(strToU8('zlib')))).toBe('zlib');
    expect(sniff(noise(2000, 3))).toBeNull();
    expect(sniff(strToU8('just some text, nothing to unpack'))).toBeNull();
  });

  it('names formats it cannot open and tells how', async () => {
    await expect(
      call(Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 0, 0, 0, 0)),
    ).rejects.toThrow(/7-Zip archive.*7z x/);
    await expect(call(utf8Encode('Rar!\x1a\x07\x00 and more bytes'))).rejects.toThrow(
      /RAR archive/,
    );
  });

  it('explains when the input is not an archive, or is empty', async () => {
    await expect(call(utf8Encode('hello there, this is only text'))).rejects.toThrow(ToolError);
    await expect(call(utf8Encode('hello there, this is only text'))).rejects.toThrow(/Carve/);
    await expect(call(new Uint8Array(0))).rejects.toThrow(ToolError);
  });

  it('reports a damaged nested archive instead of failing everything', async () => {
    const broken = gzipSync(strToU8('payload payload payload'), { mtime: 0 }).slice(0, 20);
    const zip = buildZip([
      { name: 'ok.txt', data: strToU8('fine') },
      { name: 'bad.gz', data: broken, method: 0 },
    ]);
    const out = await run(zip);
    expect(fileText(out, 'ok.txt')).toBe('fine');
    expect(notes(out).join('\n')).toMatch(/bad\.gz: could not be opened as an archive/);
  });

  it('detect() recommends it for ZIP, GZIP, TAR and a ZIP behind a PNG', () => {
    const d = (bytes: Uint8Array) => archive.detect?.({ text: null, bytes });
    expect(d(sample('forensics-nested.zip'))?.score).toBeGreaterThanOrEqual(0.85);
    expect(d(gzipSync(strToU8('hello')))?.score).toBeGreaterThanOrEqual(0.85);
    expect(d(buildTar([['a', strToU8('b')]]))?.score).toBeGreaterThanOrEqual(0.8);
    expect(d(sample('forensics-polyglot.png'))?.score).toBeGreaterThanOrEqual(0.6);
    expect(d(noise(3000, 9))).toBeNull();
  });
});

/** Raw deflate (no header) of a string. */
function inflateRawFixture(text: string): Uint8Array {
  const z = zlibSync(strToU8(text));
  return z.subarray(2, z.length - 4);
}
