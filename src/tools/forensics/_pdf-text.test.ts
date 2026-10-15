import { describe, expect, it } from 'vitest';
import { PdfDoc } from './_pdf-doc';
import { buildEmbeddedJs, buildInvisibleText, buildRevisions } from './_pdf-fixtures';
import { bytesOf, PdfWriter, simpleDocument } from './_pdf-kit';
import {
  collectPages,
  extractPageText,
  glyphToText,
  layoutText,
  looksLikeContent,
  parseCMap,
  rawContentText,
  type PageText,
} from './_pdf-text';

async function textOf(w: PdfWriter | Uint8Array, page = 1): Promise<PageText> {
  const doc = await PdfDoc.open(w instanceof PdfWriter ? w.bytes() : w);
  const pages = collectPages(doc, doc.view);
  return extractPageText(doc, doc.view, pages[page - 1]!);
}

const visible = (t: PageText) => t.runs.filter((r) => r.hidden.length === 0);

describe('page text and hidden text', () => {
  it('flags the five kinds of invisible text of the sample, and nothing else', async () => {
    const t = await textOf(buildInvisibleText());
    const byText = Object.fromEntries(t.runs.map((r) => [r.text, r.hidden]));
    expect(byText).toEqual({
      'Public page: nothing to see': [],
      'FTF{invisible_text}': ['render'],
      'FTF{white_text}': ['white'],
      'FTF{tiny_text}': ['tiny'],
      'FTF{offpage_text}': ['offpage'],
      'FTF{covered_text}': ['covered'],
      'The box above hides a line': [],
    });
    expect(layoutText(visible(t))).toBe('Public page: nothing to see\nThe box above hides a line');
  });

  it('does not call white text hidden when something coloured is painted under it', async () => {
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
      [
        '0.1 0.2 0.5 rg 10 150 200 30 re f', // a banner, then white title text on it
        'BT /F1 14 Tf 1 g 20 160 Td (white on a banner) Tj ET',
        'BT /F1 14 Tf 1 g 20 100 Td (white on nothing) Tj ET',
        'q 100 0 0 40 20 40 cm /Im Do Q', // an image, then white text on it
        'BT /F1 14 Tf 1 g 30 55 Td (white on a picture) Tj ET',
        '0 0.5 0 rg 10 10 m 60 10 l 60 30 l h f', // a triangle: its bounding box counts
        'BT /F1 14 Tf 1 g 20 12 Td (white on a shape) Tj ET',
        'BT /F1 14 Tf 1 g 250 100 Td (white beside the banner) Tj ET',
      ].join('\n'),
    );
    w.object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    w.stream(
      6,
      '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8',
      '\u0000',
    );
    w.xref([1, 2, 3, 4, 5, 6], '/Size 7 /Root 1 0 R');
    const t = await textOf(w);
    expect(t.runs.map((r) => `${r.text}:${r.hidden.join('+')}`)).toEqual([
      'white on a banner:',
      'white on nothing:white',
      'white on a picture:',
      'white on a shape:',
      'white beside the banner:white',
    ]);
  });

  it('calls the invisible text over a page-sized picture an OCR layer, not hidden text', async () => {
    const page = (content: string): PdfWriter => {
      const w = new PdfWriter();
      w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
      w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
      w.object(
        3,
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im 6 0 R >> >> >>',
      );
      w.stream(4, '', content);
      w.object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
      w.stream(
        6,
        '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8',
        '\u0000',
      );
      w.xref([1, 2, 3, 4, 5, 6], '/Size 7 /Root 1 0 R');
      return w;
    };
    const kinds = async (content: string) =>
      (await textOf(page(content))).runs.map((r) => `${r.text}:${r.hidden.join('+')}`);
    // the scan, its OCR layer, then text typed over it
    expect(
      await kinds(
        [
          'q 300 0 0 200 0 0 cm /Im Do Q',
          'BT /F1 12 Tf 3 Tr 20 100 Td (scanned words) Tj ET',
          'BT /F1 12 Tf 0 Tr 20 50 Td (typed over the scan) Tj ET',
        ].join('\n'),
      ),
    ).toEqual(['scanned words:ocr', 'typed over the scan:']);
    // a small picture does not make an OCR layer, and no picture leaves hidden text hidden
    expect(
      await kinds('q 20 0 0 20 0 0 cm /Im Do Q BT /F1 12 Tf 3 Tr 20 100 Td (secret) Tj ET'),
    ).toEqual(['secret:render']);
    expect(await kinds('BT /F1 12 Tf 3 Tr 20 100 Td (secret) Tj ET')).toEqual(['secret:render']);
    // other reasons still count: tiny OCR-like text over a scan is hidden text
    expect(
      await kinds('q 300 0 0 200 0 0 cm /Im Do Q BT /F1 1 Tf 3 Tr 20 100 Td (tiny) Tj ET'),
    ).toEqual(['tiny:render+tiny']);
  });

  it('reads the pages of the ordinary samples', async () => {
    expect(layoutText((await textOf(buildRevisions())).runs)).toBe('Nothing to see here');
    expect(layoutText((await textOf(buildEmbeddedJs())).runs)).toBe(
      'An embedded file, JavaScript and a form',
    );
  });

  it('adds spaces for TJ kerning and breaks lines on a move down', async () => {
    const t = await textOf(
      simpleDocument(
        "BT /F1 12 Tf 14 TL 10 100 Td [(Hel) -300 (lo) 20 (World)] TJ T* (second line) Tj (third) ' ET",
      ),
    );
    expect(layoutText(t.runs)).toBe('Hel loWorld\nsecond line\nthird');
  });

  it('decodes WinAnsi, MacRoman and /Differences', async () => {
    const w = new PdfWriter();
    w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    w.object(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /W 5 0 R /M 6 0 R /D 7 0 R >> >> >>',
    );
    w.stream(
      4,
      '',
      'BT /W 12 Tf 10 100 Td <80E9> Tj /M 12 Tf 0 -20 Td <8E> Tj /D 12 Tf 0 -20 Td <414243> Tj ET',
    );
    w.object(5, '<< /Type /Font /Subtype /TrueType /BaseFont /A /Encoding /WinAnsiEncoding >>');
    w.object(6, '<< /Type /Font /Subtype /TrueType /BaseFont /B /Encoding /MacRomanEncoding >>');
    w.object(
      7,
      '<< /Type /Font /Subtype /Type1 /BaseFont /C /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [65 /eacute /uni0042 /Euro] >> >>',
    );
    w.xref([1, 2, 3, 4, 5, 6, 7], '/Size 8 /Root 1 0 R');
    const t = await textOf(w);
    expect(t.runs.map((r) => r.text)).toEqual(['€é', 'é', 'éB€']);
  });

  it('maps a Type0 font through its ToUnicode CMap, and shows the codes when there is none', async () => {
    const cmap = [
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
      '1 begincodespacerange <0000> <FFFF> endcodespacerange',
      '2 beginbfchar <0001> <0046> <0002> <0054> endbfchar',
      '1 beginbfrange <0003> <0004> <0046> endbfrange',
      '1 beginbfrange <0010> <0012> [<0041> <0042> <00430044>] endbfrange',
      'endcmap end end',
    ].join('\n');
    const w = new PdfWriter();
    w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    w.object(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /A 5 0 R /B 8 0 R >> >> >>',
    );
    w.stream(
      4,
      '',
      'BT /A 12 Tf 10 100 Td <00010002000300040010001100120099> Tj /B 12 Tf 0 -20 Td <00410042> Tj ET',
    );
    w.object(
      5,
      '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    );
    w.object(
      6,
      '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 1000 /W [1 [500 600] 3 4 700] >>',
    );
    w.stream(7, '', cmap);
    w.object(
      8,
      '<< /Type /Font /Subtype /Type0 /BaseFont /Y /Encoding /Identity-H /DescendantFonts [6 0 R] >>',
    );
    w.xref([1, 2, 3, 4, 5, 6, 7, 8], '/Size 9 /Root 1 0 R');
    const t = await textOf(w);
    // 0003 -> F, 0004 -> G (range with an incrementing last digit), 0010..0012 from the array,
    // 0099 has no mapping
    expect(t.runs[0]!.text).toBe('FTFGABCD<0099>');
    expect(t.runs[0]!.raw).toBe(true);
    expect(t.runs[1]!.text).toBe('<0041><0042>');
    expect(t.runs[1]!.raw).toBe(true);
  });

  it('hides what a transparent graphics state, a hidden layer or a form drawn off the page contain', async () => {
    const w = new PdfWriter('%PDF-1.7\n');
    w.object(
      1,
      '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [8 0 R 9 0 R] /D << /OFF [8 0 R] >> >> >>',
    );
    w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 200] >>');
    w.object(
      3,
      '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /ExtGState << /G0 << /ca 0 >> >> ' +
        '/Properties << /L1 8 0 R /L2 9 0 R >> /XObject << /Fm 6 0 R >> >> >>',
    );
    w.stream(
      4,
      '',
      [
        'BT /F1 12 Tf 10 180 Td (plain) Tj ET',
        'q /G0 gs BT /F1 12 Tf 10 160 Td (transparent) Tj ET Q',
        '/OC /L1 BDC BT /F1 12 Tf 10 140 Td (layer off) Tj ET EMC',
        '/OC /L2 BDC BT /F1 12 Tf 10 120 Td (layer on) Tj ET EMC',
        'q 1 0 0 1 0 -500 cm /Fm Do Q',
        '/Fm Do',
      ].join('\n'),
    );
    w.object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    w.stream(
      6,
      '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 20 0]',
      'BT /F1 12 Tf 0 50 Td (in form) Tj ET',
    );
    w.object(8, '<< /Type /OCG /Name (Secret layer) >>');
    w.object(9, '<< /Type /OCG /Name (Visible layer) >>');
    w.xref([1, 2, 3, 4, 5, 6, 8, 9], '/Size 10 /Root 1 0 R');
    const t = await textOf(w);
    const by = t.runs.map((r) => `${r.text}:${r.hidden.join('+')}`);
    expect(by).toEqual([
      'plain:',
      'transparent:transparent',
      'layer off:layer',
      'layer on:',
      'in form:offpage',
      'in form:',
    ]);
    // the form's matrix moved its text 20 points to the right
    expect(t.runs[5]!.x).toBe(20);
  });

  it('follows the page tree: inherited boxes and resources, nested nodes, loops', async () => {
    const w = new PdfWriter();
    w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    w.object(
      2,
      '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /MediaBox [0 0 100 50] /Resources << /Font << /F1 5 0 R >> >> >>',
    );
    w.object(3, '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 2 0 R] /Count 1 >>');
    w.object(4, '<< /Type /Page /Parent 3 0 R /Contents 7 0 R >>');
    w.object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    w.object(6, '<< /Type /Page /Parent 2 0 R /Contents [7 0 R 8 0 R] /MediaBox [0 0 300 300] >>');
    w.stream(7, '', 'BT /F1 12 Tf 10 10 Td (one) Tj ET');
    w.stream(8, '', 'BT /F1 12 Tf 10 30 Td (two) Tj ET');
    w.xref([1, 2, 3, 4, 5, 6, 7, 8], '/Size 9 /Root 1 0 R');
    const doc = await PdfDoc.open(w.bytes());
    const pages = collectPages(doc, doc.view);
    expect(pages.map((p) => [p.index, p.num, p.mediaBox, p.contents])).toEqual([
      [1, 4, [0, 0, 100, 50], [7]],
      [2, 6, [0, 0, 300, 300], [7, 8]],
    ]);
    expect(layoutText(extractPageText(doc, doc.view, pages[1]!).runs)).toBe('one\ntwo');
  });

  it('does not stop on garbage, unbalanced operators or a missing font', async () => {
    const t = await textOf(
      simpleDocument(
        'Q Q Q BT (no font yet) Tj /Nope 12 Tf (still) Tj ) ) << >> ] [ 1 2 3 Td ET BI /W 1 ID xx EI (after) Tj',
      ),
    );
    expect(t.runs.map((r) => r.text)).toContain('no font yet');
    const empty = await textOf(simpleDocument(''));
    expect(empty.runs).toEqual([]);
    const noContents = await textOf(
      (() => {
        const w = new PdfWriter();
        w.object(1, '<< /Type /Catalog /Pages 2 0 R >>');
        w.object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
        w.object(3, '<< /Type /Page /Parent 2 0 R >>');
        w.xref([1, 2, 3], '/Size 4 /Root 1 0 R');
        return w;
      })(),
    );
    expect(noContents.notes).toContain('noContent');
  });
});

describe('CMaps, glyph names and loose content', () => {
  it('parses the code space, bfchar and both forms of bfrange', () => {
    const cmap = parseCMap(
      bytesOf(
        '1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <00480069> endbfchar ' +
          '1 beginbfrange <61> <63> <0061> endbfrange',
      ),
    );
    expect(cmap.codeBytes).toBe(1);
    expect(cmap.chars.get(0x41)).toBe('Hi');
    expect(cmap.ranges).toHaveLength(1);
  });

  it('turns glyph names into text', () => {
    expect(glyphToText('eacute')).toBe('é');
    expect(glyphToText('Odieresis')).toBe('Ö');
    expect(glyphToText('uni20AC')).toBe('€');
    expect(glyphToText('u1F600')).toBe('😀');
    expect(glyphToText('fi')).toBe('ﬁ');
    expect(glyphToText('space')).toBe(' ');
    expect(glyphToText('g123')).toBe('');
  });

  it('reads text out of a content stream without a font, and recognises content streams', () => {
    const content = bytesOf('BT /F1 12 Tf (Hello) Tj 0 -14 Td [(Wor) -300 (ld)] TJ ET');
    expect(rawContentText(content)).toBe('Hello\nWor ld');
    expect(looksLikeContent(content)).toBe(true);
    expect(looksLikeContent(bytesOf('just some prose, nothing to see'))).toBe(false);
  });
});
