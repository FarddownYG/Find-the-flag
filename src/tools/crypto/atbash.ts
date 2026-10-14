import { bool, defineTool } from '../../core/define';
import { toolT } from '../../i18n/tool-text';

const T = toolT('atbash');

/** Mirror the alphabet (A↔Z, b↔y); optionally the digits too (0↔9). Case is kept. */
export function atbash(text: string, digits = false): string {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) out += String.fromCharCode(155 - c);
    else if (c >= 97 && c <= 122) out += String.fromCharCode(219 - c);
    else if (digits && c >= 48 && c <= 57) out += String.fromCharCode(105 - c);
    else out += ch;
  }
  return out;
}

export default defineTool({
  id: 'atbash',
  name: 'Atbash',
  category: 'crypto',
  description: 'Mirror the alphabet (A↔Z, B↔Y…). Encrypting and decrypting are the same step.',
  tags: ['reverse alphabet', 'mirror alphabet', 'hebrew', 'substitution', 'monoalphabetic'],
  input: 'text',
  placeholder: 'uozt{zgyzhs_rh_hvou_rmevihv}',
  options: {
    digits: bool('Also mirror digits', false, {
      hint: '0↔9, 1↔8… (non-standard, some CTFs do it)',
    }),
  },
  examples: [
    {
      label: 'Atbash flag',
      input: 'uozt{zgyzhs_rh_hvou_rmevihv}',
      expect: 'flag{atbash_is_self_inverse}',
    },
    {
      label: 'With digits',
      input: 'uozt{yrg_9_rh_8}',
      options: { digits: true },
      expect: 'flag{bit_0_is_1}',
    },
    {
      label: 'Mixed case sentence',
      input: 'Gsv Jfrxp Yildm Ulc',
      expect: 'The Quick Brown Fox',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 6 || !/^[a-z0-9_]+\{[^}]+\}$/i.test(t)) return null;
    return atbash(t).toLowerCase().startsWith('flag{')
      ? { score: 0.85, reason: T('detect.flag') }
      : null;
  },
  run(text, { digits }) {
    return [{ type: 'text', value: atbash(text, digits) }];
  },
});
