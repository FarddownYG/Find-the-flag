import { bool, defineTool, toggle } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';

const T = toolT('nato');

// ---------------------------------------------------------------------------------------------
// The ICAO / NATO spelling alphabet
// ---------------------------------------------------------------------------------------------

/** [letter, ICAO spelling, common spelling, other spellings people use]. */
const LETTERS: [string, string, string, string[]][] = [
  ['A', 'Alfa', 'Alpha', []],
  ['B', 'Bravo', 'Bravo', []],
  ['C', 'Charlie', 'Charlie', []],
  ['D', 'Delta', 'Delta', []],
  ['E', 'Echo', 'Echo', []],
  ['F', 'Foxtrot', 'Foxtrot', []],
  ['G', 'Golf', 'Golf', []],
  ['H', 'Hotel', 'Hotel', []],
  ['I', 'India', 'India', []],
  ['J', 'Juliett', 'Juliet', []],
  ['K', 'Kilo', 'Kilo', []],
  ['L', 'Lima', 'Lima', []],
  ['M', 'Mike', 'Mike', []],
  ['N', 'November', 'November', []],
  ['O', 'Oscar', 'Oscar', []],
  ['P', 'Papa', 'Papa', []],
  ['Q', 'Quebec', 'Quebec', []],
  ['R', 'Romeo', 'Romeo', []],
  ['S', 'Sierra', 'Sierra', []],
  ['T', 'Tango', 'Tango', []],
  ['U', 'Uniform', 'Uniform', []],
  ['V', 'Victor', 'Victor', []],
  ['W', 'Whiskey', 'Whiskey', ['Whisky']],
  ['X', 'Xray', 'Xray', []],
  ['Y', 'Yankee', 'Yankee', []],
  ['Z', 'Zulu', 'Zulu', []],
];

/** [digit, plain word, ICAO radio word, other spellings]. */
const DIGITS: [string, string, string, string[]][] = [
  ['0', 'Zero', 'Zero', ['Zeero']],
  ['1', 'One', 'One', ['Wun']],
  ['2', 'Two', 'Two', ['Too']],
  ['3', 'Three', 'Tree', ['Thuhree']],
  ['4', 'Four', 'Fower', []],
  ['5', 'Five', 'Fife', []],
  ['6', 'Six', 'Six', []],
  ['7', 'Seven', 'Seven', []],
  ['8', 'Eight', 'Eight', ['Ait']],
  ['9', 'Nine', 'Niner', ['Nin-er']],
];

const LETTER_WORDS = new Map<string, string>();
const DIGIT_WORDS = new Map<string, string>();
for (const [ch, icao, common, other] of LETTERS) {
  for (const w of [icao, common, ...other]) LETTER_WORDS.set(w.toLowerCase(), ch);
}
for (const [ch, plain, radio, other] of DIGITS) {
  for (const w of [plain, radio, ...other]) DIGIT_WORDS.set(w.toLowerCase().replace('-', ''), ch);
}
const WORDS = new Map<string, string>([...LETTER_WORDS, ...DIGIT_WORDS, ['decimal', '.']]);

export type NatoSpelling = 'icao' | 'common';
export type NatoDigits = 'radio' | 'plain';
export type NatoSeparator = 'space' | 'dash' | 'comma' | 'newline';
export type NatoCase = 'title' | 'upper' | 'lower';

export interface NatoEncodeOptions {
  spelling?: NatoSpelling;
  digits?: NatoDigits;
  separator?: NatoSeparator;
  wordCase?: NatoCase;
}

const SEPARATORS: Record<NatoSeparator, string> = {
  space: ' ',
  dash: '-',
  comma: ', ',
  newline: '\n',
};

/**
 * Letters, digits and "." become words; spaces and line breaks become a word break ("/", or a
 * blank line when the words are on separate lines). Accents are dropped (é is E). Anything else
 * has no word and is returned in `skipped`.
 */
export function natoEncode(
  text: string,
  {
    spelling = 'icao',
    digits = 'radio',
    separator = 'space',
    wordCase = 'title',
  }: NatoEncodeOptions = {},
): { text: string; skipped: string[] } {
  const letterWord = new Map<string, string>(
    LETTERS.map(([ch, icao, common]) => [ch, spelling === 'icao' ? icao : common]),
  );
  // "X-ray" is the official spelling, but a hyphen would look like the separator
  letterWord.set('X', separator === 'dash' ? 'Xray' : 'X-ray');
  const digitWord = new Map<string, string>(
    DIGITS.map(([ch, plain, radio]) => [ch, digits === 'radio' ? radio : plain]),
  );
  digitWord.set('.', 'Decimal');

  const style = (w: string) =>
    wordCase === 'upper' ? w.toUpperCase() : wordCase === 'lower' ? w.toLowerCase() : w;
  const skipped: string[] = [];
  const groups: string[][] = [[]];
  for (const raw of text) {
    const ch = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/^\s$/.test(raw)) {
      if (groups[groups.length - 1]!.length) groups.push([]);
      continue;
    }
    for (const c of ch.toUpperCase()) {
      const w = letterWord.get(c) ?? digitWord.get(c);
      if (w) groups[groups.length - 1]!.push(style(w));
      else if (!skipped.includes(raw)) skipped.push(raw);
    }
  }
  const sep = SEPARATORS[separator];
  const breaker = separator === 'newline' ? '\n\n' : ' / ';
  const value = groups
    .filter((g) => g.length)
    .map((g) => g.join(sep))
    .join(breaker);
  return { text: value, skipped };
}

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

export type NatoUnknown = 'error' | 'mark' | 'skip';

export interface NatoDecoded {
  text: string;
  /** Words (and word groups) that were read. */
  words: number;
  /** Words with no meaning, with their position (only for `mark` and `skip`). */
  unknown: { word: string; pos: number }[];
}

const editDistance = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
};

/** The closest word, if one word is clearly the closest (distance 1, or 2 for long words). */
function suggest(word: string): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  let tie = false;
  for (const w of WORDS.keys()) {
    const d = editDistance(word, w);
    if (d < bestD) {
      best = w;
      bestD = d;
      tie = false;
    } else if (d === bestD && WORDS.get(w) !== WORDS.get(best!)) {
      tie = true;
    }
  }
  const limit = word.length >= 6 ? 2 : 1;
  return best && !tie && bestD <= limit ? best : null;
}

/** Cut a run of letters into NATO words ("alfabravo"): the first complete split, longest words first. */
function segment(token: string): string[] | null {
  if (token.length > 400) return null;
  const failed = new Set<number>();
  const walk = (i: number): string[] | null => {
    if (i === token.length) return [];
    if (failed.has(i)) return null;
    for (let len = Math.min(8, token.length - i); len >= 3; len--) {
      const head = token.slice(i, i + len);
      if (!WORDS.has(head)) continue;
      const rest = walk(i + len);
      if (rest) return [head, ...rest];
    }
    failed.add(i);
    return null;
  };
  return walk(0);
}

const capital = (w: string) => w[0]!.toUpperCase() + w.slice(1);

/**
 * Case and separators do not matter: spaces, commas, dashes, dots, slashes and line breaks all
 * separate words; "/" and a blank line are a space in the result. Alfa/Alpha, Juliett/Juliet,
 * Whiskey/Whisky, X-ray/Xray and the radio digits (Tree, Fower, Fife, Niner...) are all read, and
 * words run together ("AlfaBravo") are cut apart. `unknown` says what a word with no meaning does:
 * throw (with its position and the nearest word), become "?", or be left out.
 */
export function natoDecode(
  text: string,
  unknown: NatoUnknown = 'error',
  lower = false,
): NatoDecoded {
  const tokens = [...text.matchAll(/[A-Za-z0-9]+|\/|\||\r?\n[ \t]*\r?\n/g)].map((m) => ({
    word: m[0],
    pos: m.index + 1,
    end: m.index + m[0].length,
  }));
  let out = '';
  let words = 0;
  const bad: { word: string; pos: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const { word, pos } = tokens[i]!;
    if (word === '/' || word === '|' || /^\s+$/.test(word)) {
      if (out && !out.endsWith(' ')) out += ' ';
      continue;
    }
    if (/^\d+$/.test(word)) {
      out += word;
      words++;
      continue;
    }
    const lowerWord = word.toLowerCase();
    // "X-ray", "X ray", "Nin-er": a hyphen or one space joins two or three tokens into one word
    let joined = lowerWord;
    let used = 1;
    if (!WORDS.has(lowerWord)) {
      let candidate = lowerWord;
      for (let k = 1; k <= 2 && i + k < tokens.length; k++) {
        const prev = tokens[i + k - 1]!;
        const next = tokens[i + k]!;
        if (!/^[- ]$/.test(text.slice(prev.end, next.pos - 1))) break;
        candidate += next.word.toLowerCase();
        if (WORDS.has(candidate)) {
          joined = candidate;
          used = k + 1;
          break;
        }
      }
    }
    const direct = WORDS.get(joined);
    if (direct !== undefined) {
      out += direct;
      words++;
      i += used - 1;
      continue;
    }
    const parts = segment(lowerWord);
    if (parts?.length) {
      for (const p of parts) out += WORDS.get(p)!;
      words += parts.length;
      continue;
    }
    if (unknown === 'error') {
      const near = suggest(lowerWord);
      throw new ToolError(
        near
          ? T('error.unknownNear', { word, pos, near: capital(near) })
          : T('error.unknown', { word, pos }),
      );
    }
    bad.push({ word, pos });
    if (unknown === 'mark') out += '?';
  }
  const result = out.trim();
  return { text: lower ? result.toLowerCase() : result, words, unknown: bad };
}

/** Does the whole text read as NATO words? Used by the home triage and by Auto-decode. */
export function looksLikeNato(text: string): { words: number; letters: number } | null {
  if (text.length > 100000) return null;
  const r = natoDecode(text, 'mark');
  if (r.unknown.length || r.words < 4) return null;
  const letters = [...r.text].filter((c) => /[A-Z]/.test(c));
  // "Echo Echo Echo Echo" is a phrase, not a spelled message
  return new Set(letters).size >= 3 ? { words: r.words, letters: letters.length } : null;
}

// ---------------------------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------------------------

export default defineTool({
  id: 'nato',
  name: 'NATO phonetic alphabet',
  category: 'encoding',
  description:
    'Spell text with the NATO / ICAO alphabet (Alfa Bravo Charlie…) or read it back; tolerant of case, separators and spelling variants.',
  tags: [
    'icao',
    'spelling alphabet',
    'phonetic alphabet',
    'alpha bravo charlie',
    'radio alphabet',
    'military alphabet',
    'niner',
    'itu',
  ],
  input: 'text',
  placeholder: 'Foxtrot Lima Alfa Golf',
  live: true,
  options: {
    mode: toggle('Mode', ['decode', 'encode']),
    unknown: toggle(
      'Unknown words',
      [
        { value: 'error', label: 'Stop with an error' },
        { value: 'mark', label: 'Show ?' },
        { value: 'skip', label: 'Leave out' },
      ],
      'error',
      { showIf: (v) => v.mode === 'decode' },
    ),
    lower: bool('Lower case output', false, {
      hint: 'Spelled words carry no case: the result is in capitals unless this is on.',
      showIf: (v) => v.mode === 'decode',
    }),
    spelling: toggle(
      'Spelling',
      [
        { value: 'icao', label: 'ICAO (Alfa, Juliett)' },
        { value: 'common', label: 'Common (Alpha, Juliet)' },
      ],
      'icao',
      { showIf: (v) => v.mode === 'encode' },
    ),
    digits: toggle(
      'Digits',
      [
        { value: 'radio', label: 'Radio (Tree, Fower, Fife, Niner)' },
        { value: 'plain', label: 'Plain (Three, Four, Five, Nine)' },
      ],
      'radio',
      { showIf: (v) => v.mode === 'encode' },
    ),
    separator: toggle(
      'Separator',
      [
        { value: 'space', label: 'Space' },
        { value: 'dash', label: 'Dash' },
        { value: 'comma', label: 'Comma' },
        { value: 'newline', label: 'New line' },
      ],
      'space',
      { showIf: (v) => v.mode === 'encode' },
    ),
    wordCase: toggle(
      'Words',
      [
        { value: 'title', label: 'Title' },
        { value: 'upper', label: 'UPPER' },
        { value: 'lower', label: 'lower' },
      ],
      'title',
      { showIf: (v) => v.mode === 'encode' },
    ),
  },
  examples: [
    {
      label: 'Decode a message',
      input: 'Sierra Echo Charlie Romeo Echo Tango Tree Fower Two',
      expect: 'SECRET342',
    },
    {
      label: 'Variants: Alpha, Juliet, Niner, dashes',
      input: 'Alpha-Juliet-Niner-X-ray / Whisky',
      expect: 'AJ9X W',
    },
    {
      label: 'Words run together, any case',
      input: 'FOXTROTLIMAALFAGOLF',
      expect: 'FLAG',
    },
    {
      label: 'Encode text',
      input: 'Flag 42',
      options: { mode: 'encode' },
      expect: 'Foxtrot Lima Alfa Golf / Fower Two',
    },
    {
      label: 'A word that is not in the alphabet',
      input: 'Alfa Brovo Charlie',
      options: { unknown: 'mark' },
      expect: 'Brovo (6)',
    },
  ],
  detect({ text }) {
    const t = text?.trim() ?? '';
    if (t.length < 15 || t.length > 100000) return null;
    const r = looksLikeNato(t);
    if (!r || r.letters < 3) return null;
    return {
      score: r.words >= 6 ? 0.9 : 0.8,
      options: { mode: 'decode' },
      reason: T('detect.words'),
    };
  },
  run(text, { mode, unknown, lower, spelling, digits, separator, wordCase }) {
    if (mode === 'encode') {
      const r = natoEncode(text, { spelling, digits, separator, wordCase });
      const out: Output[] = [{ type: 'text', value: r.text }];
      if (r.skipped.length) {
        out.push({
          type: 'note',
          level: 'info',
          text: T('note.skipped', { chars: r.skipped.slice(0, 20).join(' ') }),
        });
      }
      return out;
    }
    if (!text.trim()) throw new ToolError(T('error.empty'));
    const r = natoDecode(text, unknown, lower);
    const out: Output[] = [{ type: 'text', value: r.text }];
    if (r.unknown.length) {
      const list = r.unknown
        .slice(0, 10)
        .map((u) => `${u.word} (${u.pos})`)
        .join(', ');
      out.push({ type: 'note', level: 'warn', text: T('note.unknown', { words: list }) });
    }
    return out;
  },
});
