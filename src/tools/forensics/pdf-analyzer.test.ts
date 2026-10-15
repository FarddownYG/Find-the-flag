import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { defaultOptions } from '../../core/registry';
import type { Output } from '../../core/types';
import { encode as encodeJpeg } from 'jpeg-js';
import { latin1Decode } from '../../lib/bytes';
import tool from './pdf-analyzer';
import {
  buildBrokenXref,
  buildEmbeddedJs,
  buildEncryptedPassword,
  buildEncryptedRc4,
  buildInvisibleText,
  buildObjectStream,
  buildRevisions,
  buildSamples,
} from './_pdf-fixtures';
import { bytesOf, flate, join, PdfWriter, simpleDocument } from './_pdf-kit';
import { ENCRYPTED_VECTORS } from './_pdf-vectors';

type Labelled = Exclude<Output, { type: 'note' }>;
type Block<T extends Labelled['type']> = Extract<Labelled, { type: T }>;

async function run(bytes: Uint8Array, options: Record<string, unknown> = {}): Promise<Output[]> {
  const o = { ...defaultOptions(tool as never), ...options } as never;
  return tool.run({ bytes, name: 'test.pdf' }, o);
}

const blocks = <T extends Labelled['type']>(out: Output[], type: T): Block<T>[] =>
  out.filter((b): b is Block<T> => b.type === type);
const byLabel = <T extends Labelled['type']>(out: Output[], type: T, label: RegExp | string) =>
  blocks(out, type).find((b) =>
    typeof label === 'string' ? b.label === label : label.test(b.label ?? ''),
  );
const kvOf = (out: Output[], label: string): Record<string, string> =>
  Object.fromEntries(byLabel(out, 'kv', label)?.entries ?? []);
const tableOf = (out: Output[], label: string) => byLabel(out, 'table', label);
const textOf = (out: Output[], label: RegExp | string) => byLabel(out, 'text', label)?.value;
const notes = (out: Output[]) => out.flatMap((b) => (b.type === 'note' ? [b.text] : []));

describe('PDF analyzer: the samples, decoded exactly', () => {
  it('pdf-revisions: the first revision says FTF{old_revision}, the update replaced it', async () => {
    const bytes = buildRevisions();
    const out = await run(bytes);
    expect(kvOf(out, 'PDF file')['Revisions']).toBe('2');
    const revs = tableOf(out, 'Revisions (saves) in the file')!;
    expect(revs.rows.map((r) => [r[0], r[1], r[3]])).toEqual([
      [1, '0–801 · 801 B', 6],
      [2, '801–1209 · 408 B', 2],
    ]);
    expect(revs.rows[0]![4]).toBe(''); // the original file adds everything: not listed
    expect(String(revs.rows[1]![5])).toContain('4 page 1 content');
    expect(String(revs.rows[1]![5])).toContain('6 Info');
    expect(textOf(out, /^Revision 1, page 1/)).toBe('FTF{old_revision}');
    expect(textOf(out, 'Page 1')).toBe('Nothing to see here');
    expect(notes(out).some((n) => n.startsWith('Revisions in the file: 2'))).toBe(true);
    // the first revision is offered as a PDF of its own, byte for byte
    const files = byLabel(out, 'files', 'Earlier revisions, each as a PDF file')!;
    expect(files.files.map((f) => f.name)).toEqual(['revision-1.pdf']);
    expect(files.files[0]!.data).toEqual(bytes.subarray(0, 801));
    const again = await run(files.files[0]!.data);
    expect(textOf(again, 'Page 1')).toBe('FTF{old_revision}');
    expect(kvOf(again, 'PDF file')['Revisions']).toBe('1');
  });

  it('pdf-embedded-js: embedded file, JavaScript, link and form field', async () => {
    const out = await run(buildEmbeddedJs());
    const files = byLabel(out, 'files', 'Embedded files, to download')!;
    expect(files.files).toHaveLength(1);
    expect(files.files[0]!.name).toBe('hidden-note.txt');
    expect(latin1Decode(files.files[0]!.data)).toBe(
      'FTF{embedded_file}\nThis note travels inside the PDF.\n',
    );
    const embedded = tableOf(out, 'Embedded files')!;
    expect(embedded.rows[0]).toEqual([
      'hidden-note.txt',
      53,
      'text/plain',
      'A note',
      'FTF{embedded_file} This note travels inside the PDF.',
      '/Root/Names/EmbeddedFiles/Names[1]',
    ]);
    const js = tableOf(out, 'JavaScript')!;
    expect(js.rows.map((r) => [r[0], r[4]])).toEqual([
      [9, '/Root/OpenAction'],
      [11, '/Root/Names/JavaScript/Names[1]'],
    ]);
    expect(textOf(out, 'JavaScript of object 9 (not run)')).toBe("app.alert('demo');");
    expect(textOf(out, 'JavaScript of object 11 (not run)')).toBe(
      "this.getField('note').value = 'demo';",
    );
    expect(tableOf(out, 'Actions and links')!.rows).toEqual([
      ['URI', 'https://example.com/ftf-demo', '/Root/Pages/Kids[0]/Annots[1]/A'],
    ]);
    expect(tableOf(out, 'Form fields')!.rows).toEqual([
      ['note', 'text', 'FTF{form_value}', 'default text', ''],
    ]);
    const counts = Object.fromEntries(
      tableOf(out, 'pdfid-style keyword counts')!.rows.map((r) => [r[0], [r[1], r[2]]]),
    );
    expect(counts['/JS']).toEqual([2, 2]);
    expect(counts['/OpenAction']).toEqual([1, 1]);
    expect(counts['/EmbeddedFile']).toEqual([1, 1]);
    expect(counts['/URI']).toEqual([2, 2]);
    expect(notes(out)).toContain(
      'Scripts with JavaScript found: 2. They are decoded below and never run.',
    );
  });

  it('pdf-invisible-text: five hidden pieces, each with its reason', async () => {
    const out = await run(buildInvisibleText());
    const hidden = tableOf(out, 'Hidden text')!;
    expect(hidden.rows.map((r) => [r[2], r[1]])).toEqual([
      ['FTF{invisible_text}', 'render mode 3 (invisible)'],
      ['FTF{white_text}', 'white fill'],
      ['FTF{tiny_text}', 'font smaller than 2 points'],
      ['FTF{offpage_text}', 'outside the page'],
      ['FTF{covered_text}', 'covered by a filled shape drawn later'],
    ]);
    expect(hidden.rows.map((r) => r[0])).toEqual([1, 1, 1, 1, 1]);
    expect(textOf(out, 'Page 1')).toBe('Public page: nothing to see\nThe box above hides a line');
  });

  it('pdf-objstm: the packed Info dictionary gives up its secret', async () => {
    const out = await run(buildObjectStream());
    expect(kvOf(out, 'Document information (Info dictionary)')).toEqual({
      Title: 'Packed',
      'Secret (custom)': 'FTF{object_stream}',
      Producer: 'hand-made',
    });
    expect(tableOf(out, 'Object streams')!.rows).toEqual([[5, 5, '1 2 3 6 7']]);
    expect(kvOf(out, 'PDF file')['Structure']).toBe('xref streams (PDF 1.5)');
    const objects = tableOf(out, 'Objects')!;
    const packed = objects.rows.filter((r) => String(r[2]).startsWith('in object stream'));
    expect(packed.map((r) => [r[0], r[2], r[3]])).toEqual([
      [1, 'in object stream 5, #0', 'Catalog'],
      [2, 'in object stream 5, #1', 'Pages'],
      [3, 'in object stream 5, #2', 'Page'],
      [6, 'in object stream 5, #3', 'Font/Type1'],
      [7, 'in object stream 5, #4', 'Info'],
    ]);
    // nothing is "unreferenced": the object stream and the xref stream are structure
    expect(notes(out).some((n) => n.includes('nothing in the document points to'))).toBe(false);
  });

  it('pdf-encrypted-rc4: opened with the empty password, every string decrypted', async () => {
    const out = await run(buildEncryptedRc4());
    expect(textOf(out, 'Page 1')).toBe('FTF{rc4_encrypted}');
    const enc = kvOf(out, 'Encryption');
    expect(enc['Security handler']).toBe('Standard');
    expect(enc['Handler version (V)']).toBe('2');
    expect(enc['Handler revision (R)']).toBe('3');
    expect(enc['Key length']).toBe('128 bits');
    expect(enc['Allowed']).toBe('print, accessibility, print in high quality');
    expect(enc['Status']).toBe('opened with the empty user password');
    expect(kvOf(out, 'Document information (Info dictionary)')['Title']).toBe(
      'Encrypted with an empty password',
    );
    expect(notes(out)[0]).toBe('Encrypted with RC4 128; opened with the empty user password.');
  });

  it('pdf-broken-xref: rebuilt, with the comment and the data after %%EOF', async () => {
    const out = await run(buildBrokenXref());
    expect(textOf(out, 'Page 1')).toBe('FTF{rebuilt_xref}');
    expect(kvOf(out, 'PDF file')['Structure']).toBe(
      'rebuilt by scanning the file (no usable xref)',
    );
    expect(notes(out).some((n) => n.startsWith('The xref tables do not match the objects'))).toBe(
      true,
    );
    expect(tableOf(out, 'Comments and unexplained data between the objects')!.rows).toEqual([
      [64, 'comment', '% FTF{comment_between_objects}'],
    ]);
    const after = byLabel(out, 'bytes', 'Data after the last %%EOF')!;
    expect(latin1Decode(after.value)).toBe('FTF{after_eof}');
    expect(after.filename).toBe('after-eof.bin');
  });

  it('the samples on disk are the ones the fixtures build', () => {
    for (const { name, bytes } of buildSamples()) {
      const onDisk = new Uint8Array(
        readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)),
      );
      expect(onDisk, name).toEqual(bytes);
    }
  });
});

describe('PDF analyzer: encrypted files from another implementation', () => {
  it.each(Object.entries(ENCRYPTED_VECTORS))('%s', async (_name, v) => {
    const out = await run(v.bytes, { password: v.password });
    expect(textOf(out, 'Page 1')).toBe(v.flag);
    expect(kvOf(out, 'Encryption')['Status']).toBe(
      v.password ? 'opened with your password' : 'opened with the empty user password',
    );
    expect(kvOf(out, 'Document information (Info dictionary)')['Title']).toMatch(/^Title /);
  });

  it('says clearly when a password is needed, and still shows the structure', async () => {
    const v = ENCRYPTED_VECTORS['aes-256-pw']!;
    const out = await run(v.bytes);
    expect(notes(out)[0]).toMatch(
      /^This PDF is encrypted \(AESV3\) and the empty user password does not open it\./,
    );
    expect(kvOf(out, 'Encryption')['Status']).toBe('locked: a password is needed');
    expect(kvOf(out, 'Encryption')['Handler revision (R)']).toBe('6');
    expect(textOf(out, 'Page 1')).toBeUndefined();
    expect(tableOf(out, 'Objects')!.rows.length).toBeGreaterThan(3);
    // nothing is read from the ciphertext, and a locked file is not called a scan
    expect(byLabel(out, 'kv', 'Document information (Info dictionary)')).toBeUndefined();
    expect(notes(out).some((n) => n.startsWith('No page has text'))).toBe(false);
    const wrong = await run(v.bytes, { password: 'nope' });
    expect(notes(wrong)[0]).toMatch(/does not open it/);
  });

  it('pdf-encrypted-password: the hand-made RC4 file needs its user password', async () => {
    const bytes = buildEncryptedPassword();
    const locked = await run(bytes);
    expect(textOf(locked, 'Page 1')).toBeUndefined();
    expect(notes(locked)[0]).toMatch(
      /^This PDF is encrypted \(RC4 128\) and the empty user password/,
    );
    expect(byLabel(locked, 'kv', 'Document information (Info dictionary)')).toBeUndefined();
    expect(notes(locked).some((n) => n.startsWith('No page has text'))).toBe(false);
    const wrong = await run(bytes, { password: 'demo124' });
    expect(textOf(wrong, 'Page 1')).toBeUndefined();
    const open = await run(bytes, { password: 'demo123' });
    expect(textOf(open, 'Page 1')).toBe('FTF{password_ok}');
    expect(kvOf(open, 'Encryption')['Status']).toBe('opened with your password');
    expect(kvOf(open, 'Document information (Info dictionary)')['Title']).toBe(
      'Locked with a user password',
    );
  });

  it('reports a security handler it cannot open', async () => {
    const w = simpleDocument('BT /F1 12 Tf 10 10 Td (hello) Tj ET');
    w.object(6, '<< /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 >>');
    w.xref([1, 2, 3, 4, 5, 6], '/Size 7 /Root 1 0 R /Encrypt 6 0 R');
    const out = await run(w.bytes());
    expect(notes(out)[0]).toBe(
      'This PDF uses an encryption this tool cannot open (security handler Adobe.PubSec). The structure is shown, the strings and streams stay encrypted.',
    );
    expect(kvOf(out, 'Encryption')['Status']).toBe(
      'cannot be opened (security handler Adobe.PubSec)',
    );
  });
});

describe('PDF analyzer: scanned pages', () => {
  it('shows the OCR layer with the text of its page and does not call it hidden text', async () => {
    const w = new PdfWriter();
    w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    w.object(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im 6 0 R >> >> >>',
    );
    w.stream(
      4,
      '',
      'q 300 0 0 200 0 0 cm /Im Do Q\nBT /F1 12 Tf 3 Tr 20 100 Td (FTF{scanned_words}) Tj ET',
    );
    w.object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    w.stream(
      6,
      '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8',
      '\u0000',
    );
    w.xref([1, 2, 3, 4, 5, 6], '/Size 7 /Root 1 0 R');
    const out = await run(w.bytes());
    expect(textOf(out, 'Page 1')).toBe('FTF{scanned_words}');
    expect(byLabel(out, 'table', 'Hidden text')).toBeUndefined();
    expect(notes(out)).toContain(
      'Invisible text over page images, like the OCR layer of a scanned document: 1. It is shown with the text of its page.',
    );
    expect(notes(out).some((n) => n.startsWith('Hidden text'))).toBe(false);
    expect(notes(out).some((n) => n.startsWith('No page has text'))).toBe(false);
  });
});

describe('PDF analyzer: options', () => {
  it('inspects one object as of a given revision, with its stream and every version', async () => {
    const bytes = buildRevisions();
    const out = await run(bytes, { object: 4, revision: 1 });
    const info = kvOf(out, 'Object 4');
    expect(info['Revision shown']).toBe('1 / 2');
    expect(info['Where']).toBe('248');
    expect(info['Used by']).toBe('content of page 1');
    const data = byLabel(out, 'bytes', /^Stream data/)!;
    expect(latin1Decode(data.value)).toBe('BT /F1 18 Tf 20 100 Td (FTF{old_revision}) Tj ET');
    expect(data.filename).toBe('object-4.txt');
    const versions = tableOf(out, 'Every version of this object in the file')!;
    expect(versions.rows.map((r) => [r[0], r[1]])).toEqual([
      [1, 248],
      [2, 801],
    ]);
    const last = await run(bytes, { object: 4 });
    expect(latin1Decode(byLabel(last, 'bytes', /^Stream data/)!.value)).toBe(
      'BT /F1 18 Tf 20 100 Td (Nothing to see here) Tj ET',
    );
    await expect(run(bytes, { object: 4, revision: 9 })).rejects.toThrow(ToolError);
  });

  it('inspects an object that is not there, and a packed one', async () => {
    const out = await run(buildRevisions(), { object: 77 });
    expect(kvOf(out, 'Object 77')['State']).toBe('not defined in this revision');
    const packed = await run(buildObjectStream(), { object: 7 });
    expect(kvOf(packed, 'Object 7')['Where']).toBe('in object stream 5, #4');
    expect(textOf(packed, 'Object 7: source')).toContain('/Secret (FTF{object_stream})');
  });

  it('searches the decoded streams and the objects, plain text or /regex/', async () => {
    const bytes = buildBrokenXref();
    const plain = await run(bytes, { search: 'rebuilt_xref' });
    const table = tableOf(plain, 'Search: rebuilt_xref')!;
    expect(table.rows.map((r) => [r[0], r[1]])).toEqual([[4, 'decoded stream']]);
    expect(String(table.rows[0]![3])).toContain('(FTF{rebuilt_xref}) Tj');
    const regex = await run(bytes, { search: '/FTF\\{\\w+\\}/' });
    expect(tableOf(regex, 'Search: /FTF\\{\\w+\\}/')!.rows).toHaveLength(1);
    const none = await run(bytes, { search: 'zzz' });
    expect(notes(none)).toContain('Nothing found for zzz in the decoded streams and objects.');
    await expect(run(bytes, { search: '/(unclosed/' })).rejects.toThrow(ToolError);
  });

  it('lists every stream as a file on request', async () => {
    const out = await run(buildEmbeddedJs(), { all: true });
    const files = byLabel(out, 'files', 'All streams, decoded')!;
    expect(files.files.map((f) => f.name)).toEqual([
      'object-4.txt',
      'object-8.txt',
      'object-13.txt',
    ]);
    expect(latin1Decode(files.files[2]!.data)).toBe("this.getField('note').value = 'demo';");
  });

  it('ignores the xref when asked', async () => {
    const out = await run(buildRevisions(), { rebuild: true });
    expect(kvOf(out, 'PDF file')['Structure']).toBe(
      'rebuilt by scanning the file (no usable xref)',
    );
    expect(notes(out)).toContain(
      'As requested, the xref is ignored: the objects were found by scanning the file for "n g obj".',
    );
    // without the xref, the revisions are told apart by their %%EOF
    expect(textOf(out, /^Revision 1, page 1/)).toBe('FTF{old_revision}');
    expect(textOf(out, 'Page 1')).toBe('Nothing to see here');
  });
});

describe('PDF analyzer: odd and hostile files', () => {
  it('refuses what is not a PDF, with a way forward', async () => {
    await expect(run(new Uint8Array(0))).rejects.toThrow('Drop a PDF file');
    await expect(run(bytesOf('hello world, not a pdf at all'))).rejects.toThrow(
      /does not look like a PDF/,
    );
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    await expect(run(png)).rejects.toThrow(ToolError);
  });

  it('finds a flag in a stream a damaged file hides behind a wrong /Length', async () => {
    const w = new PdfWriter();
    w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    w.object(2, '<< /Type /Pages /Kids [] /Count 0 >>');
    w.stream(3, '/Filter /FlateDecode', flate('FTF{found_behind_length}'), 0, '4');
    w.xref([1, 2, 3], '/Size 4 /Root 1 0 R');
    const out = await run(w.bytes(), { search: 'FTF' });
    expect(tableOf(out, 'Search: FTF')!.rows.map((r) => r[0])).toEqual([3]);
    expect(notes(out)).toContain(
      'Streams whose /Length does not match the data: 1. Some readers ignore the bytes after the declared length.',
    );
  });

  it('offers images in a codec it cannot decode as raw files, and says what they are', async () => {
    const pixels = Uint8Array.from({ length: 8 * 8 * 4 }, (_, i) => (i * 13) & 255);
    const jpeg = Uint8Array.from(encodeJpeg({ data: pixels, width: 8, height: 8 }, 90).data);
    const jp2 = Uint8Array.from([
      0, 0, 0, 12, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a, 1, 2, 3,
    ]);
    const w = new PdfWriter();
    w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    w.object(2, '<< /Type /Pages /Kids [] /Count 0 >>');
    const image = (codec: string) =>
      `/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/FlateDecode /${codec}]`;
    w.stream(3, image('DCTDecode'), flate(jpeg));
    w.stream(4, image('JPXDecode'), flate(jp2));
    w.stream(
      5,
      '/Type /XObject /Subtype /Image /Width 8 /Height 8 /Filter /CCITTFaxDecode',
      'ccitt bytes',
    );
    w.stream(
      6,
      '/Type /XObject /Subtype /Image /Width 8 /Height 8 /Filter /JBIG2Decode',
      'jbig2 bytes',
    );
    w.xref([1, 2, 3, 4, 5, 6], '/Size 7 /Root 1 0 R');
    const out = await run(w.bytes());
    const files = byLabel(out, 'files', 'Images as files')!;
    expect(files.files.map((f) => f.name)).toEqual([
      'object-3.jpg',
      'object-4.jp2',
      'object-5.ccitt',
      'object-6.jb2',
    ]);
    expect(files.files[0]!.data).toEqual(jpeg);
    expect(files.files[1]!.data).toEqual(jp2);
    expect(latin1Decode(files.files[2]!.data)).toBe('ccitt bytes');
    const rows = tableOf(out, 'Streams')!.rows;
    expect(String(rows[0]![8])).toBe('image 8×8, jpeg codec: the stored bytes are an image file');
    expect(rows[0]![3]).toBe('Flate+DCT');
    expect(rows[0]![6]).toBe('JPEG image');
  });

  it('stops a decompression bomb and says so', async () => {
    const w = new PdfWriter();
    w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    w.object(2, '<< /Type /Pages /Kids [] /Count 0 >>');
    w.stream(3, '/Filter /FlateDecode', flate(new Uint8Array(200 * 1024 * 1024)));
    w.xref([1, 2, 3], '/Size 4 /Root 1 0 R');
    const started = Date.now();
    const out = await run(w.bytes());
    expect(Date.now() - started).toBeLessThan(10_000);
    const row = tableOf(out, 'Streams')!.rows[0]!;
    expect(row[5]).toBe(`${4 * 1024 * 1024}+`);
  });

  it('copes with many objects, absurd nesting and a hostile object stream', async () => {
    const w = new PdfWriter();
    w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    w.object(2, '<< /Type /Pages /Kids [] /Count 0 >>');
    for (let n = 3; n < 20_003; n++) w.object(n, `<< /N ${n} >>`);
    w.object(20_003, `${'['.repeat(20_000)}`);
    w.stream(20_004, '/Type /ObjStm /N 999999999 /First 5', '1 0 2 0 null');
    const nums = Array.from({ length: 20_004 }, (_, i) => i + 1);
    w.xref(nums, '/Size 20005 /Root 1 0 R');
    const started = Date.now();
    const out = await run(w.bytes());
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(tableOf(out, 'Objects')!.rows).toHaveLength(5000);
    expect(notes(out).some((n) => n.startsWith('Showing 5000 of'))).toBe(true);
  });

  it('does not slow down on thousands of streams that never end', async () => {
    let body = '%PDF-1.4\n';
    for (let n = 1; n <= 30_000; n++) body += `${n} 0 obj\n<< /Length 99999 >>\nstream\nabc\n`;
    const started = Date.now();
    const out = await run(bytesOf(body));
    expect(Date.now() - started).toBeLessThan(8000);
    expect(out.length).toBeGreaterThan(5);
  });

  it('offers the bytes in front of the header, and reads xref offsets from the header on', async () => {
    const out = await run(join(bytesOf('% FTF{in_the_header}\n'), buildRevisions()));
    const leading = byLabel(out, 'bytes', 'Data before the %PDF- header')!;
    expect(latin1Decode(leading.value)).toBe('% FTF{in_the_header}\n');
    expect(kvOf(out, 'PDF file')['Structure']).toBe('classic xref tables');
    expect(kvOf(out, 'PDF file')['Revisions']).toBe('2');
    expect(notes(out)).toContain('21 B of data before the %PDF- header. It is offered below.');
  });

  it('reads bytes before the header and offers them', async () => {
    const junk = bytesOf('X'.repeat(1500) + 'FTF{before_header}\n');
    const out = await run(join(junk, buildRevisions()));
    // a header further than 1024 bytes in: not a header any reader accepts, the scan still works
    expect(textOf(out, 'Page 1')).toBe('Nothing to see here');
  });
});

describe('PDF analyzer: triage', () => {
  it('recognises a PDF by its header, a renamed one by its extension only weakly', () => {
    const d = (bytes: Uint8Array, name?: string) => tool.detect!({ text: null, bytes, name });
    expect(d(buildRevisions())?.score).toBeGreaterThan(0.8);
    expect(d(bytesOf('plain text'), 'a.txt')).toBeNull();
    expect(d(bytesOf('not really'), 'x.PDF')?.score).toBeLessThan(0.6);
  });
});
