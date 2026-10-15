import { defineTool } from '../../core/define';
import type { Output } from '../../core/types';
import { formatSize, indexOfBytes, latin1Decode, printableRatio, toHex } from '../../lib/bytes';
import { tOr } from '../../i18n';
import { signatureName, toolT } from '../../i18n/tool-text';
import { identify, SIGNATURES, type Signature } from '../../lib/signatures';

const T = toolT('file-type');

/** ZIP-based formats are told apart by the names of their entries. */
const ZIP_FLAVOURS: [string, () => string][] = [
  ['word/', () => T('flavour.docx')],
  ['xl/', () => T('flavour.xlsx')],
  ['ppt/', () => T('flavour.pptx')],
  ['AndroidManifest.xml', () => T('flavour.apk')],
  ['META-INF/MANIFEST.MF', () => T('flavour.jar')],
  ['mimetypeapplication/vnd.oasis', () => T('flavour.odf')],
  ['mimetypeapplication/epub', () => T('flavour.epub')],
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
        T('kv.type'),
        best
          ? signatureName(best)
          : printableRatio(bytes) > 0.95
            ? T('value.plainText')
            : T('value.unknown'),
      ],
    ];
    if (best) entries.push([T('kv.extension'), `.${best.ext}`]);
    if (best?.mime) entries.push([T('kv.mime'), best.mime]);
    if (best?.id === 'zip') {
      const names = latin1Decode(bytes.subarray(0, Math.min(bytes.length, 1 << 20)));
      const flavour = ZIP_FLAVOURS.find(([needle]) => names.includes(needle));
      if (flavour) entries.push([T('kv.zipFlavour'), flavour[1]()]);
    }
    entries.push(
      [T('kv.size'), T('value.size', { size: formatSize(bytes.length), count: bytes.length })],
      [T('kv.firstBytes'), head],
    );
    out.push({ type: 'kv', label: T('label.identification'), entries });

    const ext = name?.includes('.') ? name.split('.').pop()!.toLowerCase() : null;
    if (best && ext && ext !== best.ext && !matches.some((m) => m.ext === ext)) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.wrongExt', { ext, name: signatureName(best), expected: best.ext }),
      });
    }
    if (!best || best.weak) {
      for (const { sig, diff } of nearMisses(bytes).slice(0, 3)) {
        out.push({
          type: 'note',
          level: 'warn',
          text: T('note.damaged', {
            name: signatureName(sig),
            count: diff,
            magic: sig.magic
              .map((m) => (m === null ? '??' : m.toString(16).padStart(2, '0')))
              .join(' '),
          }),
        });
      }
    }
    if (matches.length > 1) {
      out.push({
        type: 'table',
        label: T('label.allMatches'),
        columns: [T('col.type'), T('col.ext'), T('col.magicLength')],
        rows: matches.map((m) => [signatureName(m), m.ext, m.magic.length]),
      });
    }
    if (best?.id === 'pdf') out.push({ type: 'note', level: 'info', text: T('note.pdf') });
    // An executable has a tool of its own.
    if (best && ['elf', 'pe', 'macho32', 'macho64'].includes(best.id)) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.executable', { tool: tOr('tool.exe-analyzer.name', 'Executable analyzer') }),
      });
    }
    // Something else glued after/inside? Point at the carving tool.
    const embedded = indexOfBytes(bytes, [0x50, 0x4b, 0x03, 0x04], 1);
    if (embedded > 0 && best?.id !== 'zip') {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.embeddedZip', { offset: embedded }),
      });
    }
    return out;
  },
  detect({ bytes, text }) {
    if (text !== null && printableRatio(bytes) > 0.95) return null;
    const best = identify(bytes)[0];
    return best ? { score: best.weak ? 0.4 : 0.9, reason: signatureName(best) } : { score: 0.3 };
  },
});
