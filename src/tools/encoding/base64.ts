import { defineTool, bool, toggle } from '../../core/define';
import { toolT } from '../../i18n/tool-text';
import { fromBase64, isValidUtf8, toBase64 } from '../../lib/bytes';

const T = toolT('base64');

const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export default defineTool({
  id: 'base64',
  name: 'Base64',
  category: 'encoding',
  description: 'Encode or decode Base64 (standard and URL-safe, padding optional).',
  tags: ['b64', 'atob', 'btoa', 'base-64'],
  input: 'bytes',
  placeholder: 'ZmxhZ3tiYXNlNjRfaXNfbm90X2NyeXB0b30=',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    alphabet: toggle('Alphabet', [
      { value: 'std', label: 'Standard +/' },
      { value: 'url', label: 'URL-safe -_' },
    ]),
    pad: bool('Pad with =', true, { showIf: (v) => v.mode === 'encode' }),
  },
  examples: [
    {
      label: 'Decode a flag',
      input: 'ZmxhZ3tiYXNlNjRfaXNfbm90X2NyeXB0b30=',
      expect: 'flag{base64_is_not_crypto}',
    },
    {
      label: 'Encode text',
      input: 'hello CTF',
      options: { mode: 'encode' },
      expect: 'aGVsbG8gQ1RG',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(t.replace(/\s+/g, ''))) return null;
    const len = t.replace(/\s+/g, '').length;
    const score = len % 4 === 0 || !t.includes('=') ? 0.8 : 0.5;
    return { score, options: { mode: 'decode' }, reason: T('detect.charset') };
  },
  run({ bytes }, { mode, alphabet, pad }) {
    const abc = alphabet === 'url' ? URL_SAFE : STD;
    if (mode === 'encode') return [{ type: 'text', value: toBase64(bytes, abc, pad) }];
    const text = new TextDecoder().decode(bytes);
    const out = fromBase64(text, abc);
    return [
      { type: 'bytes', value: out, filename: 'decoded.bin' },
      ...(isValidUtf8(out)
        ? []
        : [
            {
              type: 'note' as const,
              level: 'info' as const,
              text: T('note.binary'),
            },
          ]),
    ];
  },
});
