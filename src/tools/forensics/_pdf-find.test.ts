import { describe, expect, it } from 'vitest';
import { PdfDoc } from './_pdf-doc';
import {
  computeReach,
  findActions,
  findAnnotations,
  findEmbedded,
  findFields,
  findScripts,
  findXfa,
  keywordCounts,
  pathOf,
  readInfo,
  readXmp,
  unusualEntries,
  xmpFields,
} from './_pdf-find';
import { flate, PdfWriter } from './_pdf-kit';
import { collectPages } from './_pdf-text';
import { latin1Decode } from '../../lib/bytes';

async function open(w: PdfWriter) {
  return PdfDoc.open(w.bytes());
}

/** A catalog with the given extra entries and one empty page; more objects through `more`. */
function doc(catalog: string, more: (w: PdfWriter) => void = () => {}, trailer = ''): PdfWriter {
  const w = new PdfWriter();
  w.object(1, `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`);
  w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  w.object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>');
  more(w);
  w.xref(
    [...w.offsets.keys()],
    `/Size ${Math.max(...w.offsets.keys()) + 1} /Root 1 0 R ${trailer}`,
  );
  return w;
}

describe('pdfid-style counts', () => {
  it('counts names in the file text, with the # escapes, and in the parsed objects', async () => {
    const d = await open(
      doc('/OpenAction 4 0 R', (w) => {
        w.object(4, '<< /S /J#61vaScript /J#53 (app.alert(1)) >>');
        // the stream data mentions /JS and /Launch but is not file text
        w.stream(5, '/Filter /FlateDecode', flate('/JS /Launch /EmbeddedFile'));
        w.object(6, '<< /Note (a string with /JS and /URI in it) >>');
      }),
    );
    const counts = Object.fromEntries(keywordCounts(d).map((c) => [c.key, c]));
    expect(counts['/JavaScript']).toMatchObject({ file: 1, escaped: 1, parsed: 1 });
    expect(counts['/JS']).toMatchObject({ file: 1, escaped: 1, parsed: 1 });
    expect(counts['/OpenAction']).toMatchObject({ file: 1, escaped: 0, parsed: 1 });
    expect(counts['/Launch']).toMatchObject({ file: 0, parsed: 0 });
    expect(counts['/URI']).toMatchObject({ file: 0, parsed: 0 });
    expect(counts['/Page']).toMatchObject({ file: 1, parsed: 1 });
    expect(counts['obj']).toMatchObject({ file: 6 });
    expect(counts['stream']).toMatchObject({ file: 1 });
    expect(counts['startxref']).toMatchObject({ file: 1 });
  });

  it('counts the names of objects packed in an object stream', async () => {
    const w = new PdfWriter('%PDF-1.5\n');
    const packed = '<< /S /Launch /F (cmd.exe) >>';
    w.stream(5, '/Type /ObjStm /N 1 /First 4', `9 0 ${packed}`);
    w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    w.object(2, '<< /Type /Pages /Kids [] /Count 0 >>');
    w.xref([1, 2, 5], '/Size 10 /Root 1 0 R');
    const d = await PdfDoc.open(w.bytes(), { rebuild: true });
    const launch = keywordCounts(d).find((c) => c.key === '/Launch')!;
    expect(launch.file).toBe(0); // inside stream data
    expect(launch.parsed).toBe(1);
  });
});

describe('JavaScript', () => {
  it('finds scripts in strings, streams, packed objects and old versions, and says where', async () => {
    const w = new PdfWriter();
    w.object(
      1,
      '<< /Type /Catalog /Pages 2 0 R /AA << /WC 4 0 R >> /Names << /JavaScript << /Names [(a) 5 0 R] >> >> >>',
    );
    w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    w.object(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /AA << /O << /S /JavaScript /JS (this.print();) >> >> >>',
    );
    w.object(4, '<< /S /JavaScript /JS (var secret = "FTF{js_string}";) >>');
    w.object(5, '<< /S /JavaScript /JS 6 0 R >>');
    w.stream(6, '/Filter /FlateDecode', flate('eval(unescape("%61%6c%65%72%74"));'));
    const first = w.xref([1, 2, 3, 4, 5, 6], '/Size 8 /Root 1 0 R');
    w.object(4, '<< /S /JavaScript /JS (app.alert("second version");) >>');
    w.object(7, '<< /S /JavaScript /JS (orphan();) >>');
    w.xref([4, 7], `/Size 8 /Root 1 0 R /Prev ${first}`, false);
    const d = await PdfDoc.open(w.bytes());
    const scripts = findScripts(d, computeReach(d));
    const by = Object.fromEntries(scripts.map((s) => [`${s.num}:${s.state}`, s]));
    expect(by['4:current']!.source).toBe('app.alert("second version");');
    expect(by['4:current']!.where).toBe('/Root/AA/WC');
    expect(by['4:old']!.source).toBe('var secret = "FTF{js_string}";');
    expect(by['4:old']!.where).toBe('older version of object 4');
    expect(by['5:current']!.source).toBe('eval(unescape("%61%6c%65%72%74"));');
    expect(by['5:current']!.notable).toEqual(['eval', 'unescape']);
    expect(by['5:current']!.where).toBe('/Root/Names/JavaScript/Names[1]');
    expect(by['3:current']!.where).toBe('/Root/Pages/Kids[0]/AA/O');
    expect(by['7:current']!.where).toBe('unreferenced object 7');
  });
});

describe('embedded files', () => {
  it('reads names from the name tree, nested kids and the file spec, and the stream data', async () => {
    const d = await open(
      doc('/Names << /EmbeddedFiles << /Kids [10 0 R] >> >>', (w) => {
        w.object(10, '<< /Names [(tree-name.bin) 11 0 R (b.txt) 13 0 R] >>');
        w.object(11, '<< /Type /Filespec /UF (real name.zip) /Desc (zip) /EF << /F 12 0 R >> >>');
        w.stream(
          12,
          '/Type /EmbeddedFile /Subtype /application#2Fzip /Filter /FlateDecode /Params << /Size 4 >>',
          flate(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])),
        );
        w.object(13, '<< /Type /Filespec /EF << /F 14 0 R >> >>');
        w.stream(14, '/Type /EmbeddedFile', 'plain');
        w.stream(15, '/Type /EmbeddedFile', 'nobody points to this');
      }),
    );
    const files = findEmbedded(d, computeReach(d));
    expect(
      files.map((f) => [
        f.name,
        f.treeName,
        latin1Decode(f.data.subarray(0, 5)),
        f.mime,
        f.declaredSize,
      ]),
    ).toEqual([
      ['real name.zip', 'tree-name.bin', 'PK\x03\x04', 'application/zip', 4],
      ['b.txt', null, 'plain', '', null],
      ['embedded-15', null, 'nobod', '', null],
    ]);
    expect(files[0]!.kind).toBe('zip');
    expect(files[0]!.where).toBe('/Root/Names/EmbeddedFiles/Kids[0]/Names[1]');
    expect(files[2]!.where).toBe('unreferenced EmbeddedFile stream');
  });
});

describe('actions, forms and annotations', () => {
  it('lists links and the actions that leave the document', async () => {
    const d = await open(
      doc('/OpenAction 4 0 R /URI << /Base (https://example.org/base/) >>', (w) => {
        w.object(4, '<< /S /Launch /Win << /F (cmd.exe) /P (/c calc) >> >>');
        w.object(5, '<< /S /GoToR /F (other.pdf) /D [0 /Fit] >>');
        w.object(6, '<< /S /SubmitForm /F (https://example.org/submit) >>');
        w.object(7, '<< /S /URI /URI (https://example.org/a) >>');
        w.object(8, '<< /S /Named /N /NextPage >>');
        w.object(9, '<< /Holder [5 0 R 6 0 R 7 0 R 8 0 R] >>');
      }),
    );
    const reach = computeReach(d);
    const actions = findActions(d, reach);
    expect(actions.map((a) => [a.type, a.target])).toEqual([
      ['Launch', 'cmd.exe /c calc'],
      ['GoToR', 'other.pdf'],
      ['SubmitForm', 'https://example.org/submit'],
      ['URI', 'https://example.org/a'],
      ['Named', 'NextPage'],
      ['URI base', 'https://example.org/base/'],
    ]);
    expect(actions[0]!.where).toBe('/Root/OpenAction');
  });

  it('reads form fields with their full names, inherited types and hidden widgets', async () => {
    const d = await open(
      doc('/AcroForm << /Fields [10 0 R 14 0 R] >>', (w) => {
        w.object(10, '<< /T (person) /FT /Tx /Kids [11 0 R 12 0 R] >>');
        w.object(11, '<< /T (first) /V (Alice) /Parent 10 0 R >>');
        w.object(12, '<< /T (secret) /V <FEFF00460054> /Ff 1 /Parent 10 0 R /Kids [13 0 R] >>');
        w.object(13, '<< /Subtype /Widget /F 2 /Parent 12 0 R /Rect [0 0 0 0] >>');
        w.object(14, '<< /T (choice) /FT /Ch /V [(a) (b)] /DV (a) >>');
      }),
    );
    const fields = findFields(d);
    expect(fields.map((f) => [f.name, f.type, f.value, f.defaultValue, f.flags])).toEqual([
      ['person.first', 'text', 'Alice', '', []],
      ['person.secret', 'text', 'FT', '', ['readOnly', 'hidden']],
      ['choice', 'choice', 'a, b', 'a', []],
    ]);
  });

  it('reads XFA packets from the array and the single-stream form', async () => {
    const d = await open(
      doc('/AcroForm << /Fields [] /XFA [(template) 4 0 R (datasets) 5 0 R] >>', (w) => {
        w.stream(4, '', '<template/>');
        w.stream(5, '', '<datasets>FTF{xfa}</datasets>');
      }),
    );
    expect(findXfa(d).map((x) => [x.name, latin1Decode(x.data)])).toEqual([
      ['template', '<template/>'],
      ['datasets', '<datasets>FTF{xfa}</datasets>'],
    ]);
    const single = await open(doc('/AcroForm << /XFA 4 0 R >>', (w) => w.stream(4, '', '<xdp/>')));
    expect(findXfa(single).map((x) => latin1Decode(x.data))).toEqual(['<xdp/>']);
  });

  it('lists annotations with text or odd flags and skips plain links', async () => {
    const w = doc('', (more) => {
      more.object(
        3,
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Annots [10 0 R 11 0 R 12 0 R 13 0 R] >>',
      );
      more.object(10, '<< /Type /Annot /Subtype /Text /Contents (FTF{note}) /T (Mallory) /F 2 >>');
      more.object(11, '<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] >>');
      more.object(12, '<< /Type /Annot /Subtype /FreeText /Contents <FEFF00480069> >>');
      more.object(13, '<< /Type /Annot /Subtype /Stamp /F 33 >>');
    });
    const d = await open(w);
    const found = findAnnotations(d, collectPages(d, d.view));
    expect(found.map((a) => [a.page, a.type, a.text, a.author, a.flags])).toEqual([
      [1, 'Text', 'FTF{note}', 'Mallory', ['hidden']],
      [1, 'FreeText', 'Hi', '', []],
      [1, 'Stamp', '', '', ['invisible', 'noView']],
    ]);
  });
});

describe('metadata', () => {
  it('reads the Info dictionary with its custom keys and the XMP fields', async () => {
    const xmp =
      '<?xpacket begin="" id="x"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Hand tools">' +
      '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP title</rdf:li></rdf:Alt></dc:title>' +
      '<dc:creator><rdf:Seq><rdf:li>Eve</rdf:li><rdf:li>Frank</rdf:li></rdf:Seq></dc:creator>' +
      '<xmp:CreateDate>2025-01-02T03:04:05Z</xmp:CreateDate></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const d = await open(
      doc(
        '/Metadata 4 0 R',
        (w) => {
          w.stream(4, '/Type /Metadata /Subtype /XML', xmp);
          w.object(
            5,
            '<< /Title (Doc) /Author <FEFF00C9> /Secret (FTF{info_key}) /CreationDate (D:20250102030405Z) >>',
          );
        },
        '/Info 5 0 R',
      ),
    );
    expect(readInfo(d)).toEqual([
      { key: 'Title', value: 'Doc', custom: false },
      { key: 'Author', value: 'É', custom: false },
      { key: 'Secret', value: 'FTF{info_key}', custom: true },
      { key: 'CreationDate', value: 'D:20250102030405Z', custom: false },
    ]);
    const packet = readXmp(d)!;
    expect(packet).toContain('<x:xmpmeta');
    expect(xmpFields(packet)).toEqual([
      ['Title', 'XMP title'],
      ['Author', 'Eve Frank'],
      ['Creator tool', 'Hand tools'],
      ['Created', '2025-01-02T03:04:05Z'],
    ]);
  });

  it('lists entries no reader looks at in the catalog, pages and trailer', async () => {
    const d = await open(
      doc(
        '/Secret (FTF{catalog_key}) /Lang (en)',
        (w) => {
          w.object(
            3,
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Hidden 7 /Rotate 0 >>',
          );
        },
        '/Extra (in the trailer)',
      ),
    );
    const found = unusualEntries(d, collectPages(d, d.view));
    expect(found).toEqual([
      { where: 'trailer', key: '/Extra', value: 'in the trailer' },
      { where: 'Catalog', key: '/Secret', value: 'FTF{catalog_key}' },
      { where: 'page 1', key: '/Hidden', value: '7' },
    ]);
  });
});

describe('how objects are reached', () => {
  it('gives the path from the trailer and leaves out what nothing points to', async () => {
    const d = await open(
      doc('', (w) => {
        w.object(3, '<< /Type /Page /Parent 2 0 R /Contents [4 0 R] >>');
        w.stream(4, '', 'q Q');
        w.stream(5, '', 'orphan');
      }),
    );
    const reach = computeReach(d);
    expect(pathOf(reach, 4)).toBe('/Root/Pages/Kids[0]/Contents[0]');
    expect(pathOf(reach, 3)).toBe('/Root/Pages/Kids[0]');
    expect(reach.has(5)).toBe(false);
    expect(pathOf(reach, 5)).toBeNull();
    // a reference loop does not hang it
    const loop = await open(doc('/Self 1 0 R /Other 2 0 R'));
    expect(pathOf(computeReach(loop), 2)).toBe('/Root/Pages');
  });
});
