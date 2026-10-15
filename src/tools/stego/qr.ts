import { defineTool } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { isValidUtf8, printableRatio, toHex, utf8Decode } from '../../lib/bytes';
import { scanQr } from './_qr-scan';

const T = toolT('qr');

/** Control characters other than tab, newline and carriage return. */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f) return true;
  }
  return false;
}

export default defineTool({
  id: 'qr',
  name: 'QR code reader',
  category: 'stego',
  description:
    'Decode QR codes in an image, even inverted, tiny, noisy or missing their quiet zone; shows text and raw bytes. Other barcodes (1D, Data Matrix, Aztec, PDF417): Barcode reader.',
  tags: ['qr', 'qrcode', 'barcode', 'scan', 'decode', 'jsqr', 'zxing', 'mobile'],
  input: 'image',
  placeholder: 'Drop an image that contains a QR code',
  examples: [
    { label: 'Scan a QR code', input: { sample: 'stego-qr.png' }, expect: 'flag{qr_scanned}' },
    {
      label: 'Where it was found',
      input: { sample: 'stego-qr.png' },
      expect: 'Version: 1 (21x21 modules)',
    },
  ],
  run({ image }) {
    if (!image.width || !image.height) throw new ToolError(T('error.noPixels'));
    const { hits, tried } = scanQr(image);
    if (!hits.length) {
      return [
        {
          type: 'note',
          level: 'warn',
          text: T('note.none', { count: tried }),
        },
        { type: 'note', level: 'info', text: T('note.otherCodes') },
      ];
    }
    const out: Output[] = [];
    if (hits.length > 1) {
      out.push({ type: 'note', level: 'info', text: T('note.count', { count: hits.length }) });
    }
    hits.forEach((hit, i) => {
      const { code } = hit;
      const tag = hits.length > 1 ? ` ${i + 1}` : '';
      const bytes = Uint8Array.from(code.binaryData);
      // Text means valid UTF-8 without control characters (accents and CJK are fine).
      const isText = isValidUtf8(bytes) && !hasControlChars(utf8Decode(bytes));
      const modules = 17 + 4 * code.version;
      out.push({
        type: 'kv',
        label: T('label.code', { tag }),
        entries: [
          [T('kv.version'), T('value.version', { version: code.version, modules })],
          [
            T('kv.payload'),
            isText
              ? T('value.payloadText', { count: bytes.length })
              : T('value.payloadBinary', { count: bytes.length }),
          ],
          [
            T('kv.encoding'),
            [...new Set(code.chunks.map((c) => String(c.type)))].join(', ') || T('value.unknown'),
          ],
          [T('kv.readAfter'), hit.how],
          [
            T('kv.position'),
            T('value.position', { x: hit.centre.x, y: hit.centre.y, size: hit.size }),
          ],
        ],
      });
      if (isText) {
        out.push({ type: 'text', label: T('label.decoded', { tag }), value: utf8Decode(bytes) });
      } else {
        out.push({
          type: 'note',
          level: 'info',
          text: T('note.binary', { hex: toHex(bytes.subarray(0, 16), ' ') }),
        });
        out.push({
          type: 'bytes',
          label: T('label.raw', { tag }),
          value: bytes,
          filename: `qr-data${tag.trim() ? `-${i + 1}` : ''}.bin`,
        });
        if (code.data && printableRatio(new TextEncoder().encode(code.data)) > 0.9) {
          out.push({ type: 'text', label: T('label.jsqr', { tag }), value: code.data });
        }
      }
    });
    return out;
  },
});
