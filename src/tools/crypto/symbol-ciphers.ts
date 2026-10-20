import { bool, defineTool, number, select } from '../../core/define';
import { ToolError } from '../../core/errors';
import { registeredTools } from '../../core/tool-list';
import type { KeypadKey, Output } from '../../core/types';
import { toolName, toolT } from '../../i18n/tool-text';
import { utf8Encode } from '../../lib/bytes';
import { ALPHABETS, type AlphabetId, type SymbolKey, type Token } from './_symbols';
import { renderRow, renderSheet } from './_symbols-svg';

const T = toolT('symbol-ciphers');

/** Names of the symbols the encoder puts in by itself (Braille signs), as the sheet labels them. */
const EXTRA_KEYS: Record<string, string> = {
  number: 'extra.number',
  letter: 'extra.letter',
  capital: 'extra.capital',
};

/** Symbols drawn in one picture: more would make a file a browser struggles to show. */
export const MAX_DRAWN = 1500;

/** The tokens of the first MAX_DRAWN symbols (and the gaps between them). */
function drawable(tokens: Token[]): { tokens: Token[]; cut: boolean } {
  let drawn = 0;
  for (const [i, token] of tokens.entries()) {
    if (token.type !== 'glyph' && token.type !== 'plain') continue;
    if (++drawn > MAX_DRAWN) return { tokens: tokens.slice(0, i), cut: true };
  }
  return { tokens, cut: false };
}

/** Characters with no symbol, once each, in the order they first appear. */
function unmapped(chars: string[]): string[] {
  return [...new Set(chars)].slice(0, 12);
}

export default defineTool({
  id: 'symbol-ciphers',
  name: 'Symbol ciphers',
  category: 'crypto',
  description:
    'Click the Pigpen, semaphore or Braille symbols you see to get the letters, or type letters to draw them as SVG / PNG.',
  tags: [
    'pigpen',
    'freemason',
    'masonic',
    'pig pen',
    'semaphore',
    'flag signals',
    'braille',
    'symbol cipher',
    'picture cipher',
    'alphabet',
    'dcode',
    'symbols',
  ],
  input: 'text',
  placeholder: 'Click the symbols below, or type letters (Braille cells like ⠋⠞⠋ are read too)',
  options: {
    alphabet: select(
      'Alphabet',
      [
        { value: 'pigpen', label: 'Pigpen / Freemason' },
        { value: 'semaphore', label: 'Semaphore flags' },
        { value: 'braille', label: 'Braille' },
      ],
      'pigpen',
      {
        hint: 'The pictures to read or to draw. The keyboard under the text box shows the symbols of this alphabet.',
      },
    ),
    mirror: bool('Mirrored', false, {
      hint: 'Semaphore: draw the signaller as seen from the other side (A with its low flag on the left). Try it if a chart gives nonsense.',
      showIf: (v) => v.alphabet === 'semaphore',
    }),
    perRow: number('Symbols per row', 12, {
      min: 3,
      max: 60,
      hint: 'How many symbols fit on a line of the picture before a word moves down.',
    }),
  },
  examples: [
    { label: 'Pigpen: draw a flag', input: 'FTF{PIGPEN}', expect: 'FTF{PIGPEN}' },
    {
      label: 'Semaphore: a word as flags',
      input: 'SEMAPHORE',
      options: { alphabet: 'semaphore' },
      expect: 'SEMAPHORE',
    },
    {
      label: 'Braille cells to letters',
      input: '⠋⠞⠋\u2800⠃⠗⠁⠊⠇⠇⠑\u2800⠼⠁⠃⠉',
      options: { alphabet: 'braille' },
      expect: 'ftf braille 123',
    },
    {
      label: 'Braille: write a message',
      input: 'braille 42',
      options: { alphabet: 'braille' },
      expect: '⠃⠗⠁⠊⠇⠇⠑\u2800⠼⠙⠃',
    },
    {
      label: 'Whole Pigpen alphabet',
      input: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      expect: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    },
  ],
  detect({ text }) {
    if (!text) return null;
    const chars = [...text].filter((c) => !/\s/.test(c) && c !== '\u2800');
    if (chars.length < 3) return null;
    const cells = chars.filter((c) => /[\u2801-\u28ff]/.test(c)).length;
    if (cells / chars.length < 0.8) return null;
    return { score: 0.9, options: { alphabet: 'braille' }, reason: T('detect.braille') };
  },
  keypad({ alphabet, mirror }): KeypadKey[] {
    return ALPHABETS[alphabet].keys({ mirror }).map((k) => ({
      text: k.text,
      label: k.name,
      glyph: k.keyGlyph ?? k.glyph,
    }));
  },
  run(text, { alphabet, mirror, perRow }) {
    if (!text.trim()) throw new ToolError(T('error.empty'));
    const id: AlphabetId = alphabet;
    const alpha = ALPHABETS[id];
    const options = { mirror };
    const tokens = alpha.tokenize(text, options);
    const letters = alpha.plain(text);
    const title = T(`title.${id}`);

    const out: Output[] = [{ type: 'text', label: T('label.letters'), value: letters }];

    const shown = drawable(tokens);
    const row = renderRow(alpha, shown.tokens, {
      perRow,
      labelled: true,
      title: `${title}: ${letters.length > 200 ? `${letters.slice(0, 200)}…` : letters}`,
    });
    if (row.glyphs) {
      out.push({
        type: 'picture',
        label: T('label.symbols'),
        data: utf8Encode(row.svg),
        mime: 'image/svg+xml',
        filename: `${id}.svg`,
      });
    }

    // Braille cells have a Unicode form to copy or send on.
    const cells = tokens.flatMap((t) =>
      t.type === 'glyph'
        ? (t.key.unicode ?? '')
        : t.type === 'space'
          ? '\u2800'
          : t.type === 'newline'
            ? '\n'
            : t.ch,
    );
    if (id === 'braille' && cells.some((c) => /[\u2801-\u28ff]/.test(c))) {
      out.push({ type: 'text', label: T('label.unicode'), value: cells.join('') });
    }

    const plain = unmapped(tokens.flatMap((t) => (t.type === 'plain' ? [t.ch] : [])));
    if (plain.length) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.unmapped', { count: plain.length, chars: plain.join(' ') }),
      });
    }
    if (!row.glyphs) out.push({ type: 'note', level: 'warn', text: T('note.nothingDrawn') });
    if (shown.cut)
      out.push({ type: 'note', level: 'warn', text: T('note.truncated', { max: MAX_DRAWN }) });

    out.push({ type: 'note', level: 'info', text: T(`note.${id}`) });

    const labelOf = (key: SymbolKey): string => {
      const extra = EXTRA_KEYS[key.name];
      return extra && key.text === '' ? T(extra) : key.name;
    };
    out.push({
      type: 'picture',
      label: T('label.reference'),
      data: utf8Encode(renderSheet(alpha, options, title, labelOf).svg),
      mime: 'image/svg+xml',
      filename: `${id}-reference.svg`,
    });
    if (id === 'braille') {
      const braille = registeredTools().find((t) => t.id === 'braille');
      if (braille) {
        out.push({
          type: 'actions',
          actions: [
            {
              label: T('open', { tool: toolName(braille) }),
              options: {},
              open: { tool: braille.id, text },
            },
          ],
        });
      }
    }
    return out;
  },
});
