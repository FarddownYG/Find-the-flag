import { bool, defineTool, number, text } from '../../core/define';
import { toolT } from '../../i18n/tool-text';
import { latin1Decode } from '../../lib/bytes';
import { analyzePdf } from './_pdf-report';

const T = toolT('pdf-analyzer');

export default defineTool({
  id: 'pdf-analyzer',
  name: 'PDF analyzer',
  category: 'forensics',
  description:
    'Open a PDF like pdfid, pdf-parser and peepdf: every object and stream, older revisions, hidden text, JavaScript, embedded files, forms and metadata.',
  tags: [
    'pdf',
    'pdfid',
    'pdf-parser',
    'peepdf',
    'qpdf',
    'pdftotext',
    'incremental update',
    'revision',
    'hidden text',
    'invisible text',
    'embedded file',
    'javascript',
    'object stream',
    'xref',
    'acroform',
    'decrypt pdf',
  ],
  input: 'bytes',
  placeholder: 'Drop a PDF file',
  options: {
    object: number('Inspect object', 0, {
      min: 0,
      max: 99999999,
      hint: 'An object number (see the tables): its source, its decoded stream to read or download, and every version of it in the file. 0 = none.',
    }),
    revision: number('Revision', 0, {
      min: 0,
      max: 999,
      hint: 'Show the object as it was after this save (1 = the original file). 0 = the last one.',
      showIf: (v) => Number(v.object) > 0,
    }),
    password: text('User password', '', {
      placeholder: 'only if the PDF asks for one',
      hint: 'An encrypted PDF is opened with the empty user password first, then with this one. The owner password is not supported.',
    }),
    search: text('Search', '', {
      placeholder: 'FTF{   ·   /flag\\{\\w+\\}/',
      hint: 'Find text in the decoded streams and in the objects: plain text (ignoring case) or /regex/.',
    }),
    rebuild: bool('Ignore the xref', false, {
      hint: 'Do not trust the cross-reference tables: find the objects by scanning the file for "n g obj".',
    }),
    all: bool('List every stream as a file', false, {
      hint: 'Offer each decoded stream for download (images in a codec this tool cannot decode come out as raw files anyway).',
    }),
  },
  examples: [
    {
      label: 'An older revision hides the flag',
      input: { sample: 'pdf-revisions.pdf' },
      expect: 'FTF{old_revision}',
    },
    {
      label: 'Show the original version of one object',
      input: { sample: 'pdf-revisions.pdf' },
      options: { object: 4, revision: 1 },
      expect: 'BT /F1 18 Tf 20 100 Td (FTF{old_revision}) Tj ET',
    },
    {
      label: 'Invisible text (render mode 3, white, tiny, off the page, under a box)',
      input: { sample: 'pdf-invisible-text.pdf' },
      expect: 'FTF{invisible_text}',
    },
    {
      label: 'Embedded file',
      input: { sample: 'pdf-embedded-js.pdf' },
      expect: 'hidden-note.txt',
    },
    {
      label: 'JavaScript source (never run)',
      input: { sample: 'pdf-embedded-js.pdf' },
      expect: "app.alert('demo');",
    },
    {
      label: 'Form field values',
      input: { sample: 'pdf-embedded-js.pdf' },
      expect: 'FTF{form_value}',
    },
    {
      label: 'Object stream and xref stream',
      input: { sample: 'pdf-objstm.pdf' },
      expect: 'FTF{object_stream}',
    },
    {
      label: 'RC4-encrypted PDF (empty user password)',
      input: { sample: 'pdf-encrypted-rc4.pdf' },
      expect: 'FTF{rc4_encrypted}',
    },
    {
      label: 'Encrypted PDF, user password typed',
      input: { sample: 'pdf-encrypted-password.pdf' },
      options: { password: 'demo123' },
      expect: 'FTF{password_ok}',
    },
    {
      label: 'Wrong xref, comment between objects, data after %%EOF',
      input: { sample: 'pdf-broken-xref.pdf' },
      expect: 'FTF{after_eof}',
    },
    {
      label: 'Search the decoded streams',
      input: { sample: 'pdf-broken-xref.pdf' },
      options: { search: '/FTF\\{rebuilt\\w+\\}/' },
      expect: 'FTF{rebuilt_xref}',
    },
  ],
  detect({ bytes, name }) {
    const head = latin1Decode(bytes.subarray(0, 1024));
    if (head.includes('%PDF-')) return { score: 0.9, reason: T('detect.pdf') };
    if (/\.pdf$/i.test(name ?? '')) return { score: 0.5, reason: T('detect.name') };
    return null;
  },
  run({ bytes }, o) {
    return analyzePdf(bytes, {
      object: Math.max(0, Math.trunc(o.object)),
      revision: Math.max(0, Math.trunc(o.revision)),
      password: o.password,
      search: o.search,
      rebuild: o.rebuild,
      all: o.all,
    });
  },
});
