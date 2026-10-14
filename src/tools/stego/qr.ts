import { defineTool } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { isValidUtf8, printableRatio, toHex, utf8Decode } from '../../lib/bytes';
import { scanQr } from './_qr-scan';

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
    'Decode QR codes in an image, even inverted, tiny, noisy or missing their quiet zone; shows text and raw bytes.',
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
    if (!image.width || !image.height) throw new ToolError('The image has no pixels.');
    const { hits, tried } = scanQr(image);
    if (!hits.length) {
      return [
        {
          type: 'note',
          level: 'warn',
          text: `No QR code found after ${tried} attempts (as is, inverted, with a margin, binarized, rescaled). Crop tightly around the code, make sure it is flat and sharp, or look for it first with the Bit planes tool if it may be hidden in the pixels.`,
        },
      ];
    }
    const out: Output[] = [];
    if (hits.length > 1) {
      out.push({ type: 'note', level: 'info', text: `${hits.length} QR codes found.` });
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
        label: `QR code${tag}`,
        entries: [
          ['Version', `${code.version} (${modules}x${modules} modules)`],
          ['Payload', `${bytes.length} bytes, ${isText ? 'text' : 'binary'}`],
          [
            'Encoding',
            [...new Set(code.chunks.map((c) => String(c.type)))].join(', ') || 'unknown',
          ],
          ['Read after', hit.how],
          ['Position', `around (${hit.centre.x}, ${hit.centre.y}), about ${hit.size} px wide`],
        ],
      });
      if (isText) {
        out.push({ type: 'text', label: `Decoded text${tag}`, value: utf8Decode(bytes) });
      } else {
        out.push({
          type: 'note',
          level: 'info',
          text: `The payload is not plain text (starts with ${toHex(bytes.subarray(0, 16), ' ')}). Download the raw bytes below and identify them with File type.`,
        });
        out.push({
          type: 'bytes',
          label: `Raw bytes${tag}`,
          value: bytes,
          filename: `qr-data${tag.trim() ? `-${i + 1}` : ''}.bin`,
        });
        if (code.data && printableRatio(new TextEncoder().encode(code.data)) > 0.9) {
          out.push({ type: 'text', label: `jsQR text view${tag}`, value: code.data });
        }
      }
    });
    return out;
  },
});
