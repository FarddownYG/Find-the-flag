import { defineTool, bool, text as textOption, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';

/** International Morse (ITU-R M.1677) plus the usual accented letters. */
const TABLE: [string, string][] = [
  ['A', '.-'], ['B', '-...'], ['C', '-.-.'], ['D', '-..'], ['E', '.'], ['F', '..-.'],
  ['G', '--.'], ['H', '....'], ['I', '..'], ['J', '.---'], ['K', '-.-'], ['L', '.-..'],
  ['M', '--'], ['N', '-.'], ['O', '---'], ['P', '.--.'], ['Q', '--.-'], ['R', '.-.'],
  ['S', '...'], ['T', '-'], ['U', '..-'], ['V', '...-'], ['W', '.--'], ['X', '-..-'],
  ['Y', '-.--'], ['Z', '--..'],
  ['0', '-----'], ['1', '.----'], ['2', '..---'], ['3', '...--'], ['4', '....-'],
  ['5', '.....'], ['6', '-....'], ['7', '--...'], ['8', '---..'], ['9', '----.'],
  ['.', '.-.-.-'], [',', '--..--'], ['?', '..--..'], ["'", '.----.'], ['!', '-.-.--'],
  ['/', '-..-.'], ['(', '-.--.'], [')', '-.--.-'], ['&', '.-...'], [':', '---...'],
  [';', '-.-.-.'], ['=', '-...-'], ['+', '.-.-.'], ['-', '-....-'], ['_', '..--.-'],
  ['"', '.-..-.'], ['$', '...-..-'], ['@', '.--.-.'],
  ['Ä', '.-.-'], ['Ö', '---.'], ['Ü', '..--'], ['É', '..-..'], ['Ñ', '--.--'],
  ['À', '.--.-'], ['Ç', '-.-..'],
]; // prettier-ignore

const ENCODE = new Map(TABLE);
const DECODE = new Map(TABLE.map(([ch, code]) => [code, ch]));

export interface MorseSymbols {
  /** One character standing for a dot. Default ".". */
  dot?: string;
  /** One character standing for a dash. Default "-". */
  dash?: string;
}

function symbols(opts: MorseSymbols): { dot: string; dash: string; custom: boolean } {
  const dot = opts.dot || '.';
  const dash = opts.dash || '-';
  for (const [name, s] of [
    ['Dot', dot],
    ['Dash', dash],
  ] as const) {
    if ([...s].length !== 1 || /\s/.test(s) || s === '/') {
      throw new ToolError(
        `${name} symbol must be one visible character other than "/" (got "${s}").`,
      );
    }
  }
  if (dot === dash) throw new ToolError('Dot and dash symbols must be different.');
  return { dot, dash, custom: dot !== '.' || dash !== '-' };
}

export type MorseWordSeparator = 'slash' | 'spaces';

/**
 * Letters are separated by one space; words by " / " or by two spaces. Case is ignored,
 * accents are stripped when the accented letter has no code of its own. Characters with no
 * Morse code are dropped and returned in `skipped`.
 */
export function morseEncode(
  input: string,
  opts: MorseSymbols & { wordSeparator?: MorseWordSeparator } = {},
): { text: string; skipped: string[] } {
  const { dot, dash } = symbols(opts);
  const wordSep = opts.wordSeparator === 'spaces' ? '  ' : ' / ';
  const skipped: string[] = [];
  const words: string[] = [];
  for (const word of input.toUpperCase().split(/\s+/)) {
    const letters: string[] = [];
    for (const ch of word) {
      let code = ENCODE.get(ch);
      if (code === undefined) {
        const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
        code = ENCODE.get(plain);
      }
      if (code === undefined) {
        if (!skipped.includes(ch)) skipped.push(ch);
        continue;
      }
      letters.push([...code].map((c) => (c === '.' ? dot : dash)).join(''));
    }
    if (letters.length) words.push(letters.join(' '));
  }
  return { text: words.join(wordSep), skipped };
}

/** Typographic dots and dashes that are accepted when the default symbols are used. */
const DOT_LOOKALIKES = /[•·∙●⋅]/g;
const DASH_LOOKALIKES = /[−–—‒―_▬]/g;

/**
 * Letters are separated by a single space (or newline), words by "/" or by two or more
 * spaces (or a blank line). With the default symbols, • · and − – — are read as dot and dash
 * too. Unknown codes become "?"; `unknown` counts them. Output is upper case.
 */
export function morseDecode(
  input: string,
  opts: MorseSymbols = {},
): { text: string; unknown: number } {
  const { dot, dash, custom } = symbols(opts);
  let s = input.replace(/\r\n?/g, '\n');
  if (custom) {
    // Only the chosen symbols are Morse; map them to . and - after checking nothing else is.
    const marks = [...s].map((c) =>
      c === dot ? '.' : c === dash ? '-' : c === '.' || c === '-' ? '\u0000' : c,
    );
    s = marks.join('');
  } else {
    s = s.replace(DOT_LOOKALIKES, '.').replace(DASH_LOOKALIKES, '-');
  }
  const bad = s.match(/[^.\-\s/]/);
  if (bad) {
    const shown = bad[0] === '\u0000' ? 'a plain . or -' : `"${bad[0]}"`;
    throw new ToolError(
      `Not Morse: found ${shown} at position ${bad.index! + 1}. Expected "${dot}" and "${dash}" separated by spaces; set the dot and dash symbols if the message uses others.`,
    );
  }

  let out = '';
  let unknown = 0;
  let pendingSpace = false;
  for (const m of s.matchAll(/[.-]+|\/|\s+/g)) {
    const tok = m[0];
    if (tok === '/') {
      pendingSpace = out.length > 0;
    } else if (/^\s/.test(tok)) {
      const blanks = (tok.match(/[ \t]/g) ?? []).length;
      const lines = (tok.match(/\n/g) ?? []).length;
      if (blanks >= 2 || lines >= 2) pendingSpace = out.length > 0;
    } else {
      if (pendingSpace) out += ' ';
      pendingSpace = false;
      const ch = DECODE.get(tok);
      if (ch === undefined) unknown++;
      out += ch ?? '?';
    }
  }
  return { text: out, unknown };
}

export default defineTool({
  id: 'morse',
  name: 'Morse code',
  category: 'encoding',
  description:
    'Decode or write Morse code (letters, digits, punctuation) with your own dot and dash.',
  tags: ['morse', 'cw', 'dots and dashes', 'telegraph', 'sos', 'From Morse Code', 'To Morse Code'],
  input: 'text',
  placeholder: '..-. .-.. .- --. / -- --- .-. ... .   (• and − work too)',
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    dot: textOption('Dot symbol', '.', { placeholder: '.' }),
    dash: textOption('Dash symbol', '-', { placeholder: '-' }),
    wordSeparator: toggle(
      'Words are separated by',
      [
        { value: 'slash', label: 'Slash  /' },
        { value: 'spaces', label: 'Two spaces' },
      ],
      'slash',
      { showIf: (v) => v.mode === 'encode' },
    ),
    lower: bool('Lower case output', false, {
      hint: 'Morse has no case: decoding gives capitals unless this is on.',
      showIf: (v) => v.mode === 'decode',
    }),
  },
  examples: [
    {
      label: 'Decode',
      input: '..-. .-.. .- --. ..--.- -- --- .-. ... .',
      expect: 'FLAG_MORSE',
    },
    {
      label: 'Words, digits and lower case',
      input: '.... .. / - .... . .-. . / .---- ..--- ...--',
      options: { lower: true },
      expect: 'hi there 123',
    },
    {
      label: 'Other symbols (0 = dot, 1 = dash)',
      input: '0010 0100 01 110 / 11 111 010 000 0',
      options: { dot: '0', dash: '1' },
      expect: 'FLAG MORSE',
    },
    {
      label: 'Encode text',
      input: 'SOS now',
      options: { mode: 'encode' },
      expect: '... --- ... / -. --- .--',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 5 || t.length > 100000 || !/^[.\-•·−–—\s/]+$/.test(t) || !/[.\-•·−–—]/.test(t)) {
      return null;
    }
    try {
      const { text: decoded, unknown } = morseDecode(t);
      const letters = decoded.replace(/\s/g, '').length;
      if (letters >= 2 && unknown <= letters * 0.2) {
        return { score: 0.88, options: { mode: 'decode' }, reason: 'Dots and dashes that decode' };
      }
    } catch {
      return null;
    }
    return null;
  },
  run(input, { mode, dot, dash, wordSeparator, lower }) {
    if (mode === 'encode') {
      const { text, skipped } = morseEncode(input, { dot, dash, wordSeparator });
      const out: Output[] = [{ type: 'text', value: text }];
      if (skipped.length) {
        out.push({
          type: 'note',
          level: 'warn',
          text: `No Morse code for ${skipped.map((c) => `"${c}"`).join(' ')}: skipped.`,
        });
      }
      return out;
    }
    if (!input.trim()) throw new ToolError('Paste Morse code, e.g. .... .. (dots and dashes).');
    const { text, unknown } = morseDecode(input, { dot, dash });
    const out: Output[] = [{ type: 'text', value: lower ? text.toLowerCase() : text }];
    if (unknown) {
      out.push({
        type: 'note',
        level: 'warn',
        text: `${unknown} unknown code${unknown === 1 ? '' : 's'} shown as "?". Check the spacing between letters.`,
      });
    }
    return out;
  },
});
