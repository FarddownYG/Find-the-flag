import { describe, expect, it } from 'vitest';
import { isDict, isString, stringText } from './_pdf-lex';
import { PdfDoc } from './_pdf-doc';
import {
  buildBrokenXref,
  buildEncryptedRc4,
  buildEmbeddedJs,
  buildInvisibleText,
  buildObjectStream,
  buildRevisions,
} from './_pdf-fixtures';
import { bytesOf, join, PdfWriter, simpleDocument } from './_pdf-kit';
import { ENCRYPTED_VECTORS } from './_pdf-vectors';
import { latin1Decode } from '../../lib/bytes';

type Doc = PdfDoc;
const text = (b: Uint8Array) => latin1Decode(b);

/** The decoded content stream (object 4) as a given revision saw it. */
function contentAt(doc: Doc, revision: number): string {
  const rev = doc.revisions[revision - 1]!;
  const rec = doc.getRecord(4, doc.viewOf(rev));
  if (!rec) throw new Error('object 4 is not there');
  return text(doc.decode(rec).data);
}

describe('PdfDoc: a classic file with one update', () => {
  it('lists two revisions with their own byte ranges and views', async () => {
    const bytes = buildRevisions();
    const doc = await PdfDoc.open(bytes);
    expect(doc.version).toBe('1.7');
    expect(doc.headerAt).toBe(0);
    expect(doc.recovered).toBe(false);
    expect(doc.sections.map((s) => s.kind)).toEqual(['table', 'table']);
    expect(doc.revisions).toHaveLength(2);
    const [r1, r2] = doc.revisions as [Doc['revisions'][0], Doc['revisions'][0]];
    expect(r1.start).toBe(0);
    expect(r2.start).toBe(r1.end);
    expect(r2.end).toBe(bytes.length);
    expect(text(bytes.subarray(r1.end - 6, r1.end)).trim()).toBe('%%EOF');
    expect(r1.eofAt).toBe(r1.end - 6);
    // revision 2 changes objects 4 and 6 only
    expect([...r2.delta.keys()].sort()).toEqual([4, 6]);
    expect(doc.records.filter((r) => r.num === 4)).toHaveLength(2);
    expect(contentAt(doc, 1)).toContain('FTF{old_revision}');
    expect(contentAt(doc, 2)).toContain('Nothing to see here');
    expect(contentAt(doc, 2)).not.toContain('FTF');
    // the current document: the title of the update
    const info = doc.dictOf(doc.trailer.map.get('Info'));
    expect(stringText(info?.map.get('Title'))).toBe('Quarterly report - final');
    expect(doc.trailingData()).toBeNull();
    expect(doc.leadingData()).toBeNull();
  });

  it('finds the objects of the earlier revision even though the update replaced them', async () => {
    const doc = await PdfDoc.open(buildRevisions());
    const four = doc.records.filter((r) => r.num === 4);
    expect(four.map((r) => text(doc.decode(r).data).includes('FTF{old_revision}'))).toEqual([
      true,
      false,
    ]);
  });
});

describe('PdfDoc: object streams and xref streams', () => {
  it('reads the xref stream (with its PNG predictor) and unpacks the object stream', async () => {
    const doc = await PdfDoc.open(buildObjectStream());
    expect(doc.version).toBe('1.5');
    expect(doc.sections.map((s) => s.kind)).toEqual(['stream']);
    expect(doc.recovered).toBe(false);
    const view = doc.view;
    expect(view.get(1)).toMatchObject({ kind: 'c', a: 5, b: 0 });
    expect(view.get(7)).toMatchObject({ kind: 'c', a: 5, b: 4 });
    expect(view.get(4)?.kind).toBe('n');
    const info = doc.dictOf(doc.trailer.map.get('Info'));
    expect(stringText(info?.map.get('Secret'))).toBe('FTF{object_stream}');
    const catalog = doc.dictOf(doc.trailer.map.get('Root'));
    expect(catalog?.map.get('Type')).toEqual({ k: 'name', v: 'Catalog' });
    const stm = doc.getRecord(5)!;
    expect(doc.objStmMembers(stm).map((m) => m.num)).toEqual([1, 2, 3, 6, 7]);
    expect(contentAt(doc, 1)).toContain('Packed objects and an xref stream');
  });

  it('rebuilds the packed objects when the xref stream is ignored', async () => {
    const doc = await PdfDoc.open(buildObjectStream(), { rebuild: true });
    expect(doc.recovered).toBe(true);
    expect(doc.view.get(7)).toMatchObject({ kind: 'c', a: 5 });
    const info = doc.dictOf(doc.trailer.map.get('Info'));
    expect(stringText(info?.map.get('Secret'))).toBe('FTF{object_stream}');
  });
});

describe('PdfDoc: encryption', () => {
  it('opens the hand-made RC4 file with the empty user password', async () => {
    const doc = await PdfDoc.open(buildEncryptedRc4());
    expect(doc.encrypt?.r).toBe(3);
    expect(doc.encrypt?.bits).toBe(128);
    expect(doc.unlocked).toMatchObject({ ok: true, password: 'empty' });
    expect(contentAt(doc, 1)).toBe('BT /F1 18 Tf 20 100 Td (FTF{rc4_encrypted}) Tj ET');
    const info = doc.dictOf(doc.trailer.map.get('Info'));
    expect(stringText(info?.map.get('Title'))).toBe('Encrypted with an empty password');
  });

  it('says so when the data stays encrypted', async () => {
    const v = ENCRYPTED_VECTORS['aes-256-pw']!;
    const doc = await PdfDoc.open(v.bytes);
    expect(doc.unlocked).toMatchObject({ ok: false, reason: 'password' });
    const rec = doc.records.find((r) => r.stream && r.num !== 0)!;
    expect(doc.decode(rec).encrypted).toBe(true);
  });

  // Files written by pypdf (an independent implementation), page text decoded by us.
  it.each(Object.entries(ENCRYPTED_VECTORS))('decrypts %s', async (_name, v) => {
    const doc = await PdfDoc.open(v.bytes, { passwords: v.password ? [v.password] : [] });
    expect(doc.unlocked?.ok).toBe(true);
    if (doc.unlocked?.ok) expect(doc.unlocked.password).toBe(v.password ? 'given' : 'empty');
    const contents = doc.records.filter((r) => r.stream).map((r) => text(doc.decode(r).data));
    expect(contents.some((c) => c.includes(v.flag))).toBe(true);
    const info = doc.dictOf(doc.trailer.map.get('Info'));
    const title = info?.map.get('Title');
    expect(isString(title) && stringText(title).startsWith('Title ')).toBe(true);
  });

  it('refuses a wrong password', async () => {
    const v = ENCRYPTED_VECTORS['rc4-128-pw']!;
    const doc = await PdfDoc.open(v.bytes, { passwords: ['wrong'] });
    expect(doc.unlocked).toMatchObject({ ok: false, reason: 'password' });
    // the owner password is not a user password: no way in
    const owner = await PdfDoc.open(v.bytes, { passwords: ['owner-secret'] });
    expect(owner.unlocked?.ok).toBe(false);
  });
});

describe('PdfDoc: damaged files', () => {
  it('rebuilds a file whose xref offsets are wrong, and sees what surrounds the objects', async () => {
    const bytes = buildBrokenXref();
    const doc = await PdfDoc.open(bytes);
    expect(doc.recovered).toBe(true);
    expect(doc.chainProblem).toBe('mismatch');
    expect(doc.records.map((r) => r.num)).toEqual([1, 2, 3, 4, 5]);
    expect(contentAt(doc, doc.revisions.length)).toContain('FTF{rebuilt_xref}');
    const trailing = doc.trailingData()!;
    expect(text(bytes.subarray(trailing.offset, trailing.offset + trailing.length))).toBe(
      'FTF{after_eof}',
    );
    const gaps = doc.gaps();
    expect(gaps.map((g) => g.text)).toEqual(['% FTF{comment_between_objects}']);
  });

  it('copes with no xref, no trailer and no startxref', async () => {
    const w = simpleDocument('BT /F1 12 Tf 10 10 Td (FTF{bare}) Tj ET');
    const doc = await PdfDoc.open(w.bytes());
    expect(doc.recovered).toBe(true);
    expect(doc.chainProblem).toBe('noStartxref');
    expect(doc.revisions).toHaveLength(1);
    // the catalog is found by its /Type
    const root = doc.dictOf(doc.trailer.map.get('Root'));
    expect(root?.map.get('Type')).toEqual({ k: 'name', v: 'Catalog' });
    expect(contentAt(doc, 1)).toContain('FTF{bare}');
  });

  it('follows xref offsets that point at the end of line before the object', async () => {
    const w = simpleDocument('BT /F1 12 Tf 10 10 Td (FTF{late_offsets}) Tj ET');
    for (const [, o] of w.offsets) o.offset -= 1; // the newline in front of "n g obj"
    w.xref([1, 2, 3, 4, 5], '/Size 6 /Root 1 0 R');
    const doc = await PdfDoc.open(w.bytes());
    expect(doc.recovered).toBe(false);
    expect(doc.xrefMismatch).toBe(0);
    expect(contentAt(doc, 1)).toContain('FTF{late_offsets}');
  });

  it('reads offsets relative to a %PDF header that is not at byte 0', async () => {
    const w = buildRevisions();
    const junk = bytesOf('GIF89a-ish junk before the header\n');
    const doc = await PdfDoc.open(join(junk, w));
    expect(doc.headerAt).toBe(junk.length);
    expect(doc.recovered).toBe(false);
    expect(doc.revisions).toHaveLength(2);
    expect(doc.leadingData()).toEqual({ offset: 0, length: junk.length });
    expect(contentAt(doc, 1)).toContain('FTF{old_revision}');
  });

  it('finds the end of a stream whose /Length is wrong, missing or indirect', async () => {
    const data = 'BT /F1 12 Tf 10 10 Td (FTF{length_trick}) Tj ET';
    const cases: [string, (w: PdfWriter) => void][] = [
      ['too short', (w) => w.stream(4, '', data, 0, '5')],
      ['too long', (w) => w.stream(4, '', data, 0, '5000')],
      ['indirect', (w) => w.stream(4, '', data, 0, '9 0 R').object(9, String(data.length))],
      ['negative', (w) => w.stream(4, '', data, 0, '-3')],
    ];
    for (const [label, put] of cases) {
      const w = new PdfWriter();
      w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
      w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
      w.object(3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>');
      put(w);
      w.xref(
        [1, 2, 3, 4, 9].filter((n) => w.offsets.has(n)),
        '/Size 10 /Root 1 0 R',
      );
      const doc = await PdfDoc.open(w.bytes());
      const rec = doc.getRecord(4)!;
      expect(text(doc.decode(rec).data), label).toBe(data);
      if (label === 'indirect') expect(rec.stream?.lengthOk).toBe(true);
      else expect(rec.stream?.lengthOk, label).toBe(false);
    }
  });

  it('survives a file cut in the middle of a stream', async () => {
    const w = simpleDocument('BT /F1 12 Tf 10 10 Td (FTF{cut}) Tj ET');
    const full = w.bytes();
    const cutAt = text(full).indexOf('FTF{cut}') + 4;
    const doc = await PdfDoc.open(full.subarray(0, cutAt));
    const rec = doc.records.find((r) => r.num === 4)!;
    expect(rec.stream?.hasEndstream).toBe(false);
    expect(text(doc.decode(rec).data)).toContain('FTF{');
  });

  it('does not crash on random bytes, on a lone header, or on absurd nesting', async () => {
    let seed = 12345;
    const noise = Uint8Array.from(
      { length: 200_000 },
      () => ((seed = (seed * 1103515245 + 12345) >>> 0) >> 16) & 255,
    );
    const a = await PdfDoc.open(noise);
    expect(a.records.length).toBeLessThan(5);
    const b = await PdfDoc.open(bytesOf('%PDF-1.4\n'));
    expect(b.revisions).toHaveLength(1);
    const c = await PdfDoc.open(
      join('%PDF-1.4\n1 0 obj\n', '['.repeat(100_000), '\nendobj\n2 0 obj\n<< /A 1 >>\nendobj\n'),
    );
    expect(c.records.some((r) => r.num === 2 && isDict(r.value))).toBe(true);
    const d = await PdfDoc.open(new Uint8Array(0));
    expect(d.records).toHaveLength(0);
  });

  it('keeps going when an object references itself or the chain loops', async () => {
    const w = new PdfWriter();
    w.object(1, '<< /Type /Catalog /Pages 1 0 R /Self 1 0 R >>');
    const at = w.xref([1], '/Size 2 /Root 1 0 R /Prev 9');
    w.raw(
      `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 2 /Prev ${at} >>\nstartxref\n${at}\n%%EOF\n`,
    );
    const doc = await PdfDoc.open(w.bytes());
    expect(doc.revisions.length).toBeGreaterThan(0);
    expect(doc.resolve({ k: 'ref', num: 1, gen: 0 })).toBeDefined();
  });
});

describe('PdfDoc: other layouts', () => {
  it('keeps one revision for a linearized file: its two xref sections are one save', async () => {
    const pad = (n: number) => String(n).padStart(10, '0');
    const firstText = (offsets: number[], prev: number) =>
      `xref\n1 3\n${offsets.map((o) => `${pad(o)} 00000 n \n`).join('')}` +
      `trailer\n<< /Size 6 /Root 2 0 R /Prev ${pad(prev)} >>\nstartxref\n0\n%%EOF\n`;
    let out = '%PDF-1.4\n';
    const at = new Map<number, number>();
    const obj = (n: number, body: string) => {
      at.set(n, out.length);
      out += `${n} 0 obj\n${body}\nendobj\n`;
    };
    obj(1, '<< /Linearized 1 /L 0 /O 3 /N 1 >>');
    // the first-page section sits at the start and points forward to the main one
    const firstAt = out.length;
    const reserved = firstText([0, 0, 0], 0).length;
    out += ' '.repeat(reserved);
    obj(2, '<< /Type /Catalog /Pages 4 0 R >>');
    obj(3, '<< /Type /Page /Parent 4 0 R /Contents 5 0 R >>');
    obj(4, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(5, '<< /Length 0 >>\nstream\n\nendstream');
    const mainAt = out.length;
    out +=
      `xref\n0 1\n0000000000 65535 f \n4 2\n${pad(at.get(4)!)} 00000 n \n${pad(at.get(5)!)} 00000 n \n` +
      `trailer\n<< /Size 6 >>\nstartxref\n${firstAt}\n%%EOF\n`;
    const first = firstText([at.get(1)!, at.get(2)!, at.get(3)!], mainAt);
    out = out.slice(0, firstAt) + first + out.slice(firstAt + reserved);
    const doc = await PdfDoc.open(bytesOf(out));
    expect(doc.linearized).toBe(true);
    expect(doc.recovered).toBe(false);
    expect(doc.sections).toHaveLength(2);
    expect(doc.revisions).toHaveLength(1);
    expect([...doc.view.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(doc.revisions[0]).toMatchObject({ start: 0, end: out.length });
  });

  it('parses the plain sample files as one revision each', async () => {
    for (const bytes of [buildEmbeddedJs(), buildInvisibleText()]) {
      const doc = await PdfDoc.open(bytes);
      expect(doc.recovered).toBe(false);
      expect(doc.revisions).toHaveLength(1);
      expect(doc.trailer.map.get('Root')).toEqual({ k: 'ref', num: 1, gen: 0 });
    }
  });

  it('merges hybrid files: the xref stream completes the table', async () => {
    const w = new PdfWriter('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n');
    w.object(1, '<< /Type /Catalog /Pages 2 0 R /Packed 7 0 R >>');
    w.object(2, '<< /Type /Pages /Kids [] /Count 0 >>');
    // object 7 is inside object stream 8, listed only in the xref stream (object 9)
    const header = '7 0 ';
    const body = '(FTF{hybrid})\n';
    w.stream(8, `/Type /ObjStm /N 1 /First ${header.length}`, header + body);
    const at9 = w.length;
    const row = (t: number, a: number, b: number) => [t, (a >> 8) & 255, a & 255, b];
    const entries = [row(2, 8, 0)];
    w.stream(9, '/Type /XRef /Size 10 /W [1 2 1] /Index [7 1]', Uint8Array.from(entries.flat()));
    // the classic table lists the others, and 7 as free (a reader without xref streams skips it)
    w.xref([1, 2, 8], `/Size 10 /Root 1 0 R /XRefStm ${at9}`);
    const doc = await PdfDoc.open(w.bytes());
    expect(doc.recovered).toBe(false);
    expect(doc.sections[0]?.hybrid?.get(7)).toMatchObject({ kind: 'c', a: 8 });
    const catalog = doc.dictOf(doc.trailer.map.get('Root'));
    expect(stringText(doc.resolve(catalog?.map.get('Packed')))).toBe('FTF{hybrid}');
  });
});
