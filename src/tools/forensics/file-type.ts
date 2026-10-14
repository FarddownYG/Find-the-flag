import { defineTool } from '../../core/define';
import type { Output } from '../../core/types';
import { formatSize, indexOfBytes, latin1Decode, printableRatio, toHex } from '../../lib/bytes';
import { identify, SIGNATURES, type Signature } from '../../lib/signatures';

/** ZIP-based formats are told apart by the names of their entries. */
const ZIP_FLAVOURS: [string, string][] = [
  ['word/', 'Word document (docx)'],
  ['xl/', 'Excel workbook (xlsx)'],
  ['ppt/', 'PowerPoint deck (pptx)'],
  ['AndroidManifest.xml', 'Android package (apk)'],
  ['META-INF/MANIFEST.MF', 'Java archive (jar)'],
  ['mimetypeapplication/vnd.oasis', 'OpenDocument (odt/ods/odp)'],
  ['mimetypeapplication/epub', 'EPUB e-book'],
];

/** Signatures whose first bytes are within 1-2 bit-flips/bytes of this header: likely tampered. */
function nearMisses(b: Uint8Array): { sig: Signature; diff: number }[] {
  const out: { sig: Signature; diff: number }[] = [];
  for (const sig of SIGNATURES) {
    const fixed = sig.magic.filter((m) => m !== null).length;
    if (sig.weak || fixed < 4 || (sig.offset ?? 0) !== 0 || b.length < sig.magic.length) continue;
    let diff = 0;
    sig.magic.forEach((m, i) => {
      if (m !== null && b[i] !== m) diff++;
    });
    if (diff > 0 && diff <= Math.min(2, fixed / 3)) out.push({ sig, diff });
  }
  return out.sort((a, c) => a.diff - c.diff);
}

export default defineTool({
  id: 'file-type',
  name: 'File type',
  category: 'forensics',
  description: 'Identify a file from its magic bytes, flag a wrong extension or a damaged header.',
  tags: ['magic', 'file', 'signature', 'header', 'mime', 'libmagic'],
  input: 'bytes',
  placeholder: 'Drop any file — or paste hex with "Paste as: hex"',
  examples: [
    {
      label: 'PNG header',
      input: { hex: '89504e470d0a1a0a0000000d49484452' },
      expect: 'PNG image',
    },
    {
      label: 'Damaged PNG',
      input: { hex: '89504e580d0a1a0a0000000d49484452' },
      expect: 'damaged PNG image header',
    },
    { label: 'ELF binary', input: { hex: '7f454c4602010100' }, expect: 'ELF executable' },
  ],
  run({ bytes, name }) {
    const out: Output[] = [];
    const matches = identify(bytes);
    const best = matches[0];
    const head = toHex(bytes.subarray(0, 16), ' ');
    const entries: [string, string][] = [
      [
        'Type',
        best ? best.name : printableRatio(bytes) > 0.95 ? 'Plain text (no magic)' : 'Unknown',
      ],
    ];
    if (best) entries.push(['Extension', `.${best.ext}`]);
    if (best?.mime) entries.push(['MIME', best.mime]);
    if (best?.id === 'zip') {
      const names = latin1Decode(bytes.subarray(0, Math.min(bytes.length, 1 << 20)));
      const flavour = ZIP_FLAVOURS.find(([needle]) => names.includes(needle));
      if (flavour) entries.push(['ZIP flavour', flavour[1]]);
    }
    entries.push(
      ['Size', `${formatSize(bytes.length)} (${bytes.length} bytes)`],
      ['First bytes', head],
    );
    out.push({ type: 'kv', label: 'Identification', entries });

    const ext = name?.includes('.') ? name.split('.').pop()!.toLowerCase() : null;
    if (best && ext && ext !== best.ext && !matches.some((m) => m.ext === ext)) {
      out.push({
        type: 'note',
        level: 'warn',
        text: `Extension ".${ext}" does not match the content (${best.name}). Rename it to .${best.ext}.`,
      });
    }
    if (!best || best.weak) {
      for (const { sig, diff } of nearMisses(bytes).slice(0, 3)) {
        out.push({
          type: 'note',
          level: 'warn',
          text: `Looks like a damaged ${sig.name} header (${diff} byte${diff > 1 ? 's' : ''} off). Expected ${sig.magic.map((m) => (m === null ? '??' : m.toString(16).padStart(2, '0'))).join(' ')} — fix it in a hex editor.`,
        });
      }
    }
    if (matches.length > 1) {
      out.push({
        type: 'table',
        label: 'All matching signatures',
        columns: ['Type', 'Ext', 'Magic length'],
        rows: matches.map((m) => [m.name, m.ext, m.magic.length]),
      });
    }
    // Something else glued after/inside? Point at the carving tool.
    const embedded = indexOfBytes(bytes, [0x50, 0x4b, 0x03, 0x04], 1);
    if (embedded > 0 && best?.id !== 'zip') {
      out.push({
        type: 'note',
        level: 'info',
        text: `A ZIP header also appears at offset ${embedded}. Use Carve to extract embedded files.`,
      });
    }
    return out;
  },
  detect({ bytes, text }) {
    if (text !== null && printableRatio(bytes) > 0.95) return null;
    const best = identify(bytes)[0];
    return best ? { score: best.weak ? 0.4 : 0.9, reason: best.name } : { score: 0.3 };
  },
});
